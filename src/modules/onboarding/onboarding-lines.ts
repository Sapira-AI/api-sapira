import { type Month, monthsBetween } from '@/modules/metrics/metrics-period';
import {
	LEGACY_FIRST_RSM_JOIN,
	legacyAfterContractSql,
	legacyFirstRsmCte,
	legacyRemovedSql,
	legacySkipCodeSql,
} from '@/modules/metrics/mrr-historico';

import { encodeLineKey, encodeRootKey, num, numOrNull, type Row, str } from './onboarding-common';

import type { HistoryLineIssue, HistoryLineStatus } from './dtos/onboarding.dto';

/**
 * Lectura de los registros de MRR histórico (§3.1) sobre `mrr_legacy`, sin tabla nueva. **Registro** (Domi 18-10, definitivo) =
 * `batch_id` × cliente comercial × moneda de contrato × contrato (`migrated_to_contract_id`, o sin contrato): "un MRR legacy", las facturas
 * que la usuaria registró de una vez para un cliente, con **uno o varios productos** (lo que el front anterior agrupaba por `batch_id`). Las
 * filas siguen siendo mes × ítem de factura (varias filas en un mes se suman). Un `batch_id` con varios clientes (cargas masivas) se ve como
 * un registro por cliente; una serie con meses en dos contratos y meses sueltos son tres registros, nunca una pendiente que muestra un contrato.
 * Estado derivado:
 * - `linked`: el registro tiene contrato (todas sus filas lo tienen; la clave lleva el `contract_id`);
 * - sin contrato: `pending` (alguna fila sin marcar) → `closed` ("No activado": todas marcadas; el motivo es siempre `churn`).
 * El motivo sale de `legacySkipCodeSql`: columna `skip_reason_code`; una fila marcada sin código es `churn` (el texto libre no se interpreta,
 * Domi 18-10). Desde el 18-10 no hay estado `removed` ni acción "Quitar": un duplicado se corrige con "Editar línea" (`legacyRemovedSql` queda
 * en `mrr-historico.ts` por si quedara una fila con código `duplicate` | `error`; en prod no hay ninguna).
 * `products[]` (por producto: primer y último mes, meses, MRR de su último mes vivo), `first/last_month`, `live_last`, `mrr_last` (= Σ
 * `products[].mrr_last`: cada producto en **su** último mes vivo, como sumaba el front anterior y como nacen los ítems del contrato),
 * `months_count`, `invoices_count`, `companies`, `legal_names` y `registered_at` (primera fila) se calculan dentro del registro. Nada cambia
 * en los datos ni en las series y Métricas (que van por fila).
 *
 * Problemas de datos (`issues`, Domi 18-10), solo en registros con contrato: `history_after_contract` = tiene filas recurrentes no quitadas
 * en meses posteriores al primer mes con MRR de su contrato (`legacyAfterContractSql`). El mes de empalme (mismo mes) no es un problema.
 */

export interface LineSqlOptions {
	/** Placeholder del holding (`$1`). */
	holding: string;
	/** Condiciones extra sobre las filas (`m`). Solo columnas de la clave (cliente, lote, contrato): un filtro por producto va sobre `st`. */
	rowWhere?: string[];
}

/**
 * Condición de fila para el contrato de un registro: `migrated_to_contract_id IS NULL` (registro sin contrato) o `= <placeholder>`.
 * La usan todas las lecturas y escrituras por clave, para que una operación nunca cruce de un registro a otro de la misma raíz.
 */
export const contractRowSql = (alias: string, contractParam: string | null): string =>
	contractParam ? `${alias}.migrated_to_contract_id = ${contractParam}` : `${alias}.migrated_to_contract_id IS NULL`;

/** Columnas de la clave del registro sobre la fila `m`. */
const RECORD_OF_ROW = 'm.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id';

/**
 * CTEs `first_rsm`, `rws` (filas con motivo y último mes vivo del registro y del producto), `prods` (agregado por registro × producto),
 * `pj` (productos de cada registro como JSON, ordenados por MRR del último mes), `lines` (agregado por registro) y `st` (estado).
 */
