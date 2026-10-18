import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadMetricsHistoryStart } from '@/core/utils/holding-preferences';
import { type Month, monthRange, monthsBetween, monthStart } from '@/modules/metrics/metrics-period';
import {
	LEGACY_FIRST_RSM_JOIN,
	legacyAfterContractSql,
	legacyCountedConditions,
	legacyFirstRsmCte,
	legacyRemovedSql,
	legacySkipCodeSql,
} from '@/modules/metrics/mrr-historico';
import { NOT_PENDING_RENEWAL } from '@/modules/metrics/rsm-momentum';

import { num, round2, type Row, str } from './onboarding-common';

import type { HistorySeriesConcept, HistorySeriesCurrency, HistorySeriesGroupBy, HistorySeriesQueryDto } from './dtos/onboarding.dto';

/** Tope de meses de la serie (la historia de SimpliRoute ya pasa los 36 de Métricas). */
export const HISTORY_SERIES_MAX_MONTHS = 120;
/** Filas por dimensión por defecto (el resto va en "Otros"). */
export const HISTORY_SERIES_DEFAULT_TOP = 15;

/**
 * Montos de un mes (o de una moneda en un mes). `counted` = `counted_linked + counted_not_activated + counted_pending` (Domi 18-10, serie
 * por concepto; con `concept`, solo ese sumando y los otros dos en 0); `after_contract` = histórico después del inicio del contrato (error de
 * datos); `removed` = quitadas con código explícito.
 * El mes de empalme (mismo mes que el primer mes con MRR del contrato) se corta en silencio y no aparece en ningún monto.
 */
export interface SeriesAmounts {
	counted: number;
	counted_linked: number;
	counted_not_activated: number;
	counted_pending: number;
	after_contract: number;
	removed: number;
}
type AmountKey = keyof SeriesAmounts;
const AMOUNT_KEYS: AmountKey[] = ['counted', 'counted_linked', 'counted_not_activated', 'counted_pending', 'after_contract', 'removed'];

export type SeriesMonth = { month: Month } & { [K in AmountKey]: number | null } & {
	contracts: number;
	by_currency: Array<{ currency: string } & SeriesAmounts>;
};

/** Fila de la serie por dimensión: `values` alineado con `months` (`counted` del mes en la moneda del modo). */
export interface SeriesGroupRow {
	key: string;
	label: string;
	/** Moneda de contrato o de factura en esos modos; `null` en `system`. */
	currency: string | null;
	values: number[];
}

/** Monto por moneda de la serie: sistema = `mrr_legacy_system_currency`; contrato = `mrr_legacy`; factura = asignado ÷ plazo. */
const VALUE_SQL: Record<HistorySeriesCurrency, string> = {
	system: 'm.mrr_legacy_system_currency',
	contract: 'm.mrr_legacy',
	invoice: 'm.allocated_invoice_currency / NULLIF(m.term, 0)',
};
const CURRENCY_SQL: Record<HistorySeriesCurrency, string> = {
	system: `''`,
	contract: 'm.contract_currency',
	invoice: 'm.invoice_currency',
};

/**
 * Concepto de una fila que cuenta (Domi 18-10), sobre `m`: empalmada a un contrato (meses antes del corte), "No activado" (marcada, motivo
 * efectivo `churn`) o pendiente (ni una ni otra). Una sola regla: separa los `counted_*` y filtra la serie con `concept`.
 */
export const CONCEPT_SQL: Record<HistorySeriesConcept, string> = {
	linked: 'm.migrated_to_contract_id IS NOT NULL',
	not_activated: `m.migrated_to_contract_id IS NULL AND ${legacySkipCodeSql('m')} = 'churn'`,
	pending: 'm.migrated_to_contract_id IS NULL AND NOT m.skip_activation',
};

/**
 * Dimensiones de la serie (Domi 18-10): clave, etiqueta, JOIN extra y etiqueta cuando no hay valor. `entity` = razón social receptora de
 * la factura de origen (`il`/`ce` ya van en `JOINS`).
 */
