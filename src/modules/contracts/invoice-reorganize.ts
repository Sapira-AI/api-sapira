import type { FieldError } from '@/core/utils/validation-errors';

import { addDays, daysInMonth, findFixedRate, type FxPeriodRate, normalizeTaxRate, periodDays, round2 } from './billing-engine';
import { headerFromLines as headerFromLineAmounts } from './consumption';
import { isCreditNote } from './contract-360';
import {
	commonBlockers,
	type ContractInvoiceContext,
	type ContractInvoiceRow,
	erpDraftBlocker,
	type InvoiceBlocker,
	invoiceDueDate,
	type InvoiceWarning,
	partialBillingBlocker,
	round6,
	sameDayOfMonth,
} from './contract-invoices';
import { isPerTierBreakdown } from './invoice-description';
import {
	amountsOf,
	type DeviationType,
	discountEmbedded,
	type EditItem,
	type EditLineRow,
	invoiceFx,
	type IssuedPeriod,
	isVisibleLine,
	type LineState,
	MANUAL_EDIT_KEPT,
	MANUAL_QUANTITY_SOURCE,
	type RenderInput,
	renderLine,
	revalueStates,
	stateOf,
} from './invoice-edit';
import { multicurrencyHeader, type PairRateContext } from './multicurrency';
import { isOneOffSubline, oneOffOf } from './one-off-discount';
import { isMetered, type PricedSubline } from './pricing-engine';

/**
 * Facturas en el Contrato 360, etapa 5 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.5): **Reorganizar el cronograma** con
 * operaciones (no con el estado completo, como hacía `invoice_reschedule_items`): juntar Por Emitir, mover una línea a otra factura o a
 * una nueva, dividir una línea (por fecha, por monto o en cuotas con montos distintos), dividir una factura por fecha, y los atajos por
 * ítem del front viejo (mensualizar, juntar lo pendiente, repartir parejo) más el cuadre de redondeo encabezado ↔ líneas. Lógica pura: el
 * servicio (`contract-invoice-reorganize.service.ts`) carga, bloquea y escribe.
 *
 * Reglas (cierran U1/U2 y el clon de encabezados): **cambio mínimo** (solo cambian las líneas nombradas; cantidad, unitario, descuento y
 * período se conservan salvo que la operación divida montos: entonces la cantidad se conserva y el unitario = subtotal ÷ cantidad); una
 * factura nueva nace de las **reglas del generador** (receptor, documento, IVA, moneda, vencimiento por condición de pago y FX = política
 * del contrato para su período; nunca clonada de otra factura; `split_reason = 'reorganize'`); una factura que queda sin líneas pasa a
 * `Cancelada` (nunca DELETE); las emitidas son ancla (`overlaps_issued`); filas por tramo de un ítem y período se mueven y dividen
 * juntas; las líneas manuales (`quantity_source = 'manual'`) o con descuento puntual se pueden mover pero no se re-montan
 * (`manual_edit_kept`); las glosas protegidas se conservan y las demás de líneas nuevas o divididas se re-renderizan con la plantilla.
 * La continuidad por ítem se calcula antes y después **leyendo líneas** (matemática de `check_contract_item_continuity`): si el total por
 * ítem cambia hace falta motivo (`deviation_reason_required`); una redistribución pura no lo pide.
 */

// ------------------------------------------------------------------ constantes

export const REORGANIZE_OPS = [
	'merge',
	'move_line',
	'split_line',
	'split_invoice',
	'item_monthly',
	'item_unify_pending',
	'item_even_split',
	'round_fix',
] as const;
export type ReorganizeOp = (typeof REORGANIZE_OPS)[number];
export const SPLIT_LINE_BY = ['date', 'amount', 'installments'] as const;
export type SplitLineBy = (typeof SPLIT_LINE_BY)[number];
/** `invoices.split_reason` de las facturas que nacen al reorganizar (texto libre existente). */
export const REORGANIZE_SPLIT_REASON = 'reorganize';
/** `invoice_items.fx_rate_source` de las líneas que cambian de tasa al reorganizar. */
export const REORGANIZE_FX_RATE_SOURCE = 'reorganize';
/** Cuotas máximas de una división. */
export const REORGANIZE_MAX_PARTS = 60;
/** Diferencia del cuadre de redondeo sobre la que se avisa (1 unidad de moneda). */
export const ROUND_FIX_WARN_ABOVE = 1;

const PENDING_STATUS = 'Por Emitir';
const CANCELLED_STATUS = 'Cancelada';
const ISSUED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'];

export const REORGANIZE_MESSAGES = {
	mixed_currency: 'No se pueden juntar facturas con distinta moneda, receptor o tipo de documento',
	overlaps_issued: 'El período de la línea se cruza con un período ya emitido del mismo ítem',
	target_issued: 'Las facturas emitidas son ancla del cronograma: no reciben líneas',
	metered_line: 'Una línea por consumo no se divide ni se reparte: su monto sale del consumo del período',
	per_tier_group: 'El ítem se presenta con una fila por tramo: pásalo a una sola fila (Editar borrador › presentación) antes de juntarlo',
	deviation_reason_required: 'La reorganización cambia el total facturado de un ítem: indica el tipo y el motivo del desvío',
} as const;

// ------------------------------------------------------------------ entrada

export interface InstallmentInput {
	amount: number;
	issue_date?: string | null;
}

/** Una operación (forma plana: cada `op` usa sus campos; el DTO valida cuáles son obligatorios). */
export interface ReorganizeOperationInput {
	op: ReorganizeOp;
	/** merge */
	invoice_ids?: string[] | null;
	/** move_line · split_line */
	line_id?: string | null;
	/** move_line: factura Por Emitir destino */
	to_invoice_id?: string | null;
	/** move_line: factura nueva (nace del generador) */
	new_invoice?: { issue_date: string } | null;
	/** split_line */
	by?: SplitLineBy | null;
	/** split_line by date: último día de la primera parte */
	at?: string | null;
	/** split_line by amount: monto de la primera parte (moneda de contrato) */
	amount?: number | null;
	/** split_line by installments (cuotas parejas) · item_even_split (cuotas mensuales nuevas) */
	count?: number | null;
	/** split_line by installments: montos distintos por cuota (y fecha de emisión opcional) */
	installments?: InstallmentInput[] | null;
	/** split_invoice · round_fix */
	invoice_id?: string | null;
	/** split_invoice: último día que queda en la factura original */
	cut_date?: string | null;
	/** item_* */
	contract_item_id?: string | null;
	/** split_line by date · split_invoice · item_unify_pending: fecha de emisión de la factura que recibe la parte posterior / lo unificado */
	issue_date?: string | null;
}

export interface ReorganizeInput {
	operations: ReorganizeOperationInput[];
	/** Nota libre de la reorganización (va al evento). */
	reason?: string | null;
	/** Motivo tipado si el total por ítem cambia (fila en `invoice_adjustments`). */
	deviation?: { type: DeviationType; reason: string } | null;
}

/** Reglas del generador para una factura nueva (lo que haría la activación): nunca se copia de otra factura. */
export interface NewInvoiceRules {
	client_entity_id: string | null;
	legal_name: string | null;
	document_type: string;
	export_type: 0 | 1;
	/** IVA en porcentaje, según el tipo de documento (exportación 0, Colombia 0, si no la compañía normalizada). */
	tax_rate: number;
	contract_currency: string;
	invoice_currency: string;
	fx_invoice_policy: string | null;
	/** Tasas fijas de facturación del contrato (`contract_fx_period_rates`, purpose = invoice). */
	fixed_invoice_rates: FxPeriodRate[];
}

/** Línea de otra factura vigente del contrato (emitida, NC…) para la continuidad por ítem. */
export interface OtherContractLine {
	invoice_id: string;
	contract_item_id: string;
	billing_period_start: string | null;
	billing_period_end: string | null;
	subtotal: number;
	credit_note: boolean;
}

export interface ReorganizeContext {
	context: ContractInvoiceContext;
	/** Por Emitir activas del contrato (orden de emisión). */
	invoices: ContractInvoiceRow[];
	/** Líneas por factura Por Emitir. */
	lines: Map<string, EditLineRow[]>;
	/** Facturas del contrato nombradas en las operaciones que NO están Por Emitir activas (emitidas, canceladas…). */
	foreign_invoices: Map<string, ContractInvoiceRow>;
	/** Líneas nombradas de facturas del contrato que NO están Por Emitir activas → estado de su factura. */
	foreign_lines: Map<string, { invoice_id: string; status: string | null }>;
	items: Map<string, EditItem>;
	issued_periods: IssuedPeriod[];
	/** Líneas de las demás facturas vigentes del contrato (no Por Emitir), para la continuidad. */
	other_lines: OtherContractLine[];
	/** Plan del motor: `item|period_start` → subtotal esperado (moneda de contrato). */
	expected: Map<string, number>;
	known_items: Set<string>;
	product_names: Map<string, string | null>;
	rules: NewInvoiceRules;
	render: { template: RenderInput['template']; contract_number: string | null; client_name: string | null; max_chars: number | null };
	/** Multimoneda: contexto por par del contrato (`requires_multicurrency_billing`); ausente/null en los demás. */
	multicurrency?: PairRateContext | null;
}

// ------------------------------------------------------------------ salida

export type ReorganizeLineAction = 'moved' | 'split' | 'created' | 'updated' | 'unchanged' | 'removed';
export type ReorganizeInvoiceAction = 'updated' | 'created' | 'cancelled' | 'unchanged';

export interface ReorganizeHeader {
	status: string | null;
	issue_date: string | null;
	due_date: string | null;
	client_entity_id: string | null;
	legal_name: string | null;
	document_type: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
	tax_rate: number | null;
	period_start: string | null;
	period_end: string | null;
	lines_count: number;
	amount_contract_currency: number;
	tax_contract_currency: number;
	vat: number | null;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
}

export interface ReorganizeLineView {
	id: string | null;
	/** Id de la línea o `new-line:N` (líneas que nacen en esta reorganización). */
	key: string;
	action: ReorganizeLineAction;
	/** Factura de origen (moved) o línea de origen (split). */
	from_invoice_id: string | null;
	origin_line_id: string | null;
	/** Factura donde queda (id o `new:N`); null si se quitó. */
	to_invoice_key: string | null;
	per_tier_group: string | null;
	before: LineState | null;
	after: LineState | null;
}

export interface ReorganizeInvoiceView {
	id: string | null;
	/** Id de la factura o `new:N` (facturas que nacen del generador). */
	key: string;
	invoice_number: string | null;
	action: ReorganizeInvoiceAction;
	split_from_invoice_id: string | null;
	before: ReorganizeHeader | null;
	after: ReorganizeHeader | null;
	lines: ReorganizeLineView[];
}

export interface ReorganizeOperationResult {
	index: number;
	op: ReorganizeOp;
	ok: boolean;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
}

export interface ContinuityGap {
	type: 'period_gap' | 'tail_gap';
	from: string;
	to: string;
}
export interface ContinuityOverlap {
	type: 'overlap' | 'exceeds_item_end';
	start: string;
	previous_end: string;
}
export interface ContinuitySide {
	actual_total: number;
	lines: number;
	gaps: ContinuityGap[];
	overlaps: ContinuityOverlap[];
}
export interface ContinuityPeriod {
	/** `YYYY-MM` del inicio del período. */
	month: string;
	expected: number | null;
	before: number;
	after: number;
}
export interface ItemContinuity {
	contract_item_id: string;
	product_name: string | null;
	/** Lo que el plan (motor + consumos) espera facturar en total para el ítem; null si el motor no lo tarifa. */
	expected_total: number | null;
	before: ContinuitySide;
	after: ContinuitySide;
	/** after − before (moneda de contrato). */
	diff: number;
	tolerance: number;
	/** Ya se apartaba del plan antes de reorganizar. */
	inherited: boolean;
	/** La reorganización cambia el total del ítem (pide motivo). */
	changed: boolean;
	by_period: ContinuityPeriod[];
}
export interface ReorganizeContinuity {
	by_item: ItemContinuity[];
	changed: boolean;
	total_diff: number;
	inherited: boolean;
	reason_required: boolean;
	currency: string | null;
}

