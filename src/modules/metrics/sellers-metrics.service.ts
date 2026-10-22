import { Injectable } from '@nestjs/common';

import { normalizeQuoteType, QUOTE_TYPE_LABELS, type QuoteTypeCode } from '@/modules/quotes/quote-status';

import { MetricsDataService, SqlParams } from './metrics-data.service';
import { currentMonth, monthStart, resolveRange } from './metrics-period';

import type { SellerDealsDto, SellersDto } from './dtos/query-metrics.dto';

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0) || 0;
const str = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const avg = (values: Array<number | null>): number | null => {
	const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));

	return valid.length ? round1(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
};
const splitList = (value?: string) => value?.split(',').filter(Boolean) ?? [];

/** Facturas que cuentan como emitidas (ni Por Emitir, ni canceladas, ni absorbidas por una unificación o división). */
export const BILLED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'] as const;

/** Familias de tipo de negocio del panel: nuevo negocio, upsell (incluye cross-sell), downsell y el resto. */
export const DEAL_TYPES = ['new_business', 'upsell', 'downsell', 'other'] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_TYPE_LABELS: Record<DealType, string> = { new_business: 'Nuevo negocio', upsell: 'Upsell', downsell: 'Downsell', other: 'Otro' };

/** Código de la cotización → familia del panel. */
export function dealTypeOf(code: QuoteTypeCode | null): DealType {
	if (code === 'new_business') return 'new_business';
	if (code === 'upsell' || code === 'cross_sell') return 'upsell';
	if (code === 'downsell') return 'downsell';

	return 'other';
}

/** Un negocio: una oportunidad ganada (cotización cerrada) y lo que pasó después con lo que vendió. */
export interface SellerDeal {
	quote_id: string;
	quote_number: string | null;
	seller_id: string | null;
	seller_name: string | null;
	client_id: string | null;
	client_name: string | null;
	/** Grafía original del tipo, su código normalizado y la familia del panel. */
	quote_type: string | null;
	type_code: QuoteTypeCode | null;
	type: DealType;
	type_label: string;
	stage: string | null;
	/** Fecha de cierre: `booking_date` (la del CRM) o, si falta, el inicio del servicio. */
	closed_on: string;
	amount: number | null;
	currency: string | null;
	contract: { id: string; number: string | null; status: string | null } | null;
	contracts_count: number;
	/** Inicio del servicio: el primer ítem vinculado (o el contrato creado desde la cotización). */
	started_on: string | null;
	/** MRR del negocio en moneda de sistema: ítems vinculados menos los ítems que reemplazaron (downsell negativo); null si no se pudo calcular. */
	mrr: number | null;
	billed: number;
	collected: number;
	first_invoice_on: string | null;
	first_payment_on: string | null;
	/** Facturas emitidas del contrato desde el cierre (períodos facturados) y cuántas de ellas están pagadas. */
	periods: number;
	paid_periods: number;
	/** Reversiones: facturas anuladas desde el cierre y si el contrato está cancelado. */
	invoices_cancelled: number;
	contract_cancelled: boolean;
	days_to_start: number | null;
	days_to_first_invoice: number | null;
	days_to_payment: number | null;
}

/** Fila del panel para un vendedor (o el equipo). */
export interface SellerFunnelRow {
	seller_id: string | null;
	seller_name: string;
	is_active: boolean;
	deals: number;
	by_type: Record<DealType, number>;
	with_contract: number;
	without_contract: number;
	/** Con contrato y todavía sin factura emitida. */
	not_invoiced: number;
	mrr: number;
	billed: number;
	collected: number;
	/** Facturas pagadas sobre emitidas, en [0, 1]; null sin facturas. */
	paid_share: number | null;
	periods_avg: number | null;
	days_to_start: number | null;
	days_to_first_invoice: number | null;
	days_to_payment: number | null;
	contracts_cancelled: number;
	invoices_cancelled: number;
}

export interface NoSellerSummary {
	contracts: number;
	mrr: number;
	billed: number;
	collected: number;
	contracts_cancelled: number;
}

