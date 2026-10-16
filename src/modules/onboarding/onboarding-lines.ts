import { type Month, monthsBetween } from '@/modules/metrics/metrics-period';
import { legacyFirstRsmCte, legacyRemovedSql, legacySkipCodeSql } from '@/modules/metrics/mrr-historico';

import { encodeLineKey, num, numOrNull, type Row, str } from './onboarding-common';

import type { HistoryLineStatus } from './dtos/onboarding.dto';

/**
 * Lectura de las líneas de MRR histórico (§3.1) sobre `mrr_legacy`, sin tabla nueva. Una línea = cliente comercial × producto × moneda
 * de contrato; las filas siguen siendo mes × ítem de factura (varias filas en un mes se suman). Estado derivado, con precedencia:
 * - `pending` / `pending_ended`: tiene filas sin empalme ni cierre (`pending_ended` si su último mes ya pasó);
 * - `linked`: sin pendientes y con filas empalmadas (`migrated_to_contract_id`);
 * - `closed`: solo filas marcadas con motivo `churn` (fue baja; cuenta hasta su último mes);
 * - `removed`: solo filas quitadas (`duplicate` | `error`; no cuentan en nada).
 * El motivo sale de `legacySkipCodeSql` (columna `skip_reason_code` o, en las filas viejas, el texto libre).
 */

export interface LineSqlOptions {
	/** Placeholder del holding (`$1`). */
	holding: string;
	/** Placeholder del primer día del mes en curso del holding (`$2`). */
	today: string;
	/** Condiciones extra sobre las filas (`m`). */
	rowWhere?: string[];
}

/** CTEs `first_rsm`, `rws` (filas con motivo y último mes vivo), `lines` (agregado) y `st` (estado). */
export function lineCtes({ holding, today, rowWhere = [] }: LineSqlOptions): string {
	return `WITH ${legacyFirstRsmCte(holding)},
		rws AS (
			SELECT m.id, m.client_id, m.product_name, m.contract_currency, m.period_month, m.mrr_legacy, m.mrr_legacy_system_currency,
				m.migrated_to_contract_id, m.skip_activation, m.skip_activation_reason, m.skip_activation_at, m.batch_id, m.invoice_legacy_id,
				m.company_id, m.legal_client_name,
				${legacySkipCodeSql('m')} AS skip_code,
				${legacyRemovedSql('m')} AS removed,
				MAX(m.period_month) FILTER (WHERE NOT ${legacyRemovedSql('m')}) OVER (PARTITION BY m.client_id, m.product_name, m.contract_currency) AS live_last
			FROM mrr_legacy m
			WHERE m.holding_id = ${holding}${rowWhere.length ? ` AND ${rowWhere.join(' AND ')}` : ''}
		),
		lines AS (
			SELECT x.client_id, x.product_name, x.contract_currency,
				MIN(x.period_month) AS first_date, MAX(x.period_month) AS last_date, MAX(x.live_last) AS live_last,
				COUNT(DISTINCT x.period_month) AS months_count,
				COALESCE(SUM(x.mrr_legacy) FILTER (WHERE x.period_month = x.live_last AND NOT x.removed), 0) AS mrr_last,
				SUM(x.mrr_legacy_system_currency) FILTER (WHERE x.period_month = x.live_last AND NOT x.removed) AS mrr_last_system,
				BOOL_OR(x.migrated_to_contract_id IS NULL AND NOT x.skip_activation) AS has_pending,
				BOOL_OR(x.migrated_to_contract_id IS NOT NULL) AS has_linked,
				BOOL_OR(x.skip_code = 'churn') AS has_closed,
				(ARRAY_AGG(x.migrated_to_contract_id ORDER BY x.period_month DESC) FILTER (WHERE x.migrated_to_contract_id IS NOT NULL))[1] AS contract_id,
				ARRAY_AGG(DISTINCT x.batch_id) AS batch_ids,
				ARRAY_AGG(DISTINCT x.legal_client_name) AS legal_names,
				COUNT(DISTINCT x.invoice_legacy_id) AS invoices_count,
				(ARRAY_AGG(x.skip_code ORDER BY x.skip_activation_at DESC NULLS LAST, x.period_month DESC) FILTER (WHERE x.skip_activation))[1] AS skip_reason_code,
				(ARRAY_AGG(x.skip_activation_reason ORDER BY x.skip_activation_at DESC NULLS LAST, x.period_month DESC) FILTER (WHERE x.skip_activation))[1] AS skip_reason
			FROM rws x
			GROUP BY x.client_id, x.product_name, x.contract_currency
		),
		st AS (
			SELECT l.*,
				CASE WHEN l.has_pending THEN CASE WHEN l.last_date < ${today}::date THEN 'pending_ended' ELSE 'pending' END
					WHEN l.has_linked THEN 'linked' WHEN l.has_closed THEN 'closed' ELSE 'removed' END AS status,
				l.last_date < ${today}::date AS ended
			FROM lines l
		)`;
}

