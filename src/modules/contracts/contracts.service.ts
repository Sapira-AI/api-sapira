import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import { buildItemGroups, type ContractItem, deriveItemStatus, type ItemGroup, type PendingInvoiceLine } from './contract-items';
import { CONTRACT_DERIVED_STATUSES, type ContractDerivedStatus, derivedStatusLateral } from './contract-status';

import type { ContractInvoiceSortField, ContractInvoiceStatusFilter } from './dtos/query-contract-invoices.dto';
import type { ContractSortField } from './dtos/query-contracts.dto';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Emitidas (cuentan como facturadas al cliente). */
/** Tipos de evento genéricos que dejan mandar al subtipo cuando este es un tipo conocido. */
const GENERIC_EVENT_TYPES = new Set(['', 'AMENDMENT', 'MODIFICATION', 'CONTRACT_CHANGE', 'LIFECYCLE', 'CHANGE', 'OTHER']);
export const ISSUED_INVOICE_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'];

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const money = (value: number, currency: string | null) =>
	`${currency ? `${currency} ` : ''}${value.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * MRR del mes **sin** "pendiente de renovar" (decisión S5-3): el RSM guarda filas `momentum = 'PENDING_RENEWAL'` para
 * ítems vencidos sin renovar ni churn (`apply_pending_renewal_tail`); ese MRR se muestra aparte, nunca sumado.
 */
export const NOT_PENDING_RENEWAL = `r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'`;

/**
 * Borrado lógico de borradores (C5, columna `contracts.deleted_at` de la migración `1790358766159-AddContractBillingFields`):
 * un contrato borrado no aparece en ninguna lectura v2 (lista, KPIs, opciones ni 360).
 */
const NOT_DELETED = `(to_jsonb(c)->>'deleted_at') IS NULL`;

/**
 * MRR del mes del contrato en moneda del sistema (lateral `rsm`, sin pendiente de renovar). `$1` = holding, `$2` = hoy.
 * Lo comparten las filas de la lista y sus totales, para que el total sea la suma exacta de lo que muestran las filas.
 */
const LIST_MRR_LATERAL = `LEFT JOIN LATERAL (
	SELECT SUM(r.mrr_period_system_ccy) AS mrr, SUM(r.mrr_period_contract_ccy) AS mrr_contract_ccy
	FROM revenue_schedule_monthly r
	WHERE r.contract_id = c.id AND r.holding_id = $1 AND r.is_total_row = false
		AND r.period_month = date_trunc('month', $2::date) AND ${NOT_PENDING_RENEWAL}
) rsm ON true`;

/** Estado mostrado del contrato (lateral `ds`, `contract-status.ts`). `$2` = hoy. */
const DERIVED_STATUS_LATERAL = derivedStatusLateral('$2');
type DerivedStatusFilter = (typeof CONTRACT_DERIVED_STATUSES)[number];

/**
 * Estados pedidos en `?status=` (coma): `all` o vacío = todos; `in_review` = alias de `draft`. Valores fuera de la lista
 * blanca se descartan (el DTO ya los rechaza).
 */
export const parseStatusFilter = (value?: string | null): DerivedStatusFilter[] => {
	const parts = (value ?? '')
		.split(',')
		.map((part) => part.trim())
		.map((part) => (part === 'in_review' ? 'draft' : part));

	if (parts.includes('all')) return [];

	return [...new Set(parts.filter((part): part is DerivedStatusFilter => (CONTRACT_DERIVED_STATUSES as readonly string[]).includes(part)))];
};

/**
 * Fin del próximo ítem recurrente vigente hoy (no ajuste de baja, no renovado ni con churn). Es el vencimiento real
 * del contrato: el fin del contrato puede quedar lejos aunque un ítem venza antes (Tanda 2).
 * `$2` = hoy.
 */
export const NEXT_ITEM_END_LATERAL = `LEFT JOIN LATERAL (
	SELECT MIN(ci.end_date) AS next_item_end_date
	FROM contract_items ci
	WHERE ci.contract_id = c.id AND ci.is_recurring = true
		AND ci.start_date <= $2::date AND ci.end_date >= $2::date
		AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
		AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
) nx ON true`;

type BoolParam = 'true' | 'false' | boolean;

export interface ContractListFilters {
	page?: number;
	limit?: number;
	/** Uno o varios estados mostrados separados por coma (`ContractStatusFilter`, `in_review` = `draft`). */
	status?: string;
	search?: string;
	clientId?: string;
	entityId?: string;
	companyId?: string;
	currency?: string;
	productId?: string;
	endingWithinDays?: number;
	autoSendToOdoo?: BoolParam;
	type?: string;
	minValue?: number;
	maxValue?: number;
	startFrom?: string;
	startTo?: string;
	endFrom?: string;
	endTo?: string;
	nextEndFrom?: string;
	nextEndTo?: string;
	multicompany?: BoolParam;
	multicurrency?: BoolParam;
	segment?: string;
	market?: string;
	industry?: string;
	clientCountry?: string;
	entityCountry?: string;
	autoInvoice?: BoolParam;
	hasErpInvoice?: BoolParam;
	sellerId?: string;
	sortBy?: ContractSortField;
	sortOrder?: 'asc' | 'desc';
}

export interface ContractInvoiceFilters {
	page?: number;
	limit?: number;
	status?: ContractInvoiceStatusFilter;
	sortBy?: ContractInvoiceSortField;
	sortOrder?: 'asc' | 'desc';
}

export interface ContractAlert {
	code: string;
	severity: 'error' | 'warning' | 'info';
	message: string;
	count?: number;
}

export type { ContractDerivedStatus } from './contract-status';

export interface ResolvedContract {
	id: string;
	status: string | null;
	contract_end_date: string | null;
	contract_currency: string | null;
	system_currency: string | null;
}

/**
 * Contratos v2 — lectura (L1–L3 de `docs/v2-rediseno/mapa-v2-contratos.md`). Solo lee: toda consulta se acota al
 * holding del guard; las rutas por contrato resuelven primero el contrato en el holding (404 si no es suyo).
 */
