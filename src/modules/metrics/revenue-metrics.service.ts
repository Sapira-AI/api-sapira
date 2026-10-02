import { BadRequestException, Injectable } from '@nestjs/common';

import {
	type CurrencyContext,
	inactiveEmptyRowSql,
	MetricsDataService,
	PENDING,
	realGapSql,
	SqlParams,
	unconvertedSql,
} from './metrics-data.service';
import { addMonths, currentMonth, type Month, monthStart, resolveRange } from './metrics-period';
import { balancesAt, forwardSchedule, indexByItem, journalMonths, type RevenueItemMonth, rollforward } from './revenue-balances';

import type {
	ExceptionsDto,
	MetricsFiltersDto,
	RevenueDimension,
	RevenueDimensionDto,
	RevenueForwardDto,
	RevenueJournalDto,
	RevenueScheduleDto,
	ScheduleSortField,
} from './dtos/query-metrics.dto';

type Row = Record<string, unknown>;

const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: unknown) => Number(value ?? 0) || 0;
const str = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const suffix = (mode: CurrencyContext['mode']) => (mode === 'system' ? '_system_ccy' : mode === 'company' ? '_ccy' : '_contract_ccy');
const isoDate = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);
const lastDay = (month: Month) => {
	const [year, m] = month.split('-').map(Number);

	return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Expresión SQL de cada dimensión de Revenue (alias del detalle: `cl` cliente, `ce` razón social, `co` compañía, `ci` ítem). */
const DIMENSION_SQL: Record<RevenueDimension, { key: string; label: string }> = {
	client: { key: `COALESCE(c.client_id, s.client_id)::text`, label: `MAX(cl.name_commercial)` },
	client_entity: { key: `COALESCE(c.client_entity_id, s.client_entity_id)::text`, label: `MAX(ce.legal_name)` },
	client_country: { key: `cl.country`, label: `MAX(cl.country)` },
	entity_country: { key: `ce.country`, label: `MAX(ce.country)` },
	product: { key: `COALESCE(ci.product_name, r.product_name)`, label: `MAX(COALESCE(ci.product_name, r.product_name))` },
	company: { key: `r.company_id::text`, label: `MAX(co.legal_name)` },
	recurring: {
		key: `CASE WHEN r.subscription_id IS NOT NULL OR COALESCE(ci.is_recurring, false) THEN 'recurring' ELSE 'one_time' END`,
		label: `MAX(CASE WHEN r.subscription_id IS NOT NULL OR COALESCE(ci.is_recurring, false) THEN 'Recurrente' ELSE 'No recurrente' END)`,
	},
};

const SCHEDULE_SORT: Record<ScheduleSortField, string> = {
	period: 'r.period_month',
	contract_number: 'c.contract_number',
	client_name: 'cl.name_commercial',
	company_name: 'co.legal_name',
	product: 'COALESCE(ci.product_name, r.product_name)',
	recognized: 'recognized',
	billed: 'billed',
	deferred_eom: 'deferred_eom',
	unbilled_eom: 'unbilled_eom',
	mrr: 'mrr',
};

const JOINS = `
	LEFT JOIN contracts c ON c.id = r.contract_id
	LEFT JOIN subscriptions s ON s.id = r.subscription_id
	LEFT JOIN contract_items ci ON ci.id = r.contract_item_id
	LEFT JOIN clients cl ON cl.id = COALESCE(c.client_id, s.client_id)
	LEFT JOIN client_entities ce ON ce.id = COALESCE(c.client_entity_id, s.client_entity_id)
	LEFT JOIN companies co ON co.id = r.company_id`;

/** Devengo (spec-revenue-y-metricas §1.7, §3 Revenue). Solo lectura. */
@Injectable()
export class RevenueMetricsService {
	constructor(private readonly data: MetricsDataService) {}

	/** Filas del devengo hasta `to` (toda la historia: los saldos necesitan el último acumulado de cada ítem) y lo que quedó fuera. */
	private async rows(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, to: Month) {
		const loaded = await this.data.loadRevenueRows(holdingId, filters, currency, null, to);

		return { rows: loaded.rows, unconverted: this.data.summarizeUnconverted({ revenueRows: loaded.unconvertedRows, currency }) };
	}

	private where(holdingId: string, filters: MetricsFiltersDto, params: SqlParams, from: Month, to: Month) {
		return [
			`r.holding_id = ${params.add(holdingId)}`,
			`COALESCE(r.is_total_row, false) = false`,
			`r.momentum IS DISTINCT FROM '${PENDING}'`,
			`r.period_month BETWEEN ${params.add(monthStart(from))}::date AND ${params.add(monthStart(to))}::date`,
			`c.deleted_at IS NULL`,
			...this.data.rsmFilters(
				{
					...filters,
					source: filters.source
						? filters.source
								.split(',')
								.filter((x) => x !== 'legacy')
								.join(',') || 'none'
						: undefined,
				},
				params
			),
		];
	}

	/** Cortes de período por compañía (`accounting_period_cutoff`, solo lectura). */
	private async cutoffs(holdingId: string, companyIds?: string) {
		const companies = companyIds?.split(',').filter(Boolean) ?? [];
		const rows = await this.data.query(
			`SELECT co.id::text AS company_id, co.legal_name AS company_name, co.currency, apc.cutoff_date
			FROM companies co
			LEFT JOIN accounting_period_cutoff apc ON apc.company_id = co.id AND apc.holding_id = co.holding_id
			WHERE co.holding_id = $1 ${companies.length ? 'AND co.id = ANY($2::uuid[])' : ''}
				AND EXISTS (SELECT 1 FROM revenue_schedule_monthly r WHERE r.company_id = co.id AND r.holding_id = $1)
			ORDER BY co.legal_name`,
			companies.length ? [holdingId, companies] : [holdingId]
		);

		return rows.map((row) => ({
			company_id: String(row.company_id),
			company_name: str(row.company_name),
			currency: str(row.currency),
			cutoff_date: isoDate(row.cutoff_date),
		}));
	}

	/** Resumen del período: KPIs, serie mensual con meses cerrados, top y cortes (§3 `revenue/summary`). */
	async summary(holdingId: string, query: MetricsFiltersDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const [{ rows, unconverted }, cutoffs, top, fx, recurring, asOf] = await Promise.all([
			this.rows(holdingId, query, currency, to),
			this.cutoffs(holdingId, query.companyId),
			Promise.all((['client', 'product', 'company'] as const).map((dimension) => this.topBy(holdingId, query, currency, dimension, from, to))),
			currency.mode === 'system' ? this.fxDifference(holdingId, query, from, to) : Promise.resolve(null),
			this.recurringVsMrr(holdingId, query, currency, to),
			this.data.asOf(holdingId),
		]);
		const byItem = indexByItem(rows);
		const sumMonth = (month: Month, field: 'recognized' | 'billed') =>
			round2(rows.filter((row) => row.period === month).reduce((s, row) => s + row[field], 0));
		const closedUntil = cutoffs.length && cutoffs.every((c) => c.cutoff_date) ? cutoffs.map((c) => c.cutoff_date!).sort()[0] : null;
		const series = months.map((month) => {
			const balances = balancesAt(byItem, month);

			return {
				period: month,
				recognized: sumMonth(month, 'recognized'),
				billed: sumMonth(month, 'billed'),
				deferred_eom: balances.deferred,
				unbilled_eom: balances.unbilled,
				fx_difference: fx ? (fx.get(month) ?? 0) : null,
				closed: Boolean(closedUntil && lastDay(month) <= closedUntil),
			};
		});
		const closing = balancesAt(byItem, to);

		return {
			currency: currency.code,
			period: { from, to },
			calculated_at: asOf,
			kpis: {
				recognized: round2(series.reduce((s, m) => s + m.recognized, 0)),
				billed: round2(series.reduce((s, m) => s + m.billed, 0)),
				deferred_eom: closing.deferred,
				unbilled_eom: closing.unbilled,
				fx_difference: fx ? round2([...fx.values()].reduce((s, v) => s + v, 0)) : null,
				recurring_recognized: recurring.recognized,
				mrr: recurring.mrr,
			},
			months: series,
			top: { clients: top[0], products: top[1], companies: top[2] },
			cutoffs,
			unconverted,
		};
	}

	private async topBy(
		holdingId: string,
		filters: MetricsFiltersDto,
		currency: CurrencyContext,
		dimension: RevenueDimension,
		from: Month,
		to: Month
	) {
		const s = suffix(currency.mode);
		const params = new SqlParams();
		const where = this.where(holdingId, filters, params, from, to);
		const dim = DIMENSION_SQL[dimension];
		const rows = await this.data.query(
			`SELECT ${dim.key} AS key, ${dim.label} AS label, SUM(r.recognized_period${s}) AS value
			FROM revenue_schedule_monthly r ${JOINS}
			WHERE ${where.join(' AND ')} AND NOT ${unconvertedSql(currency.mode, `r.recognized_period${s}`)}
			GROUP BY ${dim.key} ORDER BY value DESC NULLS LAST LIMIT 5`,
			params.values
		);

		return rows.map((row) => ({ key: str(row.key) ?? '—', label: str(row.label) ?? 'Sin dato', value: round2(num(row.value)) }));
	}

	/**
	 * Diferencia de cambio del facturado por mes (§1.7, solo moneda de sistema): Σ `invoices.amount_system_currency` de las facturas
	 * emitidas ligadas a contratos (tasa de emisión) − Σ `billed_period_system_ccy` del devengo (tasa del devengo).
	 */
	private async fxDifference(holdingId: string, filters: MetricsFiltersDto, from: Month, to: Month): Promise<Map<Month, number>> {
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const start = params.add(monthStart(from));
		const end = params.add(monthStart(to));
		const extra: string[] = [];
		const add = (values: string | undefined, sql: (p: string) => string) => {
			const list = values?.split(',').filter(Boolean) ?? [];

			if (list.length) extra.push(sql(params.add(list)));
		};

		add(filters.companyId, (p) => `c.company_id = ANY(${p}::uuid[])`);
		add(filters.clientId, (p) => `c.client_id = ANY(${p}::uuid[])`);
		add(filters.contractId, (p) => `c.id = ANY(${p}::uuid[])`);
		const filterSql = extra.map((condition) => `AND ${condition}`).join(' ');
		const rows = await this.data.query(
			`WITH inv AS (
				SELECT to_char(date_trunc('month', i.issue_date), 'YYYY-MM') AS period, SUM(i.amount_system_currency) AS amount
				FROM invoices i JOIN contracts c ON c.id = i.contract_id
				WHERE i.holding_id = ${holding} AND i.is_active AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
					AND i.amount_system_currency IS NOT NULL
					AND date_trunc('month', i.issue_date) BETWEEN ${start}::date AND ${end}::date ${filterSql}
				GROUP BY 1
			), rsm AS (
				SELECT to_char(r.period_month, 'YYYY-MM') AS period, SUM(r.billed_period_system_ccy) AS amount
				FROM revenue_schedule_monthly r JOIN contracts c ON c.id = r.contract_id
				WHERE r.holding_id = ${holding} AND r.momentum IS DISTINCT FROM '${PENDING}' AND r.billed_period_system_ccy IS NOT NULL
					AND r.period_month BETWEEN ${start}::date AND ${end}::date ${filterSql}
				GROUP BY 1
			)
			SELECT COALESCE(inv.period, rsm.period) AS period, COALESCE(inv.amount, 0) - COALESCE(rsm.amount, 0) AS diff
			FROM inv FULL JOIN rsm ON rsm.period = inv.period`,
			params.values
		);

		return new Map(rows.map((row) => [String(row.period), round2(num(row.diff))]));
	}

	/** Ingreso recurrente reconocido del mes vs MRR (D3: lo que resolvía el "MRR reconocido"). */
	private async recurringVsMrr(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, month: Month) {
		const s = suffix(currency.mode);
		const params = new SqlParams();
		const where = this.where(holdingId, filters, params, month, month);
		const [row] = await this.data.query(
			`SELECT SUM(r.recognized_period${s}) FILTER (WHERE r.subscription_id IS NOT NULL OR COALESCE(ci.is_recurring, false)) AS recognized,
				SUM(r.mrr_period_contracted${s}) AS mrr
			FROM revenue_schedule_monthly r ${JOINS}
			WHERE ${where.join(' AND ')} AND NOT ${unconvertedSql(currency.mode, `r.recognized_period${s}`)}`,
			params.values
		);

		return { recognized: round2(num(row?.recognized)), mrr: round2(num(row?.mrr)) };
	}

	/** Roll-forward de diferido y por facturar del período (§1.7). */
	async rollforward(holdingId: string, query: MetricsFiltersDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const { rows, unconverted } = await this.rows(holdingId, query, currency, to);

		return { currency: currency.code, period: { from, to }, ...rollforward(rows, months), unconverted };
	}

	/** Reconocimiento futuro (RPO) desde `asOf`: 12 meses + posterior, separado en diferido y por facturar (§1.7). */
	async forward(holdingId: string, query: RevenueForwardDto) {
		const asOf = query.asOf ?? currentMonth();
		const currency = await this.data.resolveCurrency(holdingId, query);
		const [{ rows, unconverted }, future] = await Promise.all([
			this.rows(holdingId, query, currency, asOf),
			this.futureRows(holdingId, query, currency, asOf),
		]);

		return {
			currency: currency.code,
			as_of: asOf,
			rate_note: currency.mode === 'contract' ? null : 'Meses futuros sin tasa propia se convierten con la tasa del mes de corte',
			...forwardSchedule(rows, future.rows, asOf),
			unconverted: { ...unconverted, rows: unconverted.rows + future.missing },
		};
	}

	/** Reconocido futuro por ítem: el monto convertido del mes si tiene tasa; si no, moneda de contrato × tasa del ítem en el mes de corte. */
	private async futureRows(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, asOf: Month) {
		const s = suffix(currency.mode);
		const fx = currency.mode === 'system' ? 'fx_contract_to_system' : 'fx_contract_to_company';
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const asOfDate = params.add(monthStart(asOf));
		const where = [
			`r.holding_id = ${holding}`,
			`COALESCE(r.is_total_row, false) = false`,
			`r.momentum IS DISTINCT FROM '${PENDING}'`,
			`r.period_month > ${asOfDate}::date`,
			`c.deleted_at IS NULL`,
			...this.data.rsmFilters(
				{
					...filters,
					source: filters.source
						? filters.source
								.split(',')
								.filter((x) => x !== 'legacy')
								.join(',') || 'none'
						: undefined,
				},
				params
			),
		];
		const amount =
			currency.mode === 'contract'
				? `SUM(r.recognized_period_contract_ccy)`
				: `SUM(CASE WHEN NOT ${unconvertedSql(currency.mode, `r.recognized_period${s}`)} THEN r.recognized_period${s}
					ELSE r.recognized_period_contract_ccy * (SELECT a.${fx} FROM revenue_schedule_monthly a
						WHERE a.contract_item_id = r.contract_item_id AND a.period_month <= ${asOfDate}::date AND a.${fx} IS NOT NULL
						ORDER BY a.period_month DESC LIMIT 1) END)`;
		const rows = await this.data.query(
			`SELECT COALESCE(r.contract_id, r.subscription_id)::text AS contract_id,
				COALESCE(r.contract_item_id, r.subscription_item_id, r.subscription_id)::text AS item_id, r.company_id::text AS company_id,
				to_char(r.period_month, 'YYYY-MM') AS period, ${amount} AS recognized
			FROM revenue_schedule_monthly r ${JOINS}
			WHERE ${where.join(' AND ')}
			GROUP BY 1, 2, 3, 4`,
			params.values
		);
		const out: RevenueItemMonth[] = [];
		let missing = 0;

		for (const row of rows) {
			if (row.recognized === null || row.recognized === undefined) {
				missing += 1;
				continue;
			}
			out.push({
				contractId: String(row.contract_id),
				itemId: String(row.item_id),
				companyId: String(row.company_id),
				period: String(row.period),
				recognized: num(row.recognized),
				billed: 0,
				recognizedCum: 0,
				billedCum: 0,
			});
		}

		return { rows: out, missing };
	}

	/** Reconocido o facturado por dimensión y mes, top N + "Otros". */
	async byDimension(holdingId: string, query: RevenueDimensionDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const s = suffix(currency.mode);
		const dimension = query.dimension ?? 'client';
		const measure = query.measure ?? 'recognized';
		const column = `r.${measure === 'billed' ? 'billed_period' : 'recognized_period'}${s}`;
		const params = new SqlParams();
		const where = this.where(holdingId, query, params, from, to);
		const dim = DIMENSION_SQL[dimension];
		const rows = await this.data.query(
			`SELECT ${dim.key} AS key, ${dim.label} AS label, to_char(r.period_month, 'YYYY-MM') AS period, SUM(${column}) AS value
			FROM revenue_schedule_monthly r ${JOINS}
			WHERE ${where.join(' AND ')} AND NOT ${unconvertedSql(currency.mode, column)}
			GROUP BY ${dim.key}, r.period_month`,
			params.values
		);
		const groups = new Map<string, { key: string; label: string; values: number[] }>();

		for (const row of rows) {
			const key = str(row.key) ?? '—';
			const group = groups.get(key) ?? { key, label: str(row.label) ?? 'Sin dato', values: months.map(() => 0) };
			const index = months.indexOf(String(row.period));

			if (index >= 0) group.values[index] += num(row.value);
			groups.set(key, group);
		}

		const totalOf = (values: number[]) => values.reduce((s2, v) => s2 + v, 0);
		const sorted = [...groups.values()].sort((a, b) => totalOf(b.values) - totalOf(a.values));
		const top = query.top ?? 10;
		const rest = sorted.slice(top);
		const finalize = (g: { key: string; label: string; values: number[] }) => ({
			key: g.key,
			label: g.label,
			values: g.values.map(round2),
			total: round2(totalOf(g.values)),
		});

		return {
			currency: currency.code,
			dimension,
			measure,
			periods: months,
			rows: sorted.slice(0, top).map(finalize),
			others: rest.length
				? finalize({
						key: 'others',
						label: `Otros (${rest.length})`,
						values: months.map((_, i) => rest.reduce((sum, g) => sum + g.values[i], 0)),
					})
				: null,
			totals: months.map((_, i) => round2(sorted.reduce((sum, g) => sum + g.values[i], 0))),
		};
	}

	/** Detalle mensual paginado: período × contrato × ítem con las tres monedas (también sirve para "explicar esta cifra"). */
	async schedule(holdingId: string, query: RevenueScheduleDto) {
		const { from, to } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const s = suffix(currency.mode);
		const params = new SqlParams();
		const where = this.where(holdingId, query, params, from, to);

		if (query.search) {
			const p = params.add(`%${query.search.replace(/[%_]/g, '')}%`);

			where.push(`(c.contract_number ILIKE ${p} OR cl.name_commercial ILIKE ${p} OR COALESCE(ci.product_name, r.product_name) ILIKE ${p})`);
		}
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;
		const order = `${SCHEDULE_SORT[query.sortBy ?? 'period']} ${query.sortOrder === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, r.id`;
		const unconv = unconvertedSql(currency.mode, `r.recognized_period${s}`);
		const base = `FROM revenue_schedule_monthly r ${JOINS} WHERE ${where.join(' AND ')}`;
		const [rows, [totals]] = await Promise.all([
			this.data.query(
				`SELECT r.id::text AS id, to_char(r.period_month, 'YYYY-MM') AS period, r.momentum,
					COALESCE(r.contract_id, r.subscription_id)::text AS contract_id, c.contract_number,
					CASE WHEN r.contract_id IS NOT NULL THEN 'contract' ELSE 'subscription' END AS source,
					cl.id::text AS client_id, cl.name_commercial AS client_name, cl.country AS client_country,
					ce.legal_name AS entity_name, ce.country AS entity_country, co.legal_name AS company_name,
					COALESCE(ci.product_name, r.product_name) AS product,
					r.contract_currency, r.company_currency, r.system_currency,
					r.recognized_period_contract_ccy, r.recognized_period_ccy, r.recognized_period_system_ccy,
					r.billed_period_contract_ccy, r.billed_period_ccy, r.billed_period_system_ccy,
					r.deferred_balance_eom_contract_ccy, r.deferred_balance_eom_ccy, r.deferred_balance_eom_system_ccy,
					r.unbilled_balance_eom_contract_ccy, r.unbilled_balance_eom_ccy, r.unbilled_balance_eom_system_ccy,
					r.mrr_period_contracted_contract_ccy, r.mrr_period_contracted_ccy, r.mrr_period_contracted_system_ccy,
					r.cmrr_period_contract_ccy, r.cmrr_period_ccy, r.cmrr_period_system_ccy,
					r.fx_to_company_source, r.fx_to_system_source, r.calc_version,
					r.recognized_period${s} AS recognized, r.billed_period${s} AS billed,
					r.deferred_balance_eom${s} AS deferred_eom, r.unbilled_balance_eom${s} AS unbilled_eom, r.mrr_period_contracted${s} AS mrr,
					${realGapSql(unconv)} AS unconverted
				${base}
				ORDER BY ${order}
				LIMIT ${Number(limit)} OFFSET ${(page - 1) * Number(limit)}`,
				params.values
			),
			this.data.query(
				`SELECT COUNT(*) AS n,
					SUM(r.recognized_period${s}) FILTER (WHERE NOT ${unconv}) AS recognized,
					SUM(r.billed_period${s}) FILTER (WHERE NOT ${unconv}) AS billed,
					COUNT(*) FILTER (WHERE ${realGapSql(unconv)}) AS unconverted
				${base}`,
				params.values
			),
		]);
		const money = (value: unknown) => (value === null || value === undefined ? null : round2(Number(value)));
		const n = num(totals?.n);

		return {
			data: rows.map((row) => ({
				id: String(row.id),
				period: String(row.period),
				momentum: str(row.momentum),
				source: String(row.source),
				contract_id: str(row.contract_id),
				contract_number: str(row.contract_number),
				client_id: str(row.client_id),
				client_name: str(row.client_name),
				client_country: str(row.client_country),
				entity_name: str(row.entity_name),
				entity_country: str(row.entity_country),
				company_name: str(row.company_name),
				product: str(row.product),
				currencies: { contract: str(row.contract_currency), company: str(row.company_currency), system: str(row.system_currency) },
				amounts: {
					contract: this.amountsOf(row, '_contract_ccy', money),
					company: this.amountsOf(row, '_ccy', money),
					system: this.amountsOf(row, '_system_ccy', money),
				},
				recognized: money(row.recognized),
				billed: money(row.billed),
				deferred_eom: money(row.deferred_eom),
				unbilled_eom: money(row.unbilled_eom),
				mrr: money(row.mrr),
				fx_source: { company: str(row.fx_to_company_source), system: str(row.fx_to_system_source) },
				calc_version: str(row.calc_version),
				unconverted: Boolean(row.unconverted),
			})),
			items: n,
			pages: Math.max(1, Math.ceil(n / Number(limit))),
			currentPage: page,
			limit,
			currency: currency.code,
			totals: { recognized: money(totals?.recognized) ?? 0, billed: money(totals?.billed) ?? 0, unconverted_rows: num(totals?.unconverted) },
		};
	}

	private amountsOf(row: Row, s: string, money: (value: unknown) => number | null) {
		return {
			recognized: money(row[`recognized_period${s}`]),
			billed: money(row[`billed_period${s}`]),
			deferred_eom: money(row[`deferred_balance_eom${s}`]),
			unbilled_eom: money(row[`unbilled_balance_eom${s}`]),
			mrr: money(row[`mrr_period_contracted${s}`]),
			cmrr: money(row[`cmrr_period${s}`]),
		};
	}

	/** Asientos del reconocimiento por mes de UNA compañía en su moneda, con las cuentas de `company_account_mappings` (§3). */
	async journal(holdingId: string, query: RevenueJournalDto) {
		const companies = query.companyId?.split(',').filter(Boolean) ?? [];

		if (companies.length !== 1) {
			throw new BadRequestException({
				message: 'Asientos por compañía',
				errors: [{ field: 'companyId', message: 'Elige una compañía: los asientos van en su moneda' }],
			});
		}
		const { to, months } = resolveRange(query.from, query.to);
		const filters = { ...query, currency: 'company' as const };
		const currency = await this.data.resolveCurrency(holdingId, filters);
		const [{ rows, unconverted }, [company], [mapping], cutoffs] = await Promise.all([
			this.rows(holdingId, filters, currency, to),
			this.data.query(`SELECT id::text AS id, legal_name FROM companies WHERE id = $1 AND holding_id = $2`, [companies[0], holdingId]),
			this.data.query(`SELECT * FROM company_account_mappings WHERE company_id = $1 LIMIT 1`, [companies[0]]),
			this.cutoffs(holdingId, companies[0]),
		]);
		const cutoff = cutoffs[0]?.cutoff_date ?? null;
		const accounts = {
			revenue: { code: str(mapping?.revenue_account_code), name: str(mapping?.revenue_account_name) ?? 'Ingresos' },
			deferred: { code: str(mapping?.deferred_account_code), name: str(mapping?.deferred_account_name) ?? 'Ingresos diferidos' },
			unbilled: { code: str(mapping?.unbilled_account_code), name: str(mapping?.unbilled_account_name) ?? 'Ingresos por facturar' },
			configured: Boolean(mapping),
		};

		return {
			company: { id: companies[0], name: str(company?.legal_name) },
			currency: currency.code,
			accounts,
			cutoff_date: cutoff,
			months: journalMonths(rows, months).map((month) => ({
				...month,
				closed: Boolean(cutoff && lastDay(month.period) <= cutoff),
				entries: month.entries.map((entry) => ({ ...entry, code: accounts[entry.account].code, name: accounts[entry.account].name })),
			})),
			unconverted,
		};
	}

	/** Excepciones de calidad del devengo (§3 `revenue/exceptions`), con enlace al contrato. */
	async exceptions(holdingId: string, query: ExceptionsDto) {
		const current = currentMonth();
		const horizon = monthStart(addMonths(current, 12));
		const [fxMissing, noSchedule, noMapping, legacyGap, changedClosed] = await Promise.all([
			this.data.query(
				`SELECT c.id::text AS contract_id, c.contract_number, cl.name_commercial AS client_name, co.legal_name AS company_name,
					MIN(to_char(r.period_month, 'YYYY-MM')) AS period, COUNT(*) AS n,
					BOOL_OR(r.calc_version = 'missing_fx_rate') AS item_fx
				FROM revenue_schedule_monthly r JOIN contracts c ON c.id = r.contract_id
				LEFT JOIN contract_items ci ON ci.id = r.contract_item_id
				LEFT JOIN clients cl ON cl.id = c.client_id LEFT JOIN companies co ON co.id = r.company_id
				WHERE r.holding_id = $1 AND r.period_month <= $2::date AND c.deleted_at IS NULL
					AND (r.calc_version = 'missing_fx_rate' OR COALESCE(r.fx_to_system_source, '') LIKE 'missing_fx_rate%' OR COALESCE(r.fx_to_company_source, '') LIKE 'missing_fx_rate%')
					-- Un mes inactivo del ítem sin montos no es un hueco (misma regla que el rebuild, v0.0.69); los huecos reales se mantienen.
					AND NOT ${inactiveEmptyRowSql()}
				GROUP BY 1, 2, 3, 4`,
				[holdingId, horizon]
			),
			this.data.query(
				`SELECT c.id::text AS contract_id, c.contract_number, cl.name_commercial AS client_name, co.legal_name AS company_name
				FROM contracts c LEFT JOIN clients cl ON cl.id = c.client_id LEFT JOIN companies co ON co.id = c.company_id
				WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND c.status = 'Activo'
					AND EXISTS (SELECT 1 FROM invoices i WHERE i.contract_id = c.id AND i.is_active AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida'))
					AND NOT EXISTS (SELECT 1 FROM revenue_schedule_monthly r WHERE r.contract_id = c.id)`,
				[holdingId]
			),
			this.data.query(
				`SELECT co.id::text AS company_id, co.legal_name AS company_name
				FROM companies co
				WHERE co.holding_id = $1 AND NOT EXISTS (SELECT 1 FROM company_account_mappings m WHERE m.company_id = co.id)
					AND EXISTS (SELECT 1 FROM revenue_schedule_monthly r WHERE r.company_id = co.id AND r.holding_id = $1)`,
				[holdingId]
			),
			this.data.query(
				`WITH legacy_end AS (
					SELECT m.client_id, MAX(m.period_month) AS last_month
					FROM mrr_legacy m
					WHERE m.holding_id = $1 AND COALESCE(m.is_recurring, false) AND m.migrated_to_contract_id IS NULL
					GROUP BY m.client_id
				), first_contract AS (
					SELECT c.client_id, c.id, c.contract_number, MIN(r.period_month) AS first_month
					FROM revenue_schedule_monthly r JOIN contracts c ON c.id = r.contract_id
					WHERE r.holding_id = $1 AND r.mrr_period_contracted_contract_ccy > 0 AND c.deleted_at IS NULL
					GROUP BY c.client_id, c.id, c.contract_number
				)
				SELECT f.id::text AS contract_id, f.contract_number, cl.name_commercial AS client_name, to_char(f.first_month, 'YYYY-MM') AS period
				FROM legacy_end l
				JOIN first_contract f ON f.client_id = l.client_id AND f.first_month = (l.last_month + interval '1 month')::date
				LEFT JOIN clients cl ON cl.id = l.client_id
				WHERE NOT EXISTS (SELECT 1 FROM mrr_legacy m2 WHERE m2.migrated_to_contract_id = f.id)`,
				[holdingId]
			),
			this.data.query(
				`SELECT co.legal_name AS company_name, c.id::text AS contract_id, c.contract_number, cl.name_commercial AS client_name,
					MIN(to_char(r.period_month, 'YYYY-MM')) AS period, COUNT(*) AS n
				FROM revenue_schedule_monthly r
				JOIN accounting_period_cutoff apc ON apc.company_id = r.company_id AND apc.holding_id = r.holding_id
				LEFT JOIN contracts c ON c.id = r.contract_id LEFT JOIN clients cl ON cl.id = c.client_id
				LEFT JOIN companies co ON co.id = r.company_id
				WHERE r.holding_id = $1 AND r.period_month <= apc.cutoff_date AND apc.last_action_at IS NOT NULL AND r.updated_at > apc.last_action_at
				GROUP BY 1, 2, 3, 4`,
				[holdingId]
			),
		]);
		const items = [
			...fxMissing.map((row) => ({
				type: 'fx_missing',
				severity: 'error',
				message: row.item_fx
					? 'Falta la tasa pactada ítem → contrato: estos meses no entran a los totales'
					: 'Falta tipo de cambio a la moneda de compañía o sistema',
				contract_id: str(row.contract_id),
				contract_number: str(row.contract_number),
				client_name: str(row.client_name),
				company_name: str(row.company_name),
				period: str(row.period),
				count: num(row.n),
			})),
			...noSchedule.map((row) => ({
				type: 'no_schedule',
				severity: 'error',
				message: 'Contrato activo con facturas emitidas y sin devengo',
				contract_id: str(row.contract_id),
				contract_number: str(row.contract_number),
				client_name: str(row.client_name),
				company_name: str(row.company_name),
				period: null,
				count: 1,
			})),
			...noMapping.map((row) => ({
				type: 'no_account_mapping',
				severity: 'warning',
				message: 'Compañía sin cuentas contables configuradas: los asientos salen sin código',
				contract_id: null,
				contract_number: null,
				client_name: null,
				company_name: str(row.company_name),
				period: null,
				count: 1,
			})),
			...legacyGap.map((row) => ({
				type: 'legacy_unlinked',
				severity: 'warning',
				message:
					'El legacy del cliente termina el mes anterior al inicio de este contrato y no están vinculados: Métricas lo ve como baja + nuevo',
				contract_id: str(row.contract_id),
				contract_number: str(row.contract_number),
				client_name: str(row.client_name),
				company_name: null,
				period: str(row.period),
				count: 1,
			})),
			...changedClosed.map((row) => ({
				type: 'changed_after_close',
				severity: 'warning',
				message: 'Devengo recalculado en meses ya cerrados',
				contract_id: str(row.contract_id),
				contract_number: str(row.contract_number),
				client_name: str(row.client_name),
				company_name: str(row.company_name),
				period: str(row.period),
				count: num(row.n),
			})),
		];
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;

		return {
			data: items.slice((page - 1) * limit, page * limit),
			items: items.length,
			pages: Math.max(1, Math.ceil(items.length / limit)),
			currentPage: page,
			limit,
			counts: items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {}),
		};
	}
}