const GROUPS: Record<Exclude<HistorySeriesGroupBy, 'none'>, { key: string; label: string; join: string; empty: string }> = {
	client: { key: 'm.client_id::text', label: 'cl.name_commercial', join: 'LEFT JOIN clients cl ON cl.id = m.client_id', empty: 'Sin cliente' },
	entity: { key: 'il.client_entity_id::text', label: 'ce.legal_name', join: '', empty: 'Sin razón social' },
	product: { key: `NULLIF(btrim(m.product_name), '')`, label: 'm.product_name', join: '', empty: 'Sin producto' },
	company: { key: 'm.company_id::text', label: 'co.legal_name', join: 'LEFT JOIN companies co ON co.id = m.company_id', empty: 'Sin compañía' },
};
const NO_KEY = 'none';
const OTHERS = { key: 'others', label: 'Otros' };

/**
 * Serie mensual del MRR histórico para el Resumen de Datos históricos (Domi 18-10; contrato en `mapa-v2-onboarding.md` §2c). Reutiliza la
 * regla única de `mrr-historico.ts` (U14 + quitadas, la misma de Métricas) y el MRR del devengo con la columna y el filtro de Métricas
 * (`mrr_period_contracted_system_ccy`, sin las filas de pendiente de renovar). Solo lectura.
 */
@Injectable()
export class OnboardingSeriesService {
	constructor(private readonly dataSource: DataSource) {}

	/** Filtros sobre las filas de `mrr_legacy` (`m`), su factura de origen (`il`) y la razón social receptora (`ce`). */
	private filters(holdingId: string, query: HistorySeriesQueryDto) {
		const params: unknown[] = [holdingId];
		const add = (value: unknown) => `$${params.push(value)}`;
		const where = ['m.holding_id = $1'];

		if (query.companyId) where.push(`m.company_id = ${add(query.companyId)}::uuid`);
		if (query.clientId) where.push(`m.client_id = ${add(query.clientId)}::uuid`);
		if (query.entityId) where.push(`il.client_entity_id = ${add(query.entityId)}::uuid`);
		if (query.country) where.push(`upper(ce.country_code) = ${add(query.country.toUpperCase())}`);

		return { params, add, where };
	}

	private static readonly JOINS = `LEFT JOIN invoices_legacy il ON il.id = m.invoice_legacy_id
		LEFT JOIN client_entities ce ON ce.id = il.client_entity_id`;

