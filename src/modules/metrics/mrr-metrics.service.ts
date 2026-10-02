import { Injectable } from '@nestjs/common';

import { CATEGORY_INFO, FORMULAS, KEY_LABELS, MOVEMENT_CATEGORIES } from './metrics-categories';
import { type CurrencyContext, MetricsDataService, PENDING, SqlParams } from './metrics-data.service';
import { addMonths, currentMonth, type Month, MONTH_RE, monthRange, monthStart, resolveRange } from './metrics-period';
import {
	buildCohorts,
	buildWaterfall,
	classifyMonth,
	clientActivity,
	logoStats,
	type Movement,
	type MrrLine,
	periodIndicators,
	retentionOf,
	splitUnconverted,
	totalAt,
	valueAt,
	yoyRetention,
} from './mrr-movements';

import type {
	BookingsDto,
	ChurnDetailDto,
	CohortsDto,
	MetricsFiltersDto,
	MovementDetailDto,
	MrrBasisDto,
	MrrDimensionDto,
	MrrOverviewDto,
	RenewalsDto,
} from './dtos/query-metrics.dto';

type Row = Record<string, unknown>;

const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (value: unknown) => Number(value ?? 0) || 0;
/** Primer mes de historia que se lee para clientes y cohortes. */
const HISTORY_START: Month = '2015-01';

/**
 * Condición de ventana de Renovaciones. Cada parámetro se agrega **solo** si la condición lo usa: un `$n` sin referencia en el SQL
 * hace fallar a Postgres ("could not determine data type of parameter $n", 500). Era el error de las ventanas 30/90/180/365, que
 * agregaban el mes actual (solo lo usa "vencidos") sin referenciarlo.
 */
export function renewalWindowSql(window: NonNullable<RenewalsDto['window']>, params: SqlParams, today = currentMonth()): string {
	return window === 'overdue'
		? `EXISTS (SELECT 1 FROM revenue_schedule_monthly p WHERE p.contract_item_id = ci.id AND p.momentum = '${PENDING}' AND p.period_month = ${params.add(monthStart(today))}::date)`
		: `ci.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ${params.add(Number(window))}::int`;
}

/** Métricas de MRR (spec-revenue-y-metricas §1.2–1.6, §1.8, §3 Métricas). Solo lectura. */
@Injectable()
export class MrrMetricsService {
	constructor(private readonly data: MetricsDataService) {}

	/** Líneas convertidas del rango y lo que quedó fuera (§1.3). */
	private async lines(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, basis: 'mrr' | 'cmrr', from: Month, to: Month) {
		const loaded = await this.data.loadMrrLines(holdingId, filters, currency, basis, from, to);
		const { converted, unconverted } = splitUnconverted(loaded.lines, monthRange(from, to));

		return {
			lines: converted,
			unconverted: this.data.summarizeUnconverted({
				lines: unconverted,
				itemFxMissing: loaded.itemFxMissing,
				currency,
				legacyCompanyRows: loaded.legacyCompanyRows,
			}),
		};
	}

	/** Primer mes con datos del holding (devengo o legacy), para leer la historia completa de clientes y cohortes. */
	private async firstMonth(holdingId: string): Promise<Month> {
		const [row] = await this.data.query(
			`SELECT to_char(LEAST(
				(SELECT MIN(period_month) FROM revenue_schedule_monthly WHERE holding_id = $1),
				(SELECT MIN(period_month) FROM mrr_legacy WHERE holding_id = $1)
			), 'YYYY-MM') AS first`,
			[holdingId]
		);
		const first = row?.first ? String(row.first) : null;

		return first && MONTH_RE.test(first) && first > HISTORY_START ? first : HISTORY_START;
	}

