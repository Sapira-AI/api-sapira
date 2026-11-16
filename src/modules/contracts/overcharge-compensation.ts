import { round2 } from './billing-engine';

import type { PricedSubline } from './pricing-engine';

/**
 * Compensación de un cobro en exceso (baja con fecha efectiva anterior a facturas ya emitidas, Domi 16-11, caso S07212). **No es un
 * descuento**: lo facturado de más en los períodos emitidos cubre parte de los períodos siguientes, así que la línea Por Emitir del mismo
 * producto sale con **menos cantidad** (baja de cantidad: 61 del período − 42 ya facturados = 19, al mismo precio) o con **menor precio
 * unitario** (baja de precio), sin tocar `discount_pct` y sin líneas negativas. La factura que compensa más las ya emitidas suman el
 * total con el ajuste.
 *
 * La línea queda como cualquier otra (cantidad × unitario × (1 − descuento) = neto) y lleva una **marca** en su `pricing_breakdown`:
 * `{ kind: 'compensation', quantity: 0, amount: 0, label, compensation: { … } }`. La marca vale 0 (no suma ni resta en ningún lector
 * del desglose) y guarda la cantidad y el unitario del período, lo que se restó y los períodos emitidos que cubre: con eso el motor
 * la retira y la vuelve a aplicar ante cualquier cambio posterior, el devengo sabe que el mes no vale menos y Editar factura la protege.
 */

export const COMPENSATION_MODES = ['quantity', 'unit_price'] as const;
export type CompensationMode = (typeof COMPENSATION_MODES)[number];

/** Un período emitido cuyo cobro en exceso se compensa (monto positivo, moneda del ítem). */
export interface CompensationPeriod {
	invoice_id: string;
	invoice_number: string | null;
	period_start: string;
	period_end: string;
	amount: number;
}

export interface CompensationInfo {
	/** Ítem madre del producto compensado. */
	item_id: string;
	periods: CompensationPeriod[];
	/** `quantity`: la línea lleva menos cantidad. `unit_price`: la línea lleva menor precio unitario. */
	mode: CompensationMode;
	/** Cantidad y unitario del período antes de compensar (lo que la línea valdría sin el ajuste). */
	base_quantity: number;
	base_unit_price: number;
	/** Unidades que se restan de la cantidad (modo `quantity`; 0 en `unit_price`). */
	units: number;
	/** Neto que deja de facturar esta línea por la compensación (positivo, en la moneda del neto de la línea). */
	amount: number;
	/** Cuenta exacta de lo ya facturado ("14 x 3": 14 unidades de más en 3 períodos); null si no es una cuenta redonda. */
	count?: { quantity: number; months: number } | null;
}

/** La marca tal como se guarda en `pricing_breakdown`. */
export interface CompensationMarker extends PricedSubline {
	kind: 'compensation';
	compensation: CompensationInfo;
}

export const isCompensationMarker = (subline: Partial<PricedSubline> | null | undefined): boolean =>
	!!subline && subline.kind === 'compensation' && !!(subline as { compensation?: unknown }).compensation;

/** Marca de compensación de la línea; null si no compensa nada. */
export function compensationOf(breakdown: Array<Partial<PricedSubline>> | null | undefined): CompensationMarker | null {
	return ((breakdown ?? []).find((subline) => isCompensationMarker(subline)) as CompensationMarker | undefined) ?? null;
}

/** Desglose sin la marca de compensación. null si queda vacío. */
export const withoutCompensation = <T extends Partial<PricedSubline>>(breakdown: T[] | null | undefined): T[] | null => {
	const rest = (breakdown ?? []).filter((subline) => !isCompensationMarker(subline));

	return rest.length ? rest : null;
};

const round4 = (value: number) => Math.round((value + Number.EPSILON) * 1e4) / 1e4;
const round6 = (value: number) => Math.round((value + Number.EPSILON) * 1e6) / 1e6;

export interface CompensationBase {
	quantity: number;
	unit_price: number;
	/** Neto de la línea sin compensar. */
	subtotal: number;
}

export interface CompensationResult {
	quantity: number;
	unit_price: number;
	subtotal: number;
	/** Neto que la línea deja de facturar (≤ lo pedido: tope el neto de la línea; puede diferir en centavos por el redondeo). */
	amount: number;
	/** Unidades restadas (modo `quantity`). */
	units: number;
}

