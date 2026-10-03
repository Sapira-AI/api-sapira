import { randomUUID } from 'crypto';

import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { SalesforceAuthType, SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { normalizeQuoteType, QUOTE_TYPE_CODES, QUOTE_TYPE_LABELS, QuoteTypeCode } from '@/modules/quotes/quote-status';
import { SalesforceService } from '@/modules/salesforce/salesforce.service';
import { SalesforceSchedulerJob, SalesforceSchedulerJobDocument } from '@/modules/salesforce/schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog, SalesforceSyncLogDocument } from '@/modules/salesforce/schemas/salesforce-sync-log.schema';
import { SalesforceAuthService } from '@/modules/salesforce/services/salesforce-auth.service';
import { SalesforceMappingService } from '@/modules/salesforce/services/salesforce-mapping.service';
import { SalesforceStagingService } from '@/modules/salesforce/services/salesforce-staging.service';
import {
	DAILY_SYNC_WINDOW_DAYS,
	SALESFORCE_WON_STAGES,
	SalesforceSyncCompleteService,
} from '@/modules/salesforce/services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from '@/modules/salesforce/services/salesforce-sync-run.service';

import {
	Actor,
	buildMappingView,
	ComputedRuleField,
	ConnectionTestResult,
	ConnectionView,
	durationMs,
	emptyConnection,
	errorsSummary,
	errorText,
	filterRefs,
	filterRuns,
	ImpactErrors,
	ImportRequest,
	ImportStarted,
	IntegrationRun,
	IntegrationRunDetail,
	MappingItem,
	MappingRow,
	MappingStatus,
	MappingView,
	nextDailyAtInZone,
	normalizeText,
	paginateArray,
	Paginated,
	parseRunId,
	RecordSource,
	Ref,
	RunRecord,
	RunsQuery,
	runStatusOf,
	runTotals,
	ScheduleInfo,
	secretInfo,
	sortRunsDesc,
	stagingStatusSql,
	suggestRef,
	SyncStarted,
} from '../integrations.types';

import { FieldsMappingHelper } from './fields-mapping.helper';
import { IntegrationAdapter, IntegrationRules } from './integration-adapter';

type Row = Record<string, unknown>;

const LEASE_MS = 3 * 60 * 60 * 1000;
const RUNS_WINDOW = 300;
const ACTIVE_RUN_STATUSES = ['queued', 'running', 'cancellation_requested'];
const RUN_KINDS: Record<string, { kind: string; label: string }> = {
	update_staging: { kind: 'crm_staging', label: 'Traer oportunidades a revisión' },
	process_final: { kind: 'crm_import', label: 'Importación a Sapira' },
	retry_full: { kind: 'crm_retry', label: 'Traer e importar oportunidades' },
};
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CrmConnectionInput {
	auth_type: 'password' | 'client_credentials';
	login_url?: string;
	client_id: string;
	client_secret?: string;
	username?: string;
	password?: string;
	security_token?: string;
}

export interface CrmFetchInput {
	date_from: string;
	date_to: string;
	opportunity_ids?: string[];
	stages: string[];
}

/**
 * CRM (Salesforce). Reutiliza `SalesforceService` (validar credenciales, consultas), `SalesforceAuthService` (guardar credenciales),
 * `SalesforceSyncCompleteService` (corrida diaria por holding, vista previa, procesar cuentas), `SalesforceSyncRunService` (ejecuciones
 * por oportunidad) y `SalesforceMappingService` (productos, tipos de cotización, campos). Historial: corridas diarias/manuales en Mongo +
 * ejecuciones en `salesforce_sync_runs`.
 */
/**
 * Campos calculados de la oportunidad para las reglas de exclusión (contrato §6.5). Forma real de `raw_data` (QA, 03-10):
 * `Owner { Id, Name, Email }`, `OpportunityLineItems { done, records[] }` (o JSON null), `StageName`, `Type`, `Forma_de_pago__c`.
 * Caso SimpliRoute: excluir las ganadas sin ítems (`line_items_count` es "0") o con un dueño dado (`owner_email` es "<correo>").
 */
export const OPPORTUNITY_COMPUTED_FIELDS: ComputedRuleField[] = [
	{ field: 'owner_email', label: 'Correo del dueño', type: 'text', lowercase: true },
	{ field: 'owner_name', label: 'Nombre del dueño', type: 'text' },
	{ field: 'line_items_count', label: 'Cantidad de ítems', type: 'number' },
	{ field: 'stage', label: 'Etapa', type: 'text' },
	{ field: 'opportunity_type', label: 'Tipo', type: 'text' },
	{ field: 'payment_method', label: 'Forma de pago', type: 'text' },
];

const OPPORTUNITY_COMPUTED_SQL = `jsonb_build_object(
	'owner_email', lower(s.raw_data->'Owner'->>'Email'),
	'owner_name', s.raw_data->'Owner'->>'Name',
	'line_items_count', COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(s.raw_data->'OpportunityLineItems'->'records') = 'array'
		THEN s.raw_data->'OpportunityLineItems'->'records' END), 0),
	'stage', s.raw_data->>'StageName',
	'opportunity_type', s.raw_data->>'Type',
	'payment_method', s.raw_data->>'Forma_de_pago__c')`;

@Injectable()
export class CrmAdapter implements IntegrationAdapter {
	readonly tipo = 'crm' as const;
	readonly mappingObjects = ['products', 'quote_types', 'owners', 'fields'];
	readonly defaultRules: IntegrationRules = { opportunity_stages: [...SALESFORCE_WON_STAGES] };
	private readonly logger = new Logger(CrmAdapter.name);
	private readonly fields: FieldsMappingHelper;

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(SalesforceConnection) private readonly connections: Repository<SalesforceConnection>,
		private readonly salesforceService: SalesforceService,
		private readonly authService: SalesforceAuthService,
		private readonly syncComplete: SalesforceSyncCompleteService,
		private readonly syncRuns: SalesforceSyncRunService,
		private readonly staging: SalesforceStagingService,
		private readonly mappings: SalesforceMappingService,
		@InjectModel(SalesforceSchedulerJob.name) private readonly schedulerJobs: Model<SalesforceSchedulerJobDocument>,
		@InjectModel(SalesforceSyncLog.name) private readonly syncLogs: Model<SalesforceSyncLogDocument>,
		private readonly config: ConfigService
	) {
		this.fields = new FieldsMappingHelper(dataSource);
	}

	private environment() {
		return this.config.get<string>('NODE_ENV') || 'development';
	}

	// ── Conexión ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private current(holdingId: string) {
		return this.connections.findOne({ where: { holding_id: holdingId } });
	}

	private async require(holdingId: string): Promise<SalesforceConnection> {
		const connection = await this.current(holdingId);

		if (!connection) throw new NotFoundException('No hay una conexión con el CRM');

		return connection;
	}

	private view(connection: SalesforceConnection | null): ConnectionView {
		if (!connection) return emptyConnection('crm');

		return {
			tipo: 'crm',
			system: 'salesforce',
			connected: true,
			id: connection.id,
			name: connection.instance_url ?? connection.login_url ?? 'CRM',
			active: connection.is_active !== false,
			fields: {
				auth_type: connection.auth_type,
				login_url: connection.login_url ?? null,
				username: connection.username ?? null,
				client_id: connection.client_id ?? null,
				instance_url: connection.instance_url ?? null,
				has_valid_token: Boolean(connection.access_token),
			},
			secrets: {
				client_secret: secretInfo(connection.client_secret),
				// Cifrada: los últimos 4 del texto cifrado no dicen nada.
				password: { has_secret: Boolean(connection.password), secret_last4: null },
				security_token: secretInfo(connection.security_token),
			},
			last_sync_at: connection.last_sync_at ?? null,
			created_at: connection.created_at ?? null,
			updated_at: connection.updated_at ?? null,
		};
	}

	async getConnection(holdingId: string): Promise<ConnectionView> {
		return this.view(await this.current(holdingId));
	}

	async saveConnection(holdingId: string, input: CrmConnectionInput, actor: Actor): Promise<ConnectionView> {
		const current = await this.current(holdingId);
		const errors = [
			...(!current?.client_secret && !input.client_secret
				? [{ field: 'client_secret', message: 'Falta el secreto de la aplicación del CRM' }]
				: []),
			...(input.auth_type === 'password'
				? [
						...(!input.username && !current?.username ? [{ field: 'username', message: 'Falta el usuario del CRM' }] : []),
						...(!input.password && !current?.password ? [{ field: 'password', message: 'Falta la contraseña del CRM' }] : []),
						...(!input.security_token && !current?.security_token
							? [{ field: 'security_token', message: 'Falta el token de seguridad del CRM' }]
							: []),
					]
				: []),
		];

		if (errors.length) throw validationException(errors);
		await this.authService.storeConnectionWithoutAuth(
			{
				clientId: input.client_id,
				clientSecret: input.client_secret ?? '',
				loginUrl: input.login_url,
				username: input.username ?? current?.username,
				password: input.password,
				securityToken: input.security_token ?? current?.security_token,
			},
			actor.authId,
			holdingId,
			input.auth_type === 'password' ? SalesforceAuthType.PASSWORD : SalesforceAuthType.CLIENT_CREDENTIALS
		);

		return this.getConnection(holdingId);
	}

	async testConnection(holdingId: string): Promise<ConnectionTestResult> {
		await this.require(holdingId);
		const tested_at = new Date().toISOString();

		try {
			const result = await this.salesforceService.validateStoredCredentials(holdingId);

			return { ok: true, tested_at, message: 'Conexión correcta', details: { instance_url: result.instanceUrl ?? null } };
		} catch (error) {
			return { ok: false, tested_at, message: 'El CRM rechazó las credenciales o no respondió', details: { error: errorText(error) } };
		}
	}

	async setActive(holdingId: string, active: boolean): Promise<ConnectionView> {
		await this.require(holdingId);
		await this.connections.update({ holding_id: holdingId }, { is_active: active });

		return this.getConnection(holdingId);
	}

	async deleteImpact(holdingId: string): Promise<ImpactErrors> {
		const [row] = (await this.dataSource.query(
			`SELECT (SELECT count(*) FROM salesforce_product_mappings WHERE holding_id = $1) AS products,
				(SELECT count(*) FROM salesforce_quote_type_mappings WHERE holding_id = $1) AS quote_types,
				(SELECT count(*) FROM salesforce_sync_runs WHERE holding_id = $1 AND status = ANY($2::text[])) AS runs`,
			[holdingId, ACTIVE_RUN_STATUSES]
		)) as Row[];
		const impact: ImpactErrors = [];

		if (Number(row?.runs) > 0) impact.push({ field: 'runs', message: `${row.runs} ejecuciones en curso se detendrán` });
		if (Number(row?.products) + Number(row?.quote_types) > 0) {
			impact.push({ field: 'mappings', message: `${Number(row.products) + Number(row.quote_types)} mapeos (se conservan)` });
		}

		return impact;
	}

	async deleteConnection(holdingId: string): Promise<void> {
		await this.require(holdingId);
		await this.connections.delete({ holding_id: holdingId });
	}

	// ── Sincronizar e historial ─────────────────────────────────────────────────────────────────────────────────────────────

	async sync(holdingId: string): Promise<SyncStarted> {
		const connection = await this.current(holdingId);

		if (!connection) throw new BadRequestException('La integración no está conectada');
		if (connection.is_active === false) throw new BadRequestException('La integración está pausada');
		const since = new Date(Date.now() - LEASE_MS);
		const [running, [activeRun]] = await Promise.all([
			this.schedulerJobs
				.findOne({
					status: 'running',
					startedAt: { $gte: since },
					$or: [{ jobId: /^salesforce-daily-sync:/ }, { jobId: new RegExp(`^salesforce-holding-sync:[^:]+:${escapeRegex(holdingId)}:`) }],
				})
				.lean()
				.exec(),
			this.dataSource.query(`SELECT id FROM salesforce_sync_runs WHERE holding_id = $1 AND status = ANY($2::text[]) LIMIT 1`, [
				holdingId,
				ACTIVE_RUN_STATUSES,
			]) as Promise<Row[]>,
		]);

		if (running || activeRun) throw new ConflictException('Ya hay una sincronización en curso');
		const executionEnvironment = this.environment();
		const jobId = `salesforce-holding-sync:${executionEnvironment}:${holdingId}:${randomUUID()}`;
		const startedAt = new Date();

		await this.schedulerJobs.create({ jobId, status: 'running', startedAt, executionEnvironment, holdingResults: [] });
		setImmediate(() => {
			this.syncComplete
				.syncDailyModifiedOpportunities(holdingId, { jobId, executionEnvironment })
				.then(async (result) => {
					await this.schedulerJobs.updateOne(
						{ jobId },
						{
							status: result.success ? 'completed' : 'failed',
							completedAt: new Date(),
							durationSeconds: (Date.now() - startedAt.getTime()) / 1000,
							error: result.error ?? null,
							holdingResults: [
								{
									holding_id: holdingId,
									success: result.success,
									opportunities: result.stats?.opportunities || 0,
									clientsCreated: result.stats?.clientsCreated || 0,
									clientsUpdated: result.stats?.clientsUpdated || 0,
									quotesCreated: result.stats?.quotesCreated || 0,
									quotesUpdated: result.stats?.quotesUpdated || 0,
									sellersCreated: result.stats?.sellersCreated || 0,
									error: result.error,
									durationSeconds: result.duration_seconds || 0,
								},
							],
						}
					);
				})
				.catch(async (error) => {
					this.logger.error(`Sincronización manual del CRM falló (${holdingId}): ${errorText(error)}`);
					await this.schedulerJobs.updateOne({ jobId }, { status: 'failed', completedAt: new Date(), error: errorText(error) });
				});
		});

		return { run_id: `crm-job:${jobId}`, status: 'running', message: 'Trayendo las oportunidades ganadas del CRM' };
	}

	private jobToRun(job: SalesforceSchedulerJob, holdingId: string, errors: number): IntegrationRun {
		const result = (job.holdingResults ?? []).find((item) => item.holding_id === holdingId);
		const manual = job.jobId.startsWith('salesforce-holding-sync:') || job.jobId.includes(':manual:');
		const ok = (result?.quotesCreated ?? 0) + (result?.quotesUpdated ?? 0);
		// Oportunidades revisadas sin cotización nueva ni cambio (ya existía, nada que hacer) = sin cambios, no fallo.
		const totals = runTotals({ total: result?.opportunities ?? 0, ok, errors });

		return {
			id: `crm-job:${job.jobId}`,
			tipo: 'crm',
			kind: manual ? 'crm_manual' : 'crm_daily',
			kind_label: manual ? 'Sincronización manual' : 'Sincronización diaria',
			trigger: manual ? 'manual' : 'automatic',
			// `success: false` = falló la selección o algún lote (error de la corrida): "Falló" solo si no se procesó nada.
			status: runStatusOf({
				running: job.status === 'running',
				failed: job.status === 'failed' || result?.success === false,
				ok,
				unchanged: totals.unchanged,
				errors,
			}),
			started_at: job.startedAt ?? null,
			finished_at: job.completedAt ?? null,
			duration_ms: durationMs(job.startedAt, job.completedAt),
			totals,
			error: result?.error ?? job.error ?? null,
			metrics: {
				clients_created: result?.clientsCreated ?? 0,
				clients_updated: result?.clientsUpdated ?? 0,
				quotes_created: result?.quotesCreated ?? 0,
				quotes_updated: result?.quotesUpdated ?? 0,
				sellers_created: result?.sellersCreated ?? 0,
			},
		};
	}

	private pgRunToRun(row: Row): IntegrationRun {
		const meta = RUN_KINDS[String(row.type)] ?? { kind: 'crm_import', label: 'Ejecución' };
		const status = String(row.status);
		const ok = Number(row.completed_items) || 0;
		const errors = Number(row.failed_items) || 0;
		const totals = runTotals({ total: Number(row.total_items) || 0, ok, errors });

		return {
			id: `crm-run:${row.id}`,
			tipo: 'crm',
			kind: meta.kind,
			kind_label: meta.label,
			trigger: 'manual',
			status: runStatusOf({
				running: ACTIVE_RUN_STATUSES.includes(status),
				cancelled: status === 'cancelled',
				failed: status === 'failed',
				ok,
				unchanged: totals.unchanged,
				errors,
			}),
			started_at: (row.started_at as Date) ?? (row.created_at as Date) ?? null,
			finished_at: (row.finished_at as Date) ?? null,
			duration_ms: durationMs((row.started_at as Date) ?? (row.created_at as Date), row.finished_at as Date),
			totals,
			error: (row.error_message as string) ?? null,
			metrics: { date_from: row.date_from ?? null, date_to: row.date_to ?? null },
		};
	}

	private jobsFilter(holdingId: string) {
		return {
			$or: [{ 'holdingResults.holding_id': holdingId }, { jobId: new RegExp(`^salesforce-holding-sync:[^:]+:${escapeRegex(holdingId)}:`) }],
		};
	}

	private async errorCounts(holdingId: string, jobIds: string[]): Promise<Map<string, number>> {
		if (!jobIds.length) return new Map();
		const rows = (await this.syncLogs
			.aggregate([
				{ $match: { holdingId, jobId: { $in: jobIds }, level: 'error', stage: 'opportunity' } },
				{ $group: { _id: '$jobId', count: { $sum: 1 } } },
			])
			.exec()) as Array<{ _id: string; count: number }>;

		return new Map(rows.map((row) => [row._id, row.count]));
	}

	async listRuns(holdingId: string, query: RunsQuery): Promise<Paginated<IntegrationRun>> {
		const [jobs, pgRuns] = await Promise.all([
			this.schedulerJobs.find(this.jobsFilter(holdingId)).sort({ startedAt: -1 }).limit(RUNS_WINDOW).lean().exec() as Promise<
				SalesforceSchedulerJob[]
			>,
			this.dataSource.query(`SELECT * FROM salesforce_sync_runs WHERE holding_id = $1 ORDER BY created_at DESC LIMIT ${RUNS_WINDOW}`, [
				holdingId,
			]) as Promise<Row[]>,
		]);
		const errors = await this.errorCounts(
			holdingId,
			jobs.map((job) => job.jobId)
		);
		const runs = [...jobs.map((job) => this.jobToRun(job, holdingId, errors.get(job.jobId) ?? 0)), ...pgRuns.map((row) => this.pgRunToRun(row))];

		return paginateArray(sortRunsDesc(filterRuns(runs, query)), query.page, query.limit);
	}

	async getRun(holdingId: string, id: string): Promise<IntegrationRunDetail> {
		const parsed = parseRunId(id);

		if (parsed?.source === 'crm-job') {
			const job = (await this.schedulerJobs
				.findOne({ ...this.jobsFilter(holdingId), jobId: parsed.raw })
				.lean()
				.exec()) as SalesforceSchedulerJob | null;

			if (job) {
				const logs = (await this.syncLogs
					.find({ holdingId, jobId: job.jobId, stage: 'opportunity' })
					.sort({ occurredAt: 1 })
					.limit(2000)
					.lean()
					.exec()) as SalesforceSyncLog[];
				const records: RunRecord[] = logs.map((log) => ({
					object: 'opportunity',
					label: log.salesforceOpportunityName ?? log.salesforceOpportunityId ?? 'Oportunidad',
					sapira_id: null,
					external_id: log.salesforceOpportunityId ?? null,
					status: log.level === 'error' ? 'error' : log.level === 'warning' ? 'skipped' : 'ok',
					message: log.errorMessage ?? log.integrationNotes ?? log.message ?? null,
				}));
				const run = this.jobToRun(job, holdingId, records.filter((record) => record.status === 'error').length);

				return { ...run, records, errors_summary: errorsSummary(records) };
			}
		}
		if (parsed?.source === 'crm-run') {
			const [row] = (await this.dataSource.query(`SELECT * FROM salesforce_sync_runs WHERE id::text = $1 AND holding_id = $2`, [
				parsed.raw,
				holdingId,
			])) as Row[];

			if (row) {
				const items = (await this.dataSource.query(
					`SELECT it.salesforce_opportunity_id, it.status, it.error_message, s.salesforce_name, q.id AS quote_id
					FROM salesforce_sync_run_items it
					LEFT JOIN salesforce_opportunities_stg s ON s.holding_id = $2 AND s.salesforce_id = it.salesforce_opportunity_id
					LEFT JOIN LATERAL (SELECT id FROM quotes WHERE holding_id = $2 AND salesforce_opportunity_id = it.salesforce_opportunity_id LIMIT 1) q ON true
					WHERE it.run_id = $1 ORDER BY it.created_at`,
					[row.id, holdingId]
				)) as Row[];
				const records: RunRecord[] = items.map((item) => ({
					object: 'opportunity',
					label: String(item.salesforce_name ?? item.salesforce_opportunity_id),
					sapira_id: (item.quote_id as string) ?? null,
					external_id: String(item.salesforce_opportunity_id),
					status: item.status === 'completed' ? 'ok' : item.status === 'error' ? 'error' : 'skipped',
					message: (item.error_message as string) ?? null,
				}));

				return { ...this.pgRunToRun(row), records, errors_summary: errorsSummary(records) };
			}
		}
		throw new NotFoundException('Corrida no encontrada');
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	recordSources(): RecordSource[] {
		return [
			{
				object: 'opportunity',
				label: 'Oportunidad',
				table: 'salesforce_opportunities_stg',
				direction: 'import',
				importable: true,
				importByIds: true,
				computedFields: OPPORTUNITY_COMPUTED_FIELDS,
				sql: `SELECT s.salesforce_id AS record_key,
						concat_ws(' · ', COALESCE(s.salesforce_name, s.raw_data->>'Name'), s.raw_data->'Account'->>'Name') AS label,
						q.id::text AS sapira_id, s.salesforce_id AS external_id,
						${stagingStatusSql('s.processing_status')} AS status,
						COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at,
						to_jsonb(s.*) || ${OPPORTUNITY_COMPUTED_SQL} AS rule_row
					FROM salesforce_opportunities_stg s
					LEFT JOIN LATERAL (SELECT id FROM quotes WHERE holding_id = s.holding_id AND salesforce_opportunity_id = s.salesforce_id LIMIT 1) q ON true
					WHERE s.holding_id = $1`,
			},
			{
				object: 'account',
				label: 'Cuenta',
				table: 'salesforce_accounts_stg',
				direction: 'import',
				importable: true,
				importByIds: true,
				sql: `SELECT s.salesforce_id AS record_key, COALESCE(s.salesforce_name, s.raw_data->>'Name') AS label,
						NULL::text AS sapira_id, s.salesforce_id AS external_id,
						${stagingStatusSql('s.processing_status')} AS status,
						COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at, to_jsonb(s.*) AS rule_row
					FROM salesforce_accounts_stg s WHERE s.holding_id = $1`,
			},
		];
	}

	async importRecords(holdingId: string, request: ImportRequest, _actor: Actor, discarded: Set<string>): Promise<ImportStarted> {
		if (request.object === 'opportunity') {
			const candidates = request.all
				? await this.staging.getEligibleOpportunityIdsForProcessing(holdingId, ['create', 'update'])
				: (request.ids ?? []);
			const ids = candidates.filter((id) => !discarded.has(id));

			if (!ids.length) throw new BadRequestException('No hay oportunidades para importar');
			const run = await this.syncRuns.createRun(holdingId, 'process_final', ids);

			return { run_id: `crm-run:${run.id}`, status: 'running', message: 'Importando las oportunidades a Sapira', accepted: ids.length };
		}
		if (request.object === 'account') {
			const candidates = request.all
				? (
						(await this.dataSource.query(
							`SELECT salesforce_id FROM salesforce_accounts_stg WHERE holding_id = $1 AND processing_status IN ('create','update','error')`,
							[holdingId]
						)) as Row[]
					).map((row) => String(row.salesforce_id))
				: (request.ids ?? []);
			const ids = candidates.filter((id) => !discarded.has(id));

			if (!ids.length) throw new BadRequestException('No hay cuentas para importar');
			setImmediate(() => {
				this.syncComplete
					.processAccountsStaging(holdingId, ids)
					.catch((error) => this.logger.error(`Importación de cuentas del CRM falló (${holdingId}): ${errorText(error)}`));
			});

			return { run_id: null, status: 'running', message: 'Importando las cuentas seleccionadas', accepted: ids.length };
		}
		throw validationException([{ field: 'object', message: 'Este objeto no se importa' }]);
	}

	// ── Traer oportunidades (A5) ────────────────────────────────────────────────────────────────────────────────────────────

	async fetchOpportunities(holdingId: string, input: CrmFetchInput) {
		const connection = await this.current(holdingId);

		if (!connection) throw new BadRequestException('La integración no está conectada');
		let preview: { items: Array<Record<string, any>> };

		try {
			preview = await this.syncComplete.previewOpportunitiesAgainstStaging(
				holdingId,
				input.opportunity_ids?.length ? undefined : input.date_from,
				input.opportunity_ids?.length ? undefined : input.date_to,
				input.opportunity_ids?.length ? input.opportunity_ids : undefined,
				input.stages
			);
		} catch (error) {
			throw new BadGatewayException(`El CRM no respondió: ${errorText(error)}`);
		}
		const ids = preview.items.map((item) => String(item.opportunity?.Id));
		const quotes = ids.length
			? ((await this.dataSource.query(
					`SELECT id, salesforce_opportunity_id FROM quotes WHERE holding_id = $1 AND salesforce_opportunity_id = ANY($2::text[])`,
					[holdingId, ids]
				)) as Row[])
			: [];
		const quoteByOpportunity = new Map(quotes.map((quote) => [String(quote.salesforce_opportunity_id), String(quote.id)]));
		const statusRank = { new: 0, changed: 1, synchronized: 2 } as const;
		const data = preview.items
			.map((item) => {
				const opportunity = item.opportunity ?? {};
				const status: keyof typeof statusRank = item.status === 'synchronized' ? 'synchronized' : item.status === 'new' ? 'new' : 'changed';

				return {
					id: String(opportunity.Id),
					name: opportunity.Name ?? null,
					account: opportunity.Account?.Name ?? null,
					close_date: opportunity.CloseDate ?? null,
					stage: opportunity.StageName ?? null,
					amount: opportunity.Amount ?? null,
					currency: opportunity.CurrencyIsoCode ?? null,
					owner: opportunity.Owner?.Name ?? null,
					type: opportunity.Type ?? null,
					line_items: (opportunity.OpportunityLineItems?.records ?? []).length,
					status,
					reasons: ((item.reasons ?? []) as string[]).map((reason) =>
						reason
							.replace('La oportunidad no existe en staging', 'La oportunidad todavía no llegó a Sapira')
							.replace('El cliente no existe en staging', 'La cuenta todavía no llegó a Sapira')
							.replace(/en Salesforce/g, 'en el CRM')
							.replace('Productos sin mapping activo', 'Productos sin relacionar')
					),
					unmapped_products: ((item.unmappedProducts ?? []) as Array<{ id: string; name: string }>).map((product) => ({
						id: product.id,
						name: product.name,
					})),
					quote_id: quoteByOpportunity.get(String(opportunity.Id)) ?? null,
				};
			})
			.sort((a, b) => statusRank[a.status] - statusRank[b.status] || String(b.close_date ?? '').localeCompare(String(a.close_date ?? '')));

		return {
			stages: input.stages,
			date_from: input.opportunity_ids?.length ? null : input.date_from,
			date_to: input.opportunity_ids?.length ? null : input.date_to,
			data,
			total: data.length,
		};
	}

	async importOpportunities(holdingId: string, ids: string[], mode: 'full' | 'review'): Promise<ImportStarted> {
		const run = await this.syncRuns.createRun(holdingId, mode === 'review' ? 'update_staging' : 'retry_full', ids);

		return {
			run_id: `crm-run:${run.id}`,
			status: 'running',
			message: mode === 'review' ? 'Trayendo las oportunidades a revisión' : 'Trayendo e importando las oportunidades',
			accepted: run.total_items,
		};
	}

	/** Etapas de oportunidad del CRM, en vivo. */
	async stages(holdingId: string) {
		try {
			const result = await this.salesforceService.executeQuery(
				'SELECT ApiName, MasterLabel, IsWon, IsClosed FROM OpportunityStage WHERE IsActive = true ORDER BY SortOrder',
				holdingId
			);
			const records = ((result.data as { records?: Row[] })?.records ?? []) as Row[];

			return {
				data: records.map((record) => ({
					value: String(record.MasterLabel ?? record.ApiName),
					label: String(record.MasterLabel ?? record.ApiName),
					is_won: record.IsWon === true,
					is_closed: record.IsClosed === true,
				})),
				available: true,
				error: null,
			};
		} catch (error) {
			return { data: [], available: false, error: `El CRM no respondió: ${errorText(error)}` };
		}
	}

	// ── Mapeos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async externalProducts(holdingId: string): Promise<Ref[]> {
		const rows = (await this.dataSource.query(
			`SELECT id, max(name) AS name, max(code) AS code, max(family) AS family,
				count(DISTINCT opportunity_id) FILTER (WHERE waiting = 1)::int AS waiting, count(DISTINCT opportunity_id)::int AS opportunities FROM (
				SELECT li.salesforce_product_id AS id, li.raw_data->'Product2'->>'Name' AS name, li.raw_data->'Product2'->>'ProductCode' AS code,
					li.raw_data->'Product2'->>'Family' AS family, li.salesforce_opportunity_id AS opportunity_id,
					CASE WHEN o.processing_status IS DISTINCT FROM 'processed' THEN 1 ELSE 0 END AS waiting
				FROM salesforce_line_items_stg li
				LEFT JOIN salesforce_opportunities_stg o ON o.holding_id = li.holding_id AND o.salesforce_id = li.salesforce_opportunity_id
				WHERE li.holding_id = $1 AND li.salesforce_product_id IS NOT NULL
				UNION ALL
				SELECT salesforce_product_id, salesforce_product_name, salesforce_product_code, salesforce_family, NULL, 0
				FROM salesforce_product_mappings WHERE holding_id = $1
			) t GROUP BY id ORDER BY lower(max(name))`,
			[holdingId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			label: String(row.name ?? row.id),
			meta: {
				code: row.code ?? null,
				family: row.family ?? null,
				waiting: Number(row.waiting) || 0,
				opportunities: Number(row.opportunities) || 0,
			},
		}));
	}

	private async sapiraProducts(holdingId: string): Promise<Ref[]> {
		const rows = (await this.dataSource.query(`SELECT id, name, product_code FROM products WHERE holding_id = $1 ORDER BY lower(name)`, [
			holdingId,
		])) as Row[];

		return rows.map((row) => ({ id: String(row.id), label: String(row.name ?? ''), meta: { code: row.product_code ?? null } }));
	}

	private async externalOwners(holdingId: string): Promise<Ref[]> {
		const rows = (await this.dataSource.query(
			`SELECT raw_data->>'OwnerId' AS id, max(raw_data->'Owner'->>'Name') AS name, max(raw_data->'Owner'->>'Email') AS email
			FROM salesforce_opportunities_stg WHERE holding_id = $1 AND raw_data->>'OwnerId' IS NOT NULL GROUP BY 1 ORDER BY 2`,
			[holdingId]
		)) as Row[];

		return rows.map((row) => ({ id: String(row.id), label: String(row.name ?? row.email ?? row.id), meta: { email: row.email ?? null } }));
	}

	private quoteTypeRefs(): Ref[] {
		return QUOTE_TYPE_CODES.map((code) => ({ id: code, label: QUOTE_TYPE_LABELS[code], meta: {} }));
	}

	async getMapping(holdingId: string, object: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		if (object === 'fields') return this.fields.crmView(this.mappings, holdingId, query);
		if (object === 'products') {
			const [externals, sapira, mappings] = await Promise.all([
				this.externalProducts(holdingId),
				this.sapiraProducts(holdingId),
				this.mappings.getProductMappings(holdingId),
			]);
			const sapiraById = new Map(sapira.map((ref) => [ref.id, ref]));
			const rows: MappingRow[] = externals.map((external) => {
				const mapping = mappings.find((item) => item.salesforce_product_id === external.id && item.is_active !== false);
				const mapped = mapping
					? (sapiraById.get(mapping.sapira_product_id) ?? { id: mapping.sapira_product_id, label: mapping.sapira_product_name, meta: {} })
					: null;
				const suggestion = mapped ? null : suggestRef({ label: external.label, code: external.meta.code }, sapira);

				return {
					key: external.id,
					sapira: mapped,
					external,
					status: mapped ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: {
						opportunities: Number(external.meta.opportunities) || 0,
						opportunities_waiting: mapped ? 0 : Number(external.meta.waiting) || 0,
					},
					meta: null,
				};
			});

			return buildMappingView(
				{ object, object_label: 'Productos', anchor: 'external', external_available: true, external_error: null },
				rows,
				query
			);
		}
		if (object === 'quote_types') {
			const [types, mappings] = await Promise.all([
				this.dataSource.query(
					`SELECT type, sum(n)::int AS n FROM (
						SELECT raw_data->>'Type' AS type, 1 AS n FROM salesforce_opportunities_stg WHERE holding_id = $1 AND raw_data->>'Type' IS NOT NULL
						UNION ALL SELECT salesforce_type, 0 FROM salesforce_quote_type_mappings WHERE holding_id = $1
					) t GROUP BY type ORDER BY type`,
					[holdingId]
				) as Promise<Row[]>,
				this.mappings.getQuoteTypeMappings(holdingId),
			]);
			const refs = this.quoteTypeRefs();
			const rows: MappingRow[] = types.map((type) => {
				const external: Ref = { id: String(type.type), label: String(type.type), meta: {} };
				const mapping = mappings.find((item) => item.salesforce_type === external.id && item.is_active !== false);
				const code = mapping ? normalizeQuoteType(mapping.sapira_quote_type) : null;
				const suggestedCode = mapping ? null : normalizeQuoteType(external.id);
				const mapped = mapping
					? (refs.find((ref) => ref.id === code) ?? { id: mapping.sapira_quote_type, label: mapping.sapira_quote_type, meta: {} })
					: null;
				const suggestion = suggestedCode ? (refs.find((ref) => ref.id === suggestedCode) ?? null) : null;

				return {
					key: external.id,
					sapira: mapped,
					external,
					status: mapped ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: { opportunities: Number(type.n) || 0 },
					meta: null,
				};
			});

			return buildMappingView(
				{ object, object_label: 'Tipos de cotización', anchor: 'external', external_available: true, external_error: null },
				rows,
				query
			);
		}
		if (object === 'owners') {
			// Por origen (ajuste de Domi): el CRM origina el dueño → una fila por dueño de oportunidades del CRM (y los ya relacionados);
			// los vendedores de Sapira sin dueño del CRM no aparecen ni cuentan como sin mapear.
			const [owners, sellers, usage] = await Promise.all([
				this.externalOwners(holdingId),
				this.dataSource.query(`SELECT s.id, s.name, s.email, s.crm_owner_id FROM sellers s WHERE s.holding_id = $1 ORDER BY lower(s.name)`, [
					holdingId,
				]) as Promise<Row[]>,
				this.dataSource.query(
					`SELECT raw_data->>'OwnerId' AS id, count(*)::int AS n FROM salesforce_opportunities_stg WHERE holding_id = $1 AND raw_data->>'OwnerId' IS NOT NULL GROUP BY 1`,
					[holdingId]
				) as Promise<Row[]>,
			]);
			const sellerRefs: Ref[] = sellers.map((seller) => ({
				id: String(seller.id),
				label: String(seller.name ?? ''),
				meta: { email: seller.email ?? null, technical_email: String(seller.email ?? '').endsWith('@salesforce.local') },
			}));
			const opportunities = new Map(usage.map((row) => [String(row.id), Number(row.n) || 0]));
			const byOwner = new Map(owners.map((owner) => [owner.id, owner]));
			const ownerIds = [
				...new Set([
					...owners.map((owner) => owner.id),
					...sellers.filter((seller) => seller.crm_owner_id).map((seller) => String(seller.crm_owner_id)),
				]),
			];
			const rows: MappingRow[] = ownerIds.map((ownerId) => {
				const external = byOwner.get(ownerId) ?? { id: ownerId, label: ownerId, meta: { email: null } };
				const seller = sellers.find((item) => item.crm_owner_id === ownerId);
				const email = normalizeText(external.meta.email);
				const suggestion = seller
					? null
					: (sellerRefs.find(
							(ref) =>
								(email && normalizeText(ref.meta.email) === email) ||
								normalizeText(ref.meta.email) === normalizeText(`sf_${ownerId.toLowerCase()}@salesforce.local`)
						) ?? null);

				return {
					key: ownerId,
					sapira: seller ? (sellerRefs.find((ref) => ref.id === String(seller.id)) ?? null) : null,
					external,
					status: seller ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: { opportunities: opportunities.get(ownerId) ?? 0 },
					meta: null,
				};
			});

			return buildMappingView(
				{ object, object_label: 'Vendedores', anchor: 'external', external_available: true, external_error: null },
				rows,
				query
			);
		}
		throw new NotFoundException('Mapeo no encontrado');
	}

	async mappingOptions(holdingId: string, object: string, side: 'sapira' | 'external', search?: string) {
		if (object === 'fields') return this.fields.crmOptions(this.mappings, holdingId, search);
		let refs: Ref[];

		if (object === 'products') refs = side === 'sapira' ? await this.sapiraProducts(holdingId) : await this.externalProducts(holdingId);
		else if (object === 'quote_types')
			refs = side === 'sapira' ? this.quoteTypeRefs() : (await this.getMapping(holdingId, object, {})).data.map((row) => row.external as Ref);
		else if (object === 'owners') {
			refs =
				side === 'external'
					? await this.externalOwners(holdingId)
					: (
							(await this.dataSource.query(`SELECT id, name, email FROM sellers WHERE holding_id = $1 ORDER BY lower(name)`, [
								holdingId,
							])) as Row[]
						).map((row) => ({
							id: String(row.id),
							label: String(row.name ?? ''),
							meta: { email: row.email ?? null },
						}));
		} else throw new NotFoundException('Mapeo no encontrado');

		return { data: filterRefs(refs, search), available: true, error: null };
	}

	private async assertOwned(holdingId: string, table: 'products' | 'sellers', items: MappingItem[]): Promise<Map<string, Row>> {
		const rows = (await this.dataSource.query(`SELECT id::text AS id, name FROM ${table} WHERE holding_id = $1 AND id::text = ANY($2::text[])`, [
			holdingId,
			items.map((item) => item.sapira_id),
		])) as Row[];
		const owned = new Map(rows.map((row) => [String(row.id), row]));
		const errors = items.flatMap((item, index) =>
			owned.has(item.sapira_id) ? [] : [{ field: `items.${index}.sapira_id`, message: 'No pertenece a este holding' }]
		);

		if (errors.length) throw validationException(errors);

		return owned;
	}

	async putMapping(holdingId: string, object: string, items: MappingItem[]): Promise<void> {
		if (object === 'fields') return this.fields.crmPut(this.mappings, holdingId, items);
		if (object === 'products') {
			const owned = await this.assertOwned(holdingId, 'products', items);
			const externals = new Map((await this.externalProducts(holdingId)).map((ref) => [ref.id, ref]));

			for (const item of items) {
				const external = externals.get(item.external_id);

				await this.mappings.createProductMapping(holdingId, {
					salesforce_product_id: item.external_id,
					salesforce_product_name: String(external?.label ?? item.meta?.external_label ?? item.external_id),
					salesforce_product_code: (external?.meta.code as string) ?? undefined,
					salesforce_family: (external?.meta.family as string) ?? undefined,
					sapira_product_id: item.sapira_id,
					sapira_product_name: String(owned.get(item.sapira_id)?.name ?? ''),
				});
			}

			return;
		}
		if (object === 'quote_types') {
			const errors = items.flatMap((item, index) =>
				(QUOTE_TYPE_CODES as readonly string[]).includes(item.sapira_id)
					? []
					: [{ field: `items.${index}.sapira_id`, message: 'Tipo de cotización no válido' }]
			);

			if (errors.length) throw validationException(errors);
			for (const item of items) {
				await this.mappings.createQuoteTypeMapping(holdingId, {
					salesforce_type: item.external_id,
					sapira_quote_type: item.sapira_id as QuoteTypeCode,
				});
			}

			return;
		}
		if (object === 'owners') {
			await this.assertOwned(holdingId, 'sellers', items);
			const ownerIds = items.map((item) => item.external_id);

			if (new Set(ownerIds).size !== ownerIds.length)
				throw validationException([{ field: 'items', message: 'Un dueño del CRM solo puede ir con un vendedor' }]);
			await this.dataSource.transaction(async (manager) => {
				for (const item of items) {
					await manager.query(`UPDATE sellers SET crm_owner_id = NULL WHERE holding_id = $1 AND crm_owner_id = $2 AND id::text <> $3`, [
						holdingId,
						item.external_id,
						item.sapira_id,
					]);
					await manager.query(`UPDATE sellers SET crm_owner_id = $3 WHERE holding_id = $1 AND id::text = $2`, [
						holdingId,
						item.sapira_id,
						item.external_id,
					]);
				}
			});

			return;
		}
		throw new NotFoundException('Mapeo no encontrado');
	}

	async deleteMapping(holdingId: string, object: string, sapiraId: string, externalId: string): Promise<void> {
		if (object === 'fields') return this.fields.crmDelete(this.mappings, holdingId, sapiraId);
		if (object === 'products') {
			const mapping = (await this.mappings.getProductMappings(holdingId)).find(
				(item) => item.salesforce_product_id === externalId && item.sapira_product_id === sapiraId
			);

			if (!mapping) throw new NotFoundException('Mapeo no encontrado');
			await this.mappings.deleteProductMapping(mapping.id, holdingId);

			return;
		}
		if (object === 'quote_types') {
			const mapping = (await this.mappings.getQuoteTypeMappings(holdingId)).find(
				(item) => item.salesforce_type === externalId && normalizeQuoteType(item.sapira_quote_type) === normalizeQuoteType(sapiraId)
			);

			if (!mapping) throw new NotFoundException('Mapeo no encontrado');
			await this.mappings.deleteQuoteTypeMapping(mapping.id, holdingId);

			return;
		}
		if (object === 'owners') {
			const result = (await this.dataSource.query(
				`UPDATE sellers SET crm_owner_id = NULL WHERE holding_id = $1 AND id::text = $2 AND crm_owner_id = $3 RETURNING id`,
				[holdingId, sapiraId, externalId]
			)) as unknown[];
			const updated = Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;

			if (!updated) throw new NotFoundException('Mapeo no encontrado');

			return;
		}
		throw new NotFoundException('Mapeo no encontrado');
	}

	async pendingMapping(holdingId: string): Promise<number> {
		const [products, types] = await Promise.all([this.getMapping(holdingId, 'products', {}), this.getMapping(holdingId, 'quote_types', {})]);
		const [owners] = (await this.dataSource.query(
			`SELECT count(DISTINCT o.raw_data->>'OwnerId') AS n FROM salesforce_opportunities_stg o
			WHERE o.holding_id = $1 AND o.raw_data->>'OwnerId' IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM sellers s WHERE s.holding_id = $1 AND s.crm_owner_id = o.raw_data->>'OwnerId')`,
			[holdingId]
		)) as Row[];

		return products.counts.total - products.counts.mapped + (types.counts.total - types.counts.mapped) + (Number(owners?.n) || 0);
	}

	schedule(): ScheduleInfo {
		const enabled = this.config.get<string>('SALESFORCE_SYNC_ENABLED') !== 'false';

		return {
			daily_at: '08:30',
			timezone: 'America/Santiago',
			window_days: DAILY_SYNC_WINDOW_DAYS,
			enabled,
			next_at: enabled ? nextDailyAtInZone(8, 30, 'America/Santiago').toISOString() : null,
		};
	}
}