	/** KPIs del mes de corte con su valor anterior y sparkline de 12 meses (§3 `mrr/overview`). */
	async overview(holdingId: string, query: MrrOverviewDto) {
		const asOf = query.asOf ?? currentMonth();
		const currency = await this.data.resolveCurrency(holdingId, query);
		const from = addMonths(asOf, -13);
		const prevMonth = addMonths(asOf, -1);
		const [mrr, cmrr, asOfStamp, pending] = await Promise.all([
			this.lines(holdingId, query, currency, 'mrr', from, asOf),
			this.lines(holdingId, query, currency, 'cmrr', from, asOf),
			this.data.asOf(holdingId),
			this.data.loadPendingRenewal(holdingId, query, currency, [prevMonth, asOf]),
		]);
		const waterfall = buildWaterfall(mrr.lines, [prevMonth, asOf], { currency: currency.mode });
		const indicatorsOf = (index: number) => periodIndicators(retentionOf([waterfall.months[index]]));
		const now = indicatorsOf(1);
		const before = indicatorsOf(0);
		const logos = logoStats(mrr.lines, asOf);
		const logosPrev = logoStats(mrr.lines, prevMonth);
		const yoy = yoyRetention(mrr.lines, asOf);
		const yoyPrev = yoyRetention(mrr.lines, prevMonth);
		// Misma regla que el KPI "Por renovar" de Contratos: filas RSM PENDING_RENEWAL del mes (no las líneas convertidas del rango).
		const pendingNow = pending.get(asOf) ?? { mrr: 0, cmrr: 0, items: 0, clients: 0, contracts: 0 };
		const kpi = (value: number | null, previous: number | null, formula: string) => ({
			value,
			previous,
			delta: value === null || previous === null ? null : round2(value - previous),
			formula: FORMULAS[formula],
		});
		const mrrNow = totalAt(mrr.lines, asOf);
		const mrrPrev = totalAt(mrr.lines, prevMonth);
		const cmrrNow = totalAt(cmrr.lines, asOf);
		const cmrrPrev = totalAt(cmrr.lines, prevMonth);
		const sparkMonths = monthRange(addMonths(asOf, -11), asOf);

		return {
			currency: currency.code,
			as_of: asOf,
			calculated_at: asOfStamp,
			kpis: {
				mrr: kpi(mrrNow, mrrPrev, 'mrr'),
				arr: kpi(round2(mrrNow * 12), round2(mrrPrev * 12), 'arr'),
				cmrr: kpi(cmrrNow, cmrrPrev, 'cmrr'),
				carr: kpi(round2(cmrrNow * 12), round2(cmrrPrev * 12), 'carr'),
				pending_renewal: {
					...pendingNow,
					previous: pending.get(prevMonth)?.mrr ?? 0,
					formula: FORMULAS.pending_renewal,
				},
				active_clients: kpi(logos.active, logosPrev.active, 'active_clients'),
				arpa: kpi(logos.active ? round2(mrrNow / logos.active) : null, logosPrev.active ? round2(mrrPrev / logosPrev.active) : null, 'arpa'),
				net_new_mrr: kpi(now.net_new_mrr, before.net_new_mrr, 'net_new_mrr'),
				growth: kpi(now.growth, before.growth, 'growth'),
				gross_mrr_churn: kpi(now.gross_mrr_churn, before.gross_mrr_churn, 'gross_mrr_churn'),
				net_mrr_churn: kpi(now.net_mrr_churn, before.net_mrr_churn, 'net_mrr_churn'),
				logo_churn: kpi(logos.logoChurn, logosPrev.logoChurn, 'logo_churn'),
				nrr: kpi(now.nrr, before.nrr, 'nrr'),
				grr: kpi(now.grr, before.grr, 'grr'),
				nrr_yoy: kpi(yoy.nrr, yoyPrev.nrr, 'nrr_yoy'),
				grr_yoy: kpi(yoy.grr, yoyPrev.grr, 'grr_yoy'),
				quick_ratio: kpi(now.quick_ratio, before.quick_ratio, 'quick_ratio'),
			},
			sparklines: {
				months: sparkMonths,
				mrr: sparkMonths.map((month) => totalAt(mrr.lines, month)),
				cmrr: sparkMonths.map((month) => totalAt(cmrr.lines, month)),
				active_clients: sparkMonths.map((month) => logoStats(mrr.lines, month).active),
			},
			unconverted: mrr.unconverted,
		};
	}

