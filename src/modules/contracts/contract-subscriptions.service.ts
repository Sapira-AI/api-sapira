import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import { SUBSCRIPTION_STATUSES, type SubscriptionSortField, type SubscriptionStatus } from './dtos/query-contract-subscriptions.dto';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** Estados que aportan MRR cuando la suscripción no tiene filas en el devengo del mes. */
export const SUBSCRIPTION_MRR_STATUSES: SubscriptionStatus[] = ['active', 'past_due'];

/**
 * MRR del mes de la suscripción, en moneda del sistema (`m.mrr`). `$1` = holding, `$2` = hoy.
 * 1. Filas del devengo (`revenue_schedule_monthly.subscription_id`) del mes, igual que el Dashboard.
 * 2. Si no hay filas (hoy el devengo no tiene filas de suscripciones): `monthly_amount_system_currency` de la suscripción
 *    (o `monthly_amount × fx_to_system`, o la suma de sus ítems no cancelados), solo para `active` y `past_due`.
 */
const MRR_LATERALS = `LEFT JOIN LATERAL (
		SELECT COUNT(*) AS items_count,
			COALESCE(SUM(si.monthly_amount_system_currency) FILTER (WHERE si.canceled_at IS NULL), 0) AS items_mrr,
			array_agg(DISTINCT si.product_name ORDER BY si.product_name) FILTER (WHERE si.product_name IS NOT NULL) AS products
		FROM subscription_items si WHERE si.subscription_id = s.id
	) it ON true
	LEFT JOIN LATERAL (
		SELECT COUNT(*) AS rows_count, SUM(r.mrr_period_system_ccy) AS mrr
		FROM revenue_schedule_monthly r
		WHERE r.subscription_id = s.id AND r.holding_id = $1 AND r.is_total_row = false
			AND r.period_month = date_trunc('month', $2::date)
	) rsm ON true
	LEFT JOIN LATERAL (
		SELECT CASE
			WHEN rsm.rows_count > 0 THEN COALESCE(rsm.mrr, 0)
			WHEN s.status IN (${SUBSCRIPTION_MRR_STATUSES.map((value) => `'${value}'`).join(', ')}) THEN COALESCE(
				NULLIF(s.monthly_amount_system_currency, 0),
				NULLIF(s.monthly_amount * COALESCE(s.fx_to_system, 1), 0),
				it.items_mrr,
				0
			)
			ELSE 0
		END AS mrr,
		CASE WHEN rsm.rows_count > 0 THEN 'rsm' ELSE 'subscription' END AS mrr_source
	) m ON true`;

export interface SubscriptionListFilters {
	page?: number;
	limit?: number;
	status?: string;
	search?: string;
	clientId?: string;
	/** Razón social (`subscriptions.client_entity_id`). */
	entityId?: string;
	sortBy?: SubscriptionSortField;
	sortOrder?: 'asc' | 'desc';
}

/** `?status=` (coma) → estados de la lista blanca; `all` o vacío = todos. */
export const parseSubscriptionStatus = (value?: string | null): SubscriptionStatus[] => {
	const parts = (value ?? '').split(',').map((part) => part.trim());

	if (parts.includes('all')) return [];

	return [...new Set(parts.filter((part): part is SubscriptionStatus => (SUBSCRIPTION_STATUSES as readonly string[]).includes(part)))];
};

/**
 * Suscripciones (Stripe) para la pestaña "Suscripciones" de Contratos v2. Solo lectura, acotada al holding del guard.
 * No reutiliza `SubscriptionsService` (`/subscriptions`): ese controlador lee `x-holding-id` sin `HoldingScopeGuard`,
 * devuelve `pagination.totalPages` y calcula el MRR con `unit_price × quantity` sin mirar intervalo ni moneda.
 */
