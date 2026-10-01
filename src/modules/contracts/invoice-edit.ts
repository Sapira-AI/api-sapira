import type { FieldError } from '@/core/utils/validation-errors';

import { normalizeCountry, normalizeTaxRate, round2 } from './billing-engine';
import { headerFromLines, lineAmounts } from './consumption';
import { isVisibleLine } from './contract-360';
import {
	commonBlockers,
	type ContractInvoiceContext,
	type ContractInvoiceRow,
	erpDraftBlocker,
	type InvoiceBlocker,
	invoiceDueDate,
	type InvoiceWarning,
	isMultiCurrency,
	partialBillingBlocker,
	periodClosedBlocker,
	round6,
} from './contract-invoices';
import {
	type DescriptionContext,
	type DescriptionReference,
	type DescriptionTemplate,
	exceedsMax,
	fitDescription,
	isPerTierBreakdown,
	manualDescription,
	tierLabelFromBreakdown,
} from './invoice-description';
import { multicurrencyHeader, type PairRateContext, revalueByPair } from './multicurrency';
import {
	isOneOffSubline,
	oneOffAmount,
	type OneOffDiscountInput,
	oneOffOf,
	oneOffRevenueEffect,
	type OneOffRevenueTreatment,
	oneOffSubline,
	type RevenueEffect,
	withoutOneOff,
} from './one-off-discount';
import {
	distributeTax,
	type InvoiceLineMode,
	isMetered,
	type PricedLine,
	type PricedSubline,
	priceLine,
	type PriceSpec,
	splitInvoiceLines,
} from './pricing-engine';

/**
 * Facturas en el Contrato 360, etapa 4 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.4): editar una Por Emitir como un todo
 * (líneas, cantidades, unitario, descuento, glosa, receptor, fechas, condiciones), presentación por tramo ↔ una fila, y el **conciliador
 * de desvíos** (plan ↔ factura por LÍNEAS, nunca bloquea por diferencia de monto: pide motivo). Lógica pura, sin base: el servicio
 * (`contract-invoice-edit.service.ts`) carga, bloquea y escribe.
 *
 * Esquema (decisión de Domi, sin duplicar campos): el motivo del desvío se guarda en `invoice_adjustments` (type discount | downsell |
 * upsell | correction); la línea tocada a mano queda `invoice_items.quantity_source = 'manual'`; una línea en cantidad 0 está "oculta"
 * por derivación, nunca se borra. Etapa 6 (§3.7b): una línea **interna** de facturar por OC (`invoice_items.visible_line_id` NOT NULL)
 * tampoco es visible: `is_visible = quantity !== 0 && visible_line_id IS NULL` (`isVisibleLine`, sin columna).
 */

// ------------------------------------------------------------------ constantes

export const DEVIATION_TYPES = ['discount', 'upsell', 'downsell', 'correction'] as const;
export type DeviationType = (typeof DEVIATION_TYPES)[number];
export const AMOUNT_BASES = ['unit_rate', 'exact_total'] as const;
export type AmountBasis = (typeof AMOUNT_BASES)[number];
export const LINE_MODE_SCOPES = ['invoice', 'invoice_and_following'] as const;
export type LineModeScope = (typeof LINE_MODE_SCOPES)[number];
/** Origen de la cantidad de una línea editada a mano (CHECK `invoice_items_quantity_source_check`, migración 1790680000000). */
export const MANUAL_QUANTITY_SOURCE = 'manual';
/** Origen de la tasa de las líneas nuevas cuando la factura tiene tasa (texto libre de `invoice_items.fx_rate_source`). */
export const EDIT_FX_RATE_SOURCE = 'invoice-edit';
/** Diferencia mínima (moneda de contrato) que cuenta como desvío. */
export const DEVIATION_TOLERANCE = 0.01;
export const MANUAL_EDIT_KEPT = 'manual_edit_kept';

export const EDIT_BLOCKER_MESSAGES = {
	quantity_negative: 'La cantidad de una línea no puede ser negativa',
	metered_line_use_consumption: 'La cantidad de una línea por consumo se cambia registrando el consumo del período',
	overlaps_issued: 'El período de la línea se cruza con un período ya emitido del mismo ítem',
	due_before_issue: 'El vencimiento quedaría antes de la fecha de emisión',
	item_not_in_contract: 'La línea no corresponde a un ítem vigente del contrato',
	deviation_reason_required: 'La factura queda distinta al plan: indica el tipo y el motivo del desvío',
} as const;