export interface NewInvoiceWrite {
	key: string;
	issue_date: string;
	due_date: string;
	split_from_invoice_id: string | null;
	client_entity_id: string | null;
	document_type: string;
	export_type: 0 | 1;
	tax_rate: number;
	contract_currency: string;
	invoice_currency: string;
	fx: number | null;
	header: ReorganizeHeader;
}

export interface ReorganizePlan {
	errors: FieldError[];
	operations: ReorganizeOperationResult[];
	invoices: ReorganizeInvoiceView[];
	continuity: ReorganizeContinuity;
	warnings: InvoiceWarning[];
	blockers: InvoiceBlocker[];
	can_apply: boolean;
	write: {
		creates: NewInvoiceWrite[];
		header_updates: Array<{ id: string; header: ReorganizeHeader }>;
		cancelled: Array<{ id: string; header: ReorganizeHeader }>;
		line_updates: Array<{
			id: string;
			invoice_key: string;
			state: LineState;
			moved: boolean;
			fx_changed: boolean;
			/** Línea movida: factura de origen, ítem y período de origen (para llevar sus consumos a la factura nueva). */
			from_invoice_id?: string | null;
			from_period_start?: string | null;
		}>;
		line_creates: Array<{ key: string; invoice_key: string; state: LineState }>;
		line_removes: string[];
		/** `invoices.nc_revenue_treatment` que cambia: el descuento puntual sigue a su línea (null = la factura ya no tiene puntual). */
		treatment_updates: Array<{ invoice_key: string; nc_revenue_treatment: string | null }>;
		/** Parte (0..1] del descuento puntual de la factura de origen que pasa a otra: mueve/duplica su fila de `invoice_adjustments`. */
		one_off_moves: Array<{ from_invoice_id: string; to_invoice_key: string; share: number }>;
	};
	/** Primer mes cuyo devengo se reconstruye (solo si cambió el período de alguna línea). */
	rsm_from_month: string | null;
	/** Con motivo y cambio de total por ítem: diferencia neta por factura (moneda de contrato) para `invoice_adjustments`. */
	adjustments: Array<{ invoice_key: string; amount_diff: number }>;
	summary: {
		invoices_created: number;
		invoices_cancelled: number;
		lines_moved: number;
		lines_split: number;
		lines_created: number;
		lines_removed: number;
		lines_updated: number;
	};
}

// ------------------------------------------------------------------ utilidades puras (exportadas para pruebas)

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
export const monthDiff = (from: string, to: string) => monthIndex(to) - monthIndex(from);
const dayOf = (date: string) => Number(date.slice(8, 10));
const upper = (value: string | null | undefined) => (value ?? '').trim().toUpperCase();

/** Reparto telescópico: parte i = round2(T × acumulado_i / W) − round2(T × acumulado_{i−1} / W); suma exacta, residuo en la última. */
export function telescopic(total: number, weights: number[]): number[] {
	const weight = sum(weights);
	const parts: number[] = [];
	let cumulative = 0;
	let previous = 0;

	weights.forEach((value, index) => {
		cumulative += value;
		const point = index === weights.length - 1 ? round2(total) : weight > 0 ? round2((total * cumulative) / weight) : 0;

		parts.push(round2(point - previous));
		previous = point;
	});

	return parts;
}

/** Montos de las filas de una unidad llevados a un total nuevo, proporcionales; el residuo va a la fila mayor. */
export function scaleRows(rowTotals: number[], target: number): number[] {
	if (rowTotals.length === 1) return [round2(target)];
	const total = sum(rowTotals);
	const amounts = rowTotals.map((row, index) => (total === 0 ? (index === 0 ? round2(target) : 0) : round2((row * target) / total)));
	const diff = round2(target - sum(amounts));

	if (diff !== 0) {
		const largest = rowTotals.reduce((best, row, index) => (Math.abs(row) > Math.abs(rowTotals[best]) ? index : best), 0);

		amounts[largest] = round2(amounts[largest] + diff);
	}

	return amounts;
}

/**
 * Reparte las filas de una unidad (una línea o un grupo por tramo) en partes con totales dados (Σ partes = Σ filas): cada parte suma
 * exacto y cada fila conserva su total (la última parte se lleva el resto de cada fila). Devuelve `[parte][fila]`.
 */
export function allocate(rowTotals: number[], partTotals: number[]): number[][] {
	const used = rowTotals.map(() => 0);

	return partTotals.map((part, index) => {
		const amounts = index === partTotals.length - 1 ? rowTotals.map((row, r) => round2(row - used[r])) : scaleRows(rowTotals, part);

		amounts.forEach((amount, r) => (used[r] = round2(used[r] + amount)));

		return amounts;
	});
}

/** Tramos por mes calendario de un período (ambos extremos incluidos). */
export function monthPieces(start: string, end: string): Array<{ start: string; end: string; days: number }> {
	const pieces: Array<{ start: string; end: string; days: number }> = [];
	let cursor = start;

	while (cursor <= end) {
		const [year, month] = cursor.split('-').map(Number);
		const monthEnd = `${cursor.slice(0, 8)}${String(daysInMonth(year, month)).padStart(2, '0')}`;
		const pieceEnd = monthEnd < end ? monthEnd : end;

		pieces.push({ start: cursor, end: pieceEnd, days: periodDays(cursor, pieceEnd) });
		cursor = addDays(pieceEnd, 1);
	}

	return pieces;
}

/**
 * Desglose de precio llevado a otro subtotal (montos × factor; el residuo va a la última sublínea de cargo). El descuento puntual en MONTO
 * escala también su valor pedido (`one_off_value`), así re-editar la parte no la devuelve al monto completo; el puntual en % se conserva.
 */
export function scaleBreakdown(breakdown: PricedSubline[] | null, from: number, to: number): PricedSubline[] | null {
	if (!Array.isArray(breakdown) || !breakdown.length || from === 0 || round2(from) === round2(to)) return breakdown;
	const factor = to / from;
	const scaled = breakdown.map((subline) => {
		const next = { ...subline, amount: round2(subline.amount * factor) };
		const oneOff = next as PricedSubline & { one_off_type?: string; one_off_value?: number };

		if (isOneOffSubline(subline) && oneOff.one_off_type !== 'pct' && typeof oneOff.one_off_value === 'number')
			oneOff.one_off_value = round2(oneOff.one_off_value * factor);

		return next;
	});

	if (Math.abs(sum(breakdown.map((subline) => subline.amount)) - from) < 0.02) {
		const residue = round2(to - sum(scaled.map((subline) => subline.amount)));

		if (residue !== 0) {
			const chargeKinds = new Set(['tier', 'package', 'seat', 'unit', 'flat']);
			let target = scaled.length - 1;

			for (let index = scaled.length - 1; index >= 0; index -= 1) {
				if (chargeKinds.has(scaled[index].kind)) {
					target = index;
					break;
				}
			}
			scaled[target] = { ...scaled[target], amount: round2(scaled[target].amount + residue) };
		}
	}

	return scaled;
}

/**
 * Línea con otro subtotal (y opcionalmente otro período): la cantidad se conserva y el unitario = subtotal ÷ (cantidad × (1 − descuento))
 * a 6 decimales (en líneas con modelo de precio el descuento ya está dentro del unitario: subtotal ÷ cantidad). IVA y moneda de factura
 * los completa `finalize` con la tasa y el FX de la factura donde queda.
 */
export function reamount(state: LineState, subtotal: number, period?: { start: string; end: string } | null): LineState {
	const factor = discountEmbedded(state) ? 1 : 1 - (state.discount_pct || 0) / 100;
	const unit = state.quantity > 0 && factor > 0 ? round6(subtotal / (state.quantity * factor)) : state.unit_price_contract_currency;

	return {
		...state,
		unit_price_contract_currency: unit,
		subtotal_contract_currency: round2(subtotal),
		billing_period_start: period?.start ?? state.billing_period_start,
		billing_period_end: period?.end ?? state.billing_period_end,
		pricing_breakdown: scaleBreakdown(state.pricing_breakdown, state.subtotal_contract_currency, subtotal),
	};
}

/** Bloqueos de operabilidad de una Por Emitir (comunes + borrador en el ERP + fecha de emisión en período cerrado). */
export function invoiceOperability(invoice: ContractInvoiceRow): InvoiceBlocker[] {
	const blockers = commonBlockers(invoice);
	const draft = erpDraftBlocker(invoice);

	if (draft) blockers.push(draft);
	const partial = partialBillingBlocker(invoice);

	if (partial) blockers.push(partial);

	return blockers;
}

/**
 * Continuidad de un ítem leyendo LÍNEAS (port de `check_contract_item_continuity`, sin el prorrateo por encabezado que causaba U2):
 * total facturado, huecos y solapes contra la vigencia del ítem. Líneas concurrentes (mismo período, p. ej. cuotas) no son solape.
 */
export function continuitySide(
	lines: Array<{ billing_period_start: string | null; billing_period_end: string | null; subtotal: number; credit_note?: boolean }>,
	item: Pick<EditItem, 'start_date' | 'end_date'> | null
): ContinuitySide {
	const gaps: ContinuityGap[] = [];
	const overlaps: ContinuityOverlap[] = [];
	const periods = lines
		.filter((line) => !line.credit_note && line.billing_period_start && line.billing_period_end)
		.map((line) => ({ start: line.billing_period_start!, end: line.billing_period_end! }))
		.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
	let prevEnd: string | null = item?.start_date ? addDays(item.start_date, -1) : null;
	let prev: { start: string; end: string } | null = null;

	for (const period of periods) {
		if (prev && prev.start === period.start && prev.end === period.end) continue;
		if (prevEnd && period.start > addDays(prevEnd, 1))
			gaps.push({ type: 'period_gap', from: addDays(prevEnd, 1), to: addDays(period.start, -1) });
		if (prevEnd && prev && period.start <= prevEnd) overlaps.push({ type: 'overlap', start: period.start, previous_end: prevEnd });
		if (!prevEnd || period.end > prevEnd) prevEnd = period.end;
		prev = period;
	}
	if (item?.end_date && prevEnd && prev) {
		if (prevEnd < item.end_date) gaps.push({ type: 'tail_gap', from: addDays(prevEnd, 1), to: item.end_date });
		if (prevEnd > item.end_date) overlaps.push({ type: 'exceeds_item_end', start: item.end_date, previous_end: prevEnd });
	}

	return { actual_total: round2(sum(lines.map((line) => line.subtotal))), lines: lines.length, gaps, overlaps };
}

// ------------------------------------------------------------------ estado de trabajo

interface WInvoice {
	key: string;
	id: string | null;
	row: ContractInvoiceRow | null;
	invoice_number: string | null;
	issue_date: string | null;
	due_date: string | null;
	split_from: string | null;
	invoice_currency: string | null;
	contract_currency: string | null;
	client_entity_id: string | null;
	legal_name: string | null;
	document_type: string | null;
	export_type: 0 | 1;
	tax_rate: number;
	fx: number | null;
	/** `nc_revenue_treatment` (devengo del descuento puntual) de la factura; null en las nuevas. */
	treatment: string | null;
	created_by: number | null;
	/** El encabezado se recalcula aunque no cambie una línea (cuadre de redondeo). */
	forced: boolean;
	blockers: InvoiceBlocker[];
	order: number;
}

