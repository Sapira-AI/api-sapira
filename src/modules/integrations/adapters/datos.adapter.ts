import { randomUUID } from 'crypto';

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { BigQueryConnection } from '@/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity';
import { BigQueryService } from '@/modules/bigquery/bigquery.service';

import {
	Actor,
	ConnectionTestResult,
	ConnectionView,
	durationMs,
	emptyConnection,
	errorsSummary,
	errorText,
	filterRuns,
	ImpactErrors,
	ImportRequest,
	ImportStarted,
	IntegrationRun,
	IntegrationRunDetail,
	MappingView,
	nextDailyAt,
	paginateArray,
	Paginated,
	parseRunId,
	RecordSource,
	RunRecord,
	RunsQuery,
	runStatusOf,
	ScheduleInfo,
	sortRunsDesc,
	stagingStatusSql,
	SyncStarted,
} from '../integrations.types';

import { IntegrationAdapter, IntegrationRules, SyncOptions } from './integration-adapter';

type Row = Record<string, unknown>;

const ERROR_STATUSES = ['unmapped', 'currency_mismatch', 'blocked', 'ambiguous', 'conflict', 'changed_in_source'];
const REASON_LABELS: Record<string, string> = {
	unmapped: 'Sin producto: no pudimos asociarlo a un producto de un contrato',
	currency_mismatch: 'En una moneda distinta a la del contrato',
	blocked: 'La factura del período ya no está por emitir',
	ambiguous: 'Coincide con más de un producto de contrato',
	conflict: 'Ya hay un consumo cargado a mano para ese período',
	changed_in_source: 'El almacén de datos lo cambió después de importarlo',
};

export interface DatosConnectionInput {
	name: string;
	project_id: string;
	dataset_id?: string | null;
	credentials?: string;
}

interface ManualRun {
	holdingId: string;
	kind: 'datos_sync' | 'datos_import';
	startedAt: Date;
	finishedAt: Date | null;
	status: 'running' | 'completed' | 'failed';
	error: string | null;
	result: Record<string, unknown> | null;
}

const parseCredentials = (value: string | null | undefined): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(value ?? '');

		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

/**
 * Almacén de datos (BigQuery). Tabla intermedia = `sapira_quantity_imports` (fase 1: `finance.sapira_base` → tabla; fase 2: tabla →
 * `quantities`). Reutiliza `BigQueryService.syncSapiraQuantities` ("Sincronizar ahora" = fase 1 + 2) e `integrateSapiraQuantities`
 * ("Importar" = fase 2 con reintento). Las cargas (A6) se derivan de `synced_at` por hora, sin tabla nueva. El lock de "Sincronizar
 * ahora" es en memoria de la réplica (como el del cron).
 */
