import type { FieldError } from '@/core/utils/validation-errors';

import { round2 } from './billing-engine';
import { isCreditNote, ISSUED_STATUSES } from './contract-360';
import { type ChangeInvoiceLineRow, mirrorCreditNoteAmounts, type MirrorCreditNoteAmounts } from './contract-changes';
import {
	type ContractInvoiceContext,
	type ContractInvoiceRow,
	type InvoiceBlocker,
	invoiceDueDate,
	type InvoiceWarning,
	periodClosedBlocker,
	UNIFY_STEP,
} from './contract-invoices';
import { type EditContext, type EditItem, type EditLineRow, type EditPlan, type InvoiceEditInput, planInvoiceEdit } from './invoice-edit';
import { oneOffRevenueEffect, type OneOffRevenueTreatment, type RevenueEffect } from './one-off-discount';

/**
 * Facturas en el Contrato 360, etapa 6 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.8 y §8 "No existen NC sueltas"): lógica pura
 * de **anular con NC espejo y reemitir** y de la **NC de descuento parcial sobre una emitida**. Sin base: el servicio
 * (`contract-invoice-void.service.ts`) carga, bloquea y escribe con `insertMirrorCreditNote`.
 *
 * Convención (la de v2, igual que la reemisión por consumo corregido): la emitida **no se toca** (conserva su estado); queda "anulada" por
 * derivación cuando tiene una NC de anulación activa vinculada (`voided`, `voidedSql`). La NC nace `Por Emitir` (la emite Facturación),
 * **sin vencimiento** (una NC no vence: se cierra con su factura) y con `related_invoice_id` = la original.
 */

export const VOID_REASONS = ['issue_error', 'client_request', 'other'] as const;
export type VoidReason = (typeof VOID_REASONS)[number];
/** Motivos de la NC de descuento (catálogo `invoices_credit_reason_check`, los mismos del modal de Facturación). */
export const DISCOUNT_CREDIT_REASONS = ['prompt_payment_discount', 'one_time_discount', 'compensation', 'other'] as const;
export type DiscountCreditReason = (typeof DISCOUNT_CREDIT_REASONS)[number];
/** `invoices.split_reason` de la Por Emitir que reemplaza a una anulada. */
export const REISSUE_SPLIT_REASON = 'reissue';
/** Tolerancia (moneda de factura) al comparar descuentos contra lo que queda de la línea. */
export const DISCOUNT_TOLERANCE = 0.005;

export const VOID_REASON_LABELS: Record<VoidReason, string> = {
	issue_error: 'error de emisión',
	client_request: 'solicitud del cliente',
	other: 'otro motivo',
};

/**
 * `credit_reason` de la NC de anulación. El CHECK `invoices_credit_reason_check` no tiene `client_request` (y no se agrega columna ni valor:
 * regla de Domi): la solicitud del cliente se guarda como `other` y el motivo exacto queda en el evento y en las notas de la NC.
 */
export const voidCreditReason = (reason: VoidReason): 'issue_error' | 'other' => (reason === 'issue_error' ? 'issue_error' : 'other');

/** Emitida del contrato con lo que miran anular y la NC de descuento. */
export interface IssuedInvoiceRow extends ContractInvoiceRow {
	/** Tiene una NC de anulación activa vinculada (`voidedSql`). */
	voided: boolean;
	/** Tiene pagos registrados (`invoice_payments`) o está Pagada. */
	paid: boolean;
}

// ------------------------------------------------------------------ bloqueos comunes de una emitida

