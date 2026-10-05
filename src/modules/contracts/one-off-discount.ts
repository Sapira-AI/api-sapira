import { round2 } from './billing-engine';

import type { PricedSubline } from './pricing-engine';

/**
 * Descuento puntual en una Por Emitir (spec facturas §3.4, decisión de Domi 30-09): se ingresa por línea en % o monto (moneda de
 * contrato); la línea conserva cantidad × unitario y su `discount_pct` pasa a ser el porcentaje efectivo combinado (contractual + puntual),
 * sin líneas negativas. La parte puntual queda registrada como sublínea del `pricing_breakdown` existente:
 * `{ kind: 'discount', one_off: true, amount: -X, label: 'Descuento puntual: <motivo>' }` (+ `one_off_type`, `one_off_value` y
 * `base_discount_pct` para re-editar sin apilar). Su devengo lo mueve `nc_discount_revenue_adjustment` con el tratamiento guardado en
 * `invoices.nc_revenue_treatment` (el mismo mecanismo de las NC de descuento). Este módulo es la réplica en TS de esas reglas para la
 * vista previa (`revenue_effect`): mismas fórmulas que el SQL.
 */

export const ONE_OFF_REVENUE_TREATMENTS = ['service_period', 'impact_month', 'defer_forward'] as const;
export type OneOffRevenueTreatment = (typeof ONE_OFF_REVENUE_TREATMENTS)[number];
export const ONE_OFF_DISCOUNT_TYPES = ['pct', 'amount'] as const;
export type OneOffDiscountType = (typeof ONE_OFF_DISCOUNT_TYPES)[number];
export const ONE_OFF_LABEL_PREFIX = 'Descuento puntual';

export interface OneOffDiscountInput {
	type: OneOffDiscountType;
	value: number;
}

/** La sublínea del descuento puntual tal como se guarda en `pricing_breakdown`. */
export interface OneOffSubline extends PricedSubline {
	kind: 'discount';
	one_off: true;
	one_off_type?: OneOffDiscountType;
	one_off_value?: number;
	/** Descuento de la línea antes del puntual (para re-editar sin apilar). */
	base_discount_pct?: number;
}

export const isOneOffSubline = (subline: Partial<PricedSubline> | null | undefined): boolean =>
	!!subline && subline.kind === 'discount' && (subline as { one_off?: unknown }).one_off === true;

/** Desglose sin las sublíneas de descuento puntual (lo que describe el precio de la línea). null si queda vacío. */
export const withoutOneOff = (breakdown: PricedSubline[] | null | undefined): PricedSubline[] | null => {
	const rest = (breakdown ?? []).filter((subline) => !isOneOffSubline(subline));

	return rest.length ? rest : null;
};

/** Sublínea de descuento puntual de la línea (si hay varias, la primera; su monto total es la suma). */
export function oneOffOf(breakdown: PricedSubline[] | null | undefined): (OneOffSubline & { total: number }) | null {
	const sublines = (breakdown ?? []).filter(isOneOffSubline) as OneOffSubline[];

	if (!sublines.length) return null;

	return { ...sublines[0], total: round2(sublines.reduce((sum, subline) => sum + (Number(subline.amount) || 0), 0)) };
}

/** Monto (positivo) del descuento puntual sobre el subtotal previo: % del subtotal o monto fijo. */
export const oneOffAmount = (input: OneOffDiscountInput, subtotalBefore: number): number =>
	input.type === 'pct' ? round2((subtotalBefore * input.value) / 100) : round2(input.value);

export function oneOffSubline(amount: number, reason: string | null, input: OneOffDiscountInput, baseDiscountPct: number): OneOffSubline {
	return {
		kind: 'discount',
		one_off: true,
		quantity: 1,
		amount: -round2(amount),
		label: reason?.trim() ? `${ONE_OFF_LABEL_PREFIX}: ${reason.trim()}` : ONE_OFF_LABEL_PREFIX,
		one_off_type: input.type,
		one_off_value: input.value,
		base_discount_pct: baseDiscountPct,
	};
}

// ------------------------------------------------------------------ devengo (réplica de nc_discount_revenue_adjustment)

const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
const monthFromIndex = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;