	/** Movimientos de MRR por mes (alimentan el gráfico de movimientos, el puente y la tabla, §1.4). */
	async movements(holdingId: string, query: MrrBasisDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const { lines, unconverted } = await this.lines(holdingId, query, currency, query.basis ?? 'mrr', addMonths(from, -1), to);
		const waterfall = buildWaterfall(lines, months, { currency: currency.mode });
		const current = currentMonth();
		const retention = retentionOf(waterfall.months);

		return {
			currency: currency.code,
			basis: query.basis ?? 'mrr',
			categories: MOVEMENT_CATEGORIES.map((key) => ({
				...CATEGORY_INFO[key],
				subkeys: [...new Set(waterfall.months.flatMap((month) => month.movements.filter((m) => m.category === key).map((m) => m.key)))],
			})),
			key_labels: KEY_LABELS,
			months: waterfall.months.map((month) => ({ ...month, partial: month.period === current })),
			bridge: { from, to, ...retention, indicators: periodIndicators(retention) },
			unconverted,
		};
	}

	/** Detalle de los movimientos (drill-down): por ítem, contrato, cliente, segmento o mercado, paginado. */
	async movementDetail(holdingId: string, query: MovementDetailDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const { lines, unconverted } = await this.lines(holdingId, query, currency, query.basis ?? 'mrr', addMonths(from, -1), to);
		const categories = query.category?.split(',');
		const keys = query.key?.split(',');
		const movements = months
			.flatMap((month) => classifyMonth(lines, month, { currency: currency.mode }))
			.filter((m) => (!categories || categories.includes(m.category)) && (!keys || keys.includes(m.key)));
		const groupBy = query.groupBy ?? 'item';
		const groupKey = (m: Movement) => {
			const l = m.line;

			switch (groupBy) {
				case 'client':
					return l.clientId ?? '—';
				case 'contract':
					return l.contractId ?? l.key;
				case 'segment':
					return l.segment ?? 'Sin segmento';
				case 'market':
					return l.market ?? 'Sin mercado';
				default:
					return `${l.key}|${m.period}|${m.key}`;
			}
		};
		const groups = new Map<string, { movement: Movement; amount: number; items: Set<string>; periods: Set<Month>; keys: Set<string> }>();

		for (const m of movements) {
			const id = groupKey(m);
			const group = groups.get(id) ?? { movement: m, amount: 0, items: new Set(), periods: new Set(), keys: new Set() };

			group.amount += m.amount;
			group.items.add(m.line.key);
			group.periods.add(m.period);
			group.keys.add(m.key);
			groups.set(id, group);
		}

		const rows = [...groups.entries()]
			.map(([id, g]) => {
				const l = g.movement.line;

				return {
					id,
					period: g.periods.size === 1 ? g.movement.period : null,
					category: g.movement.category,
					keys: [...g.keys],
					amount: round2(g.amount),
					items: g.items.size,
					source: groupBy === 'item' ? l.source : null,
					client_id: ['item', 'contract', 'client'].includes(groupBy) ? l.clientId : null,
					client_name: ['item', 'contract', 'client'].includes(groupBy) ? l.clientName : null,
					segment: groupBy === 'segment' ? id : ['item', 'contract', 'client'].includes(groupBy) ? l.segment : null,
					market: groupBy === 'market' ? id : ['item', 'contract', 'client'].includes(groupBy) ? l.market : null,
					contract_id: ['item', 'contract'].includes(groupBy) ? l.contractId : null,
					contract_number: ['item', 'contract'].includes(groupBy) ? l.contractNumber : null,
					product: groupBy === 'item' ? l.product : null,
				};
			})
			.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;

		return {
			data: rows.slice((page - 1) * limit, page * limit),
			items: rows.length,
			pages: Math.max(1, Math.ceil(rows.length / limit)),
			currentPage: page,
			limit,
			currency: currency.code,
			total_amount: round2(rows.reduce((sum, row) => sum + row.amount, 0)),
			unconverted,
		};
	}