interface WLine {
	key: string;
	id: string | null;
	origin_id: string | null;
	invoice_key: string;
	original_invoice_key: string | null;
	state: LineState;
	before: LineState | null;
	group: string | null;
	amount_changed: boolean;
	period_changed: boolean;
	removed: boolean;
	split: boolean;
	changed_by: number | null;
	order: number;
}

interface Unit {
	rows: WLine[];
	invoice: WInvoice;
	start: string | null;
	end: string | null;
	total: number;
}

const headerOfRow = (row: ContractInvoiceRow, lines: LineState[]): ReorganizeHeader => ({
	status: row.status,
	issue_date: row.issue_date,
	due_date: row.due_date,
	client_entity_id: row.client_entity_id,
	legal_name: row.legal_name,
	document_type: row.document_type,
	contract_currency: row.contract_currency,
	invoice_currency: row.invoice_currency,
	fx_contract_to_invoice: row.fx_contract_to_invoice,
	tax_rate: row.tax_rate,
	period_start:
		lines
			.map((line) => line.billing_period_start)
			.filter((value): value is string => !!value)
			.sort()[0] ?? null,
	period_end:
		lines
			.map((line) => line.billing_period_end)
			.filter((value): value is string => !!value)
			.sort()
			.reverse()[0] ?? null,
	lines_count: lines.length,
	amount_contract_currency: row.amount_contract_currency,
	tax_contract_currency: round2(sum(lines.map((line) => line.tax_contract_currency))),
	vat: row.vat,
	amount_invoice_currency: row.amount_invoice_currency,
	total_invoice_currency: row.total_invoice_currency,
});

/**
 * Encabezado = Σ líneas con la convención única (`headerFromLines` de `consumption.ts`): misma moneda → iguales; spot → NULL en moneda de
 * factura y `vat` en moneda de contrato; fija → Σ de los montos redondeados de las líneas valorizadas.
 */
function headerFromLines(invoice: WInvoice, lines: LineState[], status: string | null, pairs: PairRateContext | null = null): ReorganizeHeader {
	let tax = round2(sum(lines.map((line) => line.tax_contract_currency)));
	let amounts = headerFromLineAmounts(lines, {
		sameCurrency: upper(invoice.invoice_currency || invoice.contract_currency) === upper(invoice.contract_currency),
		fx: invoice.fx,
		taxRate: invoice.tax_rate,
	});

	// Multimoneda (spec-multimoneda §4): encabezado = Σ líneas por par (moneda de contrato con la tasa pactada ítem → contrato).
	if (pairs && lines.length) {
		const of = (valued: boolean) =>
			multicurrencyHeader(
				lines.map((line) => ({
					currency: line.currency ?? null,
					subtotal: line.subtotal_contract_currency,
					tax: line.tax_contract_currency,
					subtotal_invoice: valued ? line.subtotal_invoice_currency : null,
					tax_invoice: valued ? line.tax_invoice_currency : null,
					fx: line.fx ?? null,
					period_start: line.billing_period_start,
				})),
				{
					contract_currency: pairs.contract_currency,
					invoice_currency: invoice.invoice_currency ?? pairs.contract_currency,
					item_rates: pairs.item_rates,
					fallback_date: invoice.issue_date ?? '',
				}
			);
		const header = of(true);

		amounts = header;
		tax = of(false).vat;
	}

	return {
		status,
		issue_date: invoice.issue_date,
		due_date: invoice.due_date,
		client_entity_id: invoice.client_entity_id,
		legal_name: invoice.legal_name,
		document_type: invoice.document_type,
		contract_currency: invoice.contract_currency,
		invoice_currency: invoice.invoice_currency,
		fx_contract_to_invoice: invoice.fx,
		tax_rate: invoice.tax_rate,
		period_start:
			lines
				.map((line) => line.billing_period_start)
				.filter((value): value is string => !!value)
				.sort()[0] ?? null,
		period_end:
			lines
				.map((line) => line.billing_period_end)
				.filter((value): value is string => !!value)
				.sort()
				.reverse()[0] ?? null,
		lines_count: lines.length,
		amount_contract_currency: amounts.amount_contract_currency,
		tax_contract_currency: tax,
		vat: amounts.vat,
		amount_invoice_currency: amounts.amount_invoice_currency,
		total_invoice_currency: amounts.total_invoice_currency,
	};
}

const sameState = (a: LineState | null, b: LineState | null) => JSON.stringify(a) === JSON.stringify(b);
const headerDiffers = (a: ReorganizeHeader, b: ReorganizeHeader) =>
	a.amount_contract_currency !== b.amount_contract_currency ||
	(a.vat ?? null) !== (b.vat ?? null) ||
	(a.amount_invoice_currency ?? null) !== (b.amount_invoice_currency ?? null) ||
	(a.total_invoice_currency ?? null) !== (b.total_invoice_currency ?? null);

// ------------------------------------------------------------------ plan

/**
 * Plan de la reorganización (preview y aplicar comparten el cálculo). Las operaciones se aplican en orden sobre un estado de trabajo; una
 * operación con bloqueos no cambia nada (queda en `operations[i].blockers`). Errores de forma → `errors` (400).
 */
