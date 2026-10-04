import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { OdooConnection } from '@/databases/postgresql/entities/integraciones/odoo/odoo-connection.entity';
import { ClientEntityErpService } from '@/modules/clients/client-entity-erp.service';
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
	INTERRUPTED_MESSAGE,
	isInterruptedJob,
	MappingItem,
	MappingRow,
	MappingStatus,
	MappingView,
	nextDailyAt,
	normalizeText,
	paginateArray,
	Paginated,
	parseRunId,
	RecordHistoryOptions,
	RecordSource,
	Ref,
	RunOccurrence,
	RunRecord,
	RunsQuery,
	runStatusOf,
	runTotals,
	ScheduleInfo,
	secretInfo,
	sortRunsDesc,
	stagingChangeKindSql,
	stagingStatusSql,
	suggestRef,
	SyncStarted,
} from '../integrations.types';

import { FieldsMappingHelper } from './fields-mapping.helper';
import { IntegrationAdapter, IntegrationRules } from './integration-adapter';

type Row = Record<string, unknown>;

/** Facturas por enviar al ERP (misma idea que la cola del envío: Por Emitir, activas, sin enviar). */
const PENDING_SEND_SQL = `i.holding_id = $1 AND i.is_active = true AND i.status = 'Por Emitir' AND i.sent_to_odoo_at IS NULL`;
/** Clave comparable de un RUT / ID tributario en SQL (como `vatKey` + sin ceros iniciales: Odoo puede devolverlo como número). */
const vatKeySql = (expr: string) => `ltrim(upper(regexp_replace(COALESCE(${expr}, ''), '[^0-9A-Za-z]', '', 'g')), '0')`;
/** Nombre comparable (VAT genérico de exportación: se exige también el mismo nombre, como `resolveAndLinkPartnerForEntity`). */
const nameKeySql = (expr: string) => `lower(regexp_replace(COALESCE(${expr}, ''), '[^[:alnum:]]', '', 'g'))`;

/**
 * Razones sociales que facturan (facturas por emitir o enviadas, contratos activos) o ya vinculadas, con su cliente del ERP y la
 * sugerencia por RUT leída de `odoo_partners_stg` (sin llamar al ERP): partners comerciales activos con el mismo RUT que ninguna otra
 * razón social usa; con un VAT genérico de exportación, además el mismo nombre. `$1` = holding.
 */