	/** MRR por dimensión y mes, top N + "Otros", con el pendiente de renovar del último mes en columna aparte. */
	async byDimension(holdingId: string, query: MrrDimensionDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const [{ lines, unconverted }, pendingTotal] = await Promise.all([
			this.lines(holdingId, query, currency, query.basis ?? 'mrr', from, to),
			this.data.loadPendingRenewal(holdingId, query, currency, [to]),
		]);
		const dimension = query.dimension ?? 'client';
		const labelOf = (line: MrrLine): [string, string] => {
			switch (dimension) {
				case 'client':
					return [line.clientId ?? '—', line.clientName ?? 'Sin cliente'];
				case 'product':
					return [line.product ?? '—', line.product ?? 'Sin producto'];
				case 'company':
					return [line.companyId ?? '—', line.companyName ?? 'Sin compañía'];
				case 'item_type':
					return [line.itemType ?? '—', line.itemType ?? (line.source === 'contract' ? 'Sin tipo' : sourceLabel(line.source))];
				case 'unit_of_measure':
					return [line.unitOfMeasure ?? '—', line.unitOfMeasure ?? (line.source === 'contract' ? 'Sin unidad' : sourceLabel(line.source))];
				case 'source':
					return [line.source, sourceLabel(line.source)];
				default: {
					const value = line[dimension as 'segment' | 'market' | 'industry' | 'country'];

					return [value ?? '—', value ?? 'Sin dato'];
				}
			}
		};
		const rows = new Map<string, { key: string; label: string; values: number[]; pending: number }>();

		for (const line of lines) {
			const [key, label] = labelOf(line);
			const row = rows.get(key) ?? { key, label, values: months.map(() => 0), pending: 0 };

			months.forEach((month, index) => (row.values[index] += valueAt(line, month)));
			row.pending += line.months.get(to)?.pending ?? 0;
			rows.set(key, row);
		}

		const sorted = [...rows.values()].sort((a, b) => b.values[b.values.length - 1] - a.values[a.values.length - 1]);
		const top = query.top ?? 15;
		const shown = sorted.slice(0, top);
		const rest = sorted.slice(top);
		const finalize = (row: { key: string; label: string; values: number[]; pending: number }) => ({
			key: row.key,
			label: row.label,
			values: row.values.map(round2),
			total: round2(row.values[row.values.length - 1] ?? 0),
			pending_renewal: round2(row.pending),
		});

		return {
			currency: currency.code,
			dimension,
			periods: months,
			rows: shown.map(finalize),
			others: rest.length
				? finalize({
						key: 'others',
						label: `Otros (${rest.length})`,
						values: months.map((_, i) => rest.reduce((s, r) => s + r.values[i], 0)),
						pending: rest.reduce((s, r) => s + r.pending, 0),
					})
				: null,
			totals: months.map((month) => totalAt(lines, month)),
			pending_renewal_total: (() => {
				const month = pendingTotal.get(to);

				return month ? ((query.basis ?? 'mrr') === 'cmrr' ? month.cmrr : month.mrr) : 0;
			})(),
			unconverted,
		};
	}

	/** Clientes activos, nuevos, reactivados y perdidos por mes (historia completa para saber quién es nuevo). */
	async clientActivity(holdingId: string, query: MetricsFiltersDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const start = await this.firstMonth(holdingId);
		const historyStart = start < from ? start : addMonths(from, -1);
		const { lines, unconverted } = await this.lines(holdingId, query, currency, 'mrr', historyStart, to);

		return { currency: currency.code, months: clientActivity(lines, monthRange(historyStart, to), months), unconverted };
	}

