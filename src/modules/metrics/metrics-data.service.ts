import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { type Month, monthStart } from './metrics-period';
import { NOT_PENDING_RENEWAL, PENDING } from './rsm-momentum';

import type { MetricCurrency, MetricsFiltersDto } from './dtos/query-metrics.dto';
import type { LineMonth, MrrLine } from './mrr-movements';
import type { RevenueItemMonth } from './revenue-balances';

type Row = Record<string, unknown>;

// Regla del "pendiente de renovar": una sola definición, compartida con Contratos (D-CTR-1).
export { NOT_PENDING_RENEWAL, PENDING } from './rsm-momentum';

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const splitList = (value?: string) =>
	value
		? [
				...new Set(
					value
						.split(',')
						.map((item) => item.trim())
						.filter(Boolean)
				),
			]
		: [];

/** Moneda de lectura resuelta (§1.1). */
export interface CurrencyContext {
	mode: MetricCurrency;
	code: string;
}

/** Contrato sin tipo de cambio en la moneda leída: sus filas no entran a ningún total (§1.3). */
export interface UnconvertedContract {
	contract_id: string | null;
	contract_number: string | null;
	client_name: string | null;
	source: 'contract' | 'subscription' | 'legacy';
	months: Month[];
	reason: 'item_fx_rate' | 'system_fx_rate' | 'company_fx_rate' | 'legacy_without_company_ccy';
}

export interface Unconverted {
	rows: number;
	items: number;
	contracts: UnconvertedContract[];
}

export const emptyUnconverted = (): Unconverted => ({ rows: 0, items: 0, contracts: [] });

/** Parámetros posicionales de una consulta. */
export class SqlParams {
	readonly values: unknown[] = [];

	add(value: unknown): string {
		this.values.push(value);

		return `$${this.values.length}`;
	}
}

/** Sufijo de columnas del RSM según la moneda (§0 regla dura 1: nunca `monthly_price` de ítems). */
const suffix = (mode: MetricCurrency) => (mode === 'system' ? '_system_ccy' : mode === 'company' ? '_ccy' : '_contract_ccy');
const fxSource = (mode: MetricCurrency) => (mode === 'system' ? 'r.fx_to_system_source' : mode === 'company' ? 'r.fx_to_company_source' : null);

/** Condición SQL de fila sin convertir para una columna del RSM. */
export function unconvertedSql(mode: MetricCurrency, column: string): string {
	const source = fxSource(mode);

	return source ? `(${column} IS NULL OR COALESCE(${source}, '') LIKE 'missing_fx_rate%')` : `(${column} IS NULL)`;
}

/**
 * Fila del RSM de un mes en que el ítem no está activo y sin montos (previo al inicio o posterior al fin, sin facturación): no es un
 * hueco de tipo de cambio aunque traiga la marca `missing_fx_rate`. Misma regla que aplica el rebuild desde api v0.0.69
 * (`revenue_schedule_rebuild_contract_ccy`); las filas que no se han recalculado la conservan, así que la lectura también la ignora.
 * Necesita `r` (RSM) y el ítem con el alias `item`. Siempre booleano (nunca NULL).
 */
export function inactiveEmptyRowSql(item = 'ci'): string {
	return `COALESCE(r.contract_item_id IS NOT NULL
		AND COALESCE(r.recognized_period_contract_ccy, 0) = 0 AND COALESCE(r.billed_period_contract_ccy, 0) = 0
		AND COALESCE(r.mrr_period_contract_ccy, 0) = 0 AND COALESCE(r.mrr_period_contracted_contract_ccy, 0) = 0
		AND COALESCE(r.cmrr_period_contract_ccy, 0) = 0
		AND NOT (${item}.start_date < (r.period_month + interval '1 month') AND (${item}.end_date IS NULL OR ${item}.end_date >= r.period_month)), false)`;
}

/** Hueco real de tipo de cambio: la fila no se pudo convertir y no es un mes inactivo sin montos. */
export const realGapSql = (unconverted: string, item = 'ci') => `(${unconverted} AND NOT ${inactiveEmptyRowSql(item)})`;

