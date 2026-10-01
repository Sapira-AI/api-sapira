import type { FieldError } from '@/core/utils/validation-errors';

import { addMonths, findFixedRate, round2 } from './billing-engine';
import { type HeaderAmounts, headerFromLines } from './consumption';
import {
	type ContractInvoiceContext,
	type ContractInvoiceLineRow,
	type ContractInvoiceRow,
	type InvoiceBlocker,
	invoiceDueDate,
	type InvoiceWarning,
	isMultiCurrency,
	netExactFx,
	REFERENCE_DOCUMENT_TYPES,
	round6,
} from './contract-invoices';
import { exceedsMax, manualDescription } from './invoice-description';
import {
	amountsOf,
	type EditLineRow,
	invoiceFx,
	isVisibleLine,
	type LineState,
	MANUAL_QUANTITY_SOURCE,
	type RenderInput,
	renderLine,
	stateOf,
} from './invoice-edit';
import { invoiceOperability, type NewInvoiceRules, scaleBreakdown } from './invoice-reorganize';
import { oneOffOf } from './one-off-discount';

/**
 * Facturas en el Contrato 360, etapa 6 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.7b, flexibilidad caso 6 tal cual, decisiones 4 y 5
 * de Domi): **facturar un monto cerrado por OC** sobre una Por Emitir. Lógica pura, sin base; el servicio
 * (`contract-invoice-partial-po.service.ts`) carga, bloquea y escribe.
 *
 * 1. Propuesta: con el monto de la OC en moneda de factura, las líneas visibles que suman **exacto** (subconjuntos sobre ≤ 12 líneas) o, si no
 *    hay, las más grandes completas más una **parcial** a precio de lista (cantidad = resto ÷ unitario). `allocation` la reemplaza.
 * 2. Lo cubierto queda en esta factura como **una línea visible** (la del documento: cantidad 1, unitario = neto de la OC) más las **internas**
 *    (`visible_line_id` = la visible) que conservan ítem, período y montos para el devengo, el conciliador y la trazabilidad. La visible lleva
 *    sus montos (subtotal, IVA, total) en **0** para que Σ líneas = encabezado sin duplicar: el documento (y el ERP, que multiplica cantidad ×
 *    unitario) la lee por su unitario; las internas no viajan (`quantity <> 0 AND visible_line_id IS NULL`).
 * 3. El saldo pasa a una Por Emitir **nueva** del mismo período, con las reglas del generador (`split_reason = 'partial_by_po'`,
 *    `split_from_invoice_id`, emisión = próximo ciclo), las líneas conservan su período.
 * 4. FX: la OC fija el neto en moneda de factura → neto exacto (`netExactFx`) sobre lo cubierto; el saldo toma la política del contrato;
 *    `fx_difference` = neto de la OC − neto cubierto × tasa previa (va al evento; no hay NC/ND ni arrastre).
 */

export const PARTIAL_BY_PO_SPLIT_REASON = 'partial_by_po';
/** `invoice_items.fx_rate_source` de las internas cubiertas con conversión (neto exacto de la OC, misma marca que `PATCH …/fx`). */
export const PARTIAL_BY_PO_FX_RATE_SOURCE = 'net_exact';
/** Líneas visibles sobre las que se buscan subconjuntos exactos (2^12 = 4096 combinaciones). */
export const SUBSET_SEARCH_MAX_LINES = 12;
export const VISIBLE_LINE_TEXT_MAX = 300;

const cents = (value: number) => Math.round(round2(value) * 100);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const round4 = (value: number) => Math.round(value * 1e4) / 1e4 || 0;

export interface PartialByPoInput {
	reference: { type: 'OC' | 'HES'; code: string; date?: string | null };
	/** Neto de la OC en MONEDA DE FACTURA. */
	amount_invoice_currency: number;
	/** Asignación manual (moneda de factura) que reemplaza la propuesta; debe sumar el neto de la OC. */
	allocation?: Array<{ line_id: string; amount: number }> | null;
	/** Texto de la única línea visible del documento. */
	visible_line_text: string;
	reason: string;
}

