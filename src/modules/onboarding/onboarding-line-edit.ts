import { type Month } from '@/modules/metrics/metrics-period';
import { REMOVED_REASON_CODES } from '@/modules/metrics/mrr-historico';

import { round2, round6 } from './onboarding-common';

import type { RegisterPlan } from './onboarding-register.service';

/**
 * "Editar línea" = volver a registrar sus facturas (Domi 14-10, "las facturas son la fuente"): no existen meses sin factura. Helpers puros
 * de la edición: la fila de una línea, el registro actual de cada factura (para prellenar), las filas que generaría el motor de Registrar
 * histórico y la comparación antes/después por factura × mes que muestra la vista previa.
 */

/** Fila de `mrr_legacy` de una línea (o de la línea de destino), con lo que necesita la edición. */
export interface LineEditRow {
	id: string | null;
	invoice_id: string;
	invoice_number: string | null;
	period: Month;
	subtotal: number;
	term: number;
	is_recurring: boolean;
	mrr: number | null;
	/** Guardado (filas existentes); en las nuevas lo calcula la vista previa. */
	mrr_system: number | null;
	fx_system: number | null;
	allocated: number;
	fx_invoice: number;
	invoice_currency: string | null;
	contract_id: string | null;
	skip_code: string | null;
	/** Producto de la fila (el registro agrupa varios, Domi 18-10). */
	product_name: string | null;
	/** Clave cruda del registro donde queda la fila (`batch_id|client_id|contract_currency|<contrato>`). */
	line_key: string;
	/** Fila generada por la edición (no existe aún). */
	generated?: boolean;
}

export const isRemovedRow = (row: { skip_code: string | null }) => (REMOVED_REASON_CODES as readonly string[]).includes(row.skip_code ?? '');
const monthlyOf = (row: { subtotal: number; term: number }) => row.subtotal / (row.term || 1);

/**
 * Registro actual de una factura en la línea (para prellenar "Editar línea"): período = primer y último mes de sus filas, monto en moneda
 * de contrato = Σ subtotal ÷ plazo (cada fila es la parte de un mes), recurrente si todas lo son. Ignora las filas quitadas salvo que no
 * haya otras.
 */
export function invoiceRegistration(rows: Array<{ period: Month; subtotal: number; term: number; is_recurring: boolean; skip_code: string | null }>) {
	const live = rows.filter((row) => !isRemovedRow(row));
	const base = live.length ? live : rows;
	const periods = base.map((row) => row.period).sort();

	return {
		period_from: periods[0],
		period_to: periods[periods.length - 1],
		amount_contract_currency: round2(base.reduce((sum, row) => sum + monthlyOf(row), 0)),
		is_recurring: base.every((row) => row.is_recurring),
	};
}

/** Monto en moneda de factura que la línea tiene asignado de una factura (Σ asignado ÷ plazo de sus filas). */
export const lineInvoiceAmount = (rows: Array<{ allocated: number; term: number }>) =>
	round2(rows.reduce((sum, row) => sum + row.allocated / (row.term || 1), 0));

/**
 * Filas que generaría el motor de Registrar histórico para un plan (mismas fórmulas que `insertRows`). `rawKeyOf` da la clave cruda del
 * registro de destino para la moneda de contrato del plan (el producto ya no cambia de registro: vive dentro, Domi 18-10).
 */
export function generatedRows(plan: RegisterPlan, rawKeyOf: (contractCurrency: string) => string): LineEditRow[] {
	const term = plan.months.length;
	const recurring = plan.input.is_recurring !== false;
	const fx = plan.fx_contract_to_invoice ?? 1;

	return plan.products.flatMap((product) =>
		plan.months
			.filter((month) => !product.covered.includes(month))
			.map((month) => ({
				id: null,
				invoice_id: plan.invoice_id,
				invoice_number: plan.invoice_number,
				period: month,
				subtotal: product.amount,
				term,
				is_recurring: recurring,
				mrr: recurring ? round2(product.amount / term) : null,
				mrr_system: null,
				fx_system: null,
				allocated: round2(product.amount * fx),
				fx_invoice: Math.max(round6(fx), 0.000001),
				invoice_currency: plan.invoice_currency,
				contract_id: null,
				skip_code: null,
				product_name: product.product_name,
				line_key: rawKeyOf(plan.input.contract_currency),
				generated: true,
			}))
	);
}