	/** Churn y contracción por mes, por motivo y detalle por cliente (§1.5). */
	async churn(holdingId: string, query: ChurnDetailDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const { lines, unconverted } = await this.lines(holdingId, query, currency, 'mrr', addMonths(from, -1), to);
		const movements = months.flatMap((month) => classifyMonth(lines, month, { currency: currency.mode }));
		const reasons = await this.churnReasons(holdingId, [
			...new Set(
				movements
					.filter((m) => m.category === 'churn')
					.map((m) => m.line.contractId)
					.filter(Boolean) as string[]
			),
		]);
		const byMonth = months.map((month) => {
			const inMonth = movements.filter((m) => m.period === month);
			const logos = logoStats(lines, month);

			return {
				period: month,
				clients_lost: logos.lost,
				mrr_lost: round2(-inMonth.filter((m) => m.category === 'churn').reduce((s, m) => s + m.amount, 0)),
				contraction: round2(-inMonth.filter((m) => m.category === 'contraction').reduce((s, m) => s + m.amount, 0)),
			};
		});
		const reasonOf = (m: Movement) =>
			m.line.source === 'legacy' ? 'Legacy sin contrato' : (reasons.get(m.line.contractId ?? '') ?? 'Sin motivo');
		const churnMovements = movements.filter((m) => m.category === 'churn');
		const byReason = new Map<string, { clients: Set<string>; mrr: number }>();

		for (const m of churnMovements) {
			const reason = reasonOf(m);
			const entry = byReason.get(reason) ?? { clients: new Set(), mrr: 0 };

			if (m.line.clientId) entry.clients.add(m.line.clientId);
			entry.mrr -= m.amount;
			byReason.set(reason, entry);
		}

		const totalLost = [...byReason.values()].reduce((s, r) => s + r.mrr, 0);
		const detail = churnMovements
			.concat(movements.filter((m) => m.category === 'contraction'))
			.map((m) => ({
				period: m.period,
				category: m.category,
				key: m.key,
				client_id: m.line.clientId,
				client_name: m.line.clientName,
				segment: m.line.segment,
				market: m.line.market,
				contract_id: m.line.contractId,
				contract_number: m.line.contractNumber,
				product: m.line.product,
				reason: m.category === 'churn' ? reasonOf(m) : null,
				amount: m.amount,
			}))
			.sort((a, b) => (a.period === b.period ? a.amount - b.amount : a.period < b.period ? 1 : -1));
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;

		return {
			currency: currency.code,
			months: byMonth,
			by_reason: [...byReason.entries()]
				.map(([reason, r]) => ({ reason, clients: r.clients.size, mrr: round2(r.mrr), pct: totalLost > 0 ? r.mrr / totalLost : null }))
				.sort((a, b) => b.mrr - a.mrr),
			data: detail.slice((page - 1) * limit, page * limit),
			items: detail.length,
			pages: Math.max(1, Math.ceil(detail.length / limit)),
			currentPage: page,
			limit,
			unconverted,
		};
	}

	private async churnReasons(holdingId: string, contractIds: string[]): Promise<Map<string, string>> {
		if (!contractIds.length) return new Map();
		const rows = await this.data.query(
			`SELECT c.id::text AS id, COALESCE(cr.name, NULLIF(TRIM(c.churn_reason), '')) AS reason
			FROM contracts c LEFT JOIN churn_reasons cr ON cr.id = c.churn_reason_id
			WHERE c.holding_id = $1 AND c.id = ANY($2::uuid[])`,
			[holdingId, contractIds]
		);

		return new Map(rows.filter((row) => row.reason).map((row) => [String(row.id), String(row.reason)]));
	}