	async series(holdingId: string, query: HistorySeriesQueryDto) {
		const mode: HistorySeriesCurrency = query.currency ?? 'system';
		const groupBy: HistorySeriesGroupBy = query.groupBy ?? 'none';
		const top = query.top ?? HISTORY_SERIES_DEFAULT_TOP;
		const { params, add, where } = this.filters(holdingId, query);
		const [[bounds], historyStart, [settings]] = await Promise.all([
			this.dataSource.query(
				`SELECT to_char(MIN(m.period_month), 'YYYY-MM') AS first_month, to_char(MAX(m.period_month), 'YYYY-MM') AS last_month
				FROM mrr_legacy m ${OnboardingSeriesService.JOINS}
				WHERE ${where.join(' AND ')}`,
				// Copia: `params` sigue creciendo con el rango y el driver puede leerlo después.
				[...params]
			) as Promise<Row[]>,
			loadMetricsHistoryStart(this.dataSource, holdingId),
			this.dataSource.query(`SELECT system_currency FROM holding_settings WHERE holding_id = $1`, [holdingId]) as Promise<Row[]>,
		]);
		const systemCurrency = str(settings?.system_currency) ?? 'USD';
		const firstData = str(bounds?.first_month);
		const lastData = str(bounds?.last_month);
		// Como Métricas: arranca en el mayor entre el inicio de la historia del holding y el primer dato.
		const defaultFrom = historyStart && firstData ? (historyStart > firstData ? historyStart : firstData) : (firstData ?? historyStart);
		const from = query.from ?? defaultFrom;
		const to = query.to ?? lastData;
		const concept = query.concept ?? null;
		const filtersApplied = {
			currency: mode,
			companyId: query.companyId ?? null,
			clientId: query.clientId ?? null,
			entityId: query.entityId ?? null,
			country: query.country ?? null,
			groupBy,
			top: groupBy === 'none' ? null : top,
			concept,
			from,
			to,
		};
		const empty = { last_month: null, counted_last: 0, lines: 0, clients: 0, rows_total: groupBy === 'none' ? null : 0 };

		if (!from || !to) {
			return { currency_mode: mode, system_currency: systemCurrency, months: [], rows: [], totals: empty, filters_applied: filtersApplied };
		}
		if (monthsBetween(from, to) < 0) {
			throw new BadRequestException({
				message: 'Rango inválido',
				errors: [{ field: 'to', message: 'El mes final debe ser igual o posterior al inicial' }],
			});
		}
		if (monthsBetween(from, to) + 1 > HISTORY_SERIES_MAX_MONTHS) {
			throw new BadRequestException({
				message: 'Rango inválido',
				errors: [{ field: 'from', message: `La serie admite hasta ${HISTORY_SERIES_MAX_MONTHS} meses` }],
			});
		}
		// Los contratos empalmados salen de las filas del filtro sin el rango (una línea no se corta por mes); el devengo sí va en el rango.
		const rowWhere = [...where];
		const range = `${add(monthStart(from))}::date AND ${add(monthStart(to))}::date`;

		where.push(`m.period_month BETWEEN ${range}`);
		// Con `concept`, lo que cuenta se limita a ese concepto (mismo predicado que separa los `counted_*`); `after_contract` y `removed` no cambian.
		const counted = [...legacyCountedConditions(), ...(concept ? [CONCEPT_SQL[concept]] : [])].join(' AND ');
		const removed = legacyRemovedSql('m');
		const value = VALUE_SQL[mode];
		const systemValue = VALUE_SQL.system;
		const group = groupBy === 'none' ? null : GROUPS[groupBy];
		const [amounts, contracts, [lineTotals], groupCells] = await Promise.all([
			// Una fila por mes × moneda (sistema: una sola). Solo filas recurrentes: el MRR histórico es recurrente. `counted` se separa por
			// concepto (Domi 18-10): empalmado (meses antes del corte), "No activado" (marcado, motivo `churn`) y pendiente (ni uno ni otro).
			this.dataSource.query(
				`WITH ${legacyFirstRsmCte('$1')}
				SELECT to_char(m.period_month, 'YYYY-MM') AS month, ${CURRENCY_SQL[mode]} AS currency,
					COALESCE(SUM(${value}) FILTER (WHERE ${counted}), 0) AS counted,
					COALESCE(SUM(${value}) FILTER (WHERE ${counted} AND ${CONCEPT_SQL.linked}), 0) AS counted_linked,
					COALESCE(SUM(${value}) FILTER (WHERE ${counted} AND ${CONCEPT_SQL.not_activated}), 0) AS counted_not_activated,
					COALESCE(SUM(${value}) FILTER (WHERE ${counted} AND ${CONCEPT_SQL.pending}), 0) AS counted_pending,
					COALESCE(SUM(${value}) FILTER (WHERE NOT ${removed} AND ${legacyAfterContractSql()}), 0) AS after_contract,
					COALESCE(SUM(${value}) FILTER (WHERE ${removed}), 0) AS removed,
					COALESCE(SUM(${systemValue}) FILTER (WHERE ${counted}), 0) AS counted_system
				FROM mrr_legacy m ${LEGACY_FIRST_RSM_JOIN} ${OnboardingSeriesService.JOINS}
				WHERE ${where.join(' AND ')} AND COALESCE(m.is_recurring, false) = true
				GROUP BY 1, 2
				ORDER BY 1, 2`,
				params
			) as Promise<Row[]>,
			// MRR del devengo de los contratos empalmados a filas del filtro (mismo filtro de filas), en moneda de sistema y con la regla de
			// Métricas (`loadMrrLines`): plan contratado, sin filas de total ni de pendiente de renovar, contratos no borrados.
			this.dataSource.query(
				`WITH linked AS (
					SELECT DISTINCT m.migrated_to_contract_id AS contract_id
					FROM mrr_legacy m ${OnboardingSeriesService.JOINS}
					WHERE ${rowWhere.join(' AND ')} AND m.migrated_to_contract_id IS NOT NULL
				)
				SELECT to_char(r.period_month, 'YYYY-MM') AS month, COALESCE(SUM(r.mrr_period_contracted_system_ccy), 0) AS contracts
				FROM revenue_schedule_monthly r
				JOIN linked l ON l.contract_id = r.contract_id
				JOIN contracts c ON c.id = r.contract_id
				WHERE r.holding_id = $1 AND COALESCE(r.is_total_row, false) = false AND ${NOT_PENDING_RENEWAL} AND c.deleted_at IS NULL
					AND r.period_month BETWEEN ${range}
				GROUP BY 1`,
				params
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT COUNT(DISTINCT (m.client_id, m.product_name, m.contract_currency)) AS lines, COUNT(DISTINCT m.client_id) AS clients
				FROM mrr_legacy m ${OnboardingSeriesService.JOINS}
				WHERE ${where.join(' AND ')}`,
				params
			) as Promise<Row[]>,
			// Serie por dimensión (Domi 18-10): solo lo que cuenta, por mes × entidad × moneda; el monto de sistema ordena en los tres modos.
			group
				? (this.dataSource.query(
						`WITH ${legacyFirstRsmCte('$1')}
						SELECT to_char(m.period_month, 'YYYY-MM') AS month, COALESCE(${group.key}, '${NO_KEY}') AS key, MAX(${group.label}) AS label,
							${CURRENCY_SQL[mode]} AS currency, COALESCE(SUM(${value}), 0) AS counted, COALESCE(SUM(${systemValue}), 0) AS counted_system
						FROM mrr_legacy m ${LEGACY_FIRST_RSM_JOIN} ${OnboardingSeriesService.JOINS} ${group.join}
						WHERE ${where.join(' AND ')} AND ${counted}
						GROUP BY 1, 2, 4`,
						params
					) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const monthList = monthRange(from, to);
		const contractsByMonth = new Map(contracts.map((row) => [String(row.month), round2(num(row.contracts))]));
		const months: SeriesMonth[] = monthList.map((month) => {
			const rows = amounts.filter((row) => String(row.month) === month);
			const sum = (key: AmountKey) => (mode === 'system' ? round2(rows.reduce((total, row) => total + num(row[key]), 0)) : null);
			const amountsOf = (row: Row) => Object.fromEntries(AMOUNT_KEYS.map((key) => [key, round2(num(row[key]))])) as unknown as SeriesAmounts;

			return {
				month,
				...(Object.fromEntries(AMOUNT_KEYS.map((key) => [key, sum(key)])) as { [K in AmountKey]: number | null }),
				contracts: contractsByMonth.get(month) ?? 0,
				by_currency: mode === 'system' ? [] : rows.map((row) => ({ currency: String(row.currency ?? ''), ...amountsOf(row) })),
			};
		});
		const lastRows = amounts.filter((row) => String(row.month) === to);
		const grouped = group ? groupRows(groupCells, monthList, mode, top, group.empty) : null;

		return {
			currency_mode: mode,
			system_currency: systemCurrency,
			months,
			rows: grouped?.rows ?? [],
			totals: {
				last_month: to,
				// Siempre en moneda de sistema (un KPI comparable en los tres modos).
				counted_last: round2(lastRows.reduce((total, row) => total + num(row.counted_system), 0)),
				lines: num(lineTotals?.lines),
				clients: num(lineTotals?.clients),
				rows_total: grouped ? grouped.total : null,
			},
			filters_applied: filtersApplied,
		};
	}

	/** Opciones de filtro de la serie: lo presente en el MRR histórico del holding. */
	async filterOptions(holdingId: string) {
		const [companies, countries, currencies, products] = await Promise.all([
			this.dataSource.query(
				`SELECT DISTINCT co.id, co.legal_name FROM mrr_legacy m JOIN companies co ON co.id = m.company_id
				WHERE m.holding_id = $1 ORDER BY co.legal_name, co.id`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT DISTINCT upper(ce.country_code) AS country
				FROM mrr_legacy m JOIN invoices_legacy il ON il.id = m.invoice_legacy_id JOIN client_entities ce ON ce.id = il.client_entity_id
				WHERE m.holding_id = $1 AND NULLIF(btrim(ce.country_code), '') IS NOT NULL ORDER BY 1`,
				[holdingId]
			) as Promise<Row[]>,
			this.dataSource.query(
				`SELECT 'contract' AS kind, upper(m.contract_currency) AS currency FROM mrr_legacy m
				WHERE m.holding_id = $1 AND NULLIF(btrim(m.contract_currency), '') IS NOT NULL
				UNION
				SELECT 'invoice' AS kind, upper(m.invoice_currency) AS currency FROM mrr_legacy m
				WHERE m.holding_id = $1 AND NULLIF(btrim(m.invoice_currency), '') IS NOT NULL
				ORDER BY 1, 2`,
				[holdingId]
			) as Promise<Row[]>,
			// Productos presentes en el histórico (filtro de la bandeja por registro, Domi 18-10: selector, no texto libre).
			this.dataSource.query(
				`SELECT DISTINCT btrim(m.product_name) AS product_name FROM mrr_legacy m
				WHERE m.holding_id = $1 AND NULLIF(btrim(m.product_name), '') IS NOT NULL ORDER BY 1`,
				[holdingId]
			) as Promise<Row[]>,
		]);
		const currenciesOf = (kind: string) => currencies.filter((row) => row.kind === kind).map((row) => String(row.currency));

		return {
			companies: companies.map((row) => ({ id: String(row.id), legal_name: str(row.legal_name) })),
			countries: countries.map((row) => String(row.country)),
			currencies: { contract: currenciesOf('contract'), invoice: currenciesOf('invoice') },
			products: products.map((row) => String(row.product_name)),
		};
	}
}