@Injectable()
export class ContractsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly holdingMetrics: HoldingMetricsService
	) {}

	/** Busca el contrato por id (UUID) o por número, dentro del holding. 404 si no es del holding. */
	async resolveContract(idOrNumber: string, holdingId: string): Promise<ResolvedContract> {
		const key = (idOrNumber ?? '').trim();

		if (!key || key.length > 100) throw new NotFoundException('Contrato no encontrado');
		const where = UUID.test(key) ? `c.id = $1::uuid` : `c.contract_number = $1`;
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT c.id, c.status, c.contract_end_date::text AS contract_end_date, c.contract_currency, c.system_currency
			FROM contracts c
			WHERE ${where} AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL
			ORDER BY c.created_at DESC
			LIMIT 1`,
			[key, holdingId]
		);

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return {
			id: row.id as string,
			status: toText(row.status),
			contract_end_date: toText(row.contract_end_date),
			contract_currency: toText(row.contract_currency),
			system_currency: toText(row.system_currency),
		};
	}

	// ---------------------------------------------------------------- L1 · lista

	async list(holdingId: string, filters: ContractListFilters, asOfDate = new Date()) {
		const {
			page = 1,
			limit = 25,
			search,
			clientId,
			entityId,
			companyId,
			currency,
			productId,
			endingWithinDays,
			autoSendToOdoo,
			sortBy = 'start_date',
			sortOrder = 'desc',
		} = filters;
		const statuses = parseStatusFilter(filters.status);
		const params: unknown[] = [holdingId, isoDate(asOfDate)];
		// Los borradores eliminados (borrado lógico, C5) no existen para v2.
		const where = [`c.holding_id = $1`, NOT_DELETED];
		const list = (value?: string) =>
			(value ?? '')
				.split(',')
				.map((part) => part.trim())
				.filter(Boolean);
		const isTrue = (value: BoolParam) => value === true || value === 'true';
		const has = (value: unknown) => value !== undefined && value !== null && value !== '';

		if (clientId) where.push(`c.client_id = $${params.push(clientId)}`);
		if (entityId === 'none') where.push(`c.client_entity_id IS NULL`);
		else if (entityId) where.push(`c.client_entity_id = $${params.push(entityId)}`);
		if (companyId) where.push(`c.company_id = ANY($${params.push(list(companyId))}::uuid[])`);
		// Mismo criterio que el scheduler de Odoo: NULL cuenta como envío automático.
		if (has(autoSendToOdoo)) where.push(isTrue(autoSendToOdoo!) ? `c.auto_send_to_odoo IS DISTINCT FROM false` : `c.auto_send_to_odoo = false`);
		if (currency?.trim()) where.push(`c.contract_currency = ANY($${params.push(list(currency).map((code) => code.toUpperCase()))}::text[])`);
		if (productId)
			where.push(
				`EXISTS (SELECT 1 FROM contract_items pi WHERE pi.contract_id = c.id AND pi.product_id = ANY($${params.push(list(productId))}::uuid[]))`
			);
		if (search?.trim()) {
			const n = params.push(`%${search.trim()}%`);

			where.push(ContractsService.searchCondition(n));
		}
		// Por vencer: activos o por renovar cuyo próximo fin de ítem cae entre hoy y hoy + N (misma regla que el KPI).
		if (has(endingWithinDays)) {
			const n = params.push(Number(endingWithinDays));

			where.push(`ds.derived_status IN ('active', 'pending_renewal') AND nx.next_item_end_date BETWEEN $2::date AND $2::date + $${n}::int`);
		}
		// Filtros avanzados.
		if (filters.type?.trim()) where.push(`c.type = ANY($${params.push(list(filters.type))}::text[])`);
		if (has(filters.minValue)) where.push(`c.total_value_system_currency >= $${params.push(Number(filters.minValue))}::numeric`);
		if (has(filters.maxValue)) where.push(`c.total_value_system_currency <= $${params.push(Number(filters.maxValue))}::numeric`);
		if (filters.startFrom) where.push(`items.start_date >= $${params.push(filters.startFrom)}::date`);
		if (filters.startTo) where.push(`items.start_date <= $${params.push(filters.startTo)}::date`);
		if (filters.endFrom) where.push(`c.contract_end_date >= $${params.push(filters.endFrom)}::date`);
		if (filters.endTo) where.push(`c.contract_end_date <= $${params.push(filters.endTo)}::date`);
		if (filters.nextEndFrom) where.push(`nx.next_item_end_date >= $${params.push(filters.nextEndFrom)}::date`);
		if (filters.nextEndTo) where.push(`nx.next_item_end_date <= $${params.push(filters.nextEndTo)}::date`);
		if (has(filters.multicompany))
			where.push(isTrue(filters.multicompany!) ? `c.requires_multicompany_billing IS TRUE` : `c.requires_multicompany_billing IS NOT TRUE`);
		if (has(filters.multicurrency))
			where.push(isTrue(filters.multicurrency!) ? `c.requires_multicurrency_billing IS TRUE` : `c.requires_multicurrency_billing IS NOT TRUE`);
		if (filters.segment?.trim()) where.push(`cl.segment = ANY($${params.push(list(filters.segment))}::text[])`);
		if (filters.market?.trim()) where.push(`cl.market = ANY($${params.push(list(filters.market))}::text[])`);
		if (filters.industry?.trim()) where.push(`cl.industry = ANY($${params.push(list(filters.industry))}::text[])`);
		if (filters.clientCountry?.trim()) where.push(`cl.country = ANY($${params.push(list(filters.clientCountry))}::text[])`);
		if (filters.entityCountry?.trim()) where.push(`ce.country = ANY($${params.push(list(filters.entityCountry))}::text[])`);
		if (has(filters.autoInvoice)) where.push(isTrue(filters.autoInvoice!) ? `c.auto_invoice IS TRUE` : `c.auto_invoice IS NOT TRUE`);
		if (has(filters.hasErpInvoice))
			where.push(
				`${isTrue(filters.hasErpInvoice!) ? '' : 'NOT '}EXISTS (SELECT 1 FROM invoices ei WHERE ei.contract_id = c.id AND ei.holding_id = $1 AND ei.odoo_invoice_id IS NOT NULL)`
			);
		if (filters.sellerId) where.push(`qt.seller_id = ANY($${params.push(list(filters.sellerId))}::uuid[])`);

		const from = `FROM contracts c
			LEFT JOIN clients cl ON cl.id = c.client_id
			LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
			LEFT JOIN companies co ON co.id = c.company_id
			LEFT JOIN quotes qt ON qt.id = c.quote_id
			LEFT JOIN sellers sl ON sl.id = qt.seller_id
			LEFT JOIN LATERAL (
				SELECT MIN(ci.start_date) AS start_date, COUNT(*) AS items_count FROM contract_items ci WHERE ci.contract_id = c.id
			) items ON true
			${NEXT_ITEM_END_LATERAL}
			${DERIVED_STATUS_LATERAL}`;
		const base = `WHERE ${where.join(' AND ')}`;
		// Literales de la lista blanca (no `$n`): el conteo comparte `params` y no usa el estado.
		const statusFilter = statuses.length ? `AND ds.derived_status IN (${statuses.map((value) => `'${value}'`).join(', ')})` : '';
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn =
			{
				contract_number: 'c.contract_number',
				client_name: 'cl.name_commercial',
				start_date: 'items.start_date',
				end_date: 'c.contract_end_date',
				next_item_end_date: 'nx.next_item_end_date',
				mrr: 'mrr',
				total_value: 'c.total_value_system_currency',
				status: 'ds.derived_status',
				type: 'c.type',
				legal_name: 'ce.legal_name',
				company_name: 'co.legal_name',
				// Productos: por el primero en orden alfabético (el mismo que muestra la columna).
				products: 'pr.products[1]',
				contract_currency: 'c.contract_currency',
				// NULL cuenta como envío automático (mismo criterio que el scheduler).
				auto_send_to_odoo: '(c.auto_send_to_odoo IS DISTINCT FROM false)',
				auto_invoice: 'COALESCE(c.auto_invoice, false)',
				seller: 'sl.name',
				quote: 'qt.quote_number',
				client_segment: 'cl.segment',
				client_market: 'cl.market',
				client_industry: 'cl.industry',
				client_country: 'cl.country',
				entity_country: 'ce.country',
			}[sortBy] ?? 'items.start_date';
		const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
		const offset = (page - 1) * limit;

		const [rows, [countRow], [totalsRow], systemCurrency] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT c.id, c.contract_number, c.status, ds.derived_status, c.type, c.client_id, cl.name_commercial AS client_name,
					c.client_entity_id, ce.legal_name, c.company_id, co.legal_name AS company_name,
					cl.country AS client_country, ce.country AS entity_country, cl.segment AS client_segment, cl.market AS client_market, cl.industry AS client_industry,
					items.start_date::text AS start_date, c.contract_end_date::text AS end_date,
					nx.next_item_end_date::text AS next_item_end_date,
					CASE WHEN c.status = 'Activo' AND c.contract_end_date >= $2::date THEN c.contract_end_date - $2::date END AS days_to_end,
					CASE WHEN c.status = 'Activo' AND c.contract_end_date < $2::date THEN $2::date - c.contract_end_date END AS days_since_end,
					c.contract_currency, c.invoice_currency, c.system_currency,
					COALESCE(rsm.mrr, 0) AS mrr, COALESCE(rsm.mrr_contract_ccy, 0) AS mrr_contract_ccy,
					c.total_value, c.total_value_system_currency, COALESCE(items.items_count, 0) AS items_count,
					COALESCE(pr.products, '{}') AS products, c.auto_send_to_odoo, c.auto_invoice,
					c.requires_multicompany_billing, c.requires_multicurrency_billing,
					qt.seller_id, sl.name AS seller_name, qt.id AS quote_id, qt.quote_number
				${from}
				LEFT JOIN LATERAL (
					SELECT array_agg(p.product_name ORDER BY p.product_name) AS products
					FROM (
						SELECT DISTINCT ci.product_name FROM contract_items ci
						WHERE ci.contract_id = c.id AND ci.product_name IS NOT NULL
						ORDER BY ci.product_name LIMIT 5
					) p
				) pr ON true
				${LIST_MRR_LATERAL}
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, c.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				// Comparte `params` con la lista: cada `$n` se usa en el conteo (la fecha en los laterales). El estado no filtra.
				`SELECT COUNT(*) AS all_count,
					${CONTRACT_DERIVED_STATUSES.map((value) => `COUNT(*) FILTER (WHERE ds.derived_status = '${value}') AS ${value}_count`).join(',\n\t\t\t\t\t')}
				${from}
				${base}`,
				params
			),
			this.dataSource.query<Row[]>(
				// Totales del conjunto filtrado completo (todas las páginas, con el estado): mismo FROM, WHERE y MRR que las filas.
				`SELECT COUNT(*) AS contracts_count, COALESCE(SUM(rsm.mrr), 0) AS mrr_total,
					COALESCE(SUM(c.total_value_system_currency), 0) AS total_value_system
				${from}
				${LIST_MRR_LATERAL}
				${base} ${statusFilter}`,
				params
			),
			this.holdingMetrics.systemCurrency(holdingId),
		]);
		const counts = {
			all: toNumber(countRow?.all_count),
			...(Object.fromEntries(CONTRACT_DERIVED_STATUSES.map((value) => [value, toNumber(countRow?.[`${value}_count`])])) as Record<
				DerivedStatusFilter,
				number
			>),
		};
		const total = statuses.length ? statuses.reduce((sum, value) => sum + counts[value], 0) : counts.all;
		const bool = (value: unknown) => (value === null || value === undefined ? null : Boolean(value));

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				contract_number: toText(row.contract_number),
				status: toText(row.status),
				derived_status: (toText(row.derived_status) ?? 'other') as ContractDerivedStatus,
				type: toText(row.type) || null,
				client_id: toText(row.client_id),
				client_name: toText(row.client_name),
				client_country: toText(row.client_country),
				client_entity_id: toText(row.client_entity_id),
				legal_name: toText(row.legal_name),
				entity_country: toText(row.entity_country),
				company_id: toText(row.company_id),
				company_name: toText(row.company_name),
				start_date: toText(row.start_date),
				end_date: toText(row.end_date),
				next_item_end_date: toText(row.next_item_end_date),
				days_to_end: toNullableNumber(row.days_to_end),
				days_since_end: toNullableNumber(row.days_since_end),
				contract_currency: toText(row.contract_currency),
				invoice_currency: toText(row.invoice_currency),
				system_currency: toText(row.system_currency),
				mrr: toNumber(row.mrr),
				mrr_contract_ccy: toNumber(row.mrr_contract_ccy),
				total_value: toNumber(row.total_value),
				total_value_system_currency: toNumber(row.total_value_system_currency),
				items_count: toNumber(row.items_count),
				products: Array.isArray(row.products) ? (row.products as string[]) : [],
				auto_send_to_odoo: bool(row.auto_send_to_odoo),
				auto_invoice: bool(row.auto_invoice),
				requires_multicompany_billing: bool(row.requires_multicompany_billing),
				requires_multicurrency_billing: bool(row.requires_multicurrency_billing),
				seller: row.seller_id ? { id: row.seller_id as string, name: toText(row.seller_name) } : null,
				/** Cotización de origen (si el contrato nació de una). */
				client_segment: toText(row.client_segment),
				client_market: toText(row.client_market),
				client_industry: toText(row.client_industry),
				quote: row.quote_id ? { id: row.quote_id as string, number: toText(row.quote_number) } : null,
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
			/** Sobre todo el conjunto filtrado (todas las páginas, estado incluido), en moneda del sistema. */
			totals: {
				contracts: toNumber(totalsRow?.contracts_count),
				mrr: Math.round(toNumber(totalsRow?.mrr_total) * 100) / 100,
				total_value_system: Math.round(toNumber(totalsRow?.total_value_system) * 100) / 100,
				currency: systemCurrency,
			},
		};
	}

	/**
	 * Búsqueda de la lista (`$n` = `%texto%`): número de contrato, cliente, razón social, número de cotización, nombre de
	 * cualquier ítem y RUT/tax id de la razón social. El tax id se compara sin puntos, guiones ni espacios de ambos lados
	 * (`76.123.456-7` encuentra `761234567` y al revés); si el texto no tiene nada más que esos signos, no se compara.
	 */
	static searchCondition(n: number): string {
		const strip = (expression: string) => `regexp_replace(${expression}, '[.[:space:]-]', '', 'g')`;

		return `(c.contract_number ILIKE $${n} OR cl.name_commercial ILIKE $${n} OR ce.legal_name ILIKE $${n}
			OR qt.quote_number ILIKE $${n}
			OR (${strip(`$${n}`)} <> '%%' AND ${strip('ce.tax_id')} ILIKE ${strip(`$${n}`)})
			OR EXISTS (SELECT 1 FROM contract_items si WHERE si.contract_id = c.id AND si.product_name ILIKE $${n}))`;
	}

	// ---------------------------------------------------------------- L2 · KPIs

	/**
	 * KPIs de la lista. MRR = MRR del Dashboard (`HoldingMetricsService`: RSM de contratos y suscripciones + MRR legacy)
	 * **menos** el pendiente de renovar del mes, que va en su propia tarjeta (S5-3). El servicio compartido suma las
	 * filas RSM `PENDING_RENEWAL` (no filtra `momentum`), así que se restan aquí: Dashboard = `mrr` + `pending_renewal_mrr`.
	 * Los conteos usan el mismo estado mostrado que la lista (`?status=active|pending_renewal|expired|draft|paused`) y
	 * `ending_30d` es el mismo filtro que `?endingWithinDays=30`.
	 */
	async summary(holdingId: string, asOfDate = new Date()) {
		const asOf = isoDate(asOfDate);
		const [metrics, [pendingRow], [countRow]] = await Promise.all([
			this.holdingMetrics.monthMetrics(holdingId, asOf),
			this.dataSource.query<Row[]>(
				`SELECT COALESCE(SUM(r.mrr_period_system_ccy), 0) AS pending
				FROM revenue_schedule_monthly r
				WHERE r.holding_id = $1 AND r.is_total_row = false AND r.period_month = date_trunc('month', $2::date)
					AND r.momentum = 'PENDING_RENEWAL'`,
				[holdingId, asOf]
			),
			this.dataSource.query<Row[]>(
				// Mismo lateral de estado que la lista: cada KPI es exactamente el filtro `?status=` (o `?endingWithinDays=30`).
				`SELECT
					COUNT(*) FILTER (WHERE ds.derived_status = 'active') AS active_count,
					COUNT(*) FILTER (WHERE ds.derived_status = 'pending_renewal') AS pending_renewal_count,
					COUNT(*) FILTER (WHERE ds.derived_status = 'expired') AS expired_count,
					COUNT(*) FILTER (WHERE ds.derived_status = 'draft') AS draft_count,
					COUNT(*) FILTER (WHERE ds.derived_status = 'paused') AS paused_count,
					COUNT(*) FILTER (WHERE ds.derived_status IN ('active', 'pending_renewal')
						AND nx.next_item_end_date BETWEEN $2::date AND $2::date + 30) AS ending_30d
				FROM contracts c
				${NEXT_ITEM_END_LATERAL}
				${DERIVED_STATUS_LATERAL}
				WHERE c.holding_id = $1 AND ${NOT_DELETED}`,
				[holdingId, asOf]
			),
		]);
		const pending = toNumber(pendingRow?.pending);

		return {
			as_of: asOf,
			currency: metrics.currency,
			mrr: Math.round((metrics.mrr.value - pending) * 100) / 100,
			pending_renewal_mrr: pending,
			active_contracts: toNumber(countRow?.active_count),
			pending_renewal: toNumber(countRow?.pending_renewal_count),
			expired: toNumber(countRow?.expired_count),
			draft: toNumber(countRow?.draft_count),
			paused: toNumber(countRow?.paused_count),
			ending_30d: toNumber(countRow?.ending_30d),
		};
	}

	// ---------------------------------------------------------------- opciones de filtro

	async filterOptions(holdingId: string) {
		const scoped = `c.holding_id = $1 AND ${NOT_DELETED}`;
		const distinctText = (expression: string, join = '') =>
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT ${expression} AS value FROM contracts c ${join}
				WHERE ${scoped} AND NULLIF(TRIM(${expression}), '') IS NOT NULL
				ORDER BY value`,
				[holdingId]
			);
		const [companies, currencies, products, types, clientCountries, entityCountries, sellers, segments, markets, industries] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT co.id, COALESCE(co.legal_name, co.holding_name) AS name
				FROM contracts c JOIN companies co ON co.id = c.company_id
				WHERE ${scoped}
				ORDER BY name`,
				[holdingId]
			),
			distinctText('c.contract_currency'),
			this.dataSource.query<Row[]>(
				`SELECT ci.product_id AS id, COALESCE(MAX(p.name), MAX(ci.product_name)) AS name
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				LEFT JOIN products p ON p.id = ci.product_id
				WHERE ${scoped} AND ci.product_id IS NOT NULL
				GROUP BY ci.product_id
				ORDER BY name`,
				[holdingId]
			),
			distinctText('c.type'),
			distinctText('cl.country', 'JOIN clients cl ON cl.id = c.client_id'),
			distinctText('ce.country', 'JOIN client_entities ce ON ce.id = c.client_entity_id'),
			this.dataSource.query<Row[]>(
				`SELECT DISTINCT sl.id, sl.name
				FROM contracts c JOIN quotes q ON q.id = c.quote_id JOIN sellers sl ON sl.id = q.seller_id
				WHERE ${scoped}
				ORDER BY sl.name`,
				[holdingId]
			),
			distinctText('cl.segment', 'JOIN clients cl ON cl.id = c.client_id'),
			distinctText('cl.market', 'JOIN clients cl ON cl.id = c.client_id'),
			distinctText('cl.industry', 'JOIN clients cl ON cl.id = c.client_id'),
		]);
		const values = (rows: Row[]) => rows.map((row) => String(row.value));

		return {
			companies: companies.map((row) => ({ id: row.id as string, name: toText(row.name) ?? '' })),
			currencies: values(currencies),
			products: products.map((row) => ({ id: row.id as string, name: toText(row.name) ?? '' })),
			types: values(types),
			client_countries: values(clientCountries),
			entity_countries: values(entityCountries),
			sellers: sellers.map((row) => ({ id: row.id as string, name: toText(row.name) ?? '' })),
			segments: values(segments),
			markets: values(markets),
			industries: values(industries),
		};
	}

	// ---------------------------------------------------------------- L3 · contrato 360

	async detail(idOrNumber: string, holdingId: string, asOfDate = new Date()) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const today = isoDate(asOfDate);
		const [[row], alerts] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT c.id, c.contract_number, c.status, c.type,
					cl.id AS client_id, cl.name_commercial AS client_name,
					ce.id AS entity_id, ce.legal_name AS entity_legal_name, ce.tax_id AS entity_tax_id, ce.country AS entity_country,
					co.id AS company_id, co.legal_name AS company_legal_name, co.country AS company_country, co.tax_rate AS company_tax_rate,
					c.contract_currency, c.invoice_currency, c.system_currency, c.company_currency, c.fx_invoice_policy, c.fx_company_policy,
					c.total_value, c.total_value_system_currency, c.booking_date::text AS booking_date,
					(SELECT MIN(ci.start_date) FROM contract_items ci WHERE ci.contract_id = c.id)::text AS start_date,
					c.contract_end_date::text AS end_date, nx.next_item_end_date::text AS next_item_end_date, c.term, c.churn_date::text AS churn_date,
					COALESCE(cr.name, c.churn_reason) AS churn_reason,
					c.auto_send_to_odoo, c.auto_invoice, c.group_invoices_by_period, c.invoice_terms_and_conditions, c.notes,
					q.id AS quote_id, q.quote_number, c.salesforce_opportunity_id, c.created_at,
					rsm.mrr_system, rsm.mrr_contract, ds.derived_status
				FROM contracts c
				LEFT JOIN clients cl ON cl.id = c.client_id
				LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
				LEFT JOIN companies co ON co.id = c.company_id
				LEFT JOIN churn_reasons cr ON cr.id = c.churn_reason_id
				LEFT JOIN quotes q ON q.id = c.quote_id
				${NEXT_ITEM_END_LATERAL.replace(/\$2::date/g, '$3::date')}
					${derivedStatusLateral('$3')}
				LEFT JOIN LATERAL (
					SELECT SUM(r.mrr_period_system_ccy) AS mrr_system, SUM(r.mrr_period_contract_ccy) AS mrr_contract
					FROM revenue_schedule_monthly r
					WHERE r.contract_id = c.id AND r.holding_id = $2 AND r.is_total_row = false
						AND r.period_month = date_trunc('month', $3::date) AND ${NOT_PENDING_RENEWAL}
				) rsm ON true
				WHERE c.id = $1 AND c.holding_id = $2`,
				[contract.id, holdingId, today]
			),
			this.alerts(contract.id, holdingId, today),
		]);

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return {
			id: row.id as string,
			contract_number: toText(row.contract_number),
			status: toText(row.status),
			derived_status: (toText(row.derived_status) ?? 'other') as ContractDerivedStatus,
			type: toText(row.type) || null,
			client: row.client_id ? { id: row.client_id as string, name: toText(row.client_name) } : null,
			entity: row.entity_id
				? {
						id: row.entity_id as string,
						legal_name: toText(row.entity_legal_name),
						tax_id: toText(row.entity_tax_id),
						country: toText(row.entity_country),
					}
				: null,
			company: row.company_id
				? {
						id: row.company_id as string,
						legal_name: toText(row.company_legal_name),
						country: toText(row.company_country),
						tax_rate: toNullableNumber(row.company_tax_rate),
					}
				: null,
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			system_currency: toText(row.system_currency),
			company_currency: toText(row.company_currency),
			fx_invoice_policy: toText(row.fx_invoice_policy),
			fx_company_policy: toText(row.fx_company_policy),
			total_value: toNumber(row.total_value),
			total_value_system_currency: toNumber(row.total_value_system_currency),
			booking_date: toText(row.booking_date),
			start_date: toText(row.start_date),
			end_date: toText(row.end_date),
			next_item_end_date: toText(row.next_item_end_date),
			term: toNullableNumber(row.term),
			churn_date: toText(row.churn_date),
			churn_reason: toText(row.churn_reason),
			auto_send_to_odoo: row.auto_send_to_odoo === null || row.auto_send_to_odoo === undefined ? null : Boolean(row.auto_send_to_odoo),
			auto_invoice: row.auto_invoice === null || row.auto_invoice === undefined ? null : Boolean(row.auto_invoice),
			group_invoices_by_period:
				row.group_invoices_by_period === null || row.group_invoices_by_period === undefined ? null : Boolean(row.group_invoices_by_period),
			invoice_terms_and_conditions: toText(row.invoice_terms_and_conditions),
			notes: toText(row.notes),
			// `quotes` no tiene nombre propio: se expone el número (y `name` queda en null).
			quote: row.quote_id ? { id: row.quote_id as string, number: toText(row.quote_number), name: null } : null,
			salesforce_opportunity_id: toText(row.salesforce_opportunity_id),
			created_at: row.created_at instanceof Date ? row.created_at.toISOString() : toText(row.created_at),
			mrr: { system: toNumber(row.mrr_system), contract: toNumber(row.mrr_contract) },
			alerts,
		};
	}

	/** Chequeos de salud del contrato (solo lectura). Mensajes para la usuaria, sin nombres de columnas. */
	private async alerts(contractId: string, holdingId: string, today: string): Promise<ContractAlert[]> {
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT c.status, c.contract_end_date::text AS end_date, c.total_value, c.contract_currency, c.auto_send_to_odoo,
				c.client_entity_id, ce.odoo_partner_id,
				(SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id) AS items_count,
				(SELECT COUNT(*) FROM contract_items ci WHERE ci.contract_id = c.id AND ci.product_id IS NULL) AS items_without_product,
				(SELECT COALESCE(SUM(ci.final_price), 0) FROM contract_items ci WHERE ci.contract_id = c.id) AS items_total,
				inv.invoices_count, inv.invoiced_total,
				(SELECT COUNT(*) FROM invoices i
					WHERE i.contract_id = c.id AND i.holding_id = $2 AND i.is_active = true AND i.status = 'Por Emitir'
						AND ABS(COALESCE(i.amount_contract_currency, 0)
							- COALESCE((SELECT SUM(ii.subtotal_contract_currency) FROM invoice_items ii WHERE ii.invoice_id = i.id), 0)) > 0.01
				) AS header_vs_lines,
				(SELECT COUNT(*) FROM invoices i
					WHERE i.contract_id = c.id AND i.holding_id = $2 AND i.is_active = true AND i.status = 'Por Emitir'
						AND c.fx_invoice_policy = 'fixed'
						AND i.invoice_currency IS NOT NULL AND i.invoice_currency <> COALESCE(i.contract_currency, c.contract_currency)
						AND i.fx_contract_to_invoice IS NULL
				) AS fixed_fx_without_rate,
				(SELECT COUNT(*) FROM contract_items ci
					WHERE ci.contract_id = c.id AND ci.is_recurring = true AND ci.end_date < $3::date
						AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
						AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
				) AS expired_items
			FROM contracts c
			LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
			LEFT JOIN LATERAL (
				-- Facturas vigentes del contrato (Por Emitir incluidas): facturas suman, notas de crédito restan.
				SELECT COUNT(*) AS invoices_count,
					COALESCE(SUM(CASE WHEN i.document_type = 'NC' THEN -ABS(COALESCE(i.amount_contract_currency, 0))
						ELSE COALESCE(i.amount_contract_currency, 0) END), 0) AS invoiced_total
				FROM invoices i
				WHERE i.contract_id = c.id AND i.holding_id = $2 AND i.is_active = true AND i.status IS DISTINCT FROM 'Cancelada'
					AND (i.document_type IS NULL OR i.document_type ILIKE 'FACTURA%' OR i.document_type IN ('Invoice', 'NC'))
			) inv ON true
			WHERE c.id = $1 AND c.holding_id = $2`,
			[contractId, holdingId, today]
		);

		return row ? ContractsService.buildAlerts(row) : [];
	}

	/** Arma las alertas a partir de la fila de chequeos (pura, para poder probarla). */
	static buildAlerts(row: Row): ContractAlert[] {
		const alerts: ContractAlert[] = [];
		const currency = toText(row.contract_currency);
		const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

		const fixedFx = toNumber(row.fixed_fx_without_rate);

		if (fixedFx > 0) {
			alerts.push({
				code: 'fixed_fx_without_rate',
				severity: 'error',
				count: fixedFx,
				message: `${fixedFx} ${plural(fixedFx, 'factura por emitir usa', 'facturas por emitir usan')} tipo de cambio fijo pero no tiene${fixedFx === 1 ? '' : 'n'} la tasa cargada. No se deben enviar hasta completarla.`,
			});
		}

		const withoutProduct = toNumber(row.items_without_product);

		if (withoutProduct > 0) {
			alerts.push({
				code: 'items_without_product',
				severity: 'warning',
				count: withoutProduct,
				message: `${withoutProduct} ${plural(withoutProduct, 'ítem no tiene', 'ítems no tienen')} un producto del catálogo asociado.`,
			});
		}

		const totalValue = toNumber(row.total_value);
		const itemsTotal = toNumber(row.items_total);

		if (toNumber(row.items_count) > 0 && Math.abs(totalValue - itemsTotal) > 0.01) {
			const difference = totalValue - itemsTotal;

			alerts.push({
				code: 'balance',
				severity: 'warning',
				message: `El valor total del contrato (${money(totalValue, currency)}) no coincide con la suma de sus ítems (${money(itemsTotal, currency)}). Diferencia: ${money(difference, currency)}.`,
			});
		}

		const invoicesCount = toNumber(row.invoices_count);
		const invoicedTotal = toNumber(row.invoiced_total);

		if (invoicesCount > 0 && Math.abs(invoicedTotal - totalValue) > 0.01) {
			alerts.push({
				code: 'invoices_vs_total',
				severity: 'info',
				message: `Las facturas del contrato suman ${money(invoicedTotal, currency)} y el valor total es ${money(totalValue, currency)} (diferencia de ${money(invoicedTotal - totalValue, currency)}). Puede ser normal si hay cobros variables o ajustes.`,
			});
		}

		const headerVsLines = toNumber(row.header_vs_lines);

		if (headerVsLines > 0) {
			alerts.push({
				code: 'header_vs_lines',
				severity: 'warning',
				count: headerVsLines,
				message: `En ${headerVsLines} ${plural(headerVsLines, 'factura por emitir', 'facturas por emitir')} el monto total no coincide con la suma de sus líneas.`,
			});
		}

		if (row.auto_send_to_odoo === true) {
			if (!row.client_entity_id) {
				alerts.push({
					code: 'no_odoo_partner',
					severity: 'warning',
					message: 'El contrato se envía automáticamente al ERP pero no tiene razón social asignada.',
				});
			} else if (row.odoo_partner_id === null || row.odoo_partner_id === undefined) {
				alerts.push({
					code: 'no_odoo_partner',
					severity: 'warning',
					message: 'El contrato se envía automáticamente al ERP pero la razón social todavía no está vinculada a un cliente en el ERP.',
				});
			}
		}

		const expiredItems = toNumber(row.expired_items);

		if (row.status === 'Activo' && expiredItems > 0) {
			alerts.push({
				code: 'expired_items',
				severity: 'warning',
				count: expiredItems,
				message: `${expiredItems} ${plural(expiredItems, 'ítem recurrente ya terminó', 'ítems recurrentes ya terminaron')} sin renovarse ni darse de baja.`,
			});
		}

		return alerts;
	}

	// ---------------------------------------------------------------- ítems e ítem madre

	async items(idOrNumber: string, holdingId: string, asOfDate = new Date()): Promise<{ items: ContractItem[]; groups: ItemGroup[] }> {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const today = isoDate(asOfDate);
		const [rows, lines] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT ci.id, ci.product_id, ci.product_name, ci.account, ci.item_type, ci.categoria, ci.unit_of_measure,
					ci.quantity, ci.unit_price, ci.price_entry_mode, ci.annual_unit_price, ci.discount_type, ci.discount_value,
					ci.monthly_price, ci.billing_period_price, ci.final_price, ci.term_months, ci.billing_frequency, ci.billing_method,
					ci.is_recurring, ci.start_date::text AS start_date, ci.end_date::text AS end_date,
					ci.booking_date::text AS booking_date, ci.churn_date::text AS churn_date,
					ci.related_item_id, ci.renews_item_id, ci.renewed_by_item_id, ci.auto_renew, ci.currency
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				WHERE ci.contract_id = $1 AND c.holding_id = $2
				ORDER BY ci.product_name, ci.account NULLS FIRST, ci.start_date NULLS FIRST, ci.id`,
				[contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ii.invoice_id, i.issue_date::text AS issue_date, ii.contract_item_id, ii.subtotal_contract_currency AS subtotal
				FROM invoice_items ii
				JOIN invoices i ON i.id = ii.invoice_id
				WHERE i.contract_id = $1 AND i.holding_id = $2 AND i.is_active = true AND i.status = 'Por Emitir'
					AND ii.contract_item_id IS NOT NULL`,
				[contract.id, holdingId]
			),
		]);

		const items: ContractItem[] = rows.map((row) => {
			const item = {
				id: row.id as string,
				product_id: toText(row.product_id),
				product_name: toText(row.product_name),
				account: toText(row.account),
				item_type: toText(row.item_type),
				categoria: toText(row.categoria),
				unit_of_measure: toText(row.unit_of_measure),
				quantity: toNullableNumber(row.quantity),
				unit_price: toNullableNumber(row.unit_price),
				price_entry_mode: toText(row.price_entry_mode),
				annual_unit_price: toNullableNumber(row.annual_unit_price),
				discount_type: toText(row.discount_type),
				discount_value: toNullableNumber(row.discount_value),
				monthly_price: toNullableNumber(row.monthly_price),
				billing_period_price: toNullableNumber(row.billing_period_price),
				final_price: toNullableNumber(row.final_price),
				term_months: toNullableNumber(row.term_months),
				billing_frequency: toText(row.billing_frequency),
				billing_method: toText(row.billing_method),
				is_recurring: row.is_recurring !== false,
				start_date: toText(row.start_date),
				end_date: toText(row.end_date),
				booking_date: toText(row.booking_date),
				churn_date: toText(row.churn_date),
				related_item_id: toText(row.related_item_id),
				renews_item_id: toText(row.renews_item_id),
				renewed_by_item_id: toText(row.renewed_by_item_id),
				auto_renew: Boolean(row.auto_renew),
				currency: toText(row.currency),
			};

			return { ...item, status: deriveItemStatus(item, today) };
		});
		const pendingLines: PendingInvoiceLine[] = lines.map((line) => ({
			invoice_id: line.invoice_id as string,
			issue_date: toText(line.issue_date),
			contract_item_id: line.contract_item_id as string,
			subtotal: toNumber(line.subtotal),
		}));

		return { items, groups: buildItemGroups(items, today, pendingLines) };
	}

	// ---------------------------------------------------------------- facturas

	async invoices(idOrNumber: string, holdingId: string, filters: ContractInvoiceFilters) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const { page = 1, limit = 50, status = 'all', sortBy = 'issue_date', sortOrder = 'asc' } = filters;
		const params: unknown[] = [contract.id, holdingId];
		const base = `WHERE i.contract_id = $1 AND i.holding_id = $2`;
		const statusSql = {
			pending: `i.is_active = true AND i.status = 'Por Emitir'`,
			// Literal (no `$n`): un parámetro que la consulta no usa rompe el tipado de Postgres.
			issued: `i.is_active = true AND i.status IN (${ISSUED_INVOICE_STATUSES.map((value) => `'${value}'`).join(', ')})`,
			cancelled: `(i.status = 'Cancelada' OR i.is_active = false)`,
		};
		const statusFilter = status === 'all' ? '' : `AND ${statusSql[status]}`;
		// Lista blanca: el campo de orden nunca viene del usuario tal cual.
		const orderColumn = { issue_date: 'i.issue_date', amount: 'i.amount_contract_currency', status: 'i.status' }[sortBy] ?? 'i.issue_date';
		const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
		const offset = (page - 1) * limit;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT i.id, i.invoice_number, i.status, i.document_type, i.invoice_type,
					i.issue_date::text AS issue_date, i.due_date::text AS due_date,
					lines.billing_period_start::text AS billing_period_start, lines.billing_period_end::text AS billing_period_end,
					i.contract_currency, i.invoice_currency, i.amount_contract_currency, i.amount_invoice_currency, i.vat,
					i.total_invoice_currency, i.total_system_currency, i.fx_contract_to_invoice, i.is_active,
					i.odoo_invoice_id, i.sent_to_odoo_at, COALESCE(lines.lines_count, 0) AS lines_count,
					ce.legal_name, i.related_invoice_id
				FROM invoices i
				LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
				LEFT JOIN LATERAL (
					SELECT MIN(ii.billing_period_start) AS billing_period_start, MAX(ii.billing_period_end) AS billing_period_end,
						COUNT(*) AS lines_count
					FROM invoice_items ii WHERE ii.invoice_id = i.id
				) lines ON true
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST, i.id
				LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
				params
			),
			this.dataSource.query<Row[]>(
				`SELECT COUNT(*) AS all_count,
					COUNT(*) FILTER (WHERE ${statusSql.pending}) AS pending_count,
					COUNT(*) FILTER (WHERE ${statusSql.issued}) AS issued_count,
					COUNT(*) FILTER (WHERE ${statusSql.cancelled}) AS cancelled_count
				FROM invoices i ${base}`,
				params
			),
		]);
		const counts = {
			all: toNumber(countRow?.all_count),
			pending: toNumber(countRow?.pending_count),
			issued: toNumber(countRow?.issued_count),
			cancelled: toNumber(countRow?.cancelled_count),
		};
		const total = counts[status];

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				invoice_number: toText(row.invoice_number),
				status: toText(row.status),
				document_type: toText(row.document_type),
				invoice_type: toText(row.invoice_type),
				issue_date: toText(row.issue_date),
				due_date: toText(row.due_date),
				billing_period_start: toText(row.billing_period_start),
				billing_period_end: toText(row.billing_period_end),
				contract_currency: toText(row.contract_currency),
				invoice_currency: toText(row.invoice_currency),
				amount_contract_currency: toNullableNumber(row.amount_contract_currency),
				amount_invoice_currency: toNullableNumber(row.amount_invoice_currency),
				vat: toNullableNumber(row.vat),
				total_invoice_currency: toNullableNumber(row.total_invoice_currency),
				total_system_currency: toNullableNumber(row.total_system_currency),
				fx_contract_to_invoice: toNullableNumber(row.fx_contract_to_invoice),
				is_active: row.is_active !== false,
				odoo_invoice_id: toNullableNumber(row.odoo_invoice_id),
				sent_to_odoo_at: row.sent_to_odoo_at instanceof Date ? row.sent_to_odoo_at.toISOString() : toText(row.sent_to_odoo_at),
				lines_count: toNumber(row.lines_count),
				legal_name: toText(row.legal_name),
				related_invoice_id: toText(row.related_invoice_id),
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
		};
	}

	// ---------------------------------------------------------------- historial

	/**
	 * Tipo de evento normalizado: mayúsculas, sin sufijos de estado (`_APPLIED`, `_CREATED`…) y con alias
	 * (`cross_sell` → `CROSS_SELL`, `SIGNED` → `ACTIVATION`). Si el tipo es genérico (`AMENDMENT`) y el subtipo es
	 * uno conocido, manda el subtipo. Tipos vistos en QA (25-09): INVOICE_UNIFICATION, INVOICE_UNCONSOLIDATION,
	 * INVOICE_ADJUSTED_POST_ISSUE, INVOICE_CANCELLED, INVOICE_EMITTED_MANUALLY, NON_RENEWAL, DOWNSELL, UPSELL_APPLIED.
	 */
	static normalizeEventType(type: unknown, subtype?: unknown): string {
		const clean = (value: unknown) =>
			String(value ?? '')
				.trim()
				.toUpperCase()
				.replace(/[\s-]+/g, '_')
				.replace(/_(APPLIED|CREATED|COMPLETED|APPROVED|EXECUTED|PROCESSED|DONE)$/, '');
		const alias: Record<string, string> = {
			CROSSSELL: 'CROSS_SELL',
			UPSELLING: 'UPSELL',
			UP_SELL: 'UPSELL',
			DOWNSELLING: 'DOWNSELL',
			DOWN_SELL: 'DOWNSELL',
			CONTRACTION: 'DOWNSELL',
			CHURNED: 'CHURN',
			CANCELLATION: 'CHURN',
			RENEW: 'RENEWAL',
			RENEWED: 'RENEWAL',
			AUTO_RENEWAL: 'RENEWAL',
			SIGNED: 'ACTIVATION',
			ACTIVATED: 'ACTIVATION',
			ACTIVATE: 'ACTIVATION',
			REACTIVATED: 'REACTIVATION',
			RENEGOTIATE: 'RENEGOTIATION',
			EXPIRED: 'EXPIRATION',
			AUTO_EXPIRE: 'EXPIRATION',
			// Contracción al fin del período (no renovar un ítem o el contrato): es un churn.
			NON_RENEWAL: 'CHURN',
		};
		const known = new Set(['UPSELL', 'CROSS_SELL', 'DOWNSELL', 'RENEGOTIATION', 'CHURN', 'RENEWAL', 'REACTIVATION', 'CORRECTION', 'ACTIVATION']);
		const main = alias[clean(type)] ?? clean(type);
		const sub = alias[clean(subtype)] ?? clean(subtype);

		// Solo un tipo genérico cede al subtipo: `INVOICE_CANCELLED/downsell` sigue siendo una factura cancelada.
		if (GENERIC_EVENT_TYPES.has(main) && known.has(sub)) return sub;

		return main || 'OTHER';
	}

	async history(idOrNumber: string, holdingId: string) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const [events, amendments] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT e.id, e.event_type, e.event_subtype, e.title, COALESCE(e.description, e.summary) AS description,
					e.effective_date::text AS effective_date, e.amount_delta, e.items_affected, e.created_at,
					u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM contract_lifecycle_events e
				LEFT JOIN users u ON u.id = e.created_by
				WHERE e.contract_id = $1 AND e.holding_id = $2`,
				[contract.id, holdingId]
			),
			// Modificaciones sin evento propio (los eventos que las registran guardan `metadata.amendment_id`).
			this.dataSource.query<Row[]>(
				`SELECT a.id, a.type, a.reason, a.status, a.effective_date::text AS effective_date, a.created_at,
					u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM contract_amendments a
				LEFT JOIN users u ON u.id = a.requested_by
				WHERE a.contract_id = $1 AND a.holding_id = $2
					AND NOT EXISTS (
						SELECT 1 FROM contract_lifecycle_events e
						WHERE e.contract_id = a.contract_id AND e.metadata->>'amendment_id' = a.id::text
					)`,
				[contract.id, holdingId]
			),
		]);
		const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
		const user = (row: Row) => (row.user_id ? { id: row.user_id as string, name: toText(row.user_name) } : null);

		const data = [
			...events.map((row) => ({
				id: row.id as string,
				type: ContractsService.normalizeEventType(row.event_type, row.event_subtype),
				subtype: toText(row.event_subtype),
				title: toText(row.title),
				description: toText(row.description),
				effective_date: toText(row.effective_date),
				amount_delta: toNullableNumber(row.amount_delta),
				items_affected: (row.items_affected as unknown) ?? null,
				created_at: iso(row.created_at),
				created_by: user(row),
			})),
			...amendments.map((row) => {
				const type = ContractsService.normalizeEventType(row.type);

				return {
					id: row.id as string,
					type,
					subtype: toText(row.status),
					title: `Modificación del contrato (${String(row.type ?? '').toLowerCase() || 'sin tipo'})`,
					description: toText(row.reason),
					effective_date: toText(row.effective_date),
					amount_delta: null,
					items_affected: null,
					created_at: iso(row.created_at),
					created_by: user(row),
				};
			}),
		].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));

		return { data };
	}

	// ---------------------------------------------------------------- devengo (RSM)

	/** Resumen mensual del devengo del contrato. El MRR excluye el pendiente de renovar (S5-3). */
	async revenue(idOrNumber: string, holdingId: string) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const rows = await this.dataSource.query<Row[]>(
			`SELECT r.period_month::text AS period_month,
				COALESCE(SUM(r.recognized_period_contract_ccy), 0) AS recognized,
				COALESCE(SUM(r.billed_period_contract_ccy), 0) AS billed,
				COALESCE(SUM(r.mrr_period_contract_ccy) FILTER (WHERE ${NOT_PENDING_RENEWAL}), 0) AS mrr,
				COALESCE(SUM(r.deferred_balance_eom_contract_ccy), 0) AS deferred_eom,
				COALESCE(SUM(r.unbilled_balance_eom_contract_ccy), 0) AS unbilled_eom,
				COALESCE(SUM(r.recognized_period_system_ccy), 0) AS recognized_system,
				COALESCE(SUM(r.mrr_period_system_ccy) FILTER (WHERE ${NOT_PENDING_RENEWAL}), 0) AS mrr_system,
				MAX(r.system_currency) AS system_currency
			FROM revenue_schedule_monthly r
			WHERE r.contract_id = $1 AND r.holding_id = $2 AND r.is_total_row = false
			GROUP BY r.period_month
			ORDER BY r.period_month`,
			[contract.id, holdingId]
		);
		const systemCurrency = contract.system_currency ?? toText(rows[0]?.system_currency) ?? (await this.holdingMetrics.systemCurrency(holdingId));

		return {
			currency_contract: contract.contract_currency,
			currency_system: systemCurrency,
			months: rows.map((row) => ({
				period_month: String(row.period_month).slice(0, 10),
				recognized: toNumber(row.recognized),
				billed: toNumber(row.billed),
				mrr: toNumber(row.mrr),
				deferred_eom: toNumber(row.deferred_eom),
				unbilled_eom: toNumber(row.unbilled_eom),
				recognized_system: toNumber(row.recognized_system),
				mrr_system: toNumber(row.mrr_system),
			})),
		};
	}
}
