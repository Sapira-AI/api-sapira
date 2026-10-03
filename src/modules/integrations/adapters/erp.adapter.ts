import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { OdooConnection } from '@/databases/postgresql/entities/integraciones/odoo/odoo-connection.entity';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';
import { InvoiceSchedulerJob, InvoiceSchedulerJobDocument } from '@/modules/invoices/schemas/invoice-scheduler-job.schema';
import { InvoiceProcessingService } from '@/modules/odoo/invoice-processing.service';
import { OdooConnectionService } from '@/modules/odoo/odoo-connection.service';
import { OdooInvoicesService } from '@/modules/odoo/odoo-invoices.service';
import { OdooProvider } from '@/modules/odoo/odoo.provider';
import { OdooService } from '@/modules/odoo/odoo.service';
import { PartnersProcessorService } from '@/modules/odoo/services/partners-processor.service';

import {
	Actor,
	buildMappingView,
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
	nextDailyAt,
	paginateArray,
	Paginated,
	parseRunId,
	RecordSource,
	Ref,
	RunRecord,
	RunsQuery,
	runStatusOf,
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

/** Facturas por enviar al ERP (misma idea que la cola del envío: Por Emitir, activas, sin enviar). */
const PENDING_SEND_SQL = `i.holding_id = $1 AND i.is_active = true AND i.status = 'Por Emitir' AND i.sent_to_odoo_at IS NULL`;
const LOCK_WINDOW_MS = 3 * 60 * 60 * 1000;
const RUNS_WINDOW = 300;

export interface ErpConnectionInput {
	name: string;
	url: string;
	database_name: string;
	username: string;
	api_key?: string;
	subscription_code?: string | null;
}

/**
 * ERP (Odoo). Reutiliza `OdooService` (compañías, productos, mapeos, mapeo de campos), `OdooInvoicesService` (impuestos),
 * `InvoiceSchedulerService` (envío de facturas = "Sincronizar ahora"), `InvoiceProcessingService` y `PartnersProcessorService` (importar
 * desde las tablas intermedias). El historial lee `invoice_scheduler_jobs` (Mongo), filtrado a las facturas del holding (A7).
 */
@Injectable()
export class ErpAdapter implements IntegrationAdapter {
	readonly tipo = 'erp' as const;
	readonly mappingObjects = ['companies', 'products', 'fields'];
	readonly defaultRules: IntegrationRules = { exclude_sapira_invoices: true };
	private readonly logger = new Logger(ErpAdapter.name);
	private readonly fields: FieldsMappingHelper;
	/** Trabajos de importación en memoria de `InvoiceProcessingService` (no guardan holding): solo se muestran al holding que los inició. */
	private readonly importJobs = new Map<string, string>();

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(OdooConnection) private readonly connections: Repository<OdooConnection>,
		private readonly odooConnectionService: OdooConnectionService,
		private readonly odooService: OdooService,
		private readonly odooInvoicesService: OdooInvoicesService,
		private readonly odooProvider: OdooProvider,
		private readonly invoiceProcessing: InvoiceProcessingService,
		private readonly partnersProcessor: PartnersProcessorService,
		private readonly invoiceScheduler: InvoiceSchedulerService,
		@InjectModel(InvoiceSchedulerJob.name) private readonly schedulerJobs: Model<InvoiceSchedulerJobDocument>,
		private readonly config: ConfigService
	) {
		this.fields = new FieldsMappingHelper(dataSource);
	}

	// ── Conexión ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** La conexión vigente: la más reciente activa (regla del envío) o, si ninguna está activa, la más reciente. */
	async current(holdingId: string): Promise<OdooConnection | null> {
		const rows = await this.connections.find({ where: { holding_id: holdingId }, order: { created_at: 'DESC' } });

		return rows.find((row) => row.is_active !== false) ?? rows[0] ?? null;
	}

	private async require(holdingId: string): Promise<OdooConnection> {
		const connection = await this.current(holdingId);

		if (!connection) throw new NotFoundException('No hay una conexión con el ERP');

		return connection;
	}

	private view(connection: OdooConnection | null): ConnectionView {
		if (!connection) return emptyConnection('erp');

		return {
			tipo: 'erp',
			system: 'odoo',
			connected: true,
			id: connection.id,
			name: connection.name,
			active: connection.is_active !== false,
			fields: {
				url: connection.url,
				database_name: connection.database_name,
				username: connection.username ?? null,
				subscription_code: connection.subscription_code ?? null,
			},
			secrets: { api_key: secretInfo(connection.api_key) },
			last_sync_at: connection.last_sync_at ?? null,
			created_at: connection.created_at ?? null,
			updated_at: connection.updated_at ?? null,
		};
	}

	async getConnection(holdingId: string): Promise<ConnectionView> {
		return this.view(await this.current(holdingId));
	}

	async saveConnection(holdingId: string, input: ErpConnectionInput, actor: Actor): Promise<ConnectionView> {
		const current = await this.current(holdingId);
		const data = {
			name: input.name.trim(),
			url: input.url.trim().replace(/\/+$/, ''),
			database_name: input.database_name.trim(),
			username: input.username.trim(),
			subscription_code: input.subscription_code ?? undefined,
			...(input.api_key ? { api_key: input.api_key } : {}),
		};

		if (current) return this.view(await this.odooConnectionService.update(current.id, data as never));
		if (!input.api_key) throw validationException([{ field: 'api_key', message: 'Falta la clave de la API del ERP' }]);

		return this.view(
			await this.odooConnectionService.create({ ...data, api_key: input.api_key, holding_id: holdingId, user_id: actor.authId } as never)
		);
	}

	async testConnection(holdingId: string): Promise<ConnectionTestResult> {
		const connection = await this.require(holdingId);
		const tested_at = new Date().toISOString();

		try {
			const common = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/common`);
			const object = this.odooProvider.createXmlRpcClient(`${connection.url}/xmlrpc/2/object`);
			const version = (await common.methodCall('version', [])) as { server_version?: string } | null;
			const uid = await common.methodCall('authenticate', [connection.database_name, connection.username, connection.api_key, {}]);

			if (!uid)
				return { ok: false, tested_at, message: 'El ERP rechazó las credenciales', details: { version: version?.server_version ?? null } };
			const companies = await object.methodCall('execute_kw', [
				connection.database_name,
				uid,
				connection.api_key,
				'res.company',
				'search_count',
				[[]],
			]);

			return {
				ok: true,
				tested_at,
				message: 'Conexión correcta',
				details: { version: version?.server_version ?? null, companies: Number(companies) || 0 },
			};
		} catch (error) {
			return { ok: false, tested_at, message: 'No pudimos conectarnos con el ERP', details: { error: errorText(error) } };
		}
	}

	async setActive(holdingId: string, active: boolean): Promise<ConnectionView> {
		const connection = await this.require(holdingId);

		return this.view(await this.odooConnectionService.update(connection.id, { is_active: active } as never));
	}

	async deleteImpact(holdingId: string): Promise<ImpactErrors> {
		const [row] = (await this.dataSource.query(
			`SELECT (SELECT count(*) FROM invoices i WHERE ${PENDING_SEND_SQL}) AS invoices,
				(SELECT count(*) FROM odoo_product_mappings m WHERE m.holding_id = $1) AS mappings`,
			[holdingId]
		)) as Row[];
		const impact: ImpactErrors = [];

		if (Number(row?.invoices) > 0) impact.push({ field: 'invoices_pending', message: `${row.invoices} facturas por enviar al ERP` });
		if (Number(row?.mappings) > 0) impact.push({ field: 'mappings', message: `${row.mappings} productos mapeados (se conservan)` });

		return impact;
	}

	async deleteConnection(holdingId: string): Promise<void> {
		await this.odooConnectionService.delete((await this.require(holdingId)).id);
	}

	// ── Sincronizar e historial ─────────────────────────────────────────────────────────────────────────────────────────────

	async sync(holdingId: string, actor: Actor): Promise<SyncStarted> {
		const connection = await this.current(holdingId);

		if (!connection) throw new BadRequestException('La integración no está conectada');
		if (connection.is_active === false) throw new BadRequestException('La integración está pausada');
		const running = await this.schedulerJobs
			.findOne({
				status: { $in: ['pending', 'running'] },
				holdingId: { $in: [holdingId, 'all'] },
				startedAt: { $gte: new Date(Date.now() - LOCK_WINDOW_MS) },
			})
			.lean()
			.exec();

		if (running) throw new ConflictException('Ya hay una sincronización en curso');
		const jobId = await this.invoiceScheduler.startSchedulerJob({ dryRun: false, holdingId, userId: actor.authId });

		return { run_id: `erp-send:${jobId}`, status: 'running', message: 'Enviando las facturas pendientes al ERP' };
	}

	private jobToRun(job: InvoiceSchedulerJob & { _id?: unknown }, holdingId: string): { run: IntegrationRun; records: RunRecord[] } {
		const results = ((job.result?.results ?? []) as unknown as Row[]).filter(
			(result) => job.holdingId !== 'all' || String(result.holdingId ?? '') === holdingId
		);
		const records: RunRecord[] = results.map((result) => ({
			object: 'invoice',
			label: [result.invoiceNumber || 'Factura sin folio', result.clientName].filter(Boolean).join(' · '),
			sapira_id: (result.invoiceId as string) ?? null,
			external_id: result.odooInvoiceId ? String(result.odooInvoiceId) : null,
			status: result.status === 'sent' ? 'ok' : result.status === 'error' ? 'error' : 'skipped',
			message: (result.error as string) ?? (result.details as string) ?? null,
		}));
		const scoped = job.holdingId === 'all';
		const progress = job.progress ?? { total: 0, sent: 0, errors: 0, skipped: 0 };
		const totals = scoped
			? {
					total: records.length,
					ok: records.filter((r) => r.status === 'ok').length,
					errors: records.filter((r) => r.status === 'error').length,
					skipped: records.filter((r) => r.status === 'skipped').length,
				}
			: { total: progress.total ?? 0, ok: progress.sent ?? 0, errors: progress.errors ?? 0, skipped: progress.skipped ?? 0 };
		const running = job.status === 'pending' || job.status === 'running';

		return {
			run: {
				id: `erp-send:${job.jobId}`,
				tipo: 'erp',
				kind: 'export_invoices',
				kind_label: 'Envío de facturas al ERP',
				trigger: job.executionSource === 'automatic' ? 'automatic' : 'manual',
				status: runStatusOf({ running, failed: job.status === 'failed' && totals.ok === 0, ok: totals.ok, errors: totals.errors }),
				started_at: job.startedAt ?? null,
				finished_at: job.completedAt ?? null,
				duration_ms: durationMs(job.startedAt, job.completedAt),
				totals,
				error: job.error ?? null,
				metrics: { environment: job.executionEnvironment ?? 'unknown' },
			},
			records,
		};
	}

	private jobsFilter(holdingId: string) {
		return {
			dryRun: false,
			$or: [{ holdingId }, { holdingId: 'all', 'result.results.holdingId': holdingId }],
		};
	}

	/** Importación de facturas del ERP (`InvoiceProcessingService`, trabajo en memoria del proceso). */
	private importJobToRun(jobId: string, job: Row): IntegrationRun {
		const ok = Number(job.records_success ?? 0);
		const errors = Number(job.records_failed ?? 0);

		return {
			id: `erp-import:${jobId}`,
			tipo: 'erp',
			kind: 'import_invoices',
			kind_label: 'Importación de facturas del ERP',
			trigger: 'manual',
			status: runStatusOf({
				running: job.status === 'running',
				failed: job.status === 'failed',
				cancelled: job.status === 'cancelled',
				ok,
				errors,
			}),
			started_at: (job.started_at as Date) ?? null,
			finished_at: (job.completed_at as Date) ?? null,
			duration_ms: durationMs(job.started_at as Date, job.completed_at as Date),
			totals: { total: Number(job.records_processed ?? 0), ok, errors, skipped: 0 },
			error: job.status === 'failed' && job.error_details ? errorText(job.error_details) : null,
			metrics: { progress: job.progress_percentage ?? null },
		};
	}

	private async importRuns(holdingId: string): Promise<IntegrationRun[]> {
		const ids = [...this.importJobs.entries()].filter(([, holding]) => holding === holdingId).map(([id]) => id);
		const jobs = await Promise.all(
			ids.map(async (id) => [id, (await this.invoiceProcessing.getJobStatus(id)) as unknown as Row | null] as const)
		);

		return jobs.flatMap(([id, job]) => (job ? [this.importJobToRun(id, job)] : []));
	}

	async listRuns(holdingId: string, query: RunsQuery): Promise<Paginated<IntegrationRun>> {
		const [jobs, imports] = await Promise.all([
			this.schedulerJobs.find(this.jobsFilter(holdingId)).sort({ startedAt: -1 }).limit(RUNS_WINDOW).lean().exec() as Promise<
				InvoiceSchedulerJob[]
			>,
			this.importRuns(holdingId),
		]);
		const runs = [...jobs.map((job) => this.jobToRun(job, holdingId).run), ...imports];

		return paginateArray(sortRunsDesc(filterRuns(runs, query)), query.page, query.limit);
	}

	async getRun(holdingId: string, id: string): Promise<IntegrationRunDetail> {
		const parsed = parseRunId(id);

		if (parsed?.source === 'erp-send') {
			const job = (await this.schedulerJobs
				.findOne({ ...this.jobsFilter(holdingId), jobId: parsed.raw })
				.lean()
				.exec()) as InvoiceSchedulerJob | null;

			if (job) {
				const { run, records } = this.jobToRun(job, holdingId);

				return { ...run, records, errors_summary: errorsSummary(records) };
			}
		}
		if (parsed?.source === 'erp-import') {
			const job =
				this.importJobs.get(parsed.raw) === holdingId
					? ((await this.invoiceProcessing.getJobStatus(parsed.raw)) as unknown as Row | null)
					: null;

			if (job) return { ...this.importJobToRun(parsed.raw, job), records: [], errors_summary: [] };
		}
		throw new NotFoundException('Corrida no encontrada');
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	recordSources(rules: IntegrationRules): RecordSource[] {
		const excludeSapira = rules.exclude_sapira_invoices !== false;

		return [
			{
				object: 'invoice',
				label: 'Factura enviada',
				table: 'invoices',
				direction: 'export',
				importable: false,
				importByIds: false,
				sql: `SELECT i.id::text AS record_key,
						concat_ws(' · ', COALESCE(i.invoice_number, 'Factura sin folio'), ce.legal_name) AS label,
						i.id::text AS sapira_id, i.odoo_invoice_id::text AS external_id,
						CASE WHEN n.id IS NOT NULL THEN 'error' WHEN i.odoo_invoice_id IS NOT NULL OR i.sent_to_odoo_at IS NOT NULL THEN 'synced' ELSE 'pending' END AS status,
						n.message AS message, COALESCE(i.sent_to_odoo_at, n.updated_at, i.created_at) AS last_sync_at, to_jsonb(i.*) AS rule_row
					FROM invoices i
					LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
					LEFT JOIN LATERAL (SELECT an.id, an.message, an.updated_at FROM app_notifications an
						WHERE an.holding_id = i.holding_id AND an.type = 'invoice_odoo_failure' AND an.status = 'open'
							AND an.resource_type = 'invoice' AND an.resource_id = i.id ORDER BY an.updated_at DESC LIMIT 1) n ON true
					WHERE i.holding_id = $1 AND i.is_active = true AND i.status <> 'Cancelada'
						AND (i.odoo_invoice_id IS NOT NULL OR i.sent_to_odoo_at IS NOT NULL OR n.id IS NOT NULL
							OR (i.status = 'Por Emitir' AND i.issue_date <= current_date))`,
			},
			{
				object: 'erp_invoice',
				label: 'Factura del ERP',
				table: 'odoo_invoices_stg',
				direction: 'import',
				importable: true,
				importByIds: false,
				sql: `SELECT s.odoo_id::text AS record_key,
						concat_ws(' · ', s.raw_data->>'name', s.raw_data->'partner_id'->>1) AS label,
						NULL::text AS sapira_id, s.odoo_id::text AS external_id,
						${stagingStatusSql('s.processing_status')} AS status,
						COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at, to_jsonb(s.*) AS rule_row
					FROM odoo_invoices_stg s
					WHERE s.holding_id = $1${
						excludeSapira ? ` AND NOT EXISTS (SELECT 1 FROM invoices si WHERE si.holding_id = $1 AND si.odoo_invoice_id = s.odoo_id)` : ''
					}`,
			},
			{
				object: 'customer',
				label: 'Cliente del ERP',
				table: 'odoo_partners_stg',
				direction: 'import',
				importable: true,
				importByIds: true,
				sql: `SELECT s.odoo_id::text AS record_key, COALESCE(s.raw_data->>'name', s.raw_data->>'display_name') AS label,
						ce.id::text AS sapira_id, s.odoo_id::text AS external_id,
						${stagingStatusSql('s.processing_status')} AS status,
						COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at, to_jsonb(s.*) AS rule_row
					FROM odoo_partners_stg s
					LEFT JOIN LATERAL (SELECT c.id FROM client_entities c WHERE c.holding_id = s.holding_id AND c.odoo_partner_id = s.odoo_id LIMIT 1) ce ON true
					WHERE s.holding_id = $1`,
			},
		];
	}

	async importRecords(holdingId: string, request: ImportRequest, _actor: Actor, discarded: Set<string>): Promise<ImportStarted> {
		if (request.object === 'erp_invoice') {
			if (request.ids?.length)
				throw validationException([{ field: 'ids', message: 'Las facturas del ERP se importan todas juntas (usa all)' }]);
			if ((await this.importRuns(holdingId)).some((run) => run.status === 'running')) {
				throw new ConflictException('Ya hay una importación de facturas en curso');
			}
			const jobId = await this.invoiceProcessing.startAsyncProcessing(holdingId, 50);

			this.importJobs.set(jobId, holdingId);

			return { run_id: `erp-import:${jobId}`, status: 'running', message: 'Importando las facturas listas', accepted: 0 };
		}
		if (request.object !== 'customer') throw validationException([{ field: 'object', message: 'Este objeto no se importa' }]);

		const [mapping] = (await this.dataSource.query(
			`SELECT id FROM field_mappings WHERE holding_id = $1 AND source_model = 'res.partner' AND is_active = true ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
			[holdingId]
		)) as Row[];

		if (!mapping) throw new BadRequestException('Falta configurar el mapeo de campos de clientes (Avanzado)');
		const candidates = request.all
			? (
					(await this.dataSource.query(
						`SELECT odoo_id::text AS id FROM odoo_partners_stg WHERE holding_id = $1 AND processing_status IN ('create','update','error')`,
						[holdingId]
					)) as Row[]
				).map((row) => String(row.id))
			: (request.ids ?? []);
		const ids = candidates
			.filter((id) => !discarded.has(id))
			.map(Number)
			.filter(Number.isInteger);

		if (!ids.length) throw new BadRequestException('No hay registros para importar');
		setImmediate(() => {
			this.partnersProcessor
				.processPartners({ holding_id: holdingId, mapping_id: String(mapping.id), partner_ids: ids })
				.catch((error) => this.logger.error(`Importación de clientes del ERP falló (${holdingId}): ${errorText(error)}`));
		});

		return { run_id: null, status: 'running', message: 'Importando los clientes seleccionados', accepted: ids.length };
	}

	// ── Mapeos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async externalCompanies(holdingId: string): Promise<{ refs: Ref[]; error: string | null }> {
		const connection = await this.current(holdingId);

		if (!connection) return { refs: [], error: 'No hay una conexión con el ERP' };
		try {
			const result = await this.odooService.getCompanies({ connection_id: connection.id, holding_id: holdingId } as never);

			return {
				refs: (result.odoo_companies as unknown as Row[]).map((company) => ({
					id: String(company.id),
					label: String(company.name ?? company.display_name ?? company.id),
					meta: {
						vat: company.vat ?? null,
						country: company.country ?? null,
						currency: company.currency ?? null,
						default_sale_tax_id: company.default_sale_tax_id ?? null,
						default_sale_tax_name: company.default_sale_tax_name ?? null,
						default_sale_tax_percentage: company.default_sale_tax_percentage ?? null,
					},
				})),
				error: null,
			};
		} catch (error) {
			return { refs: [], error: `El ERP no respondió: ${errorText(error)}` };
		}
	}

	private async externalProducts(holdingId: string): Promise<{ refs: Ref[]; error: string | null }> {
		const connection = await this.current(holdingId);

		if (!connection) return { refs: [], error: 'No hay una conexión con el ERP' };
		try {
			const result = await this.odooService.getProducts({ connection_id: connection.id } as never);

			return {
				refs: (result.odoo_products as unknown as Row[]).map((product) => ({
					id: String(product.id),
					label: String(product.display_name ?? product.name ?? product.id),
					meta: { code: product.product_code ?? null, category: product.category ?? null, tax_ids: product.tax_ids ?? [] },
				})),
				error: null,
			};
		} catch (error) {
			return { refs: [], error: `El ERP no respondió: ${errorText(error)}` };
		}
	}

	/**
	 * Mapeo por origen (ajuste de Domi): Sapira **exporta** facturas al ERP, así que las filas son los elementos de Sapira que se usan
	 * en lo que se envía (compañías que facturan o con contratos activos; productos en contratos activos o en facturas por emitir o ya
	 * enviadas) más los ya mapeados. Lo de Sapira sin uso no aparece ni cuenta como sin mapear. `usage` = lo que depende del mapeo.
	 */
	async getMapping(holdingId: string, object: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		if (object === 'fields') return this.fields.erpView(holdingId, query);
		if (object === 'companies') {
			const [{ refs, error }, companies] = await Promise.all([
				this.externalCompanies(holdingId),
				this.dataSource.query(
					`SELECT c.id, c.legal_name, c.country, c.odoo_integration_id, c.tax_rate,
						(SELECT count(*) FROM invoices i WHERE ${PENDING_SEND_SQL} AND i.company_id = c.id) AS invoices_pending,
						(SELECT count(*) FROM invoices i WHERE i.holding_id = $1 AND i.company_id = c.id AND i.is_active = true AND i.status <> 'Cancelada') AS invoices
					FROM companies c WHERE c.holding_id = $1
						AND (c.odoo_integration_id IS NOT NULL
							OR EXISTS (SELECT 1 FROM invoices i WHERE i.holding_id = $1 AND i.company_id = c.id AND i.is_active = true AND i.status <> 'Cancelada')
							OR EXISTS (SELECT 1 FROM contracts ct WHERE ct.holding_id = $1 AND ct.company_id = c.id AND ct.status = 'Activo'))
					ORDER BY lower(c.legal_name)`,
					[holdingId]
				) as Promise<Row[]>,
			]);
			const byId = new Map(refs.map((ref) => [ref.id, ref]));
			const rows: MappingRow[] = companies.map((company) => {
				const externalId =
					company.odoo_integration_id === null || company.odoo_integration_id === undefined ? null : String(company.odoo_integration_id);
				const sapira: Ref = { id: String(company.id), label: String(company.legal_name ?? ''), meta: { country: company.country ?? null } };
				const suggestion = externalId ? null : suggestRef({ label: sapira.label }, refs);

				return {
					key: sapira.id,
					sapira,
					external: externalId ? (byId.get(externalId) ?? { id: externalId, label: `Compañía ${externalId}`, meta: {} }) : null,
					status: externalId ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: { invoices_pending: Number(company.invoices_pending) || 0, invoices: Number(company.invoices) || 0 },
					meta: { tax_rate: company.tax_rate === null || company.tax_rate === undefined ? null : Number(company.tax_rate) },
				};
			});

			return buildMappingView(
				{ object, object_label: 'Compañías', anchor: 'sapira', external_available: !error, external_error: error },
				rows,
				query
			);
		}
		if (object === 'products') {
			const [{ refs, error }, products] = await Promise.all([
				this.externalProducts(holdingId),
				this.dataSource.query(
					`SELECT p.id, p.name, p.product_code, p.is_recurring, m.odoo_product_id, m.metadata->>'odoo_tax_ids' AS odoo_tax_ids,
						(SELECT count(DISTINCT ct.id) FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
							WHERE ci.product_id = p.id AND ct.holding_id = $1 AND ct.status = 'Activo') AS contracts,
						(SELECT count(DISTINCT i.id) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
							WHERE ii.product_id = p.id AND ${PENDING_SEND_SQL}) AS invoices_pending
					FROM products p
					LEFT JOIN LATERAL (SELECT odoo_product_id, metadata FROM odoo_product_mappings om
						WHERE om.holding_id = $1 AND om.sapira_product_id = p.id ORDER BY om.updated_at DESC NULLS LAST LIMIT 1) m ON true
					WHERE p.holding_id = $1
						AND (m.odoo_product_id IS NOT NULL
							OR EXISTS (SELECT 1 FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
								WHERE ci.product_id = p.id AND ct.holding_id = $1 AND ct.status = 'Activo')
							OR EXISTS (SELECT 1 FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
								WHERE ii.product_id = p.id AND i.holding_id = $1 AND i.is_active = true AND i.status <> 'Cancelada'
									AND (i.status = 'Por Emitir' OR i.sent_to_odoo_at IS NOT NULL OR i.odoo_invoice_id IS NOT NULL)))
					ORDER BY lower(p.name)`,
					[holdingId]
				) as Promise<Row[]>,
			]);
			const byId = new Map(refs.map((ref) => [ref.id, ref]));
			const rows: MappingRow[] = products.map((product) => {
				const externalId = product.odoo_product_id === null || product.odoo_product_id === undefined ? null : String(product.odoo_product_id);
				const sapira: Ref = {
					id: String(product.id),
					label: String(product.name ?? ''),
					meta: { code: product.product_code ?? null, is_recurring: product.is_recurring === true },
				};
				const suggestion = externalId ? null : suggestRef({ label: sapira.label, code: product.product_code }, refs);

				return {
					key: sapira.id,
					sapira,
					external: externalId ? (byId.get(externalId) ?? { id: externalId, label: `Producto ${externalId}`, meta: {} }) : null,
					status: externalId ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: { contracts: Number(product.contracts) || 0, invoices_pending: Number(product.invoices_pending) || 0 },
					meta: {
						tax_ids: String(product.odoo_tax_ids ?? '')
							.split(',')
							.map((id) => Number(id.trim()))
							.filter((id) => Number.isInteger(id) && id > 0),
					},
				};
			});

			return buildMappingView(
				{ object, object_label: 'Productos', anchor: 'sapira', external_available: !error, external_error: error },
				rows,
				query
			);
		}
		throw new NotFoundException('Mapeo no encontrado');
	}

	async mappingOptions(holdingId: string, object: string, side: 'sapira' | 'external', search?: string) {
		if (object === 'fields') return this.fields.erpOptions(holdingId, search);
		if (side === 'sapira') {
			const table = object === 'companies' ? 'companies' : object === 'products' ? 'products' : null;

			if (!table) throw new NotFoundException('Mapeo no encontrado');
			const rows = (await this.dataSource.query(
				`SELECT id, ${table === 'companies' ? 'legal_name' : 'name'} AS label FROM ${table} WHERE holding_id = $1 ORDER BY 2`,
				[holdingId]
			)) as Row[];

			return {
				data: filterRefs(
					rows.map((row) => ({ id: String(row.id), label: String(row.label ?? ''), meta: {} })),
					search
				),
				available: true,
				error: null,
			};
		}
		const { refs, error } =
			object === 'companies'
				? await this.externalCompanies(holdingId)
				: object === 'products'
					? await this.externalProducts(holdingId)
					: { refs: null, error: null };

		if (!refs) throw new NotFoundException('Mapeo no encontrado');

		return { data: filterRefs(refs, search), available: !error, error };
	}

	private async assertOwned(holdingId: string, table: 'companies' | 'products', ids: string[]) {
		const rows = (await this.dataSource.query(`SELECT id::text AS id FROM ${table} WHERE holding_id = $1 AND id::text = ANY($2::text[])`, [
			holdingId,
			ids,
		])) as Row[];
		const owned = new Set(rows.map((row) => String(row.id)));
		const errors = ids.flatMap((id, index) =>
			owned.has(id) ? [] : [{ field: `items.${index}.sapira_id`, message: 'No pertenece a este holding' }]
		);

		if (errors.length) throw validationException(errors);
	}

	async putMapping(holdingId: string, object: string, items: MappingItem[], actor: Actor): Promise<void> {
		if (object === 'fields') return this.fields.erpPut(holdingId, items);
		const external = items.map((item, index) => ({ index, value: Number(item.external_id) }));
		const badExternal = external.filter((entry) => !Number.isInteger(entry.value) || entry.value <= 0);

		if (badExternal.length)
			throw validationException(badExternal.map((entry) => ({ field: `items.${entry.index}.external_id`, message: 'Id del ERP inválido' })));
		if (object === 'companies') {
			await this.assertOwned(
				holdingId,
				'companies',
				items.map((item) => item.sapira_id)
			);
			await this.odooService.mapCompanies({
				holding_id: holdingId,
				mappings: items.map((item) => ({
					sapira_company_id: item.sapira_id,
					odoo_company_id: Number(item.external_id),
					tax_rate: typeof item.meta?.tax_rate === 'number' ? (item.meta.tax_rate as number) : undefined,
				})),
			});

			return;
		}
		if (object === 'products') {
			await this.assertOwned(
				holdingId,
				'products',
				items.map((item) => item.sapira_id)
			);
			const taxErrors = items.flatMap((item, index) => {
				const taxIds = item.meta?.tax_ids;

				return taxIds === undefined || (Array.isArray(taxIds) && taxIds.every((id) => Number.isInteger(id) && id > 0))
					? []
					: [{ field: `items.${index}.meta.tax_ids`, message: 'Impuestos inválidos' }];
			});

			if (taxErrors.length) throw validationException(taxErrors);
			await this.odooService.mapProducts(
				holdingId,
				{
					mappings: items.map((item) => ({
						sapira_product_id: item.sapira_id,
						odoo_product_id: Number(item.external_id),
						odoo_tax_ids: Array.isArray(item.meta?.tax_ids) ? (item.meta.tax_ids as number[]).join(',') : undefined,
					})),
				},
				actor.userId ?? undefined
			);

			return;
		}
		throw new NotFoundException('Mapeo no encontrado');
	}

	async deleteMapping(holdingId: string, object: string, sapiraId: string, externalId: string, confirm: boolean): Promise<void> {
		if (object === 'fields') return this.fields.erpDelete(holdingId, sapiraId);
		if (object !== 'companies' && object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		const view = await this.getMapping(holdingId, object, {}).catch(() => null);
		const row = view?.data.find((item) => item.sapira?.id === sapiraId && item.external?.id === externalId);

		if (!row) throw new NotFoundException('Mapeo no encontrado');
		const impact: ImpactErrors = [];

		if ((row.usage?.contracts ?? 0) > 0) impact.push({ field: 'contracts', message: `${row.usage?.contracts} contratos activos lo usan` });
		if ((row.usage?.invoices_pending ?? 0) > 0)
			impact.push({ field: 'invoices_pending', message: `${row.usage?.invoices_pending} facturas por enviar` });
		if (impact.length && !confirm) throw new ConflictException({ message: 'Quitar este mapeo bloquea el envío al ERP', errors: impact });
		if (object === 'companies') {
			await this.odooService.mapCompanies({ holding_id: holdingId, mappings: [{ sapira_company_id: sapiraId, odoo_company_id: null }] });

			return;
		}
		await this.dataSource.query(`DELETE FROM odoo_product_mappings WHERE holding_id = $1 AND sapira_product_id = $2 AND odoo_product_id = $3`, [
			holdingId,
			sapiraId,
			Number(externalId),
		]);
	}

	/** Impuestos del ERP de una compañía (selector de productos). */
	async taxes(holdingId: string, query: { company_id?: string; erp_company_id?: number }) {
		let erpCompanyId = query.erp_company_id ?? null;

		if (query.company_id) {
			const [company] = (await this.dataSource.query(`SELECT odoo_integration_id FROM companies WHERE id = $1 AND holding_id = $2`, [
				query.company_id,
				holdingId,
			])) as Row[];

			if (!company) throw new NotFoundException('Compañía no encontrada');
			erpCompanyId = company.odoo_integration_id === null ? null : Number(company.odoo_integration_id);
		}
		if (!erpCompanyId) throw new BadRequestException('La compañía no está mapeada al ERP');
		try {
			const result = await this.odooInvoicesService.getTaxesForCompany(holdingId, erpCompanyId);

			return {
				company: { id: String(result.company_id), label: result.company_name },
				data: (result.taxes as Row[]).map((tax) => ({
					id: Number(tax.id),
					label: String(tax.display_name ?? tax.name ?? tax.id),
					amount: tax.amount === undefined ? null : Number(tax.amount),
					amount_type: (tax.amount_type as string) ?? null,
					use: tax.type_tax_use === 'sale' || tax.type_tax_use === 'purchase' ? tax.type_tax_use : 'none',
					active: tax.active !== false,
				})),
			};
		} catch (error) {
			throw new BadGatewayException(`El ERP no respondió: ${errorText(error)}`);
		}
	}

	async pendingMapping(holdingId: string): Promise<number> {
		const [row] = (await this.dataSource.query(
			`SELECT
				(SELECT count(DISTINCT ci.product_id) FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
					WHERE ct.holding_id = $1 AND ct.status = 'Activo' AND ci.product_id IS NOT NULL
						AND NOT EXISTS (SELECT 1 FROM odoo_product_mappings m WHERE m.holding_id = $1 AND m.sapira_product_id = ci.product_id))
				+ (SELECT count(DISTINCT i.company_id) FROM invoices i JOIN companies c ON c.id = i.company_id
					WHERE ${PENDING_SEND_SQL} AND c.odoo_integration_id IS NULL) AS pending`,
			[holdingId]
		)) as Row[];

		return Number(row?.pending) || 0;
	}

	schedule(): ScheduleInfo {
		const enabled = this.config.get<string>('INVOICE_SCHEDULER_ENABLED') !== 'false';
		const hour = parseInt(this.config.get<string>('INVOICE_SCHEDULER_HOUR') || '9', 10);

		return {
			daily_at: `${String(hour).padStart(2, '0')}:00`,
			timezone: 'servidor',
			enabled,
			next_at: enabled ? nextDailyAt(hour, 0).toISOString() : null,
		};
	}
}
