import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import {
	isVisibleLine,
	noChargeSql,
	partialBillingEventSql,
	partialBillingOf,
	relatedDocumentsOf,
	relatedDocumentsSql,
	voidedSql,
} from './contract-360';
import { buildItemGroups, deriveItemStatus, type ItemGroup, type PendingInvoiceLine, type PricedContractItem } from './contract-items';
import { CONTRACT_DERIVED_STATUSES, type ContractDerivedStatus, derivedStatusLateral } from './contract-status';
import { isUnifiedType, UNIFIED_READ_SQL, type UnifiedReadFields, unifiedReadFields } from './invoice-consolidation-read';
import { referenceKind } from './invoice-description';
import { oneOffOf, type OneOffSubline } from './one-off-discount';
import { PRICE_COLUMNS, priceSummaryFromRow } from './price-rows';
import { DESCRIPTION_LIMITS_SQL, type DescriptionLimitRow, documentTypeLabel, resolveDescriptionMaxChars } from './tax-document-types';

import type { ContractInvoiceSortField, ContractInvoiceStatusFilter } from './dtos/query-contract-invoices.dto';
import type { ContractSortField } from './dtos/query-contracts.dto';
import type { PricedSubline } from './pricing-engine';

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Emitidas (cuentan como facturadas al cliente). */
/** Tipos de evento genéricos que dejan mandar al subtipo cuando este es un tipo conocido. */
const GENERIC_EVENT_TYPES = new Set(['', 'AMENDMENT', 'MODIFICATION', 'CONTRACT_CHANGE', 'LIFECYCLE', 'CHANGE', 'OTHER']);
export const ISSUED_INVOICE_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'];
/** Política FX derivada de una fila de `invoices`: same_currency | spot (conversión sin tasa) | fixed (tasa en `fx_contract_to_invoice`). */
export const fxPolicyOf = (row: { contract_currency?: unknown; invoice_currency?: unknown; fx_contract_to_invoice?: unknown }) => {
	const contract = String(row.contract_currency ?? '').toUpperCase();
	const invoice = String(row.invoice_currency ?? '').toUpperCase();

	if (!contract || !invoice || contract === invoice) return 'same_currency' as const;

	return row.fx_contract_to_invoice === null || row.fx_contract_to_invoice === undefined ? ('spot' as const) : ('fixed' as const);
};

/**
 * Estado de la factura frente al ERP (derivado): `none` sin vínculo; `draft` Por Emitir con borrador (o marca de envío) en el ERP — se
 * puede restablecer; `sent` emitida con vínculo. Una factura restablecida (`erp-reset`) queda sin vínculo → `none`.
 */
export const erpSyncStateOf = (row: { status?: unknown; odoo_invoice_id?: unknown; sent_to_odoo_at?: unknown }) => {
	const linked =
		(row.odoo_invoice_id !== null && row.odoo_invoice_id !== undefined) || (row.sent_to_odoo_at !== null && row.sent_to_odoo_at !== undefined);

	if (!linked) return 'none' as const;

	return row.status === 'Por Emitir' ? ('draft' as const) : ('sent' as const);
};

/** Tipos de `invoice_adjustments` que son un motivo de desvío contra el plan (el resto, p. ej. `reagenda`, no). */
const DEVIATION_ADJUSTMENT_TYPES = `('discount', 'upsell', 'downsell', 'correction')`;

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
const NOT_DELETED = `c.deleted_at IS NULL`;

/**
 * Inicio y fin del servicio del contrato (lateral `cd`): primer inicio y último fin de sus ítems, sin los dados de baja
 * (`churn_date`) ni los ajustes de baja (`CHURN`, `DOWNSELL`). El fin cae a `contract_end_date` si no queda ningún ítem.
 */
