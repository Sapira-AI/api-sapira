import { INVOICE_SYSTEM_SOURCE_CURRENCY_SQL, mirrorInvoiceSystemAmounts, refreshInvoiceSystemAmounts } from './api-written-fields';
import { isCreditNote } from './contract-360';

import type { QueryRunner } from 'typeorm';

type Row = Record<string, unknown>;

/** Resultado del recálculo tras cambiar una tasa fija del holding (lo devuelve Configuración › Monedas). */
export interface HoldingFxRecalcResult {
	/** Primer mes recalculado (antes del cierre de cada compañía nunca se toca). null = no aplicaba. */
	from_month: string | null;
	contracts: number;
	invoices: number;
}

const NOTHING: HoldingFxRecalcResult = { from_month: null, contracts: 0, invoices: 0 };

/** Primer día del mes de una fecha `YYYY-MM-DD`. */
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

/**
 * Primer mes abierto de la compañía (`get_cutoff_date` + 1 mes) acotado por abajo con `$3` (alias `c` = contrato o factura con
 * `holding_id` y `company_id`). Los meses cerrados no se recalculan nunca.
 */
const openFromSql = (alias: string) =>
	`GREATEST($3::date, COALESCE((date_trunc('month', public.get_cutoff_date(${alias}.holding_id, ${alias}.company_id)) + interval '1 month')::date, $3::date))`;

/**
 * Recalcula lo que depende de una tasa fija del holding (`holding_fx_period_rates`, política `fixed_period`) después de crearla, editarla
 * o borrarla (decisión de Domi 04-10, tasa proyectada): desde el primer mes del período tocado, que afecta a ese período y a todos los
 * posteriores (los posteriores al mes en curso se proyectan desde la última tasa del par; un mes pasado o el actual sin tasa queda
 * "Sin tipo de cambio").
 *
 * - Devengo: `revenue_schedule_apply_fx_for_contract(contrato, mes)` (solo conversión, sin rebuild) de los contratos del holding en la
 *   otra moneda del par, desde `max(mes, primer mes abierto de su compañía)`.
 * - Facturas: `refreshInvoiceSystemAmounts` de las facturas (no NC) cuya moneda de conversión (regla por estado, 04-10: la de factura
 *   si ya es documento; la de contrato del encabezado si está Por Emitir o no tiene neto en moneda de factura:
 *   `INVOICE_SYSTEM_SOURCE_CURRENCY_SQL`) es la otra moneda del par y su fecha de tipo
 *   de cambio cae desde ese mes (y en período abierto); las NC espejo de esas facturas copian la tasa de la original.
 *
 * Solo aplica si el holding usa `fixed_period` y el par incluye la moneda del sistema. Corre en la transacción v2 de quien guarda la tasa
 * (`withApiWriter`: la tasa y el recálculo se confirman juntos o ninguno).
 */
export async function recalculateHoldingFx(
	runner: Pick<QueryRunner, 'query'>,
	holdingId: string,
	currencies: string[],
	fromDate: string
): Promise<HoldingFxRecalcResult> {
	const [settings] = (await runner.query(
		`SELECT COALESCE(system_currency, 'USD') AS system_currency, COALESCE(fx_system_policy, 'monthly_avg') AS fx_system_policy
		FROM holding_settings WHERE holding_id = $1`,
		[holdingId]
	)) as Row[];
	const system = String(settings?.system_currency ?? 'USD').toUpperCase();

	if (String(settings?.fx_system_policy ?? 'monthly_avg') !== 'fixed_period') return NOTHING;
	const codes = [...new Set(currencies.map((code) => code.trim().toUpperCase()))];

	if (!codes.includes(system)) return NOTHING;
	const others = codes.filter((code) => code !== system);

	if (!others.length) return NOTHING;
	const fromMonth = monthOf(fromDate);
	const contracts = (await runner.query(
		`SELECT c.id, ${openFromSql('c')}::text AS from_month
		FROM contracts c
		WHERE c.holding_id = $1 AND c.deleted_at IS NULL AND UPPER(TRIM(c.contract_currency)) = ANY($2::text[])
			AND EXISTS (SELECT 1 FROM revenue_schedule_monthly r WHERE r.contract_id = c.id AND r.period_month >= ${openFromSql('c')})
		ORDER BY c.id`,
		[holdingId, others, fromMonth]
	)) as Row[];

	for (const contract of contracts) {
		await runner.query(`SELECT public.revenue_schedule_apply_fx_for_contract($1::uuid, $2::date)`, [contract.id, contract.from_month]);
	}
	const invoices = (await runner.query(
		`SELECT i.id, i.document_type, i.related_invoice_id
		FROM invoices i
		JOIN contracts c ON c.id = i.contract_id
		WHERE i.holding_id = $1 AND i.status IS DISTINCT FROM 'Cancelada'
			AND ${INVOICE_SYSTEM_SOURCE_CURRENCY_SQL} = ANY($2::text[])
			AND COALESCE(i.issue_date, i.scheduled_at, i.original_issue_date, CURRENT_DATE) >= ${openFromSql('i')}
		ORDER BY i.id`,
		[holdingId, others, fromMonth]
	)) as Row[];
	const creditNotes = invoices.filter((row) => isCreditNote(row.document_type as string | null) && row.related_invoice_id);
	const notes = new Set(creditNotes.map((row) => String(row.id)));

	await refreshInvoiceSystemAmounts(
		runner,
		holdingId,
		invoices.filter((row) => !notes.has(String(row.id))).map((row) => String(row.id))
	);
	for (const note of creditNotes) await mirrorInvoiceSystemAmounts(runner, holdingId, String(note.id), String(note.related_invoice_id));

	return { from_month: fromMonth, contracts: contracts.length, invoices: invoices.length };
}