	/**
	 * Renovaciones (nativo B2B): ítems recurrentes que vencen en los próximos N días sin renovación ni baja, o vencidos sin decisión
	 * (filas `PENDING_RENEWAL` del mes actual). MRR del último mes vigente del ítem en la moneda leída.
	 */
	async renewals(holdingId: string, query: RenewalsDto) {
		const currency = await this.data.resolveCurrency(holdingId, query);
		const s = currency.mode === 'system' ? '_system_ccy' : currency.mode === 'company' ? '_ccy' : '_contract_ccy';
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const window = query.window ?? '90';
		const extra: string[] = [];
		const add = (values: string | undefined, sql: (p: string) => string) => {
			const list = values?.split(',').filter(Boolean) ?? [];

			if (list.length) extra.push(sql(params.add(list)));
		};

		add(query.companyId, (p) => `c.company_id = ANY(${p}::uuid[])`);
		add(query.clientId, (p) => `c.client_id = ANY(${p}::uuid[])`);
		add(query.contractId, (p) => `c.id = ANY(${p}::uuid[])`);
		add(query.product, (p) => `ci.product_name = ANY(${p}::text[])`);
		add(query.segment, (p) => `cl.segment = ANY(${p}::text[])`);
		add(query.market, (p) => `cl.market = ANY(${p}::text[])`);
		add(query.industry, (p) => `cl.industry = ANY(${p}::text[])`);
		add(query.country, (p) => `cl.country = ANY(${p}::text[])`);
		const rows = await this.data.query(
			`WITH items AS (
				SELECT ci.id AS item_id, ci.contract_id, ci.product_name, ci.end_date, c.contract_number, c.client_id, cl.name_commercial AS client_name,
					cl.segment, cl.market, c.company_id, co.legal_name AS company_name
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				LEFT JOIN clients cl ON cl.id = c.client_id
				LEFT JOIN companies co ON co.id = c.company_id
				WHERE c.holding_id = ${holding} AND c.deleted_at IS NULL AND c.status = 'Activo'
					AND COALESCE(ci.is_recurring, false) AND ci.end_date IS NOT NULL AND ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL
					AND COALESCE(ci.categoria, '') NOT IN ('DOWNSELL', 'CHURN')
					${extra.map((condition) => `AND ${condition}`).join(' ')}
					AND ${renewalWindowSql(window, params)}
			)
			SELECT i.*, (CURRENT_DATE - i.end_date) AS days,
				(SELECT r.mrr_period_contracted${s} FROM revenue_schedule_monthly r
					WHERE r.contract_item_id = i.item_id AND r.momentum IS DISTINCT FROM '${PENDING}' AND r.mrr_period_contracted${s} IS NOT NULL
						AND r.mrr_period_contracted${s} <> 0
					ORDER BY r.period_month DESC LIMIT 1) AS mrr
			FROM items i
			ORDER BY i.end_date ASC`,
			params.values
		);
		const data = rows.map((row) => ({
			item_id: String(row.item_id),
			contract_id: String(row.contract_id),
			contract_number: row.contract_number ? String(row.contract_number) : null,
			client_id: row.client_id ? String(row.client_id) : null,
			client_name: row.client_name ? String(row.client_name) : null,
			segment: row.segment ? String(row.segment) : null,
			market: row.market ? String(row.market) : null,
			company_name: row.company_name ? String(row.company_name) : null,
			product: row.product_name ? String(row.product_name) : null,
			end_date: row.end_date
				? String(row.end_date instanceof Date ? row.end_date.toISOString().slice(0, 10) : row.end_date).slice(0, 10)
				: null,
			days: num(row.days),
			mrr: row.mrr === null || row.mrr === undefined ? null : round2(num(row.mrr)),
		}));
		const page = query.page ?? 1;
		const limit = query.limit ?? 50;

		return {
			currency: currency.code,
			window,
			summary: {
				items: data.length,
				contracts: new Set(data.map((row) => row.contract_id)).size,
				clients: new Set(data.map((row) => row.client_id).filter(Boolean)).size,
				mrr: round2(data.reduce((sum, row) => sum + (row.mrr ?? 0), 0)),
			},
			data: data.slice((page - 1) * limit, page * limit),
			items: data.length,
			pages: Math.max(1, Math.ceil(data.length / limit)),
			currentPage: page,
			limit,
		};
	}