export interface PartialByPoContext {
	invoice: ContractInvoiceRow;
	lines: EditLineRow[];
	context: ContractInvoiceContext;
	rules: NewInvoiceRules;
	/** Render de glosas de la factura cubierta (plantilla del contrato). */
	render: RenderInput;
	max_chars: number | null;
	/** Referencias propias ya guardadas en la factura (`invoice_references`). */
	references: Array<{ document_type_code: string; document_number: string }>;
}

/**
 * Subconjunto de montos (moneda de factura) que suma exacto `target`, al centavo. Entre varios, el de índices lexicográficamente menores
 * (las líneas de período más temprano primero). null si no hay o si hay más de `SUBSET_SEARCH_MAX_LINES` montos.
 */
export function exactSubset(amounts: number[], target: number): number[] | null {
	if (!amounts.length || amounts.length > SUBSET_SEARCH_MAX_LINES) return null;
	const goal = cents(target);
	const values = amounts.map(cents);
	let best: number[] | null = null;

	for (let mask = 1; mask < 1 << values.length; mask += 1) {
		let total = 0;
		const indices: number[] = [];

		for (let index = 0; index < values.length; index += 1) {
			if (mask & (1 << index)) {
				total += values[index];
				indices.push(index);
			}
		}
		if (total !== goal) continue;
		if (!best || lexicographicLess(indices, best)) best = indices;
	}

	return best;
}

const lexicographicLess = (a: number[], b: number[]) => {
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] < b[index];

	return a.length < b.length;
};

/**
 * Propuesta sin subconjunto exacto: las líneas más grandes completas mientras quepan y la siguiente **parcial** por el resto (a precio de
 * lista: la cantidad cubierta = resto ÷ unitario). null si el neto supera la suma de las líneas.
 */
export function largestWithPartial(amounts: number[], target: number): Array<{ index: number; amount: number; partial: boolean }> | null {
	if (cents(target) > sum(amounts.map(cents))) return null;
	const order = amounts.map((amount, index) => ({ amount, index })).sort((a, b) => b.amount - a.amount || a.index - b.index);
	const result: Array<{ index: number; amount: number; partial: boolean }> = [];
	let remaining = cents(target);

	for (const entry of order) {
		if (remaining <= 0) break;
		const value = cents(entry.amount);

		if (value <= remaining) {
			result.push({ index: entry.index, amount: round2(entry.amount), partial: false });
			remaining -= value;
		} else {
			result.push({ index: entry.index, amount: remaining / 100, partial: true });
			remaining = 0;
		}
	}

	return result;
}

export interface PartialLineTotals {
	amount_contract_currency: number;
	vat: number | null;
	amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
}