export type EditEntryStatus = 'kept' | 'changed' | 'added' | 'removed';

export interface EditEntry {
	invoice_id: string;
	invoice_number: string | null;
	period: Month;
	status: EditEntryStatus;
	rows: LineEditRow[];
}

/** Totales de un grupo de filas (factura × mes): monto mensual, MRR, monto en factura y tipo de cambio. */
export function entryTotals(rows: LineEditRow[]) {
	const subtotal = round2(rows.reduce((sum, row) => sum + monthlyOf(row), 0));
	const amountInvoice = round2(rows.reduce((sum, row) => sum + row.allocated / (row.term || 1), 0));

	return {
		subtotal,
		mrr: round2(rows.reduce((sum, row) => sum + (row.is_recurring ? (row.mrr ?? 0) : 0), 0)),
		amount_invoice: amountInvoice,
		// Un solo tipo de cambio en el grupo (lo normal): ese, sin pasar por montos redondeados; si no, el implícito.
		fx_invoice:
			new Set(rows.map((row) => row.fx_invoice)).size === 1
				? (rows[0]?.fx_invoice ?? null)
				: subtotal !== 0 && amountInvoice !== 0
					? round6(Math.abs(amountInvoice / subtotal))
					: (rows[0]?.fx_invoice ?? null),
		invoice_currency: rows.find((row) => row.invoice_currency)?.invoice_currency ?? null,
		is_recurring: rows.every((row) => row.is_recurring),
		/** Productos del grupo (distintos, en orden alfabético). */
		products: [...new Set(rows.map((row) => row.product_name ?? ''))].filter(Boolean).sort(),
	};
}

/** Antes/después por factura × mes: `kept` (igual), `changed` (montos, recurrencia, productos o registro), `added` (solo después) y `removed` (solo antes). */
export function diffEntries(before: LineEditRow[], after: LineEditRow[]): EditEntry[] {
	const group = (rows: LineEditRow[]) => {
		const map = new Map<string, LineEditRow[]>();

		for (const row of rows) map.set(`${row.invoice_id}|${row.period}`, [...(map.get(`${row.invoice_id}|${row.period}`) ?? []), row]);

		return map;
	};
	const was = group(before);
	const now = group(after);
	const entries: EditEntry[] = [];

	for (const [key, rows] of now) {
		const previous = was.get(key);
		let status: EditEntryStatus = 'added';

		if (previous) {
			const a = entryTotals(previous);
			const b = entryTotals(rows);

			// Cambia si cambian montos, recurrencia o productos, o si el mes pasó a otro registro (moneda distinta).
			const sameLine = [...new Set(previous.map((row) => row.line_key))].join() === [...new Set(rows.map((row) => row.line_key))].join();
			const sameProducts = a.products.join('|') === b.products.join('|');

			status =
				sameLine &&
				sameProducts &&
				a.subtotal === b.subtotal &&
				a.mrr === b.mrr &&
				a.is_recurring === b.is_recurring &&
				a.amount_invoice === b.amount_invoice
					? 'kept'
					: 'changed';
		}
		entries.push({ invoice_id: rows[0].invoice_id, invoice_number: rows[0].invoice_number, period: rows[0].period, status, rows });
	}
	for (const [key, rows] of was) {
		if (!now.has(key))
			entries.push({ invoice_id: rows[0].invoice_id, invoice_number: rows[0].invoice_number, period: rows[0].period, status: 'removed', rows });
	}

	return entries.sort((a, b) => a.period.localeCompare(b.period) || String(a.invoice_number).localeCompare(String(b.invoice_number)));
}
