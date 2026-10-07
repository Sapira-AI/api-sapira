import { addDays, BILLING_FREQUENCY_MONTHS, type BillingEngineItem, diffDays, itemPeriods, round2 } from './billing-engine';

import type { DeviationView, EditLineRow } from './invoice-edit';

/**
 * Fin de un ítem que no calza con el ciclo de facturación (caso S02762 de SimpliRoute, decisión de Domi 07-10: el prorrateo solo va en el
 * primer mes, nunca al final). Si el fin cae a mitad de un ciclo (p. ej. ciclo 21 → 20 y el ítem termina el 31-07), el motor cobra el último
 * tramo prorrateado (21-07 → 31-07) y las Por Emitir heredadas del front viejo suelen cobrar el mes completo: el plan y la factura no calzan.
 */

type CycleItem = Pick<BillingEngineItem, 'start_date' | 'end_date' | 'term_months' | 'billing_frequency' | 'billing_method' | 'billing_anchor_day'>;

/** Último período parcial del ítem (el fin no calza con el ciclo) o null si termina en un fin de ciclo, no tiene fin o es su único período. */
export function lastPartialPeriod(
	item: CycleItem,
	contractAnchor: number
): { period_start: string; period_end: string; months: number; days: number } | null {
	if (!item.start_date || !item.end_date || item.end_date < item.start_date) return null;
	const periods = itemPeriods(item, contractAnchor);
	const last = periods.at(-1);
	const frequency = BILLING_FREQUENCY_MONTHS[item.billing_frequency as keyof typeof BILLING_FREQUENCY_MONTHS] ?? 1;

	// Un solo período (o el último es el tramo inicial): el prorrateo es el del primer mes, que sí corresponde.
	if (!last || periods.length < 2 || last.period_start === item.start_date) return null;
	if (last.months >= frequency - 1e-9) return null;

	return {
		period_start: last.period_start,
		period_end: last.period_end,
		months: last.months,
		days: diffDays(last.period_start, last.period_end) + 1,
	};
}

/**
 * Sugerencia "Alinear al ciclo": el último fin de ciclo ≤ fin actual (el día anterior al inicio del último período parcial: con ciclo 21,
 * el día 20). Null si el fin ya calza con el ciclo (o el ítem no tiene fin). Pura: la usan `item_update` (fecha de fin) y la causa del desvío.
 */
export function cycleAlignedEnd(item: CycleItem, contractAnchor: number): string | null {
	const partial = lastPartialPeriod(item, contractAnchor);

	if (!partial) return null;
	const end = addDays(partial.period_start, -1);

	return end >= item.start_date ? end : null;
}

/** Causa detectada del desvío de una Por Emitir contra el plan (`GET /contracts/:id/invoices/deviations`). */
export interface EndOffCycleCause {
	code: 'end_off_cycle';
	item_id: string;
	product_name: string | null;
	/** Fin actual del ítem (a mitad de ciclo). */
	item_end: string;
	/** Día de ciclo con que se factura el ítem. */
	cycle_day: number;
	/** Fin alineado al ciclo (`cycleAlignedEnd`). */
	suggested_end: string;
	/** Inicio y fin del último período del ítem según el contrato (el tramo parcial). */
	period_start: string;
	period_end: string;
	/** Lo que corresponde según el contrato (motor) y lo que cobra la factura, en moneda de contrato. */
	plan_amount: number;
	invoice_amount: number;
	/** Días del tramo parcial. */
	days: number;
	/** La línea del ítem en la factura (si es una sola): lo que "Cobrar solo los días" reescribe con el monto del plan. */
	line: {
		id: string;
		quantity: number;
		unit_price: number;
		discount_pct: number;
		billing_period_start: string;
		billing_period_end: string | null;
	} | null;
}

/**
 * ¿El desvío de una fila (ítem × período) de la factura se explica porque el fin del ítem no calza con el ciclo? Sí cuando el período es el
 * último del ítem, es parcial porque el fin cae a mitad de ciclo y la factura cobra más que el plan. Sin baja (su fin lo marca la baja).
 */