export function planReorganize(ctx: ReorganizeContext, input: ReorganizeInput): ReorganizePlan {
	const errors: FieldError[] = [];
	const results: ReorganizeOperationResult[] = [];
	const invoices = new Map<string, WInvoice>();
	const lines = new Map<string, WLine>();
	const originalLines = new Map<string, LineState[]>();
	const roundFixTargets = new Map<string, string>();
	let order = 0;
	let invoiceSeq = 0;
	let lineSeq = 0;
	let groupSeq = 0;
	let invoiceOrder = 0;

	for (const row of ctx.invoices) {
		invoices.set(row.id, {
			key: row.id,
			id: row.id,
			row,
			invoice_number: row.invoice_number,
			issue_date: row.issue_date,
			due_date: row.due_date,
			split_from: null,
			invoice_currency: row.invoice_currency,
			contract_currency: row.contract_currency,
			client_entity_id: row.client_entity_id,
			legal_name: row.legal_name,
			document_type: row.document_type,
			export_type: row.document_type === 'FACTURA_EXPORTACION' ? 1 : 0,
			tax_rate: normalizeTaxRate(row.tax_rate) ?? 0,
			fx: invoiceFx(row),
			treatment: row.nc_revenue_treatment ?? null,
			created_by: null,
			forced: false,
			blockers: invoiceOperability(row),
			order: invoiceOrder++,
		});
		const rows = ctx.lines.get(row.id) ?? [];

		originalLines.set(
			row.id,
			rows.map((line) => stateOf(line))
		);
		for (const line of rows) {
			const state = stateOf(line);

			lines.set(line.id, {
				key: line.id,
				id: line.id,
				origin_id: null,
				invoice_key: row.id,
				original_invoice_key: row.id,
				state,
				before: state,
				group: isPerTierBreakdown(line.pricing_breakdown)
					? `${row.id}|${line.contract_item_id ?? ''}|${line.billing_period_start ?? ''}`
					: null,
				amount_changed: false,
				period_changed: false,
				removed: false,
				split: false,
				changed_by: null,
				order: order++,
			});
		}
	}

	const invoiceLabel = (invoice: WInvoice | ContractInvoiceRow) =>
		invoice.invoice_number ?? (invoice.issue_date ? `del ${invoice.issue_date}` : 'key' in invoice ? invoice.key : invoice.id);
	const live = (invoiceKey: string) =>
		[...lines.values()].filter((line) => !line.removed && line.invoice_key === invoiceKey).sort((a, b) => a.order - b.order);
	const unitOf = (line: WLine): WLine[] =>
		line.group ? [...lines.values()].filter((other) => !other.removed && other.group === line.group).sort((a, b) => a.order - b.order) : [line];
	const lockOf = (line: WLine): 'manual' | 'one_off' | null =>
		line.state.quantity_source === MANUAL_QUANTITY_SOURCE ? 'manual' : oneOffOf(line.state.pricing_breakdown) ? 'one_off' : null;
	const meteredItem = (itemId: string | null) => !!itemId && isMetered(ctx.items.get(itemId)?.price);
	const itemName = (itemId: string | null) => (itemId ? (ctx.items.get(itemId)?.product_name ?? ctx.product_names.get(itemId)) : null) ?? 'Ítem';
	const splitFromOf = (invoice: WInvoice) => invoice.id ?? invoice.split_from;

	/** Diferencias que impiden juntar (moneda, receptor, tipo de documento). */
	const incompatibility = (a: WInvoice, b: WInvoice): string[] => {
		const diffs: string[] = [];

		if (upper(a.invoice_currency) !== upper(b.invoice_currency))
			diffs.push(`moneda (${a.invoice_currency ?? '—'} / ${b.invoice_currency ?? '—'})`);
		if ((a.client_entity_id ?? '') !== (b.client_entity_id ?? '')) diffs.push(`receptor (${a.legal_name ?? '—'} / ${b.legal_name ?? '—'})`);
		if ((a.document_type ?? 'FACTURA') !== (b.document_type ?? 'FACTURA'))
			diffs.push(`tipo de documento (${a.document_type ?? 'FACTURA'} / ${b.document_type ?? 'FACTURA'})`);

		return diffs;
	};

	const newInvoice = (issueDate: string, splitFrom: string | null, opIndex: number): WInvoice => {
		const key = `new:${++invoiceSeq}`;
		const invoice: WInvoice = {
			key,
			id: null,
			row: null,
			invoice_number: null,
			issue_date: issueDate,
			due_date: invoiceDueDate(issueDate, ctx.context),
			split_from: splitFrom,
			invoice_currency: ctx.rules.invoice_currency,
			contract_currency: ctx.rules.contract_currency,
			client_entity_id: ctx.rules.client_entity_id,
			legal_name: ctx.rules.legal_name,
			document_type: ctx.rules.document_type,
			export_type: ctx.rules.export_type,
			tax_rate: ctx.rules.tax_rate,
			// Se resuelve al final con el período de sus líneas (política FX del contrato para ese período).
			fx: upper(ctx.rules.invoice_currency) === upper(ctx.rules.contract_currency) ? 1 : null,
			treatment: null,
			created_by: opIndex,
			forced: false,
			blockers: [],
			order: invoiceOrder++,
		};

		invoices.set(key, invoice);

		return invoice;
	};

	/** Por Emitir operable (o nueva de esta reorganización) compatible con `source` cuya emisión cae en el mismo mes que `issueDate`. */
	const monthInvoice = (source: WInvoice, issueDate: string, exact = false): WInvoice | null =>
		[...invoices.values()]
			.filter(
				(invoice) =>
					invoice.blockers.length === 0 &&
					!!invoice.issue_date &&
					(exact ? invoice.issue_date === issueDate : invoice.issue_date.slice(0, 7) === issueDate.slice(0, 7)) &&
					incompatibility(source, invoice).length === 0
			)
			.sort(
				(a, b) => Number(a.id === null) - Number(b.id === null) || (a.issue_date ?? '').localeCompare(b.issue_date ?? '') || a.order - b.order
			)[0] ?? null;

	const touch = (line: WLine, opIndex: number, flags: { amount?: boolean; period?: boolean } = {}) => {
		if (flags.amount) line.amount_changed = true;
		if (flags.period) line.period_changed = true;
		line.changed_by = opIndex;
	};

	const addLine = (template: WLine, state: LineState, invoiceKey: string, originId: string | null, group: string | null, opIndex: number) => {
		const key = `new-line:${++lineSeq}`;
		const line: WLine = {
			key,
			id: null,
			origin_id: originId,
			invoice_key: invoiceKey,
			original_invoice_key: null,
			state: { ...state, is_visible: isVisibleLine(state.quantity) },
			before: null,
			group,
			amount_changed: true,
			// Una cuota concurrente (mismo período que su origen) no cambia períodos: no dispara la reconstrucción del devengo.
			period_changed:
				state.billing_period_start !== (template.before ?? template.state).billing_period_start ||
				state.billing_period_end !== (template.before ?? template.state).billing_period_end,
			removed: false,
			split: false,
			changed_by: opIndex,
			order: template.order + 0.001 * lineSeq,
		};

		lines.set(key, line);

		return line;
	};

	const dropLine = (line: WLine, opIndex: number) => {
		if (line.id) {
			line.removed = true;
			line.changed_by = opIndex;
		} else lines.delete(line.key);
	};

	const newGroup = (rows: WLine[]) => (rows.length > 1 || rows[0].group ? `${rows[0].group ?? rows[0].key}#${++groupSeq}` : null);

	/** Fecha de emisión desplazada tantos meses como se desplaza el período (mantiene el desfase anticipado/vencido de la factura). */
	const shiftedIssue = (invoice: WInvoice, fromPeriod: string, toPeriod: string) => {
		const base = invoice.issue_date ?? fromPeriod;

		return sameDayOfMonth(base, monthDiff(fromPeriod, toPeriod), dayOf(base));
	};

	// ---------------------------------------------------------------- operaciones

	input.operations.forEach((op, index) => {
		const result: ReorganizeOperationResult = { index, op: op.op, ok: true, blockers: [], warnings: [] };
		const field = (name: string) => `operations.${index}.${name}`;
		const errorCount = errors.length;
		const block = (code: string, message: string, nextStep: string | null = null) => {
			if (!result.blockers.some((blocker) => blocker.code === code && blocker.message === message))
				result.blockers.push({ code, message, next_step: nextStep });
		};
		const warn = (code: string, message: string) => {
			if (!result.warnings.some((warning) => warning.code === code && warning.message === message)) result.warnings.push({ code, message });
		};
		const invoiceBlocked = (invoice: WInvoice) => {
			for (const blocker of invoice.blockers) block(blocker.code, blocker.message, blocker.next_step);

			return invoice.blockers.length > 0;
		};
		const checkIssueDate = (issueDate: string) => {
			if (issueDate < ctx.context.today)
				warn(
					'past_issue_date',
					`La factura nueva se emite el ${issueDate}, que ya pasó: el envío automático no la tomará; usa "Enviar al ERP ahora"`
				);
		};
		/** Línea Por Emitir del contrato; null (con error o bloqueo) si no se puede operar. */
		const resolveLine = (lineId: string | null | undefined): WLine | null => {
			if (!lineId) {
				errors.push({ field: field('line_id'), message: 'Indica la línea' });

				return null;
			}
			const line = lines.get(lineId);

			if (line && !line.removed) return line;
			if (line) {
				block('line_removed', 'La línea ya no existe: una operación anterior la juntó con otra');

				return null;
			}
			const foreign = ctx.foreign_lines.get(lineId);

			if (foreign) {
				block(
					'not_pending',
					`La línea es de una factura ${ISSUED_STATUSES.includes(foreign.status ?? '') ? 'emitida (ancla del cronograma)' : `en estado ${foreign.status ?? 'sin estado'}`}: no se reorganiza`
				);

				return null;
			}
			errors.push({ field: field('line_id'), message: 'La línea no pertenece a una factura del contrato' });

			return null;
		};
		/** Factura Por Emitir operable del contrato; null (con error o bloqueo) si no. `destination` = recibe líneas. */
		const resolveInvoice = (invoiceId: string | null | undefined, name: string, destination = false): WInvoice | null => {
			if (!invoiceId) {
				errors.push({ field: field(name), message: 'Indica la factura' });

				return null;
			}
			const invoice = invoices.get(invoiceId);

			if (invoice && invoice.id) return invoiceBlocked(invoice) ? null : invoice;
			const foreign = ctx.foreign_invoices.get(invoiceId);

			if (foreign) {
				const count = result.blockers.length;

				if (destination && ISSUED_STATUSES.includes(foreign.status ?? '') && !isCreditNote(foreign.document_type))
					block('overlaps_issued', `${REORGANIZE_MESSAGES.target_issued} (factura ${invoiceLabel(foreign)}, ${foreign.status})`);
				else for (const blocker of commonBlockers(foreign)) block(blocker.code, blocker.message, blocker.next_step);
				if (result.blockers.length === count) block('not_pending', `La factura ${invoiceLabel(foreign)} no está Por Emitir`);

				return null;
			}
			errors.push({ field: field(name), message: 'La factura no pertenece al contrato' });

			return null;
		};
		/** Unidades (líneas o grupos por tramo) de un ítem en Por Emitir operables, sin manuales; avisa lo que se salta. */
		const itemUnits = (itemId: string): Unit[] => {
			const seen = new Set<string>();
			const units: Unit[] = [];

			for (const line of [...lines.values()]
				.filter((row) => !row.removed && row.state.contract_item_id === itemId)
				.sort((a, b) => a.order - b.order)) {
				if (seen.has(line.key)) continue;
				const rows = unitOf(line);

				rows.forEach((row) => seen.add(row.key));
				const invoice = invoices.get(line.invoice_key)!;

				if (invoice.blockers.length) {
					warn(
						'invoice_skipped',
						`La factura ${invoiceLabel(invoice)} no se puede tocar (${invoice.blockers.map((blocker) => blocker.code).join(', ')}): sus líneas del ítem quedan igual`
					);
					continue;
				}
				const lock = rows.map(lockOf).find(Boolean);

				if (lock) {
					warn(
						lock === 'manual' ? MANUAL_EDIT_KEPT : 'one_off_discount_kept',
						`La línea "${rows[0].state.description || itemName(itemId)}" (${rows[0].state.billing_period_start ?? ''}) ${
							lock === 'manual' ? 'está editada a mano' : 'tiene un descuento puntual'
						}: se conserva tal cual`
					);
					continue;
				}
				units.push({
					rows,
					invoice,
					start: rows[0].state.billing_period_start,
					end: rows[0].state.billing_period_end,
					total: round2(sum(rows.map((row) => row.state.subtotal_contract_currency))),
				});
			}

			return units.sort((a, b) => (a.start ?? '').localeCompare(b.start ?? '') || a.rows[0].order - b.rows[0].order);
		};
		/** Unidad de una línea para una operación que re-monta: bloqueos por consumo, avisos por manual. null si no se re-monta. */
		const amountUnit = (line: WLine): WLine[] | null => {
			const rows = unitOf(line);

			if (meteredItem(line.state.contract_item_id)) {
				block(
					'metered_line',
					`${REORGANIZE_MESSAGES.metered_line} ("${itemName(line.state.contract_item_id)}")`,
					'Muévela completa o registra el consumo en Consumos'
				);

				return null;
			}
			const lock = rows.map(lockOf).find(Boolean);

			if (lock) {
				warn(
					lock === 'manual' ? MANUAL_EDIT_KEPT : 'one_off_discount_kept',
					`La línea "${line.state.description || itemName(line.state.contract_item_id)}" ${
						lock === 'manual' ? 'está editada a mano' : 'tiene un descuento puntual'
					}: se puede mover, pero no se re-monta (queda igual)`
				);

				return null;
			}
			if (rows.length > 1)
				warn('per_tier_group', `La línea es parte de un ítem con una fila por tramo: se dividen sus ${rows.length} filas juntas`);

			return rows;
		};
		// ---- validación y ejecución por tipo
		const run = (): void => {
			switch (op.op) {
				case 'merge': {
					const ids = op.invoice_ids ?? [];

					if (ids.length < 2) errors.push({ field: field('invoice_ids'), message: 'Indica al menos dos facturas para juntar' });
					if (new Set(ids).size !== ids.length) errors.push({ field: field('invoice_ids'), message: 'Una factura viene repetida' });
					if (errors.length > errorCount) return;
					const set = ids.map((id) => resolveInvoice(id, 'invoice_ids'));

					if (set.some((invoice) => !invoice) || result.blockers.length) return;
					const [target, ...others] = [...(set as WInvoice[])].sort(
						(a, b) => (a.issue_date ?? '9999').localeCompare(b.issue_date ?? '9999') || a.order - b.order
					);

					for (const other of others) {
						const diffs = incompatibility(target, other);

						if (diffs.length)
							block(
								'mixed_currency',
								`${REORGANIZE_MESSAGES.mixed_currency}: ${invoiceLabel(other)} y ${invoiceLabel(target)} difieren en ${diffs.join(', ')}`,
								'Junta solo facturas con la misma moneda, receptor y tipo de documento (el receptor se cambia en Editar borrador)'
							);
					}
					if (result.blockers.length) return;
					for (const other of others) {
						for (const line of live(other.key)) {
							line.invoice_key = target.key;
							touch(line, index);
						}
					}

					return;
				}
				case 'move_line': {
					if (!!op.to_invoice_id === !!op.new_invoice)
						errors.push({
							field: field('to_invoice_id'),
							message: 'Indica la factura destino (to_invoice_id) o una factura nueva (new_invoice), no ambas',
						});
					if (op.new_invoice && !op.new_invoice.issue_date)
						errors.push({ field: field('new_invoice.issue_date'), message: 'Indica la fecha de emisión de la factura nueva' });
					const line = resolveLine(op.line_id);

					if (!line || errors.length > errorCount) return;
					const source = invoices.get(line.invoice_key)!;

					if (invoiceBlocked(source)) return;
					let destination: WInvoice | null = null;

					if (op.to_invoice_id) {
						destination = resolveInvoice(op.to_invoice_id, 'to_invoice_id', true);
						if (!destination) return;
						if (destination.key === source.key) {
							warn('no_change', 'La línea ya está en esa factura');

							return;
						}
						if (upper(destination.invoice_currency) !== upper(source.invoice_currency))
							block(
								'mixed_currency',
								`La factura ${invoiceLabel(destination)} se emite en ${destination.invoice_currency ?? '—'} y la línea viene de una en ${source.invoice_currency ?? '—'}: una factura no mezcla monedas`,
								'Mueve la línea a una factura en la misma moneda o a una factura nueva'
							);
					} else checkIssueDate(op.new_invoice!.issue_date);
					if (result.blockers.length) return;
					const rows = unitOf(line);

					if (rows.length > 1)
						warn('per_tier_group', `La línea es parte de un ítem con una fila por tramo: se mueven sus ${rows.length} filas juntas`);
					if (rows.some((row) => lockOf(row)))
						warn(MANUAL_EDIT_KEPT, 'La línea está editada a mano o tiene un descuento puntual: se mueve sin cambiar sus montos');
					destination ??= newInvoice(op.new_invoice!.issue_date, splitFromOf(source), index);
					for (const row of rows) {
						row.invoice_key = destination.key;
						touch(row, index);
					}

					return;
				}
				case 'split_line': {
					const line = resolveLine(op.line_id);

					if (!op.by) errors.push({ field: field('by'), message: 'Indica cómo dividir: date, amount o installments' });
					if (!line || errors.length > errorCount) return;
					const source = invoices.get(line.invoice_key)!;

					if (invoiceBlocked(source)) return;
					const rows = amountUnit(line);

					if (!rows || result.blockers.length) return;
					const start = line.state.billing_period_start;
					const end = line.state.billing_period_end;
					const rowTotals = rows.map((row) => row.state.subtotal_contract_currency);
					const total = round2(sum(rowTotals));

					if (op.by === 'date') {
						if (!start || !end) {
							errors.push({ field: field('line_id'), message: 'La línea no tiene período de servicio: no se divide por fecha' });

							return;
						}
						if (!op.at) errors.push({ field: field('at'), message: 'Indica la fecha de corte (último día de la primera parte)' });
						else if (op.at < start || op.at >= end)
							errors.push({ field: field('at'), message: `La fecha de corte debe estar entre ${start} y el día anterior a ${end}` });
						if (errors.length > errorCount) return;
						const laterStart = addDays(op.at!, 1);
						const issue = op.issue_date ?? shiftedIssue(source, start, laterStart);

						if (op.issue_date || issue !== source.issue_date) checkIssueDate(issue);
						if (result.blockers.length) return;
						const parts = telescopic(total, [periodDays(start, op.at!), periodDays(laterStart, end)]);
						const matrix = allocate(rowTotals, parts);
						const destination =
							!op.issue_date && monthDiff(start, laterStart) === 0 ? source : newInvoice(issue, splitFromOf(source), index);
						const group = newGroup(rows);

						rows.forEach((row, r) => {
							const original = row.state;

							row.state = reamount(original, matrix[0][r], { start, end: op.at! });
							row.split = true;
							touch(row, index, { amount: true, period: true });
							addLine(
								row,
								reamount(original, matrix[1][r], { start: laterStart, end }),
								destination.key,
								row.id ?? row.origin_id,
								group,
								index
							);
						});

						return;
					}
					let parts: number[] = [];
					let dates: Array<string | null> = [];

					if (op.by === 'amount') {
						const amount = round2(Number(op.amount ?? 0));

						if (!(amount > 0) || amount >= total)
							errors.push({
								field: field('amount'),
								message: `El monto de la primera parte debe ser mayor que 0 y menor que ${total}`,
							});
						else parts = [amount, round2(total - amount)];
					} else if (op.by === 'installments') {
						if (op.installments?.length) {
							if (op.installments.length < 2) errors.push({ field: field('installments'), message: 'Indica al menos dos cuotas' });
							if (op.installments.length > REORGANIZE_MAX_PARTS)
								errors.push({ field: field('installments'), message: `Máximo ${REORGANIZE_MAX_PARTS} cuotas` });
							if (op.installments.some((part) => !(Number(part.amount) > 0)))
								errors.push({ field: field('installments'), message: 'Cada cuota debe ser mayor que 0' });
							const requested = round2(sum(op.installments.map((part) => Number(part.amount))));

							if (Math.abs(requested - total) > 0.01 + 1e-9)
								errors.push({
									field: field('installments'),
									message: `Las cuotas suman ${requested} y la línea ${total}: deben sumar lo mismo (la diferencia de centavos va a la última)`,
								});
							if (errors.length > errorCount) return;
							parts = op.installments.map((part) => round2(Number(part.amount)));
							parts[parts.length - 1] = round2(parts[parts.length - 1] + total - sum(parts));
							dates = op.installments.map((part) => part.issue_date ?? null);
						} else if (op.count && op.count >= 2 && op.count <= REORGANIZE_MAX_PARTS) {
							parts = telescopic(
								total,
								Array.from({ length: op.count }, () => 1)
							);
						} else
							errors.push({
								field: field('count'),
								message: `Indica las cuotas (installments) o cuántas cuotas parejas (count entre 2 y ${REORGANIZE_MAX_PARTS})`,
							});
					} else errors.push({ field: field('by'), message: 'Indica cómo dividir: date, amount o installments' });
					if (errors.length > errorCount) return;
					const base = source.issue_date ?? start ?? ctx.context.today;
					const issues = parts.map((_, k) => dates[k] ?? (k === 0 ? source.issue_date : sameDayOfMonth(base, k, dayOf(base))));

					issues.forEach((issue, k) => {
						if (issue && (k > 0 || issue !== source.issue_date)) checkIssueDate(issue);
					});
					if (result.blockers.length) return;
					const matrix = allocate(rowTotals, parts);
					const originals = rows.map((row) => row.state);
					const firstMoves = !!issues[0] && issues[0] !== source.issue_date;
					const firstDestination = firstMoves ? newInvoice(issues[0]!, splitFromOf(source), index) : null;

					rows.forEach((row, r) => {
						row.state = reamount(originals[r], matrix[0][r]);
						row.split = true;
						touch(row, index, { amount: true });
						if (firstDestination) row.invoice_key = firstDestination.key;
					});
					for (let k = 1; k < parts.length; k += 1) {
						const destination = newInvoice(issues[k] ?? base, splitFromOf(source), index);
						const group = newGroup(rows);

						rows.forEach((row, r) =>
							addLine(row, reamount(originals[r], matrix[k][r]), destination.key, row.id ?? row.origin_id, group, index)
						);
					}

					return;
				}
				case 'split_invoice': {
					if (!op.cut_date)
						errors.push({ field: field('cut_date'), message: 'Indica la fecha de corte (último día que queda en la factura)' });
					const invoice = resolveInvoice(op.invoice_id, 'invoice_id');

					if (!invoice || errors.length > errorCount) return;
					const cut = op.cut_date!;
					const laterStart = addDays(cut, 1);
					const current = live(invoice.key);
					const periodStart =
						current
							.map((line) => line.state.billing_period_start)
							.filter((value): value is string => !!value)
							.sort()[0] ?? laterStart;
					const issue = op.issue_date ?? shiftedIssue(invoice, periodStart, laterStart);
					const seen = new Set<string>();
					const moves: WLine[][] = [];
					const splits: WLine[][] = [];

					for (const line of current) {
						if (seen.has(line.key)) continue;
						const rows = unitOf(line);

						rows.forEach((row) => seen.add(row.key));
						const start = line.state.billing_period_start;
						const end = line.state.billing_period_end;

						if (!start || !end || end <= cut) continue;
						if (start > cut) moves.push(rows);
						else if (meteredItem(line.state.contract_item_id))
							warn(
								'metered_line',
								`${REORGANIZE_MESSAGES.metered_line}: "${itemName(line.state.contract_item_id)}" queda completa en la factura original`
							);
						else if (rows.some((row) => lockOf(row)))
							warn(
								MANUAL_EDIT_KEPT,
								`La línea "${line.state.description || itemName(line.state.contract_item_id)}" está editada a mano: queda completa en la factura original`
							);
						else splits.push(rows);
					}
					if (!moves.length && !splits.length) {
						warn('no_change', `Ninguna línea de la factura ${invoiceLabel(invoice)} cruza ni supera el ${cut}: no hay nada que dividir`);

						return;
					}
					if (!splits.length && moves.flat().length === current.length)
						warn('whole_invoice_moved', 'Todas las líneas quedan después del corte: la factura original queda sin líneas y se cancela');
					checkIssueDate(issue);
					if (result.blockers.length) return;
					const destination = newInvoice(issue, splitFromOf(invoice), index);

					for (const rows of moves) {
						for (const row of rows) {
							row.invoice_key = destination.key;
							touch(row, index);
						}
					}
					for (const rows of splits) {
						const start = rows[0].state.billing_period_start!;
						const end = rows[0].state.billing_period_end!;
						const rowTotals = rows.map((row) => row.state.subtotal_contract_currency);
						const matrix = allocate(rowTotals, telescopic(round2(sum(rowTotals)), [periodDays(start, cut), periodDays(laterStart, end)]));
						const group = newGroup(rows);

						if (rows.length > 1)
							warn(
								'per_tier_group',
								`"${itemName(rows[0].state.contract_item_id)}" tiene una fila por tramo: se dividen sus ${rows.length} filas juntas`
							);
						rows.forEach((row, r) => {
							const original = row.state;

							row.state = reamount(original, matrix[0][r], { start, end: cut });
							row.split = true;
							touch(row, index, { amount: true, period: true });
							addLine(
								row,
								reamount(original, matrix[1][r], { start: laterStart, end }),
								destination.key,
								row.id ?? row.origin_id,
								group,
								index
							);
						});
					}

					return;
				}
				case 'item_monthly':
				case 'item_unify_pending':
				case 'item_even_split': {
					const itemId = op.contract_item_id;

					if (!itemId) {
						errors.push({ field: field('contract_item_id'), message: 'Indica el ítem del contrato' });

						return;
					}
					if (!ctx.items.has(itemId)) {
						errors.push({ field: field('contract_item_id'), message: 'El ítem no pertenece al contrato' });

						return;
					}
					if (meteredItem(itemId)) {
						block(
							'metered_line',
							`${REORGANIZE_MESSAGES.metered_line} ("${itemName(itemId)}")`,
							'Sus líneas se mueven una a una; los montos salen de Consumos'
						);

						return;
					}
					const units = itemUnits(itemId).filter((unit) => unit.start && unit.end);

					if (!units.length) {
						warn('no_pending_lines', `"${itemName(itemId)}" no tiene líneas Por Emitir que se puedan reorganizar`);

						return;
					}
					if (op.op === 'item_monthly') return itemMonthly(units, index, warn, checkIssueDate, () => result.blockers.length > 0);
					if (op.op === 'item_unify_pending') {
						if (units.some((unit) => unit.rows.length > 1)) {
							block('per_tier_group', `${REORGANIZE_MESSAGES.per_tier_group} ("${itemName(itemId)}")`);

							return;
						}
						const first = units[0];
						const moveTo = op.issue_date && op.issue_date !== first.invoice.issue_date ? op.issue_date : null;

						if (units.length === 1 && !moveTo) {
							warn('no_change', `"${itemName(itemId)}" ya tiene una sola línea Por Emitir`);

							return;
						}
						if (moveTo) checkIssueDate(moveTo);
						if (result.blockers.length) return;
						const start = units.map((unit) => unit.start!).sort()[0];
						const end = units
							.map((unit) => unit.end!)
							.sort()
							.reverse()[0];
						const total = round2(sum(units.map((unit) => unit.total)));
						const withBreakdown = units.filter((unit) => unit.rows[0].state.pricing_breakdown?.length).length;
						const keeper = first.rows[0];

						if (units.length > 1 && withBreakdown)
							warn(
								'pricing_breakdown_dropped',
								`"${itemName(itemId)}": al juntar períodos la línea queda sin desglose por tramo (el total no cambia)`
							);
						keeper.state = reamount(
							{ ...keeper.state, pricing_breakdown: units.length > 1 && withBreakdown ? null : keeper.state.pricing_breakdown },
							total,
							{ start, end }
						);
						touch(keeper, index, { amount: true, period: true });
						for (const unit of units.slice(1)) for (const row of unit.rows) dropLine(row, index);
						if (moveTo) {
							const destination = monthInvoice(first.invoice, moveTo, true) ?? newInvoice(moveTo, splitFromOf(first.invoice), index);

							keeper.invoice_key = destination.key;
						}

						return;
					}
					// item_even_split
					const total = round2(sum(units.map((unit) => unit.total)));

					if (!op.count) {
						if (units.length < 2) {
							warn('no_change', `"${itemName(itemId)}" tiene una sola línea Por Emitir: no hay nada que repartir`);

							return;
						}
						const parts = telescopic(
							total,
							units.map(() => 1)
						);

						units.forEach((unit, k) => {
							const amounts = scaleRows(
								unit.rows.map((row) => row.state.subtotal_contract_currency),
								parts[k]
							);

							unit.rows.forEach((row, r) => {
								if (round2(row.state.subtotal_contract_currency) === amounts[r]) return;
								row.state = reamount(row.state, amounts[r]);
								touch(row, index, { amount: true });
							});
						});

						return;
					}
					const start = units.map((unit) => unit.start!).sort()[0];
					const end = units
						.map((unit) => unit.end!)
						.sort()
						.reverse()[0];
					const months = monthPieces(start, end);

					if (op.count < 1 || op.count > months.length) {
						errors.push({
							field: field('count'),
							message: `Lo pendiente de "${itemName(itemId)}" cubre ${months.length} ${months.length === 1 ? 'mes' : 'meses'}: indica entre 1 y ${months.length} cuotas`,
						});

						return;
					}
					const size = Math.floor(months.length / op.count);
					const extra = months.length % op.count;
					const chunks: Array<{ start: string; end: string }> = [];
					let cursor = 0;

					for (let k = 0; k < op.count; k += 1) {
						const take = size + (k < extra ? 1 : 0);

						chunks.push({ start: months[cursor].start, end: months[cursor + take - 1].end });
						cursor += take;
					}
					const template = units[0];
					const templateStates = template.rows.map((row) => row.state);
					const templateTotals = templateStates.map((state) => state.subtotal_contract_currency);
					const issues = chunks.map((chunk, k) =>
						k === 0 ? template.invoice.issue_date : shiftedIssue(template.invoice, template.start!, chunk.start)
					);

					issues.slice(1).forEach((issue) => issue && checkIssueDate(issue));
					if (result.blockers.length) return;
					const parts = telescopic(
						total,
						chunks.map(() => 1)
					);

					template.rows.forEach((row, r) => {
						row.state = reamount(templateStates[r], scaleRows(templateTotals, parts[0])[r], chunks[0]);
						touch(row, index, { amount: true, period: true });
					});
					for (const unit of units.slice(1)) for (const row of unit.rows) dropLine(row, index);
					for (let k = 1; k < chunks.length; k += 1) {
						const issue = issues[k] ?? chunks[k].start;
						const destination = monthInvoice(template.invoice, issue) ?? newInvoice(issue, splitFromOf(template.invoice), index);
						const amounts = scaleRows(templateTotals, parts[k]);
						const group = newGroup(template.rows);

						template.rows.forEach((row, r) =>
							addLine(row, reamount(templateStates[r], amounts[r], chunks[k]), destination.key, null, group, index)
						);
					}

					return;
				}
				case 'round_fix': {
					const invoice = resolveInvoice(op.invoice_id, 'invoice_id');

					if (!invoice?.row) return;
					const current = live(invoice.key);

					if (
						current.some((line) => line.changed_by !== null) ||
						[...lines.values()].some((line) => line.original_invoice_key === invoice.key && line.invoice_key !== invoice.key)
					) {
						warn(
							'round_fix_skipped',
							'La factura ya cambió en esta reorganización: el cuadre de redondeo se hace en una reorganización aparte'
						);

						return;
					}
					invoice.forced = true;
					const residual = round2(invoice.row.amount_contract_currency - sum(current.map((line) => line.state.subtotal_contract_currency)));
					const candidates = current
						.filter((line) => !lockOf(line) && line.state.quantity !== 0 && !meteredItem(line.state.contract_item_id))
						.sort((a, b) => Math.abs(b.state.subtotal_contract_currency) - Math.abs(a.state.subtotal_contract_currency));
					const target = candidates[0];

					if (!target) {
						warn(
							MANUAL_EDIT_KEPT,
							'No hay una línea que pueda absorber el redondeo (todas manuales o por consumo): el encabezado queda = Σ líneas'
						);

						return;
					}
					roundFixTargets.set(invoice.key, target.key);
					if (residual !== 0) {
						target.state = reamount(target.state, round2(target.state.subtotal_contract_currency + residual));
						touch(target, index, { amount: true });
						if (Math.abs(residual) > ROUND_FIX_WARN_ABOVE)
							warn(
								'rounding_residual_large',
								`La diferencia entre el encabezado y sus líneas es ${residual} ${invoice.contract_currency ?? ''}: más que un redondeo; revisa la factura antes de aplicar`.replace(
									/\s+:/,
									':'
								)
							);
					} else target.changed_by = index;

					return;
				}
			}
		};

		run();
		result.ok = result.blockers.length === 0 && errors.length === errorCount;
		results.push(result);
	});

	/** item_monthly: cada unidad en tramos por mes calendario (montos por días), los tramos nuevos a la Por Emitir del mes o a una nueva. */
	function itemMonthly(
		units: Unit[],
		index: number,
		warn: (code: string, message: string) => void,
		checkIssueDate: (issueDate: string) => void,
		blocked: () => boolean
	): void {
		const plans = units.map((unit) => ({ unit, pieces: monthPieces(unit.start!, unit.end!) }));
		const issues = plans.flatMap(({ unit, pieces }) => pieces.slice(1).map((piece) => shiftedIssue(unit.invoice, unit.start!, piece.start)));

		issues.forEach((issue) => checkIssueDate(issue));
		if (blocked()) return;
		let changed = false;

		for (const { unit, pieces } of plans) {
			if (pieces.length === 1) continue;
			changed = true;
			const originals = unit.rows.map((row) => row.state);
			const matrix = allocate(
				originals.map((state) => state.subtotal_contract_currency),
				telescopic(
					unit.total,
					pieces.map((piece) => piece.days)
				)
			);

			pieces.forEach((piece, k) => {
				if (k === 0) {
					unit.rows.forEach((row, r) => {
						row.state = reamount(originals[r], matrix[0][r], piece);
						row.split = true;
						touch(row, index, { amount: true, period: true });
					});

					return;
				}
				const issue = shiftedIssue(unit.invoice, unit.start!, piece.start);
				const destination = monthInvoice(unit.invoice, issue) ?? newInvoice(issue, splitFromOf(unit.invoice), index);
				const group = newGroup(unit.rows);

				unit.rows.forEach((row, r) =>
					addLine(row, reamount(originals[r], matrix[k][r], piece), destination.key, row.id ?? row.origin_id, group, index)
				);
			});
		}
		// Un solo renglón por mes: tramos contiguos del mismo mes (de líneas sin fila por tramo) se juntan en la línea existente.
		const itemId = units[0].rows[0].state.contract_item_id;
		const singles = [...lines.values()]
			.filter(
				(line) =>
					!line.removed &&
					line.state.contract_item_id === itemId &&
					!line.group &&
					!lockOf(line) &&
					line.state.billing_period_start &&
					line.state.billing_period_end &&
					invoices.get(line.invoice_key)!.blockers.length === 0
			)
			.sort((a, b) => a.state.billing_period_start!.localeCompare(b.state.billing_period_start!) || a.order - b.order);
		const byMonth = new Map<string, WLine[]>();

		for (const line of singles) {
			const month = line.state.billing_period_start!.slice(0, 7);

			byMonth.set(month, [...(byMonth.get(month) ?? []), line]);
		}
		for (const group of byMonth.values()) {
			if (group.length < 2) continue;
			let keeper = group[0];

			for (const next of group.slice(1)) {
				if (next.state.billing_period_start! > addDays(keeper.state.billing_period_end!, 1)) {
					keeper = next;
					continue;
				}
				const [keep, absorb] = keeper.id || !next.id ? [keeper, next] : [next, keeper];
				const start = [keep.state.billing_period_start!, absorb.state.billing_period_start!].sort()[0];
				const end = [keep.state.billing_period_end!, absorb.state.billing_period_end!].sort().reverse()[0];

				keep.state = reamount(
					{ ...keep.state, pricing_breakdown: absorb.state.pricing_breakdown?.length ? null : keep.state.pricing_breakdown },
					round2(keep.state.subtotal_contract_currency + absorb.state.subtotal_contract_currency),
					{ start, end }
				);
				touch(keep, index, { amount: true, period: true });
				dropLine(absorb, index);
				keeper = keep;
				changed = true;
			}
		}
		if (!changed) warn('no_change', 'El ítem ya se factura con una línea por mes calendario');
	}

	// ---------------------------------------------------------------- cierre: FX de las nuevas, montos por factura, glosas, anclas

	// Facturas nuevas que quedaron sin líneas (una operación posterior se las llevó) no se crean.
	for (const invoice of [...invoices.values()]) if (!invoice.id && !live(invoice.key).length) invoices.delete(invoice.key);
	for (const invoice of invoices.values()) {
		if (invoice.id || upper(invoice.invoice_currency) === upper(invoice.contract_currency)) continue;
		if (ctx.rules.fx_invoice_policy !== 'fixed') {
			invoice.fx = null;
			continue;
		}
		const periodStart =
			live(invoice.key)
				.map((line) => line.state.billing_period_start)
				.filter((value): value is string => !!value)
				.sort()[0] ?? invoice.issue_date!;

		invoice.fx = findFixedRate(ctx.rules.fixed_invoice_rates, invoice.contract_currency ?? '', invoice.invoice_currency ?? '', periodStart);
		if (invoice.fx === null && invoice.created_by !== null)
			results[invoice.created_by].warnings.push({
				code: 'fixed_fx_without_rate',
				message: `El contrato usa tipo de cambio fijo pero no tiene tasa ${invoice.contract_currency} → ${invoice.invoice_currency} para el período que empieza el ${periodStart}: la factura nueva queda sin tasa (confírmala en Tipo de cambio antes de enviar)`,
			});
	}
	const renderFor = (invoice: WInvoice): RenderInput => ({
		template: ctx.render.template,
		contract_number: ctx.render.contract_number,
		client_name: invoice.legal_name ?? ctx.render.client_name,
		references: [],
		contract_currency: invoice.contract_currency,
		invoice_currency: invoice.invoice_currency,
		fx_rate: invoice.fx === 1 ? null : invoice.fx,
		max_chars: ctx.render.max_chars,
	});

	for (const line of lines.values()) {
		if (line.removed) continue;
		const destination = invoices.get(line.invoice_key)!;
		const origin =
			invoices.get(line.original_invoice_key ?? '') ??
			(line.origin_id ? invoices.get(lines.get(line.origin_id)?.original_invoice_key ?? '') : null);
		const moved = line.original_invoice_key !== line.invoice_key;
		const state = line.state;

		if (line.amount_changed || !line.id) {
			line.state = {
				...state,
				...amountsOf(
					state.quantity,
					state.unit_price_contract_currency,
					state.subtotal_contract_currency,
					destination.tax_rate,
					destination.fx
				),
			};
		} else if (moved && origin && (origin.tax_rate !== destination.tax_rate || origin.fx !== destination.fx)) {
			line.state = {
				...state,
				...amountsOf(
					state.quantity,
					state.unit_price_contract_currency,
					state.subtotal_contract_currency,
					destination.tax_rate,
					destination.fx,
					origin.tax_rate === destination.tax_rate ? state.tax_contract_currency : undefined
				),
			};
		}
		// Una línea interna de facturar por OC (stateOf ya la dejó no visible) sigue sin serlo aunque se re-monte.
		line.state = { ...line.state, is_visible: line.state.is_visible !== false && isVisibleLine(line.state.quantity) };
		if (!line.state.description_locked && (line.amount_changed || line.period_changed || !line.id)) {
			line.state.description = renderLine(
				line.state,
				renderFor(destination),
				isPerTierBreakdown(line.state.pricing_breakdown) ? 'per_tier' : undefined
			);
		}
	}
	// Multimoneda (spec-multimoneda §4): cada línea con la tasa de SU par en el documento donde queda (nunca la del encabezado de destino). La
	// que se mueve o nace deja su tasa y toma la del documento (fijada por factura para el par, fija pactada del período o spot); la que se
	// queda conserva la suya. Glosa con la tasa de la línea; FX del encabezado = el del único par convertidor o NULL.
	if (ctx.multicurrency) {
		for (const invoice of invoices.values()) {
			const current = live(invoice.key);

			if (!current.length) continue;
			const revalued = revalueStates(
				current.map((line) => ({
					id: line.key,
					state:
						line.original_invoice_key !== line.invoice_key || !line.id ? { ...line.state, fx: null, fx_rate_source: null } : line.state,
				})),
				ctx.multicurrency,
				{ invoice_currency: invoice.invoice_currency, issue_date: invoice.issue_date },
				invoice.tax_rate
			);

			current.forEach((line, index) => {
				const next = revalued.states[index];

				line.state =
					!next.description_locked && (line.amount_changed || line.period_changed || !line.id)
						? {
								...next,
								description: renderLine(
									next,
									renderFor(invoice),
									isPerTierBreakdown(next.pricing_breakdown) ? 'per_tier' : undefined
								),
							}
						: next;
			});
			invoice.fx = revalued.header.fx_contract_to_invoice ?? null;
		}
	}
	// Cuadre de redondeo en moneda de factura: el residuo contra el encabezado guardado va a la misma línea.
	for (const [invoiceKey, lineKey] of roundFixTargets) {
		const invoice = invoices.get(invoiceKey)!;
		const target = lines.get(lineKey)!;
		const current = live(invoiceKey);
		const opIndex = target.changed_by ?? 0;
		const row = invoice.row!;
		const contractResidualApplied = target.amount_changed;
		let invoiceResidual = 0;

		if (
			!ctx.multicurrency &&
			invoice.fx !== null &&
			invoice.fx !== 1 &&
			row.amount_invoice_currency !== null &&
			current.every((line) => line.state.subtotal_invoice_currency !== null)
		) {
			invoiceResidual = round2(row.amount_invoice_currency - sum(current.map((line) => line.state.subtotal_invoice_currency ?? 0)));
			if (invoiceResidual !== 0) {
				const subtotal = round2((target.state.subtotal_invoice_currency ?? 0) + invoiceResidual);
				const tax = round2((subtotal * invoice.tax_rate) / 100);

				target.state = {
					...target.state,
					unit_price_invoice_currency:
						target.state.quantity > 0 ? round6(subtotal / target.state.quantity) : target.state.unit_price_invoice_currency,
					subtotal_invoice_currency: subtotal,
					tax_invoice_currency: tax,
					total_invoice_currency: round2(subtotal + tax),
				};
				target.amount_changed = true;
				if (Math.abs(invoiceResidual) > ROUND_FIX_WARN_ABOVE)
					results[opIndex].warnings.push({
						code: 'rounding_residual_large',
						message: `La diferencia en moneda de factura es ${invoiceResidual} ${invoice.invoice_currency ?? ''}: más que un redondeo; revisa la factura antes de aplicar`,
					});
			}
		}
		const after = headerFromLines(
			invoice,
			current.map((line) => line.state),
			PENDING_STATUS,
			ctx.multicurrency ?? null
		);
		const before = headerOfRow(row, originalLines.get(invoiceKey) ?? []);

		if (!contractResidualApplied && invoiceResidual === 0 && !headerDiffers(before, after))
			results[opIndex].warnings.push({ code: 'no_change', message: `La factura ${invoiceLabel(invoice)} ya cuadra: encabezado = Σ líneas` });
	}
	// Anclas: ninguna línea con período nuevo se cruza con lo emitido del mismo ítem; nada re-fechado en período cerrado.
	for (const line of lines.values()) {
		if (line.removed || !(line.period_changed || !line.id) || line.changed_by === null) continue;
		const result = results[line.changed_by];
		const start = line.state.billing_period_start;
		const end = line.state.billing_period_end;

		if (!start || !end) continue;
		const clash = ctx.issued_periods.find(
			(period) =>
				period.contract_item_id === line.state.contract_item_id && start <= period.billing_period_end && period.billing_period_start <= end
		);

		if (clash && !result.blockers.some((blocker) => blocker.code === 'overlaps_issued'))
			result.blockers.push({
				code: 'overlaps_issued',
				message: `${REORGANIZE_MESSAGES.overlaps_issued} ("${itemName(line.state.contract_item_id)}" ${start} a ${end}; factura ${
					clash.invoice_number ?? clash.invoice_id
				}, ${clash.billing_period_start} a ${clash.billing_period_end})`,
				next_step: 'Las emitidas son ancla: ajusta la operación para que no cubra ese período',
			});
	}
	// ---- el descuento puntual sigue a su línea (spec §3.4/§3.5): el destino toma el tratamiento de devengo del origen (conflicto si ya tiene
	// otro), el origen lo pierde si no le queda ninguna línea con puntual, y la fila de `invoice_adjustments` se mueve o duplica por la parte.
	const treatmentAfter = new Map([...invoices.values()].map((invoice) => [invoice.key, invoice.treatment]));
	const sourceOf = (line: WLine): string | null =>
		line.original_invoice_key ?? (line.origin_id ? (lines.get(line.origin_id)?.original_invoice_key ?? null) : null);
	const oneOffTotal = (states: LineState[]) => round2(sum(states.map((state) => -(oneOffOf(state.pricing_breakdown)?.total ?? 0))));
	const movedOneOff = new Map<string, number>();
	const oneOffMonths: string[] = [];

	for (const line of [...lines.values()].sort((a, b) => a.order - b.order)) {
		const one = line.removed ? null : oneOffOf(line.state.pricing_breakdown);
		const source = sourceOf(line);

		if (!one || !source || source === line.invoice_key) continue;
		const origin = invoices.get(source);
		const destination = invoices.get(line.invoice_key);

		if (!origin?.id || !destination) continue;
		const treatment = origin.treatment;
		const current = treatmentAfter.get(destination.key) ?? null;
		const result = line.changed_by === null ? null : results[line.changed_by];

		if (treatment && current && current !== treatment) {
			if (result && !result.blockers.some((blocker) => blocker.code === 'revenue_treatment_conflict'))
				result.blockers.push({
					code: 'revenue_treatment_conflict',
					message: `La línea "${line.state.description || itemName(line.state.contract_item_id)}" lleva un descuento puntual devengado como ${treatment} y la factura ${invoiceLabel(destination)} ya tiene otro (${current})`,
					next_step: 'Mueve la línea a otra factura o alinea antes el devengo del descuento puntual de ambas',
				});
			continue;
		}
		if (treatment) treatmentAfter.set(destination.key, treatment);
		const key = `${origin.id}|${destination.key}`;

		movedOneOff.set(key, round2((movedOneOff.get(key) ?? 0) - one.total));
		oneOffMonths.push(...[origin.issue_date, origin.row?.issue_date, destination.issue_date].filter((value): value is string => !!value));
	}
	for (const invoice of invoices.values())
		if (invoice.id && treatmentAfter.get(invoice.key) && !live(invoice.key).some((line) => oneOffOf(line.state.pricing_breakdown)))
			treatmentAfter.set(invoice.key, null);
	const treatmentUpdates: ReorganizePlan['write']['treatment_updates'] = [...invoices.values()]
		.filter((invoice) => (treatmentAfter.get(invoice.key) ?? null) !== (invoice.id ? invoice.treatment : null))
		.map((invoice) => ({ invoice_key: invoice.key, nc_revenue_treatment: treatmentAfter.get(invoice.key) ?? null }));
	const oneOffMoves: ReorganizePlan['write']['one_off_moves'] = [...movedOneOff.entries()].map(([key, amount]) => {
		const [fromId, toKey] = key.split('|');
		const total = oneOffTotal(originalLines.get(fromId) ?? []);

		return { from_invoice_id: fromId, to_invoice_key: toKey, share: total > 0 ? Math.min(1, amount / total) : 1 };
	});

	for (const result of results) result.ok = result.ok && result.blockers.length === 0;

	// ---------------------------------------------------------------- vistas por factura

	const views: ReorganizeInvoiceView[] = [];
	const write: ReorganizePlan['write'] = {
		creates: [],
		header_updates: [],
		cancelled: [],
		line_updates: [],
		line_creates: [],
		line_removes: [],
		treatment_updates: treatmentUpdates,
		one_off_moves: oneOffMoves,
	};
	const summary: ReorganizePlan['summary'] = {
		invoices_created: 0,
		invoices_cancelled: 0,
		lines_moved: 0,
		lines_split: 0,
		lines_created: 0,
		lines_removed: 0,
		lines_updated: 0,
	};
	const referenced = new Set<string>(
		input.operations.flatMap((op) => [...(op.invoice_ids ?? []), op.to_invoice_id ?? '', op.invoice_id ?? ''].filter(Boolean))
	);
	const actionOf = (line: WLine): ReorganizeLineAction => {
		if (line.removed) return 'removed';
		if (!line.id) return line.origin_id ? 'split' : 'created';
		if (line.split) return 'split';
		if (line.original_invoice_key !== line.invoice_key) return 'moved';

		return sameState(line.state, line.before) ? 'unchanged' : 'updated';
	};
	const lineView = (line: WLine, perspective: string): ReorganizeLineView => {
		const action = actionOf(line);
		const movedOut = action === 'moved' && line.invoice_key !== perspective;

		return {
			id: line.id,
			key: line.key,
			action,
			from_invoice_id: action === 'moved' ? line.original_invoice_key : null,
			origin_line_id: line.origin_id,
			to_invoice_key: line.removed ? null : line.invoice_key,
			per_tier_group: line.group,
			before: line.before,
			after: line.removed || movedOut ? null : line.state,
		};
	};

	for (const invoice of [...invoices.values()].sort((a, b) => (a.issue_date ?? '').localeCompare(b.issue_date ?? '') || a.order - b.order)) {
		const current = live(invoice.key);
		const involved = [...lines.values()]
			.filter((line) => line.invoice_key === invoice.key || line.original_invoice_key === invoice.key)
			.sort((a, b) => a.order - b.order);
		const linesChanged = involved.some((line) => actionOf(line) !== 'unchanged');
		const forcedChange =
			invoice.forced &&
			!!invoice.row &&
			headerDiffers(
				headerOfRow(invoice.row, originalLines.get(invoice.key) ?? []),
				headerFromLines(
					invoice,
					current.map((line) => line.state),
					PENDING_STATUS,
					ctx.multicurrency ?? null
				)
			);
		const changed = linesChanged || forcedChange;

		if (!invoice.id) {
			const header = headerFromLines(
				invoice,
				current.map((line) => line.state),
				PENDING_STATUS,
				ctx.multicurrency ?? null
			);

			views.push({
				id: null,
				key: invoice.key,
				invoice_number: null,
				action: 'created',
				split_from_invoice_id: invoice.split_from,
				before: null,
				after: header,
				lines: current.map((line) => lineView(line, invoice.key)),
			});
			write.creates.push({
				key: invoice.key,
				issue_date: invoice.issue_date!,
				due_date: invoice.due_date!,
				split_from_invoice_id: invoice.split_from,
				client_entity_id: invoice.client_entity_id,
				document_type: invoice.document_type ?? 'FACTURA',
				export_type: invoice.export_type,
				tax_rate: invoice.tax_rate,
				contract_currency: invoice.contract_currency ?? ctx.rules.contract_currency,
				invoice_currency: invoice.invoice_currency ?? ctx.rules.invoice_currency,
				fx: invoice.fx,
				header,
			});
			summary.invoices_created += 1;
			continue;
		}
		if (!changed && !referenced.has(invoice.key)) continue;
		const before = headerOfRow(invoice.row!, originalLines.get(invoice.key) ?? []);
		const cancelled = changed && current.length === 0;
		const after = !changed
			? before
			: headerFromLines(
					invoice,
					current.map((line) => line.state),
					cancelled ? CANCELLED_STATUS : PENDING_STATUS,
					ctx.multicurrency ?? null
				);

		views.push({
			id: invoice.id,
			key: invoice.key,
			invoice_number: invoice.invoice_number,
			action: !changed ? 'unchanged' : cancelled ? 'cancelled' : 'updated',
			split_from_invoice_id: null,
			before,
			after,
			lines: involved.map((line) => lineView(line, invoice.key)),
		});
		if (!changed) continue;
		if (cancelled) {
			write.cancelled.push({ id: invoice.id, header: after });
			summary.invoices_cancelled += 1;
		} else write.header_updates.push({ id: invoice.id, header: after });
	}
	for (const line of [...lines.values()].sort((a, b) => a.order - b.order)) {
		const action = actionOf(line);

		if (action === 'removed') {
			write.line_removes.push(line.id!);
			summary.lines_removed += 1;
			continue;
		}
		if (!line.id) {
			write.line_creates.push({ key: line.key, invoice_key: line.invoice_key, state: line.state });
			summary.lines_created += 1;
			continue;
		}
		if (action === 'unchanged') continue;
		const moved = line.original_invoice_key !== line.invoice_key;
		const origin = invoices.get(line.original_invoice_key ?? '');
		const destination = invoices.get(line.invoice_key)!;

		write.line_updates.push({
			id: line.id,
			invoice_key: line.invoice_key,
			state: line.state,
			moved,
			fx_changed: moved && origin?.fx !== destination.fx,
			...(moved ? { from_invoice_id: origin?.id ?? null, from_period_start: line.before?.billing_period_start ?? null } : {}),
		});
		if (action === 'moved') summary.lines_moved += 1;
		else if (action === 'split') summary.lines_split += 1;
		else summary.lines_updated += 1;
	}

	// ---------------------------------------------------------------- continuidad por ítem (antes/después, por LÍNEAS)

	const touchedItems = new Set<string>(
		[...lines.values()]
			.filter((line) => actionOf(line) !== 'unchanged' && line.state.contract_item_id)
			.map((line) => line.state.contract_item_id!)
	);
	const byItem: ItemContinuity[] = [];

	for (const itemId of [...touchedItems].sort(
		(a, b) => (ctx.product_names.get(a) ?? '').localeCompare(ctx.product_names.get(b) ?? '') || a.localeCompare(b)
	)) {
		const item = ctx.items.get(itemId) ?? null;
		const others = ctx.other_lines.filter((line) => line.contract_item_id === itemId);
		const beforeLines = [
			...others,
			...[...originalLines.values()]
				.flat()
				.filter((line) => line.contract_item_id === itemId)
				.map((line) => ({ ...line, subtotal: line.subtotal_contract_currency })),
		];
		const afterLines = [
			...others,
			...[...lines.values()]
				.filter((line) => !line.removed && line.state.contract_item_id === itemId)
				.map((line) => ({ ...line.state, subtotal: line.state.subtotal_contract_currency })),
		];
		const before = continuitySide(beforeLines, item);
		const after = continuitySide(afterLines, item);
		const expectedEntries = [...ctx.expected.entries()].filter(([key]) => key.startsWith(`${itemId}|`));
		const expectedTotal = ctx.known_items.has(itemId) ? round2(sum(expectedEntries.map(([, value]) => value))) : null;
		const tolerance = Math.max(0.01, round2(0.01 * Math.max(before.lines, after.lines)));
		const diff = round2(after.actual_total - before.actual_total);
		const months = new Map<string, ContinuityPeriod>();
		const bucket = (month: string) => {
			if (!months.has(month)) months.set(month, { month, expected: expectedTotal === null ? null : 0, before: 0, after: 0 });

			return months.get(month)!;
		};

		for (const [key, value] of expectedEntries) {
			const entry = bucket(key.slice(itemId.length + 1, itemId.length + 8));

			entry.expected = round2((entry.expected ?? 0) + value);
		}
		for (const line of beforeLines)
			if (line.billing_period_start)
				bucket(line.billing_period_start.slice(0, 7)).before = round2(bucket(line.billing_period_start.slice(0, 7)).before + line.subtotal);
		for (const line of afterLines)
			if (line.billing_period_start)
				bucket(line.billing_period_start.slice(0, 7)).after = round2(bucket(line.billing_period_start.slice(0, 7)).after + line.subtotal);
		byItem.push({
			contract_item_id: itemId,
			product_name: item?.product_name ?? ctx.product_names.get(itemId) ?? null,
			expected_total: expectedTotal,
			before,
			after,
			diff,
			tolerance,
			inherited: expectedTotal !== null && Math.abs(before.actual_total - expectedTotal) > tolerance,
			changed: Math.abs(diff) > tolerance,
			by_period: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
		});
	}
	const changedItems = byItem.filter((item) => item.changed);
	const reason = input.deviation?.reason?.trim();
	const continuity: ReorganizeContinuity = {
		by_item: byItem,
		changed: changedItems.length > 0,
		total_diff: round2(sum(changedItems.map((item) => item.diff))),
		inherited: byItem.some((item) => item.inherited),
		reason_required: changedItems.length > 0 && !reason,
		currency: ctx.rules.contract_currency,
	};
	const warnings: InvoiceWarning[] = results.flatMap((result) => result.warnings);

	if (continuity.reason_required)
		warnings.push({
			code: 'deviation_reason_required',
			message: `${REORGANIZE_MESSAGES.deviation_reason_required} (diferencia ${continuity.total_diff} ${continuity.currency ?? ''})`.replace(
				/\s+\)/,
				')'
			),
		});
	if (input.deviation && !continuity.changed)
		warnings.push({ code: 'no_deviation', message: 'La reorganización no cambia el total de ningún ítem: el motivo del desvío no se registra' });
	if (continuity.inherited)
		warnings.push({
			code: 'inherited_gap',
			message: 'Hay ítems que ya se apartaban del plan antes de reorganizar (diferencia heredada): se informa, no bloquea',
		});
	const adjustments: ReorganizePlan['adjustments'] = [];

	if (continuity.changed && reason) {
		const changedIds = new Set(changedItems.map((item) => item.contract_item_id));
		const net = new Map<string, number>();

		for (const [invoiceKey, states] of originalLines)
			for (const state of states)
				if (changedIds.has(state.contract_item_id ?? ''))
					net.set(invoiceKey, round2((net.get(invoiceKey) ?? 0) - state.subtotal_contract_currency));
		for (const line of lines.values())
			if (!line.removed && changedIds.has(line.state.contract_item_id ?? ''))
				net.set(line.invoice_key, round2((net.get(line.invoice_key) ?? 0) + line.state.subtotal_contract_currency));
		for (const [invoiceKey, diff] of net)
			if (diff !== 0 && invoices.has(invoiceKey) && live(invoiceKey).length) adjustments.push({ invoice_key: invoiceKey, amount_diff: diff });
	}
	// Devengo: desde el primer período cambiado y, si un descuento puntual cambió de factura, desde el mes de emisión más temprano de ambas
	// (el ajuste de `nc_discount_revenue_adjustment` se ancla a la emisión).
	const periodTouched = [
		...[...lines.values()]
			.filter((line) => line.period_changed && !(line.removed && !line.id))
			.flatMap((line) => [line.before?.billing_period_start, line.state.billing_period_start]),
		...oneOffMonths,
	]
		.filter((value): value is string => !!value)
		.sort();
	const blockers = results.flatMap((result) => result.blockers);

	return {
		errors,
		operations: results,
		invoices: views,
		continuity,
		warnings,
		blockers,
		can_apply: blockers.length === 0 && errors.length === 0,
		write,
		rsm_from_month: periodTouched.length ? `${periodTouched[0].slice(0, 7)}-01` : null,
		adjustments,
		summary,
	};
}