const same = (a: number, b: number, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
const PENDING_STATUS = 'Por Emitir';
const CANCELLED_STATUS = 'Cancelada';

// ------------------------------------------------------------------ tipos de entrada

export interface EditLineInput {
	id?: string | null;
	contract_item_id: string;
	description?: string | null;
	quantity: number;
	/** Unitario en MONEDA DE CONTRATO (`unit_price_contract_currency`). En líneas con modelo de precio es el unitario efectivo. */
	unit_price: number;
	discount_pct?: number | null;
	billing_period_start: string;
	billing_period_end: string;
	amount_basis?: AmountBasis | null;
	/** Con `exact_total`: subtotal neto fijo en moneda de contrato; el unitario se deriva (6 decimales). */
	exact_total?: number | null;
	/**
	 * Descuento puntual de esta factura (no cambia el contrato): % sobre el subtotal de la línea o monto en moneda de contrato. Ausente =
	 * se conserva el que tenga; null = se quita. Exige `deviation { type: discount, reason, revenue_treatment }`.
	 */
	one_off_discount?: OneOffDiscountInput | null;
}

export interface LineModeInput {
	contract_item_id: string;
	mode: InvoiceLineMode;
	scope?: LineModeScope | null;
}

export interface DeviationInput {
	type: DeviationType;
	reason: string;
	/** Devengo del descuento puntual (obligatorio si la edición agrega o cambia uno): se guarda en `invoices.nc_revenue_treatment`. */
	revenue_treatment?: OneOffRevenueTreatment | null;
}

export interface InvoiceEditInput {
	lines?: EditLineInput[] | null;
	line_mode?: LineModeInput[] | null;
	issue_date?: string | null;
	due_date?: string | null;
	client_entity_id?: string | null;
	invoice_terms_and_conditions?: string | null;
	notes?: string | null;
	auto_invoice?: boolean | null;
	deviation?: DeviationInput | null;
	confirm_manual_overwrite?: boolean | null;
}

/** Encabezado de la factura con lo que el editor necesita además de la fila común de operaciones. */
export interface EditInvoiceRow extends ContractInvoiceRow {
	client_tax_id: string | null;
	export_type: number | null;
	invoice_terms_and_conditions: string | null;
	notes: string | null;
	/** Devengo del descuento puntual de la factura (mismo campo que las NC de descuento). */
	nc_revenue_treatment: string | null;
}

/** Línea guardada de la factura. Montos en moneda de contrato salvo los `*_invoice`. */
export interface EditLineRow {
	id: string;
	contract_item_id: string | null;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	description: string | null;
	description_locked: boolean;
	quantity: number;
	unit_of_measure: string | null;
	discount_pct: number;
	unit_price: number;
	subtotal: number;
	tax_amount: number;
	total: number;
	unit_price_invoice: number | null;
	subtotal_invoice: number | null;
	tax_amount_invoice: number | null;
	total_invoice: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity_source: string | null;
	pricing_breakdown: PricedSubline[] | null;
	/** Etapa 6 (§3.7b): línea interna ligada a la línea visible del documento (facturar por OC); null/ausente = línea normal. */
	visible_line_id?: string | null;
	/**
	 * Multimoneda (spec-multimoneda §4; solo en contratos con `requires_multicurrency_billing`, ausente en los demás): moneda de la línea
	 * (`invoice_items.contract_currency` = moneda del ítem), su tasa a la moneda de factura y el origen de la tasa.
	 */
	currency?: string | null;
	fx?: number | null;
	fx_rate_source?: string | null;
}

/** Ítem del contrato con su modelo de precio (copia del contrato) y su vigencia. */
export interface EditItem {
	id: string;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	unit_of_measure: string | null;
	price: PriceSpec | null;
	price_id: string | null;
	/** `prices.owner` de la fila apuntada (`contract` = copia del contrato; nunca se edita el catálogo). */
	price_owner: string | null;
	start_date: string | null;
	end_date: string | null;
	churn_date: string | null;
	term_months?: number | null;
}

/** Período de una línea ya emitida (no NC, no anulada con NC de cancelación) de un ítem del contrato. */
export interface IssuedPeriod {
	contract_item_id: string;
	billing_period_start: string;
	billing_period_end: string;
	invoice_id: string;
	invoice_number: string | null;
}

/** Razón social pedida como receptor (misma regla de junction que `change_entity`). */
export interface ReceiverRow {
	id: string;
	legal_name: string | null;
	tax_id: string | null;
	country: string | null;
	belongs_to_client: boolean;
}

/** Lo que el plan espera por ítem y período (motor de facturación con los ítems vigentes y los consumos) y lo que ya llevan otras facturas. */
export interface DeviationPlan {
	/** `item|period_start` → subtotal esperado en moneda de contrato (Σ filas del motor). */
	expected: Map<string, number>;
	/** Ítems que el motor pudo tarifar (los demás no se concilian). */
	known_items: Set<string>;
	/** `item|period_start` → Σ subtotales del mismo ítem y período en OTRAS facturas vigentes del contrato (emitidas, Por Emitir, NC). */
	others: Map<string, number>;
	/** Nombre del producto por ítem. */
	product_names: Map<string, string | null>;
}

export interface EditContext {
	invoice: EditInvoiceRow;
	context: ContractInvoiceContext;
	company_tax_rate: number | string | null;
	contract_number: string | null;
	client_name: string | null;
	template: DescriptionTemplate | null;
	max_chars: number | null;
	lines: EditLineRow[];
	items: Map<string, EditItem>;
	issued_periods: IssuedPeriod[];
	/** Receptor pedido (`client_entity_id` del cuerpo), null si no se pidió o no existe en el holding. */
	receiver: ReceiverRow | null;
	references: DescriptionReference[];
	plan: DeviationPlan;
	/** Multimoneda: contexto por par del contrato (`requires_multicurrency_billing`); ausente/null = valorización de siempre (una tasa por factura). */
	multicurrency?: PairRateContext | null;
}

// ------------------------------------------------------------------ tipos de salida

/** Una línea antes o después (mismos nombres que `lines[]` del detalle de factura). */
export interface LineState {
	contract_item_id: string | null;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	description: string;
	description_locked: boolean;
	quantity: number;
	unit_of_measure: string | null;
	discount_pct: number;
	unit_price_contract_currency: number;
	subtotal_contract_currency: number;
	tax_contract_currency: number;
	total_contract_currency: number;
	unit_price_invoice_currency: number | null;
	subtotal_invoice_currency: number | null;
	tax_invoice_currency: number | null;
	total_invoice_currency: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity_source: string | null;
	pricing_breakdown: PricedSubline[] | null;
	is_visible: boolean;
	/** Vista del descuento puntual de la línea (derivada de su sublínea `one_off` del desglose); null si no tiene. */
	one_off_discount?: { type: string; value: number; amount: number; label: string } | null;
	/** Multimoneda (solo en contratos con el flag): moneda de la línea (= del ítem), tasa de su par a la moneda de factura y origen de la tasa. */
	currency?: string | null;
	fx?: number | null;
	fx_rate_source?: string | null;
}

export type LineAction = 'update' | 'create' | 'unchanged' | 'hide' | 'remove';

export interface LinePlan {
	id: string | null;
	action: LineAction;
	before: LineState | null;
	after: LineState | null;
	is_visible: boolean;
	/** Índice en `lines[]` del cuerpo (para errores por campo), si vino en el cuerpo. */
	input_index?: number;
}

export interface HeaderState {
	status: string | null;
	issue_date: string | null;
	scheduled_at: string | null;
	original_issue_date: string | null;
	due_date: string | null;
	client_entity_id: string | null;
	client_tax_id: string | null;
	legal_name: string | null;
	document_type: string | null;
	export_type: number | null;
	tax_rate: number | null;
	invoice_terms_and_conditions: string | null;
	notes: string | null;
	auto_invoice: boolean;
	nc_revenue_treatment: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
	amount_contract_currency: number;
	tax_contract_currency: number;
	total_contract_currency: number;
	vat: number | null;
	amount_invoice_currency: number | null;
	tax_invoice_currency: number | null;
	total_invoice_currency: number | null;
}

export interface DeviationByItem {
	contract_item_id: string;
	product_name: string | null;
	period_start: string;
	period_end: string | null;
	expected: number;
	actual: number;
	diff: number;
}

export interface DeviationView {
	has_deviation: boolean;
	/** Σ diferencias (factura − plan) en moneda de contrato. */
	total_diff: number;
	by_item: DeviationByItem[];
	/** La factura ya se desviaba del plan antes de esta edición. */
	inherited: boolean;
	/** La edición introduce o cambia el desvío (entonces pide motivo). */
	changed: boolean;
	/** Moneda de contrato de los montos. */
	currency: string | null;
	/** Aplicar exige `deviation { type, reason }` (desvío nuevo o cambiado sin motivo en el cuerpo). */
	reason_required?: boolean;
}

export interface LineModePlan {
	contract_item_id: string;
	mode: InvoiceLineMode;
	scope: LineModeScope;
	/** Períodos recompuestos en esta factura. */
	periods: string[];
	/** Períodos saltados en esta factura (líneas manuales sin confirmación, sin desglose). */
	skipped: Array<{ period_start: string; reason: string }>;
}

export interface RowWrite {
	updates: Array<{ id: string; after: LineState; touched_amounts: boolean }>;
	creates: LineState[];
	removes: string[];
}

export interface EditPlan {
	errors: FieldError[];
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	header: { before: HeaderState; after: HeaderState };
	lines: LinePlan[];
	line_mode: LineModePlan[];
	deviation: DeviationView;
	/** Qué se escribe (líneas y encabezado). */
	write: RowWrite & { header_changed: boolean; amounts_changed: boolean; tax_rate: number; fx: number | null };
	/** Primer mes cuyo devengo cambia (null = ningún monto de contrato cambió). */
	rsm_from_month: string | null;
	/** Ítems cuyo `prices.invoice_line_mode` cambia (scope `invoice_and_following`). */
	price_line_modes: Array<{ contract_item_id: string; price_id: string; mode: InvoiceLineMode }>;
	/** Dónde cae en el devengo el descuento puntual de la factura (null si no tiene ni tenía). */
	revenue_effect: RevenueEffect | null;
	/** Sin cobro (todas las líneas en 0): `becomes` = pasa a Cancelada; `reverted` = una sin cobro vuelve a Por Emitir. */
	no_charge: 'becomes' | 'reverted' | null;
	/** La edición agrega, cambia o quita un descuento puntual (o mueve su referencia): hay que reconstruir el devengo. */
	one_off_changed: boolean;
	can_apply: boolean;
}

// ------------------------------------------------------------------ utilidades

export { isVisibleLine };

/** Tasa de la factura para valorizar en su moneda: misma moneda → 1; fija → la tasa; spot sin tasa → null (se valoriza al emitir). */
export const invoiceFx = (invoice: Pick<ContractInvoiceRow, 'contract_currency' | 'invoice_currency' | 'fx_contract_to_invoice'>): number | null =>
	isMultiCurrency(invoice) ? invoice.fx_contract_to_invoice : 1;

/** IVA de la factura según su tipo de documento (misma regla del generador y de `change_entity`): exportación 0; Colombia 0; si no, la de la compañía. */
export function taxRateForDocument(documentType: string | null, companyCountry: string | null, companyTaxRate: number | string | null): number {
	if (documentType === 'FACTURA_EXPORTACION') return 0;
	if (normalizeCountry(companyCountry) === 'CO') return 0;

	return normalizeTaxRate(companyTaxRate) ?? 0;
}

/** ¿El descuento del ítem ya está dentro del unitario? (línea con modelo de precio: el motor lo aplica como sublínea). */
export const discountEmbedded = (row: Pick<EditLineRow, 'pricing_breakdown'>) =>
	Array.isArray(row.pricing_breakdown) && row.pricing_breakdown.some((subline) => !isOneOffSubline(subline));

/**
 * Subtotal de una línea manual SIN aplanar: cantidad × unitario × (1 − descuento). Con `exact_total` el subtotal es el pedido y el unitario
 * se deriva a 6 decimales. Devuelve null si el neto exacto no se puede derivar (cantidad 0 o descuento 100 %).
 */
export function manualLineAmounts(
	quantity: number,
	unitPrice: number,
	discountPct: number,
	basis: AmountBasis = 'unit_rate',
	exactTotal?: number | null
): { unit_price: number; subtotal: number } | null {
	const factor = 1 - discountPct / 100;

	if (basis === 'exact_total') {
		const target = round2(Number(exactTotal ?? 0));

		if (quantity === 0) return target === 0 ? { unit_price: round6(unitPrice), subtotal: 0 } : null;
		if (factor <= 0) return null;

		return { unit_price: round6(target / (quantity * factor)), subtotal: target };
	}

	return { unit_price: round6(unitPrice), subtotal: round2(quantity * unitPrice * factor) };
}

/** Montos de una línea (moneda de contrato y de factura con la convención FX de la factura). `tax` explícito cuando se reparte entre filas. */
export function amountsOf(
	quantity: number,
	unitPrice: number,
	subtotal: number,
	taxRate: number,
	fx: number | null,
	tax?: number
): Pick<
	LineState,
	| 'quantity'
	| 'unit_price_contract_currency'
	| 'subtotal_contract_currency'
	| 'tax_contract_currency'
	| 'total_contract_currency'
	| 'unit_price_invoice_currency'
	| 'subtotal_invoice_currency'
	| 'tax_invoice_currency'
	| 'total_invoice_currency'
> {
	const amounts = lineAmounts({ quantity, effective_unit_price: unitPrice, subtotal }, taxRate, fx, tax);

	return {
		quantity,
		unit_price_contract_currency: amounts.unit_price_contract_currency,
		subtotal_contract_currency: amounts.subtotal_contract_currency,
		tax_contract_currency: amounts.tax_amount_contract_currency,
		total_contract_currency: amounts.total_contract_currency,
		unit_price_invoice_currency: amounts.unit_price_invoice_currency,
		subtotal_invoice_currency: amounts.subtotal_invoice_currency,
		tax_invoice_currency: amounts.tax_amount_invoice_currency,
		total_invoice_currency: amounts.total_invoice_currency,
	};
}

/** IVA de la línea con otra tasa, sin tocar subtotales (en moneda de factura solo si la línea ya está valorizada), como `update_invoices_document`. */
export function retax(state: LineState, taxRate: number): LineState {
	const tax = round2((state.subtotal_contract_currency * taxRate) / 100);
	const taxInvoice = state.subtotal_invoice_currency === null ? null : round2((state.subtotal_invoice_currency * taxRate) / 100);

	return {
		...state,
		tax_contract_currency: tax,
		total_contract_currency: round2(state.subtotal_contract_currency + tax),
		tax_invoice_currency: taxInvoice,
		total_invoice_currency: state.subtotal_invoice_currency === null ? null : round2(state.subtotal_invoice_currency + (taxInvoice ?? 0)),
	};
}

/**
 * Multimoneda (spec-multimoneda §4): revaloriza por par los estados de línea de una Por Emitir de un contrato con `requires_multicurrency_billing`
 * con el mismo cálculo que el motor y el tipo de cambio por factura (`revalueByPair`): cada línea con la moneda de su ítem y la tasa de su par
 * (la suya si ya la tenía, la fijada por factura para el par, la fija pactada del período o NULL si es spot); encabezado = Σ líneas, FX del
 * documento = la del único par convertidor o NULL. Devuelve los estados nuevos (mismo orden) y los montos del encabezado.
 */
export function revalueStates(
	states: Array<{ id: string; state: LineState }>,
	multicurrency: PairRateContext,
	invoice: Pick<ContractInvoiceRow, 'invoice_currency' | 'issue_date'>,
	taxRate: number
): { states: LineState[]; header: Partial<HeaderState> } {
	const result = revalueByPair(
		states.map(({ id, state }) => ({
			id,
			contract_item_id: state.contract_item_id,
			currency: state.currency ?? null,
			fx: state.fx ?? null,
			fx_rate_source: state.fx_rate_source ?? null,
			unit_price: state.unit_price_contract_currency,
			subtotal: state.subtotal_contract_currency,
			tax_amount: state.tax_contract_currency,
			period_start: state.billing_period_start,
		})),
		multicurrency,
		{ invoice_currency: invoice.invoice_currency, tax_rate: taxRate, fallback_date: invoice.issue_date ?? '' }
	);
	const next = states.map(({ state }, index) => {
		const line = result.lines[index];

		return {
			...state,
			currency: line.currency,
			fx: line.fx,
			fx_rate_source: line.fx_rate_source,
			unit_price_invoice_currency: line.unit_price,
			subtotal_invoice_currency: line.subtotal,
			tax_invoice_currency: line.tax,
			total_invoice_currency: line.total,
		};
	});
	const { header } = result;
	// IVA del encabezado en moneda de contrato: Σ IVA de cada línea × tasa pactada ítem → contrato (mismo cálculo del encabezado sin valorizar).
	const taxContract = multicurrencyHeader(
		result.lines.map((line, index) => ({
			currency: line.currency,
			subtotal: states[index].state.subtotal_contract_currency,
			tax: states[index].state.tax_contract_currency,
			subtotal_invoice: null,
			tax_invoice: null,
			fx: null,
			period_start: states[index].state.billing_period_start,
		})),
		{
			contract_currency: multicurrency.contract_currency,
			invoice_currency: invoice.invoice_currency ?? multicurrency.contract_currency,
			item_rates: multicurrency.item_rates,
			fallback_date: invoice.issue_date ?? '',
		}
	).vat;

	return {
		states: next,
		header: {
			fx_contract_to_invoice: header.fx,
			amount_contract_currency: header.amount_contract_currency,
			tax_contract_currency: taxContract,
			total_contract_currency: round2(header.amount_contract_currency + taxContract),
			vat: header.vat,
			amount_invoice_currency: header.amount_invoice_currency,
			total_invoice_currency: header.total_invoice_currency,
			tax_invoice_currency:
				header.amount_invoice_currency === null || header.total_invoice_currency === null
					? null
					: round2(header.total_invoice_currency - header.amount_invoice_currency),
		},
	};
}

/** Estado guardado de una línea. */
export function stateOf(row: EditLineRow): LineState {
	return {
		contract_item_id: row.contract_item_id,
		product_id: row.product_id,
		product_name: row.product_name,
		account: row.account,
		description: row.description ?? '',
		description_locked: row.description_locked,
		quantity: row.quantity,
		unit_of_measure: row.unit_of_measure,
		discount_pct: row.discount_pct,
		unit_price_contract_currency: row.unit_price,
		subtotal_contract_currency: row.subtotal,
		tax_contract_currency: row.tax_amount,
		total_contract_currency: row.total,
		unit_price_invoice_currency: row.unit_price_invoice,
		subtotal_invoice_currency: row.subtotal_invoice,
		tax_invoice_currency: row.tax_amount_invoice,
		total_invoice_currency: row.total_invoice,
		billing_period_start: row.billing_period_start,
		billing_period_end: row.billing_period_end,
		quantity_source: row.quantity_source,
		pricing_breakdown: row.pricing_breakdown,
		is_visible: isVisibleLine(row.quantity, row.visible_line_id),
		...(row.currency === undefined ? {} : { currency: row.currency, fx: row.fx ?? null, fx_rate_source: row.fx_rate_source ?? null }),
	};
}

/** Línea guardada con el estado nuevo (para encadenar planes sobre las mismas filas). */
const rowFromState = (id: string, state: LineState): EditLineRow => ({
	id,
	contract_item_id: state.contract_item_id,
	product_id: state.product_id,
	product_name: state.product_name,
	account: state.account,
	description: state.description,
	description_locked: state.description_locked,
	quantity: state.quantity,
	unit_of_measure: state.unit_of_measure,
	discount_pct: state.discount_pct,
	unit_price: state.unit_price_contract_currency,
	subtotal: state.subtotal_contract_currency,
	tax_amount: state.tax_contract_currency,
	total: state.total_contract_currency,
	unit_price_invoice: state.unit_price_invoice_currency,
	subtotal_invoice: state.subtotal_invoice_currency,
	tax_amount_invoice: state.tax_invoice_currency,
	total_invoice: state.total_invoice_currency,
	billing_period_start: state.billing_period_start,
	billing_period_end: state.billing_period_end,
	quantity_source: state.quantity_source,
	pricing_breakdown: state.pricing_breakdown,
	...(state.currency === undefined ? {} : { currency: state.currency, fx: state.fx ?? null, fx_rate_source: state.fx_rate_source ?? null }),
});

/** Contexto de render de la glosa (plantilla del contrato) para una línea en su estado nuevo. */
export interface RenderInput {
	template: DescriptionTemplate | null;
	contract_number: string | null;
	client_name: string | null;
	references: DescriptionReference[];
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_rate: number | null;
	/** Límite de caracteres del documento (`description_max_chars`); la glosa generada se ajusta a él (`fitDescription`). null/ausente = sin límite. */
	max_chars?: number | null;
}

/** Glosa generada de la línea con la plantilla del contrato, ajustada al límite del documento (decisión 30-09: se corrige en el origen). */
export function renderLine(state: LineState, render: RenderInput, kind?: DescriptionContext['line_kind']): string {
	const perTier = isPerTierBreakdown(state.pricing_breakdown);
	const lineKind = kind ?? (perTier ? 'per_tier' : withoutOneOff(state.pricing_breakdown)?.length ? 'single' : 'standard');
	const source = state.quantity_source;

	return fitDescription(
		render.template,
		{
			line_kind: lineKind,
			product_name: state.product_name?.trim() || 'Producto',
			account: state.account,
			period_start: state.billing_period_start,
			period_end: state.billing_period_end,
			tier_label: lineKind === 'per_tier' ? tierLabelFromBreakdown(state.pricing_breakdown) : null,
			breakdown: lineKind === 'single' ? state.pricing_breakdown : null,
			quantity: state.quantity,
			unit: state.unit_of_measure,
			quantity_final: source !== 'pending' && source !== 'estimated',
			unit_price: state.unit_price_contract_currency,
			amount: state.subtotal_contract_currency,
			// Multimoneda: el bloque de tipo de cambio de la glosa toma el par y la tasa DE LA LÍNEA (spec-multimoneda §4 "Glosa"), como el motor.
			contract_currency: state.currency === undefined ? render.contract_currency : (state.currency ?? render.contract_currency),
			invoice_currency: render.invoice_currency,
			fx_rate: state.fx === undefined ? render.fx_rate : state.fx,
			contract_number: render.contract_number,
			references: render.references,
			client_name: render.client_name,
		},
		render.max_chars ?? null
	).text;
}

// ------------------------------------------------------------------ presentación por tramo ↔ una fila

const stripDecoration = (subline: PricedSubline): PricedSubline => {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- se descartan las marcas de fila por tramo
	const { period_quantity: _q, line_index: _i, line_count: _c, ...rest } = subline;

	return rest;
};

const lineIndexOf = (row: Pick<EditLineRow, 'pricing_breakdown'>) => {
	const own = (row.pricing_breakdown ?? []).find((subline) => subline.line_index !== undefined && subline.line_index !== null);

	return own?.line_index ?? 0;
};

export interface RecomposeResult {
	updates: Array<{ id: string; after: LineState }>;
	creates: LineState[];
	removes: string[];
	periods: string[];
	skipped: Array<{ period_start: string; reason: string }>;
}

/**
 * Pasa las filas de UN ítem en UNA factura entre "una fila por tramo" y "una sola fila", por período, recomponiendo desde
 * `period_quantity` + desglose **sin cambiar el total del ítem** (Σ subtotales e IVA iguales). Glosas re-renderizadas con la plantilla
 * del contrato; una glosa protegida (`description_locked`) se conserva en la primera fila. Se saltan los períodos con líneas manuales
 * (salvo `confirm_manual_overwrite`, y solo si conservan desglose) y los que no tienen desglose de precio.
 */
export function recomposeItemRows(
	rows: EditLineRow[],
	mode: InvoiceLineMode,
	options: { tax_rate: number; fx: number | null; render: RenderInput; confirm_manual_overwrite?: boolean }
): RecomposeResult {
	const result: RecomposeResult = { updates: [], creates: [], removes: [], periods: [], skipped: [] };
	const byPeriod = new Map<string, EditLineRow[]>();

	for (const row of rows) {
		const key = row.billing_period_start ?? '';

		byPeriod.set(key, [...(byPeriod.get(key) ?? []), row]);
	}
	for (const [period, group] of [...byPeriod.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const sorted = [...group].sort((a, b) => lineIndexOf(a) - lineIndexOf(b) || a.id.localeCompare(b.id));
		const manual = sorted.filter((row) => row.quantity_source === MANUAL_QUANTITY_SOURCE);

		if (sorted.some((row) => !discountEmbedded(row))) {
			result.skipped.push({ period_start: period, reason: 'no_pricing_breakdown' });
			continue;
		}
		if (sorted.some((row) => oneOffOf(row.pricing_breakdown))) {
			result.skipped.push({ period_start: period, reason: 'one_off_discount' });
			continue;
		}
		if (manual.length && !options.confirm_manual_overwrite) {
			result.skipped.push({ period_start: period, reason: MANUAL_EDIT_KEPT });
			continue;
		}
		const perTier = sorted.some((row) => isPerTierBreakdown(row.pricing_breakdown));

		if ((mode === 'per_tier') === perTier && (perTier || sorted.length === 1)) continue;
		const first = sorted[0];
		const locked = sorted.find((row) => row.description_locked) ?? null;
		const base: Omit<
			LineState,
			| 'quantity'
			| 'unit_price_contract_currency'
			| 'subtotal_contract_currency'
			| 'tax_contract_currency'
			| 'total_contract_currency'
			| 'unit_price_invoice_currency'
			| 'subtotal_invoice_currency'
			| 'tax_invoice_currency'
			| 'total_invoice_currency'
			| 'description'
			| 'description_locked'
			| 'pricing_breakdown'
			| 'is_visible'
		> = {
			contract_item_id: first.contract_item_id,
			product_id: first.product_id,
			product_name: first.product_name,
			account: first.account,
			unit_of_measure: first.unit_of_measure,
			discount_pct: first.discount_pct,
			billing_period_start: first.billing_period_start,
			billing_period_end: first.billing_period_end,
			quantity_source: first.quantity_source,
		};
		const subtotal = round2(sorted.reduce((sum, row) => sum + row.subtotal, 0));
		const tax = round2(sorted.reduce((sum, row) => sum + row.tax_amount, 0));

		if (mode === 'single') {
			const breakdown = sorted.flatMap((row) => (row.pricing_breakdown ?? []).map(stripDecoration));
			const quantity =
				(first.pricing_breakdown ?? []).find((subline) => subline.period_quantity !== undefined && subline.period_quantity !== null)
					?.period_quantity ?? sorted.reduce((sum, row) => sum + row.quantity, 0);
			const unit = quantity > 0 ? round6(subtotal / quantity) : 0;
			const state: LineState = {
				...base,
				...amountsOf(quantity, unit, subtotal, options.tax_rate, options.fx, tax),
				description: '',
				description_locked: false,
				pricing_breakdown: breakdown,
				is_visible: isVisibleLine(quantity),
			};

			state.description = locked ? (locked.description ?? '') : renderLine(state, options.render, 'single');
			state.description_locked = !!locked;
			result.updates.push({ id: first.id, after: state });
			result.removes.push(...sorted.slice(1).map((row) => row.id));
			result.periods.push(period);
			continue;
		}
		// single → per_tier: una fila por tramo/paquete/asiento y una por ajuste, IVA repartido con el residuo en la última de cargo.
		const priced: PricedLine = {
			quantity: first.quantity,
			quantity_source: 'fixed',
			billable_quantity: first.quantity,
			subtotal,
			effective_unit_price: first.unit_price,
			breakdown: (first.pricing_breakdown ?? []).map(stripDecoration),
			warnings: [],
		};
		const parts = splitInvoiceLines(priced);
		const taxes = distributeTax(
			parts.map((part) => part.subtotal),
			options.tax_rate,
			parts.map((part) => part.part === 'charge')
		);

		parts.forEach((part, index) => {
			const state: LineState = {
				...base,
				...amountsOf(part.quantity, part.unit_price, part.subtotal, options.tax_rate, options.fx, taxes[index]),
				description: '',
				description_locked: false,
				pricing_breakdown: part.breakdown,
				is_visible: isVisibleLine(part.quantity),
			};

			state.description = index === 0 && locked ? (locked.description ?? '') : renderLine(state, options.render, 'per_tier');
			state.description_locked = index === 0 && !!locked;
			if (index === 0) result.updates.push({ id: first.id, after: state });
			else result.creates.push(state);
		});
		result.periods.push(period);
	}

	return result;
}

// ------------------------------------------------------------------ conciliador de desvíos

export const deviationKey = (itemId: string, periodStart: string) => `${itemId}|${periodStart}`;

/**
 * Conciliador (spec §3.4, reemplaza el validador "no empeorar"): por ítem y período compara las LÍNEAS de la factura contra lo que el
 * plan espera (motor con los ítems vigentes y los consumos) menos lo que ya llevan otras facturas vigentes del contrato. Nunca bloquea:
 * informa `has_deviation`, `by_item`, si ya se desviaba antes (`inherited`) y si esta edición lo introduce o cambia (`changed`).
 */
export function reconcileDeviation(
	plan: DeviationPlan,
	before: Array<Pick<LineState, 'contract_item_id' | 'billing_period_start' | 'billing_period_end' | 'subtotal_contract_currency'>>,
	after: Array<Pick<LineState, 'contract_item_id' | 'billing_period_start' | 'billing_period_end' | 'subtotal_contract_currency'>>,
	currency: string | null = null
): DeviationView {
	const keys = new Map<string, { item: string; start: string; end: string | null }>();
	const sum = (lines: typeof before) => {
		const totals = new Map<string, number>();

		for (const line of lines) {
			if (!line.contract_item_id || !line.billing_period_start || !plan.known_items.has(line.contract_item_id)) continue;
			const key = deviationKey(line.contract_item_id, line.billing_period_start);

			if (!keys.has(key)) keys.set(key, { item: line.contract_item_id, start: line.billing_period_start, end: line.billing_period_end });
			totals.set(key, (totals.get(key) ?? 0) + line.subtotal_contract_currency);
		}

		return totals;
	};
	const beforeTotals = sum(before);
	const afterTotals = sum(after);
	const byItem: DeviationByItem[] = [];
	let inherited = false;
	let changed = false;

	for (const [key, info] of [...keys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const expected = round2((plan.expected.get(key) ?? 0) - (plan.others.get(key) ?? 0));
		const actualBefore = round2(beforeTotals.get(key) ?? 0);
		const actualAfter = round2(afterTotals.get(key) ?? 0);
		const diffBefore = round2(actualBefore - expected);
		const diffAfter = round2(actualAfter - expected);

		if (Math.abs(diffBefore) >= DEVIATION_TOLERANCE && beforeTotals.has(key)) inherited = true;
		if (Math.abs(diffAfter - (beforeTotals.has(key) ? diffBefore : 0)) >= DEVIATION_TOLERANCE && Math.abs(diffAfter) >= DEVIATION_TOLERANCE)
			changed = true;
		if (!afterTotals.has(key) || Math.abs(diffAfter) < DEVIATION_TOLERANCE) continue;
		byItem.push({
			contract_item_id: info.item,
			product_name: plan.product_names.get(info.item) ?? null,
			period_start: info.start,
			period_end: info.end,
			expected,
			actual: actualAfter,
			diff: diffAfter,
		});
	}

	return {
		has_deviation: byItem.length > 0,
		total_diff: round2(byItem.reduce((total, row) => total + row.diff, 0)),
		by_item: byItem,
		inherited,
		changed,
		currency,
	};
}

// ------------------------------------------------------------------ encabezado

export function headerStateOf(
	invoice: EditInvoiceRow,
	lines: Array<Pick<LineState, 'subtotal_contract_currency' | 'tax_contract_currency'>>,
	overrides: Partial<HeaderState> = {}
): HeaderState {
	const tax = round2(lines.reduce((sum, line) => sum + line.tax_contract_currency, 0));
	const amount = invoice.amount_contract_currency;

	return {
		status: invoice.status,
		issue_date: invoice.issue_date,
		scheduled_at: invoice.scheduled_at,
		original_issue_date: invoice.original_issue_date,
		due_date: invoice.due_date,
		client_entity_id: invoice.client_entity_id,
		client_tax_id: invoice.client_tax_id,
		legal_name: invoice.legal_name,
		document_type: invoice.document_type,
		export_type: invoice.export_type,
		tax_rate: invoice.tax_rate,
		invoice_terms_and_conditions: invoice.invoice_terms_and_conditions,
		notes: invoice.notes,
		auto_invoice: invoice.auto_invoice,
		nc_revenue_treatment: invoice.nc_revenue_treatment,
		contract_currency: invoice.contract_currency,
		invoice_currency: invoice.invoice_currency,
		fx_contract_to_invoice: invoice.fx_contract_to_invoice,
		amount_contract_currency: amount,
		tax_contract_currency: tax,
		total_contract_currency: round2(amount + tax),
		vat: invoice.vat,
		amount_invoice_currency: invoice.amount_invoice_currency,
		tax_invoice_currency:
			invoice.total_invoice_currency === null || invoice.amount_invoice_currency === null
				? null
				: round2(invoice.total_invoice_currency - invoice.amount_invoice_currency),
		total_invoice_currency: invoice.total_invoice_currency,
		...overrides,
	};
}

interface HeaderPlan {
	after: Partial<HeaderState>;
	tax_rate: number;
	warnings: InvoiceWarning[];
	blockers: InvoiceBlocker[];
	errors: FieldError[];
	changed: boolean;
}

/** Fechas, receptor (re-deriva RUT, IVA y exportación; aviso de documento) y condiciones. No cambia el tipo de documento. */
function planHeader(
	ctx: Pick<EditContext, 'invoice' | 'context' | 'company_tax_rate' | 'receiver'>,
	input: Omit<InvoiceEditInput, 'lines' | 'line_mode'>
): HeaderPlan {
	const { invoice, context } = ctx;
	const warnings: InvoiceWarning[] = [];
	const blockers: InvoiceBlocker[] = [];
	const errors: FieldError[] = [];
	const after: Partial<HeaderState> = {};
	const storedTax = normalizeTaxRate(invoice.tax_rate) ?? 0;
	let taxRate = storedTax;

	if (input.issue_date && input.issue_date !== invoice.issue_date) {
		after.issue_date = input.issue_date;
		after.scheduled_at = input.issue_date;
		// La fecha original se conserva (se fija la primera vez que se mueve).
		after.original_issue_date = invoice.original_issue_date ?? invoice.issue_date ?? input.issue_date;
		after.due_date = input.due_date ?? invoiceDueDate(input.issue_date, context);
		if (input.issue_date < context.today) {
			warnings.push({
				code: 'past_issue_date',
				message: `La nueva fecha de emisión (${input.issue_date}) ya pasó: el envío automático no la tomará; usa "Enviar al ERP ahora"`,
			});
		}
	} else if (input.due_date && input.due_date !== invoice.due_date) {
		after.due_date = input.due_date;
	}
	const issue = after.issue_date ?? invoice.issue_date;
	const due = after.due_date ?? invoice.due_date;

	if (issue && due && due < issue) {
		blockers.push({
			code: 'due_before_issue',
			message: `${EDIT_BLOCKER_MESSAGES.due_before_issue} (vence ${due}, se emite ${issue})`,
			next_step: 'Corrige la fecha de vencimiento o deja que se calcule por la condición de pago',
		});
	}
	if (input.client_entity_id && input.client_entity_id !== invoice.client_entity_id) {
		const receiver = ctx.receiver;

		if (!receiver) errors.push({ field: 'client_entity_id', message: 'La razón social no existe en el holding' });
		else if (!receiver.belongs_to_client)
			errors.push({ field: 'client_entity_id', message: 'La razón social no pertenece al cliente comercial del contrato' });
		else {
			// Mismo criterio que la activación y `change_entity`: el IVA sale del tipo de documento (que aquí NO cambia: vive en Condiciones de
			// facturación); RUT del receptor nuevo; aviso si el receptor es de otro país que la compañía emisora.
			taxRate = taxRateForDocument(invoice.document_type, context.company_country, ctx.company_tax_rate);
			after.client_entity_id = receiver.id;
			after.client_tax_id = receiver.tax_id;
			after.legal_name = receiver.legal_name;
			after.export_type = invoice.document_type === 'FACTURA_EXPORTACION' ? 1 : 0;
			const entityCountry = normalizeCountry(receiver.country);
			const companyCountry = normalizeCountry(context.company_country);

			if (entityCountry && companyCountry && entityCountry !== companyCountry) {
				warnings.push({
					code: 'document_type_review',
					message: `El receptor nuevo es de ${receiver.country} y la compañía emisora de ${context.company_country}: revisa el tipo de documento (${
						invoice.document_type ?? 'sin tipo'
					}); se cambia en Condiciones de facturación del contrato`,
				});
			}
		}
	}
	if (taxRate !== storedTax || (invoice.tax_rate !== null && invoice.tax_rate !== storedTax)) {
		after.tax_rate = taxRate;
		if (invoice.tax_rate !== null && invoice.tax_rate !== storedTax && taxRate === storedTax) {
			warnings.push({
				code: 'tax_rate_normalized',
				message: `La tasa de IVA guardada (${invoice.tax_rate}) se normaliza a ${storedTax} % y se recalcula el IVA de las líneas`,
			});
		}
	}
	if (input.invoice_terms_and_conditions !== undefined && (input.invoice_terms_and_conditions ?? null) !== invoice.invoice_terms_and_conditions)
		after.invoice_terms_and_conditions = input.invoice_terms_and_conditions ?? null;
	if (input.notes !== undefined && (input.notes ?? null) !== invoice.notes) after.notes = input.notes ?? null;
	if (input.auto_invoice !== undefined && input.auto_invoice !== null && input.auto_invoice !== invoice.auto_invoice)
		after.auto_invoice = input.auto_invoice;

	return { after, tax_rate: taxRate, warnings, blockers, errors, changed: Object.keys(after).length > 0 };
}

// ------------------------------------------------------------------ plan completo

const itemIsCurrent = (item: EditItem, start: string, end: string) =>
	(!item.start_date || item.start_date <= end) && (!item.end_date || item.end_date >= start) && (!item.churn_date || item.churn_date > start);

const overlaps = (a: { start: string; end: string }, b: { start: string; end: string }) => a.start <= b.end && b.start <= a.end;

/**
 * Plan de la edición de una Por Emitir (preview y aplicar comparten el cálculo). Errores de forma → `errors` (400); invariantes →
 * `blockers` (409); diferencias contra el plan → `deviation` (nunca bloquean aquí; aplicar exige motivo si la edición las introduce).
 */
export function planInvoiceEdit(ctx: EditContext, input: InvoiceEditInput): EditPlan {
	const { invoice, context } = ctx;
	const errors: FieldError[] = [];
	// Una factura "sin cobro" (Cancelada por INVOICE_NO_CHARGE) se puede editar para devolverle cantidad: no cuenta como no Por Emitir.
	const blockers: InvoiceBlocker[] = commonBlockers(invoice).filter((blocker) => !(invoice.no_charge && blocker.code === 'not_pending'));
	const warnings: InvoiceWarning[] = [];
	const draft = erpDraftBlocker(invoice);
	const fx = invoiceFx(invoice);
	const header = planHeader(ctx, input);
	const taxRate = header.tax_rate;
	const render: RenderInput = {
		template: ctx.template,
		contract_number: ctx.contract_number,
		client_name: header.after.legal_name ?? ctx.client_name,
		references: ctx.references,
		contract_currency: invoice.contract_currency,
		invoice_currency: invoice.invoice_currency,
		fx_rate: isMultiCurrency(invoice) ? invoice.fx_contract_to_invoice : null,
		max_chars: ctx.max_chars,
	};
	const warn = (code: string, message: string) => {
		if (!warnings.some((warning) => warning.code === code && warning.message === message)) warnings.push({ code, message });
	};
	const block = (code: string, message: string, nextStep: string | null = null) => {
		if (!blockers.some((blocker) => blocker.code === code && blocker.message === message)) blockers.push({ code, message, next_step: nextStep });
	};

	if (draft) blockers.push(draft);
	const internalLines = ctx.lines.filter((row) => row.visible_line_id).length;
	const partial = partialBillingBlocker({ ...invoice, internal_lines: internalLines || invoice.internal_lines });

	// Solo si toca líneas o el IVA (receptor o normalización de la tasa reescriben el IVA de la visible y de las internas): fechas, glosa de
	// encabezado y condiciones siguen editables en una factura por OC.
	if (
		partial &&
		((input.lines ?? []).length > 0 || (input.line_mode ?? []).length > 0 || !!input.client_entity_id || header.after.tax_rate !== undefined)
	)
		blockers.push(partial);
	blockers.push(...header.blockers);
	errors.push(...header.errors);
	warnings.push(...header.warnings);

	const rows = new Map(ctx.lines.map((row) => [row.id, row]));
	const current = new Map(ctx.lines.map((row) => [row.id, stateOf(row)]));
	const plans = new Map<string, LinePlan>();
	const creates: Array<{ state: LineState; input_index?: number }> = [];
	const removes = new Set<string>();
	const touchedAmounts = new Set<string>();
	/** Líneas cuyo descuento puntual se agrega, cambia o se quita (`new:N` para las nuevas). */
	const oneOffTouched = new Set<string>();
	const bodyLines = input.lines ?? [];
	const seen = new Set<string>();

	// ---- validación de forma (400)
	bodyLines.forEach((line, index) => {
		const field = (name: string) => `lines.${index}.${name}`;

		if (line.billing_period_end < line.billing_period_start)
			errors.push({ field: field('billing_period_end'), message: 'El fin del período no puede ser anterior al inicio' });
		if (line.discount_pct !== undefined && line.discount_pct !== null && (line.discount_pct < 0 || line.discount_pct > 100))
			errors.push({ field: field('discount_pct'), message: 'El descuento debe estar entre 0 y 100' });
		if (line.amount_basis === 'exact_total' && (line.exact_total === undefined || line.exact_total === null))
			errors.push({ field: field('exact_total'), message: 'Indica el subtotal exacto de la línea' });
		if (line.id) {
			if (seen.has(line.id)) errors.push({ field: field('id'), message: 'La línea viene repetida' });
			seen.add(line.id);
			const row = rows.get(line.id);

			if (!row) errors.push({ field: field('id'), message: 'La línea no pertenece a esta factura' });
			else if (row.contract_item_id && row.contract_item_id !== line.contract_item_id)
				errors.push({ field: field('contract_item_id'), message: 'Una línea existente no cambia de ítem: crea una línea nueva' });
		}
	});
	const lineModes = input.line_mode ?? [];
	const editedItems = new Set(bodyLines.filter((line) => line.id).map((line) => line.contract_item_id));

	lineModes.forEach((request, index) => {
		const item = ctx.items.get(request.contract_item_id);

		if (!item) errors.push({ field: `line_mode.${index}.contract_item_id`, message: 'El ítem no pertenece al contrato' });
		else if (!item.price)
			errors.push({
				field: `line_mode.${index}.contract_item_id`,
				message: 'El ítem no tiene modelo de precio: no tiene presentación por tramo',
			});
		else if (editedItems.has(request.contract_item_id))
			errors.push({
				field: `line_mode.${index}.contract_item_id`,
				message: 'Cambia la presentación del ítem en una edición aparte de sus líneas',
			});
	});

	// ---- presentación por tramo (sobre filas no editadas en esta misma petición)
	const lineModePlans: LineModePlan[] = [];
	const priceLineModes: EditPlan['price_line_modes'] = [];

	for (const request of lineModes) {
		const item = ctx.items.get(request.contract_item_id);

		if (!item?.price || editedItems.has(request.contract_item_id)) continue;
		const scope = request.scope ?? 'invoice';
		const itemRows = ctx.lines.filter((row) => row.contract_item_id === request.contract_item_id);
		const result = recomposeItemRows(itemRows, request.mode, {
			tax_rate: taxRate,
			fx,
			render,
			confirm_manual_overwrite: input.confirm_manual_overwrite === true,
		});

		for (const update of result.updates) current.set(update.id, update.after);
		for (const id of result.removes) removes.add(id);
		for (const state of result.creates) creates.push({ state });
		for (const skipped of result.skipped) {
			if (skipped.reason === MANUAL_EDIT_KEPT)
				warn(
					MANUAL_EDIT_KEPT,
					`"${item.product_name ?? 'Ítem'}" (${skipped.period_start}) tiene líneas editadas a mano: no se recompone (confirma con confirm_manual_overwrite)`
				);
			else
				warn(
					'line_mode_not_applicable',
					`"${item.product_name ?? 'Ítem'}" (${skipped.period_start}) no tiene desglose de precio que recomponer`
				);
		}
		if (scope === 'invoice_and_following') {
			if (item.price_id && item.price_owner === 'contract')
				priceLineModes.push({ contract_item_id: item.id, price_id: item.price_id, mode: request.mode });
			else warn('price_not_contract_copy', `"${item.product_name ?? 'Ítem'}" no tiene copia de precio del contrato: solo cambian las facturas`);
		}
		lineModePlans.push({ contract_item_id: item.id, mode: request.mode, scope, periods: result.periods, skipped: result.skipped });
	}

	// ---- líneas del cuerpo
	const checkOverlap = (line: EditLineInput, index: number) => {
		const clash = ctx.issued_periods.find(
			(period) =>
				period.contract_item_id === line.contract_item_id &&
				overlaps(
					{ start: line.billing_period_start, end: line.billing_period_end },
					{ start: period.billing_period_start, end: period.billing_period_end }
				)
		);

		if (clash)
			block(
				'overlaps_issued',
				`${EDIT_BLOCKER_MESSAGES.overlaps_issued} (línea ${index + 1}: ${line.billing_period_start} a ${line.billing_period_end}; factura ${
					clash.invoice_number ?? clash.invoice_id
				}, ${clash.billing_period_start} a ${clash.billing_period_end})`,
				'Ajusta el período o corrige la emitida con una nota de crédito en Facturación'
			);
	};

	/**
	 * Descuento puntual sobre el estado base de la línea (spec §3.4): subtotal − X, `discount_pct` = porcentaje efectivo combinado respecto de
	 * cantidad × unitario (sin líneas negativas) y la sublínea `{ kind: discount, one_off: true, amount: -X }` al final del desglose. Devuelve
	 * null (y deja el error) si X supera el subtotal.
	 */
	const applyOneOff = (base: LineState, request: OneOffDiscountInput, label: string | null, index: number): LineState | null => {
		const amount = oneOffAmount(request, base.subtotal_contract_currency);

		if (amount > base.subtotal_contract_currency + 0.001) {
			errors.push({
				field: `lines.${index}.one_off_discount.value`,
				message: `El descuento puntual (${amount}) supera el subtotal de la línea (${base.subtotal_contract_currency})`,
			});

			return null;
		}
		const subtotal = round2(base.subtotal_contract_currency - amount);
		const gross = base.quantity * base.unit_price_contract_currency;
		const combined = gross > 0 ? round2(Math.min(100, Math.max(0, (1 - subtotal / gross) * 100))) : base.discount_pct;

		return {
			...base,
			...amountsOf(base.quantity, base.unit_price_contract_currency, subtotal, taxRate, fx),
			discount_pct: combined,
			pricing_breakdown: [...(withoutOneOff(base.pricing_breakdown) ?? []), oneOffSubline(amount, label, request, base.discount_pct)],
		};
	};
	const reasonLabel = input.deviation?.reason?.trim() || null;

	bodyLines.forEach((line, index) => {
		const field = (name: string) => `lines.${index}.${name}`;
		const item = ctx.items.get(line.contract_item_id) ?? null;
		const basis = line.amount_basis ?? 'unit_rate';

		if (line.quantity < 0) {
			block('quantity_negative', `${EDIT_BLOCKER_MESSAGES.quantity_negative} (línea ${index + 1}: ${line.quantity})`);

			return;
		}
		if (line.one_off_discount && !(line.one_off_discount.value > 0)) {
			errors.push({ field: field('one_off_discount.value'), message: 'El descuento puntual debe ser mayor que 0 (null lo quita)' });

			return;
		}
		if (line.id) {
			const row = rows.get(line.id);

			if (!row) return;
			const before = stateOf(row);
			// Estado base: la línea sin su descuento puntual (re-editar reemplaza el puntual, nunca lo apila).
			const one = oneOffOf(row.pricing_breakdown);
			const base: EditLineRow = one
				? {
						...row,
						subtotal: round2(row.subtotal - one.total),
						discount_pct: one.base_discount_pct ?? row.discount_pct,
						pricing_breakdown: withoutOneOff(row.pricing_breakdown),
					}
				: row;
			// Si el cuerpo devuelve el % combinado guardado, cuenta como el descuento base (sin cambio).
			const bodyDiscount =
				one && line.discount_pct !== undefined && line.discount_pct !== null && same(line.discount_pct, row.discount_pct)
					? base.discount_pct
					: line.discount_pct;
			const embedded = discountEmbedded(base);
			const additional = bodyDiscount === undefined || bodyDiscount === null || same(bodyDiscount, base.discount_pct) ? 0 : bodyDiscount;
			const discount = embedded ? additional : (bodyDiscount ?? base.discount_pct);
			const quantityChanged = !same(line.quantity, base.quantity);
			const priceChanged = !same(line.unit_price, base.unit_price, 1e-6);
			const discountChanged = embedded ? additional !== 0 : !same(discount, base.discount_pct);
			const periodChanged = line.billing_period_start !== row.billing_period_start || line.billing_period_end !== row.billing_period_end;
			const exactChanged = basis === 'exact_total' && !same(round2(Number(line.exact_total ?? 0)), base.subtotal, 0.001);
			const numericChanged = quantityChanged || priceChanged || discountChanged || exactChanged;
			const description = line.description === undefined || line.description === null ? null : manualDescription(line.description);
			const descriptionChanged = description !== null && description !== (row.description ?? '');
			const requested: OneOffDiscountInput | null =
				line.one_off_discount === undefined
					? one
						? { type: one.one_off_type ?? 'amount', value: one.one_off_value ?? -one.total }
						: null
					: line.one_off_discount;
			const oneOffChanged =
				line.one_off_discount !== undefined &&
				(requested === null
					? !!one
					: !one || (one.one_off_type ?? 'amount') !== requested.type || !same(one.one_off_value ?? -one.total, requested.value, 1e-6));

			if (!numericChanged && !periodChanged && !descriptionChanged && !oneOffChanged) {
				plans.set(row.id, { id: row.id, action: 'unchanged', before, after: before, is_visible: before.is_visible, input_index: index });

				return;
			}
			if (descriptionChanged && exceedsMax(description!.length, ctx.max_chars))
				errors.push({
					field: field('description'),
					message: `La descripción tiene ${description!.length} caracteres y el documento admite ${ctx.max_chars}`,
				});
			if (!item) {
				block('item_not_in_contract', `${EDIT_BLOCKER_MESSAGES.item_not_in_contract} (línea ${index + 1})`);

				return;
			}
			if (isMetered(item.price) && quantityChanged) {
				block(
					'metered_line_use_consumption',
					`${EDIT_BLOCKER_MESSAGES.metered_line_use_consumption} ("${item.product_name ?? 'Ítem'}", ${row.billing_period_start ?? ''})`,
					'Registra el consumo del período en Consumos: recalcula esta factura'
				);

				return;
			}
			if (periodChanged) {
				if (!itemIsCurrent(item, line.billing_period_start, line.billing_period_end))
					block(
						'item_not_in_contract',
						`${EDIT_BLOCKER_MESSAGES.item_not_in_contract}: el período ${line.billing_period_start} a ${line.billing_period_end} queda fuera de la vigencia del ítem`
					);
				checkOverlap(line, index);
			}
			if (row.quantity_source === MANUAL_QUANTITY_SOURCE && (numericChanged || periodChanged || oneOffChanged))
				warn('manual_edit_overwritten', `La línea "${row.description ?? row.id}" ya estaba editada a mano: se reemplaza esa edición`);
			let after: LineState = { ...(current.get(row.id) ?? before) };
			const amountsTouched = numericChanged || periodChanged || oneOffChanged;

			if (amountsTouched) {
				after.billing_period_start = line.billing_period_start;
				after.billing_period_end = line.billing_period_end;
				const reproducible =
					numericChanged &&
					embedded &&
					!isPerTierBreakdown(base.pricing_breakdown) &&
					item.price &&
					!isMetered(item.price) &&
					quantityChanged &&
					!priceChanged &&
					!discountChanged &&
					basis === 'unit_rate' &&
					line.quantity > 0 &&
					Math.abs(priceLine(item.price, base.quantity, base.discount_pct).subtotal - base.subtotal) < DEVIATION_TOLERANCE;

				if (!numericChanged) {
					// Solo cambia el descuento puntual (o el período): se parte del estado base guardado.
					after = {
						...after,
						...amountsOf(base.quantity, base.unit_price, base.subtotal, taxRate, fx),
						discount_pct: base.discount_pct,
						pricing_breakdown: base.pricing_breakdown,
					};
				} else if (reproducible) {
					// Línea con modelo de precio (no medida) y solo cambió la cantidad: la tarifa el motor (tramos, mínimo, tope) y el desglose
					// queda coherente. El descuento del ítem sigue dentro del unitario efectivo.
					const priced = priceLine(item.price!, line.quantity, base.discount_pct);

					after = {
						...after,
						...amountsOf(priced.quantity, priced.effective_unit_price, priced.subtotal, taxRate, fx),
						discount_pct: base.discount_pct,
						pricing_breakdown: priced.breakdown,
					};
				} else {
					const amounts = manualLineAmounts(line.quantity, line.unit_price, discount, basis, line.exact_total);

					if (!amounts) {
						errors.push({
							field: field('exact_total'),
							message: 'No se puede derivar el unitario: la cantidad es 0 o el descuento es 100 %',
						});

						return;
					}
					if (embedded && line.quantity !== 0)
						warn(
							'pricing_breakdown_dropped',
							`La línea "${row.description ?? row.id}" tenía modelo de precio: queda con monto manual y sin desglose por tramo`
						);
					after = {
						...after,
						...amountsOf(line.quantity, amounts.unit_price, line.quantity === 0 ? 0 : amounts.subtotal, taxRate, fx),
						discount_pct: round2(discount),
						pricing_breakdown: null,
					};
				}
				if (requested && after.quantity > 0) {
					const label = oneOffChanged ? reasonLabel : (one?.label?.replace(/^[^:]*:\s*/, '') ?? reasonLabel);
					const discounted = applyOneOff(after, requested, label, index);

					if (!discounted) return;
					after = discounted;
				}
				after.quantity_source = MANUAL_QUANTITY_SOURCE;
				after.is_visible = isVisibleLine(after.quantity, row.visible_line_id);
				touchedAmounts.add(row.id);
				if (oneOffChanged || (one && after.quantity === 0)) oneOffTouched.add(row.id);
			}
			if (descriptionChanged) {
				after.description = description!;
				after.description_locked = true;
			} else if (!after.description_locked && (numericChanged || periodChanged)) {
				after.description = renderLine(after, render);
			}
			current.set(row.id, after);
			plans.set(row.id, {
				id: row.id,
				action: after.quantity === 0 && before.quantity !== 0 ? 'hide' : 'update',
				before,
				after,
				is_visible: after.is_visible,
				input_index: index,
			});

			return;
		}
		// Línea nueva: siempre ligada a un ítem vigente del contrato (sin líneas informativas).
		if (!item || !itemIsCurrent(item, line.billing_period_start, line.billing_period_end)) {
			block(
				'item_not_in_contract',
				item
					? `${EDIT_BLOCKER_MESSAGES.item_not_in_contract}: "${item.product_name ?? 'Ítem'}" no está vigente entre ${line.billing_period_start} y ${line.billing_period_end}`
					: `${EDIT_BLOCKER_MESSAGES.item_not_in_contract} (línea nueva ${index + 1})`
			);

			return;
		}
		if (isMetered(item.price)) {
			block(
				'metered_line_use_consumption',
				`${EDIT_BLOCKER_MESSAGES.metered_line_use_consumption} ("${item.product_name ?? 'Ítem'}")`,
				'Registra el consumo del período en Consumos'
			);

			return;
		}
		checkOverlap(line, index);
		const discount = line.discount_pct ?? 0;
		const amounts = manualLineAmounts(line.quantity, line.unit_price, discount, basis, line.exact_total);

		if (!amounts) {
			errors.push({ field: field('exact_total'), message: 'No se puede derivar el unitario: la cantidad es 0 o el descuento es 100 %' });

			return;
		}
		const description = line.description === undefined || line.description === null ? null : manualDescription(line.description);

		if (description !== null && exceedsMax(description.length, ctx.max_chars))
			errors.push({
				field: field('description'),
				message: `La descripción tiene ${description.length} caracteres y el documento admite ${ctx.max_chars}`,
			});
		let state: LineState = {
			contract_item_id: item.id,
			product_id: item.product_id,
			product_name: item.product_name,
			account: item.account,
			description: description ?? '',
			description_locked: description !== null,
			unit_of_measure: item.unit_of_measure,
			discount_pct: round2(discount),
			billing_period_start: line.billing_period_start,
			billing_period_end: line.billing_period_end,
			quantity_source: MANUAL_QUANTITY_SOURCE,
			pricing_breakdown: null,
			...amountsOf(line.quantity, amounts.unit_price, line.quantity === 0 ? 0 : amounts.subtotal, taxRate, fx),
			is_visible: isVisibleLine(line.quantity),
		};

		if (description === null) state.description = renderLine(state, render, 'standard');
		if (line.one_off_discount && state.quantity > 0) {
			const discounted = applyOneOff(state, line.one_off_discount, reasonLabel, index);

			if (!discounted) return;
			state = discounted;
			oneOffTouched.add(`new:${index}`);
		}
		creates.push({ state, input_index: index });
	});

	// ---- IVA: si la tasa cambió (receptor o normalización), todas las líneas se recalculan en ambas monedas.
	const taxChanged = header.after.tax_rate !== undefined;

	for (const row of ctx.lines) {
		if (removes.has(row.id)) {
			plans.set(row.id, { id: row.id, action: 'remove', before: stateOf(row), after: null, is_visible: false });
			continue;
		}
		const state = current.get(row.id)!;
		let after = state;

		if (taxChanged) {
			after = retax(state, taxRate);
			current.set(row.id, after);
		}
		const existing = plans.get(row.id);
		const before = stateOf(row);
		const differs = JSON.stringify(after) !== JSON.stringify(before);

		if (existing && existing.action !== 'unchanged') plans.set(row.id, { ...existing, after, is_visible: after.is_visible });
		else if (differs)
			plans.set(row.id, { id: row.id, action: 'update', before, after, is_visible: after.is_visible, input_index: existing?.input_index });
		else plans.set(row.id, existing ?? { id: row.id, action: 'unchanged', before, after: before, is_visible: before.is_visible });
	}
	const createdStates = creates.map((entry) => (taxChanged ? { ...entry, state: retax(entry.state, taxRate) } : entry));
	// ---- multimoneda (spec-multimoneda §4): cada línea con la tasa de SU par (nunca la del encabezado), glosa con la tasa de la línea y
	// encabezado = Σ líneas. Solo en contratos con `requires_multicurrency_billing`; en los demás no corre (valorización de siempre).
	let pairHeader: Partial<HeaderState> | null = null;
	let multicurrencyChanged = false;

	if (ctx.multicurrency) {
		const live = ctx.lines.filter((row) => !removes.has(row.id));
		const entries = [
			...live.map((row) => ({ id: row.id, state: current.get(row.id)! })),
			...createdStates.map((entry, index) => ({ id: `new:${index}`, state: entry.state })),
		];
		const revalued = revalueStates(entries, ctx.multicurrency, invoice, taxRate);

		revalued.states.forEach((valued, index) => {
			const entry = entries[index];
			const row = index < live.length ? live[index] : null;
			const before = row ? stateOf(row) : null;
			// La glosa que esta edición generó se vuelve a generar con la moneda y la tasa de la línea (las fijadas a mano no se tocan).
			const rendered = !valued.description_locked && (!before || entry.state.description !== before.description);
			const state = rendered ? { ...valued, description: renderLine(valued, render) } : valued;

			if (JSON.stringify(state) !== JSON.stringify(entry.state)) multicurrencyChanged = true;
			if (!row) {
				const created = index - live.length;

				createdStates[created] = { ...createdStates[created], state };

				return;
			}
			current.set(row.id, state);
			const existing = plans.get(row.id)!;

			if (existing.action !== 'unchanged') plans.set(row.id, { ...existing, after: state, is_visible: state.is_visible });
			else if (JSON.stringify(state) !== JSON.stringify(before))
				plans.set(row.id, {
					id: row.id,
					action: 'update',
					before,
					after: state,
					is_visible: state.is_visible,
					input_index: existing.input_index,
				});
		});
		pairHeader = revalued.header;
	}
	const afterLines = [
		...ctx.lines.filter((row) => !removes.has(row.id)).map((row) => current.get(row.id)!),
		...createdStates.map((entry) => entry.state),
	];

	// ---- sin cobro (reemplaza el antiguo bloqueo `empty_invoice`): si TODAS las líneas quedan en 0 (cantidad y monto), la Por Emitir pasa a
	// Cancelada con INVOICE_NO_CHARGE (las líneas quedan, para poder reactivarla); una sin cobro que recupera cantidad vuelve a Por Emitir.
	const allZero = afterLines.length > 0 && afterLines.every((line) => line.quantity === 0 && line.subtotal_contract_currency === 0);
	let noCharge: EditPlan['no_charge'] = null;
	let status = invoice.status;

	if (invoice.no_charge && !allZero) {
		noCharge = 'reverted';
		status = PENDING_STATUS;
		warn('no_charge_reverted', 'La factura estaba sin cobro (todas sus líneas en 0): vuelve a Por Emitir con las líneas recalculadas');
	} else if (!invoice.no_charge && invoice.status === PENDING_STATUS && allZero) {
		noCharge = 'becomes';
		status = CANCELLED_STATUS;
		warn(
			'becomes_no_charge',
			'Todas las líneas quedan en 0: la factura pasa a Cancelada "sin cobro" (no se envía ni genera alertas; vuelve a Por Emitir si recupera cantidad)'
		);
	}
	// Períodos tocados: el NUEVO y el ANTERIOR de cada línea con montos cambiados (mover una línea fuera de un período cerrado o reconstruir el
	// devengo del mes que deja también cuentan).
	const touchedStarts = [
		...[...touchedAmounts].flatMap((id) => [current.get(id)?.billing_period_start ?? null, rows.get(id)?.billing_period_start ?? null]),
		...createdStates.filter((entry) => entry.input_index !== undefined).map((entry) => entry.state.billing_period_start),
	].filter((value): value is string => !!value);
	const closedIssue = periodClosedBlocker(header.after.issue_date ?? invoice.issue_date, context, 'La fecha de emisión');

	if (closedIssue) blockers.push(closedIssue);
	const firstTouched = [...touchedStarts].sort()[0];
	const closedLine = firstTouched ? periodClosedBlocker(firstTouched, context, 'El período de una línea editada') : null;

	if (closedLine) blockers.push(closedLine);

	// ---- descuento puntual: motivo tipado con devengo (400 si falta) y tratamiento en `invoices.nc_revenue_treatment`.
	const oneOffAdded = bodyLines.some((line, index) => line.one_off_discount && oneOffTouched.has(line.id ?? `new:${index}`));

	if (oneOffAdded) {
		if (!input.deviation?.reason?.trim())
			errors.push({ field: 'deviation', message: 'Un descuento puntual exige deviation { type: discount, reason, revenue_treatment }' });
		else if (input.deviation.type !== 'discount')
			errors.push({ field: 'deviation.type', message: 'Un descuento puntual se registra con deviation.type = discount' });
		if (!input.deviation?.revenue_treatment)
			errors.push({
				field: 'deviation.revenue_treatment',
				message: 'Indica cómo se devenga el descuento: service_period, impact_month o defer_forward',
			});
	}
	const afterOneOff = afterLines.filter((line) => oneOffOf(line.pricing_breakdown));
	const beforeOneOff = ctx.lines.filter((row) => oneOffOf(row.pricing_breakdown));
	const treatment: string | null = afterOneOff.length
		? oneOffAdded
			? (input.deviation?.revenue_treatment ?? null)
			: (invoice.nc_revenue_treatment ?? input.deviation?.revenue_treatment ?? null)
		: null;
	const issueAfter = header.after.issue_date ?? invoice.issue_date;
	const oneOffChanged =
		oneOffTouched.size > 0 ||
		(treatment ?? null) !== (invoice.nc_revenue_treatment ?? null) ||
		((afterOneOff.length > 0 || beforeOneOff.length > 0) && issueAfter !== invoice.issue_date) ||
		(beforeOneOff.length > 0 && noCharge !== null);
	const revenueEffect =
		afterOneOff.length || beforeOneOff.length
			? oneOffRevenueEffect(
					afterOneOff.map((line) => ({
						contract_item_id: line.contract_item_id ?? '',
						amount: oneOffOf(line.pricing_breakdown)!.total,
						billing_period_start: line.billing_period_start,
						billing_period_end: line.billing_period_end,
					})),
					status === CANCELLED_STATUS ? null : (treatment as OneOffRevenueTreatment | null),
					issueAfter,
					new Map(
						[...ctx.items.values()].map((item) => [
							item.id,
							{ start_date: item.start_date, end_date: item.end_date, term_months: item.term_months ?? null },
						])
					)
				)
			: null;

	// ---- encabezado = Σ líneas. Solo se recalcula si cambió algún monto (líneas del cuerpo o IVA): una edición de fechas, glosa o
	// presentación por tramo no toca el encabezado (conserva, por ejemplo, el neto exacto en moneda de factura de una OC).
	const amountsChanged =
		touchedAmounts.size > 0 || createdStates.some((entry) => entry.input_index !== undefined) || taxChanged || multicurrencyChanged;
	const beforeHeader = headerStateOf(
		invoice,
		ctx.lines.map((row) => stateOf(row))
	);
	// `tax_rate` solo se reescribe si cambia (receptor o normalización): una tasa NULL sigue NULL (la ve `tax_rate_missing` al enviar).
	const headerOverrides: Partial<HeaderState> = {
		...header.after,
		tax_rate: header.after.tax_rate ?? invoice.tax_rate,
		status,
		nc_revenue_treatment: treatment,
	};
	let afterHeader = headerStateOf(invoice, afterLines, headerOverrides);

	if (amountsChanged && pairHeader) {
		afterHeader = headerStateOf(invoice, afterLines, { ...headerOverrides, ...pairHeader });
	} else if (amountsChanged) {
		const amounts = headerFromLines(afterLines, { sameCurrency: !isMultiCurrency(invoice), fx, taxRate });

		afterHeader = headerStateOf(invoice, afterLines, {
			...headerOverrides,
			amount_contract_currency: amounts.amount_contract_currency,
			vat: amounts.vat,
			amount_invoice_currency: amounts.amount_invoice_currency,
			total_invoice_currency: amounts.total_invoice_currency,
			tax_invoice_currency:
				amounts.amount_invoice_currency === null || amounts.total_invoice_currency === null
					? null
					: round2(amounts.total_invoice_currency - amounts.amount_invoice_currency),
		});
	}
	afterHeader.total_contract_currency = round2(afterHeader.amount_contract_currency + afterHeader.tax_contract_currency);

	// ---- conciliador de desvíos (por líneas)
	const deviation = reconcileDeviation(
		ctx.plan,
		ctx.lines.map((row) => stateOf(row)),
		afterLines,
		invoice.contract_currency
	);
	const reason = input.deviation?.reason?.trim();

	if (deviation.has_deviation && deviation.changed && !reason) {
		warn(
			'deviation_reason_required',
			`${EDIT_BLOCKER_MESSAGES.deviation_reason_required} (diferencia ${deviation.total_diff} ${invoice.contract_currency ?? ''})`.trim()
		);
	}
	if (input.deviation && !deviation.has_deviation)
		warn('no_deviation', 'La factura no queda distinta al plan: el motivo del desvío no se registra');

	// ---- líneas de la respuesta (existentes en su orden, luego las nuevas), con la vista del descuento puntual
	const view = (state: LineState | null): LineState | null => {
		if (!state) return null;
		const one = oneOffOf(state.pricing_breakdown);

		return {
			...state,
			one_off_discount: one
				? { type: one.one_off_type ?? 'amount', value: one.one_off_value ?? -one.total, amount: -one.total, label: one.label }
				: null,
		};
	};
	const linePlans: LinePlan[] = [
		...ctx.lines.map((row) => plans.get(row.id)!),
		...createdStates.map((entry) => ({
			id: null,
			action: 'create' as const,
			before: null,
			after: entry.state,
			is_visible: entry.state.is_visible,
			...(entry.input_index === undefined ? {} : { input_index: entry.input_index }),
		})),
	].map((plan) => ({ ...plan, before: view(plan.before), after: view(plan.after) }));
	const updates = ctx.lines
		.filter((row) => !removes.has(row.id))
		.map((row) => plans.get(row.id)!)
		.filter((plan) => plan.action === 'update' || plan.action === 'hide')
		.map((plan) => ({ id: plan.id!, after: plan.after!, touched_amounts: touchedAmounts.has(plan.id!) }));
	// Devengo: desde el primer período cuyo monto cambió (la presentación por tramo no cambia montos); con descuento puntual, también desde
	// el mes de emisión (antes y después), porque el ajuste de `nc_discount_revenue_adjustment` se ancla ahí.
	const rsmMonths = [
		...(firstTouched ? [firstTouched] : []),
		...(oneOffChanged ? [invoice.issue_date, issueAfter, ...afterOneOff.map((line) => line.billing_period_start)] : []),
		...(noCharge ? afterLines.map((line) => line.billing_period_start) : []),
	]
		.filter((value): value is string => !!value)
		.sort();

	return {
		errors,
		blockers,
		warnings,
		header: { before: beforeHeader, after: afterHeader },
		lines: linePlans,
		line_mode: lineModePlans,
		deviation: { ...deviation, reason_required: deviation.has_deviation && deviation.changed && !reason },
		write: {
			updates,
			creates: createdStates.map((entry) => entry.state),
			removes: [...removes],
			header_changed: header.changed || amountsChanged || noCharge !== null || oneOffChanged,
			amounts_changed: amountsChanged,
			tax_rate: taxRate,
			fx,
		},
		rsm_from_month: rsmMonths.length ? `${rsmMonths[0].slice(0, 7)}-01` : null,
		price_line_modes: priceLineModes,
		revenue_effect: revenueEffect,
		no_charge: noCharge,
		one_off_changed: oneOffChanged,
		can_apply: blockers.length === 0 && errors.length === 0,
	};
}

export const deviationReasonMissing = (plan: Pick<EditPlan, 'deviation'>, input: Pick<InvoiceEditInput, 'deviation'>) =>
	plan.deviation.has_deviation && plan.deviation.changed && !input.deviation?.reason?.trim();

export const deviationReasonBlocker = (deviation: DeviationView): InvoiceBlocker => ({
	code: 'deviation_reason_required',
	message: `${EDIT_BLOCKER_MESSAGES.deviation_reason_required} (diferencia ${deviation.total_diff} ${deviation.currency ?? ''})`.replace(
		/\s+\)/,
		')'
	),
	next_step: 'Envía deviation { type: discount | upsell | downsell | correction, reason }',
});

// ------------------------------------------------------------------ masivo (encabezado)

export interface BulkHeaderInput {
	invoice_terms_and_conditions?: string | null;
	client_entity_id?: string | null;
	auto_invoice?: boolean | null;
}

export interface BulkHeaderPlanItem {
	id: string;
	invoice_number: string | null;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	errors: FieldError[];
	before: HeaderState;
	after: HeaderState;
	/** Líneas cuyo IVA se recalcula (cambio de receptor con otra tasa). */
	lines: Array<{ id: string; before: LineState; after: LineState }>;
	tax_rate: number;
	fx: number | null;
}

/**
 * Masivo de encabezado (cubre el front viejo: condiciones en bloque, receptor por factura, emisión automática): mismas reglas y
 * bloqueos que la edición de una factura, sin tocar líneas salvo el IVA si el receptor cambia la tasa.
 */
export function planBulkHeader(
	ctx: Pick<EditContext, 'invoice' | 'context' | 'company_tax_rate' | 'receiver' | 'lines' | 'multicurrency'>,
	input: BulkHeaderInput
): BulkHeaderPlanItem {
	const { invoice, context } = ctx;
	const blockers: InvoiceBlocker[] = [...commonBlockers(invoice)];
	const draft = erpDraftBlocker(invoice);
	const header = planHeader(ctx, input);
	const fx = invoiceFx(invoice);
	const taxChanged = header.after.tax_rate !== undefined;
	let lines = taxChanged
		? ctx.lines.map((row) => {
				const before = stateOf(row);

				return {
					id: row.id,
					before,
					after: retax(before, header.tax_rate),
				};
			})
		: [];
	// Multimoneda: con IVA nuevo, cada línea se revaloriza con la tasa de su par y el encabezado = Σ líneas (spec-multimoneda §4).
	const pair =
		taxChanged && ctx.multicurrency
			? revalueStates(
					lines.map((line) => ({ id: line.id, state: line.after })),
					ctx.multicurrency,
					invoice,
					header.tax_rate
				)
			: null;

	if (pair) lines = lines.map((line, index) => ({ ...line, after: pair.states[index] }));
	const afterLines = taxChanged ? lines.map((line) => line.after) : ctx.lines.map((row) => stateOf(row));
	const amounts = headerFromLines(afterLines, { sameCurrency: !isMultiCurrency(invoice), fx, taxRate: header.tax_rate });
	const closed = periodClosedBlocker(invoice.issue_date, context, 'La fecha de emisión');
	const internalLines = ctx.lines.filter((row) => row.visible_line_id).length;
	const partial = partialBillingBlocker({ ...invoice, internal_lines: internalLines || invoice.internal_lines });

	if (draft) blockers.push(draft);
	if (closed) blockers.push(closed);
	// Facturada por OC: cambiar el receptor o el IVA reescribiría la visible y las internas; se salta y se informa (spec §3.7b).
	if (partial && (!!input.client_entity_id || taxChanged)) blockers.push(partial);
	blockers.push(...header.blockers);
	// Sin cambio de IVA, los montos del encabezado quedan como están (términos, receptor del mismo país o emisión automática no los tocan).
	const after = headerStateOf(invoice, afterLines, {
		...header.after,
		tax_rate: header.after.tax_rate ?? invoice.tax_rate,
		...(pair
			? pair.header
			: taxChanged
				? {
						amount_contract_currency: amounts.amount_contract_currency,
						vat: amounts.vat,
						amount_invoice_currency: amounts.amount_invoice_currency,
						total_invoice_currency: amounts.total_invoice_currency,
						tax_invoice_currency:
							amounts.amount_invoice_currency === null || amounts.total_invoice_currency === null
								? null
								: round2(amounts.total_invoice_currency - amounts.amount_invoice_currency),
					}
				: {}),
	});

	after.total_contract_currency = round2(after.amount_contract_currency + after.tax_contract_currency);
	if (!header.changed) blockers.push({ code: 'no_change', message: 'La factura ya tiene esos valores', next_step: null });

	return {
		id: invoice.id,
		invoice_number: invoice.invoice_number,
		blockers,
		warnings: header.warnings,
		errors: header.errors,
		before: headerStateOf(
			invoice,
			ctx.lines.map((row) => stateOf(row))
		),
		after,
		lines,
		tax_rate: header.tax_rate,
		fx,
	};
}

/** Qué recomponer en una Por Emitir posterior (scope `invoice_and_following`): bloqueos de la factura o las filas del ítem. */
export function planFollowingLineMode(
	invoice: ContractInvoiceRow,
	rows: EditLineRow[],
	itemId: string,
	mode: InvoiceLineMode,
	options: { tax_rate: number; render: RenderInput; confirm_manual_overwrite?: boolean }
): { blockers: InvoiceBlocker[]; result: RecomposeResult | null } {
	const blockers = [...commonBlockers(invoice)];
	const draft = erpDraftBlocker(invoice);

	if (draft) blockers.push(draft);
	if (invoice.status !== PENDING_STATUS) return { blockers, result: null };
	if (blockers.length) return { blockers, result: null };

	return {
		blockers,
		result: recomposeItemRows(
			rows.filter((row) => row.contract_item_id === itemId),
			mode,
			{ tax_rate: options.tax_rate, fx: invoiceFx(invoice), render: options.render, confirm_manual_overwrite: options.confirm_manual_overwrite }
		),
	};
}

export { rowFromState };