export function lineCtes({ holding, rowWhere = [] }: LineSqlOptions): string {
	return `WITH ${legacyFirstRsmCte(holding)},
		rws AS (
			SELECT m.id, m.batch_id, m.client_id, m.contract_currency, m.product_name, m.period_month, m.mrr_legacy, m.mrr_legacy_system_currency,
				m.migrated_to_contract_id, m.skip_activation, m.skip_activation_reason, m.skip_activation_at, m.invoice_legacy_id,
				m.company_id, m.legal_client_name, m.created_at,
				${legacySkipCodeSql('m')} AS skip_code,
				${legacyRemovedSql('m')} AS removed,
				MAX(m.period_month) FILTER (WHERE NOT ${legacyRemovedSql('m')}) OVER (PARTITION BY ${RECORD_OF_ROW}) AS live_last,
				MAX(m.period_month) FILTER (WHERE NOT ${legacyRemovedSql('m')}) OVER (PARTITION BY ${RECORD_OF_ROW}, m.product_name) AS product_live_last,
				(COALESCE(m.is_recurring, false) AND NOT ${legacyRemovedSql('m')} AND ${legacyAfterContractSql('m', 'f')}) AS after_contract
			FROM mrr_legacy m ${LEGACY_FIRST_RSM_JOIN}
			WHERE m.holding_id = ${holding}${rowWhere.length ? ` AND ${rowWhere.join(' AND ')}` : ''}
		),
		prods AS (
			SELECT x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id AS contract_id, x.product_name,
				MIN(x.period_month) AS first_date, MAX(x.period_month) AS last_date, COUNT(DISTINCT x.period_month) AS months_count,
				COALESCE(SUM(x.mrr_legacy) FILTER (WHERE x.period_month = x.product_live_last AND NOT x.removed), 0) AS mrr_last,
				SUM(x.mrr_legacy_system_currency) FILTER (WHERE x.period_month = x.product_live_last AND NOT x.removed) AS mrr_last_system
			FROM rws x
			GROUP BY x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id, x.product_name
		),
		pj AS (
			SELECT p.batch_id, p.client_id, p.contract_currency, p.contract_id,
				json_agg(json_build_object('product_name', p.product_name,
					'product_id', (SELECT pr.id FROM products pr WHERE pr.holding_id = ${holding} AND lower(btrim(pr.name)) = lower(btrim(p.product_name))
						ORDER BY pr.created_at LIMIT 1),
					'first_month', to_char(p.first_date, 'YYYY-MM'), 'last_month', to_char(p.last_date, 'YYYY-MM'), 'months_count', p.months_count,
					'mrr_last', p.mrr_last, 'mrr_last_system', p.mrr_last_system) ORDER BY p.mrr_last DESC, p.product_name) AS products,
				ARRAY_AGG(p.product_name) AS product_names,
				(ARRAY_AGG(p.product_name ORDER BY p.mrr_last DESC, p.product_name))[1] AS top_product
			FROM prods p
			GROUP BY p.batch_id, p.client_id, p.contract_currency, p.contract_id
		),
		lines AS (
			SELECT x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id AS contract_id,
				MIN(x.period_month) AS first_date, MAX(x.period_month) AS last_date, MAX(x.live_last) AS live_last,
				COUNT(DISTINCT x.period_month) AS months_count,
				COALESCE(SUM(x.mrr_legacy) FILTER (WHERE x.period_month = x.product_live_last AND NOT x.removed), 0) AS mrr_last,
				SUM(x.mrr_legacy_system_currency) FILTER (WHERE x.period_month = x.product_live_last AND NOT x.removed) AS mrr_last_system,
				BOOL_OR(NOT x.skip_activation) AS has_pending,
				BOOL_OR(x.after_contract) AS has_after_contract,
				ARRAY_AGG(DISTINCT x.legal_client_name) FILTER (WHERE x.legal_client_name IS NOT NULL) AS legal_names,
				ARRAY_AGG(DISTINCT x.company_id) FILTER (WHERE x.company_id IS NOT NULL) AS company_ids,
				COUNT(DISTINCT x.invoice_legacy_id) AS invoices_count,
				MIN(x.created_at) AS registered_at,
				(ARRAY_AGG(x.skip_activation_reason ORDER BY x.skip_activation_at DESC NULLS LAST, x.period_month DESC) FILTER (WHERE x.skip_activation))[1] AS skip_reason
			FROM rws x
			GROUP BY x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id
		),
		st AS (
			SELECT l.*, CASE WHEN l.contract_id IS NOT NULL THEN 'linked' WHEN l.has_pending THEN 'pending' ELSE 'closed' END AS status
			FROM lines l
		)`;
}