/**
 * Arma las filas por dimensión (Domi 18-10): una por entidad (× moneda en `contract`/`invoice`), las `top` primeras por su `counted` en
 * moneda de sistema del último mes con datos (desempate por la suma del rango, luego etiqueta) y una fila "Otros" (por moneda) con el
 * resto, calculada como `counted` del mes − filas mostradas para que filas + Otros = `counted` al centavo. `total` = entidades distintas.
 */
export function groupRows(cells: Row[], months: Month[], mode: HistorySeriesCurrency, top: number, emptyLabel: string) {
	const index = new Map(months.map((month, position) => [month, position]));
	const byRow = new Map<string, SeriesGroupRow & { raw: number[]; system: number[] }>();
	const zeros = () => months.map(() => 0);

	for (const cell of cells) {
		const position = index.get(String(cell.month));

		if (position === undefined) continue;
		const key = String(cell.key);
		const currency = mode === 'system' ? null : String(cell.currency ?? '');
		const id = `${key}\u0000${currency ?? ''}`;
		let row = byRow.get(id);

		if (!row) {
			row = { key, label: str(cell.label) ?? (key === NO_KEY ? emptyLabel : key), currency, values: [], raw: zeros(), system: zeros() };
			byRow.set(id, row);
		}
		row.raw[position] += num(cell.counted);
		row.system[position] += num(cell.counted_system);
	}
	const all = [...byRow.values()].filter((row) => row.raw.some((amount) => amount !== 0) || row.system.some((amount) => amount !== 0));
	const total = new Set(all.map((row) => row.key)).size;
	const systemByMonth = months.map((_, position) => all.reduce((sum, row) => sum + row.system[position], 0));
	let last = -1;

	systemByMonth.forEach((amount, position) => {
		if (round2(amount) !== 0) last = position;
	});
	const sumOf = (list: number[]) => list.reduce((sum, amount) => sum + amount, 0);
	const ranked = [...all].sort(
		(a, b) =>
			(last >= 0 ? b.system[last] - a.system[last] : 0) ||
			sumOf(b.system) - sumOf(a.system) ||
			a.label.localeCompare(b.label) ||
			(a.currency ?? '').localeCompare(b.currency ?? '')
	);
	const shown = ranked.slice(0, top);
	const rest = ranked.slice(top);
	const rows: SeriesGroupRow[] = shown.map((row) => ({ key: row.key, label: row.label, currency: row.currency, values: row.raw.map(round2) }));

	for (const currency of [...new Set(rest.map((row) => row.currency))]) {
		const ofCurrency = all.filter((row) => row.currency === currency);
		const shownOfCurrency = rows.filter((row) => row.currency === currency);

		rows.push({
			...OTHERS,
			currency,
			values: months.map((_, position) =>
				round2(round2(sumOf(ofCurrency.map((row) => row.raw[position]))) - sumOf(shownOfCurrency.map((row) => row.values[position])))
			),
		});
	}

	return { rows, total };
}
