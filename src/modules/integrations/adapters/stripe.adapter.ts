import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectRepository } from '@nestjs/typeorm';
import { Model } from 'mongoose';
import Stripe from 'stripe';
import { DataSource, Repository } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { StripeConnection } from '@/databases/postgresql/entities/integraciones/stripe/stripe-connection.entity';
import { StripeIntegrationLog, StripeIntegrationLogDocument } from '@/modules/stripe/schemas/stripe-integration-log.schema';
import { StripeSyncService } from '@/modules/stripe/services/stripe-sync.service';
import { StripeConnectionService } from '@/modules/stripe/stripe-connection.service';
import { StripeIngestionService } from '@/modules/stripe/stripe-ingestion.service';
import { StripeService } from '@/modules/stripe/stripe.service';

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

import { IntegrationAdapter, IntegrationRules, SyncOptions } from './integration-adapter';

type Row = Record<string, unknown>;

const LOCK_WINDOW_MS = 2 * 60 * 60 * 1000;
const RUNS_WINDOW = 300;
const STRIPE_API_VERSION = '2026-01-28.clover';
const ENTITY_LABELS: Record<string, string> = { customers: 'Clientes', subscriptions: 'Suscripciones', invoices: 'Invoices' };

/** Un lote de ingesta por objeto (`record_key` = el objeto: el error se repite "en la ingesta de clientes"). */
function ingestRecord(log: StripeIntegrationLog): RunRecord {
	const entity = String((log.metadata as Row | undefined)?.entity_type ?? log.target_table);

	return {
		object: entity,
		record_key: entity,
		label: `${ENTITY_LABELS[entity] ?? entity}: ${log.records_success ?? 0} de ${log.records_processed ?? 0}`,
		sapira_id: null,
		external_id: null,
		status: (log.records_failed ?? 0) > 0 || log.status === 'failed' ? 'error' : 'ok',
		message: log.error_details ? JSON.stringify(log.error_details).slice(0, 500) : null,
	};
}

/** `errors` es `string[]` (mensajes de la corrida) en `StripeSyncService`; se aceptan también objetos por registro. */
function importErrorRecords(row: Row): RunRecord[] {
	return ((Array.isArray(row.errors) ? row.errors : []) as Array<Row | string>).map((error) =>
		typeof error === 'string'
			? { object: 'registro', record_key: null, label: 'Importación', sapira_id: null, external_id: null, status: 'error', message: error }
			: {
					object: String(error.entity ?? error.type ?? 'registro'),
					record_key: (error.stripe_id as string) ?? (error.id as string) ?? null,
					label: String(error.id ?? error.stripe_id ?? error.entity ?? 'Registro'),
					sapira_id: null,
					external_id: (error.stripe_id as string) ?? (error.id as string) ?? null,
					status: 'error',
					message: String(error.error ?? error.message ?? 'Error sin detalle'),
				}
	);
}

export interface StripeConnectionInput {
	name: string;
	mode: 'test' | 'live';
	secret_key?: string;
	publishable_key?: string | null;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Cliente mínimo de Stripe que usa el adaptador (se reemplaza en los tests). */
export type StripeClientLike = Pick<Stripe, 'balance' | 'products'>;

/**
 * Stripe ("Invoices y suscripciones"; no se llama Pagos: el cobro con pasarela es otra función futura), con **varias cuentas por holding** (`stripe_connections` ya lo admite; caso SimpliRoute). Reutiliza
 * `StripeConnectionService`, `StripeIngestionService.syncAll` (cuenta → revisión = "Sincronizar ahora", por cuenta),
 * `StripeSyncService.syncAll` (revisión → Sapira = "Importar", del holding completo) y `StripeService.mapProducts`. Los productos del
 * sistema se listan por cada cuenta activa (la lectura de `StripeService.getProducts` toma una sola). Historial: ingestas en
 * `stripe_integration_logs` (Mongo, por lote y cuenta) + importaciones en `stripe_sync_jobs`.
 */
@Injectable()
export class StripeAdapter implements IntegrationAdapter {
	readonly tipo = 'stripe' as const;
	readonly mappingObjects = ['products'];
	readonly defaultRules: IntegrationRules = {};

	constructor(
		private readonly dataSource: DataSource,
		@InjectRepository(StripeConnection) private readonly connections: Repository<StripeConnection>,
		private readonly stripeConnectionService: StripeConnectionService,
		private readonly stripeService: StripeService,
		private readonly ingestion: StripeIngestionService,
		private readonly stripeSync: StripeSyncService,
		@InjectModel(StripeIntegrationLog.name) private readonly logs: Model<StripeIntegrationLogDocument>,
		private readonly config: ConfigService
	) {}