/**
 * Aplica una compensación a una línea: reduce la cantidad (4 decimales) o el unitario (6 decimales) en la proporción `amount / neto`, y
 * el neto nuevo **sale de la cantidad o el unitario ya redondeados** (la línea sigue siendo cantidad × unitario, igual en Sapira y en el
 * ERP). Con cuentas redondas (S07212: 26.334 sobre 61 × 627 → 19) es exacto; con prorrateo por días la diferencia es de centavos.
 */
export function applyCompensation(base: CompensationBase, amount: number, mode: CompensationMode): CompensationResult {
	const wanted = Math.max(0, Math.min(round2(amount), base.subtotal));

	if (!(base.subtotal > 0) || wanted < 0.005)
		return { quantity: base.quantity, unit_price: base.unit_price, subtotal: base.subtotal, amount: 0, units: 0 };
	const full = base.subtotal - wanted < 0.005;
	const ratio = full ? 0 : (base.subtotal - wanted) / base.subtotal;

	// Sin cantidad que bajar (línea en 0 unidades con monto), la compensación va por el unitario.
	if (mode === 'quantity' && base.quantity > 0) {
		const quantity = round4(base.quantity * ratio);
		const subtotal = round2((base.subtotal * quantity) / base.quantity);

		return {
			quantity,
			unit_price: base.unit_price,
			subtotal,
			amount: round2(base.subtotal - subtotal),
			units: round4(base.quantity - quantity),
		};
	}
	const unitPrice = round6(base.unit_price * ratio);
	const subtotal = base.unit_price > 0 ? round2((base.subtotal * unitPrice) / base.unit_price) : round2(base.subtotal - wanted);

	return { quantity: base.quantity, unit_price: unitPrice, subtotal, amount: round2(base.subtotal - subtotal), units: 0 };
}

const SHORT_MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const shortMonth = (iso: string) => SHORT_MONTHS[Number(iso.slice(5, 7)) - 1];
const plain = (value: number, decimals = 4) => {
	const rounded = Math.round((value + Number.EPSILON) * 10 ** decimals) / 10 ** decimals;

	return String(rounded).replace('.', ',');
};

/** "sep-nov 2026", "sep 2026" o "dic 2025-feb 2026": los meses de los períodos emitidos que se compensan. */
export function compensationRange(periods: Array<Pick<CompensationPeriod, 'period_start' | 'period_end'>>): string {
	const first = periods.map((period) => period.period_start).sort()[0];
	const last = periods
		.map((period) => period.period_end)
		.sort()
		.at(-1);

	if (!first || !last) return '';
	if (first.slice(0, 7) === last.slice(0, 7)) return `${shortMonth(first)} ${first.slice(0, 4)}`;
	if (first.slice(0, 4) === last.slice(0, 4)) return `${shortMonth(first)}-${shortMonth(last)} ${first.slice(0, 4)}`;

	return `${shortMonth(first)} ${first.slice(0, 4)}-${shortMonth(last)} ${last.slice(0, 4)}`;
}

/**
 * Texto de la compensación: "61 del período menos 42 ya facturados en sep-nov 2026 (14 x 3)" (cantidad; el paréntesis solo con cuenta
 * exacta) o "Precio del período 100 menos lo ya facturado de más en sep-nov 2026" (precio). Va en la marca, en la vista y, en ASCII,
 * al final de la glosa.
 */
export function compensationLabel(info: CompensationInfo): string {
	const range = compensationRange(info.periods);
	const where = range ? ` en ${range}` : '';

	if (info.mode === 'unit_price') return `Precio del período ${plain(info.base_unit_price, 6)} menos lo ya facturado de más${where}`;
	const exact = !!info.count && info.count.quantity > 0 && Math.abs(info.count.quantity * info.count.months - info.units) < 0.00015;
	const count = exact ? ` (${plain(info.count!.quantity)} x ${plain(info.count!.months)})` : '';

	return `${plain(info.base_quantity)} del período menos ${plain(info.units)} ya facturados${where}${count}`;
}

/** Marca de compensación para el `pricing_breakdown` de la línea (vale 0: la línea ya trae la cantidad o el unitario reducidos). */
export function compensationMarker(info: CompensationInfo): CompensationMarker {
	return { kind: 'compensation', quantity: 0, amount: 0, label: compensationLabel(info), compensation: info };
}

/**
 * Nota que cierra la glosa de la línea que compensa: el texto de la marca sin tildes (la glosa va en ASCII, como "Periodo"); null sin
 * compensación.
 */
export function compensationNote(breakdown: Array<Partial<PricedSubline>> | null | undefined): string | null {
	const label = compensationOf(breakdown)?.label?.trim();

	return label ? label.normalize('NFD').replace(/[̀-ͯ]/g, '') : null;
}