export const CUSTOMERS_SQL = `WITH p AS (
		SELECT s.odoo_id, COALESCE(s.raw_data->>'name', s.raw_data->>'display_name') AS name, s.raw_data->>'vat' AS vat,
			s.raw_data->'country_id'->>1 AS country, ${vatKeySql("s.raw_data->>'vat'")} AS vat_key, ${nameKeySql("s.raw_data->>'name'")} AS name_key
		FROM odoo_partners_stg s
		WHERE s.holding_id = $1 AND jsonb_typeof(s.raw_data->'vat') IN ('string', 'number') AND COALESCE(s.raw_data->>'active', 'true') <> 'false'
			AND COALESCE((s.raw_data->'commercial_partner_id'->>0)::int, s.odoo_id) = s.odoo_id
	),
	iv AS (
		SELECT i.client_entity_id, count(*) FILTER (WHERE i.status = 'Por Emitir' AND i.sent_to_odoo_at IS NULL) AS invoices_pending, count(*) AS invoices
		FROM invoices i
		WHERE i.holding_id = $1 AND i.is_active = true AND i.status <> 'Cancelada' AND i.client_entity_id IS NOT NULL
			AND (i.status = 'Por Emitir' OR i.sent_to_odoo_at IS NOT NULL OR i.odoo_invoice_id IS NOT NULL)
		GROUP BY i.client_entity_id
	),
	cv AS (
		SELECT ct.client_entity_id, count(*) AS contracts FROM contracts ct
		WHERE ct.holding_id = $1 AND ct.status = 'Activo' AND ct.deleted_at IS NULL AND ct.client_entity_id IS NOT NULL GROUP BY ct.client_entity_id
	),
	e AS (
		SELECT ce.id, ce.legal_name, ce.tax_id, COALESCE(ce.country_code, ce.country) AS country, ce.odoo_partner_id, c.name_commercial AS client_name,
			${vatKeySql('ce.tax_id')} AS vat_key, ${nameKeySql('ce.legal_name')} AS name_key,
			COALESCE(iv.invoices_pending, 0) AS invoices_pending, COALESCE(iv.invoices, 0) AS invoices, COALESCE(cv.contracts, 0) AS contracts
		FROM client_entities ce
		LEFT JOIN clients c ON c.id = ce.client_id
		LEFT JOIN iv ON iv.client_entity_id = ce.id
		LEFT JOIN cv ON cv.client_entity_id = ce.id
		WHERE ce.holding_id = $1
	)
	SELECT e.*, lp.name AS partner_name, lp.vat AS partner_vat, sg.n AS suggestion_count, sg.id AS suggestion_id, sg.name AS suggestion_name,
		sg.vat AS suggestion_vat
	FROM e
	LEFT JOIN LATERAL (SELECT COALESCE(s.raw_data->>'name', s.raw_data->>'display_name') AS name, s.raw_data->>'vat' AS vat FROM odoo_partners_stg s
		WHERE s.holding_id = $1 AND s.odoo_id = e.odoo_partner_id LIMIT 1) lp ON e.odoo_partner_id IS NOT NULL
	LEFT JOIN LATERAL (SELECT count(DISTINCT p.odoo_id) AS n, min(p.odoo_id) AS id, min(p.name) AS name, min(p.vat) AS vat FROM p
		WHERE e.odoo_partner_id IS NULL AND length(e.vat_key) >= 5 AND p.vat_key = e.vat_key
			AND (p.name_key = e.name_key OR NOT EXISTS (SELECT 1 FROM generic_export_vats g WHERE g.is_active = true AND ${vatKeySql('g.vat')} = e.vat_key))
			AND NOT EXISTS (SELECT 1 FROM client_entities o WHERE o.holding_id = $1 AND o.odoo_partner_id = p.odoo_id)) sg ON true
	WHERE e.odoo_partner_id IS NOT NULL OR e.invoices > 0 OR e.contracts > 0
	ORDER BY lower(e.legal_name)`;