export interface PartialByPoPlan {
	errors: FieldError[];
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	proposal: { mode: 'exact' | 'partial' | 'allocation'; allocation: Array<{ line_id: string; amount: number; partial: boolean }> };
	covered_lines: Array<{
		line_id: string;
		contract_item_id: string | null;
		product_name: string | null;
		billing_period_start: string | null;
		billing_period_end: string | null;
		quantity: number;
		subtotal_contract_currency: number;
		subtotal_invoice_currency: number | null;
		partial: boolean;
	}>;
	partial_line: {
		line_id: string;
		quantity_before: number;
		quantity_covered: number;
		quantity_remaining: number;
		unit_price_invoice_currency: number | null;
		amount_covered: number;
		amount_remaining: number;
	} | null;
	visible_line: {
		description: string;
		quantity: 1;
		unit_price_contract_currency: number;
		unit_price_invoice_currency: number | null;
		contract_item_id: string | null;
		billing_period_start: string | null;
		billing_period_end: string | null;
	};
	balance_lines: Array<{
		line_id: string | null;
		from_line_id: string;
		action: 'moved' | 'split';
		contract_item_id: string | null;
		product_name: string | null;
		quantity: number;
		subtotal_contract_currency: number;
		subtotal_invoice_currency: number | null;
		billing_period_start: string | null;
		billing_period_end: string | null;
	}>;
	covered_invoice: {
		id: string;
		invoice_number: string | null;
		invoice_currency: string | null;
		before: PartialLineTotals;
		after: PartialLineTotals;
	};
	remainder_invoice: {
		issue_date: string;
		due_date: string;
		contract_currency: string;
		invoice_currency: string;
		fx_contract_to_invoice: number | null;
		split_reason: typeof PARTIAL_BY_PO_SPLIT_REASON;
		split_from_invoice_id: string;
		notes: string;
		totals: PartialLineTotals;
	} | null;
	fx: {
		policy_before: 'same_currency' | 'fixed' | 'spot';
		fx_before: number | null;
		fx_after: number | null;
		net_exact: boolean;
		covered_contract_total: number;
		covered_invoice_total: number;
		/** Neto de la OC − neto cubierto × tasa previa (moneda de factura); 0 en misma moneda. */
		fx_difference: number;
		remainder_fx: number | null;
	};
	reference: { type: 'OC' | 'HES'; code: string; date: string | null; document_type_code: string; already_present: boolean };
	rsm_from_month: string | null;
	write: {
		/** Líneas que quedan en la factura como internas (UPDATE con `visible_line_id`). */
		covered: Array<{ id: string; state: LineState }>;
		visible: LineState;
		/** Líneas que pasan completas a la factura de saldo (UPDATE `invoice_id`). */
		moves: Array<{ id: string; state: LineState }>;
		/** Resto de la línea parcial (INSERT en la factura de saldo). */
		creates: Array<{ from_line_id: string; state: LineState }>;
		covered_header: HeaderAmounts;
		covered_fx: number | null;
		covered_fx_source: string | null;
		/** Ya no le queda una línea con descuento puntual: su `nc_revenue_treatment` pasa a NULL. */
		covered_treatment_cleared: boolean;
		/** Parte (0..1] del descuento puntual de la cubierta que pasa al saldo (mueve/duplica su `invoice_adjustments`); 0 = ninguna. */
		one_off_share: number;
		remainder: {
			issue_date: string;
			due_date: string;
			fx: number | null;
			document_type: string;
			export_type: 0 | 1;
			tax_rate: number;
			client_entity_id: string | null;
			contract_currency: string;
			invoice_currency: string;
			notes: string;
			header: HeaderAmounts;
			/** El descuento puntual sigue a su línea: el saldo toma el devengo de la cubierta si recibe una línea con puntual. */
			nc_revenue_treatment: string | null;
		} | null;
	};
}

const totalsOf = (
	header: Pick<ContractInvoiceRow, 'amount_contract_currency' | 'vat' | 'amount_invoice_currency' | 'total_invoice_currency'>
): PartialLineTotals => ({
	amount_contract_currency: header.amount_contract_currency,
	vat: header.vat,
	amount_invoice_currency: header.amount_invoice_currency,
	total_invoice_currency: header.total_invoice_currency,
});

const ddmmyyyy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** "09/2026" si el período cae en un mes; si no, "01/09/2026 a 30/11/2026". */
export function periodLabel(start: string | null, end: string | null): string {
	if (!start) return 'sin período';
	if (!end || start.slice(0, 7) === end.slice(0, 7)) return `${start.slice(5, 7)}/${start.slice(0, 4)}`;

	return `${ddmmyyyy(start)} a ${ddmmyyyy(end)}`;
}