/** Columnas de salida de una línea (sobre `st`, `cl` cliente y `c` contrato). */
export function lineSelect(holding: string): string {
	return `st.client_id, st.product_name, st.contract_currency, to_char(st.first_date, 'YYYY-MM') AS first_month,
		to_char(st.last_date, 'YYYY-MM') AS last_month, to_char(st.live_last, 'YYYY-MM') AS live_last_month, st.months_count, st.mrr_last,
		st.mrr_last_system, st.status, st.ended, st.contract_id, st.batch_ids, st.invoices_count, st.skip_reason_code, st.skip_reason,
		cl.name_commercial AS client_name, c.contract_number, c.status AS contract_status,
		(SELECT p.id FROM products p WHERE p.holding_id = ${holding} AND lower(btrim(p.name)) = lower(btrim(st.product_name))
			ORDER BY p.created_at LIMIT 1) AS product_id`;
}

export const LINE_JOINS = `LEFT JOIN clients cl ON cl.id = st.client_id LEFT JOIN contracts c ON c.id = st.contract_id`;

export interface HistoryLine {
	key: string;
	client: { id: string; name: string | null };
	product_name: string;
	product_id: string | null;
	currency: string;
	first_month: Month | null;
	last_month: Month | null;
	months_count: number;
	mrr_last: number;
	mrr_last_system: number | null;
	status: HistoryLineStatus;
	ended: boolean;
	contract: { id: string; contract_number: string | null; status: string | null } | null;
	batch_ids: string[];
	invoices_count: number;
	skip_reason_code: string | null;
	skip_reason: string | null;
}

const arrayOf = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter(Boolean).map(String)
		: typeof value === 'string'
			? value
					.replace(/[{}]/g, '')
					.split(',')
					.filter((part) => part && part !== 'NULL')
			: [];

export function lineDto(row: Row): HistoryLine {
	const parts = {
		client_id: String(row.client_id),
		product_name: String(row.product_name ?? ''),
		contract_currency: String(row.contract_currency ?? ''),
	};

	return {
		key: encodeLineKey(parts),
		client: { id: parts.client_id, name: str(row.client_name) },
		product_name: parts.product_name,
		product_id: str(row.product_id),
		currency: parts.contract_currency,
		first_month: str(row.first_month),
		last_month: str(row.last_month),
		months_count: num(row.months_count),
		mrr_last: Math.round(num(row.mrr_last) * 100) / 100,
		mrr_last_system: numOrNull(row.mrr_last_system) === null ? null : Math.round(num(row.mrr_last_system) * 100) / 100,
		status: String(row.status) as HistoryLineStatus,
		ended: row.ended === true,
		contract: row.contract_id
			? { id: String(row.contract_id), contract_number: str(row.contract_number), status: str(row.contract_status) }
			: null,
		batch_ids: arrayOf(row.batch_ids),
		invoices_count: num(row.invoices_count),
		skip_reason_code: str(row.skip_reason_code),
		skip_reason: str(row.skip_reason),
	};
}

export interface Splice {
	gap_months: number;
	overlap_months: number;
	contract_first_month: Month | null;
}

/**
 * Empalme de una línea con un contrato (§3.1): hueco = meses entre el último mes vivo de la línea y el primer mes con MRR del contrato
 * (último + 1 = primero → 0); solape = meses de la línea desde ese primer mes (los corta U14).
 */
export function spliceOf(lastMonth: Month | null, contractFirstMonth: Month | null, lineMonths: Month[]): Splice {
	if (!lastMonth || !contractFirstMonth) return { gap_months: 0, overlap_months: 0, contract_first_month: contractFirstMonth };

	return {
		gap_months: Math.max(0, monthsBetween(lastMonth, contractFirstMonth) - 1),
		overlap_months: new Set(lineMonths.filter((month) => month >= contractFirstMonth)).size,
		contract_first_month: contractFirstMonth,
	};
}

/**
 * Puntaje de un contrato candidato para empalmar: +2 si tiene un ítem del mismo producto, +1 misma moneda, +1 si arranca justo al mes
 * siguiente del último de la línea.
 */
export function candidateScore(
	line: { product_name: string; currency: string; last_month: Month | null },
	contract: { products: string[]; currency: string | null; first_month: Month | null }
): number {
	const product = line.product_name.trim().toLowerCase();
	let score = 0;

	if (contract.products.some((name) => name.trim().toLowerCase() === product)) score += 2;
	if ((contract.currency ?? '').toUpperCase() === line.currency.toUpperCase()) score += 1;
	if (line.last_month && contract.first_month && monthsBetween(line.last_month, contract.first_month) === 1) score += 1;

	return score;
}