/** Solo emitidas (Emitida/Enviada/Vencida/Pagada) activas del contrato, no NC/ND, no unificadas, no legacy, no anuladas. */
export function issuedBlockers(invoice: IssuedInvoiceRow, context: ContractInvoiceContext, creditNoteDate: string): InvoiceBlocker[] {
	const blockers: InvoiceBlocker[] = [];

	if (isCreditNote(invoice.document_type) || invoice.document_type === 'ND') {
		blockers.push({
			code: 'credit_note',
			message: 'Una nota de crédito o débito no se anula ni se descuenta con otra NC',
			next_step: 'Opera sobre la factura original',
		});

		return blockers;
	}
	if (!ISSUED_STATUSES.includes((invoice.status ?? '') as (typeof ISSUED_STATUSES)[number]) || !invoice.is_active) {
		blockers.push({
			code: 'not_issued',
			message: `La factura ${invoice.invoice_number ?? invoice.id} no está emitida (estado: ${invoice.status ?? 'sin estado'}${
				invoice.is_active ? '' : ', inactiva'
			}): solo una emitida se corrige con nota de crédito`,
			next_step: 'Una Por Emitir se edita o reorganiza antes de emitir',
		});
	}
	if (invoice.consolidated_into_invoice_id || invoice.invoice_type === 'Unificada' || invoice.invoice_type === 'Consolidada') {
		blockers.push({ code: 'unified_invoice', message: 'Es un documento unificado o consolidado entre facturas', next_step: UNIFY_STEP });
	}
	if (invoice.is_legacy) {
		blockers.push({ code: 'legacy_invoice', message: 'Es una factura importada (legacy): no se opera desde el contrato', next_step: null });
	}
	if (invoice.voided) {
		blockers.push({
			code: 'already_voided',
			message: `La factura ${invoice.invoice_number ?? invoice.id} ya tiene una nota de crédito de anulación`,
			next_step: 'Revisa la NC y la reemisión en Documentos relacionados',
		});
	}
	const closed = periodClosedBlocker(creditNoteDate, context, 'La fecha de la nota de crédito');

	if (closed) blockers.push(closed);

	return blockers;
}

/** Línea de la emitida en la forma que espera `insertMirrorCreditNote`. */
export const mirrorLineOf = (row: EditLineRow, invoiceId: string): ChangeInvoiceLineRow => ({
	id: row.id,
	invoice_id: invoiceId,
	contract_item_id: row.contract_item_id,
	product_id: row.product_id,
	description: row.description,
	quantity: row.quantity,
	unit_price: row.unit_price,
	unit_price_invoice: row.unit_price_invoice,
	discount_pct: row.discount_pct,
	subtotal: row.subtotal,
	subtotal_invoice: row.subtotal_invoice,
	tax_amount: row.tax_amount,
	tax_amount_invoice: row.tax_amount_invoice,
	total: row.total,
	total_invoice: row.total_invoice,
	billing_period_start: row.billing_period_start,
	billing_period_end: row.billing_period_end,
	unit_of_measure: row.unit_of_measure,
	quantity_source: row.quantity_source,
	visible_line_id: row.visible_line_id ?? null,
});

/** Tasa de IVA en porcentaje (las facturas del front viejo pueden traer 0,19). */
export const taxPct = (rate: number | null): number => (rate === null ? 0 : rate > 0 && rate <= 1 ? round2(rate * 100) : rate);

export interface CreditNoteLineView {
	source_line_id: string;
	contract_item_id: string | null;
	product_name: string | null;
	description: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	/** Montos NEGATIVOS de la NC (moneda de contrato y de factura). */
	subtotal_contract_currency: number;
	subtotal_invoice_currency: number | null;
	tax_contract_currency: number;
	tax_invoice_currency: number | null;
	total_contract_currency: number;
	total_invoice_currency: number | null;
}

export interface CreditNoteView {
	credit_type: 'cancellation' | 'discount';
	credit_reason: string;
	nc_revenue_treatment: string | null;
	status: 'Por Emitir';
	issue_date: string;
	due_date: null;
	related_invoice_id: string;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
	lines: CreditNoteLineView[];
	totals: MirrorCreditNoteAmounts['header'];
}

type MirrorInput = Array<{ line: ChangeInvoiceLineRow; ratio: number; period_start: string }>;

