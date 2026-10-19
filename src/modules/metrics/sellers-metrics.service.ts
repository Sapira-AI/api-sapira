import { Injectable } from '@nestjs/common';

import { MetricsDataService, SqlParams } from './metrics-data.service';
import { monthStart, resolveRange } from './metrics-period';

import type { SellerDealsDto, SellersDto } from './dtos/query-metrics.dto';

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value ?? 0) || 0;
const numOrNull = (value: unknown): number | null => (value === null || value === undefined || value === '' ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const avg = (values: Array<number | null>): number | null => {
	const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));

	return valid.length ? round1(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
};
const splitList = (value?: string) => value?.split(',').filter(Boolean) ?? [];

/** Facturas que cuentan como facturadas (emitidas de verdad: ni Por Emitir, ni canceladas, ni las absorbidas por una unificación o división). */
export const BILLED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'] as const;

/** Un negocio: una cotización con lo que pasó después (contrato, facturación y cobro de ese contrato). */
export interface SellerDeal {
	quote_id: string;
	quote_number: string | null;
	seller_id: string | null;
	seller_name: string | null;
	client_id: string | null;
	client_name: string | null;
	quote_type: string | null;
	stage: string | null;
	stage_kind: string | null;
	/** Fecha de la cotización (quote_date o, si falta, created_at). */
	created_on: string;
	/** Cerrada: etapa firmada o con contrato creado, **o** con un contrato vinculado aunque la etapa haya quedado atrás (Domi 19-10). */
	closed: boolean;
	lost: boolean;
	/** booking_date o, si falta, la fecha del contrato vinculado. */
	closed_on: string | null;
	amount: number | null;
	currency: string | null;
	contract: { id: string; number: string | null } | null;
	contracts_count: number;
	tcv: number;
	mrr: number;
	billed: number;
	collected: number;
	first_invoice_on: string | null;
}

/** Fila del funnel de un vendedor (o del total del equipo). */
export interface SellerFunnelRow {
	seller_id: string | null;
	seller_name: string;
	is_active: boolean;
	created: number;
	closed: number;
	lost: number;
	with_contract: number;
	/** closed / created, en [0, 1]; null sin cotizaciones creadas. */
	conversion: number | null;
	tcv: number;
	mrr: number;
	billed: number;
	collected: number;
	cycle_days: number | null;
	days_to_first_invoice: number | null;
}

export interface NoSellerSummary {
	contracts: number;
	tcv: number;
	mrr: number;
	billed: number;
	collected: number;
}

const inPeriod = (value: string | null, from: string, to: string) => value !== null && value >= from && value < to;

/**
 * Funnel por vendedor (Domi 19-10): cotizaciones creadas en el período → cerradas → con contrato → facturado y cobrado, en moneda de
 * sistema como el resto de Métricas. El vendedor es el de la cotización; el contrato llega por `contracts.quote_id` o por sus ítems
 * (`contract_items.quote_item_id`, los upsell sobre un contrato existente). Los contratos sin cotización con vendedor van aparte en
 * "Sin vendedor" (segunda etapa, fuera de alcance: columna de vendedor en el contrato).
 *
 * El SQL devuelve una fila por negocio (cotización) y el servicio agrega en memoria: un período tiene como mucho cientos de negocios, y
 * así el funnel y el detalle salen de las mismas filas y las mismas reglas.
 */
@Injectable()
export class SellersMetricsService {
	constructor(private readonly data: MetricsDataService) {}

	/** Una fila por vendedor activo (más los inactivos con actividad), el total del equipo y "Sin vendedor". */
	async funnel(holdingId: string, query: SellersDto) {
		const { from, to } = resolveRange(query.from, query.to);
		const [currency, deals, sellers, noSeller] = await Promise.all([
			this.data.systemCurrency(holdingId),
			this.deals(holdingId, query, from, to),
			this.sellers(holdingId, query.sellerId),
			this.noSeller(holdingId, query, from, to),
		]);
		const periodFrom = monthStart(from);
		const periodTo = nextMonthStart(to);
		const bySeller = new Map<string | null, SellerDeal[]>();

		for (const deal of deals) {
			const list = bySeller.get(deal.seller_id) ?? [];

			list.push(deal);
			bySeller.set(deal.seller_id, list);
		}
		const rows: SellerFunnelRow[] = sellers
			.filter((seller) => seller.is_active || bySeller.has(seller.id))
			.map((seller) => aggregate(seller.id, seller.name, seller.is_active, bySeller.get(seller.id) ?? [], periodFrom, periodTo))
			.sort((a, b) => b.closed - a.closed || b.tcv - a.tcv || a.seller_name.localeCompare(b.seller_name, 'es'));
		const team = aggregate(
			null,
			'Equipo',
			true,
			deals.filter((deal) => deal.seller_id !== null),
			periodFrom,
			periodTo
		);

		return {
			currency,
			from,
			to,
			team: { ...team, sellers_with_sales: rows.filter((row) => row.closed > 0).length },
			rows,
			no_seller: noSeller,
		};
	}

