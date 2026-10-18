import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { loadMetricsHistoryStart } from '@/core/utils/holding-preferences';
import { type Month, monthRange, monthsBetween, monthStart } from '@/modules/metrics/metrics-period';
import { LEGACY_FIRST_RSM_JOIN, legacyCountedConditions, legacyFirstRsmCte, legacyRemovedSql } from '@/modules/metrics/mrr-historico';
import { NOT_PENDING_RENEWAL } from '@/modules/metrics/rsm-momentum';

import { num, round2, type Row, str } from './onboarding-common';

import type { HistorySeriesCurrency, HistorySeriesQueryDto } from './dtos/onboarding.dto';

/** Tope de meses de la serie (la historia de SimpliRoute ya pasa los 36 de Métricas). */
export const HISTORY_SERIES_MAX_MONTHS = 120;

/** Montos de un mes (o de una moneda en un mes). */
export interface SeriesAmounts {
	counted: number;
	cut: number;
	removed: number;
}

export interface SeriesMonth {
	month: Month;
	counted: number | null;
	cut: number | null;
	removed: number | null;
	contracts: number;
	by_currency: Array<{ currency: string } & SeriesAmounts>;
}

/**
 * Condición SQL de fila **cortada** (solape, U14): recurrente, no quitada y en un mes ≥ primer mes con MRR de su contrato empalmado. Es el
 * complemento exacto de `legacyCountedConditions()` entre las filas recurrentes no quitadas. Necesita `m` y `f` (`first_rsm`).
 */
const CUT_SQL = `(f.first_month IS NOT NULL AND m.period_month >= f.first_month)`;

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
		const filtersApplied = {
			currency: mode,
			companyId: query.companyId ?? null,
			clientId: query.clientId ?? null,
			entityId: query.entityId ?? null,
			country: query.country ?? null,
			from,
			to,
		};
		const empty = { last_month: null, counted_last: 0, lines: 0, clients: 0 };

		if (!from || !to) {
			return { currency_mode: mode, system_currency: systemCurrency, months: [], totals: empty, filters_applied: filtersApplied };
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
		const counted = legacyCountedConditions().join(' AND ');
		const removed = legacyRemovedSql('m');
		const value = VALUE_SQL[mode];
		const systemValue = VALUE_SQL.system;
		const [amounts, contracts, [lineTotals]] = await Promise.all([
			// Una fila por mes × moneda (sistema: una sola). Solo filas recurrentes: el MRR histórico es recurrente.
			this.dataSource.query(
				`WITH ${legacyFirstRsmCte('$1')}
				SELECT to_char(m.period_month, 'YYYY-MM') AS month, ${CURRENCY_SQL[mode]} AS currency,
					COALESCE(SUM(${value}) FILTER (WHERE ${counted}), 0) AS counted,
					COALESCE(SUM(${value}) FILTER (WHERE NOT ${removed} AND ${CUT_SQL}), 0) AS cut,
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
		]);
		const contractsByMonth = new Map(contracts.map((row) => [String(row.month), round2(num(row.contracts))]));
		const months: SeriesMonth[] = monthRange(from, to).map((month) => {
			const rows = amounts.filter((row) => String(row.month) === month);
			const sum = (key: keyof SeriesAmounts) => round2(rows.reduce((total, row) => total + num(row[key]), 0));

			return {
				month,
				counted: mode === 'system' ? sum('counted') : null,
				cut: mode === 'system' ? sum('cut') : null,
				removed: mode === 'system' ? sum('removed') : null,
				contracts: contractsByMonth.get(month) ?? 0,
				by_currency:
					mode === 'system'
						? []
						: rows.map((row) => ({
								currency: String(row.currency ?? ''),
								counted: round2(num(row.counted)),
								cut: round2(num(row.cut)),
								removed: round2(num(row.removed)),
							})),
			};
		});
		const lastRows = amounts.filter((row) => String(row.month) === to);

		return {
			currency_mode: mode,
			system_currency: systemCurrency,
			months,
			totals: {
				last_month: to,
				// Siempre en moneda de sistema (un KPI comparable en los tres modos).
				counted_last: round2(lastRows.reduce((total, row) => total + num(row.counted_system), 0)),
				lines: num(lineTotals?.lines),
				clients: num(lineTotals?.clients),
			},
			filters_applied: filtersApplied,
		};
	}

	/** Opciones de filtro de la serie: lo presente en el MRR histórico del holding. */
	async filterOptions(holdingId: string) {
		const [companies, countries, currencies] = await Promise.all([
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
		]);
		const currenciesOf = (kind: string) => currencies.filter((row) => row.kind === kind).map((row) => String(row.currency));

		return {
			companies: companies.map((row) => ({ id: String(row.id), legal_name: str(row.legal_name) })),
			countries: countries.map((row) => String(row.country)),
			currencies: { contract: currenciesOf('contract'), invoice: currenciesOf('invoice') },
		};
	}
}