@Injectable()
export class ContractSubscriptionsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly holdingMetrics: HoldingMetricsService
	) {}

	async list(holdingId: string, filters: SubscriptionListFilters, asOfDate = new Date()) {
		const { page = 1, limit = 25, search, clientId, entityId, sortBy = 'start_date', sortOrder = 'desc' } = filters;
		const statuses = parseSubscriptionStatus(filters.status);
		const params: unknown[] = [holdingId, isoDate(asOfDate)];
		const where = [`s.holding_id = $1`];

		if (clientId) where.push(`s.client_id = $${params.push(clientId)}`);
		if (entityId) where.push(`s.client_entity_id = $${params.push(entityId)}`);
		if (search?.trim()) {
			const n = params.push(`%${search.trim()}%`);

			where.push(`(cl.name_commercial ILIKE $${n} OR ce.legal_name ILIKE $${n} OR s.external_id ILIKE $${n})`);
		}

		const from = `FROM subscriptions s
			LEFT JOIN clients cl ON cl.id = s.client_id
			LEFT JOIN client_entities ce ON ce.id = s.client_entity_id
			${MRR_LATERALS}`;
		const base = `WHERE ${where.join(' AND ')}`;
		// Literales de la lista blanca: el conteo comparte `params` y no usa el estado.
		const statusFilter = statuses.length ? `AND s.status IN (${statuses.map((value) => `'${value}'`).join(', ')})` : '';
		const orderColumn =
			{
				client_name: 'cl.name_commercial',
				status: 's.status',
				start_date: 's.start_date',
				current_period_end: 's.current_period_end',
				mrr: 'm.mrr',
				monthly_amount: 's.monthly_amount',
				created_at: 's.created_at',
				legal_name: 'ce.legal_name',
				products: 'it.products[1]',
				monthly_amount_system_currency: 's.monthly_amount_system_currency',
				cancel_at_period_end: 'COALESCE(s.cancel_at_period_end, false)',
				stripe_subscription_id: 's.external_id',
				last_synced_at: 's.last_synced_at',
			}[sortBy] ?? 's.start_date';
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;

		const [rows, countRows] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT s.id, s.external_id, s.source, s.status, s.client_id, cl.name_commercial AS client_name,
					s.client_entity_id, ce.legal_name, s.currency, s.monthly_amount, s.system_currency, s.monthly_amount_system_currency,
					s.start_date, s.current_period_start, s.current_period_end, s.cancel_at_period_end, s.canceled_at, s.ended_at,
					s.last_synced_at, s.created_at, m.mrr, m.mrr_source, COALESCE(it.items_count, 0) AS items_count,
					COALESCE(it.products, '{}') AS products
				${from}
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, s.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				// Comparte `params` y el FROM con la lista (cada `$n` se usa); el estado no filtra el conteo.
				`SELECT s.status, COUNT(*) AS count ${from} ${base} GROUP BY s.status`,
				params
			),
		]);
		const counts: Record<string, number> = { all: 0, ...Object.fromEntries(SUBSCRIPTION_STATUSES.map((value) => [value, 0])) };

		for (const row of countRows) {
			const count = toNumber(row.count);

			counts.all += count;
			if (row.status) counts[String(row.status)] = (counts[String(row.status)] ?? 0) + count;
		}
		const total = statuses.length ? statuses.reduce((sum, value) => sum + (counts[value] ?? 0), 0) : counts.all;

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				stripe_subscription_id: toText(row.external_id),
				source: toText(row.source),
				status: toText(row.status),
				client_id: toText(row.client_id),
				client_name: toText(row.client_name),
				client_entity_id: toText(row.client_entity_id),
				legal_name: toText(row.legal_name),
				currency: toText(row.currency),
				monthly_amount: toNullableNumber(row.monthly_amount),
				system_currency: toText(row.system_currency),
				monthly_amount_system_currency: toNullableNumber(row.monthly_amount_system_currency),
				start_date: toIso(row.start_date),
				current_period_start: toIso(row.current_period_start),
				current_period_end: toIso(row.current_period_end),
				cancel_at_period_end:
					row.cancel_at_period_end === null || row.cancel_at_period_end === undefined ? null : Boolean(row.cancel_at_period_end),
				canceled_at: toIso(row.canceled_at),
				ended_at: toIso(row.ended_at),
				last_synced_at: toIso(row.last_synced_at),
				mrr: toNumber(row.mrr),
				mrr_source: toText(row.mrr_source) as 'rsm' | 'subscription',
				items_count: toNumber(row.items_count),
				products: Array.isArray(row.products) ? (row.products as string[]) : [],
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
		};
	}

	/** KPIs de la pestaña: suscripciones activas y MRR del mes (misma regla que la columna `mrr` de la lista). */
	async summary(holdingId: string, asOfDate = new Date()) {
		const asOf = isoDate(asOfDate);
		const [[row], currency] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) FILTER (WHERE s.status = 'active') AS active, COUNT(*) FILTER (WHERE s.status = 'past_due') AS past_due,
					COALESCE(SUM(m.mrr), 0) AS mrr
				FROM subscriptions s
				${MRR_LATERALS}
				WHERE s.holding_id = $1`,
				[holdingId, asOf]
			),
			this.holdingMetrics.systemCurrency(holdingId),
		]);

		return {
			as_of: asOf,
			currency,
			active: toNumber(row?.active),
			past_due: toNumber(row?.past_due),
			mrr: Math.round(toNumber(row?.mrr) * 100) / 100,
		};
	}
}