@Injectable()
export class DatosAdapter implements IntegrationAdapter {
	readonly tipo = 'datos' as const;
	readonly mappingObjects: string[] = [];
	readonly defaultRules: IntegrationRules = {};
	private readonly logger = new Logger(DatosAdapter.name);
	private readonly manualRuns = new Map<string, ManualRun>();

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(BigQueryConnection) private readonly connections: Repository<BigQueryConnection>,
		private readonly bigQuery: BigQueryService,
		private readonly config: ConfigService
	) {}

	// ── Conexión ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	private async current(holdingId: string): Promise<BigQueryConnection | null> {
		const rows = await this.connections.find({ where: { holding_id: holdingId }, order: { created_at: 'DESC' } });

		return rows.find((row) => row.is_active !== false) ?? rows[0] ?? null;
	}

	private async require(holdingId: string): Promise<BigQueryConnection> {
		const connection = await this.current(holdingId);

		if (!connection) throw new NotFoundException('No hay una conexión con el almacén de datos');

		return connection;
	}

	private view(connection: BigQueryConnection | null): ConnectionView {
		if (!connection) return emptyConnection('datos');
		const credentials = parseCredentials(connection.credentials);
		const keyId = typeof credentials?.private_key_id === 'string' ? credentials.private_key_id : '';

		return {
			tipo: 'datos',
			system: 'bigquery',
			connected: true,
			id: connection.id,
			name: connection.name,
			active: connection.is_active !== false,
			fields: { project_id: connection.project_id, dataset_id: connection.dataset_id ?? null, client_email: credentials?.client_email ?? null },
			secrets: { credentials: { has_secret: Boolean(connection.credentials), secret_last4: keyId.length >= 8 ? keyId.slice(-4) : null } },
			last_sync_at: connection.last_sync_at ?? null,
			created_at: connection.created_at ?? null,
			updated_at: connection.updated_at ?? null,
		};
	}

	async getConnection(holdingId: string): Promise<ConnectionView> {
		return this.view(await this.current(holdingId));
	}

	async saveConnection(holdingId: string, input: DatosConnectionInput, actor: Actor): Promise<ConnectionView> {
		const current = await this.current(holdingId);

		if (input.credentials !== undefined) {
			const credentials = parseCredentials(input.credentials);

			if (!credentials || typeof credentials.client_email !== 'string' || typeof credentials.private_key !== 'string') {
				throw validationException([
					{ field: 'credentials', message: 'Las credenciales deben ser el JSON de una cuenta de servicio (client_email y private_key)' },
				]);
			}
		} else if (!current) {
			throw validationException([{ field: 'credentials', message: 'Faltan las credenciales de la cuenta de servicio' }]);
		}
		const data: Partial<BigQueryConnection> = {
			name: input.name.trim(),
			project_id: input.project_id.trim(),
			dataset_id: input.dataset_id ?? undefined,
			...(input.credentials ? { credentials: input.credentials } : {}),
		};

		if (current) {
			await this.connections.update({ id: current.id, holding_id: holdingId }, { ...data, updated_at: new Date() });

			return this.getConnection(holdingId);
		}

		return this.view(
			await this.connections.save(this.connections.create({ ...data, holding_id: holdingId, user_id: actor.authId, is_active: true }))
		);
	}

	async testConnection(holdingId: string): Promise<ConnectionTestResult> {
		const connection = await this.require(holdingId);
		const tested_at = new Date().toISOString();

		try {
			const client = await this.bigQuery.getBigQueryClientForHolding(holdingId);

			if (!client) return { ok: false, tested_at, message: 'No pudimos crear el cliente con las credenciales guardadas', details: {} };
			const [datasets] = await client.getDatasets();

			return { ok: true, tested_at, message: 'Conexión correcta', details: { project_id: connection.project_id, datasets: datasets.length } };
		} catch (error) {
			return {
				ok: false,
				tested_at,
				message: 'El almacén de datos rechazó las credenciales o no respondió',
				details: { error: errorText(error) },
			};
		}
	}

	async setActive(holdingId: string, active: boolean): Promise<ConnectionView> {
		const connection = await this.require(holdingId);

		await this.connections.update({ id: connection.id, holding_id: holdingId }, { is_active: active, updated_at: new Date() });

		return this.getConnection(holdingId);
	}

	async deleteImpact(holdingId: string): Promise<ImpactErrors> {
		const [row] = (await this.dataSource.query(
			`SELECT count(*) FILTER (WHERE integration_status = 'pending') AS pending FROM sapira_quantity_imports WHERE holding_id = $1`,
			[holdingId]
		)) as Row[];

		return Number(row?.pending) > 0 ? [{ field: 'pending', message: `${row.pending} consumos pendientes de importar (se conservan)` }] : [];
	}

	async deleteConnection(holdingId: string): Promise<void> {
		const connection = await this.require(holdingId);

		await this.connections.delete({ id: connection.id, holding_id: holdingId });
	}

	// ── Sincronizar e historial ─────────────────────────────────────────────────────────────────────────────────────────────

	private assertIdle(holdingId: string) {
		if ([...this.manualRuns.values()].some((run) => run.holdingId === holdingId && run.status === 'running')) {
			throw new ConflictException('Ya hay una sincronización en curso');
		}
	}

	private track(holdingId: string, kind: ManualRun['kind'], work: () => Promise<Record<string, unknown>>): string {
		const id = randomUUID();
		const run: ManualRun = { holdingId, kind, startedAt: new Date(), finishedAt: null, status: 'running', error: null, result: null };

		this.manualRuns.set(id, run);
		setImmediate(() => {
			work()
				.then((result) => Object.assign(run, { status: 'completed', result, finishedAt: new Date() }))
				.catch((error) => {
					this.logger.error(`${kind} falló (${holdingId}): ${errorText(error)}`);
					Object.assign(run, { status: 'failed', error: errorText(error), finishedAt: new Date() });
				});
		});

		return id;
	}

	async sync(holdingId: string, _actor: Actor, options: SyncOptions): Promise<SyncStarted> {
		const connection = await this.current(holdingId);

		if (!connection) throw new BadRequestException('La integración no está conectada');
		if (connection.is_active === false) throw new BadRequestException('La integración está pausada');
		this.assertIdle(holdingId);
		const id = this.track(holdingId, 'datos_sync', async () => {
			const result = await this.bigQuery.syncSapiraQuantities(holdingId, { from: options.date_from, to: options.date_to });

			return { range: result.range, ingest: result.ingest, integration: result.integration };
		});

		return { run_id: `datos-manual:${id}`, status: 'running', message: 'Trayendo los consumos del almacén de datos' };
	}

	private manualToRun(id: string, run: ManualRun): IntegrationRun {
		const integration = (run.result?.integration ?? {}) as Record<string, number>;
		const ok = Number(integration.integrated ?? 0);
		const errors = ERROR_STATUSES.reduce(
			(sum, status) => sum + Number(integration[status === 'currency_mismatch' ? 'currencyMismatch' : status] ?? 0),
			0
		);

		return {
			id: `datos-manual:${id}`,
			tipo: 'datos',
			kind: run.kind,
			kind_label: run.kind === 'datos_sync' ? 'Sincronización manual' : 'Importación de consumos',
			trigger: 'manual',
			status: runStatusOf({ running: run.status === 'running', failed: run.status === 'failed', ok, errors }),
			started_at: run.startedAt,
			finished_at: run.finishedAt,
			duration_ms: durationMs(run.startedAt, run.finishedAt),
			totals: { total: Number(integration.totalProcessed ?? 0), ok, errors, skipped: 0 },
			error: run.error,
			metrics: run.result ?? {},
		};
	}

	private loadToRun(row: Row): IntegrationRun {
		const rows = Number(row.rows) || 0;
		const errors = Number(row.errors) || 0;
		const ok = Number(row.integrated) || 0;
		const bucket = new Date(row.bucket as string | Date).toISOString();
		const manual = [...this.manualRuns.values()].some((run) => run.startedAt.toISOString().slice(0, 13) === bucket.slice(0, 13));

		return {
			id: `datos-load:${bucket}`,
			tipo: 'datos',
			kind: 'datos_load',
			kind_label: 'Carga de consumos',
			trigger: manual ? 'manual' : 'automatic',
			status: runStatusOf({ ok, errors }),
			started_at: (row.started as Date) ?? null,
			finished_at: (row.finished as Date) ?? null,
			duration_ms: durationMs(row.started as Date, row.finished as Date),
			totals: { total: rows, ok, errors, skipped: Math.max(0, rows - ok - errors) },
			error: null,
			metrics: {
				periods: (row.periods as string[]) ?? [],
				rows,
				new_rows: Number(row.new_rows) || 0,
				changed_rows: Number(row.changed_rows) || 0,
				changed_after_import: Number(row.changed_after_import) || 0,
				unmapped: Number(row.unmapped) || 0,
				errors,
			},
		};
	}

	private loadsSql(where: string) {
		return `SELECT date_trunc('hour', synced_at) AS bucket, min(synced_at) AS started, max(synced_at) AS finished,
				array_agg(DISTINCT to_char(period, 'YYYY-MM') ORDER BY to_char(period, 'YYYY-MM')) AS periods, count(*) AS rows,
				count(*) FILTER (WHERE created_at >= date_trunc('hour', synced_at)) AS new_rows,
				count(*) FILTER (WHERE created_at < date_trunc('hour', synced_at)) AS changed_rows,
				count(*) FILTER (WHERE integration_status = 'changed_in_source') AS changed_after_import,
				count(*) FILTER (WHERE integration_status = 'unmapped') AS unmapped,
				count(*) FILTER (WHERE integration_status = ANY($2::text[])) AS errors,
				count(*) FILTER (WHERE integration_status = 'integrated') AS integrated
			FROM sapira_quantity_imports WHERE holding_id = $1 ${where} GROUP BY 1 ORDER BY 1 DESC`;
	}

	async listRuns(holdingId: string, query: RunsQuery): Promise<Paginated<IntegrationRun>> {
		const loads = (await this.dataSource.query(`${this.loadsSql('')} LIMIT 300`, [holdingId, ERROR_STATUSES])) as Row[];
		const manual = [...this.manualRuns.entries()].filter(([, run]) => run.holdingId === holdingId).map(([id, run]) => this.manualToRun(id, run));
		const runs = [...loads.map((row) => this.loadToRun(row)), ...manual];

		return paginateArray(sortRunsDesc(filterRuns(runs, query)), query.page, query.limit);
	}

	async getRun(holdingId: string, id: string): Promise<IntegrationRunDetail> {
		const parsed = parseRunId(id);

		if (parsed?.source === 'datos-manual') {
			const run = this.manualRuns.get(parsed.raw);

			if (run && run.holdingId === holdingId) return { ...this.manualToRun(parsed.raw, run), records: [], errors_summary: [] };
		}
		if (parsed?.source === 'datos-load' && !Number.isNaN(Date.parse(parsed.raw))) {
			const [load] = (await this.dataSource.query(this.loadsSql(`AND date_trunc('hour', synced_at) = $3::timestamptz`), [
				holdingId,
				ERROR_STATUSES,
				parsed.raw,
			])) as Row[];

			if (load) {
				const rows = (await this.dataSource.query(
					`SELECT id, business_name, product, period, sf_id, billing_date, integration_status, integration_reason, quantity_id
					FROM sapira_quantity_imports WHERE holding_id = $1 AND date_trunc('hour', synced_at) = $2::timestamptz ORDER BY billing_date LIMIT 2000`,
					[holdingId, parsed.raw]
				)) as Row[];
				const records: RunRecord[] = rows.map((row) => {
					const status = String(row.integration_status);

					return {
						object: 'consumption',
						label: [row.business_name, row.product].filter(Boolean).join(' · '),
						sapira_id: (row.quantity_id as string) ?? null,
						external_id: [row.sf_id, row.product, row.billing_date].filter(Boolean).join(' · '),
						status: status === 'integrated' ? 'ok' : ERROR_STATUSES.includes(status) ? 'error' : 'skipped',
						message: (row.integration_reason as string) ?? REASON_LABELS[status] ?? null,
					};
				});

				return { ...this.loadToRun(load), records, errors_summary: errorsSummary(records) };
			}
		}
		throw new NotFoundException('Corrida no encontrada');
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	recordSources(): RecordSource[] {
		const reasons = Object.entries(REASON_LABELS)
			.map(([status, label]) => `WHEN '${status}' THEN '${label.replace(/'/g, "''")}'`)
			.join(' ');

		return [
			{
				object: 'consumption',
				label: 'Consumo',
				table: 'sapira_quantity_imports',
				direction: 'import',
				importable: true,
				importByIds: false,
				sql: `SELECT s.id::text AS record_key,
						concat_ws(' · ', COALESCE(s.business_name, s.entity_name), s.product, to_char(s.period, 'YYYY-MM')) AS label,
						s.quantity_id::text AS sapira_id, concat_ws(' · ', s.sf_id, s.product, s.billing_date::text) AS external_id,
						${stagingStatusSql('s.integration_status')} AS status,
						COALESCE(s.integration_reason, CASE s.integration_status ${reasons} END) AS message,
						COALESCE(s.integrated_at, s.synced_at) AS last_sync_at, to_jsonb(s.*) AS rule_row
					FROM sapira_quantity_imports s
					WHERE s.holding_id = $1 AND s.integration_status NOT IN ('no_quantity_data', 'not_variable')`,
			},
		];
	}

	async importRecords(holdingId: string, request: ImportRequest): Promise<ImportStarted> {
		if (request.object !== 'consumption') throw validationException([{ field: 'object', message: 'Este objeto no se importa' }]);
		if (request.ids?.length) throw validationException([{ field: 'ids', message: 'Los consumos se importan por período (usa all y period)' }]);
		this.assertIdle(holdingId);
		const range = request.period
			? {
					from: `${request.period}-01`,
					to: new Date(Date.UTC(Number(request.period.slice(0, 4)), Number(request.period.slice(5, 7)), 0)).toISOString().slice(0, 10),
				}
			: undefined;
		const id = this.track(holdingId, 'datos_import', async () => ({
			integration: await this.bigQuery.integrateSapiraQuantities(holdingId, { retryFailed: true, range }),
		}));

		return { run_id: `datos-manual:${id}`, status: 'running', message: 'Importando los consumos a Sapira', accepted: 0 };
	}

	// ── Mapeos (no tiene: los consumos se asocian por contrato) ─────────────────────────────────────────────────────────────

	async getMapping(): Promise<MappingView> {
		throw new NotFoundException('Mapeo no encontrado');
	}

	async mappingOptions(): Promise<never> {
		throw new NotFoundException('Mapeo no encontrado');
	}

	async putMapping(): Promise<void> {
		throw new NotFoundException('Mapeo no encontrado');
	}

	async deleteMapping(): Promise<void> {
		throw new NotFoundException('Mapeo no encontrado');
	}

	async pendingMapping(holdingId: string): Promise<number> {
		const [row] = (await this.dataSource.query(
			`SELECT count(*) AS n FROM sapira_quantity_imports WHERE holding_id = $1 AND integration_status = 'unmapped'`,
			[holdingId]
		)) as Row[];

		return Number(row?.n) || 0;
	}

	schedule(): ScheduleInfo {
		const enabled = this.config.get<string>('BIGQUERY_SYNC_ENABLED') !== 'false';
		const hour = parseInt(this.config.get<string>('BIGQUERY_SYNC_HOUR') || '3', 10);

		return {
			daily_at: `${String(hour).padStart(2, '0')}:00`,
			timezone: 'servidor',
			enabled,
			next_at: enabled ? nextDailyAt(hour, 0).toISOString() : null,
		};
	}
}