/** Plan de facturar por OC (preview y aplicar comparten el cálculo). */
export function planPartialByPo(ctx: PartialByPoContext, input: PartialByPoInput): PartialByPoPlan {
	const { invoice, context, rules } = ctx;
	const errors: FieldError[] = [];
	const blockers: InvoiceBlocker[] = invoiceOperability(invoice, context);
	const warnings: InvoiceWarning[] = [];
	const taxRate = invoice.tax_rate === null ? 0 : invoice.tax_rate > 0 && invoice.tax_rate <= 1 ? round2(invoice.tax_rate * 100) : invoice.tax_rate;
	const multi = isMultiCurrency(invoice);
	const fxBefore = invoiceFx(invoice);
	const target = round2(Number(input.amount_invoice_currency));
	const text = manualDescription(input.visible_line_text ?? '').trim();
	const referenceType = REFERENCE_DOCUMENT_TYPES[input.reference.type];
	const referenceCode = input.reference.code.trim();

	if (!(target > 0)) errors.push({ field: 'amount_invoice_currency', message: 'El monto de la OC debe ser mayor que 0' });
	if (!text) errors.push({ field: 'visible_line_text', message: 'Escribe el texto de la línea del documento' });
	else if (exceedsMax(text.length, ctx.max_chars))
		errors.push({ field: 'visible_line_text', message: `El texto tiene ${text.length} caracteres y el documento admite ${ctx.max_chars}` });
	if (multi && fxBefore === null)
		blockers.push({
			code: 'spot_without_rate',
			message: 'La factura está en spot sin tasa: no se puede comparar el monto de la OC con sus líneas',
			next_step: 'Fija el tipo de cambio de la factura (Tipo de cambio) y vuelve a facturar por OC',
		});
	// Candidatas: líneas visibles (cantidad ≠ 0, no internas) con monto, en el orden del documento (período, luego la carga).
	const candidates = ctx.lines.filter((row) => isVisibleLine(row.quantity, row.visible_line_id) && row.subtotal > 0);
	const lineInvoice = (row: EditLineRow): number =>
		row.subtotal_invoice !== null && fxBefore !== 1 ? row.subtotal_invoice : round2(row.subtotal * (fxBefore ?? 1));
	const amounts = candidates.map(lineInvoice);
	const invoiceTotal = round2(sum(amounts));

	if (!candidates.length)
		blockers.push({ code: 'no_visible_lines', message: 'La factura no tiene líneas con monto que facturar por OC', next_step: null });
	else if (target > invoiceTotal + 0.005)
		blockers.push({
			code: 'exceeds_invoice',
			message: `El monto de la OC (${target} ${invoice.invoice_currency ?? ''}) supera el neto de la factura (${invoiceTotal})`.replace(
				' )',
				')'
			),
			next_step: 'Revisa el monto: una OC mayor que la factura se factura junto con otra Por Emitir (Reorganizar › juntar)',
		});

	// ---- asignación: la del cuerpo o la propuesta
	let proposal: PartialByPoPlan['proposal'] = { mode: 'exact', allocation: [] };

	if (input.allocation?.length) {
		const seen = new Set<string>();
		const byId = new Map(candidates.map((row, index) => [row.id, index]));
		const allocation: PartialByPoPlan['proposal']['allocation'] = [];

		input.allocation.forEach((entry, index) => {
			const field = (name: string) => `allocation.${index}.${name}`;
			const position = byId.get(entry.line_id);

			if (seen.has(entry.line_id)) return errors.push({ field: field('line_id'), message: 'La línea viene repetida' });
			seen.add(entry.line_id);
			if (position === undefined) return errors.push({ field: field('line_id'), message: 'No es una línea visible con monto de esta factura' });
			const amount = round2(Number(entry.amount));

			if (!(amount > 0)) return errors.push({ field: field('amount'), message: 'El monto asignado debe ser mayor que 0' });
			if (cents(amount) > cents(amounts[position]))
				return errors.push({ field: field('amount'), message: `El monto asignado supera el neto de la línea (${amounts[position]})` });
			allocation.push({ line_id: entry.line_id, amount, partial: cents(amount) < cents(amounts[position]) });
		});
		const allocated = round2(sum(allocation.map((entry) => entry.amount)));

		if (!errors.length && cents(allocated) !== cents(target))
			errors.push({ field: 'allocation', message: `La asignación suma ${allocated} y la OC ${target}: deben coincidir` });
		proposal = { mode: 'allocation', allocation };
	} else if (candidates.length && target > 0 && cents(target) <= cents(invoiceTotal)) {
		const exact = exactSubset(amounts, target);

		if (exact)
			proposal = {
				mode: 'exact',
				allocation: exact.map((index) => ({ line_id: candidates[index].id, amount: round2(amounts[index]), partial: false })),
			};
		else {
			const partial = largestWithPartial(amounts, target) ?? [];

			proposal = {
				mode: 'partial',
				allocation: partial
					.sort((a, b) => a.index - b.index)
					.map((entry) => ({ line_id: candidates[entry.index].id, amount: entry.amount, partial: entry.partial })),
			};
		}
	}
	const partials = proposal.allocation.filter((entry) => entry.partial);

	if (partials.length > 1)
		warnings.push({
			code: 'several_partial_lines',
			message: `La asignación deja ${partials.length} líneas parciales: cada una se divide entre la OC y el saldo`,
		});

	// ---- líneas cubiertas (internas), resto de la parcial y saldo
	const allocationById = new Map(proposal.allocation.map((entry) => [entry.line_id, entry]));
	const coveredStates: Array<{ id: string; row: EditLineRow; state: LineState; partial: boolean }> = [];
	const moves: Array<{ id: string; row: EditLineRow; state: LineState }> = [];
	const creates: Array<{ from_line_id: string; row: EditLineRow; state: LineState }> = [];
	let partialView: PartialByPoPlan['partial_line'] = null;

	for (const [index, row] of candidates.entries()) {
		const entry = allocationById.get(row.id);
		const base = stateOf(row);

		if (!entry) {
			moves.push({ id: row.id, row, state: base });
			continue;
		}
		if (!entry.partial) {
			coveredStates.push({ id: row.id, row, state: base, partial: false });
			continue;
		}
		const ratio = amounts[index] > 0 ? entry.amount / amounts[index] : 0;
		const quantityCovered = round4(row.quantity * ratio);
		const subtotalCovered = round2(row.subtotal * ratio);
		const coveredState: LineState = {
			...base,
			...amountsOf(quantityCovered, row.unit_price, subtotalCovered, taxRate, fxBefore),
			pricing_breakdown: scaleBreakdown(row.pricing_breakdown, row.subtotal, subtotalCovered),
		};
		const remainingState: LineState = {
			...base,
			...amountsOf(round4(row.quantity - quantityCovered), row.unit_price, round2(row.subtotal - subtotalCovered), rules.tax_rate, null),
			pricing_breakdown: scaleBreakdown(row.pricing_breakdown, row.subtotal, round2(row.subtotal - subtotalCovered)),
		};

		if (!base.description_locked) {
			coveredState.description = renderLine(coveredState, ctx.render);
			remainingState.description = renderLine(remainingState, ctx.render);
		}
		coveredStates.push({ id: row.id, row, state: coveredState, partial: true });
		creates.push({ from_line_id: row.id, row, state: remainingState });
		partialView ??= {
			line_id: row.id,
			quantity_before: row.quantity,
			quantity_covered: quantityCovered,
			quantity_remaining: round4(row.quantity - quantityCovered),
			unit_price_invoice_currency: row.unit_price_invoice,
			amount_covered: entry.amount,
			amount_remaining: round2(amounts[index] - entry.amount),
		};
	}

	// ---- FX de lo cubierto: misma moneda = 1; con conversión, neto exacto de la OC sobre las internas.
	const coveredContract = round2(sum(coveredStates.map((entry) => entry.state.subtotal_contract_currency)));
	let coveredFx = fxBefore;
	let coveredHeader: HeaderAmounts = headerFromLines(
		coveredStates.map((entry) => entry.state),
		{ sameCurrency: !multi, fx: fxBefore, taxRate }
	);
	let netExact = false;

	if (multi && fxBefore !== null && coveredStates.length && target > 0) {
		const rows: ContractInvoiceLineRow[] = coveredStates.map((entry) => ({
			id: entry.id,
			quantity: entry.state.quantity,
			// Unitario efectivo (subtotal ÷ cantidad): la base del neto exacto respeta el descuento de la línea.
			unit_price_contract_currency: entry.state.quantity
				? entry.state.subtotal_contract_currency / entry.state.quantity
				: entry.state.subtotal_contract_currency,
			subtotal_contract_currency: entry.state.subtotal_contract_currency,
			tax_amount_contract_currency: entry.state.tax_contract_currency,
			total_contract_currency: entry.state.total_contract_currency,
			unit_price_invoice_currency: entry.state.unit_price_invoice_currency,
			subtotal_invoice_currency: entry.state.subtotal_invoice_currency,
			tax_amount_invoice_currency: entry.state.tax_invoice_currency,
			total_invoice_currency: entry.state.total_invoice_currency,
			created_at: null,
		}));
		const result = netExactFx(rows, taxRate, target);

		if (result) {
			netExact = true;
			coveredFx = result.fx;
			coveredHeader = result.header;
			result.lines.forEach((line, index) => {
				coveredStates[index].state = {
					...coveredStates[index].state,
					unit_price_invoice_currency: line.after.unit_price_invoice_currency,
					subtotal_invoice_currency: line.after.subtotal_invoice_currency,
					tax_invoice_currency: line.after.tax_amount_invoice_currency,
					total_invoice_currency: line.after.total_invoice_currency,
				};
			});
		}
	}
	const coveredInvoiceTotal = multi ? target : coveredContract;
	const fxDifference = multi && fxBefore !== null ? round2(target - round2(coveredContract * fxBefore)) : 0;

	// ---- línea visible (la del documento)
	const sortedCovered = [...coveredStates].sort(
		(a, b) => (a.state.billing_period_start ?? '').localeCompare(b.state.billing_period_start ?? '') || 0
	);
	const first = sortedCovered[0]?.state ?? null;
	const starts = coveredStates
		.map((entry) => entry.state.billing_period_start)
		.filter((value): value is string => !!value)
		.sort();
	const ends = coveredStates
		.map((entry) => entry.state.billing_period_end)
		.filter((value): value is string => !!value)
		.sort();
	const visible: LineState = {
		contract_item_id: first?.contract_item_id ?? null,
		product_id: first?.product_id ?? null,
		product_name: first?.product_name ?? null,
		account: first?.account ?? null,
		description: text,
		description_locked: true,
		quantity: 1,
		unit_of_measure: 'UND',
		discount_pct: 0,
		unit_price_contract_currency: round6(coveredContract),
		// Montos en 0: los llevan las internas (Σ líneas = encabezado). El documento lee cantidad × unitario.
		subtotal_contract_currency: 0,
		tax_contract_currency: 0,
		total_contract_currency: 0,
		unit_price_invoice_currency: coveredFx === null ? null : round6(coveredInvoiceTotal),
		subtotal_invoice_currency: coveredFx === null ? null : 0,
		tax_invoice_currency: coveredFx === null ? null : 0,
		total_invoice_currency: coveredFx === null ? null : 0,
		billing_period_start: starts[0] ?? null,
		billing_period_end: ends[ends.length - 1] ?? null,
		quantity_source: MANUAL_QUANTITY_SOURCE,
		pricing_breakdown: null,
		is_visible: true,
	};

	// ---- saldo: Por Emitir nueva con las reglas del generador
	const balanceStates = [...moves.map((entry) => entry.state), ...creates.map((entry) => entry.state)];
	const balanceStarts = balanceStates
		.map((state) => state.billing_period_start)
		.filter((value): value is string => !!value)
		.sort();
	const balanceEnds = balanceStates
		.map((state) => state.billing_period_end)
		.filter((value): value is string => !!value)
		.sort();
	let remainder: PartialByPoPlan['write']['remainder'] = null;
	let remainderFx: number | null = null;
	const movesOut: Array<{ id: string; state: LineState }> = [];
	const createsOut: Array<{ from_line_id: string; state: LineState }> = [];

	if (balanceStates.length) {
		const sameCurrency = rules.invoice_currency.toUpperCase() === rules.contract_currency.toUpperCase();
		const periodStart = balanceStarts[0] ?? invoice.issue_date ?? context.today;

		if (sameCurrency) remainderFx = 1;
		else if (rules.fx_invoice_policy === 'fixed') {
			remainderFx = findFixedRate(rules.fixed_invoice_rates, rules.contract_currency, rules.invoice_currency, periodStart);
			if (remainderFx === null)
				warnings.push({
					code: 'fixed_fx_without_rate',
					message: `El contrato usa tipo de cambio fijo pero no tiene tasa ${rules.contract_currency} → ${rules.invoice_currency} para el período que empieza el ${periodStart}: la factura de saldo queda sin tasa (confírmala en Tipo de cambio antes de enviar)`,
				});
		}
		const valued = (state: LineState): LineState => ({
			...state,
			...amountsOf(state.quantity, state.unit_price_contract_currency, state.subtotal_contract_currency, rules.tax_rate, remainderFx),
		});

		for (const entry of moves) movesOut.push({ id: entry.id, state: valued(entry.state) });
		for (const entry of creates) createsOut.push({ from_line_id: entry.from_line_id, state: valued(entry.state) });
		const nextCycle = addMonths(invoice.issue_date ?? context.today, 1);
		const issueDate = nextCycle < context.today ? context.today : nextCycle;
		const remainderStates = [...movesOut.map((entry) => entry.state), ...createsOut.map((entry) => entry.state)];

		remainder = {
			issue_date: issueDate,
			due_date: invoiceDueDate(issueDate, context),
			fx: remainderFx,
			document_type: rules.document_type,
			export_type: rules.export_type,
			tax_rate: rules.tax_rate,
			client_entity_id: rules.client_entity_id,
			contract_currency: rules.contract_currency,
			invoice_currency: rules.invoice_currency,
			notes: `Saldo de OC ${referenceCode} del período ${periodLabel(balanceStarts[0] ?? null, balanceEnds[balanceEnds.length - 1] ?? null)}`,
			header: headerFromLines(remainderStates, { sameCurrency, fx: remainderFx, taxRate: rules.tax_rate }),
			nc_revenue_treatment: remainderStates.some((state) => oneOffOf(state.pricing_breakdown)) ? (invoice.nc_revenue_treatment ?? null) : null,
		};
	} else if (!errors.length && target > 0) {
		warnings.push({ code: 'no_balance', message: 'La OC cubre toda la factura: no queda saldo; la factura pasa a una sola línea visible' });
	}

	// ---- consumo sin cerrar (el saldo puede cambiar) y referencia
	const open = [...coveredStates.map((entry) => entry.row), ...moves.map((entry) => entry.row), ...creates.map((entry) => entry.row)].filter(
		(row) => row.quantity_source === 'pending' || row.quantity_source === 'estimated'
	);

	for (const row of open)
		warnings.push({
			code: 'open_consumption',
			message: `"${row.product_name ?? row.description ?? 'Ítem'}" (${row.billing_period_start ?? ''}) es por consumo sin cerrar: el monto cubierto y el saldo pueden cambiar al registrar el consumo`,
		});
	const alreadyPresent = ctx.references.some(
		(row) =>
			row.document_type_code.toUpperCase() === referenceType.code.toUpperCase() &&
			row.document_number.trim().toUpperCase() === referenceCode.toUpperCase()
	);

	if (alreadyPresent)
		warnings.push({
			code: 'reference_exists',
			message: `La factura ya tiene la referencia ${input.reference.type} ${referenceCode}: no se duplica`,
		});
	const coveredWrite = coveredStates.map((entry) => ({
		id: entry.id,
		state: { ...entry.state, is_visible: false },
	}));
	// ---- el descuento puntual sigue a su línea: parte que pasa al saldo y si a la cubierta le queda alguno.
	const oneOffOfStates = (states: LineState[]) => round2(sum(states.map((state) => -(oneOffOf(state.pricing_breakdown)?.total ?? 0))));
	const oneOffBefore = oneOffOfStates(ctx.lines.map((row) => stateOf(row)));
	const oneOffMoved = remainder ? oneOffOfStates([...movesOut.map((entry) => entry.state), ...createsOut.map((entry) => entry.state)]) : 0;
	const oneOffShare = oneOffBefore > 0 && oneOffMoved > 0 ? Math.min(1, oneOffMoved / oneOffBefore) : 0;
	const coveredKeepsOneOff = coveredStates.some((entry) => oneOffOf(entry.state.pricing_breakdown));
	const oneOffMonths = oneOffShare > 0 ? [invoice.issue_date, remainder?.issue_date].filter((value): value is string => !!value) : [];
	const afterTotals: PartialLineTotals = { ...coveredHeader };

	return {
		errors,
		blockers,
		warnings,
		can_apply: errors.length === 0 && blockers.length === 0 && coveredStates.length > 0,
		proposal,
		covered_lines: coveredStates.map((entry) => ({
			line_id: entry.id,
			contract_item_id: entry.state.contract_item_id,
			product_name: entry.state.product_name,
			billing_period_start: entry.state.billing_period_start,
			billing_period_end: entry.state.billing_period_end,
			quantity: entry.state.quantity,
			subtotal_contract_currency: entry.state.subtotal_contract_currency,
			subtotal_invoice_currency: entry.state.subtotal_invoice_currency,
			partial: entry.partial,
		})),
		partial_line: partialView,
		visible_line: {
			description: visible.description,
			quantity: 1,
			unit_price_contract_currency: visible.unit_price_contract_currency,
			unit_price_invoice_currency: visible.unit_price_invoice_currency,
			contract_item_id: visible.contract_item_id,
			billing_period_start: visible.billing_period_start,
			billing_period_end: visible.billing_period_end,
		},
		balance_lines: [
			...movesOut.map((entry) => ({ line_id: entry.id, from_line_id: entry.id, action: 'moved' as const, state: entry.state })),
			...createsOut.map((entry) => ({ line_id: null, from_line_id: entry.from_line_id, action: 'split' as const, state: entry.state })),
		].map(({ state, ...rest }) => ({
			...rest,
			contract_item_id: state.contract_item_id,
			product_name: state.product_name,
			quantity: state.quantity,
			subtotal_contract_currency: state.subtotal_contract_currency,
			subtotal_invoice_currency: state.subtotal_invoice_currency,
			billing_period_start: state.billing_period_start,
			billing_period_end: state.billing_period_end,
		})),
		covered_invoice: {
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			invoice_currency: invoice.invoice_currency,
			before: totalsOf(invoice),
			after: afterTotals,
		},
		remainder_invoice: remainder
			? {
					issue_date: remainder.issue_date,
					due_date: remainder.due_date,
					contract_currency: remainder.contract_currency,
					invoice_currency: remainder.invoice_currency,
					fx_contract_to_invoice: remainder.fx,
					split_reason: PARTIAL_BY_PO_SPLIT_REASON,
					split_from_invoice_id: invoice.id,
					notes: remainder.notes,
					totals: { ...remainder.header },
				}
			: null,
		fx: {
			policy_before: !multi ? 'same_currency' : fxBefore === null ? 'spot' : 'fixed',
			fx_before: fxBefore,
			fx_after: coveredFx,
			net_exact: netExact,
			covered_contract_total: coveredContract,
			covered_invoice_total: round2(coveredInvoiceTotal),
			fx_difference: fxDifference,
			remainder_fx: remainderFx,
		},
		reference: {
			type: input.reference.type,
			code: referenceCode,
			date: input.reference.date ?? null,
			document_type_code: referenceType.code,
			already_present: alreadyPresent,
		},
		rsm_from_month:
			starts.length || balanceStarts.length || oneOffMonths.length
				? `${[...starts, ...balanceStarts, ...oneOffMonths].sort()[0].slice(0, 7)}-01`
				: null,
		write: {
			covered: coveredWrite,
			visible,
			moves: movesOut,
			creates: createsOut,
			covered_header: coveredHeader,
			covered_fx: coveredFx,
			covered_fx_source: netExact ? PARTIAL_BY_PO_FX_RATE_SOURCE : null,
			covered_treatment_cleared: !!invoice.nc_revenue_treatment && !coveredKeepsOneOff,
			one_off_share: oneOffShare,
			remainder,
		},
	};
}