function creditNoteView(
	invoice: IssuedInvoiceRow,
	rows: EditLineRow[],
	mirror: MirrorInput,
	computed: MirrorCreditNoteAmounts,
	meta: Pick<CreditNoteView, 'credit_type' | 'credit_reason' | 'nc_revenue_treatment' | 'issue_date'>
): CreditNoteView {
	const byId = new Map(rows.map((row) => [row.id, row]));

	return {
		...meta,
		status: 'Por Emitir',
		due_date: null,
		related_invoice_id: invoice.id,
		contract_currency: invoice.contract_currency,
		invoice_currency: invoice.invoice_currency,
		fx_contract_to_invoice: invoice.fx_contract_to_invoice,
		lines: mirror.map(({ line }, index) => {
			const amount = computed.lines[index];

			return {
				source_line_id: line.id,
				contract_item_id: line.contract_item_id,
				product_name: byId.get(line.id)?.product_name ?? null,
				description: line.description,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
				subtotal_contract_currency: -amount.subtotal,
				subtotal_invoice_currency: amount.subtotal_invoice === null ? null : -amount.subtotal_invoice,
				tax_contract_currency: -amount.tax,
				tax_invoice_currency: amount.tax_invoice === null ? null : -amount.tax_invoice,
				total_contract_currency: -round2(amount.subtotal + amount.tax),
				total_invoice_currency: amount.subtotal_invoice === null ? null : -round2(amount.subtotal_invoice + (amount.tax_invoice ?? 0)),
			};
		}),
		totals: computed.header,
	};
}

const monthOf = (date: string) => `${date.slice(0, 7)}-01`;
const firstMonth = (dates: Array<string | null | undefined>): string | null => {
	const sorted = dates.filter((value): value is string => !!value).sort();

	return sorted.length ? monthOf(sorted[0]) : null;
};

/**
 * Parte que queda de cada línea tras las NC de descuento vigentes (`previous`), como ratio sobre su neto: se cruzan por ítem y período (como
 * las atribuye el devengo) y, si varias líneas comparten la clave, lo acreditado se consume en orden. En moneda de factura si la factura la
 * tiene (o con su tasa); si no, en moneda de contrato. Las líneas sin neto (la visible de una OC) quedan en 1.
 */
export function remainingRatios(
	invoice: Pick<IssuedInvoiceRow, 'fx_contract_to_invoice'>,
	rows: EditLineRow[],
	previous: PreviousDiscountLine[]
): Map<string, number> {
	const fx = invoice.fx_contract_to_invoice;
	const base = (row: Pick<EditLineRow, 'subtotal' | 'subtotal_invoice'>) =>
		row.subtotal_invoice !== null ? row.subtotal_invoice : fx !== null ? round2(row.subtotal * fx) : row.subtotal;
	const credited = new Map<string, number>();

	for (const line of previous) {
		const amount = Math.abs(line.subtotal_invoice ?? (fx !== null ? round2(line.subtotal * fx) : line.subtotal));

		credited.set(lineKey(line), round2((credited.get(lineKey(line)) ?? 0) + amount));
	}
	const ratios = new Map<string, number>();

	for (const row of rows) {
		const value = base(row);

		if (!(value > 0)) continue;
		const key = lineKey(row);
		const left = credited.get(key) ?? 0;
		const used = Math.min(value, left);

		credited.set(key, round2(left - used));
		ratios.set(row.id, used > 0 ? Math.max(0, (value - used) / value) : 1);
	}

	return ratios;
}

// ------------------------------------------------------------------ anular con NC espejo (§3.8)

export interface VoidInput {
	reason: VoidReason;
	notes?: string | null;
	reissue: boolean;
}

export interface VoidPlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	credit_note: CreditNoteView;
	/** Lo que se escribe con `insertMirrorCreditNote` (todas las líneas con monto o cantidad, ratio 1, IVA exacto). */
	mirror: MirrorInput;
	/** Primer mes del período de la emitida (rebuild del devengo). */
	rsm_from_month: string | null;
}