	/** Negocios de un vendedor en el período (creados o cerrados en él), los cerrados primero; `none` = contratos sin vendedor. */
	async sellerDeals(holdingId: string, sellerId: string, query: SellerDealsDto) {
		const { from, to } = resolveRange(query.from, query.to);
		const page = Math.max(1, query.page ?? 1);
		const limit = Math.min(200, Math.max(1, query.limit ?? 25));
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
		const periodFrom = monthStart(from);
		const periodTo = nextMonthStart(to);
		const sorted = deals
			.map((deal) => ({ ...deal, closed_in_period: deal.closed && inPeriod(deal.closed_on, periodFrom, periodTo) }))
			.sort(
				(a, b) =>
					Number(b.closed_in_period) - Number(a.closed_in_period) ||
					(b.closed_on ?? b.created_on).localeCompare(a.closed_on ?? a.created_on)
			);

		return paginate(sorted);
	}

	/** Negocios (cotizaciones) del holding creados o cerrados en el período, con su contrato, facturación y cobro. */
	private async deals(holdingId: string, query: SellersDto, from: string, to: string): Promise<SellerDeal[]> {
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const periodFrom = params.add(monthStart(from));
		const periodTo = params.add(nextMonthStart(to));
		const where = [`q.holding_id = ${holding}`, `q.deleted_at IS NULL`];
		const contractWhere = [`c.holding_id = ${holding}`, `c.deleted_at IS NULL`];
		const sellers = splitList(query.sellerId);
		const companies = splitList(query.companyId);
		const clients = splitList(query.clientId);

		if (sellers.length) where.push(`q.seller_id = ANY(${params.add(sellers)}::uuid[])`);
		if (clients.length) where.push(`q.client_id = ANY(${params.add(clients)}::uuid[])`);
		if (companies.length) contractWhere.push(`c.company_id = ANY(${params.add(companies)}::uuid[])`);
		const rows = (await this.data.query(
			`WITH links AS (
				SELECT DISTINCT x.quote_id, x.contract_id FROM (
					SELECT c.quote_id, c.id AS contract_id FROM contracts c WHERE ${contractWhere.join(' AND ')} AND c.quote_id IS NOT NULL
					UNION
					SELECT qi.quote_id, ci.contract_id FROM contract_items ci
					JOIN quote_items qi ON qi.id = ci.quote_item_id
					JOIN contracts c ON c.id = ci.contract_id
					WHERE ${contractWhere.join(' AND ')}
				) x
			),
			money AS (
				SELECT c.id AS contract_id, c.contract_number, COALESCE(c.booking_date, c.created_at::date) AS contract_on,
					COALESCE(c.total_value_system_currency, 0) AS tcv,
					COALESCE((SELECT SUM(r.mrr_period_system_ccy) FROM revenue_schedule_monthly r
						WHERE r.contract_id = c.id AND r.period_month = (SELECT MAX(r2.period_month) FROM revenue_schedule_monthly r2 WHERE r2.contract_id = c.id AND r2.period_month < ${periodTo}::date)), 0) AS mrr,
					COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i WHERE i.contract_id = c.id AND i.status = ANY(${params.add([...BILLED_STATUSES])}::text[]) AND i.issue_date < ${periodTo}::date), 0) AS billed,
					COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i WHERE i.contract_id = c.id AND i.status = 'Pagada' AND i.issue_date < ${periodTo}::date), 0) AS collected,
					(SELECT MIN(i.issue_date) FROM invoices i WHERE i.contract_id = c.id AND i.status = ANY(${params.add([...BILLED_STATUSES])}::text[])) AS first_invoice_on
				FROM contracts c WHERE ${contractWhere.join(' AND ')} AND c.id IN (SELECT contract_id FROM links)
			),
			deal AS (
				SELECT q.id, q.quote_number, q.seller_id, sl.name AS seller_name, q.client_id, cl.name_commercial AS client_name, q.quote_type,
					s.name AS stage, s.kind AS stage_kind, COALESCE(q.quote_date, q.created_at::date) AS created_on, q.booking_date,
					q.total_amount AS amount, q.currency,
					(SELECT MIN(m.contract_on) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS first_contract_on,
					(SELECT COUNT(*) FROM links l WHERE l.quote_id = q.id) AS contracts_count,
					(SELECT m.contract_id::text || '|' || COALESCE(m.contract_number, '') FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id ORDER BY m.contract_on, m.contract_id LIMIT 1) AS contract_ref,
					(SELECT SUM(m.tcv) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS tcv,
					(SELECT SUM(m.mrr) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS mrr,
					(SELECT SUM(m.billed) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS billed,
					(SELECT SUM(m.collected) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS collected,
					(SELECT MIN(m.first_invoice_on) FROM links l JOIN money m ON m.contract_id = l.contract_id WHERE l.quote_id = q.id) AS first_invoice_on
				FROM quotes q
				LEFT JOIN quote_stages s ON s.id = q.quote_stage_id
				LEFT JOIN sellers sl ON sl.id = q.seller_id
				LEFT JOIN clients cl ON cl.id = q.client_id
				WHERE ${where.join(' AND ')}
			)
			SELECT d.*, (d.stage_kind IN ('signed', 'contract_created') OR d.contracts_count > 0) AS closed, (d.stage_kind = 'lost') AS lost,
				COALESCE(d.booking_date, d.first_contract_on) AS closed_on
			FROM deal d
			WHERE (d.created_on >= ${periodFrom}::date AND d.created_on < ${periodTo}::date)
				OR (COALESCE(d.booking_date, d.first_contract_on) >= ${periodFrom}::date AND COALESCE(d.booking_date, d.first_contract_on) < ${periodTo}::date)
				${companies.length ? 'AND d.contracts_count > 0' : ''}
			ORDER BY closed_on DESC NULLS LAST, d.created_on DESC`,
			params.values
		)) as Row[];

		return rows.map((row): SellerDeal => {
			const ref = str(row.contract_ref);
			const [contractId, contractNumber] = ref ? ref.split('|') : [null, null];

			return {
				quote_id: String(row.id),
				quote_number: str(row.quote_number),
				seller_id: str(row.seller_id),
				seller_name: str(row.seller_name),
				client_id: str(row.client_id),
				client_name: str(row.client_name),
				quote_type: str(row.quote_type),
				stage: str(row.stage),
				stage_kind: str(row.stage_kind),
				created_on: dateStr(row.created_on) ?? '',
				closed: Boolean(row.closed),
				lost: Boolean(row.lost),
				closed_on: dateStr(row.closed_on),
				amount: numOrNull(row.amount),
				currency: str(row.currency),
				contract: contractId ? { id: contractId, number: contractNumber || null } : null,
				contracts_count: num(row.contracts_count),
				tcv: round2(num(row.tcv)),
				mrr: round2(num(row.mrr)),
				billed: round2(num(row.billed)),
				collected: round2(num(row.collected)),
				first_invoice_on: dateStr(row.first_invoice_on),
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

	/** SQL de los contratos del período sin cotización con vendedor (la fila "Sin vendedor"). */
	private noSellerSql(holdingId: string, query: SellersDto, from: string, to: string, params: SqlParams) {
		const holding = params.add(holdingId);
		const periodFrom = params.add(monthStart(from));
		const periodTo = params.add(nextMonthStart(to));
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

		return {
			select: `c.id, c.contract_number, cl.name_commercial AS client_name, COALESCE(c.booking_date, c.created_at::date) AS contract_on,
				COALESCE(c.total_value_system_currency, 0) AS tcv,
				COALESCE((SELECT SUM(r.mrr_period_system_ccy) FROM revenue_schedule_monthly r
					WHERE r.contract_id = c.id AND r.period_month = (SELECT MAX(r2.period_month) FROM revenue_schedule_monthly r2 WHERE r2.contract_id = c.id AND r2.period_month < ${periodTo}::date)), 0) AS mrr,
				COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i WHERE i.contract_id = c.id AND i.status = ANY(${params.add([...BILLED_STATUSES])}::text[]) AND i.issue_date < ${periodTo}::date), 0) AS billed,
				COALESCE((SELECT SUM(i.total_system_currency) FROM invoices i WHERE i.contract_id = c.id AND i.status = 'Pagada' AND i.issue_date < ${periodTo}::date), 0) AS collected`,
			from: `FROM contracts c LEFT JOIN clients cl ON cl.id = c.client_id WHERE ${where.join(' AND ')}`,
		};
	}

	private async noSeller(holdingId: string, query: SellersDto, from: string, to: string): Promise<NoSellerSummary> {
		if (splitList(query.sellerId).length) return { contracts: 0, tcv: 0, mrr: 0, billed: 0, collected: 0 };
		const params = new SqlParams();
		const sql = this.noSellerSql(holdingId, query, from, to, params);
		const [row] = (await this.data.query(
			`SELECT COUNT(*) AS contracts, COALESCE(SUM(x.tcv), 0) AS tcv, COALESCE(SUM(x.mrr), 0) AS mrr, COALESCE(SUM(x.billed), 0) AS billed, COALESCE(SUM(x.collected), 0) AS collected FROM (SELECT ${sql.select} ${sql.from}) x`,
			params.values
		)) as Row[];

		return {
			contracts: num(row?.contracts),
			tcv: round2(num(row?.tcv)),
			mrr: round2(num(row?.mrr)),
			billed: round2(num(row?.billed)),
			collected: round2(num(row?.collected)),
		};
	}

	private async noSellerContracts(holdingId: string, query: SellersDto, from: string, to: string) {
		const params = new SqlParams();
		const sql = this.noSellerSql(holdingId, query, from, to, params);
		const rows = (await this.data.query(`SELECT ${sql.select} ${sql.from} ORDER BY contract_on DESC, c.contract_number`, params.values)) as Row[];

		return rows.map((row) => ({
			contract: { id: String(row.id), number: str(row.contract_number) },
			client_name: str(row.client_name),
			contract_on: dateStr(row.contract_on),
			tcv: round2(num(row.tcv)),
			mrr: round2(num(row.mrr)),
			billed: round2(num(row.billed)),
			collected: round2(num(row.collected)),
		}));
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
	const next = new Date(Date.UTC(year, month, 1));

	return next.toISOString().slice(0, 10);
}

const daysBetween = (from: string | null, to: string | null): number | null =>
	from && to
		? Math.round(
				(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))) -
					Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))) /
					86_400_000
			)
		: null;

