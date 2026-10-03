/**
 * Indicadores de Cuentas por cobrar (Cobranza, revisión 02-10): **DSO** (días de venta pendientes de cobro, portado del reporte AR del front
 * anterior, `ARAgingReport` + `useARReport`) y el chequeo de datos **monto en sistema inconsistente**. Funciones puras + el SQL que las
 * alimenta (sobre la CTE `d` de `invoicesCte`).
 *
 * **DSO** (fórmula del reporte anterior, ventana de 90 días): `DSO = round(Por cobrar ÷ Facturado de los últimos 90 días × 90)`, ambos en
 * moneda de sistema (lo único sumable entre monedas; cada factura convierte con su propia razón `total_system_currency ÷ total`).
 * - Por cobrar al corte: saldo de las facturas emitidas hasta el corte (no NC, no anuladas, activas, Emitida · Enviada · Vencida · Pagada)
 *   menos los pagos confirmados con fecha ≤ corte. Una Pagada sin pagos que la cubran cuenta 0 (misma regla de saldo que la antigüedad: no
 *   se sabe cuándo se pagó).
 * - Facturado de la ventana: total en sistema de esas mismas facturas con `issue_date` entre corte − 90 días y el corte (inclusive).
 * - Sin facturado en la ventana ⇒ `null`. Las facturas sin conversión a sistema y las CLF/UF no suman en ninguno de los dos.
 * - Diferencias con el reporte anterior: no lee `invoices_legacy` (v2 trabaja sobre `invoices`) y descuenta solo pagos en la moneda de la
 *   factura (antes sumaba cualquier pago al total en sistema).
 * - Histórico (tendencia, corte = fin de cada mes): saldo reconstruido con las **fechas** de emisión y de pago (no con el estado de hoy);
 *   las Canceladas de hoy no entran aunque hayan estado abiertas en el pasado.
 *
 * **Monto en sistema inconsistente**: factura con saldo cuya razón `total_system_currency ÷ total` está a más de 10× (por arriba o por abajo)
 * de la mediana de la misma moneda y mes de emisión del holding. No se excluye ni se corrige (regla de Domi: nunca ajustar el sistema por un
 * dato malo, solo informarlo): se cuenta y se listan hasta 20 para revisarlas.
 */
import { addDays } from './billing-calendar';
import { NON_INVOICING_CURRENCIES, PAYMENT_EPSILON, RECEIVABLE_STATUSES } from './billing-states';

export const DSO_WINDOW_DAYS = 90;
export const SYSTEM_RATIO_FACTOR = 10;
export const DATA_CHECK_SAMPLE = 20;
export const DSO_TREND_MAX_MONTHS = 24;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const pad = (value: number) => String(value).padStart(2, '0');

/** DSO = Por cobrar ÷ Facturado de la ventana × días de la ventana (redondeado); `null` sin facturado. */
export function dsoOf(receivableSystem: number, billedSystem: number, windowDays = DSO_WINDOW_DAYS): number | null {
	return billedSystem > 0 ? Math.round((receivableSystem / billedSystem) * windowDays) : null;
}

/** Último día del mes anterior al de `date`. */
export const previousMonthEnd = (date: string) => addDays(`${date.slice(0, 7)}-01`, -1);

/**
 * Cortes de la tendencia de DSO: el fin de cada uno de los `months − 1` meses anteriores y `asOf` (el mes en curso, a hoy). Orden ascendente.
 */
export function dsoTrendCuts(asOf: string, months: number): string[] {
	const cuts = [asOf];
	let cursor = asOf;

	for (let index = 1; index < months; index += 1) {
		cursor = previousMonthEnd(cursor);
		cuts.unshift(cursor);
	}

	return cuts;
}

/** Mes `YYYY-MM` de un corte (etiqueta del punto de la tendencia). */
export const monthOfCut = (cut: string) => `${cut.slice(0, 4)}-${pad(Number(cut.slice(5, 7)))}`;

/** Universo de AR (columnas de `d`): factura emitida, activa, no anulada, valorizada, en moneda de facturación. */
export const RECEIVABLE_UNIVERSE_SQL = `d.is_active AND NOT d.voided AND d.document_kind = 'invoice' AND d.total_due IS NOT NULL
	AND d.status IN (${quoted(RECEIVABLE_STATUSES)}) AND d.invoice_currency NOT IN (${quoted(NON_INVOICING_CURRENCIES)})`;

/**
 * DSO por corte (`cuts` = `$n` con `date[]`): una fila por corte con `ar_system`, `billed_system` y `unconverted`. `holding` = `$n` del holding.
 * Se antepone la CTE `d` (filtros de la vista, sin período).
 */