	/** Cohortes por primer mes (o trimestre) con MRR > 0 (§1.6). */
	async cohorts(holdingId: string, query: CohortsDto) {
		const { from, to } = resolveRange(query.from, query.to);
		const currency = await this.data.resolveCurrency(holdingId, query);
		const start = await this.firstMonth(holdingId);
		const historyStart = start < from ? start : from;
		const { lines, unconverted } = await this.lines(holdingId, query, currency, 'mrr', historyStart, to);
		const cohorts = buildCohorts(lines, monthRange(historyStart, to), query.basis ?? 'revenue', query.grain ?? 'month').filter((row) =>
			(query.grain ?? 'month') === 'month'
				? row.cohort >= from
				: row.cohort >= `${from.slice(0, 4)}-T${Math.floor((Number(from.slice(5, 7)) - 1) / 3) + 1}`
		);

		return { currency: currency.code, basis: query.basis ?? 'revenue', grain: query.grain ?? 'month', cohorts, unconverted };
	}

	/** TCV firmado por mes de booking (§1.2): `contracts.total_value_system_currency`, contratos no borrador ni borrados. */
	async bookings(holdingId: string, query: BookingsDto) {
		const { from, to, months } = resolveRange(query.from, query.to);
		const currency = await this.data.systemCurrency(holdingId);
		const params = new SqlParams();
		const where = [
			`c.holding_id = ${params.add(holdingId)}`,
			`c.deleted_at IS NULL`,
			`c.status NOT IN ('En revisión', 'Borrador')`,
			`c.booking_date IS NOT NULL`,
			`c.booking_date >= ${params.add(monthStart(from))}::date`,
			`c.booking_date < (${params.add(monthStart(to))}::date + interval '1 month')`,
		];
		const add = (values: string | undefined, sql: (p: string) => string) => {
			const list = values?.split(',').filter(Boolean) ?? [];

			if (list.length) where.push(sql(params.add(list)));
		};

		add(query.companyId, (p) => `c.company_id = ANY(${p}::uuid[])`);
		add(query.clientId, (p) => `c.client_id = ANY(${p}::uuid[])`);
		add(query.segment, (p) => `cl.segment = ANY(${p}::text[])`);
		add(query.market, (p) => `cl.market = ANY(${p}::text[])`);
		add(query.industry, (p) => `cl.industry = ANY(${p}::text[])`);
		add(query.country, (p) => `cl.country = ANY(${p}::text[])`);
		const groupBy = query.groupBy ?? 'month';
		const keySql =
			groupBy === 'company' ? `c.company_id::text` : groupBy === 'client' ? `c.client_id::text` : `to_char(c.booking_date, 'YYYY-MM')`;
		const labelSql =
			groupBy === 'company' ? `MAX(co.legal_name)` : groupBy === 'client' ? `MAX(cl.name_commercial)` : `to_char(c.booking_date, 'YYYY-MM')`;
		const rows = await this.data.query(
			`SELECT ${keySql} AS key, ${labelSql} AS label, COUNT(*) AS contracts,
				SUM(c.total_value_system_currency) FILTER (WHERE c.total_value_system_currency IS NOT NULL) AS tcv,
				COUNT(*) FILTER (WHERE c.total_value_system_currency IS NULL) AS without_value
			FROM contracts c
			LEFT JOIN clients cl ON cl.id = c.client_id
			LEFT JOIN companies co ON co.id = c.company_id
			WHERE ${where.join(' AND ')}
			GROUP BY ${keySql}${groupBy === 'month' ? '' : ''}
			ORDER BY ${groupBy === 'month' ? '1' : 'tcv DESC NULLS LAST'}`,
			params.values
		);
		const mapped = rows.map((row: Row) => ({
			key: String(row.key ?? '—'),
			label: String(row.label ?? 'Sin dato'),
			contracts: num(row.contracts),
			tcv: round2(num(row.tcv)),
			without_value: num(row.without_value),
		}));

		return {
			currency,
			group_by: groupBy,
			rows:
				groupBy === 'month'
					? months.map(
							(month) => mapped.find((row) => row.key === month) ?? { key: month, label: month, contracts: 0, tcv: 0, without_value: 0 }
						)
					: mapped,
			total: round2(mapped.reduce((sum, row) => sum + row.tcv, 0)),
		};
	}
}

const sourceLabel = (source: MrrLine['source']) => (source === 'contract' ? 'Contratos' : source === 'subscription' ? 'Suscripciones' : 'Legacy');