/** Funnel de un conjunto de negocios: creados en el período, cerrados en el período y el dinero de esos cierres. */
export function aggregate(
	sellerId: string | null,
	sellerName: string,
	isActive: boolean,
	deals: SellerDeal[],
	periodFrom: string,
	periodTo: string
): SellerFunnelRow {
	const created = deals.filter((deal) => inPeriod(deal.created_on, periodFrom, periodTo));
	const closed = deals.filter((deal) => deal.closed && inPeriod(deal.closed_on, periodFrom, periodTo));
	const lost = deals.filter((deal) => deal.lost && inPeriod(deal.created_on, periodFrom, periodTo)).length;
	const withContract = closed.filter((deal) => deal.contracts_count > 0);
	const sum = (key: 'tcv' | 'mrr' | 'billed' | 'collected') => round2(closed.reduce((total, deal) => total + deal[key], 0));

	return {
		seller_id: sellerId,
		seller_name: sellerName,
		is_active: isActive,
		created: created.length,
		closed: closed.length,
		lost,
		with_contract: withContract.length,
		conversion: created.length ? Math.round((closed.length / created.length) * 1000) / 1000 : null,
		tcv: sum('tcv'),
		mrr: sum('mrr'),
		billed: sum('billed'),
		collected: sum('collected'),
		cycle_days: avg(closed.map((deal) => daysBetween(deal.created_on, deal.closed_on))),
		days_to_first_invoice: avg(withContract.map((deal) => daysBetween(deal.closed_on, deal.first_invoice_on))),
	};
}