export const CONTRACT_DATES_LATERAL = `LEFT JOIN LATERAL (
	SELECT MIN(ci.start_date) AS start_date, MAX(ci.end_date) AS end_date
	FROM contract_items ci
	WHERE ci.contract_id = c.id AND ci.churn_date IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')
) cd ON true`;

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
/** Agrupa las líneas internas (facturar por OC) bajo su línea visible: `internal_lines[]` en cada línea (vacío si no tiene). */
export function withInternalLines<T extends { id: string; visible_line_id: string | null }>(views: T[]): Array<T & { internal_lines: T[] }> {
	return views.map((view) => ({ ...view, internal_lines: views.filter((entry) => entry.visible_line_id === view.id) }));
}

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
			WHERE ${where} AND c.holding_id = $2 AND c.deleted_at IS NULL
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
					co.odoo_integration_id AS company_odoo_integration_id,
					c.contract_currency, c.invoice_currency, c.system_currency, c.company_currency, c.fx_invoice_policy, c.fx_company_policy,
					c.total_value, c.total_value_system_currency, c.booking_date::text AS booking_date,
					cd.start_date::text AS start_date, COALESCE(cd.end_date, c.contract_end_date)::text AS end_date,
					nx.next_item_end_date::text AS next_item_end_date, c.term, c.churn_date::text AS churn_date,
					COALESCE(cr.name, c.churn_reason) AS churn_reason,
					c.billing_anchor_day, c.payment_terms, c.document_type, c.requires_multicompany_billing, c.requires_multicurrency_billing,
					c.tax_document_type_id, tdt.code AS tax_document_type_code, tdt.name AS tax_document_type_name, tdt.kind AS tax_document_type_kind,
					tdt.country_code AS tax_document_type_country,
					c.auto_send_to_odoo, c.auto_invoice, c.group_invoices_by_period, c.invoice_terms_and_conditions, c.notes,
					q.id AS quote_id, q.quote_number, c.salesforce_opportunity_id, c.created_at,
					rsm.mrr_system, rsm.mrr_contract, ds.derived_status,
					-- Multimoneda: tasas pactadas ítem → contrato (MRR, TCV y devengo de los ítems en otra moneda).
					(SELECT COALESCE(jsonb_agg(jsonb_build_object('from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
						'period_start', r.period_start::text, 'period_end', r.period_end::text) ORDER BY r.from_currency, r.period_start), '[]'::jsonb)
						FROM contract_fx_period_rates r WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'item') AS fx_item_rates
				FROM contracts c
				LEFT JOIN clients cl ON cl.id = c.client_id
				LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
				LEFT JOIN companies co ON co.id = c.company_id
				LEFT JOIN churn_reasons cr ON cr.id = c.churn_reason_id
				LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
				LEFT JOIN quotes q ON q.id = c.quote_id
				${CONTRACT_DATES_LATERAL}
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
						/** La compañía puede enviar facturas al ERP (mismo criterio del scheduler y del alta: `odoo_integration_id` asignado). */
						erp_integration_enabled: row.company_odoo_integration_id !== null && row.company_odoo_integration_id !== undefined,
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
			/** Día de ciclo de facturación (1–31). */
			billing_anchor_day: toNullableNumber(row.billing_anchor_day),
			/** Condición de pago propia (misma forma que `client_entities.payment_terms`); `null` = sin condición propia. */
			payment_terms: (row.payment_terms as Record<string, unknown> | null | undefined) ?? null,
			/** Familia del documento que emite el contrato (`FACTURA`, `FACTURA_EXPORTACION`). */
			document_type: toText(row.document_type),
			/** Nombre para mostrar: el del documento tributario del catálogo o, sin él, el de la familia. */
			document_type_label: toText(row.tax_document_type_name) || documentTypeLabel(toText(row.document_type)),
			/** Documento tributario del catálogo (`tax_document_types`); null en contratos anteriores al catálogo. */
			tax_document_type: row.tax_document_type_id
				? {
						id: String(row.tax_document_type_id),
						code: toText(row.tax_document_type_code),
						name: toText(row.tax_document_type_name),
						kind: toText(row.tax_document_type_kind),
						country_code: toText(row.tax_document_type_country),
					}
				: null,
			/** Banderas: factura a más de una razón social / en más de una moneda (mismas que la lista). */
			requires_multicompany_billing: row.requires_multicompany_billing === true,
			requires_multicurrency_billing: row.requires_multicurrency_billing === true,
			/** Multimoneda: tasas fijas pactadas ítem → contrato (`purpose = 'item'`, "1 [from] = rate [moneda del contrato]"). Vacío sin multimoneda. */
			fx_item_rates: ContractsService.fxItemRatesOf(row.fx_item_rates),
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
				(SELECT COALESCE(SUM(ROUND(ci.final_price * COALESCE(public.contract_item_fx_rate(c.id, ci.currency, c.contract_currency,
					COALESCE(ci.start_date, CURRENT_DATE), COALESCE(ci.end_date, ci.start_date, CURRENT_DATE)), 0), 2)), 0)
					FROM contract_items ci WHERE ci.contract_id = c.id) AS items_total,
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

	async items(idOrNumber: string, holdingId: string, asOfDate = new Date()): Promise<{ items: PricedContractItem[]; groups: ItemGroup[] }> {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const today = isoDate(asOfDate);
		const [rows, lines] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT ci.id, ci.product_id, ci.product_name, ci.account, ci.item_type, ci.categoria, ci.unit_of_measure,
					ci.quantity, ci.unit_price, ci.price_entry_mode, ci.annual_unit_price, ci.discount_type, ci.discount_value,
					ci.monthly_price, ci.billing_period_price, ci.final_price, ci.term_months, ci.billing_frequency, ci.billing_method,
					ci.is_recurring, ci.start_date::text AS start_date, ci.end_date::text AS end_date,
					ci.booking_date::text AS booking_date, ci.churn_date::text AS churn_date,
					ci.related_item_id, ci.renews_item_id, ci.renewed_by_item_id, ci.auto_renew, ci.currency, ${PRICE_COLUMNS},
					bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name, bm.unit AS metric_unit, bm.aggregation AS metric_aggregation,
					lp.id AS catalog_price_id, lp.name AS catalog_price_name, lp.version AS catalog_price_version
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				LEFT JOIN prices p ON p.id = ci.price_id
				LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id
				LEFT JOIN prices lp ON lp.id = p.list_price_id
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

		const items: PricedContractItem[] = rows.map((row) => {
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
			const price = priceSummaryFromRow(row);

			return {
				...item,
				status: deriveItemStatus(item, today),
				price,
				metric: row.metric_id
					? {
							id: String(row.metric_id),
							code: toText(row.metric_code) ?? '',
							name: toText(row.metric_name) ?? '',
							unit: toText(row.metric_unit) ?? '',
							aggregation: toText(row.metric_aggregation) ?? '',
						}
					: null,
				catalog_price: row.catalog_price_id
					? { id: String(row.catalog_price_id), name: toText(row.catalog_price_name), version: Number(row.catalog_price_version ?? 1) || 1 }
					: null,
				uses_price_model: price !== null,
			};
		});
		const pendingLines: PendingInvoiceLine[] = lines.map((line) => ({
			invoice_id: line.invoice_id as string,
			issue_date: toText(line.issue_date),
			contract_item_id: line.contract_item_id as string,
			subtotal: toNumber(line.subtotal),
		}));

		return { items, groups: buildItemGroups(items, today, pendingLines, (item) => item) };
	}

	// ---------------------------------------------------------------- facturas

	async invoices(idOrNumber: string, holdingId: string, filters: ContractInvoiceFilters) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const { page = 1, limit = 50, status = 'all', sortBy = 'billing_period_start', sortOrder = 'asc' } = filters;
		const params: unknown[] = [contract.id, holdingId];
		const base = `WHERE i.contract_id = $1 AND i.holding_id = $2`;
		const statusSql = {
			pending: `i.is_active = true AND i.status = 'Por Emitir'`,
			// Literal (no `$n`): un parámetro que la consulta no usa rompe el tipado de Postgres.
			issued: `i.is_active = true AND i.status IN (${ISSUED_INVOICE_STATUSES.map((value) => `'${value}'`).join(', ')})`,
			cancelled: `(i.status = 'Cancelada' OR i.is_active = false)`,
		};
		const statusFilter = status === 'all' ? '' : `AND ${statusSql[status]}`;
		// Lista blanca: el campo de orden nunca viene del usuario tal cual. Por período (defecto) desempata por emisión.
		const orderColumn =
			{
				billing_period_start: 'lines.billing_period_start',
				issue_date: 'i.issue_date',
				amount: 'i.amount_contract_currency',
				status: 'i.status',
			}[sortBy] ?? 'lines.billing_period_start';
		const direction = sortOrder === 'desc' ? 'DESC' : 'ASC';
		const tieBreak = orderColumn === 'i.issue_date' ? '' : `, i.issue_date ${direction} NULLS LAST`;
		const offset = (page - 1) * limit;

		const [rows, [countRow]] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT i.id, i.invoice_number, i.status, i.document_type, i.invoice_type,
					i.issue_date::text AS issue_date, i.due_date::text AS due_date,
					lines.billing_period_start::text AS billing_period_start, lines.billing_period_end::text AS billing_period_end,
					i.contract_currency, i.invoice_currency, i.amount_contract_currency, i.amount_invoice_currency, i.vat,
					i.total_invoice_currency, i.total_system_currency, i.fx_contract_to_invoice, i.is_active,
					i.odoo_invoice_id, i.sent_to_odoo_at, COALESCE(lines.lines_count, 0) AS lines_count,
					ce.legal_name, i.related_invoice_id, i.original_issue_date::text AS original_issue_date,
					EXISTS (SELECT 1 FROM contract_lifecycle_events e WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id
						AND e.event_type = 'INVOICE_ISSUED_EXTERNALLY' AND e.metadata->>'invoice_id' = i.id::text) AS issued_externally,
					EXISTS (SELECT 1 FROM invoice_items mi WHERE mi.invoice_id = i.id AND mi.quantity_source = 'manual') AS has_manual_lines,
					${noChargeSql('i')} AS no_charge, i.document_type AS doc_type,
					${voidedSql('i')} AS voided, ${relatedDocumentsSql('i')} AS related_documents, ${partialBillingEventSql('i')} AS partial_billing_event,
					i.split_reason, i.split_from_invoice_id,
					adj.id AS deviation_id, adj.type AS deviation_type, adj.amount_diff AS deviation_amount_diff, adj.notes AS deviation_reason,
					adj.adjusted_at AS deviation_adjusted_at, adj.adjusted_by_name AS deviation_adjusted_by_name
				FROM invoices i
				LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
				LEFT JOIN LATERAL (
					SELECT a.id, a.type, a.amount_diff, a.notes, a.adjusted_at, COALESCE(u.name, u.email) AS adjusted_by_name
					FROM invoice_adjustments a LEFT JOIN users u ON u.id = a.adjusted_by
					WHERE a.invoice_id = i.id AND a.type IN ${DEVIATION_ADJUSTMENT_TYPES}
					ORDER BY a.adjusted_at DESC, a.created_at DESC FETCH FIRST 1 ROW ONLY
				) adj ON true
				LEFT JOIN LATERAL (
					SELECT MIN(ii.billing_period_start) AS billing_period_start, MAX(ii.billing_period_end) AS billing_period_end,
						COUNT(*) AS lines_count
					FROM invoice_items ii WHERE ii.invoice_id = i.id
				) lines ON true
				${base} ${statusFilter}
				ORDER BY ${orderColumn} ${direction} NULLS LAST${tieBreak}, i.id
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
		// Documentos unificados de la página (spec multimoneda §9): v2 (evento INVOICE_CONSOLIDATED) o legacy de solo lectura, y aporte por
		// contrato; una sola consulta y solo si la página trae alguno.
		const unified = await this.unifiedFields(
			rows.filter((row) => isUnifiedType(toText(row.invoice_type))).map((row) => String(row.id)),
			holdingId
		);

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
				// Derivados (nada nuevo en la tabla): política por moneda + `fx_contract_to_invoice`; emisión externa por evento.
				fx_policy: fxPolicyOf(row),
				fx_rate: toNullableNumber(row.fx_contract_to_invoice),
				issued_externally: row.issued_externally === true,
				original_issue_date: toText(row.original_issue_date),
				// Etapa 4 (spec facturas §3.4): motivo del desvío (último `invoice_adjustments`), líneas editadas a mano, sin cobro y ERP.
				deviation: ContractsService.deviationOf(row),
				has_manual_lines: row.has_manual_lines === true,
				no_charge: row.no_charge === true,
				erp_sync_state: erpSyncStateOf(row),
				erp_reset_available: ContractsService.erpResetAvailable(row),
				// Etapa 6 (spec facturas §3.7b–3.8): anulada con NC (derivado), documentos vinculados (NC y reemisión, ambos sentidos), facturación
				// por OC (cubierta o saldo, desde su evento) y motivo de división (`reissue`, `partial_by_po`, `reorganize`).
				voided: row.voided === true,
				related_documents: relatedDocumentsOf(row.related_documents),
				partial_billing: partialBillingOf(String(row.id), row.partial_billing_event),
				split_reason: toText(row.split_reason),
				split_from_invoice_id: toText(row.split_from_invoice_id),
				...(unified.get(String(row.id)) ?? {}),
			})),
			items: total,
			pages: Math.max(1, Math.ceil(total / limit)),
			currentPage: page,
			limit,
			counts,
		};
	}

	/**
	 * Una factura del contrato, de solo lectura: encabezado (fechas programada y real, monedas, tipo de cambio, IVA, ERP,
	 * referencias exigidas), sus líneas con `pricing_breakdown` y `quantity_source`, las referencias (OC/HES: propias de la
	 * factura y las del contrato vinculadas), los ajustes posteriores a la emisión y los documentos relacionados (nota de
	 * crédito, original, consolidada, dividida). 404 si la factura no es del contrato o el contrato no es del holding.
	 */
	async invoiceDetail(idOrNumber: string, invoiceId: string, holdingId: string) {
		const contract = await this.resolveContract(idOrNumber, holdingId);
		const [[header], lines, references, adjustments, related, history] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT i.id, i.invoice_number, i.status, i.document_type, i.invoice_type, i.credit_type,
					i.issue_date::text AS issue_date, i.original_issue_date::text AS original_issue_date, i.scheduled_at::text AS scheduled_at,
					i.due_date::text AS due_date, i.created_at,
					lines.billing_period_start::text AS billing_period_start, lines.billing_period_end::text AS billing_period_end,
					i.contract_currency, i.invoice_currency, i.system_currency, i.amount_contract_currency, i.amount_invoice_currency, i.vat,
					i.total_invoice_currency, i.total_system_currency, i.fx_contract_to_invoice, i.tax_rate, i.payment_method, i.is_active,
					i.odoo_invoice_id, i.sent_to_odoo_at, i.sent_at, i.notes, i.pdf_url, i.invoice_terms_and_conditions,
					i.requires_references_for_billing, i.related_invoice_id, i.consolidated_into_invoice_id, i.split_from_invoice_id, i.split_reason,
					-- Proforma / documento: emisor y receptor como los guarda la factura, con la compañía y la razón social como respaldo.
					COALESCE(i.issuer_legal_name, co.legal_name) AS issuer_legal_name, COALESCE(i.issuer_tax_id, co.tax_id) AS issuer_tax_id,
					COALESCE(i.issuer_address, co.legal_address) AS issuer_address, i.fiscal_regime, i.export_type,
					ce.country AS client_country, ce.legal_address AS client_address, c.contract_number,
					(SELECT t.name FROM tax_document_types t WHERE t.id = c.tax_document_type_id) AS tax_document_type_name,
					lines.fx_rate_source,
					(SELECT MAX(e.created_at) FROM contract_lifecycle_events e WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id
						AND e.event_type = 'INVOICE_FX_CHANGED' AND e.metadata->>'invoice_id' = i.id::text) AS fx_confirmed_at,
					EXISTS (SELECT 1 FROM contract_lifecycle_events e WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id
						AND e.event_type = 'INVOICE_ISSUED_EXTERNALLY' AND e.metadata->>'invoice_id' = i.id::text) AS issued_externally,
					COALESCE(lines.lines_count, 0) AS lines_count, ce.legal_name, COALESCE(ce.tax_id, i.client_tax_id) AS client_tax_id,
					${noChargeSql('i')} AS no_charge, i.nc_revenue_treatment, i.client_entity_id, i.auto_invoice, i.credit_reason,
					${voidedSql('i')} AS voided, ${partialBillingEventSql('i')} AS partial_billing_event,
					c.tax_document_type_id, tdt.description_max_chars AS own_description_max_chars, co.country AS company_country,
					c.document_type AS contract_document_type, ${DESCRIPTION_LIMITS_SQL} AS description_limits,
					COALESCE(c.requires_multicurrency_billing, false) AS requires_multicurrency_billing,
					(SELECT COALESCE(jsonb_agg(jsonb_build_object('from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
						'period_start', r.period_start::text, 'period_end', r.period_end::text) ORDER BY r.from_currency, r.period_start), '[]'::jsonb)
						FROM contract_fx_period_rates r WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'item') AS fx_item_rates
				FROM invoices i
				LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
				LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
				LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
				LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
				LEFT JOIN LATERAL (
					SELECT MIN(ii.billing_period_start) AS billing_period_start, MAX(ii.billing_period_end) AS billing_period_end, COUNT(*) AS lines_count,
						mode() WITHIN GROUP (ORDER BY ii.fx_rate_source) FILTER (WHERE ii.fx_rate_source IS NOT NULL) AS fx_rate_source
					FROM invoice_items ii WHERE ii.invoice_id = i.id
				) lines ON true
				WHERE i.id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3`,
				[invoiceId, contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ii.id, ii.description, ii.description_locked, ii.quantity, ii.unit_of_measure, ii.quantity_source, ii.discount_pct,
					ii.unit_price_contract_currency, ii.unit_price_invoice_currency, ii.subtotal_contract_currency, ii.subtotal_invoice_currency,
					ii.tax_amount_contract_currency, ii.tax_amount_invoice_currency, ii.total_contract_currency, ii.total_invoice_currency,
					ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end,
					ii.contract_item_id, ii.product_id, ii.pricing_breakdown, ci.product_name, ci.account, ii.visible_line_id,
					ii.contract_currency AS line_currency, ii.fx_contract_to_invoice AS line_fx, ii.fx_rate_source AS line_fx_rate_source
				FROM invoice_items ii
				JOIN invoices i ON i.id = ii.invoice_id
				LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
				WHERE ii.invoice_id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3
				-- Las filas de un mismo ítem van juntas y, si el precio factura una fila por tramo, en el orden de sus tramos.
				ORDER BY ii.billing_period_start NULLS LAST, ci.product_name NULLS LAST, ci.account NULLS FIRST, ii.contract_item_id,
					CASE WHEN jsonb_typeof(ii.pricing_breakdown) = 'array' THEN (ii.pricing_breakdown->0->>'line_index')::int END NULLS FIRST,
					ii.created_at, ii.id`,
				[invoiceId, contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT r.id, r.document_type_code AS type, r.document_type_name AS name, r.document_number AS code,
					r.reference_date::text AS date, 'invoice' AS source
				FROM invoice_references r
				JOIN invoices i ON i.id = r.invoice_id
				WHERE r.invoice_id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3
				UNION ALL
				SELECT br.id, br.reference_type::text AS type, NULL AS name, br.reference_code AS code, br.issue_date::text AS date, 'contract' AS source
				FROM invoice_reference_links rl
				JOIN billing_references br ON br.id = rl.reference_id
				JOIN invoices i ON i.id = rl.invoice_id
				WHERE rl.invoice_id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3`,
				[invoiceId, contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT a.id, a.type, a.amount_diff, a.notes, a.adjusted_at, u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM invoice_adjustments a
				JOIN invoices i ON i.id = a.invoice_id
				LEFT JOIN users u ON u.id = a.adjusted_by
				WHERE a.invoice_id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3
				ORDER BY a.adjusted_at DESC, a.created_at DESC`,
				[invoiceId, contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT o.id, o.invoice_number, o.document_type, o.credit_type, o.status, o.issue_date::text AS issue_date,
					COALESCE(o.total_invoice_currency, o.amount_contract_currency) AS total,
					CASE
						WHEN o.related_invoice_id = $1::uuid AND o.document_type = 'NC' THEN 'credit_note'
						WHEN o.related_invoice_id = $1::uuid THEN 'reissue'
						WHEN o.id = i.related_invoice_id THEN 'original'
						WHEN o.id = i.consolidated_into_invoice_id THEN 'consolidated_into'
						WHEN o.id = i.split_from_invoice_id THEN 'split_from'
					END AS relation
				FROM invoices i
				JOIN invoices o ON o.holding_id = i.holding_id AND o.id <> i.id
					AND (o.related_invoice_id = i.id OR o.id = i.related_invoice_id OR o.id = i.consolidated_into_invoice_id OR o.id = i.split_from_invoice_id)
				WHERE i.id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3
				ORDER BY o.issue_date NULLS LAST, o.created_at`,
				[invoiceId, contract.id, holdingId]
			),
			// Historial de la factura: eventos del contrato que la nombran (`metadata.invoice_id`, operaciones del 360) o la incluyen
			// (`metadata.invoice_ids`, `created_invoices`, `invoices_updated`, `invoices_cancelled`, `created_credit_notes` de modificaciones/consumo)
			// o la referencian como NC, anulada o complementada (`credit_note_id`, `cancelled_invoice_id`, `complements_invoice_id` del consumo).
			this.dataSource.query<Row[]>(
				`SELECT e.id, e.event_type, e.event_subtype, e.title, COALESCE(e.description, e.summary) AS description,
					e.effective_date::text AS effective_date, e.created_at, e.metadata, u.id AS user_id, COALESCE(u.name, u.email) AS user_name
				FROM invoices i
				JOIN contract_lifecycle_events e ON e.contract_id = i.contract_id AND e.holding_id = i.holding_id
				LEFT JOIN users u ON u.id = e.created_by
				WHERE i.id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3
					AND (e.metadata->>'invoice_id' = i.id::text
						OR e.metadata->'invoice_ids' ? i.id::text
						OR e.metadata->'created_invoices' ? i.id::text
						OR e.metadata->'invoices_updated' ? i.id::text
						OR e.metadata->'invoices_cancelled' ? i.id::text
						OR e.metadata->'created_credit_notes' ? i.id::text
						OR e.metadata->>'credit_note_id' = i.id::text
						OR e.metadata->>'cancelled_invoice_id' = i.id::text
						OR e.metadata->>'complements_invoice_id' = i.id::text)
				ORDER BY e.created_at DESC`,
				[invoiceId, contract.id, holdingId]
			),
		]);

		if (!header) throw new NotFoundException('Factura no encontrada');
		const unified = await this.unifiedFields(isUnifiedType(toText(header.invoice_type)) ? [String(header.id)] : [], holdingId);
		const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
		const json = <T>(value: unknown): T | null => {
			if (value === null || value === undefined) return null;
			if (typeof value !== 'string') return value as T;
			try {
				return JSON.parse(value) as T;
			} catch {
				return null;
			}
		};

		return {
			id: header.id as string,
			invoice_number: toText(header.invoice_number),
			status: toText(header.status),
			document_type: toText(header.document_type),
			invoice_type: toText(header.invoice_type),
			credit_type: toText(header.credit_type),
			issue_date: toText(header.issue_date),
			original_issue_date: toText(header.original_issue_date),
			scheduled_at: toText(header.scheduled_at),
			due_date: toText(header.due_date),
			created_at: iso(header.created_at),
			billing_period_start: toText(header.billing_period_start),
			billing_period_end: toText(header.billing_period_end),
			contract_currency: toText(header.contract_currency),
			invoice_currency: toText(header.invoice_currency),
			system_currency: toText(header.system_currency),
			amount_contract_currency: toNullableNumber(header.amount_contract_currency),
			amount_invoice_currency: toNullableNumber(header.amount_invoice_currency),
			vat: toNullableNumber(header.vat),
			total_invoice_currency: toNullableNumber(header.total_invoice_currency),
			total_system_currency: toNullableNumber(header.total_system_currency),
			fx_contract_to_invoice: toNullableNumber(header.fx_contract_to_invoice),
			tax_rate: toNullableNumber(header.tax_rate),
			payment_method: toText(header.payment_method),
			is_active: header.is_active !== false,
			odoo_invoice_id: toNullableNumber(header.odoo_invoice_id),
			sent_to_odoo_at: iso(header.sent_to_odoo_at),
			sent_at: iso(header.sent_at),
			notes: toText(header.notes),
			pdf_url: toText(header.pdf_url),
			invoice_terms_and_conditions: toText(header.invoice_terms_and_conditions),
			requires_references_for_billing: header.requires_references_for_billing === true,
			related_invoice_id: toText(header.related_invoice_id),
			split_reason: toText(header.split_reason),
			split_from_invoice_id: toText(header.split_from_invoice_id),
			// Tipo de cambio por factura (spec facturas §3.2) y emisión externa (§3.1), todo DERIVADO de lo existente: política por moneda +
			// `fx_contract_to_invoice`; origen = `invoice_items.fx_rate_source` más frecuente; confirmación = último evento INVOICE_FX_CHANGED;
			// emisión externa = evento INVOICE_ISSUED_EXTERNALLY; `erp_sync_state`: draft = borrador en el ERP de una Por Emitir, sent = emitida
			// con vínculo al ERP, none = sin vínculo.
			fx_policy: fxPolicyOf(header),
			fx_rate: toNullableNumber(header.fx_contract_to_invoice),
			fx_rate_source: toText(header.fx_rate_source),
			fx_confirmed_at: iso(header.fx_confirmed_at),
			issued_externally: header.issued_externally === true,
			erp_sync_state: erpSyncStateOf(header),
			// "Restablecer borrador del ERP" disponible (Por Emitir activa vinculada al ERP, no NC/unificada).
			erp_reset_available: ContractsService.erpResetAvailable({ ...header, doc_type: header.document_type }),
			// Sin cobro: Cancelada porque todas sus líneas quedaron en 0 (evento INVOICE_NO_CHARGE); se reactiva al recuperar cantidad.
			no_charge: header.no_charge === true,
			// Devengo del descuento puntual de la factura (mismo campo que las NC de descuento).
			nc_revenue_treatment: toText(header.nc_revenue_treatment),
			// Receptor y emisión automática de la factura (el editor de la etapa 4 parte de estos valores).
			client_entity_id: toText(header.client_entity_id),
			auto_invoice: header.auto_invoice === null || header.auto_invoice === undefined ? null : Boolean(header.auto_invoice),
			has_manual_lines: lines.some((line) => line.quantity_source === 'manual'),
			deviation: ContractsService.deviationOf(
				(() => {
					const latest = adjustments.find((row) => ['discount', 'upsell', 'downsell', 'correction'].includes(String(row.type)));

					return latest
						? {
								deviation_id: latest.id,
								deviation_type: latest.type,
								deviation_amount_diff: latest.amount_diff,
								deviation_reason: latest.notes,
								deviation_adjusted_at: latest.adjusted_at,
								deviation_adjusted_by_name: latest.user_name,
							}
						: {};
				})()
			),
			lines_count: toNumber(header.lines_count),
			legal_name: toText(header.legal_name),
			client_tax_id: toText(header.client_tax_id),
			// Proforma / documento (front `ProformaDocument`): emisor, receptor, régimen, exportación, contrato y nombre del documento.
			issuer_legal_name: toText(header.issuer_legal_name),
			issuer_tax_id: toText(header.issuer_tax_id),
			issuer_address: toText(header.issuer_address),
			fiscal_regime: toText(header.fiscal_regime),
			export_type: toNullableNumber(header.export_type),
			client_country: toText(header.client_country),
			client_address: toText(header.client_address),
			contract_number: toText(header.contract_number),
			tax_document_type_name: toText(header.tax_document_type_name),
			// Multimoneda (spec-multimoneda §3): el contrato factura ítems en distintas monedas; cada línea trae su par (`currency` → moneda de
			// factura) y su tasa; el encabezado `fx_contract_to_invoice` es NULL con dos o más pares. Tasas pactadas ítem → contrato del contrato.
			requires_multicurrency_billing: header.requires_multicurrency_billing === true,
			fx_item_rates: ContractsService.fxItemRatesOf(header.fx_item_rates),
			// Constructor de descripción (spec facturas §3.6): límite de la glosa del documento del contrato (null = sin límite).
			description_max_chars: resolveDescriptionMaxChars({
				tax_document_type_id: toText(header.tax_document_type_id),
				own_max_chars: header.own_description_max_chars as number | null,
				company_country: toText(header.company_country),
				document_type: toText(header.contract_document_type),
				limits: json<DescriptionLimitRow[]>(header.description_limits),
			}),
			// Etapa 6 (§3.7b): cada línea visible de una factura por OC lleva sus internas en `internal_lines` (las internas siguen también en la
			// lista plana, con `visible_line_id`, para que Σ líneas = encabezado).
			lines: withInternalLines(
				lines.map((line) => ({
					id: line.id as string,
					description: toText(line.description),
					description_locked: line.description_locked === true,
					product_name: toText(line.product_name),
					account: toText(line.account),
					contract_item_id: toText(line.contract_item_id),
					product_id: toText(line.product_id),
					quantity: toNullableNumber(line.quantity),
					unit_of_measure: toText(line.unit_of_measure),
					quantity_source: toText(line.quantity_source),
					// Visible (derivado): cantidad ≠ 0 y no es línea interna de facturar por OC (`visible_line_id`). Las ocultas quedan en Sapira para
					// trazabilidad y devengo; no van al documento ni al ERP.
					is_visible: isVisibleLine(toNumber(line.quantity), toText(line.visible_line_id)),
					visible_line_id: toText(line.visible_line_id),
					// Descuento puntual de la línea (sublínea `one_off` del desglose), el que mueve el devengo con `nc_revenue_treatment`.
					one_off_discount: oneOffDiscountOf(json<PricedSubline[]>(line.pricing_breakdown)),
					discount_pct: toNullableNumber(line.discount_pct),
					unit_price_contract_currency: toNullableNumber(line.unit_price_contract_currency),
					unit_price_invoice_currency: toNullableNumber(line.unit_price_invoice_currency),
					subtotal_contract_currency: toNullableNumber(line.subtotal_contract_currency),
					subtotal_invoice_currency: toNullableNumber(line.subtotal_invoice_currency),
					tax_contract_currency: toNullableNumber(line.tax_amount_contract_currency),
					tax_invoice_currency: toNullableNumber(line.tax_amount_invoice_currency),
					total_contract_currency: toNullableNumber(line.total_contract_currency),
					total_invoice_currency: toNullableNumber(line.total_invoice_currency),
					billing_period_start: toText(line.billing_period_start),
					billing_period_end: toText(line.billing_period_end),
					pricing_breakdown: json<unknown[]>(line.pricing_breakdown),
					// Multimoneda: moneda de origen de la línea (la del ítem; sus `*_contract_currency` están en ella), tasa de su par → moneda de
					// factura (1 mismo par, null = spot) y su origen (`contract`, `manual`, `net_exact`, `spot`…).
					currency: toText(line.line_currency) ?? toText(header.contract_currency),
					fx: toNullableNumber(line.line_fx),
					fx_rate_source: toText(line.line_fx_rate_source),
				}))
			),
			references: references.map((row) => ({
				id: row.id as string,
				// OC | HES | nombre del documento (derivado del código SII guardado: 801 = OC).
				kind: referenceKind(toText(row.type), toText(row.name)),
				type: toText(row.type),
				name: toText(row.name),
				code: toText(row.code),
				date: toText(row.date),
				source: (row.source === 'contract' ? 'contract' : 'invoice') as 'contract' | 'invoice',
			})),
			adjustments: adjustments.map((row) => ({
				id: row.id as string,
				type: toText(row.type),
				amount_diff: toNullableNumber(row.amount_diff),
				notes: toText(row.notes),
				adjusted_at: iso(row.adjusted_at),
				adjusted_by: row.user_id ? { id: row.user_id as string, name: toText(row.user_name) } : null,
			})),
			related_documents: related.map((row) => ({
				id: row.id as string,
				invoice_number: toText(row.invoice_number),
				document_type: toText(row.document_type),
				credit_type: toText(row.credit_type),
				status: toText(row.status),
				issue_date: toText(row.issue_date),
				total: toNullableNumber(row.total),
				relation: toText(row.relation),
			})),
			// Etapa 6 (§3.8): anulada con NC (derivado de la NC de anulación vinculada) y facturación por OC (§3.7b, desde su evento).
			voided: header.voided === true,
			credit_reason: toText(header.credit_reason),
			partial_billing: partialBillingOf(String(header.id), header.partial_billing_event),
			history: history.map((row) => ({
				id: row.id as string,
				type: ContractsService.normalizeEventType(row.event_type, row.event_subtype),
				subtype: toText(row.event_subtype),
				title: toText(row.title),
				description: toText(row.description),
				effective_date: toText(row.effective_date),
				created_at: iso(row.created_at),
				created_by: row.user_id ? { id: row.user_id as string, name: toText(row.user_name) } : null,
				metadata: json<Record<string, unknown>>(row.metadata),
			})),
			// Documento unificado (spec multimoneda §9): `legacy_unified` (sin evento INVOICE_CONSOLIDATED: solo lectura) y aporte por contrato.
			...(unified.get(String(header.id)) ?? {}),
		};
	}

	/**
	 * `legacy_unified` y `contributions[]` de los documentos `Unificada`/`Consolidada` dados (spec multimoneda §7/§9), en una sola consulta.
	 * Sin ids no consulta (las demás facturas no cambian su respuesta).
	 */
	private async unifiedFields(invoiceIds: string[], holdingId: string): Promise<Map<string, UnifiedReadFields>> {
		if (!invoiceIds.length) return new Map();

		return unifiedReadFields(await this.dataSource.query<Row[]>(UNIFIED_READ_SQL, [invoiceIds, holdingId]));
	}

	/** Tasas pactadas ítem → contrato (jsonb agregado) en la forma de la API. */
	static fxItemRatesOf(
		value: unknown
	): Array<{ from_currency: string; to_currency: string; rate: number; period_start: string; period_end: string }> {
		const rows = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

		if (!Array.isArray(rows)) return [];

		return rows.map((row: Row) => ({
			from_currency: String(row.from_currency ?? '').toUpperCase(),
			to_currency: String(row.to_currency ?? '').toUpperCase(),
			rate: toNumber(row.rate),
			period_start: String(row.period_start ?? '').slice(0, 10),
			period_end: String(row.period_end ?? '').slice(0, 10),
		}));
	}

	/** Motivo del desvío de una factura desde su último `invoice_adjustments` (columnas `deviation_*`), o null si no tiene. */
	static deviationOf(row: Row) {
		if (!row.deviation_id) return null;
		const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

		return {
			has_reason: !!toText(row.deviation_reason)?.trim(),
			type: toText(row.deviation_type),
			amount_diff: toNullableNumber(row.deviation_amount_diff),
			reason: toText(row.deviation_reason),
			adjusted_at: iso(row.deviation_adjusted_at),
			adjusted_by_name: toText(row.deviation_adjusted_by_name),
		};
	}

	/** Se puede "Restablecer borrador del ERP": Por Emitir activa vinculada al ERP que no es NC ni documento unificado. */
	static erpResetAvailable(row: Row): boolean {
		const docType = toText(row.doc_type) ?? '';

		return (
			row.status === 'Por Emitir' &&
			row.is_active !== false &&
			erpSyncStateOf(row) === 'draft' &&
			!/^(NC|ND|NOTA)/i.test(docType) &&
			!row.consolidated_into_invoice_id &&
			row.invoice_type !== 'Unificada' &&
			row.invoice_type !== 'Consolidada'
		);
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

/** Descuento puntual de una línea a partir de su desglose: tipo y valor ingresados, monto total (negativo) y etiqueta. */
function oneOffDiscountOf(breakdown: PricedSubline[] | null): { type: string; value: number; amount: number; label: string } | null {
	const subline: (OneOffSubline & { total: number }) | null = oneOffOf(breakdown);

	if (!subline) return null;

	return {
		type: subline.one_off_type ?? 'amount',
		value: Number(subline.one_off_value ?? Math.abs(subline.total)),
		amount: subline.total,
		label: subline.label,
	};
}