export interface TrendMonth {
	month: string;
	deals: number;
	mrr: Record<DealType, number>;
}

/**
 * Panel de vendedores v2 (Domi 22-10): parte de las oportunidades ganadas (cotizaciones cerradas por su fecha de cierre, la del CRM) y
 * sigue qué pasó con cada una: inicio del servicio, primera factura, pago, períodos facturados y reversiones. Montos en MRR y en moneda
 * de sistema. El vendedor es el de la cotización; el contrato llega por `contracts.quote_id` o por los ítems (`contract_items.quote_item_id`,
 * los upsell y downsell sobre un contrato existente). Los contratos sin cotización con vendedor van aparte en "Sin vendedor".
 *
 * El SQL devuelve una fila por negocio y el servicio agrega en memoria (un período tiene como mucho cientos de negocios): el panel, la
 * tendencia y el detalle salen de las mismas filas y las mismas reglas. Las CTE van `MATERIALIZED` a propósito: sin eso el planificador
 * recalculaba los agregados de facturas por cada negocio (más de 70 s en prod, medido el 22-10).
 */
@Injectable()
export class SellersMetricsService {
	constructor(private readonly data: MetricsDataService) {}

	/** Una fila por vendedor activo (más los inactivos con negocios), el equipo, la tendencia por mes y "Sin vendedor". */
	async funnel(holdingId: string, query: SellersDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const [currency, allDeals, sellers, noSeller] = await Promise.all([
			this.data.systemCurrency(holdingId),
			this.deals(holdingId, query, from, to),
			this.sellers(holdingId, query.sellerId),
			this.noSeller(holdingId, query, from, to),
		]);
		const deals = query.type ? allDeals.filter((deal) => deal.type === query.type) : allDeals;
		const bySeller = new Map<string | null, SellerDeal[]>();

		for (const deal of deals) {
			const list = bySeller.get(deal.seller_id) ?? [];

			list.push(deal);
			bySeller.set(deal.seller_id, list);
		}
		const rows: SellerFunnelRow[] = sellers
			.filter((seller) => seller.is_active || bySeller.has(seller.id))
			.map((seller) => aggregate(seller.id, seller.name, seller.is_active, bySeller.get(seller.id) ?? []))
			.sort((a, b) => b.deals - a.deals || b.mrr - a.mrr || a.seller_name.localeCompare(b.seller_name, 'es'));
		const withSeller = deals.filter((deal) => deal.seller_id !== null);
		const team = aggregate(null, 'Equipo', true, withSeller);

		return {
			currency,
			from,
			to,
			type: query.type ?? null,
			team: { ...team, sellers_with_deals: rows.filter((row) => row.deals > 0).length, sellers: rows.length },
			rows,
			trend: trend(withSeller, months),
			no_seller: noSeller,
		};
	}

	/** Negocios de un vendedor en el período (los más recientes primero), paginados; `none` = contratos sin vendedor. */
	async sellerDeals(holdingId: string, sellerId: string, query: SellerDealsDto) {
		const { from, to } = resolveRange(query.from, query.to);
		const page = Math.max(1, query.page ?? 1);
		const limit = Math.min(1000, Math.max(1, query.limit ?? 25));
		const currency = await this.data.systemCurrency(holdingId);
		const paginate = <T>(items: T[]) => ({
			currency,
			data: items.slice((page - 1) * limit, page * limit),
			total: items.length,
			currentPage: page,
			pages: Math.max(1, Math.ceil(items.length / limit)),
			limit,
		});

		if (sellerId === 'none') return paginate(await this.noSellerContracts(holdingId, query, from, to));
		const deals = await this.deals(holdingId, { ...query, sellerId }, from, to);

		return paginate(
			(query.type ? deals.filter((deal) => deal.type === query.type) : deals).sort((a, b) => b.closed_on.localeCompare(a.closed_on))
		);
	}