/** Columnas de salida de un registro (sobre `st`, `pj` productos, `cl` cliente y `c` contrato). */
export function lineSelect(): string {
	return `st.batch_id, st.client_id, st.contract_currency, st.contract_id, to_char(st.first_date, 'YYYY-MM') AS first_month,
		to_char(st.last_date, 'YYYY-MM') AS last_month, to_char(st.live_last, 'YYYY-MM') AS live_last_month, st.months_count, st.mrr_last,
		st.mrr_last_system, st.status, st.has_after_contract, st.invoices_count, st.skip_reason, st.legal_names, st.registered_at,
		pj.products, cl.name_commercial AS client_name, c.contract_number, c.status AS contract_status,
		(SELECT COALESCE(json_agg(json_build_object('id', co.id, 'legal_name', co.legal_name) ORDER BY co.legal_name, co.id), '[]'::json)
			FROM companies co WHERE co.id = ANY(st.company_ids)) AS companies`;
}

/** Prioridad de estado para el orden por defecto de la bandeja (pendiente → relacionada → no activada). */
export const STATUS_PRIORITY_SQL = `CASE st.status WHEN 'pending' THEN 0 WHEN 'linked' THEN 1 ELSE 2 END`;

export const LINE_JOINS = `LEFT JOIN pj ON pj.batch_id = st.batch_id AND pj.client_id = st.client_id AND pj.contract_currency = st.contract_currency
		AND pj.contract_id IS NOT DISTINCT FROM st.contract_id
	LEFT JOIN clients cl ON cl.id = st.client_id LEFT JOIN contracts c ON c.id = st.contract_id`;

export interface HistoryLineProduct {
	product_name: string;
	/** Producto del catálogo con el mismo nombre (`mrr_legacy` no guarda `product_id`). */
	product_id: string | null;
	first_month: Month | null;
	last_month: Month | null;
	months_count: number;
	/** MRR del producto en su último mes vivo (moneda de contrato y de sistema). */
	mrr_last: number;
	mrr_last_system: number | null;
}

export interface HistoryLine {
	/** Clave del registro (`batch_id` × cliente × moneda × contrato), la de la URL. */
	key: string;
	/** Clave de la raíz (sin contrato): la misma antes y después de empalmar; la acepta `GET /onboarding/events?lineKey=`. */
	root_key: string;
	batch_id: string;
	client: { id: string; name: string | null };
	currency: string;
	/** Productos del registro, ordenados por MRR del último mes (desc). */
	products: HistoryLineProduct[];
	first_month: Month | null;
	last_month: Month | null;
	months_count: number;
	/** Σ `products[].mrr_last` (cada producto en su último mes vivo). */
	mrr_last: number;
	mrr_last_system: number | null;
	status: HistoryLineStatus;
	contract: { id: string; contract_number: string | null; status: string | null } | null;
	invoices_count: number;
	/** Nota libre del "No activado" (`skip_activation_reason`), si la hay. */
	skip_reason: string | null;
	/** Compañías emisoras de sus filas (Domi 18-10: el front sugiere registros "del mismo emisor y receptor"). */
	companies: Array<{ id: string; legal_name: string | null }>;
	/** Razones sociales (texto de las facturas) de sus filas. */
	legal_names: string[];
	/** Primera fila del registro (`MIN(created_at)`), ISO. */
	registered_at: string | null;
	/** Problemas de datos (Domi 18-10): `history_after_contract` si tiene histórico después del inicio de su contrato. */
	issues: HistoryLineIssue[];
}

/** `json_agg` llega como arreglo (pg) o como texto JSON. */
function jsonList(value: unknown): Row[] {
	const list = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

	return Array.isArray(list) ? (list as Row[]) : [];
}

export const companiesOf = (value: unknown): Array<{ id: string; legal_name: string | null }> =>
	jsonList(value).map((company) => ({ id: String(company.id), legal_name: str(company.legal_name) }));