/** Pendiente de renovar de un mes (KPI de Métricas = KPI "Por renovar" de Contratos). */
export interface PendingRenewalMonth {
	mrr: number;
	cmrr: number;
	items: number;
	clients: number;
	contracts: number;
}

/**
 * Lecturas del devengo (`revenue_schedule_monthly`), del legacy (`mrr_legacy`) y catálogos, con los filtros comunes. Solo SELECT y
 * siempre acotado al holding del guard.
 */
@Injectable()
export class MetricsDataService {
	constructor(private readonly dataSource: DataSource) {}

	query<T = Row>(sql: string, params: unknown[]): Promise<T[]> {
		return this.dataSource.query<T[]>(sql, params);
	}

	/** Moneda de lectura: sistema (holding), compañía (exige una) o contrato (exige uno). 400 con `errors[]` si falta. */
	async resolveCurrency(holdingId: string, filters: MetricsFiltersDto): Promise<CurrencyContext> {
		const mode = filters.currency ?? 'system';

		if (mode === 'company') {
			const companies = splitList(filters.companyId);

			if (companies.length !== 1) {
				throw new BadRequestException({
					message: 'Moneda de compañía',
					errors: [{ field: 'companyId', message: 'Elige una compañía para ver montos en su moneda' }],
				});
			}
			const [row] = await this.query(`SELECT currency FROM companies WHERE id = $1 AND holding_id = $2`, [companies[0], holdingId]);

			if (!row)
				throw new BadRequestException({
					message: 'Compañía no encontrada',
					errors: [{ field: 'companyId', message: 'La compañía no es del holding' }],
				});

			return { mode, code: String(row.currency) };
		}
		if (mode === 'contract') {
			if (!filters.contractId) {
				throw new BadRequestException({
					message: 'Moneda de contrato',
					errors: [{ field: 'contractId', message: 'Elige un contrato para ver montos en su moneda' }],
				});
			}
			const [row] = await this.query(`SELECT contract_currency FROM contracts WHERE id = $1 AND holding_id = $2`, [
				filters.contractId,
				holdingId,
			]);

			if (!row)
				throw new BadRequestException({
					message: 'Contrato no encontrado',
					errors: [{ field: 'contractId', message: 'El contrato no es del holding' }],
				});

			return { mode, code: String(row.contract_currency) };
		}

		return { mode, code: await this.systemCurrency(holdingId) };
	}