	/** Negocios cerrados en el período con todo lo que pasó después (hasta hoy). */
	private async deals(holdingId: string, query: SellersDto, from: string, to: string): Promise<SellerDeal[]> {
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const periodFrom = params.add(monthStart(from));
		const periodTo = params.add(nextMonthStart(to));
		const today = params.add(monthStart(currentMonth()));
		const billed = params.add([...BILLED_STATUSES]);
		const where = [`q.holding_id = ${holding}`, `q.deleted_at IS NULL`];
		const contractWhere = [`c.holding_id = ${holding}`, `c.deleted_at IS NULL`];
		const sellers = splitList(query.sellerId);
		const companies = splitList(query.companyId);
		const clients = splitList(query.clientId);

		if (sellers.length) where.push(`q.seller_id = ANY(${params.add(sellers)}::uuid[])`);
		if (clients.length) where.push(`q.client_id = ANY(${params.add(clients)}::uuid[])`);
		if (companies.length) contractWhere.push(`c.company_id = ANY(${params.add(companies)}::uuid[])`);
		const rows = (await this.data.query(
			`WITH items AS MATERIALIZED (
				SELECT DISTINCT x.quote_id, x.item_id, x.contract_id, x.start_date FROM (
					SELECT qi.quote_id, ci.id AS item_id, ci.contract_id, ci.start_date FROM contract_items ci
					JOIN quote_items qi ON qi.id = ci.quote_item_id
					JOIN contracts c ON c.id = ci.contract_id
					WHERE ${contractWhere.join(' AND ')}
					UNION
					SELECT c.quote_id, ci.id, c.id, ci.start_date FROM contracts c
					JOIN contract_items ci ON ci.contract_id = c.id
					WHERE ${contractWhere.join(' AND ')} AND c.quote_id IS NOT NULL
				) x
			),
			item_ids AS MATERIALIZED (
				SELECT item_id FROM items
				UNION
				SELECT ai.original_item_id FROM contract_amendment_items ai WHERE ai.original_item_id IS NOT NULL AND ai.new_item_id IN (SELECT item_id FROM items)
			),
			item_mrr AS MATERIALIZED (
				SELECT DISTINCT ON (m.item_id) m.item_id, m.mrr FROM (
					SELECT r.contract_item_id AS item_id, r.period_month, SUM(r.mrr_period_system_ccy) AS mrr
					FROM revenue_schedule_monthly r
					WHERE r.holding_id = ${holding} AND r.contract_item_id IN (SELECT item_id FROM item_ids) AND r.period_month <= ${today}::date
					GROUP BY r.contract_item_id, r.period_month
				) m
				ORDER BY m.item_id, m.period_month DESC
			),
			deal AS (
				SELECT q.id, q.quote_number, q.seller_id, sl.name AS seller_name, q.client_id, cl.name_commercial AS client_name, q.quote_type,
					s.name AS stage, s.kind AS stage_kind, q.booking_date, q.total_amount AS amount, q.currency,
					(SELECT COUNT(DISTINCT i.contract_id) FROM items i WHERE i.quote_id = q.id) AS contracts_count,
					(SELECT MIN(i.start_date) FROM items i WHERE i.quote_id = q.id) AS started_on,
					(SELECT c.id::text || '|' || COALESCE(c.contract_number, '') || '|' || COALESCE(c.status, '') FROM items i JOIN contracts c ON c.id = i.contract_id WHERE i.quote_id = q.id ORDER BY i.start_date NULLS LAST, c.contract_number LIMIT 1) AS contract_ref,
					(SELECT BOOL_OR(c.status = 'Cancelado') FROM items i JOIN contracts c ON c.id = i.contract_id WHERE i.quote_id = q.id) AS contract_cancelled,
					(SELECT COUNT(*) FROM items i WHERE i.quote_id = q.id) AS items_count,
					(SELECT COUNT(*) FROM items i WHERE i.quote_id = q.id AND NOT EXISTS (SELECT 1 FROM item_mrr m WHERE m.item_id = i.item_id)) AS items_without_mrr,
					(SELECT COALESCE(SUM(m.mrr), 0) FROM items i JOIN item_mrr m ON m.item_id = i.item_id WHERE i.quote_id = q.id) AS mrr_new,
					(SELECT COALESCE(SUM(m.mrr), 0) FROM items i JOIN contract_amendment_items ai ON ai.new_item_id = i.item_id JOIN item_mrr m ON m.item_id = ai.original_item_id WHERE i.quote_id = q.id) AS mrr_replaced
				FROM quotes q
				LEFT JOIN quote_stages s ON s.id = q.quote_stage_id
				LEFT JOIN sellers sl ON sl.id = q.seller_id
				LEFT JOIN clients cl ON cl.id = q.client_id
				WHERE ${where.join(' AND ')}
			),
			closed AS MATERIALIZED (
				SELECT d.*, COALESCE(d.booking_date, d.started_on) AS closed_on
				FROM deal d
				WHERE (d.stage_kind IN ('signed', 'contract_created') OR d.contracts_count > 0)
					AND COALESCE(d.booking_date, d.started_on) >= ${periodFrom}::date AND COALESCE(d.booking_date, d.started_on) < ${periodTo}::date
					${companies.length ? 'AND d.contracts_count > 0' : ''}
			),
			inv AS MATERIALIZED (
				SELECT inv.id, inv.contract_id, inv.issue_date, inv.status, inv.total_system_currency,
					(SELECT MIN(p.payment_date) FROM invoice_payments p WHERE p.invoice_id = inv.id AND p.confirmed) AS paid_on
				FROM invoices inv
				WHERE inv.holding_id = ${holding} AND inv.contract_id IN (SELECT DISTINCT i.contract_id FROM items i WHERE i.quote_id IN (SELECT id FROM closed))
			),
			agg AS MATERIALIZED (
				SELECT k.id AS quote_id,
					COALESCE(SUM(inv.total_system_currency) FILTER (WHERE inv.status = ANY(${billed}::text[])), 0) AS billed,
					COALESCE(SUM(inv.total_system_currency) FILTER (WHERE inv.status = 'Pagada'), 0) AS collected,
					COUNT(*) FILTER (WHERE inv.status = ANY(${billed}::text[])) AS periods,
					COUNT(*) FILTER (WHERE inv.status = 'Pagada') AS paid_periods,
					COUNT(*) FILTER (WHERE inv.status = 'Cancelada') AS invoices_cancelled,
					MIN(inv.issue_date) FILTER (WHERE inv.status = ANY(${billed}::text[])) AS first_invoice_on,
					MIN(inv.paid_on) AS first_payment_on
				FROM closed k
				JOIN (SELECT DISTINCT i.quote_id, i.contract_id FROM items i) ic ON ic.quote_id = k.id
				JOIN inv ON inv.contract_id = ic.contract_id AND inv.issue_date >= k.closed_on
				GROUP BY k.id
			)
			SELECT k.*, COALESCE(agg.billed, 0) AS billed, COALESCE(agg.collected, 0) AS collected, COALESCE(agg.periods, 0) AS periods,
				COALESCE(agg.paid_periods, 0) AS paid_periods, COALESCE(agg.invoices_cancelled, 0) AS invoices_cancelled, agg.first_invoice_on, agg.first_payment_on
			FROM closed k
			LEFT JOIN agg ON agg.quote_id = k.id
			ORDER BY k.closed_on DESC, k.quote_number`,
			params.values
		)) as Row[];

		return rows.map((row): SellerDeal => {
			const ref = str(row.contract_ref);
			const [contractId, contractNumber, contractStatus] = ref ? ref.split('|') : [null, null, null];
			const code = normalizeQuoteType(str(row.quote_type));
			const type = dealTypeOf(code);
			const closedOn = dateStr(row.closed_on) ?? '';
			const startedOn = dateStr(row.started_on);
			const firstInvoiceOn = dateStr(row.first_invoice_on);
			const firstPaymentOn = dateStr(row.first_payment_on);
			const itemsWithoutMrr = num(row.items_without_mrr);
			const itemsCount = num(row.items_count);
			// MRR del negocio: lo que suman los ítems vinculados menos lo que sumaban los que reemplazaron (en downsell queda negativo).
			// Sin ítems con devengo (contrato recién creado o sin RSM) no se inventa: null.
			const mrr = itemsCount === 0 || itemsWithoutMrr === itemsCount ? null : round2(num(row.mrr_new) - num(row.mrr_replaced));

			return {
				quote_id: String(row.id),
				quote_number: str(row.quote_number),
				seller_id: str(row.seller_id),
				seller_name: str(row.seller_name),
				client_id: str(row.client_id),
				client_name: str(row.client_name),
				quote_type: str(row.quote_type),
				type_code: code,
				type,
				type_label: code ? QUOTE_TYPE_LABELS[code] : DEAL_TYPE_LABELS.other,
				stage: str(row.stage),
				closed_on: closedOn,
				amount: row.amount === null || row.amount === undefined ? null : Number(row.amount),
				currency: str(row.currency),
				contract: contractId ? { id: contractId, number: contractNumber || null, status: contractStatus || null } : null,
				contracts_count: num(row.contracts_count),
				started_on: startedOn,
				mrr,
				billed: round2(num(row.billed)),
				collected: round2(num(row.collected)),
				first_invoice_on: firstInvoiceOn,
				first_payment_on: firstPaymentOn,
				periods: num(row.periods),
				paid_periods: num(row.paid_periods),
				invoices_cancelled: num(row.invoices_cancelled),
				contract_cancelled: Boolean(row.contract_cancelled),
				days_to_start: daysBetween(closedOn, startedOn),
				days_to_first_invoice: daysBetween(closedOn, firstInvoiceOn),
				days_to_payment: daysBetween(firstInvoiceOn, firstPaymentOn),
			};
		});
	}