	protected stripeClient(secretKey: string): StripeClientLike {
		return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION as never });
	}

	// ── Cuentas (conexiones) ────────────────────────────────────────────────────────────────────────────────────────────────

	private all(holdingId: string): Promise<StripeConnection[]> {
		return this.connections.find({ where: { holding_id: holdingId }, order: { created_at: 'ASC' } });
	}

	private async byId(holdingId: string, id: string): Promise<StripeConnection> {
		const connection = await this.connections.findOne({ where: { id, holding_id: holdingId } });

		if (!connection) throw new NotFoundException('Cuenta de Stripe no encontrada');

		return connection;
	}

	private view(connection: StripeConnection | null): ConnectionView {
		if (!connection) return emptyConnection('stripe');

		return {
			tipo: 'stripe',
			system: 'stripe',
			connected: true,
			id: connection.id,
			name: connection.name,
			active: connection.is_active !== false,
			fields: { mode: connection.mode, publishable_key: connection.publishable_key ?? null },
			secrets: { secret_key: secretInfo(connection.secret_key) },
			last_sync_at: connection.last_sync_at ?? null,
			created_at: connection.created_at ?? null,
			updated_at: connection.updated_at ?? null,
		};
	}

	async listConnections(holdingId: string): Promise<{ data: ConnectionView[] }> {
		return { data: (await this.all(holdingId)).map((connection) => this.view(connection)) };
	}

	async getConnectionById(holdingId: string, id: string): Promise<ConnectionView> {
		return this.view(await this.byId(holdingId, id));
	}

	/** Resumen: la primera cuenta activa (o la primera). */
	async getConnection(holdingId: string): Promise<ConnectionView> {
		const rows = await this.all(holdingId);

		return this.view(rows.find((row) => row.is_active !== false) ?? rows[0] ?? null);
	}

	async saveConnection(holdingId: string, input: StripeConnectionInput, actor: Actor, id?: string): Promise<ConnectionView> {
		const current = id ? await this.byId(holdingId, id) : null;

		if (input.secret_key && !new RegExp(`^(sk|rk)_${input.mode}_`).test(input.secret_key)) {
			throw validationException([
				{ field: 'secret_key', message: `La clave no corresponde al modo ${input.mode === 'live' ? 'real' : 'de prueba'}` },
			]);
		}
		if (!current && !input.secret_key) throw validationException([{ field: 'secret_key', message: 'Falta la clave secreta de Stripe' }]);
		if (current && !input.secret_key && current.mode !== input.mode) {
			throw validationException([{ field: 'secret_key', message: 'Al cambiar el modo hay que escribir la clave de ese modo' }]);
		}
		const duplicated = (await this.all(holdingId)).some(
			(row) => row.id !== current?.id && row.name.trim().toLowerCase() === input.name.trim().toLowerCase()
		);

		if (duplicated) throw validationException([{ field: 'name', message: 'Ya hay una cuenta con ese nombre' }]);
		const data = {
			name: input.name.trim(),
			mode: input.mode,
			...(input.publishable_key !== undefined ? { publishable_key: input.publishable_key ?? undefined } : {}),
			...(input.secret_key ? { secret_key: input.secret_key } : {}),
		};

		if (current) return this.view(await this.stripeConnectionService.update(current.id, holdingId, data as never));

		return this.view(await this.stripeConnectionService.create({ ...data, holding_id: holdingId, user_id: actor.authId } as never));
	}

	async testConnection(holdingId: string, id?: string): Promise<ConnectionTestResult> {
		if (!id) throw new BadRequestException('Indica la cuenta de Stripe');
		const connection = await this.byId(holdingId, id);
		const tested_at = new Date().toISOString();

		try {
			const balance = await this.stripeClient(connection.secret_key).balance.retrieve();

			return {
				ok: true,
				tested_at,
				message: 'Conexión correcta',
				details: { livemode: balance.livemode, currencies: (balance.available ?? []).map((item) => item.currency.toUpperCase()) },
			};
		} catch (error) {
			return { ok: false, tested_at, message: 'Stripe rechazó la clave o no respondió', details: { error: errorText(error) } };
		}
	}

	async setActive(holdingId: string, active: boolean, id?: string): Promise<ConnectionView> {
		if (!id) throw new BadRequestException('Indica la cuenta de Stripe');
		const connection = await this.byId(holdingId, id);

		return this.view(await this.stripeConnectionService.update(connection.id, holdingId, { is_active: active } as never));
	}

	async deleteImpact(holdingId: string, id?: string): Promise<ImpactErrors> {
		if (!id) throw new BadRequestException('Indica la cuenta de Stripe');
		await this.byId(holdingId, id);
		const [row] = (await this.dataSource.query(
			`SELECT (SELECT count(*) FROM stripe_customers_stg WHERE holding_id = $1 AND connection_id = $2)
				+ (SELECT count(*) FROM stripe_subscriptions_stg WHERE holding_id = $1 AND connection_id = $2)
				+ (SELECT count(*) FROM stripe_invoices_stg WHERE holding_id = $1 AND connection_id = $2) AS staged,
				(SELECT count(*) FROM stripe_sync_jobs WHERE holding_id = $1 AND status = 'running') AS running`,
			[holdingId, id]
		)) as Row[];
		const impact: ImpactErrors = [];

		if (Number(row?.running) > 0) impact.push({ field: 'runs', message: `${row.running} importaciones en curso` });
		if (Number(row?.staged) > 0) impact.push({ field: 'records', message: `${row.staged} registros traídos de esta cuenta (se conservan)` });

		return impact;
	}

	async deleteConnection(holdingId: string, id?: string): Promise<void> {
		if (!id) throw new BadRequestException('Indica la cuenta de Stripe');
		await this.stripeConnectionService.remove((await this.byId(holdingId, id)).id, holdingId);
	}

	// ── Sincronizar e historial ─────────────────────────────────────────────────────────────────────────────────────────────

	private async assertIdle(holdingId: string, connectionId?: string) {
		const since = new Date(Date.now() - LOCK_WINDOW_MS);
		const [ingesting, [importing]] = await Promise.all([
			this.logs
				.findOne({
					holding_id: holdingId,
					status: 'running',
					started_at: { $gte: since },
					...(connectionId ? { connection_id: connectionId } : {}),
				})
				.lean()
				.exec(),
			this.dataSource.query(`SELECT id FROM stripe_sync_jobs WHERE holding_id = $1 AND status = 'running' AND created_at >= $2 LIMIT 1`, [
				holdingId,
				since,
			]) as Promise<Row[]>,
		]);

		if (ingesting || importing) throw new ConflictException('Ya hay una sincronización en curso');
	}

	/** Sincroniza una cuenta (`connection_id`); sin cuenta, solo si el holding tiene una sola activa. */
	async sync(holdingId: string, actor: Actor, options: SyncOptions & { connection_id?: string }): Promise<SyncStarted> {
		const active = (await this.all(holdingId)).filter((row) => row.is_active !== false);
		const connection = options.connection_id ? await this.byId(holdingId, options.connection_id) : active.length === 1 ? active[0] : null;

		if (!connection) {
			if (!active.length) throw new BadRequestException('La integración no está conectada');
			throw validationException([{ field: 'connection_id', message: 'Indica la cuenta de Stripe a sincronizar' }]);
		}
		if (connection.is_active === false) throw new BadRequestException('La cuenta está pausada');
		const today = new Date();
		const dateFrom = options.date_from ?? isoDay(new Date(today.getTime() - 2 * 86_400_000));
		const dateTo = options.date_to ?? isoDay(today);

		if (dateFrom > dateTo) throw validationException([{ field: 'date_from', message: 'La fecha inicial es posterior a la final' }]);
		await this.assertIdle(holdingId, connection.id);
		// `date_to` es inclusivo (contrato §0): la ingesta compara `created <= date_to` en segundos, así que va al final del día.
		const result = await this.ingestion.syncAll(
			{ connection_id: connection.id, date_from: `${dateFrom}T00:00:00.000Z`, date_to: `${dateTo}T23:59:59.999Z` },
			holdingId
		);

		// La ingesta no guarda quién la pidió: sin `user_id` el historial la mostraría como automática.
		await this.logs
			.updateMany({ holding_id: holdingId, 'metadata.batch_id': result.batch_id }, { $set: { user_id: actor.authId } })
			.exec()
			.catch(() => undefined);

		return {
			run_id: `stripe-ingest:${result.batch_id}`,
			status: 'running',
			message: `Trayendo clientes, suscripciones e invoices de ${connection.name} a revisión`,
		};
	}

	private ingestRuns(logs: StripeIntegrationLog[], accounts: Map<string, string>): IntegrationRun[] {
		const byBatch = new Map<string, StripeIntegrationLog[]>();

		for (const log of logs) {
			const batch = String((log.metadata as Row | undefined)?.batch_id ?? log.batch_uuid);

			byBatch.set(batch, [...(byBatch.get(batch) ?? []), log]);
		}

		return [...byBatch.entries()].map(([batch, items]) => {
			const ok = items.reduce((sum, item) => sum + (item.records_success ?? 0), 0);
			const errors = items.reduce((sum, item) => sum + (item.records_failed ?? 0), 0);
			const started = Math.min(...items.map((item) => new Date(item.started_at).getTime()));
			const finished = items.every((item) => item.completed_at)
				? Math.max(...items.map((item) => new Date(item.completed_at as Date).getTime()))
				: null;
			const connectionId = items.find((item) => item.connection_id)?.connection_id ?? null;
			const running = items.some((item) => item.status === 'running');
			// Los logs no guardan el entorno: solo el lease (una ingesta "en curso" de más de LOCK_WINDOW_MS quedó huérfana).
			const interrupted =
				running && isInterruptedJob({ startedAt: Number.isFinite(started) ? new Date(started) : null }, { leaseMs: LOCK_WINDOW_MS });

			return {
				id: `stripe-ingest:${batch}`,
				tipo: 'stripe',
				kind: 'stripe_ingest',
				kind_label: 'Ingesta a revisión',
				trigger: items.some((item) => item.user_id) ? 'manual' : 'automatic',
				status: runStatusOf({
					running,
					interrupted,
					failed: items.every((item) => item.status === 'failed' || item.status === 'error'),
					cancelled: items.some((item) => item.status === 'cancelled'),
					ok,
					errors,
				}),
				started_at: Number.isFinite(started) ? new Date(started) : null,
				finished_at: finished ? new Date(finished) : null,
				duration_ms: finished && Number.isFinite(started) ? finished - started : null,
				totals: runTotals({ ok, errors, unchanged: 0, total: items.reduce((sum, item) => sum + (item.records_processed ?? 0), 0) }),
				error: interrupted ? INTERRUPTED_MESSAGE : null,
				metrics: {
					account_id: connectionId,
					account_name: connectionId ? (accounts.get(connectionId) ?? null) : null,
					...Object.fromEntries(
						items.map((item) => [
							String((item.metadata as Row | undefined)?.entity_type ?? item.target_table),
							item.records_processed ?? 0,
						])
					),
				},
			};
		});
	}

	private importRun(row: Row): IntegrationRun {
		const stats = (row.stats ?? {}) as Record<string, Row>;
		// `stats` trae también subscriptionItems/invoiceItems: se cuentan solo los tres objetos que se ven en la lista.
		const entities = ['customers', 'subscriptions', 'invoices'].map((key) => stats[key] ?? {});
		const sum = (field: string) => entities.reduce((total, entity) => total + (Number(entity[field]) || 0), 0);
		const ok = sum('created') + sum('updated');
		// Errores por registro (`stats.*.errors` + inválidos) y, si la corrida cayó entera, sus mensajes en `errors[]`.
		const errors = Math.max(sum('errors') + sum('invalid'), Array.isArray(row.errors) ? (row.errors as unknown[]).length : 0);
		const skipped = sum('skipped');
		const interrupted = row.status === 'running' && isInterruptedJob({ startedAt: row.created_at as Date }, { leaseMs: LOCK_WINDOW_MS });

		return {
			id: `stripe-import:${row.id}`,
			tipo: 'stripe',
			kind: 'stripe_import',
			kind_label: 'Importación a Sapira',
			trigger: 'manual',
			status: runStatusOf({ running: row.status === 'running', interrupted, failed: row.status === 'failed', ok, unchanged: skipped, errors }),
			started_at: (row.created_at as Date) ?? null,
			finished_at: (row.completed_at as Date) ?? null,
			duration_ms: durationMs(row.created_at as Date, row.completed_at as Date),
			totals: runTotals({ ok, errors, unchanged: skipped }),
			error: interrupted ? INTERRUPTED_MESSAGE : ((row.error_message as string) ?? null),
			metrics: { progress: (row.progress as Row | null)?.overallProgress ?? null },
		};
	}

	private async accountNames(holdingId: string) {
		return new Map((await this.all(holdingId)).map((row) => [row.id, row.name]));
	}

	async listRuns(holdingId: string, query: RunsQuery): Promise<Paginated<IntegrationRun>> {
		const [logs, jobs, accounts] = await Promise.all([
			this.logs
				.find({ holding_id: holdingId })
				.sort({ started_at: -1 })
				.limit(RUNS_WINDOW * 3)
				.lean()
				.exec() as Promise<StripeIntegrationLog[]>,
			this.dataSource.query(`SELECT * FROM stripe_sync_jobs WHERE holding_id = $1 ORDER BY created_at DESC LIMIT ${RUNS_WINDOW}`, [
				holdingId,
			]) as Promise<Row[]>,
			this.accountNames(holdingId),
		]);
		const runs = [...this.ingestRuns(logs, accounts), ...jobs.map((row) => this.importRun(row))];

		return paginateArray(sortRunsDesc(filterRuns(runs, query)), query.page, query.limit);
	}

	async getRun(holdingId: string, id: string): Promise<IntegrationRunDetail> {
		const parsed = parseRunId(id);

		if (parsed?.source === 'stripe-ingest') {
			const logs = (await this.logs
				.find({ holding_id: holdingId, $or: [{ 'metadata.batch_id': parsed.raw }, { batch_uuid: parsed.raw }] })
				.lean()
				.exec()) as StripeIntegrationLog[];

			if (logs.length) {
				const [run] = this.ingestRuns(logs, await this.accountNames(holdingId));
				const records: RunRecord[] = logs.map((log) => ingestRecord(log));

				return { ...run, records, errors_summary: errorsSummary(records) };
			}
		}
		if (parsed?.source === 'stripe-import') {
			const [row] = (await this.dataSource.query(`SELECT * FROM stripe_sync_jobs WHERE id::text = $1 AND holding_id = $2`, [
				parsed.raw,
				holdingId,
			])) as Row[];

			if (row) {
				// `errors` es `string[]` (mensajes de la corrida) en `StripeSyncService`; se aceptan también objetos por registro.
				const records: RunRecord[] = importErrorRecords(row);
				// Registros que quedaron con error o inválidos en esta corrida (la tabla intermedia guarda el motivo).
				const failed = (await this.dataSource.query(
					`SELECT 'customer' AS object, stripe_id, processing_status, COALESCE(error_message, integration_notes) AS message FROM stripe_customers_stg
						WHERE holding_id = $1 AND processing_status IN ('error','invalid') AND GREATEST(last_integrated_at, updated_at) BETWEEN $2 AND COALESCE($3, now())
					UNION ALL SELECT 'subscription', stripe_id, processing_status, COALESCE(error_message, integration_notes) FROM stripe_subscriptions_stg
						WHERE holding_id = $1 AND processing_status IN ('error','invalid') AND GREATEST(last_integrated_at, updated_at) BETWEEN $2 AND COALESCE($3, now())
					UNION ALL SELECT 'invoice', stripe_id, processing_status, COALESCE(error_message, integration_notes) FROM stripe_invoices_stg
						WHERE holding_id = $1 AND processing_status IN ('error','invalid') AND GREATEST(last_integrated_at, updated_at) BETWEEN $2 AND COALESCE($3, now())
					LIMIT 2000`,
					[holdingId, row.created_at, row.completed_at ?? null]
				)) as Row[];

				records.push(
					...failed.map((item) => ({
						object: String(item.object),
						record_key: String(item.stripe_id),
						label: String(item.stripe_id),
						sapira_id: null,
						external_id: String(item.stripe_id),
						status: 'error' as const,
						message: (item.message as string) ?? null,
					}))
				);

				return { ...this.importRun(row), records, errors_summary: errorsSummary(records) };
			}
		}
		throw new NotFoundException('Corrida no encontrada');
	}

	/**
	 * Ingestas (un registro por objeto de cada lote, Mongo) y errores de las importaciones (`stripe_sync_jobs.errors`), una lectura cada una.
	 * Los registros con error de la tabla intermedia son estado actual (no por corrida) y no entran.
	 */
	async recordHistory(holdingId: string, options: RecordHistoryOptions): Promise<RunOccurrence[]> {
		const until = options.until ?? new Date();
		const keys = options.keys ? new Set(options.keys) : null;
		const [logs, jobs] = await Promise.all([
			this.logs
				.find({ holding_id: holdingId, started_at: { $gte: options.since, $lte: until } })
				.lean()
				.exec() as Promise<StripeIntegrationLog[]>,
			this.dataSource.query(
				`SELECT id, created_at, errors FROM stripe_sync_jobs WHERE holding_id = $1 AND created_at BETWEEN $2 AND $3 AND (CASE WHEN jsonb_typeof(errors) = 'array' THEN jsonb_array_length(errors) ELSE 0 END) > 0`,
				[holdingId, options.since, until]
			) as Promise<Row[]>,
		]);
		const occurrences: RunOccurrence[] = [
			...logs.map((log) => ({
				run_id: `stripe-ingest:${String((log.metadata as Row | undefined)?.batch_id ?? log.batch_uuid)}`,
				kind: 'stripe_ingest',
				at: log.started_at ?? null,
				...ingestRecord(log),
			})),
			...jobs.flatMap((row) =>
				importErrorRecords(row).map((record) => ({
					run_id: `stripe-import:${row.id}`,
					kind: 'stripe_import',
					at: (row.created_at as Date) ?? null,
					...record,
				}))
			),
		].map((item) => ({
			run_id: item.run_id,
			kind: item.kind,
			at: item.at,
			object: item.object,
			record_key: item.record_key ?? null,
			status: item.status,
			message: item.message,
		}));

		return occurrences.filter((item) => (!options.errorsOnly || item.status === 'error') && (!keys || keys.has(item.record_key ?? '')));
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	recordSources(): RecordSource[] {
		/** `link`: LATERAL que trae `sid` / `slabel` del registro creado en Sapira ("En Sapira" legible, no el uuid). */
		const source = (object: string, label: string, table: string, name: string, link: string): RecordSource => ({
			object,
			label,
			table,
			direction: 'import',
			importable: true,
			importByIds: false,
			hasChangeKind: true,
			hasSapiraLabel: true,
			hasAccount: true,
			sql: `SELECT s.stripe_id AS record_key, COALESCE(${name}, s.stripe_id) AS label, l.sid AS sapira_id, l.slabel AS sapira_label,
					s.stripe_id AS external_id,
					${stagingStatusSql('s.processing_status')} AS status, ${stagingChangeKindSql('s.processing_status')} AS change_kind,
					COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at,
					to_jsonb(s.*) AS rule_row, s.connection_id::text AS account_id, c.name AS account_name
				FROM ${table} s LEFT JOIN stripe_connections c ON c.id = s.connection_id
				LEFT JOIN LATERAL (${link}) l ON true
				WHERE s.holding_id = $1`,
		});

		return [
			source(
				'customer',
				'Cliente',
				'stripe_customers_stg',
				`COALESCE(s.raw_data->>'name', s.raw_data->>'email')`,
				`SELECT k.id::text AS sid, k.name_commercial AS slabel FROM clients k WHERE k.holding_id = s.holding_id AND k.stripe_customer_id = s.stripe_id LIMIT 1`
			),
			source(
				'subscription',
				'Suscripción',
				'stripe_subscriptions_stg',
				`NULLIF(concat_ws(' · ', s.stripe_id, s.raw_data->>'status'), '')`,
				`SELECT k.id::text AS sid, concat_ws(' · ', 'Suscripción', COALESCE(k.client_name_commercial, k.legal_client_name)) AS slabel
					FROM subscriptions k WHERE k.holding_id = s.holding_id AND k.external_id = s.stripe_id LIMIT 1`
			),
			source(
				'invoice',
				'Invoice',
				'stripe_invoices_stg',
				`NULLIF(concat_ws(' · ', s.raw_data->>'number', s.raw_data->>'customer_name'), '')`,
				`SELECT k.id::text AS sid, NULLIF(concat_ws(' · ', k.invoice_number, cl.name_commercial), '') AS slabel
					FROM invoices k LEFT JOIN clients cl ON cl.id = k.client_id WHERE k.holding_id = s.holding_id AND k.stripe_id = s.stripe_id LIMIT 1`
			),
		];
	}

	async importRecords(holdingId: string, request: ImportRequest): Promise<ImportStarted> {
		if (request.ids?.length) throw validationException([{ field: 'ids', message: 'Stripe se importa completo (usa all)' }]);
		await this.assertIdle(holdingId);
		const { jobId } = await this.stripeSync.syncAll(holdingId, 100);

		return {
			run_id: `stripe-import:${jobId}`,
			status: 'running',
			message: 'Importando clientes, suscripciones e invoices a Sapira',
			accepted: 0,
		};
	}

	// ── Mapeos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** Productos activos de cada cuenta activa (con la cuenta en `meta`). */
	private async externalProducts(holdingId: string): Promise<{ refs: Ref[]; error: string | null }> {
		const accounts = (await this.all(holdingId)).filter((row) => row.is_active !== false);
		const refs: Ref[] = [];
		const errors: string[] = [];

		for (const account of accounts) {
			try {
				const products = await this.stripeClient(account.secret_key).products.list({ active: true, limit: 100 });

				refs.push(
					...products.data.map((product) => ({
						id: product.id,
						label: accounts.length > 1 ? `${product.name} (${account.name})` : product.name,
						meta: { account_id: account.id, account_name: account.name, description: product.description ?? null },
					}))
				);
			} catch (error) {
				errors.push(`${account.name}: ${errorText(error)}`);
			}
		}

		return {
			refs,
			error: errors.length ? `Stripe no respondió (${errors.join('; ')})` : accounts.length ? null : 'No hay cuentas de Stripe activas',
		};
	}

	/**
	 * Productos de Stripe que usa el holding (en las suscripciones e invoices traídas a revisión), con cuántas suscripciones e
	 * invoices los usan y la cuenta de origen.
	 */
	private async usedProducts(holdingId: string): Promise<Row[]> {
		return (await this.dataSource.query(
			`WITH u AS (
				SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(s.raw_data->'items'->'data') = 'array' THEN s.raw_data->'items'->'data' ELSE '[]'::jsonb END)
					->'price'->>'product' AS product, 'subscription' AS kind, s.stripe_id, s.connection_id
				FROM stripe_subscriptions_stg s WHERE s.holding_id = $1
				UNION ALL
				SELECT COALESCE(l->'pricing'->'price_details'->>'product', l->'price'->>'product'), 'invoice', i.stripe_id, i.connection_id
				FROM stripe_invoices_stg i,
					jsonb_array_elements(CASE WHEN jsonb_typeof(i.raw_data->'lines'->'data') = 'array' THEN i.raw_data->'lines'->'data' ELSE '[]'::jsonb END) l
				WHERE i.holding_id = $1)
			SELECT product AS id, count(DISTINCT stripe_id) FILTER (WHERE kind = 'subscription')::int AS subscriptions,
				count(DISTINCT stripe_id) FILTER (WHERE kind = 'invoice')::int AS invoices, max(connection_id::text) AS account_id
			FROM u WHERE product IS NOT NULL GROUP BY product`,
			[holdingId]
		)) as Row[];
	}

	/**
	 * Mapeo por origen (ajuste de Domi): Stripe **importa** a Sapira, así que hay una fila por producto de Stripe que se usa (en las
	 * suscripciones/invoices traídas) o que ya está mapeado → a qué producto de Sapira corresponde (el nombre sale de la lista en vivo
	 * de cada cuenta; los activos sin uso se ofrecen en `options`). Los
	 * productos de Sapira sin contraparte en Stripe no aparecen ni cuentan como sin mapear. N:N: un producto de Stripe mapeado a dos
	 * de Sapira da dos filas. `usage` = cuánto lo usa Stripe.
	 */
	async getMapping(holdingId: string, object: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		if (object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		const [{ refs, error }, products, mappings, used, accounts] = await Promise.all([
			this.externalProducts(holdingId),
			this.dataSource.query(`SELECT p.id, p.name, p.product_code FROM products p WHERE p.holding_id = $1 ORDER BY lower(p.name)`, [
				holdingId,
			]) as Promise<Row[]>,
			this.dataSource.query(`SELECT sapira_product_id, stripe_product_id FROM stripe_product_mappings WHERE holding_id = $1`, [
				holdingId,
			]) as Promise<Row[]>,
			this.usedProducts(holdingId),
			this.accountNames(holdingId),
		]);
		const sapira: Ref[] = products.map((product) => ({
			id: String(product.id),
			label: String(product.name ?? ''),
			meta: { code: product.product_code ?? null },
		}));
		const sapiraById = new Map(sapira.map((ref) => [ref.id, ref]));
		const live = new Map(refs.map((ref) => [ref.id, ref]));
		const usage = new Map(used.map((row) => [String(row.id), row]));
		const externalIds = [...new Set([...used.map((row) => String(row.id)), ...mappings.map((row) => String(row.stripe_product_id))])];
		const rows: MappingRow[] = externalIds.flatMap((externalId): MappingRow[] => {
			const use = usage.get(externalId);
			const accountId = (use?.account_id as string) ?? null;
			const external: Ref = live.get(externalId) ?? {
				id: externalId,
				label: externalId,
				meta: { account_id: accountId, account_name: accountId ? (accounts.get(accountId) ?? null) : null },
			};
			const rowUsage = { subscriptions: Number(use?.subscriptions) || 0, invoices: Number(use?.invoices) || 0 };
			const mapped = mappings.filter((mapping) => String(mapping.stripe_product_id) === externalId);

			if (!mapped.length) {
				const suggestion = live.has(externalId) ? suggestRef({ label: external.label }, sapira) : null;

				return [
					{
						key: externalId,
						sapira: null,
						external,
						status: suggestion ? 'suggested' : 'unmapped',
						suggestion,
						usage: rowUsage,
						meta: null,
					},
				];
			}

			return mapped.map((mapping) => {
				const sapiraId = String(mapping.sapira_product_id);

				return {
					key: `${externalId}:${sapiraId}`,
					sapira: sapiraById.get(sapiraId) ?? { id: sapiraId, label: sapiraId, meta: {} },
					external,
					status: 'mapped',
					suggestion: null,
					usage: rowUsage,
					meta: null,
				} satisfies MappingRow;
			});
		});

		rows.sort(
			(a, b) =>
				Number(b.status !== 'mapped') - Number(a.status !== 'mapped') ||
				(b.usage?.subscriptions ?? 0) + (b.usage?.invoices ?? 0) - ((a.usage?.subscriptions ?? 0) + (a.usage?.invoices ?? 0)) ||
				(a.external?.label ?? '').localeCompare(b.external?.label ?? '')
		);

		return buildMappingView(
			{ object, object_label: 'Productos', anchor: 'external', external_available: !error, external_error: error },
			rows,
			query
		);
	}

	async mappingOptions(holdingId: string, object: string, side: 'sapira' | 'external', search?: string) {
		if (object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		if (side === 'sapira') {
			const rows = (await this.dataSource.query(`SELECT id, name, product_code FROM products WHERE holding_id = $1 ORDER BY lower(name)`, [
				holdingId,
			])) as Row[];

			return {
				data: filterRefs(
					rows.map((row) => ({ id: String(row.id), label: String(row.name ?? ''), meta: { code: row.product_code ?? null } })),
					search
				),
				available: true,
				error: null,
			};
		}
		const { refs, error } = await this.externalProducts(holdingId);

		return { data: filterRefs(refs, search), available: !error, error };
	}

	async putMapping(holdingId: string, object: string, items: MappingItem[], actor: Actor): Promise<void> {
		if (object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		const rows = (await this.dataSource.query(`SELECT id::text AS id FROM products WHERE holding_id = $1 AND id::text = ANY($2::text[])`, [
			holdingId,
			items.map((item) => item.sapira_id),
		])) as Row[];
		const owned = new Set(rows.map((row) => String(row.id)));
		const errors = items.flatMap((item, index) =>
			owned.has(item.sapira_id) ? [] : [{ field: `items.${index}.sapira_id`, message: 'No pertenece a este holding' }]
		);

		if (errors.length) throw validationException(errors);
		await this.stripeService.mapProducts(
			holdingId,
			{ mappings: items.map((item) => ({ sapira_product_id: item.sapira_id, stripe_product_id: item.external_id })) } as never,
			actor.userId ?? undefined
		);
	}

	async deleteMapping(holdingId: string, object: string, sapiraId: string, externalId: string): Promise<void> {
		if (object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		const result = (await this.dataSource.query(
			`DELETE FROM stripe_product_mappings WHERE holding_id = $1 AND sapira_product_id::text = $2 AND stripe_product_id = $3 RETURNING id`,
			[holdingId, sapiraId, externalId]
		)) as unknown[];
		const deleted = Array.isArray(result[0]) ? (result[0] as unknown[]).length : result.length;

		if (!deleted) throw new NotFoundException('Mapeo no encontrado');
	}

	/** Productos de Stripe usados en lo traído sin producto de Sapira (lo mismo que "Sin mapear" del mapeo, sin llamar a Stripe). */
	async pendingMapping(holdingId: string, notApplicable: Record<string, string[]> = {}): Promise<number> {
		if (!(await this.all(holdingId)).length) return 0;
		const [used, mappings] = await Promise.all([
			this.usedProducts(holdingId),
			this.dataSource.query(`SELECT DISTINCT stripe_product_id FROM stripe_product_mappings WHERE holding_id = $1`, [holdingId]) as Promise<
				Row[]
			>,
		]);
		const mapped = new Set(mappings.map((row) => String(row.stripe_product_id)));

		const skipped = new Set(notApplicable.products ?? []);

		return used.filter((row) => !mapped.has(String(row.id)) && !skipped.has(String(row.id))).length;
	}

	schedule(): ScheduleInfo {
		const enabled = this.config.get<string>('STRIPE_SYNC_ENABLED') !== 'false';
		const hour = parseInt(this.config.get<string>('STRIPE_SYNC_HOUR') || '2', 10);

		return {
			daily_at: `${String(hour).padStart(2, '0')}:00`,
			timezone: 'servidor',
			enabled,
			next_at: enabled ? nextDailyAt(hour, 0).toISOString() : null,
		};
	}
}