	async systemCurrency(holdingId: string): Promise<string> {
		const [row] = await this.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1 LIMIT 1`, [holdingId]);

		return str(row?.system_currency) ?? 'USD';
	}

	/** Filtros comunes sobre las filas del RSM (alias `r`, `c` contrato, `s` suscripción, `ci` ítem, `cl` cliente). */
	rsmFilters(filters: MetricsFiltersDto, params: SqlParams): string[] {
		const where: string[] = [];
		const add = (values: string[], sql: (p: string) => string) => {
			if (values.length) where.push(sql(params.add(values)));
		};

		add(splitList(filters.companyId), (p) => `r.company_id = ANY(${p}::uuid[])`);
		add(splitList(filters.clientId), (p) => `COALESCE(c.client_id, s.client_id) = ANY(${p}::uuid[])`);
		if (filters.contractId) where.push(`r.contract_id = ${params.add(filters.contractId)}`);
		add(splitList(filters.product), (p) => `COALESCE(ci.product_name, r.product_name) = ANY(${p}::text[])`);
		add(splitList(filters.segment), (p) => `cl.segment = ANY(${p}::text[])`);
		add(splitList(filters.market), (p) => `cl.market = ANY(${p}::text[])`);
		add(splitList(filters.industry), (p) => `cl.industry = ANY(${p}::text[])`);
		add(splitList(filters.country), (p) => `cl.country = ANY(${p}::text[])`);

		const sources = splitList(filters.source);

		if (sources.length) {
			const parts = [
				sources.includes('contract') && 'r.contract_id IS NOT NULL',
				sources.includes('subscription') && 'r.subscription_id IS NOT NULL',
			].filter(Boolean);

			where.push(parts.length ? `(${parts.join(' OR ')})` : 'false');
		}

		return where;
	}

	/** Filtros comunes sobre `mrr_legacy` (alias `m`, `cl` cliente). */
	legacyFilters(filters: MetricsFiltersDto, params: SqlParams): string[] {
		const where: string[] = [];
		const add = (values: string[], sql: (p: string) => string) => {
			if (values.length) where.push(sql(params.add(values)));
		};

		add(splitList(filters.companyId), (p) => `m.company_id = ANY(${p}::uuid[])`);
		add(splitList(filters.clientId), (p) => `m.client_id = ANY(${p}::uuid[])`);
		if (filters.contractId) where.push(`m.migrated_to_contract_id = ${params.add(filters.contractId)}`);
		add(splitList(filters.product), (p) => `m.product_name = ANY(${p}::text[])`);
		add(splitList(filters.segment), (p) => `cl.segment = ANY(${p}::text[])`);
		add(splitList(filters.market), (p) => `cl.market = ANY(${p}::text[])`);
		add(splitList(filters.industry), (p) => `cl.industry = ANY(${p}::text[])`);
		add(splitList(filters.country), (p) => `cl.country = ANY(${p}::text[])`);

		return where;
	}

	/** ¿El legacy entra a esta lectura? Solo en moneda de sistema o de contrato y si el filtro de origen lo incluye. */
	legacyIncluded(filters: MetricsFiltersDto, currency: CurrencyContext) {
		const sources = splitList(filters.source);

		return (!sources.length || sources.includes('legacy')) && currency.mode !== 'company';
	}

	/**
	 * Líneas de MRR por mes entre `from` y `to` (§1.4, §1.8): ítems de contrato y de suscripción del RSM y grupos legacy con la regla de
	 * corte U14 (la fila migrada no cuenta desde el primer mes con MRR de su contrato). Valor NULL = sin convertir.
	 */
	async loadMrrLines(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, basis: 'mrr' | 'cmrr', from: Month, to: Month) {
		const lines = new Map<string, MrrLine>();
		const value = `r.${basis === 'cmrr' ? 'cmrr_period' : 'mrr_period_contracted'}${suffix(currency.mode)}`;
		const unconv = unconvertedSql(currency.mode, value);
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const where = [
			`r.holding_id = ${holding}`,
			`COALESCE(r.is_total_row, false) = false`,
			`r.period_month BETWEEN ${params.add(monthStart(from))}::date AND ${params.add(monthStart(to))}::date`,
			`c.deleted_at IS NULL`,
			...this.rsmFilters(filters, params),
		];
		const rsmRows =
			splitList(filters.source).length && !splitList(filters.source).some((s) => s !== 'legacy')
				? []
				: await this.query(
						`SELECT
				CASE WHEN r.contract_item_id IS NOT NULL THEN 'i:' || r.contract_item_id::text
					ELSE 's:' || COALESCE(r.subscription_item_id, r.subscription_id)::text END AS key,
				CASE WHEN r.contract_id IS NOT NULL THEN 'contract' ELSE 'subscription' END AS source,
				COALESCE(r.contract_id, r.subscription_id) AS contract_id, c.contract_number, r.contract_item_id AS item_id,
				COALESCE(c.client_id, s.client_id) AS client_id, cl.name_commercial AS client_name,
				r.company_id, co.legal_name AS company_name,
				COALESCE(ci.product_name, MAX(r.product_name)) AS product, ci.categoria, ci.renews_item_id, ci.renewed_by_item_id,
				ci.item_type, ci.unit_of_measure, cl.segment, cl.market, cl.industry, cl.country,
				to_char(r.period_month, 'YYYY-MM') AS period,
				SUM(${value}) FILTER (WHERE ${NOT_PENDING_RENEWAL}) AS value,
				BOOL_OR(${realGapSql(unconv)}) FILTER (WHERE ${NOT_PENDING_RENEWAL}) AS unconverted,
				BOOL_OR(r.calc_version = 'missing_fx_rate' AND NOT ${inactiveEmptyRowSql()}) AS item_fx_missing,
				SUM(r.${basis === 'cmrr' ? 'cmrr_period' : 'mrr_period_contracted'}_contract_ccy) FILTER (WHERE ${NOT_PENDING_RENEWAL}) AS value_contract,
				COALESCE(SUM(${value}) FILTER (WHERE r.momentum = '${PENDING}' AND NOT ${unconv}), 0) AS pending,
				MAX(r.momentum) FILTER (WHERE r.momentum NOT IN ('BOP', '${PENDING}')) AS momentum
			FROM revenue_schedule_monthly r
			LEFT JOIN contracts c ON c.id = r.contract_id
			LEFT JOIN subscriptions s ON s.id = r.subscription_id
			LEFT JOIN contract_items ci ON ci.id = r.contract_item_id
			LEFT JOIN clients cl ON cl.id = COALESCE(c.client_id, s.client_id)
			LEFT JOIN companies co ON co.id = r.company_id
			WHERE ${where.join(' AND ')}
			GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, ci.product_name, ci.categoria, ci.renews_item_id, ci.renewed_by_item_id, ci.item_type,
				ci.unit_of_measure, cl.segment, cl.market, cl.industry, cl.country, r.period_month`,
						params.values
					);
		const itemFxMissing = new Set<string>();

		for (const row of rsmRows) {
			const key = String(row.key);

			if (row.item_fx_missing) itemFxMissing.add(key);
			this.addLineMonth(lines, row, {
				value: row.unconverted ? null : (num(row.value) ?? 0),
				valueContract: num(row.value_contract),
				pending: num(row.pending) ?? 0,
				momentum: str(row.momentum),
			});
		}

		let legacyCompanyRows = 0;

		if (this.legacyIncluded(filters, currency)) {
			for (const row of await this.loadLegacyRows(holdingId, filters, currency, from, to)) {
				this.addLineMonth(lines, row, { value: num(row.value), valueContract: num(row.value_contract), pending: 0, momentum: null });
			}
		} else if (currency.mode === 'company' && (!splitList(filters.source).length || splitList(filters.source).includes('legacy'))) {
			legacyCompanyRows = await this.countLegacyRows(holdingId, filters, from, to);
		}

		return { lines: [...lines.values()], itemFxMissing, legacyCompanyRows };
	}

	/**
	 * Pendiente de renovar por mes con **la misma regla** que el KPI "Por renovar" de Contratos (`ContractsService.summary`): suma de
	 * las filas RSM `momentum = 'PENDING_RENEWAL'` del mes (`apply_pending_renewal_tail`), columna `mrr_period*` (CMRR: `cmrr_period*`)
	 * en la moneda leída. No depende de las líneas de MRR: antes salía de las líneas convertidas del rango, y un ítem con un mes sin
	 * tipo de cambio en los 14 meses leídos perdía también su pendiente (el KPI mostraba 0 con Contratos en USD 974). Las filas
	 * pendientes sin tipo de cambio no suman (§1.3), igual que en Contratos (`SUM` ignora NULL).
	 */
	async loadPendingRenewal(
		holdingId: string,
		filters: MetricsFiltersDto,
		currency: CurrencyContext,
		months: Month[]
	): Promise<Map<Month, PendingRenewalMonth>> {
		const out = new Map<Month, PendingRenewalMonth>();

		if (!months.length || (splitList(filters.source).length && !splitList(filters.source).some((s) => s !== 'legacy'))) return out;

		const mrr = `r.mrr_period${suffix(currency.mode)}`;
		const cmrr = `r.cmrr_period${suffix(currency.mode)}`;
		const params = new SqlParams();
		const where = [
			`r.holding_id = ${params.add(holdingId)}`,
			`COALESCE(r.is_total_row, false) = false`,
			`r.momentum = '${PENDING}'`,
			`r.period_month = ANY(${params.add(months.map(monthStart))}::date[])`,
			`c.deleted_at IS NULL`,
			...this.rsmFilters(filters, params),
		];
		const rows = await this.query(
			`SELECT to_char(r.period_month, 'YYYY-MM') AS period,
				COALESCE(SUM(${mrr}) FILTER (WHERE NOT ${unconvertedSql(currency.mode, mrr)}), 0) AS mrr,
				COALESCE(SUM(${cmrr}) FILTER (WHERE NOT ${unconvertedSql(currency.mode, cmrr)}), 0) AS cmrr,
				COUNT(DISTINCT r.contract_item_id) AS items,
				COUNT(DISTINCT COALESCE(c.client_id, s.client_id)) AS clients,
				COUNT(DISTINCT r.contract_id) AS contracts
			FROM revenue_schedule_monthly r
			LEFT JOIN contracts c ON c.id = r.contract_id
			LEFT JOIN subscriptions s ON s.id = r.subscription_id
			LEFT JOIN contract_items ci ON ci.id = r.contract_item_id
			LEFT JOIN clients cl ON cl.id = COALESCE(c.client_id, s.client_id)
			WHERE ${where.join(' AND ')}
			GROUP BY 1`,
			params.values
		);

		for (const row of rows) {
			out.set(String(row.period), {
				mrr: Math.round((num(row.mrr) ?? 0) * 100) / 100,
				cmrr: Math.round((num(row.cmrr) ?? 0) * 100) / 100,
				items: num(row.items) ?? 0,
				clients: num(row.clients) ?? 0,
				contracts: num(row.contracts) ?? 0,
			});
		}

		return out;
	}

	private addLineMonth(lines: Map<string, MrrLine>, row: Row, cell: LineMonth) {
		const key = String(row.key);
		let line = lines.get(key);

		if (!line) {
			line = {
				key,
				source: row.source as MrrLine['source'],
				contractId: str(row.contract_id),
				contractNumber: str(row.contract_number),
				itemId: str(row.item_id),
				clientId: str(row.client_id),
				clientName: str(row.client_name),
				companyId: str(row.company_id),
				companyName: str(row.company_name),
				product: str(row.product),
				categoria: str(row.categoria),
				renewsItemId: str(row.renews_item_id),
				renewedByItemId: str(row.renewed_by_item_id),
				legacyContractId: row.source === 'legacy' ? str(row.contract_id) : null,
				segment: str(row.segment),
				market: str(row.market),
				industry: str(row.industry),
				country: str(row.country),
				itemType: str(row.item_type),
				unitOfMeasure: str(row.unit_of_measure),
				months: new Map(),
			};
			lines.set(key, line);
		}
		const period = String(row.period);
		const previous = line.months.get(period);

		line.months.set(
			period,
			previous
				? {
						value: previous.value === null || cell.value === null ? null : previous.value + cell.value,
						valueContract: (previous.valueContract ?? 0) + (cell.valueContract ?? 0),
						pending: previous.pending + cell.pending,
						momentum: previous.momentum ?? cell.momentum,
					}
				: cell
		);
	}

	/** Grupos legacy por mes con el corte U14 (§1.8). */
	private loadLegacyRows(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, from: Month, to: Month) {
		const params = new SqlParams();
		const holding = params.add(holdingId);
		const value = currency.mode === 'contract' ? 'm.mrr_legacy' : 'm.mrr_legacy_system_currency';
		const where = [
			`m.holding_id = ${holding}`,
			`COALESCE(m.is_recurring, false) = true`,
			`m.period_month BETWEEN ${params.add(monthStart(from))}::date AND ${params.add(monthStart(to))}::date`,
			`NOT (f.first_month IS NOT NULL AND m.period_month >= f.first_month)`,
			...this.legacyFilters(filters, params),
		];

		return this.query(
			`WITH first_rsm AS (
				SELECT r.contract_id, MIN(r.period_month) AS first_month
				FROM revenue_schedule_monthly r
				WHERE r.holding_id = ${holding} AND r.contract_id IS NOT NULL AND r.mrr_period_contracted_contract_ccy > 0
				GROUP BY r.contract_id
			)
			SELECT 'l:' || COALESCE(m.client_id::text, '') || '|' || COALESCE(m.product_name, '') || '|' || COALESCE(m.contract_currency, '') || '|' ||
					COALESCE(m.migrated_to_contract_id::text, '') AS key,
				'legacy' AS source, m.migrated_to_contract_id AS contract_id, c.contract_number, NULL AS item_id,
				m.client_id, cl.name_commercial AS client_name, m.company_id, co.legal_name AS company_name, m.product_name AS product,
				NULL AS categoria, NULL AS renews_item_id, NULL AS renewed_by_item_id, NULL AS item_type, NULL AS unit_of_measure,
				cl.segment, cl.market, cl.industry, cl.country,
				to_char(m.period_month, 'YYYY-MM') AS period,
				CASE WHEN BOOL_OR(${value} IS NULL) THEN NULL ELSE SUM(${value}) END AS value,
				SUM(m.mrr_legacy) AS value_contract
			FROM mrr_legacy m
			LEFT JOIN first_rsm f ON f.contract_id = m.migrated_to_contract_id
			LEFT JOIN contracts c ON c.id = m.migrated_to_contract_id
			LEFT JOIN clients cl ON cl.id = m.client_id
			LEFT JOIN companies co ON co.id = m.company_id
			WHERE ${where.join(' AND ')}
			GROUP BY 1, 2, 3, 4, 6, 7, 8, 9, 10, cl.segment, cl.market, cl.industry, cl.country, m.period_month`,
			params.values
		);
	}

	private async countLegacyRows(holdingId: string, filters: MetricsFiltersDto, from: Month, to: Month) {
		const params = new SqlParams();
		const where = [
			`m.holding_id = ${params.add(holdingId)}`,
			`COALESCE(m.is_recurring, false) = true`,
			`m.period_month BETWEEN ${params.add(monthStart(from))}::date AND ${params.add(monthStart(to))}::date`,
			...this.legacyFilters(filters, params),
		];
		const [row] = await this.query(
			`SELECT COUNT(*) AS n FROM mrr_legacy m LEFT JOIN clients cl ON cl.id = m.client_id WHERE ${where.join(' AND ')}`,
			params.values
		);

		return Number(row?.n ?? 0);
	}

	/**
	 * Filas ítem × mes del devengo para Revenue (§1.7): reconocido y facturado del mes y los acumulados de un solo registro por ítem-mes
	 * (la fila regular, no la CHURN de la cola, que repite el acumulado final, R4). Sin pendientes de renovar (acumulado 0).
	 */
	async loadRevenueRows(holdingId: string, filters: MetricsFiltersDto, currency: CurrencyContext, from: Month | null, to: Month) {
		const s = suffix(currency.mode);
		const unconv = unconvertedSql(currency.mode, `r.recognized_period${s}`);
		const params = new SqlParams();
		const where = [
			`r.holding_id = ${params.add(holdingId)}`,
			`COALESCE(r.is_total_row, false) = false`,
			NOT_PENDING_RENEWAL,
			`r.period_month <= ${params.add(monthStart(to))}::date`,
			...(from ? [`r.period_month >= ${params.add(monthStart(from))}::date`] : []),
			`c.deleted_at IS NULL`,
			...this.rsmFilters(
				{
					...filters,
					source: filters.source
						? splitList(filters.source)
								.filter((x) => x !== 'legacy')
								.join(',') || 'none'
						: undefined,
				},
				params
			),
		];
		const rows = await this.query(
			`SELECT COALESCE(r.contract_id, r.subscription_id)::text AS contract_id, c.contract_number,
				COALESCE(r.contract_item_id, r.subscription_item_id, r.subscription_id)::text AS item_id, r.company_id::text AS company_id,
				to_char(r.period_month, 'YYYY-MM') AS period,
				SUM(r.recognized_period${s}) AS recognized, SUM(r.billed_period${s}) AS billed,
				(ARRAY_AGG(r.recognized_cum${s} ORDER BY (r.momentum = 'CHURN')))[1] AS recognized_cum,
				(ARRAY_AGG(r.billed_cum${s} ORDER BY (r.momentum = 'CHURN')))[1] AS billed_cum,
				BOOL_OR(${realGapSql(unconv)}) AS unconverted,
				BOOL_OR(r.calc_version = 'missing_fx_rate' AND NOT ${inactiveEmptyRowSql()}) AS item_fx_missing,
				cl.name_commercial AS client_name, cl.id::text AS client_id, cl.market, cl.industry, cl.segment,
				MAX(COALESCE(ci.product_name, r.product_name)) AS product
			FROM revenue_schedule_monthly r
			LEFT JOIN contracts c ON c.id = r.contract_id
			LEFT JOIN subscriptions s ON s.id = r.subscription_id
			LEFT JOIN contract_items ci ON ci.id = r.contract_item_id
			LEFT JOIN clients cl ON cl.id = COALESCE(c.client_id, s.client_id)
			WHERE ${where.join(' AND ')}
			GROUP BY 1, 2, 3, 4, 5, cl.name_commercial, cl.id, cl.market, cl.industry, cl.segment`,
			params.values
		);
		const unconvertedItems = new Set<string>();
		const unconverted: Row[] = [];
		const converted: RevenueItemMonth[] = [];

		for (const row of rows) {
			if (row.unconverted) {
				unconvertedItems.add(String(row.item_id));
				unconverted.push(row);
			}
		}
		for (const row of rows) {
			if (unconvertedItems.has(String(row.item_id))) continue;
			converted.push({
				contractId: String(row.contract_id),
				itemId: String(row.item_id),
				companyId: String(row.company_id),
				period: String(row.period),
				recognized: num(row.recognized) ?? 0,
				billed: num(row.billed) ?? 0,
				recognizedCum: num(row.recognized_cum) ?? 0,
				billedCum: num(row.billed_cum) ?? 0,
				// Dimensiones del ítem para abrir los asientos (mismas columnas de `clients` que Métricas "por dimensión").
				attrs: {
					contractNumber: str(row.contract_number),
					clientId: str(row.client_id),
					clientName: str(row.client_name),
					product: str(row.product),
					market: str(row.market),
					industry: str(row.industry),
					segment: str(row.segment),
				},
			});
		}

		return { rows: converted, unconvertedRows: unconverted };
	}

	/** Resumen de lo que no entró a los totales, agrupado por contrato (§1.3). */
	summarizeUnconverted(input: {
		lines?: MrrLine[];
		itemFxMissing?: Set<string>;
		revenueRows?: Row[];
		currency: CurrencyContext;
		legacyCompanyRows?: number;
	}): Unconverted {
		const contracts = new Map<string, UnconvertedContract>();
		let rows = 0;
		const items = new Set<string>();
		const reasonFor = (itemFx: boolean): UnconvertedContract['reason'] =>
			itemFx ? 'item_fx_rate' : input.currency.mode === 'company' ? 'company_fx_rate' : 'system_fx_rate';

		for (const line of input.lines ?? []) {
			const months = [...line.months].filter(([, cell]) => cell.value === null).map(([month]) => month);

			rows += months.length;
			items.add(line.key);
			const id = line.contractId ?? line.key;
			const entry = contracts.get(id) ?? {
				contract_id: line.contractId,
				contract_number: line.contractNumber,
				client_name: line.clientName,
				source: line.source,
				months: [],
				reason: reasonFor(Boolean(input.itemFxMissing?.has(line.key))),
			};

			entry.months = [...new Set([...entry.months, ...months])].sort();
			contracts.set(id, entry);
		}
		for (const row of input.revenueRows ?? []) {
			rows += 1;
			items.add(String(row.item_id));
			const id = String(row.contract_id);
			const entry = contracts.get(id) ?? {
				contract_id: id,
				contract_number: str(row.contract_number),
				client_name: str(row.client_name),
				source: 'contract' as const,
				months: [],
				reason: reasonFor(Boolean(row.item_fx_missing)),
			};

			entry.months = [...new Set([...entry.months, String(row.period)])].sort();
			contracts.set(id, entry);
		}
		if (input.legacyCompanyRows) {
			rows += input.legacyCompanyRows;
			contracts.set('legacy', {
				contract_id: null,
				contract_number: null,
				client_name: null,
				source: 'legacy',
				months: [],
				reason: 'legacy_without_company_ccy',
			});
		}

		return { rows, items: items.size, contracts: [...contracts.values()] };
	}

	/** Opciones reales de filtro del holding (nada fijo en el front: el viejo traía segmentos y mercados escritos a mano). */
	async filterOptions(holdingId: string) {
		const distinct = (column: string) =>
			this.query(
				`SELECT DISTINCT ${column} AS value FROM clients WHERE holding_id = $1 AND ${column} IS NOT NULL AND TRIM(${column}) <> '' ORDER BY 1`,
				[holdingId]
			).then((rows) => rows.map((row) => String(row.value)));
		const [companies, clients, products, segments, markets, industries, countries, reasons, currency, hasLegacy, hasSubscriptions] =
			await Promise.all([
				this.query(`SELECT id::text AS id, legal_name AS name, currency FROM companies WHERE holding_id = $1 ORDER BY legal_name`, [
					holdingId,
				]),
				this.query(
					`SELECT cl.id::text AS id, cl.name_commercial AS name FROM clients cl
				WHERE cl.holding_id = $1 AND (EXISTS (SELECT 1 FROM contracts c WHERE c.client_id = cl.id) OR EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.client_id = cl.id)
					OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.client_id = cl.id))
				ORDER BY cl.name_commercial`,
					[holdingId]
				),
				this.query(
					`SELECT DISTINCT product_name AS name FROM (
					SELECT r.product_name FROM revenue_schedule_monthly r WHERE r.holding_id = $1
					UNION SELECT m.product_name FROM mrr_legacy m WHERE m.holding_id = $1
				) p WHERE product_name IS NOT NULL ORDER BY 1`,
					[holdingId]
				),
				distinct('segment'),
				distinct('market'),
				distinct('industry'),
				distinct('country'),
				this.query(`SELECT id::text AS id, name, is_active FROM churn_reasons WHERE holding_id = $1 ORDER BY name`, [holdingId]),
				this.systemCurrency(holdingId),
				this.query(`SELECT EXISTS (SELECT 1 FROM mrr_legacy WHERE holding_id = $1) AS v`, [holdingId]),
				this.query(`SELECT EXISTS (SELECT 1 FROM revenue_schedule_monthly WHERE holding_id = $1 AND subscription_id IS NOT NULL) AS v`, [
					holdingId,
				]),
			]);

		return {
			system_currency: currency,
			companies: companies.map((row) => ({ id: String(row.id), name: str(row.name), currency: str(row.currency) })),
			clients: clients.map((row) => ({ id: String(row.id), name: str(row.name) })),
			products: products.map((row) => String(row.name)),
			segments,
			markets,
			industries,
			countries,
			churn_reasons: reasons.map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.is_active) })),
			sources: ['contract', ...(hasSubscriptions[0]?.v ? ['subscription'] : []), ...(hasLegacy[0]?.v ? ['legacy'] : [])],
		};
	}

	/** Última actualización del devengo leída (para "calculado hace X"). */
	async asOf(holdingId: string): Promise<string | null> {
		const [row] = await this.query(`SELECT MAX(updated_at) AS at FROM revenue_schedule_monthly WHERE holding_id = $1`, [holdingId]);

		return row?.at ? new Date(row.at as string).toISOString() : null;
	}
}