/**
 * NC espejo de la emitida: cada línea con cantidad o monto (las ocultas en 0 no aportan) por **lo que queda** de ella, con su IVA guardado
 * (al centavo en ambas monedas) si queda completa, mismo ítem y período. Las NC de descuento vigentes de la factura se descuentan por ítem
 * y período (`previous`, mismas filas que la NC de descuento) y se avisa `previous_credit_notes_considered`; nunca bloquean. Factura por OC:
 * van la visible del documento y sus internas (`insertMirrorCreditNote` le pone a la visible el unitario = Σ acreditado). Bloqueos de
 * emitida; aviso `paid_invoice_voided` si tiene pagos (Facturación decide la devolución).
 */
export function planVoid(
	invoice: IssuedInvoiceRow,
	rows: EditLineRow[],
	context: ContractInvoiceContext,
	input: VoidInput,
	previous: PreviousDiscountLine[] = []
): VoidPlan {
	const today = context.today;
	const blockers = issuedBlockers(invoice, context, today);
	const warnings: InvoiceWarning[] = [];

	if (invoice.paid || invoice.status === 'Pagada')
		warnings.push({
			code: 'paid_invoice_voided',
			message: `La factura ${invoice.invoice_number ?? invoice.id} tiene pagos registrados: la NC la anula y la devolución o aplicación del pago se decide en Facturación`,
		});
	if (invoice.odoo_invoice_id !== null || invoice.sent_to_odoo_at !== null)
		warnings.push({
			code: 'credit_note_to_erp',
			message: 'La factura está en el ERP: la NC queda Por Emitir y se emite desde Facturación contra ese documento',
		});
	const ratios = remainingRatios(invoice, rows, previous);
	const mirror: MirrorInput = rows
		.filter((row) => (row.quantity !== 0 || row.subtotal !== 0) && (ratios.get(row.id) ?? 1) > 0)
		.map((row) => ({
			line: mirrorLineOf(row, invoice.id),
			ratio: ratios.get(row.id) ?? 1,
			period_start: row.billing_period_start ?? row.billing_period_end ?? today,
		}));
	const computed = mirrorCreditNoteAmounts(mirror, taxPct(invoice.tax_rate), true);
	const creditNotes = [
		...new Map(
			previous.filter((line) => line.credit_note_id).map((line) => [line.credit_note_id!, line.credit_note_number ?? line.credit_note_id!])
		).values(),
	];

	if (previous.length)
		warnings.push({
			code: 'previous_credit_notes_considered',
			message: `La factura ya tiene NC de descuento vigentes${creditNotes.length ? ` (${creditNotes.join(', ')})` : ''}: la NC de anulación acredita solo lo que queda de cada línea`,
		});
	// Una factura por OC cuyas internas ya quedaron acreditadas solo dejaría su visible (sin monto): no hay nada que anular.
	const documentLines = new Set(rows.map((row) => row.visible_line_id).filter((id): id is string => !!id));

	if (!mirror.some((entry) => !documentLines.has(entry.line.id)))
		blockers.push({
			code: 'no_lines',
			message: previous.length
				? 'Las NC de descuento vigentes ya acreditan toda la factura: no queda monto que anular'
				: 'La factura no tiene líneas con monto que anular',
			next_step: 'Revísala en Facturación',
		});

	return {
		blockers,
		warnings,
		credit_note: creditNoteView(invoice, rows, mirror, computed, {
			credit_type: 'cancellation',
			credit_reason: voidCreditReason(input.reason),
			nc_revenue_treatment: null,
			issue_date: today,
		}),
		mirror,
		rsm_from_month: firstMonth(rows.map((row) => row.billing_period_start)),
	};
}

/**
 * Contexto del editor para la **reemisión**: la emitida vista como una Por Emitir nueva (sin folio, sin ERP, fecha de emisión `issueDate`
 * y vencimiento por la condición de pago) con sus mismas líneas, y sin la emitida entre los períodos ya emitidos ni entre "otras facturas"
 * del conciliador (la reemisión toma su lugar). Así `reissue_changes` pasa por **la misma lógica** que `PUT …/:invoiceId` (§3.4).
 */