// ------------------------------------------------------------------ tablero (lectura para la UI)

export interface ScheduleBoardLine {
	id: string;
	contract_item_id: string | null;
	product_name: string | null;
	account: string | null;
	description: string;
	quantity: number;
	unit_price_contract_currency: number;
	discount_pct: number;
	subtotal_contract_currency: number;
	subtotal_invoice_currency: number | null;
	total_invoice_currency: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity_source: string | null;
	/** Grupo de filas por tramo del mismo ítem y período (se mueven y dividen juntas); null si es una sola fila. */
	per_tier_group: string | null;
	line_index: number | null;
	/** Editada a mano: se mueve pero no se re-monta. */
	manual: boolean;
	/** Glosa protegida (`description_locked`). */
	locked: boolean;
	one_off_discount: boolean;
	metered: boolean;
	is_visible: boolean;
}

export interface ScheduleBoardInvoice {
	id: string;
	invoice_number: string | null;
	status: string | null;
	issue_date: string | null;
	due_date: string | null;
	period_start: string | null;
	period_end: string | null;
	client_entity_id: string | null;
	legal_name: string | null;
	document_type: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
	amount_contract_currency: number;
	total_invoice_currency: number | null;
	/** Σ líneas (moneda de contrato) distinto del encabezado → candidata a `round_fix`. */
	header_residual: number;
	operable: boolean;
	blockers: InvoiceBlocker[];
	lines: ScheduleBoardLine[];
}