	private async sellers(holdingId: string, sellerId?: string): Promise<Array<{ id: string; name: string; is_active: boolean }>> {
		const params = new SqlParams();
		const where = [`s.holding_id = ${params.add(holdingId)}`];
		const ids = splitList(sellerId);

		if (ids.length) where.push(`s.id = ANY(${params.add(ids)}::uuid[])`);
		const rows = (await this.data.query(
			`SELECT s.id, s.name, s.is_active FROM sellers s WHERE ${where.join(' AND ')} ORDER BY lower(s.name)`,
			params.values
		)) as Row[];

		return rows.map((row) => ({ id: String(row.id), name: str(row.name) ?? 'Sin nombre', is_active: Boolean(row.is_active) }));
	}

	/**
	 * SQL de los contratos del período sin cotización con vendedor (la fila "Sin vendedor"), por fecha de firma o de creación, con su MRR
	 * actual (RSM), facturación y cobro de toda la vida del contrato. Una fila por contrato; facturas y RSM agregadas en una sola pasada.
	 */
	private noSellerSql(holdingId: string, query: SellersDto, from: string, to: string, params: SqlParams): string {
		const holding = params.add(holdingId);
		const periodFrom = params.add(monthStart(from));
		const periodTo = params.add(nextMonthStart(to));
		const today = params.add(monthStart(currentMonth()));
		const billed = params.add([...BILLED_STATUSES]);
		const where = [
			`c.holding_id = ${holding}`,
			`c.deleted_at IS NULL`,
			`c.status NOT IN ('En revisión', 'Borrador')`,
			`COALESCE(c.booking_date, c.created_at::date) >= ${periodFrom}::date`,
			`COALESCE(c.booking_date, c.created_at::date) < ${periodTo}::date`,
			`NOT EXISTS (SELECT 1 FROM quotes q WHERE q.id = c.quote_id AND q.seller_id IS NOT NULL)`,
			`NOT EXISTS (SELECT 1 FROM contract_items ci JOIN quote_items qi ON qi.id = ci.quote_item_id JOIN quotes q ON q.id = qi.quote_id WHERE ci.contract_id = c.id AND q.seller_id IS NOT NULL)`,
		];
		const companies = splitList(query.companyId);
		const clients = splitList(query.clientId);

		if (companies.length) where.push(`c.company_id = ANY(${params.add(companies)}::uuid[])`);
		if (clients.length) where.push(`c.client_id = ANY(${params.add(clients)}::uuid[])`);

		return `WITH base AS MATERIALIZED (
				SELECT c.id, c.contract_number, c.status, cl.name_commercial AS client_name, COALESCE(c.booking_date, c.created_at::date) AS contract_on
				FROM contracts c LEFT JOIN clients cl ON cl.id = c.client_id
				WHERE ${where.join(' AND ')}
			),
			mrr AS MATERIALIZED (
				SELECT DISTINCT ON (m.contract_id) m.contract_id, m.mrr FROM (
					SELECT r.contract_id, r.period_month, SUM(r.mrr_period_system_ccy) AS mrr
					FROM revenue_schedule_monthly r
					WHERE r.holding_id = ${holding} AND r.contract_id IN (SELECT id FROM base) AND r.period_month <= ${today}::date
					GROUP BY r.contract_id, r.period_month
				) m
				ORDER BY m.contract_id, m.period_month DESC
			),
			inv AS MATERIALIZED (
				SELECT i.contract_id,
					COALESCE(SUM(i.total_system_currency) FILTER (WHERE i.status = ANY(${billed}::text[])), 0) AS billed,
					COALESCE(SUM(i.total_system_currency) FILTER (WHERE i.status = 'Pagada'), 0) AS collected,
					COUNT(*) FILTER (WHERE i.status = ANY(${billed}::text[])) AS periods,
					MIN(i.issue_date) FILTER (WHERE i.status = ANY(${billed}::text[])) AS first_invoice_on
				FROM invoices i
				WHERE i.holding_id = ${holding} AND i.contract_id IN (SELECT id FROM base)
				GROUP BY i.contract_id
			)
			SELECT b.id, b.contract_number, b.status, b.client_name, b.contract_on, COALESCE(mrr.mrr, 0) AS mrr,
				COALESCE(inv.billed, 0) AS billed, COALESCE(inv.collected, 0) AS collected, COALESCE(inv.periods, 0) AS periods, inv.first_invoice_on
			FROM base b
			LEFT JOIN mrr ON mrr.contract_id = b.id
			LEFT JOIN inv ON inv.contract_id = b.id`;
	}