export const productsOf = (value: unknown): HistoryLineProduct[] =>
	jsonList(value).map((product) => ({
		product_name: String(product.product_name ?? ''),
		product_id: str(product.product_id),
		first_month: str(product.first_month),
		last_month: str(product.last_month),
		months_count: num(product.months_count),
		mrr_last: Math.round(num(product.mrr_last) * 100) / 100,
		mrr_last_system: numOrNull(product.mrr_last_system) === null ? null : Math.round(num(product.mrr_last_system) * 100) / 100,
	}));

const arrayOf = (value: unknown): string[] =>
	Array.isArray(value)
		? value.filter(Boolean).map(String)
		: typeof value === 'string'
			? value
					.replace(/[{}]/g, '')
					.split(',')
					.map((part) => part.replace(/^"|"$/g, ''))
					.filter((part) => part && part !== 'NULL')
			: [];

const isoOf = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : str(value));

export function lineDto(row: Row): HistoryLine {
	const parts = {
		batch_id: String(row.batch_id),
		client_id: String(row.client_id),
		contract_currency: String(row.contract_currency ?? ''),
		contract_id: str(row.contract_id),
	};

	return {
		key: encodeLineKey(parts),
		root_key: encodeRootKey(parts),
		batch_id: parts.batch_id,
		client: { id: parts.client_id, name: str(row.client_name) },
		currency: parts.contract_currency,
		products: productsOf(row.products),
		first_month: str(row.first_month),
		last_month: str(row.last_month),
		months_count: num(row.months_count),
		mrr_last: Math.round(num(row.mrr_last) * 100) / 100,
		mrr_last_system: numOrNull(row.mrr_last_system) === null ? null : Math.round(num(row.mrr_last_system) * 100) / 100,
		status: String(row.status) as HistoryLineStatus,
		contract: row.contract_id
			? { id: String(row.contract_id), contract_number: str(row.contract_number), status: str(row.contract_status) }
			: null,
		invoices_count: num(row.invoices_count),
		skip_reason: str(row.skip_reason),
		companies: companiesOf(row.companies),
		legal_names: arrayOf(row.legal_names),
		registered_at: isoOf(row.registered_at),
		issues: row.has_after_contract === true ? ['history_after_contract'] : [],
	};
}

export interface Splice {
	gap_months: number;
	/** Mes de empalme: el primer mes con MRR del contrato si el registro también tiene histórico ese mes (normal; se corta en silencio). */
	seam_month: Month | null;
	/** Meses del registro posteriores al primer mes con MRR del contrato: error de datos a corregir (U14 los corta). */
	months_after_contract: Month[];
	contract_first_month: Month | null;
}

/**
 * Empalme de un registro con un contrato (§3.1, Domi 18-10): hueco = meses entre el último mes vivo del registro y el primer mes con MRR del
 * contrato (último + 1 = primero → 0); `seam_month` = ese primer mes si el registro lo tiene (mes de empalme, normal con ciclos a mitad de
 * mes); `months_after_contract` = meses del registro posteriores (histórico después del inicio del contrato, a corregir).
 */
export function spliceOf(lastMonth: Month | null, contractFirstMonth: Month | null, lineMonths: Month[]): Splice {
	if (!lastMonth || !contractFirstMonth) {
		return { gap_months: 0, seam_month: null, months_after_contract: [], contract_first_month: contractFirstMonth };
	}

	return {
		gap_months: Math.max(0, monthsBetween(lastMonth, contractFirstMonth) - 1),
		seam_month: lineMonths.includes(contractFirstMonth) ? contractFirstMonth : null,
		months_after_contract: [...new Set(lineMonths.filter((month) => month > contractFirstMonth))].sort(),
		contract_first_month: contractFirstMonth,
	};
}

/**
 * Puntaje de un contrato candidato para empalmar: +2 si tiene un ítem de alguno de los productos del registro, +1 misma moneda, +1 si
 * arranca justo al mes siguiente del último del registro.
 */
export function candidateScore(
	line: { products: string[]; currency: string; last_month: Month | null },
	contract: { products: string[]; currency: string | null; first_month: Month | null }
): number {
	const names = new Set(line.products.map((name) => name.trim().toLowerCase()));
	let score = 0;

	if (contract.products.some((name) => names.has(name.trim().toLowerCase()))) score += 2;
	if ((contract.currency ?? '').toUpperCase() === line.currency.toUpperCase()) score += 1;
	if (line.last_month && contract.first_month && monthsBetween(line.last_month, contract.first_month) === 1) score += 1;

	return score;
}