/** Tipo de documento legible de una factura (`invoices.document_type`). */
const DOCUMENT_LABEL_SQL = `(CASE i.document_type WHEN 'FACTURA' THEN 'Factura' WHEN 'FACTURA_EXPORTACION' THEN 'Factura de exportación'
	WHEN 'NC' THEN 'Nota de crédito' WHEN 'ND' THEN 'Nota de débito' WHEN 'BOLETA' THEN 'Boleta' WHEN 'Invoice' THEN 'Invoice'
	ELSE COALESCE(initcap(replace(lower(i.document_type), '_', ' ')), 'Factura') END)`;
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
	readonly mappingObjects = ['companies', 'products', 'customers', 'fields'];
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
		private readonly config: ConfigService,
		private readonly entityErp: ClientEntityErpService
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
		const active = (await this.schedulerJobs
			.find({
				status: { $in: ['pending', 'running'] },
				holdingId: { $in: [holdingId, 'all'] },
				startedAt: { $gte: new Date(Date.now() - LOCK_WINDOW_MS) },
			})
			.lean()
			.exec()) as InvoiceSchedulerJob[];
		// Un envío "en curso" huérfano (la API se reinició a mitad) no bloquea: se informa como Interrumpida.
		const running = active.some((job) => !this.interrupted(job));

		if (running) throw new ConflictException('Ya hay una sincronización en curso');
		const jobId = await this.invoiceScheduler.startSchedulerJob({ dryRun: false, holdingId, userId: actor.authId });

		return { run_id: `erp-send:${jobId}`, status: 'running', message: 'Enviando las facturas pendientes al ERP' };
	}

	/** Envío en curso cuyo proceso ya no existe (mismo entorno, iniciado antes de este arranque) o que superó la ventana de bloqueo. */
	private interrupted(job: Pick<InvoiceSchedulerJob, 'startedAt' | 'executionEnvironment'>): boolean {
		const configured = process.env.NODE_ENV?.toLowerCase().trim();
		// Mismo cálculo que `InvoiceSchedulerService.getExecutionEnvironment`.
		const environment = configured === 'production' || configured === 'qa' ? configured : 'unknown';

		return isInterruptedJob({ startedAt: job.startedAt, environment: job.executionEnvironment }, { leaseMs: LOCK_WINDOW_MS, environment });
	}

	private jobToRun(job: InvoiceSchedulerJob & { _id?: unknown }, holdingId: string): { run: IntegrationRun; records: RunRecord[] } {
		const results = ((job.result?.results ?? []) as unknown as Row[]).filter(
			(result) => job.holdingId !== 'all' || String(result.holdingId ?? '') === holdingId
		);
		const records: RunRecord[] = results.map((result) => ({
			object: 'invoice',
			record_key: (result.invoiceId as string) ?? null,
			label: [result.invoiceNumber || 'Factura sin folio', result.clientName].filter(Boolean).join(' · '),
			sapira_id: (result.invoiceId as string) ?? null,
			external_id: result.odooInvoiceId ? String(result.odooInvoiceId) : null,
			status: result.status === 'sent' ? 'ok' : result.status === 'error' ? 'error' : 'skipped',
			message: (result.error as string) ?? (result.details as string) ?? null,
		}));
		const scoped = job.holdingId === 'all';
		const progress = job.progress ?? { total: 0, sent: 0, errors: 0, skipped: 0 };
		// Omitidas (ya enviadas, nada que enviar) = sin cambios: cuentan como correctas.
		const totals = scoped
			? runTotals({
					total: records.length,
					ok: records.filter((r) => r.status === 'ok').length,
					errors: records.filter((r) => r.status === 'error').length,
					unchanged: records.filter((r) => r.status === 'skipped').length,
				})
			: runTotals({ total: progress.total ?? 0, ok: progress.sent ?? 0, errors: progress.errors ?? 0, unchanged: progress.skipped ?? 0 });
		const running = job.status === 'pending' || job.status === 'running';
		const interrupted = running && this.interrupted(job);

		return {
			run: {
				id: `erp-send:${job.jobId}`,
				tipo: 'erp',
				kind: 'export_invoices',
				kind_label: 'Envío de facturas al ERP',
				trigger: job.executionSource === 'automatic' ? 'automatic' : 'manual',
				status: runStatusOf({
					running,
					interrupted,
					failed: job.status === 'failed',
					ok: totals.ok,
					unchanged: totals.unchanged,
					errors: totals.errors,
				}),
				started_at: job.startedAt ?? null,
				finished_at: job.completedAt ?? null,
				duration_ms: durationMs(job.startedAt, job.completedAt),
				totals,
				error: interrupted ? INTERRUPTED_MESSAGE : (job.error ?? null),
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
			totals: runTotals({ ok, errors, unchanged: 0, total: Number(job.records_processed ?? 0) }),
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

	/** Facturas por envío al ERP: los resultados vienen dentro de cada trabajo (una lectura). Las importaciones no guardan registros. */
	async recordHistory(holdingId: string, options: RecordHistoryOptions): Promise<RunOccurrence[]> {
		const jobs = (await this.schedulerJobs
			.find(
				{ ...this.jobsFilter(holdingId), startedAt: { $gte: options.since, $lte: options.until ?? new Date() } },
				{ jobId: 1, holdingId: 1, startedAt: 1, executionSource: 1, 'result.results': 1 }
			)
			.lean()
			.exec()) as InvoiceSchedulerJob[];
		const keys = options.keys ? new Set(options.keys) : null;

		return jobs.flatMap((job) => {
			const { run, records } = this.jobToRun(job, holdingId);

			return records
				.filter((record) => (!options.errorsOnly || record.status === 'error') && (!keys || keys.has(record.record_key ?? '')))
				.map((record) => ({
					run_id: run.id,
					kind: run.kind,
					at: run.started_at,
					object: record.object,
					record_key: record.record_key ?? null,
					status: record.status,
					message: record.message,
				}));
		});
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * Factura enviada = lo **ejecutado** en la integración (decisión de Domi 03-10): facturas que salieron al ERP o cuyo envío falló. Las
	 * Por Emitir que nunca se intentaron enviar se siguen en Facturación, no aquí. `last_sync_at` = fecha de envío (o del intento fallido),
	 * así el período del Estado filtra por cuándo se envió. `sapira_label` legible ("Factura 10091 · CTR-2026-81"; sin folio, con la fecha
	 * de emisión) y subestado (`detail_kind`) con el texto en `message`:
	 * - `erp_issued` (synced): se envió y ya se emitió.
	 * - `erp_draft` (pending, "Por revisar"): se envió y en Sapira sigue Por Emitir = borrador en el ERP que aún no se emite allá.
	 * - `send_error` (error): intento de envío fallido (alerta `invoice_odoo_failure` abierta).
	 */
	private invoiceSourceSql(): string {
		const sent = `(i.odoo_invoice_id IS NOT NULL OR i.sent_to_odoo_at IS NOT NULL)`;
		// Zona del negocio (misma regla que el envío: `TZ` o America/Santiago); solo se acepta un nombre IANA.
		const zone = /^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(process.env.TZ ?? '') ? process.env.TZ : 'America/Santiago';

		return `SELECT x.record_key, x.label, x.sapira_label, x.sapira_id, x.external_id, x.last_sync_at, x.rule_row, x.detail_kind,
				CASE x.detail_kind WHEN 'send_error' THEN 'error' WHEN 'erp_draft' THEN 'pending' ELSE 'synced' END AS status,
				CASE x.detail_kind WHEN 'send_error' THEN 'Error al enviar' WHEN 'erp_draft' THEN 'Borrador en el ERP' ELSE 'Emitida en el ERP' END AS detail_label,
				CASE x.detail_kind WHEN 'send_error' THEN x.error_message
					WHEN 'erp_draft' THEN 'Enviada al ERP como borrador el ' || to_char(x.last_sync_at AT TIME ZONE '${zone}', 'DD-MM') || '; aún no se emite allá'
					ELSE NULL END AS message
			FROM (SELECT i.id::text AS record_key,
					concat_ws(' · ', COALESCE(i.invoice_number, 'Factura sin folio'), ce.legal_name) AS label,
					concat_ws(' · ',
						${DOCUMENT_LABEL_SQL} || CASE WHEN i.invoice_number IS NOT NULL THEN ' ' || i.invoice_number ELSE ' sin folio' END,
						ct.contract_number,
						CASE WHEN i.invoice_number IS NULL THEN to_char(i.issue_date, 'DD-MM-YYYY') END) AS sapira_label,
					i.id::text AS sapira_id, i.odoo_invoice_id::text AS external_id,
					n.message AS error_message, COALESCE(i.sent_to_odoo_at, n.updated_at, i.created_at) AS last_sync_at, to_jsonb(i.*) AS rule_row,
					CASE WHEN n.id IS NOT NULL THEN 'send_error'
						WHEN ${sent} AND i.status = 'Por Emitir' THEN 'erp_draft'
						ELSE 'erp_issued' END AS detail_kind
				FROM invoices i
				LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
				LEFT JOIN contracts ct ON ct.id = i.contract_id
				LEFT JOIN LATERAL (SELECT an.id, an.message, an.updated_at FROM app_notifications an
					WHERE an.holding_id = i.holding_id AND an.type = 'invoice_odoo_failure' AND an.status = 'open'
						AND an.resource_type = 'invoice' AND an.resource_id = i.id ORDER BY an.updated_at DESC LIMIT 1) n ON true
				WHERE i.holding_id = $1 AND i.is_active = true AND i.status <> 'Cancelada' AND (${sent} OR n.id IS NOT NULL)) x`;
	}

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
				hasSapiraLabel: true,
				hasDetail: true,
				sql: this.invoiceSourceSql(),
			},
			{
				object: 'erp_invoice',
				label: 'Factura del ERP',
				table: 'odoo_invoices_stg',
				direction: 'import',
				importable: true,
				importByIds: false,
				hasChangeKind: true,
				sql: `SELECT s.odoo_id::text AS record_key,
						concat_ws(' · ', s.raw_data->>'name', s.raw_data->'partner_id'->>1) AS label,
						NULL::text AS sapira_id, s.odoo_id::text AS external_id,
						${stagingStatusSql('s.processing_status')} AS status, ${stagingChangeKindSql('s.processing_status')} AS change_kind,
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
				hasChangeKind: true,
				hasSapiraLabel: true,
				sql: `SELECT s.odoo_id::text AS record_key, COALESCE(s.raw_data->>'name', s.raw_data->>'display_name') AS label,
						ce.id::text AS sapira_id, ce.legal_name AS sapira_label, s.odoo_id::text AS external_id,
						${stagingStatusSql('s.processing_status')} AS status, ${stagingChangeKindSql('s.processing_status')} AS change_kind,
						COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at, to_jsonb(s.*) AS rule_row
					FROM odoo_partners_stg s
					LEFT JOIN LATERAL (SELECT c.id, c.legal_name FROM client_entities c WHERE c.holding_id = s.holding_id AND c.odoo_partner_id = s.odoo_id LIMIT 1) ce ON true
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
						(SELECT count(*) FROM invoices i WHERE i.holding_id = $1 AND i.company_id = c.id AND i.is_active = true AND i.status <> 'Cancelada') AS invoices,
						(SELECT count(*) FROM contracts ct WHERE ct.holding_id = $1 AND ct.company_id = c.id AND ct.status = 'Activo' AND ct.deleted_at IS NULL) AS contracts
					FROM companies c WHERE c.holding_id = $1
					ORDER BY lower(c.legal_name)`,
					[holdingId]
				) as Promise<Row[]>,
			]);
			const byId = new Map(refs.map((ref) => [ref.id, ref]));
			const rows: MappingRow[] = companies.map((company) => {
				const externalId =
					company.odoo_integration_id === null || company.odoo_integration_id === undefined ? null : String(company.odoo_integration_id);
				const sapira: Ref = { id: String(company.id), label: String(company.legal_name ?? ''), meta: { country: company.country ?? null } };
				// Todas las compañías del holding (Domi 03-10): las que no facturan ni tienen contratos activos van "Sin uso" (neutro).
				const unused = !externalId && !Number(company.invoices) && !Number(company.contracts);
				const suggestion = externalId || unused ? null : suggestRef({ label: sapira.label }, refs);

				return {
					key: sapira.id,
					sapira,
					external: externalId ? (byId.get(externalId) ?? { id: externalId, label: `Compañía ${externalId}`, meta: {} }) : null,
					status: externalId ? 'mapped' : unused ? 'unused' : suggestion ? 'suggested' : 'unmapped',
					suggestion,
					usage: {
						invoices_pending: Number(company.invoices_pending) || 0,
						invoices: Number(company.invoices) || 0,
						contracts: Number(company.contracts) || 0,
					},
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
		if (object === 'customers') return buildMappingView(this.customersBase(object), await this.customerRows(holdingId), query);
		throw new NotFoundException('Mapeo no encontrado');
	}

	private customersBase(object: string) {
		return { object, object_label: 'Clientes', anchor: 'sapira' as const, external_available: true, external_error: null };
	}

	/**
	 * Razón social en Sapira → cliente del ERP (`client_entities.odoo_partner_id`, el mismo vínculo de "Vincular con el ERP" de la Razón
	 * social 360). Sin vínculo la factura no se envía. El nombre del cliente del ERP y la sugerencia salen de `odoo_partners_stg`.
	 */
	private async customerRows(holdingId: string): Promise<MappingRow[]> {
		const entities = (await this.dataSource.query(CUSTOMERS_SQL, [holdingId])) as Row[];

		return entities.map((entity) => {
			const partnerId = entity.odoo_partner_id === null || entity.odoo_partner_id === undefined ? null : String(entity.odoo_partner_id);
			const candidates = Number(entity.suggestion_count) || 0;
			const suggestion: Ref | null =
				!partnerId && candidates === 1
					? {
							id: String(entity.suggestion_id),
							label: String(entity.suggestion_name ?? `Cliente del ERP #${entity.suggestion_id}`),
							meta: { vat: entity.suggestion_vat ?? null, match: 'tax_id' },
						}
					: null;

			return {
				key: String(entity.id),
				sapira: {
					id: String(entity.id),
					label: String(entity.legal_name ?? ''),
					meta: { tax_id: entity.tax_id ?? null, country: entity.country ?? null, client_name: entity.client_name ?? null },
				},
				external: partnerId
					? {
							id: partnerId,
							label: String(entity.partner_name ?? `Cliente del ERP #${partnerId}`),
							meta: { vat: entity.partner_vat ?? null },
						}
					: null,
				status: partnerId ? 'mapped' : suggestion ? 'suggested' : 'unmapped',
				suggestion,
				usage: {
					invoices_pending: Number(entity.invoices_pending) || 0,
					invoices: Number(entity.invoices) || 0,
					contracts: Number(entity.contracts) || 0,
				},
				meta: { candidates: partnerId ? null : candidates },
			};
		});
	}

	/** Clientes del ERP para el selector: los de `odoo_partners_stg` y, si se busca, también los que encuentra el ERP (RUT o nombre). */
	private async customerOptions(holdingId: string, search?: string) {
		const rows = (await this.dataSource.query(
			`SELECT s.odoo_id, COALESCE(s.raw_data->>'name', s.raw_data->>'display_name') AS name, s.raw_data->>'vat' AS vat
			FROM odoo_partners_stg s WHERE s.holding_id = $1 AND COALESCE(s.raw_data->>'active', 'true') <> 'false' ORDER BY 2`,
			[holdingId]
		)) as Row[];
		const refs = new Map<string, Ref>(
			rows.map((row) => [
				String(row.odoo_id),
				{ id: String(row.odoo_id), label: String(row.name ?? `Cliente del ERP #${row.odoo_id}`), meta: { vat: row.vat ?? null } },
			])
		);
		const needle = search?.trim();
		const byVat = needle ? normalizeText(needle).replace(/\s+/g, '') : '';
		const local = [...refs.values()].filter(
			(ref) =>
				!needle ||
				filterRefs([ref], needle).length > 0 ||
				(byVat.length >= 5 && normalizeText(ref.meta.vat).replace(/\s+/g, '').includes(byVat))
		);

		if (!needle) return { data: local, available: true, error: null };
		const remote = await this.entityErp.searchForNew(holdingId, needle);
		const found = remote.candidates
			.filter((candidate) => !refs.has(String(candidate.odoo_partner_id)))
			.map((candidate) => ({
				id: String(candidate.odoo_partner_id),
				label: String(candidate.name ?? `Cliente del ERP #${candidate.odoo_partner_id}`),
				meta: { vat: candidate.tax_id ?? null, linked_entity: candidate.linked_entity ?? null },
			}));

		return { data: [...local, ...found], available: true, error: remote.blockers[0]?.message ?? null };
	}

	async mappingOptions(holdingId: string, object: string, side: 'sapira' | 'external', search?: string) {
		if (object === 'fields') return this.fields.erpOptions(holdingId, search);
		if (object === 'customers' && side === 'external') return this.customerOptions(holdingId, search);
		if (side === 'sapira') {
			const table =
				object === 'companies' ? 'companies' : object === 'products' ? 'products' : object === 'customers' ? 'client_entities' : null;

			if (!table) throw new NotFoundException('Mapeo no encontrado');
			const rows = (await this.dataSource.query(
				`SELECT id, ${table === 'products' ? 'name' : 'legal_name'} AS label FROM ${table} WHERE holding_id = $1 ORDER BY 2`,
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

	private async assertOwned(holdingId: string, table: 'companies' | 'products' | 'client_entities', ids: string[]) {
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
		if (object === 'customers') return this.linkCustomers(holdingId, items);
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

	/**
	 * Vincula razones sociales con clientes del ERP reutilizando `ClientEntityErpService.link` (las validaciones de la Razón social 360:
	 * la razón social es del holding, el cliente existe y está activo en el ERP, ninguna otra razón social lo usa). Vincula una por una;
	 * las que fallan vuelven como `items.<i>.external_id` (400) y las demás quedan vinculadas.
	 */
	private async linkCustomers(holdingId: string, items: MappingItem[]): Promise<void> {
		await this.assertOwned(
			holdingId,
			'client_entities',
			items.map((item) => item.sapira_id)
		);
		const seen = new Map<string, number>();
		const duplicated = items.flatMap((item, index) => {
			const first = seen.get(item.external_id);

			seen.set(item.external_id, first ?? index);

			return first === undefined ? [] : [{ field: `items.${index}.external_id`, message: 'Ese cliente del ERP ya va en otra fila' }];
		});

		if (duplicated.length) throw validationException(duplicated);
		const errors: Array<{ field: string; message: string }> = [];

		for (const [index, item] of items.entries()) {
			try {
				await this.entityErp.link(holdingId, item.sapira_id, Number(item.external_id));
			} catch (error) {
				errors.push({ field: `items.${index}.external_id`, message: errorText(error) });
			}
		}
		if (errors.length) throw validationException(errors);
	}

	async deleteMapping(holdingId: string, object: string, sapiraId: string, externalId: string, confirm: boolean): Promise<void> {
		if (object === 'fields') return this.fields.erpDelete(holdingId, sapiraId);
		if (object === 'customers') {
			const row = (await this.customerRows(holdingId)).find((item) => item.sapira?.id === sapiraId && item.external?.id === externalId);

			if (!row) throw new NotFoundException('Mapeo no encontrado');
			const impact: ImpactErrors = [];

			if ((row.usage?.invoices_pending ?? 0) > 0)
				impact.push({ field: 'invoices_pending', message: `${row.usage?.invoices_pending} facturas por enviar dejan de enviarse al ERP` });
			if ((row.usage?.contracts ?? 0) > 0)
				impact.push({ field: 'contracts', message: `${row.usage?.contracts} contratos activos facturan a esta razón social` });
			if (impact.length && !confirm) throw new ConflictException({ message: 'Quitar este vínculo bloquea el envío al ERP', errors: impact });
			await this.entityErp.unlink(holdingId, sapiraId);

			return;
		}
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

	async pendingMapping(holdingId: string, notApplicable: Record<string, string[]> = {}): Promise<number> {
		const [row] = (await this.dataSource.query(
			`SELECT
				(SELECT count(DISTINCT ci.product_id) FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
					WHERE ct.holding_id = $1 AND ct.status = 'Activo' AND ci.product_id IS NOT NULL AND ci.product_id::text <> ALL($2::text[])
						AND NOT EXISTS (SELECT 1 FROM odoo_product_mappings m WHERE m.holding_id = $1 AND m.sapira_product_id = ci.product_id))
				+ (SELECT count(DISTINCT i.company_id) FROM invoices i JOIN companies c ON c.id = i.company_id
					WHERE ${PENDING_SEND_SQL} AND c.odoo_integration_id IS NULL AND c.id::text <> ALL($3::text[]))
				+ (SELECT count(DISTINCT i.client_entity_id) FROM invoices i JOIN client_entities ce ON ce.id = i.client_entity_id
					WHERE ${PENDING_SEND_SQL} AND ce.odoo_partner_id IS NULL AND ce.id::text <> ALL($4::text[])) AS pending`,
			[holdingId, notApplicable.products ?? [], notApplicable.companies ?? [], notApplicable.customers ?? []]
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