	private async noSeller(holdingId: string, query: SellersDto, from: string, to: string): Promise<NoSellerSummary> {
		if (splitList(query.sellerId).length) return { contracts: 0, mrr: 0, billed: 0, collected: 0, contracts_cancelled: 0 };
		const params = new SqlParams();
		const sql = this.noSellerSql(holdingId, query, from, to, params);
		const [row] = (await this.data.query(
			`SELECT COUNT(*) AS contracts, COALESCE(SUM(x.mrr), 0) AS mrr, COALESCE(SUM(x.billed), 0) AS billed, COALESCE(SUM(x.collected), 0) AS collected,
				COUNT(*) FILTER (WHERE x.status = 'Cancelado') AS contracts_cancelled
			FROM (${sql}) x`,
			params.values
		)) as Row[];

		return {
			contracts: num(row?.contracts),
			mrr: round2(num(row?.mrr)),
			billed: round2(num(row?.billed)),
			collected: round2(num(row?.collected)),
			contracts_cancelled: num(row?.contracts_cancelled),
		};
	}

	private async noSellerContracts(holdingId: string, query: SellersDto, from: string, to: string) {
		const params = new SqlParams();
		const sql = this.noSellerSql(holdingId, query, from, to, params);
		const rows = (await this.data.query(`SELECT * FROM (${sql}) x ORDER BY x.contract_on DESC, x.contract_number`, params.values)) as Row[];

		return rows.map((row) => {
			const contractOn = dateStr(row.contract_on);
			const firstInvoiceOn = dateStr(row.first_invoice_on);

			return {
				contract: { id: String(row.id), number: str(row.contract_number), status: str(row.status) },
				client_name: str(row.client_name),
				contract_on: contractOn,
				mrr: round2(num(row.mrr)),
				billed: round2(num(row.billed)),
				collected: round2(num(row.collected)),
				periods: num(row.periods),
				first_invoice_on: firstInvoiceOn,
				days_to_first_invoice: daysBetween(contractOn, firstInvoiceOn),
				contract_cancelled: str(row.status) === 'Cancelado',
			};
		});
	}
}