export function reissueEditContext(ctx: EditContext, issueDate: string): EditContext {
	const original = ctx.invoice;

	return {
		...ctx,
		invoice: {
			...original,
			id: original.id,
			invoice_number: null,
			status: 'Por Emitir',
			is_active: true,
			no_charge: false,
			issue_date: issueDate,
			scheduled_at: issueDate,
			original_issue_date: issueDate,
			due_date: invoiceDueDate(issueDate, ctx.context),
			odoo_invoice_id: null,
			sent_to_odoo_at: null,
			sent_at: null,
			issued_externally: false,
			notes: `Reemplaza a ${original.invoice_number ?? original.id}`,
		},
		issued_periods: ctx.issued_periods.filter((period) => period.invoice_id !== original.id),
	};
}

/**
 * Plan de la reemisión: el editor sobre el contexto de reemisión; sin cambios = copia exacta de las líneas y del encabezado. La fecha de
 * emisión es la de `changes.issue_date` o hoy (una nueva Por Emitir), con vencimiento por la condición de pago salvo `changes.due_date`.
 */
export function planReissue(ctx: EditContext, changes: InvoiceEditInput | null | undefined): EditPlan {
	const issueDate = changes?.issue_date ?? ctx.context.today;
	const reissueCtx = reissueEditContext(ctx, issueDate);
	const input: InvoiceEditInput = { ...(changes ?? {}) };

	// La fecha ya es la del contexto; las notas de la reemisión siempre dicen a quién reemplaza (las del cuerpo se agregan).
	delete input.issue_date;
	delete input.notes;
	const plan = planInvoiceEdit(reissueCtx, input);
	const extra = changes?.notes?.trim();

	plan.header.after = { ...plan.header.after, notes: extra ? `${reissueCtx.invoice.notes} · ${extra}` : reissueCtx.invoice.notes };

	return plan;
}

// ------------------------------------------------------------------ NC de descuento parcial sobre una emitida (§8)

export interface DiscountLineInput {
	line_id: string;
	/** Monto NETO del descuento en MONEDA DE FACTURA (la del documento). */
	amount?: number | null;
	/** Porcentaje del neto original de la línea. */
	pct?: number | null;
}

export interface DiscountCreditNoteInput {
	lines?: DiscountLineInput[] | null;
	/** Porcentaje sobre todas las líneas con monto (en vez de `lines`). */
	pct?: number | null;
	reason: DiscountCreditReason;
	revenue_treatment: OneOffRevenueTreatment;
	notes?: string | null;
}

/** Línea de una NC de descuento previa de la misma factura (montos NEGATIVOS guardados). */
export interface PreviousDiscountLine {
	/** NC de descuento a la que pertenece la línea (para el aviso `previous_credit_notes_considered`). */
	credit_note_id?: string | null;
	credit_note_number?: string | null;
	contract_item_id: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	subtotal: number;
	subtotal_invoice: number | null;
}

export interface DiscountPlan {
	errors: FieldError[];
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	credit_note: CreditNoteView;
	/** Por línea afectada: neto original, ya descontado por NC previas, lo pedido y lo que queda (moneda de factura). */
	lines: Array<{
		line_id: string;
		contract_item_id: string | null;
		original_amount: number;
		previously_credited: number;
		requested: number;
		remaining_after: number;
	}>;
	revenue_effect: RevenueEffect;
	mirror: MirrorInput;
	rsm_from_month: string | null;
	can_apply: boolean;
}

const lineKey = (row: { contract_item_id: string | null; billing_period_start: string | null; billing_period_end: string | null }) =>
	`${row.contract_item_id ?? ''}|${row.billing_period_start ?? ''}|${row.billing_period_end ?? ''}`;

/**
 * NC de descuento parcial sobre una emitida (decisión de Domi 30-09: el tercer motivo de NC, "descuento puntual", sobre una factura ya
 * emitida). Una línea negativa por línea afectada (mismo ítem y período, cantidad 1 y unitario = −monto, patrón NC32), montos en ambas
 * monedas con la tasa de la original (ratio del neto en moneda de factura), IVA = neto × tasa de la original. `exceeds_line` si lo pedido
 * supera lo que queda de la línea tras las NC de descuento previas (se cruzan por ítem y período, como las atribuye el devengo).
 */