/** Tablero de Reorganizar: Por Emitir con sus líneas ordenadas por período, flags de lo que se puede tocar y el residuo encabezado ↔ líneas. */
export function scheduleBoard(
	invoices: ContractInvoiceRow[],
	lines: Map<string, EditLineRow[]>,
	items: Map<string, EditItem>
): ScheduleBoardInvoice[] {
	return invoices
		.map((invoice) => {
			const rows = lines.get(invoice.id) ?? [];
			const blockers = invoiceOperability(invoice);

			return {
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				status: invoice.status,
				issue_date: invoice.issue_date,
				due_date: invoice.due_date,
				period_start: invoice.period_start,
				period_end: invoice.period_end,
				client_entity_id: invoice.client_entity_id,
				legal_name: invoice.legal_name,
				document_type: invoice.document_type,
				contract_currency: invoice.contract_currency,
				invoice_currency: invoice.invoice_currency,
				fx_contract_to_invoice: invoice.fx_contract_to_invoice,
				amount_contract_currency: invoice.amount_contract_currency,
				total_invoice_currency: invoice.total_invoice_currency,
				header_residual: round2(invoice.amount_contract_currency - sum(rows.map((row) => row.subtotal))),
				operable: blockers.length === 0,
				blockers,
				lines: rows.map((row) => {
					const perTier = isPerTierBreakdown(row.pricing_breakdown);
					const lineIndex = (row.pricing_breakdown ?? []).find(
						(subline) => subline.line_index !== undefined && subline.line_index !== null
					)?.line_index;

					return {
						id: row.id,
						contract_item_id: row.contract_item_id,
						product_name: row.product_name,
						account: row.account,
						description: row.description ?? '',
						quantity: row.quantity,
						unit_price_contract_currency: row.unit_price,
						discount_pct: row.discount_pct,
						subtotal_contract_currency: row.subtotal,
						subtotal_invoice_currency: row.subtotal_invoice,
						total_invoice_currency: row.total_invoice,
						billing_period_start: row.billing_period_start,
						billing_period_end: row.billing_period_end,
						quantity_source: row.quantity_source,
						per_tier_group: perTier ? `${invoice.id}|${row.contract_item_id ?? ''}|${row.billing_period_start ?? ''}` : null,
						line_index: perTier ? (lineIndex ?? 0) : null,
						manual: row.quantity_source === MANUAL_QUANTITY_SOURCE,
						locked: row.description_locked,
						one_off_discount: !!oneOffOf(row.pricing_breakdown),
						metered: !!row.contract_item_id && isMetered(items.get(row.contract_item_id)?.price),
						is_visible: isVisibleLine(row.quantity, row.visible_line_id),
					};
				}),
			};
		})
		.sort((a, b) => (a.period_start ?? '9999').localeCompare(b.period_start ?? '9999') || (a.issue_date ?? '').localeCompare(b.issue_date ?? ''));
}