export function endOffCycleCause(
	row: { contract_item_id: string; product_name: string | null; period_start: string; expected: number; actual: number; diff: number },
	item: (CycleItem & { is_recurring?: boolean }) | null | undefined,
	contractAnchor: number,
	options: { churned?: boolean; line?: EndOffCycleCause['line'] } = {}
): EndOffCycleCause | null {
	if (!item || item.is_recurring === false || options.churned || !item.end_date || row.diff <= 0) return null;
	const partial = lastPartialPeriod(item, contractAnchor);

	if (!partial || partial.period_start !== row.period_start) return null;
	const suggested = cycleAlignedEnd(item, contractAnchor);

	if (!suggested) return null;

	return {
		code: 'end_off_cycle',
		item_id: row.contract_item_id,
		product_name: row.product_name,
		item_end: item.end_date,
		cycle_day: item.billing_anchor_day ?? contractAnchor,
		suggested_end: suggested,
		period_start: partial.period_start,
		period_end: partial.period_end,
		plan_amount: row.expected,
		invoice_amount: row.actual,
		days: partial.days,
		line: options.line ?? null,
	};
}

/** Ítems del contrato al formato del generador (con su baja) y día de ciclo (`deviationCauseContext` del servicio de edición). */
export interface DeviationCauseContext {
	items: Map<string, { item: CycleItem & { is_recurring?: boolean }; churned: boolean }>;
	anchor: number;
}

/**
 * Causa por ítem del desvío (`by_item[].cause`) y de la factura (`cause`: la del primer ítem cuando todos los desvíos de la factura tienen
 * causa conocida; null = causa desconocida, se explica con motivo de texto libre). Hoy: `end_off_cycle` (caso S02762).
 */
export function withDeviationCauses(
	deviation: DeviationView,
	lines: Array<
		Pick<EditLineRow, 'id' | 'contract_item_id' | 'quantity' | 'unit_price' | 'discount_pct' | 'billing_period_start' | 'billing_period_end'>
	>,
	context: DeviationCauseContext
): {
	deviation: DeviationView & { by_item: Array<DeviationView['by_item'][number] & { cause: EndOffCycleCause | null }> };
	cause: EndOffCycleCause | null;
} {
	const byItem = deviation.by_item.map((row) => {
		const entry = context.items.get(row.contract_item_id);
		const own = lines.filter(
			(line) => line.contract_item_id === row.contract_item_id && (line.billing_period_start ?? '').slice(0, 10) === row.period_start
		);
		const line =
			own.length === 1
				? {
						id: own[0].id,
						quantity: own[0].quantity,
						unit_price: own[0].unit_price,
						discount_pct: own[0].discount_pct,
						billing_period_start: (own[0].billing_period_start ?? '').slice(0, 10),
						billing_period_end: own[0].billing_period_end ? own[0].billing_period_end.slice(0, 10) : null,
					}
				: null;

		return { ...row, cause: endOffCycleCause(row, entry?.item, context.anchor, { churned: entry?.churned, line }) };
	});
	const cause = byItem.length && byItem.every((row) => row.cause) ? byItem[0].cause : null;

	return { deviation: { ...deviation, by_item: byItem }, cause };
}

/**
 * Lo facturado contra el valor total (alerta `invoices_vs_total` del 360) y si lo explican las Por Emitir que no calzan con el contrato:
 * misma diferencia (tolerancia de 1 centavo por factura). El front muestra entonces un solo aviso (el de los desvíos).
 */
export function invoicesVsTotalSummary(
	invoiced: { invoices_count: number; invoiced_total: number; total_value: number },
	rows: Array<{ deviation: Pick<DeviationView, 'total_diff'> }>
) {
	const difference = round2(invoiced.invoiced_total - invoiced.total_value);
	const deviations = round2(rows.reduce((sum, row) => sum + row.deviation.total_diff, 0));

	return {
		difference,
		deviations_total: deviations,
		explained_by_deviations:
			invoiced.invoices_count > 0 &&
			Math.abs(difference) > 0.01 &&
			rows.length > 0 &&
			Math.abs(difference - deviations) <= 0.01 * Math.max(1, rows.length),
	};
}