/** Cuota k (1..n) de `amount` en n partes con redondeo telescópico: Σ cuotas = amount exacto (misma fórmula que el SQL). */
export const telescopicInstallment = (amount: number, k: number, n: number) => round2(round2((amount * k) / n) - round2((amount * (k - 1)) / n));

/** Ventana activa del ítem en meses, como `revenue_schedule_rebuild_contract_ccy` (`v_item_start_month`, `v_item_active_end_month`). */
export function itemActiveWindow(item: { start_date: string | null; end_date: string | null; term_months: number | null }): {
	start_month: string | null;
	active_end_month: string | null;
} {
	const start = item.start_date ? monthOf(item.start_date) : null;
	const endMonth = item.end_date ? monthOf(item.end_date) : null;

	if (!start) return { start_month: null, active_end_month: endMonth };
	if ((item.term_months ?? 0) > 0) {
		const byTerm = monthFromIndex(monthIndex(start) + Number(item.term_months) - 1);

		return { start_month: start, active_end_month: endMonth === null ? null : endMonth < byTerm ? endMonth : byTerm };
	}

	return { start_month: start, active_end_month: endMonth };
}

export interface OneOffLine {
	contract_item_id: string;
	/** Monto del descuento en moneda de contrato, NEGATIVO (como la sublínea). */
	amount: number;
	billing_period_start: string | null;
	billing_period_end: string | null;
}

export interface RevenueEffect {
	treatment: OneOffRevenueTreatment | null;
	total: number;
	by_month: Array<{ month: string; amount: number }>;
}

/**
 * Dónde cae el descuento en el devengo, por mes (negativo = reduce lo reconocido), con las reglas de `nc_discount_revenue_adjustment`:
 * - `impact_month`: todo en el mes de la fecha de emisión de la factura.
 * - `defer_forward`: partes iguales desde el mes de emisión (o el inicio del ítem, si es posterior) hasta el fin activo del ítem, con
 *   redondeo telescópico; si ese inicio queda después del fin activo (o el ítem no tiene fin), degenera a `impact_month`. Nunca antes del mes de emisión.
 * - `service_period`: partes iguales en los meses calendario del período de servicio de la línea (`billing_period_start` → `_end`); sin
 *   período, degenera a `impact_month`.
 */
export function oneOffRevenueEffect(
	lines: OneOffLine[],
	treatment: OneOffRevenueTreatment | null,
	issueDate: string | null,
	items: Map<string, { start_date: string | null; end_date: string | null; term_months: number | null }>
): RevenueEffect {
	const byMonth = new Map<string, number>();
	const add = (month: string, amount: number) => byMonth.set(month, round2((byMonth.get(month) ?? 0) + amount));

	if (!treatment) return { treatment: null, total: 0, by_month: [] };
	for (const line of lines) {
		if (!line.amount) continue;
		const refMonth = issueDate ? monthOf(issueDate) : null;
		const impact = () => {
			if (refMonth) add(refMonth, line.amount);
		};

		if (treatment === 'service_period') {
			const start = line.billing_period_start;
			const end = line.billing_period_end;

			if (!start || !end || end < start) {
				impact();
				continue;
			}
			const first = monthIndex(monthOf(start));
			const n = monthIndex(monthOf(end)) - first + 1;

			for (let k = 1; k <= n; k += 1) add(monthFromIndex(first + k - 1), telescopicInstallment(line.amount, k, n));
			continue;
		}
		if (treatment === 'impact_month') {
			impact();
			continue;
		}
		const window = itemActiveWindow(items.get(line.contract_item_id) ?? { start_date: null, end_date: null, term_months: null });

		if (!refMonth) continue;
		const deferStart = window.start_month && window.start_month > refMonth ? window.start_month : refMonth;

		if (!window.active_end_month || deferStart > window.active_end_month) {
			impact();
			continue;
		}
		const first = monthIndex(deferStart);
		const n = monthIndex(window.active_end_month) - first + 1;

		for (let k = 1; k <= n; k += 1) add(monthFromIndex(first + k - 1), telescopicInstallment(line.amount, k, n));
	}
	const byMonthList = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, amount]) => ({ month, amount }));

	return { treatment, total: round2(byMonthList.reduce((sum, row) => sum + row.amount, 0)), by_month: byMonthList };
}
