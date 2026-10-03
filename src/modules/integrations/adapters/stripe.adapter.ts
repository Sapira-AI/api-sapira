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

import { IntegrationAdapter, IntegrationRules, SyncOptions } from './integration-adapter';

type Row = Record<string, unknown>;

const LOCK_WINDOW_MS = 2 * 60 * 60 * 1000;
const RUNS_WINDOW = 300;
const STRIPE_API_VERSION = '2026-01-28.clover';
const ENTITY_LABELS: Record<string, string> = { customers: 'Clientes', subscriptions: 'Suscripciones', invoices: 'Invoices' };

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
	async sync(holdingId: string, _actor: Actor, options: SyncOptions & { connection_id?: string }): Promise<SyncStarted> {
		const active = (await this.all(holdingId)).filter((row) => row.is_active !== false);
		const connection = options.connection_id ? await this.byId(holdingId, options.connection_id) : active.length === 1 ? active[0] : null;

		if (!connection) {
			if (!active.length) throw new BadRequestException('La integración no está conectada');
			throw validationException([{ field: 'connection_id', message: 'Indica la cuenta de Stripe a sincronizar' }]);
		}
		if (connection.is_active === false) throw new BadRequestException('La cuenta está pausada');
		await this.assertIdle(holdingId, connection.id);
		const today = new Date();
		const result = await this.ingestion.syncAll(
			{
				connection_id: connection.id,
				date_from: options.date_from ?? isoDay(new Date(today.getTime() - 2 * 86_400_000)),
				date_to: options.date_to ?? isoDay(today),
			},
			holdingId
		);

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

			return {
				id: `stripe-ingest:${batch}`,
				tipo: 'stripe',
				kind: 'stripe_ingest',
				kind_label: 'Ingesta a revisión',
				trigger: items.some((item) => item.user_id) ? 'manual' : 'automatic',
				status: runStatusOf({
					running: items.some((item) => item.status === 'running'),
					failed: items.every((item) => item.status === 'failed' || item.status === 'error'),
					cancelled: items.some((item) => item.status === 'cancelled'),
					ok,
					errors,
				}),
				started_at: Number.isFinite(started) ? new Date(started) : null,
				finished_at: finished ? new Date(finished) : null,
				duration_ms: finished && Number.isFinite(started) ? finished - started : null,
				totals: { total: items.reduce((sum, item) => sum + (item.records_processed ?? 0), 0), ok, errors, skipped: 0 },
				error: null,
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
		const errors = Array.isArray(row.errors) ? (row.errors as unknown[]).length : 0;
		const ok = Object.values(stats).reduce((sum, entity) => sum + (Number(entity?.created) || 0) + (Number(entity?.updated) || 0), 0);

		return {
			id: `stripe-import:${row.id}`,
			tipo: 'stripe',
			kind: 'stripe_import',
			kind_label: 'Importación a Sapira',
			trigger: 'manual',
			status: runStatusOf({ running: row.status === 'running', failed: row.status === 'failed', ok, errors }),
			started_at: (row.created_at as Date) ?? null,
			finished_at: (row.completed_at as Date) ?? null,
			duration_ms: durationMs(row.created_at as Date, row.completed_at as Date),
			totals: { total: ok + errors, ok, errors, skipped: 0 },
			error: (row.error_message as string) ?? null,
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
				const records: RunRecord[] = logs.map((log) => {
					const entity = String((log.metadata as Row | undefined)?.entity_type ?? log.target_table);

					return {
						object: entity,
						label: `${ENTITY_LABELS[entity] ?? entity}: ${log.records_success ?? 0} de ${log.records_processed ?? 0}`,
						sapira_id: null,
						external_id: null,
						status: (log.records_failed ?? 0) > 0 || log.status === 'failed' ? 'error' : 'ok',
						message: log.error_details ? JSON.stringify(log.error_details).slice(0, 500) : null,
					};
				});

				return { ...run, records, errors_summary: errorsSummary(records) };
			}
		}
		if (parsed?.source === 'stripe-import') {
			const [row] = (await this.dataSource.query(`SELECT * FROM stripe_sync_jobs WHERE id::text = $1 AND holding_id = $2`, [
				parsed.raw,
				holdingId,
			])) as Row[];

			if (row) {
				const records: RunRecord[] = ((Array.isArray(row.errors) ? row.errors : []) as Row[]).map((error) => ({
					object: String(error.entity ?? error.type ?? 'registro'),
					label: String(error.id ?? error.stripe_id ?? error.entity ?? 'Registro'),
					sapira_id: null,
					external_id: (error.stripe_id as string) ?? (error.id as string) ?? null,
					status: 'error',
					message: String(error.error ?? error.message ?? 'Error sin detalle'),
				}));

				return { ...this.importRun(row), records, errors_summary: errorsSummary(records) };
			}
		}
		throw new NotFoundException('Corrida no encontrada');
	}

	// ── Registros ───────────────────────────────────────────────────────────────────────────────────────────────────────────

	recordSources(): RecordSource[] {
		const source = (object: string, label: string, table: string, name: string): RecordSource => ({
			object,
			label,
			table,
			direction: 'import',
			importable: true,
			importByIds: false,
			hasAccount: true,
			sql: `SELECT s.stripe_id AS record_key, COALESCE(${name}, s.stripe_id) AS label, NULL::text AS sapira_id, s.stripe_id AS external_id,
					${stagingStatusSql('s.processing_status')} AS status,
					COALESCE(s.error_message, s.integration_notes) AS message, COALESCE(s.last_integrated_at, s.updated_at) AS last_sync_at,
					to_jsonb(s.*) AS rule_row, s.connection_id::text AS account_id, c.name AS account_name
				FROM ${table} s LEFT JOIN stripe_connections c ON c.id = s.connection_id
				WHERE s.holding_id = $1`,
		});

		return [
			source('customer', 'Cliente', 'stripe_customers_stg', `COALESCE(s.raw_data->>'name', s.raw_data->>'email')`),
			source('subscription', 'Suscripción', 'stripe_subscriptions_stg', `NULLIF(concat_ws(' · ', s.stripe_id, s.raw_data->>'status'), '')`),
			source('invoice', 'Invoice', 'stripe_invoices_stg', `NULLIF(concat_ws(' · ', s.raw_data->>'number', s.raw_data->>'customer_name'), '')`),
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

	async getMapping(holdingId: string, object: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		if (object !== 'products') throw new NotFoundException('Mapeo no encontrado');
		const [{ refs, error }, products, mappings] = await Promise.all([
			this.externalProducts(holdingId),
			this.dataSource.query(
				`SELECT p.id, p.name, p.product_code,
					(SELECT count(DISTINCT ct.id) FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
						WHERE ci.product_id = p.id AND ct.holding_id = $1 AND ct.status = 'Activo') AS contracts
				FROM products p WHERE p.holding_id = $1 ORDER BY lower(p.name)`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(`SELECT sapira_product_id, stripe_product_id FROM stripe_product_mappings WHERE holding_id = $1`, [
				holdingId,
			]) as Promise<Row[]>,
		]);
		const byId = new Map(refs.map((ref) => [ref.id, ref]));
		const rows: MappingRow[] = products.flatMap((product): MappingRow[] => {
			const sapira: Ref = { id: String(product.id), label: String(product.name ?? ''), meta: { code: product.product_code ?? null } };
			const usage = { contracts: Number(product.contracts) || 0 };
			const mapped = mappings.filter((mapping) => String(mapping.sapira_product_id) === sapira.id);

			if (!mapped.length) {
				const suggestion = suggestRef({ label: sapira.label, code: product.product_code }, refs);

				return [
					{
						key: sapira.id,
						sapira,
						external: null,
						status: suggestion ? 'suggested' : 'unmapped',
						suggestion,
						usage,
						meta: null,
					} satisfies MappingRow,
				];
			}

			return mapped.map((mapping) => {
				const externalId = String(mapping.stripe_product_id);

				return {
					key: `${sapira.id}:${externalId}`,
					sapira,
					external: byId.get(externalId) ?? { id: externalId, label: externalId, meta: {} },
					status: 'mapped',
					suggestion: null,
					usage,
					meta: null,
				} satisfies MappingRow;
			});
		});

		return buildMappingView(
			{ object, object_label: 'Productos', anchor: 'sapira', external_available: !error, external_error: error },
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

	async pendingMapping(holdingId: string): Promise<number> {
		if (!(await this.all(holdingId)).length) return 0;
		const [row] = (await this.dataSource.query(
			`SELECT count(DISTINCT ci.product_id) AS n FROM contract_items ci JOIN contracts ct ON ct.id = ci.contract_id
			WHERE ct.holding_id = $1 AND ct.status = 'Activo' AND ci.product_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM stripe_product_mappings m WHERE m.holding_id = $1 AND m.sapira_product_id = ci.product_id)`,
			[holdingId]
		)) as Row[];

		return Number(row?.n) || 0;
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