export function planDiscountCreditNote(
	invoice: IssuedInvoiceRow,
	rows: EditLineRow[],
	previous: PreviousDiscountLine[],
	context: ContractInvoiceContext,
	items: Map<string, Pick<EditItem, 'start_date' | 'end_date' | 'term_months'>>,
	input: DiscountCreditNoteInput
): DiscountPlan {
	const today = context.today;
	const errors: FieldError[] = [];
	const blockers = issuedBlockers(invoice, context, today);
	const warnings: InvoiceWarning[] = [];
	const fx = invoice.fx_contract_to_invoice;
	const invoiceAmount = (row: Pick<EditLineRow, 'subtotal' | 'subtotal_invoice'>): number | null =>
		row.subtotal_invoice !== null ? row.subtotal_invoice : fx !== null ? round2(row.subtotal * fx) : null;
	const eligible = rows.filter((row) => row.subtotal > 0);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const hasLines = (input.lines ?? []).length > 0;
	const hasPct = input.pct !== undefined && input.pct !== null;

	if (hasLines === hasPct)
		errors.push({ field: 'lines', message: 'Indica las líneas a descontar (lines) o un porcentaje para todas (pct), no ambos' });
	if (hasPct && !(Number(input.pct) > 0 && Number(input.pct) <= 100))
		errors.push({ field: 'pct', message: 'El porcentaje debe ser mayor que 0 y hasta 100' });
	const requests: Array<{ row: EditLineRow; amount: number; index: number | null }> = [];
	// Factura por OC (§3.7b): el descuento es del DOCUMENTO (su línea visible): un ratio sobre el neto de la OC que se aplica igual a la
	// visible y a cada interna (la selección de internas de la UI se reemplaza por ese ratio).
	const documentIds = new Set(rows.map((row) => row.visible_line_id).filter((id): id is string => !!id));
	const internals = rows.filter((row) => row.visible_line_id && row.subtotal > 0);
	let documentRatio: number | null = null;

	if (documentIds.size && (hasLines || hasPct)) {
		const documentBase = round2(internals.reduce((sum, row) => sum + (invoiceAmount(row) ?? 0), 0));
		let total = 0;

		if (internals.some((row) => invoiceAmount(row) === null) || !(documentBase > 0))
			errors.push({
				field: hasPct ? 'pct' : 'lines',
				message: 'La factura no tiene montos en moneda de factura: no se puede descontar desde aquí',
			});
		else if (hasPct) total = round2((documentBase * Number(input.pct)) / 100);
		else {
			const seen = new Set<string>();

			(input.lines ?? []).forEach((line, index) => {
				const field = (name: string) => `lines.${index}.${name}`;
				const row = byId.get(line.line_id);
				const hasAmount = line.amount !== undefined && line.amount !== null;
				const hasLinePct = line.pct !== undefined && line.pct !== null;

				if (seen.has(line.line_id)) return errors.push({ field: field('line_id'), message: 'La línea viene repetida' });
				seen.add(line.line_id);
				if (!row) return errors.push({ field: field('line_id'), message: 'La línea no pertenece a esta factura' });
				const base = documentIds.has(row.id) ? documentBase : (invoiceAmount(row) ?? 0);

				if (!(base > 0)) return errors.push({ field: field('line_id'), message: 'La línea no tiene monto que descontar' });
				if (hasAmount === hasLinePct)
					return errors.push({ field: field('amount'), message: 'Indica el monto o el porcentaje de la línea (uno de los dos)' });
				if (hasLinePct && !(Number(line.pct) > 0 && Number(line.pct) <= 100))
					return errors.push({ field: field('pct'), message: 'El porcentaje debe ser mayor que 0 y hasta 100' });
				if (hasAmount && !(Number(line.amount) > 0)) return errors.push({ field: field('amount'), message: 'El monto debe ser mayor que 0' });
				total = round2(total + (hasAmount ? round2(Number(line.amount)) : round2((base * Number(line.pct)) / 100)));
			});
		}
		if (total > 0 && documentBase > 0) {
			documentRatio = total / documentBase;
			// Cada interna lleva la misma parte; el centavo residual va a la interna mayor (Σ internas = lo pedido, igual a la visible).
			const amounts = internals.map((row) => round2((invoiceAmount(row) ?? 0) * documentRatio!));
			const residual = round2(total - amounts.reduce((sum, value) => sum + value, 0));

			if (residual !== 0 && amounts.length) {
				let largest = 0;

				internals.forEach((row, index) => {
					if ((invoiceAmount(row) ?? 0) > (invoiceAmount(internals[largest]) ?? 0)) largest = index;
				});
				amounts[largest] = round2(amounts[largest] + residual);
			}
			internals.forEach((row, index) => {
				if (amounts[index] > 0) requests.push({ row, amount: amounts[index], index: null });
			});
			warnings.push({
				code: 'partial_billing_whole_document',
				message: `La factura se facturó por OC: el descuento (${total} ${invoice.invoice_currency ?? ''}) se aplica como ${round2(
					documentRatio * 100
				)} % del documento a su línea visible y a cada línea interna`.replace(/\s+\)/, ')'),
			});
		}
	} else if (hasLines) {
		const seen = new Set<string>();

		(input.lines ?? []).forEach((line, index) => {
			const field = (name: string) => `lines.${index}.${name}`;
			const row = byId.get(line.line_id);
			const hasAmount = line.amount !== undefined && line.amount !== null;
			const hasLinePct = line.pct !== undefined && line.pct !== null;

			if (seen.has(line.line_id)) errors.push({ field: field('line_id'), message: 'La línea viene repetida' });
			seen.add(line.line_id);
			if (!row) return errors.push({ field: field('line_id'), message: 'La línea no pertenece a esta factura' });
			if (!(row.subtotal > 0)) return errors.push({ field: field('line_id'), message: 'La línea no tiene monto que descontar' });
			if (hasAmount === hasLinePct)
				return errors.push({ field: field('amount'), message: 'Indica el monto o el porcentaje de la línea (uno de los dos)' });
			if (hasLinePct && !(Number(line.pct) > 0 && Number(line.pct) <= 100))
				return errors.push({ field: field('pct'), message: 'El porcentaje debe ser mayor que 0 y hasta 100' });
			if (hasAmount && !(Number(line.amount) > 0)) return errors.push({ field: field('amount'), message: 'El monto debe ser mayor que 0' });
			const base = invoiceAmount(row);

			if (base === null)
				return errors.push({
					field: field('line_id'),
					message: 'La línea no tiene monto en moneda de factura: no se puede descontar desde aquí',
				});
			requests.push({ row, amount: hasAmount ? round2(Number(line.amount)) : round2((base * Number(line.pct)) / 100), index });
		});
	} else if (hasPct) {
		for (const row of eligible) {
			const base = invoiceAmount(row);

			if (base === null) {
				errors.push({ field: 'pct', message: 'La factura no tiene montos en moneda de factura: no se puede descontar desde aquí' });
				break;
			}
			requests.push({ row, amount: round2((base * Number(input.pct)) / 100), index: null });
		}
	}
	// Lo ya descontado por NC de descuento previas, por ítem y período (moneda de factura, positivo).
	const credited = new Map<string, number>();

	for (const line of previous) {
		const amount = Math.abs(line.subtotal_invoice ?? (fx !== null ? round2(line.subtotal * fx) : line.subtotal));

		credited.set(lineKey(line), round2((credited.get(lineKey(line)) ?? 0) + amount));
	}
	const originalByKey = new Map<string, number>();

	for (const row of eligible) originalByKey.set(lineKey(row), round2((originalByKey.get(lineKey(row)) ?? 0) + (invoiceAmount(row) ?? 0)));
	const requestedByKey = new Map<string, number>();

	for (const request of requests)
		requestedByKey.set(lineKey(request.row), round2((requestedByKey.get(lineKey(request.row)) ?? 0) + request.amount));
	for (const [key, requested] of requestedByKey) {
		const remaining = round2((originalByKey.get(key) ?? 0) - (credited.get(key) ?? 0));

		if (requested > remaining + DISCOUNT_TOLERANCE) {
			const row = requests.find((request) => lineKey(request.row) === key)!.row;

			blockers.push({
				code: 'exceeds_line',
				message:
					`El descuento de "${row.product_name ?? row.description ?? 'la línea'}" (${row.billing_period_start ?? ''}) es ${requested} ${
						invoice.invoice_currency ?? ''
					} y a la línea le quedan ${Math.max(0, remaining)} (neto ${originalByKey.get(key) ?? 0}, ya descontado ${credited.get(key) ?? 0})`.replace(
						/\s+\(/g,
						' ('
					),
				next_step: 'Baja el monto: una NC de descuento no puede dejar la línea en negativo; para anularla completa usa Anular',
			});
		}
	}
	const documentMirror: MirrorInput =
		documentRatio === null
			? []
			: rows
					.filter((row) => documentIds.has(row.id))
					.map((row) => ({
						line: { ...mirrorLineOf(row, invoice.id), subtotal_invoice: row.subtotal_invoice ?? (fx !== null ? 0 : null) },
						ratio: documentRatio!,
						period_start: row.billing_period_start ?? row.billing_period_end ?? today,
					}));
	const mirror: MirrorInput = [
		...documentMirror,
		...requests.map(({ row, amount }) => {
			const base = invoiceAmount(row) ?? 0;

			return {
				line: { ...mirrorLineOf(row, invoice.id), subtotal_invoice: base },
				ratio: base > 0 ? amount / base : 0,
				period_start: row.billing_period_start ?? row.billing_period_end ?? today,
			};
		}),
	];
	const computed = mirrorCreditNoteAmounts(mirror, taxPct(invoice.tax_rate));
	const revenueEffect = oneOffRevenueEffect(
		mirror
			.map(({ line }, index) => ({
				contract_item_id: line.contract_item_id ?? '',
				amount: -computed.lines[index].subtotal,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
			}))
			.filter((entry) => entry.amount !== 0),
		input.revenue_treatment,
		today,
		new Map(
			[...items.entries()].map(([id, item]) => [
				id,
				{ start_date: item.start_date, end_date: item.end_date, term_months: item.term_months ?? null },
			])
		)
	);

	if (invoice.odoo_invoice_id !== null || invoice.sent_to_odoo_at !== null)
		warnings.push({
			code: 'credit_note_to_erp',
			message: 'La factura está en el ERP: la NC queda Por Emitir y se emite desde Facturación contra ese documento',
		});
	if (invoice.paid || invoice.status === 'Pagada')
		warnings.push({
			code: 'paid_invoice_discounted',
			message: 'La factura tiene pagos registrados: el saldo a favor del cliente se resuelve en Facturación',
		});

	return {
		errors,
		blockers,
		warnings,
		credit_note: creditNoteView(invoice, rows, mirror, computed, {
			credit_type: 'discount',
			credit_reason: input.reason,
			nc_revenue_treatment: input.revenue_treatment,
			issue_date: today,
		}),
		lines: requests.map(({ row, amount }) => {
			const key = lineKey(row);
			const original = invoiceAmount(row) ?? 0;

			return {
				line_id: row.id,
				contract_item_id: row.contract_item_id,
				original_amount: original,
				previously_credited: credited.get(key) ?? 0,
				requested: amount,
				remaining_after: round2((originalByKey.get(key) ?? 0) - (credited.get(key) ?? 0) - (requestedByKey.get(key) ?? 0)),
			};
		}),
		revenue_effect: revenueEffect,
		mirror,
		rsm_from_month: firstMonth([
			today,
			...requests.map(({ row }) => row.billing_period_start),
			...revenueEffect.by_month.map((entry) => entry.month),
		]),
		can_apply: blockers.length === 0 && errors.length === 0 && requests.length > 0,
	};
}