/** Fecha de la base (Date o texto) → `YYYY-MM-DD`. */
const dateStr = (value: unknown): string | null => {
	if (value === null || value === undefined || value === '') return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);

	return String(value).slice(0, 10);
};

/** Primer día del mes siguiente a `to` (`YYYY-MM-01`), tope exclusivo del período. */
export function nextMonthStart(to: string): string {
	const [year, month] = to.split('-').map(Number);

	return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

const toUtc = (value: string) => Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));

/** Días entre dos fechas `YYYY-MM-DD` (null si falta alguna). */
export const daysBetween = (from: string | null, to: string | null): number | null =>
	from && to ? Math.round((toUtc(to) - toUtc(from)) / 86_400_000) : null;

const emptyByType = (): Record<DealType, number> => ({ new_business: 0, upsell: 0, downsell: 0, other: 0 });

/** Panel de un conjunto de negocios: conteos, MRR (sumando los que lo tienen), facturación y tiempos promedio. */
export function aggregate(sellerId: string | null, sellerName: string, isActive: boolean, deals: SellerDeal[]): SellerFunnelRow {
	const byType = emptyByType();

	for (const deal of deals) byType[deal.type] += 1;
	const withContract = deals.filter((deal) => deal.contracts_count > 0);
	const periods = deals.reduce((sum, deal) => sum + deal.periods, 0);
	const paid = deals.reduce((sum, deal) => sum + deal.paid_periods, 0);
	const sum = (key: 'billed' | 'collected') => round2(deals.reduce((total, deal) => total + deal[key], 0));

	return {
		seller_id: sellerId,
		seller_name: sellerName,
		is_active: isActive,
		deals: deals.length,
		by_type: byType,
		with_contract: withContract.length,
		without_contract: deals.length - withContract.length,
		not_invoiced: withContract.filter((deal) => deal.periods === 0).length,
		mrr: round2(deals.reduce((total, deal) => total + (deal.mrr ?? 0), 0)),
		billed: sum('billed'),
		collected: sum('collected'),
		paid_share: periods ? Math.round((paid / periods) * 1000) / 1000 : null,
		periods_avg: withContract.length ? round1(periods / withContract.length) : null,
		days_to_start: avg(withContract.map((deal) => deal.days_to_start)),
		days_to_first_invoice: avg(withContract.map((deal) => deal.days_to_first_invoice)),
		days_to_payment: avg(deals.map((deal) => deal.days_to_payment)),
		contracts_cancelled: deals.filter((deal) => deal.contract_cancelled).length,
		invoices_cancelled: deals.reduce((total, deal) => total + deal.invoices_cancelled, 0),
	};
}

/** MRR cerrado por mes de cierre y familia de tipo (barras apiladas de la tendencia). */
export function trend(deals: SellerDeal[], months: string[]): TrendMonth[] {
	const byMonth = new Map(months.map((month): [string, TrendMonth] => [month, { month, deals: 0, mrr: emptyByType() }]));

	for (const deal of deals) {
		const entry = byMonth.get(deal.closed_on.slice(0, 7));

		if (!entry) continue;
		entry.deals += 1;
		entry.mrr[deal.type] = round2(entry.mrr[deal.type] + (deal.mrr ?? 0));
	}

	return [...byMonth.values()];
}
