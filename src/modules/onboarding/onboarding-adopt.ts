import { round2, round6 } from './onboarding-common';

/**
 * Helpers puros de "Adoptar como factura del contrato" (spec `spec-onboarding-y-mrr-historico-v2.md` §4.5): una factura previa ya
 * emitida en el ERP pasa a ser la factura de uno o varios meses del contrato. Las líneas de la factura del contrato (con
 * `contract_item_id`, para que el devengo las cuente como facturado) se **reescalan** al neto que cubre la previa; el IVA se reparte por
 * peso del neto. Misma aritmética que `reconcile_legacy_with_por_emitir` del front anterior, con los centavos cuadrados.
 */

export interface AdoptSourceLine {
	id: string | null;
	contract_item_id: string | null;
	product_id: string | null;
	description: string;
	quantity: number;
	unit_of_measure: string | null;
	discount_pct: number;
	subtotal_contract_currency: number;
	tax_amount_contract_currency: number;
	tax_code: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity_source: string | null;
	pricing_breakdown: unknown;
	contract_currency: string;
}

export interface ScaledLine extends AdoptSourceLine {
	unit_price_contract_currency: number;
	total_contract_currency: number;
	unit_price_invoice_currency: number;
	subtotal_invoice_currency: number;
	tax_amount_invoice_currency: number;
	total_invoice_currency: number;
}

/**
 * Reparte `subtotalContract` e `vatContract` entre las líneas según su peso actual (a partes iguales si todas están en 0), redondea a
 * centavos y cuadra el resto en la línea mayor, de modo que Σ líneas = encabezado en las dos monedas. `fx` = contrato → factura.
 */
export function scaleLines(lines: AdoptSourceLine[], subtotalContract: number, vatContract: number, fx: number): ScaledLine[] {
	if (!lines.length) return [];
	const base = lines.map((line) => Math.max(line.subtotal_contract_currency, 0));
	const total = base.reduce((sum, value) => sum + value, 0);
	const weights = total > 0 ? base.map((value) => value / total) : lines.map(() => 1 / lines.length);
	const subtotals = splitExact(subtotalContract, weights);
	const taxes = splitExact(vatContract, weights);
	const subtotalsInvoice = splitExact(round2(subtotalContract * fx), weights);
	const taxesInvoice = splitExact(round2(vatContract * fx), weights);

	return lines.map((line, index) => {
		const quantity = line.quantity > 0 ? line.quantity : 1;

		return {
			...line,
			quantity,
			subtotal_contract_currency: subtotals[index],
			unit_price_contract_currency: round6(subtotals[index] / quantity),
			tax_amount_contract_currency: taxes[index],
			total_contract_currency: round2(subtotals[index] + taxes[index]),
			subtotal_invoice_currency: subtotalsInvoice[index],
			unit_price_invoice_currency: round6(subtotalsInvoice[index] / quantity),
			tax_amount_invoice_currency: taxesInvoice[index],
			total_invoice_currency: round2(subtotalsInvoice[index] + taxesInvoice[index]),
		};
	});
}

/** Reparte `amount` por pesos, a centavos, y pone la diferencia de redondeo en la parte de mayor peso. */
export function splitExact(amount: number, weights: number[]): number[] {
	if (!weights.length) return [];
	const parts = weights.map((weight) => round2(amount * weight));
	const diff = round2(amount - parts.reduce((sum, value) => sum + value, 0));

	if (diff !== 0) {
		const largest = weights.reduce((best, weight, index) => (weight > weights[best] ? index : best), 0);

		parts[largest] = round2(parts[largest] + diff);
	}

	return parts;
}

/**
 * Cómo se reparte el neto de la previa entre los meses que cubre: en proporción al neto de cada destino (Por Emitir o plantilla);
 * si ninguno tiene neto, a partes iguales. Devuelve la cobertura por destino, a centavos y cuadrada.
 */
export function allocateCoverage(amountContract: number, targetAmounts: Array<number | null>): number[] {
	const base = targetAmounts.map((value) => Math.max(value ?? 0, 0));
	const total = base.reduce((sum, value) => sum + value, 0);
	const weights = total > 0 ? base.map((value) => value / total) : base.map(() => 1 / base.length);

	return splitExact(amountContract, weights);
}

/** Estado de la factura del contrato según el de la factura previa (misma regla que `reconcile_legacy_with_por_emitir`). */
export function adoptedStatus(previousStatus: string | null): 'Pagada' | 'Vencida' | 'Enviada' | 'Emitida' {
	return previousStatus === 'Pagada' || previousStatus === 'Vencida' || previousStatus === 'Enviada' ? previousStatus : 'Emitida';
}

export const ADOPT_FX_RATE_SOURCE = 'previous_invoice';
/** `invoices.split_reason` del remanente que queda Por Emitir cuando la previa cubre solo parte (mismo valor que el front anterior). */
export const ADOPT_REMAINDER_SPLIT_REASON = 'legacy_partial';