export function dsoSql(cte: string, holding: string, cuts: string): string {
	const issued = `COALESCE(d.issue_date, d.scheduled_at)::date`;

	return `${cte}, cuts AS (SELECT DISTINCT unnest(${cuts}::date[]) AS cut),
	paid AS (
		SELECT p.invoice_id, c.cut, SUM(p.amount) AS paid
		FROM invoice_payments p JOIN d ON d.id = p.invoice_id JOIN cuts c ON p.payment_date <= c.cut
		WHERE p.holding_id = ${holding} AND p.confirmed = true AND UPPER(p.currency) = d.invoice_currency
		GROUP BY 1, 2
	)
	SELECT c.cut::text AS cut,
		COALESCE(SUM(CASE WHEN d.status = 'Pagada' AND d.paid_amount < d.total_due - ${PAYMENT_EPSILON} THEN 0
			ELSE GREATEST(d.total_due - COALESCE(pd.paid, 0), 0) * d.total_system_currency / NULLIF(d.total_due, 0) END)
			FILTER (WHERE ${issued} <= c.cut), 0) AS ar_system,
		COALESCE(SUM(d.total_system_currency) FILTER (WHERE d.issue_date::date >= c.cut - ${DSO_WINDOW_DAYS} AND d.issue_date::date <= c.cut), 0) AS billed_system,
		COUNT(*) FILTER (WHERE d.total_system_currency IS NULL AND ${issued} <= c.cut
			AND (d.total_due - COALESCE(pd.paid, 0)) > ${PAYMENT_EPSILON}) AS unconverted
	FROM cuts c CROSS JOIN d
	LEFT JOIN paid pd ON pd.invoice_id = d.id AND pd.cut = c.cut
	WHERE ${RECEIVABLE_UNIVERSE_SQL}
	GROUP BY c.cut ORDER BY c.cut`;
}

/**
 * Facturas con saldo cuyo monto en sistema es inconsistente (ver encabezado). `holding` = `$n` del holding; `cut` = `$n` del corte (solo
 * emitidas hasta el corte). Devuelve una fila por factura (mayor monto en sistema primero).
 */
export function systemAmountChecksSql(cte: string, holding: string, cut: string): string {
	const issued = (alias: string) => `COALESCE(${alias}.issue_date, ${alias}.scheduled_at)`;

	return `${cte}, ratios AS (
		SELECT UPPER(COALESCE(i.invoice_currency, i.contract_currency)) AS currency, to_char(${issued('i')}::date, 'YYYY-MM') AS month,
			percentile_cont(0.5) WITHIN GROUP (ORDER BY i.total_system_currency / COALESCE(i.total_invoice_currency, i.amount_invoice_currency)) AS median_ratio
		FROM invoices i
		WHERE i.holding_id = ${holding} AND i.is_active AND i.total_system_currency > 0 AND COALESCE(i.total_invoice_currency, i.amount_invoice_currency) > 0
			AND ${issued('i')} IS NOT NULL
		GROUP BY 1, 2
	)
	SELECT d.id, d.invoice_number, d.client_id, d.client_name, d.company_name, d.invoice_currency AS currency, LEFT(${issued('d')}, 10) AS issue_date,
		d.total_due, d.total_system_currency, d.balance, d.balance * d.total_system_currency / d.total_due AS balance_system,
		d.total_system_currency / d.total_due AS ratio, r.median_ratio
	FROM d JOIN ratios r ON r.currency = d.invoice_currency AND r.month = to_char(${issued('d')}::date, 'YYYY-MM')
	WHERE ${RECEIVABLE_UNIVERSE_SQL} AND d.balance > ${PAYMENT_EPSILON} AND ${issued('d')}::date <= ${cut}::date
		AND d.total_due > 0 AND d.total_system_currency > 0 AND r.median_ratio > 0
		AND (d.total_system_currency / d.total_due > r.median_ratio * ${SYSTEM_RATIO_FACTOR}
			OR d.total_system_currency / d.total_due < r.median_ratio / ${SYSTEM_RATIO_FACTOR})
	ORDER BY d.total_system_currency DESC, d.id`;
}

export interface DataCheckInvoice {
	id: string;
	invoice_number: string | null;
	client_id: string | null;
	client_name: string | null;
	company_name: string | null;
	currency: string;
	issue_date: string | null;
	total: number;
	total_system: number;
	balance_system: number;
	ratio: number;
	median_ratio: number;
}

export interface DataCheck {
	code: 'system_amount_inconsistent';
	count: number;
	/** Saldo en sistema de las facturas marcadas (lo que puede estar inflando o achicando el total). */
	balance_system: number;
	message: string;
	invoices_sample: DataCheckInvoice[];
}

/** `data_checks[]` desde las filas de `systemAmountChecksSql` (vacío si no hay ninguna). */
export function systemAmountDataChecks(rows: Array<Record<string, unknown>>): DataCheck[] {
	if (!rows.length) return [];
	const number = (value: unknown) => Number(value ?? 0) || 0;
	const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
	const round = (value: number, decimals = 2) => Math.round(value * 10 ** decimals) / 10 ** decimals;
	const balance = round(rows.reduce((sum, row) => sum + number(row.balance_system), 0));

	return [
		{
			code: 'system_amount_inconsistent',
			count: rows.length,
			balance_system: balance,
			message: `${rows.length} factura(s) con un monto en moneda de sistema más de ${SYSTEM_RATIO_FACTOR}× fuera del tipo de cambio habitual de su moneda y mes: revisa su monto en sistema (no se corrigen ni se excluyen)`,
			invoices_sample: rows.slice(0, DATA_CHECK_SAMPLE).map((row) => ({
				id: String(row.id),
				invoice_number: text(row.invoice_number),
				client_id: text(row.client_id),
				client_name: text(row.client_name),
				company_name: text(row.company_name),
				currency: String(row.currency),
				issue_date: text(row.issue_date),
				total: round(number(row.total_due)),
				total_system: round(number(row.total_system_currency)),
				balance_system: round(number(row.balance_system)),
				ratio: round(number(row.ratio), 6),
				median_ratio: round(number(row.median_ratio), 6),
			})),
		},
	];
}
