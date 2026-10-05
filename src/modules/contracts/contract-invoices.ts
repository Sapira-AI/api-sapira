import { addMonths, computeDueDate, diffDays, round2 } from './billing-engine';
import { type HeaderAmounts, headerFromLines } from './consumption';
import {
	creditNotePendingEmission,
	isCreditNote,
	PENDING_STATUS,
	PRODUCT_WITHOUT_ERP_MAPPING_CODE,
	UNMAPPED_PRODUCTS_SQL,
	unmappedProductsMessage,
} from './contract-360';
import { cleanPaymentTerms } from './contract-drafts.service';
import { CONSOLIDATION_EVENT_TYPES } from './invoice-consolidation-read';
import { codedValidationException, MULTICURRENCY_CODES, pairKey, upperCode, valuateLinesByPair } from './multicurrency';

/**
 * Facturas en el Contrato 360, etapas 1 y 2 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.1–3.3): lógica pura, sin base.
 * Enviar al ERP ahora, registrar emisión externa, reprogramar (una o masivo) y tipo de cambio por factura (una o masivo). El servicio
 * (`contract-invoices.service.ts`) carga, bloquea y escribe; aquí vive lo que se prueba sin base: bloqueos, matemática FX (incluido el
 * neto exacto de `apply_fixed_fx_to_contract`), fechas de reprogramación y vencimiento.
 */

export const round6 = (value: number): number => Math.round(value * 1e6) / 1e6 || 0;

export const INVOICE_FX_POLICIES = ['spot', 'fixed', 'net_exact'] as const;
export type InvoiceFxPolicy = (typeof INVOICE_FX_POLICIES)[number];
/**
 * Política FX DERIVADA de la factura (regla de Domi 29-09: nada nuevo que duplique lo existente): `same_currency` si factura y contrato
 * comparten moneda; con conversión, `fixed` si `invoices.fx_contract_to_invoice` tiene valor y `spot` si es NULL (se valoriza al emitir).
 * `net_exact` es un modo de `fixed` cuyo origen queda en `invoice_items.fx_rate_source = 'net_exact'` y en el evento.
 */
export type StoredFxPolicy = 'same_currency' | 'spot' | 'fixed';
/** Origen de la tasa, en `invoice_items.fx_rate_source` (texto libre ya existente; v2 escribe manual | net_exact) y en el evento. */
export type FxRateSource = 'contract' | 'manual' | 'official' | 'net_exact' | string;

export const INVOICE_EVENT_TYPES = {
	send_now: 'INVOICE_SENT_MANUALLY',
	mark_issued: 'INVOICE_ISSUED_EXTERNALLY',
	reschedule: 'INVOICE_RESCHEDULED',
	fx: 'INVOICE_FX_CHANGED',
	// Etapa 3 (§3.6, §3.7a): descripciones de líneas, plantilla del contrato y referencias OC/HES.
	descriptions: 'INVOICE_DESCRIPTIONS_UPDATED',
	description_template: 'CONTRACT_DESCRIPTION_TEMPLATE_CHANGED',
	references: 'INVOICE_REFERENCES_UPDATED',
	// Etapa 4 (§3.4): editar una Por Emitir como un todo y explicar un desvío contra el plan.
	edit: 'INVOICE_EDITED',
	deviation: 'INVOICE_DEVIATION_EXPLAINED',
	// Restablecer el borrador del ERP (reemplaza por ahora el `erp-withdraw` oculto, §3.1).
	erp_reset: 'INVOICE_ERP_DRAFT_RESET',
	// Sin cobro: una Por Emitir cuyas líneas quedan todas en 0 pasa a Cancelada (y vuelve a Por Emitir si recupera cantidad).
	no_charge: 'INVOICE_NO_CHARGE',
	no_charge_reverted: 'INVOICE_NO_CHARGE_REVERTED',
	// Etapa 5 (§3.5): reorganizar el cronograma (juntar, mover, dividir, atajos por ítem y cuadre de redondeo).
	reorganize: 'INVOICES_REORGANIZED',
	// Etapa 6 (§3.7b, §3.8, §8): anular con NC espejo y reemitir, NC de descuento parcial sobre una emitida y facturar por OC.
	voided: 'INVOICE_VOIDED',
	reissued: 'INVOICE_REISSUED',
	credit_note: 'INVOICE_CREDIT_NOTE_CREATED',
	partial_billing: 'INVOICE_PARTIAL_BILLING',
	// Multimoneda §7: consolidación opcional entre contratos (uno por contrato) y deshacerla.
	consolidated: CONSOLIDATION_EVENT_TYPES.consolidated,
	consolidation_undone: CONSOLIDATION_EVENT_TYPES.undone,
} as const;

export { noChargeSql } from './contract-360';
export type InvoiceEventType = (typeof INVOICE_EVENT_TYPES)[keyof typeof INVOICE_EVENT_TYPES];

export const ISSUED_STATUS = 'Emitida';

export interface InvoiceBlocker {
	code: string;
	message: string;
	next_step: string | null;
	/**
	 * Acción que la UI puede ofrecer para destrabar: `erp_reset` en `sent_to_erp_draft` → "Restablecer borrador y editar"; `map_product` en
	 * `product_without_erp_mapping` → mapear el producto en Integraciones › ERP.
	 */
	action?: 'erp_reset' | 'map_product';
}
export interface InvoiceWarning {
	code: string;
	message: string;
}

/** Factura del contrato con lo que necesitan las cuatro operaciones (una fila de `loadInvoice`). */
export interface ContractInvoiceRow {
	id: string;
	invoice_number: string | null;
	status: string | null;
	document_type: string | null;
	invoice_type: string | null;
	is_active: boolean;
	is_legacy: boolean;
	issue_date: string | null;
	original_issue_date: string | null;
	scheduled_at: string | null;
	due_date: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	amount_contract_currency: number;
	amount_invoice_currency: number | null;
	vat: number | null;
	total_invoice_currency: number | null;
	fx_contract_to_invoice: number | null;
	tax_rate: number | null;
	/** Origen de la tasa según las líneas (`invoice_items.fx_rate_source` más frecuente), null si ninguna lo tiene. */
	fx_rate_source: FxRateSource | null;
	/** Cuándo se confirmó la política/tasa por última vez (evento `INVOICE_FX_CHANGED`), null si nunca. */
	fx_confirmed_at: string | null;
	/** Derivado: existe un evento `INVOICE_ISSUED_EXTERNALLY` de la factura. */
	issued_externally: boolean;
	odoo_invoice_id: number | null;
	sent_to_odoo_at: string | null;
	/** `invoices.sent_at` (lo limpia "Restablecer borrador del ERP", igual que la función vieja). */
	sent_at: string | null;
	/** Cancelada "sin cobro" (todas sus líneas en 0, evento INVOICE_NO_CHARGE): se puede reactivar. Derivado de eventos. */
	no_charge?: boolean;
	auto_invoice: boolean;
	requires_references: boolean;
	consolidated_into_invoice_id: string | null;
	client_entity_id: string | null;
	company_id: string | null;
	legal_name: string | null;
	period_start: string | null;
	period_end: string | null;
	lines_count: number;
	lines_without_product: number;
	/**
	 * Productos (nombre) de las líneas que viajarían al ERP sin producto de Odoo resoluble (`UNMAPPED_PRODUCTS_SQL`): el scheduler los
	 * rechaza (`product_without_erp_mapping`) en vez de mandarlos como producto 1. Ausente = no se cargó (sin bloqueo).
	 */
	unmapped_products?: string[];
	references_count: number;
	/** Σ cantidad × unitario en moneda de contrato (base del neto exacto, sin redondeos de subtotal). */
	priced_base: number;
	/** Etapa 6 (§3.7b): líneas internas (`visible_line_id` NOT NULL) = la factura se facturó por OC con una línea visible. */
	internal_lines?: number;
	/** Devengo del descuento puntual de la factura (`invoices.nc_revenue_treatment`); null/ausente = sin descuento puntual. */
	nc_revenue_treatment?: string | null;
	/** Alguna línea tiene una tasa fijada explícitamente desde el 360 (`fx_rate_source` manual o net_exact, `EXPLICIT_FX_SOURCES`). */
	fx_explicit?: boolean;
}

/** Orígenes de tasa que fijan la factura aunque el contrato sea spot (mismo criterio que el envío al ERP del scheduler). */
export const EXPLICIT_FX_SOURCES = ['manual', 'net_exact'] as const;

/** Contrato, compañía y razón social que gobiernan la factura. */
export interface ContractInvoiceContext {
	contract_id: string;
	contract_number: string | null;
	contract_status: string | null;
	contract_fx_invoice_policy: string | null;
	contract_requires_references: boolean;
	/** `auto_send_to_odoo` con NULL = sí (mismo criterio que el scheduler). */
	auto_send_to_erp: boolean;
	payment_terms: unknown;
	entity_payment_terms: unknown;
	company_country: string | null;
	has_erp_integration: boolean;
	has_erp_partner: boolean;
	has_entity: boolean;
	/** Cierre de períodos de la compañía (`get_cutoff_date`), o null. */
	cutoff_date: string | null;
	today: string;
}

export interface ContractInvoiceLineRow {
	id: string;
	quantity: number;
	unit_price_contract_currency: number;
	subtotal_contract_currency: number;
	tax_amount_contract_currency: number;
	total_contract_currency: number;
	unit_price_invoice_currency: number | null;
	subtotal_invoice_currency: number | null;
	tax_amount_invoice_currency: number | null;
	total_invoice_currency: number | null;
	created_at: string | null;
	/** Multimoneda: moneda de origen de la línea (`invoice_items.contract_currency` = moneda del ítem); ausente = la del encabezado. */
	currency?: string | null;
	/** Multimoneda: inicio del período de la línea. */
	billing_period_start?: string | null;
}

/** Mismo código que el scheduler (`invoice-scheduler.service.ts` `CREDIT_NOTE_SEND_PENDING`). */
export const CREDIT_NOTE_SEND_PENDING_CODE = 'credit_note_send_pending';

export const UNIFY_STEP = 'Desunifica el documento en Facturación y vuelve a intentarlo';

// ---------------------------------------------------------------- producto sin mapeo al ERP

export { PRODUCT_WITHOUT_ERP_MAPPING_CODE, UNMAPPED_PRODUCTS_SQL, unmappedProductsMessage };
export const MAP_PRODUCT_STEP = 'Mapea el producto en Integraciones › ERP';

/** Bloqueo `product_without_erp_mapping` si alguna línea que viajaría al ERP no resuelve a un producto de Odoo; null si todo resuelve. */
export function productMappingBlocker(products: string[] | undefined): InvoiceBlocker | null {
	if (!products?.length) return null;

	return { code: PRODUCT_WITHOUT_ERP_MAPPING_CODE, message: unmappedProductsMessage(products), next_step: MAP_PRODUCT_STEP, action: 'map_product' };
}

// ---------------------------------------------------------------- bloqueos comunes

/** Bloqueos comunes de toda operación sobre una Por Emitir (spec §3, convenciones): solo Por Emitir activa, no unificada, no NC/ND, no legacy. */
export function commonBlockers(invoice: ContractInvoiceRow): InvoiceBlocker[] {
	const blockers: InvoiceBlocker[] = [];

	if (isCreditNote(invoice.document_type) || invoice.document_type === 'ND') {
		// Las NC que crea la API nacen siempre Emitida y quedan pendientes de emisión electrónica (no son facturas por enviar).
		const pendingEmission = creditNotePendingEmission(invoice);

		blockers.push({
			code: 'credit_note',
			message: pendingEmission
				? 'Nota de crédito pendiente de emisión electrónica: no se edita desde el contrato'
				: 'Las notas de crédito y débito no se editan desde el contrato',
			next_step: pendingEmission ? 'Se emitirá cuando exista la emisión de NC en el ERP' : 'Gestiónala en Facturación',
		});

		return blockers;
	}
	if (invoice.status !== PENDING_STATUS || !invoice.is_active) {
		blockers.push({
			code: 'not_pending',
			message: `La factura ${invoice.invoice_number ?? invoice.id} no está Por Emitir (estado: ${invoice.status ?? 'sin estado'}${
				invoice.is_active ? '' : ', inactiva'
			})`,
			next_step: null,
		});
	}
	if (invoice.consolidated_into_invoice_id || invoice.invoice_type === 'Unificada' || invoice.invoice_type === 'Consolidada') {
		blockers.push({ code: 'unified_invoice', message: 'Es un documento unificado o consolidado entre facturas', next_step: UNIFY_STEP });
	}
	if (invoice.is_legacy) {
		blockers.push({ code: 'legacy_invoice', message: 'Es una factura importada (legacy): no se opera desde el contrato', next_step: null });
	}

	return blockers;
}

/**
 * Ya está en el ERP como borrador: bloquea reprogramar, FX, emisión externa y edición. Lleva `action: 'erp_reset'` para que la UI ofrezca
 * "Restablecer borrador y editar" (`POST …/:invoiceId/erp-reset`, que desvincula la factura; el borrador en Odoo se elimina allá).
 */
export function erpDraftBlocker(invoice: ContractInvoiceRow): InvoiceBlocker | null {
	if (invoice.odoo_invoice_id === null) return null;

	return {
		code: 'sent_to_erp_draft',
		message: `La factura ya está en el ERP como borrador (id ${invoice.odoo_invoice_id}, enviada ${invoice.sent_to_odoo_at?.slice(0, 10) ?? ''})`,
		next_step: 'Restablece el borrador del ERP (y elimínalo en el ERP) antes de cambiarla, o edítala en el ERP',
		action: 'erp_reset',
	};
}

/**
 * Facturada por OC (§3.7b): la línea visible del documento lleva el neto de la OC y las internas el detalle por ítem y período. Editar
 * líneas, reorganizar o cambiar el tipo de cambio rompería "visible = Σ internas" y el neto exacto de la OC: se bloquea.
 */
export function partialBillingBlocker(invoice: Pick<ContractInvoiceRow, 'internal_lines' | 'invoice_number' | 'id'>): InvoiceBlocker | null {
	if (!invoice.internal_lines) return null;

	return {
		code: 'partial_billing_invoice',
		message: `La factura ${invoice.invoice_number ?? invoice.id} se factura por OC (una línea visible con ${invoice.internal_lines} ${
			invoice.internal_lines === 1 ? 'línea interna' : 'líneas internas'
		}): sus líneas, su tipo de cambio y su lugar en el cronograma quedan fijos`,
		next_step: 'Si la OC cambió, anula la emitida con NC y reemite, o ajusta el saldo en su factura de saldo',
	};
}

export const isMultiCurrency = (invoice: Pick<ContractInvoiceRow, 'contract_currency' | 'invoice_currency'>) =>
	!!invoice.invoice_currency && !!invoice.contract_currency && invoice.invoice_currency.toUpperCase() !== invoice.contract_currency.toUpperCase();

/** Política FX efectiva de la factura: la propia y, si no tiene, la del contrato (transición U12/B3). */
export const effectiveFxPolicy = (
	invoice: Pick<ContractInvoiceRow, 'fx_contract_to_invoice' | 'contract_currency' | 'invoice_currency'>,
	context: Pick<ContractInvoiceContext, 'contract_fx_invoice_policy'>
): StoredFxPolicy | null =>
	!isMultiCurrency(invoice)
		? 'same_currency'
		: invoice.fx_contract_to_invoice !== null
			? 'fixed'
			: context.contract_fx_invoice_policy === 'fixed'
				? 'fixed'
				: context.contract_fx_invoice_policy === 'spot'
					? 'spot'
					: null;

/** Política derivada de la factura sola (sin mirar el contrato): la que ven la lista, el detalle y los eventos. */
export const derivedFxPolicy = (
	invoice: Pick<ContractInvoiceRow, 'fx_contract_to_invoice' | 'contract_currency' | 'invoice_currency'>
): StoredFxPolicy => (!isMultiCurrency(invoice) ? 'same_currency' : invoice.fx_contract_to_invoice !== null ? 'fixed' : 'spot');

/** Tasa con la que se valorizaría hoy: la fija de la factura, o la pegada por el contrato; null en spot sin tasa. */
export const effectiveFxRate = (invoice: Pick<ContractInvoiceRow, 'fx_contract_to_invoice'>) => invoice.fx_contract_to_invoice;

// ---------------------------------------------------------------- enviar al ERP ahora (§3.1)

export interface SendNowPlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	summary: {
		legal_name: string | null;
		document_type: string | null;
		issue_date: string | null;
		invoice_currency: string | null;
		amount_contract_currency: number;
		total_invoice_currency: number | null;
		fx_policy: StoredFxPolicy | null;
		fx_rate: number | null;
		references_count: number;
		auto_invoice: boolean;
	};
}

/**
 * Los mismos bloqueos de la columna Bloqueos del 360 más los del envío puntual (`already_sent`, `erp_send_disabled`, `tax_rate_missing`,
 * `product_without_erp_mapping`).
 */
export function planSendNow(invoice: ContractInvoiceRow, context: ContractInvoiceContext): SendNowPlan {
	// NC/ND: el envío al ERP (`out_refund`) todavía no existe (Leon); se rechaza con un código propio, no el genérico de edición.
	const blockers = commonBlockers(invoice).map((blocker) =>
		blocker.code === 'credit_note'
			? {
					code: CREDIT_NOTE_SEND_PENDING_CODE,
					message: 'El envío de notas de crédito y débito al ERP todavía no está disponible',
					next_step: 'Se enviará cuando exista la emisión de NC en el ERP',
				}
			: blocker
	);
	const warnings: InvoiceWarning[] = [];
	const policy = effectiveFxPolicy(invoice, context);

	if (invoice.odoo_invoice_id !== null || invoice.sent_to_odoo_at !== null) {
		blockers.push({
			code: 'already_sent',
			message:
				invoice.odoo_invoice_id !== null
					? `Ya está en el ERP como borrador (id ${invoice.odoo_invoice_id})`
					: `Ya se envió al ERP el ${invoice.sent_to_odoo_at?.slice(0, 10) ?? ''}`.trim(),
			next_step: 'Retírala del ERP y vuelve a enviarla (próxima etapa)',
		});
	}
	if (!context.auto_send_to_erp) {
		blockers.push({
			code: 'erp_send_disabled',
			message: 'El contrato no envía facturas al ERP',
			next_step: 'Actívalo en Condiciones de facturación o registra la emisión externa',
		});
	}
	if (!context.has_erp_integration) {
		blockers.push({
			code: 'no_erp_integration',
			message: 'La compañía emisora no tiene integración con el ERP',
			next_step: 'Configura la integración en Configuración › Integraciones',
		});
	}
	if (!context.has_erp_partner) {
		blockers.push({
			code: 'no_erp_partner',
			message: context.has_entity
				? 'La razón social todavía no está vinculada a un cliente en el ERP'
				: 'El contrato no tiene razón social asignada',
			next_step: context.has_entity
				? 'Abre la razón social en Clientes › Razones sociales y usa «Vincular con Odoo»'
				: 'Asigna la razón social en el contrato',
		});
	}
	if ((context.contract_requires_references || invoice.requires_references) && invoice.references_count === 0) {
		blockers.push({
			code: 'needs_reference',
			message: 'El contrato exige referencias para facturar (por ejemplo, una orden de compra) y esta factura todavía no tiene ninguna',
			next_step: 'Agrega la referencia a la factura',
		});
	}
	if (invoice.lines_count === 0) {
		blockers.push({ code: 'no_lines', message: 'La factura no tiene líneas', next_step: null });
	}
	if (invoice.lines_without_product > 0) {
		blockers.push({
			code: 'item_without_product',
			message:
				invoice.lines_without_product === 1
					? 'Una línea no tiene un producto del catálogo asociado'
					: `${invoice.lines_without_product} líneas no tienen un producto del catálogo asociado`,
			next_step: 'Asocia el producto en el ítem del contrato',
		});
	}
	// Solo si la factura va por el ERP (si el contrato no envía o la compañía no tiene integración, ya lo dicen esos bloqueos).
	const unmapped = context.auto_send_to_erp && context.has_erp_integration ? productMappingBlocker(invoice.unmapped_products) : null;

	if (unmapped) blockers.push(unmapped);
	if (isMultiCurrency(invoice) && policy === 'fixed' && effectiveFxRate(invoice) === null) {
		blockers.push({
			code: 'fixed_fx_without_rate',
			message: 'Usa tipo de cambio fijo pero no tiene la tasa cargada',
			next_step: 'Confirma la tasa desde Tipo de cambio de la factura',
		});
	}
	if (invoice.tax_rate === null) {
		blockers.push({
			code: 'tax_rate_missing',
			message: 'La factura no tiene tasa de IVA',
			next_step: 'Completa la tasa de impuesto de la compañía',
		});
	}
	if (invoice.issue_date && invoice.issue_date < context.today) {
		warnings.push({ code: 'past_issue_date', message: `La fecha de emisión (${invoice.issue_date}) ya pasó: se envía igual con esa fecha` });
	}
	if (isMultiCurrency(invoice) && policy !== 'fixed') {
		warnings.push({
			code: 'spot_fx',
			message: 'Tipo de cambio spot: se valoriza con la tasa oficial de la fecha de emisión; si no hay tasa, el envío se detiene',
		});
	}

	return {
		blockers,
		warnings,
		can_apply: blockers.length === 0,
		summary: {
			legal_name: invoice.legal_name,
			document_type: invoice.document_type,
			issue_date: invoice.issue_date,
			invoice_currency: invoice.invoice_currency,
			amount_contract_currency: invoice.amount_contract_currency,
			total_invoice_currency: invoice.total_invoice_currency,
			fx_policy: policy,
			fx_rate: isMultiCurrency(invoice) ? effectiveFxRate(invoice) : null,
			references_count: invoice.references_count,
			auto_invoice: invoice.auto_invoice,
		},
	};
}

// ---------------------------------------------------------------- vencimiento

/** Vencimiento según la condición de pago del contrato (si no, la de la razón social; México +1 mes; nunca `+30` fijo salvo sin condición). */
export function invoiceDueDate(
	issueDate: string,
	context: Pick<ContractInvoiceContext, 'payment_terms' | 'entity_payment_terms' | 'company_country'>
): string {
	return computeDueDate(
		issueDate,
		cleanPaymentTerms(context.payment_terms) ?? cleanPaymentTerms(context.entity_payment_terms),
		context.company_country
	);
}

// ---------------------------------------------------------------- registrar emisión externa (§3.1)

export interface MarkIssuedInput {
	invoice_number: string;
	issue_date: string;
	fx_rate?: number | null;
	notes?: string | null;
}

export interface MarkIssuedPlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	before: { status: string | null; invoice_number: string | null; issue_date: string | null; due_date: string | null; fx_rate: number | null };
	after: { status: string; invoice_number: string; issue_date: string; due_date: string; fx_rate: number | null; issued_externally: true };
	/**
	 * Tasa que se ESCRIBE en `invoices.fx_contract_to_invoice`: solo cuando la factura estaba en spot (montos en moneda de factura NULL) y se
	 * valoriza con la tasa realizada; null = la tasa guardada no cambia (misma moneda, o factura ya valorizada: fija, neto exacto, OC).
	 */
	fx: number | null;
	/** La factura estaba en spot y se valoriza ahora con `fx` (líneas + encabezado). false = sus montos se conservan tal cual. */
	valuate: boolean;
	/** Líneas que se valorizan (solo spot); vacío = ninguna línea se reescribe. */
	lines: FxLineAmounts[];
	/** Encabezado = Σ líneas (`headerFromLines`), con las líneas valorizadas si `valuate`. */
	header: HeaderAmounts;
	rsm_from_month: string;
}

/**
 * Registrar una emisión externa (spec §3.1, decisión de Domi 01-10): **solo registra** folio, fecha y la tasa realizada; nunca reescribe
 * líneas ya valorizadas. Si los montos en moneda de factura están en NULL (spot), los completa (líneas y encabezado) con la tasa dada (o la
 * de la factura); si ya existen (fija, neto exacto, facturada por OC), quedan intactos y, si la tasa informada difiere de la guardada,
 * avisa `fx_mismatch` sin cambiar nada. Encabezado = Σ líneas. Una factura por OC se puede registrar: nunca se reescribe.
 */
export function planMarkIssued(
	invoice: ContractInvoiceRow,
	context: ContractInvoiceContext,
	input: MarkIssuedInput,
	lines: ContractInvoiceLineRow[] = []
): MarkIssuedPlan {
	const blockers = commonBlockers(invoice);
	const warnings: InvoiceWarning[] = [];
	const draft = erpDraftBlocker(invoice);

	if (draft) blockers.push(draft);
	if (invoice.lines_count === 0) blockers.push({ code: 'no_lines', message: 'La factura no tiene líneas', next_step: null });
	const multi = isMultiCurrency(invoice);
	const bodyRate = input.fx_rate && input.fx_rate > 0 ? round6(input.fx_rate) : null;
	const stored = effectiveFxRate(invoice);
	const valued = !multi || (invoice.amount_invoice_currency !== null && lines.every((line) => line.subtotal_invoice_currency !== null));
	const valuationFx = multi && !valued ? (bodyRate ?? stored) : null;
	const taxRate = invoice.tax_rate ?? 0;

	if (multi && !valued && valuationFx === null) {
		blockers.push({
			code: 'fx_rate_missing',
			message: `La factura se emite en ${invoice.invoice_currency} sobre un contrato en ${invoice.contract_currency} y no hay tasa para valorizarla`,
			next_step: 'Escribe la tasa usada en la emisión (fx_rate) o confírmala desde Tipo de cambio',
		});
	}
	if (multi && valued && bodyRate !== null && stored !== null && Math.abs(bodyRate - stored) > 1e-9) {
		warnings.push({
			code: 'fx_mismatch',
			message: `La tasa informada (${bodyRate}) no coincide con la de la factura (${stored}): ajusta la factura antes con las opciones disponibles`,
		});
	}
	if (context.auto_send_to_erp && context.has_erp_integration) {
		warnings.push({
			code: 'erp_auto_send',
			message: 'El contrato envía sus facturas al ERP automáticamente: al registrar la emisión externa, esta factura ya no se enviará',
		});
	}
	if (input.issue_date > context.today) {
		warnings.push({ code: 'future_issue_date', message: `La fecha de emisión (${input.issue_date}) es futura` });
	}
	const dueDate = invoiceDueDate(input.issue_date, context);
	const rsmFrom = [invoice.period_start, input.issue_date].filter((value): value is string => !!value).sort()[0];
	const valuated = valuationFx !== null ? fixedFxLines(lines, valuationFx) : [];
	const headerLines = valuationFx !== null ? lines.map((line, index) => ({ ...line, ...afterAsRow(valuated[index].after) })) : lines;
	const header = headerFromLines(headerLines, {
		sameCurrency: !multi,
		fx: !multi ? 1 : (valuationFx ?? stored ?? bodyRate ?? 1),
		taxRate,
	});

	return {
		blockers,
		warnings,
		can_apply: blockers.length === 0,
		before: {
			status: invoice.status,
			invoice_number: invoice.invoice_number,
			issue_date: invoice.issue_date,
			due_date: invoice.due_date,
			fx_rate: invoice.fx_contract_to_invoice,
		},
		after: {
			status: ISSUED_STATUS,
			invoice_number: input.invoice_number.trim(),
			issue_date: input.issue_date,
			due_date: dueDate,
			fx_rate: multi ? (valuationFx ?? stored) : null,
			issued_externally: true,
		},
		fx: valuationFx,
		valuate: valuationFx !== null,
		lines: valuated,
		header,
		rsm_from_month: `${rsmFrom.slice(0, 7)}-01`,
	};
}

/** Montos en moneda de factura de un `FxLineAmounts.after` con los nombres de la fila (`ContractInvoiceLineRow`). */
const afterAsRow = (after: FxLineAmounts['after']) => ({
	unit_price_invoice_currency: after.unit_price_invoice_currency,
	subtotal_invoice_currency: after.subtotal_invoice_currency,
	tax_amount_invoice_currency: after.tax_amount_invoice_currency,
	total_invoice_currency: after.total_invoice_currency,
});

// ---------------------------------------------------------------- reprogramar (§3.3)

export interface ReschedulePlanItem {
	id: string;
	invoice_number: string | null;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	before: { issue_date: string | null; scheduled_at: string | null; due_date: string | null; original_issue_date: string | null };
	after: { issue_date: string; scheduled_at: string; due_date: string; original_issue_date: string };
	/**
	 * Con descuento puntual (`nc_revenue_treatment`) el ajuste de devengo se ancla al mes de emisión: se reconstruye desde el menor de los
	 * meses de emisión (antes y después). null = sin descuento puntual (el devengo no cambia al reprogramar).
	 */
	rsm_from_month: string | null;
}

/** Una factura a una fecha: conserva `original_issue_date` (se fija la primera vez), vencimiento por condición de pago, período intacto. */
export function planRescheduleOne(invoice: ContractInvoiceRow, context: ContractInvoiceContext, issueDate: string): ReschedulePlanItem {
	const blockers = commonBlockers(invoice);
	const warnings: InvoiceWarning[] = [];
	const draft = erpDraftBlocker(invoice);

	if (draft) blockers.push(draft);
	if (invoice.issue_date === issueDate) warnings.push({ code: 'same_date', message: 'La fecha de emisión no cambia' });
	if (issueDate < context.today) {
		warnings.push({
			code: 'past_issue_date',
			message: `La nueva fecha (${issueDate}) ya pasó: el envío automático no la tomará; usa "Enviar al ERP ahora"`,
		});
	}
	if (issueDate.slice(0, 7) !== context.today.slice(0, 7) && issueDate > context.today) {
		warnings.push({ code: 'outside_current_month', message: 'La fecha queda fuera del mes en curso: el envío automático la tomará en su mes' });
	}

	return {
		id: invoice.id,
		invoice_number: invoice.invoice_number,
		blockers,
		warnings,
		before: {
			issue_date: invoice.issue_date,
			scheduled_at: invoice.scheduled_at,
			due_date: invoice.due_date,
			original_issue_date: invoice.original_issue_date,
		},
		after: {
			issue_date: issueDate,
			scheduled_at: issueDate,
			due_date: invoiceDueDate(issueDate, context),
			original_issue_date: invoice.original_issue_date ?? invoice.issue_date ?? issueDate,
		},
		rsm_from_month: invoice.nc_revenue_treatment
			? `${[invoice.issue_date, issueDate]
					.filter((value): value is string => !!value)
					.sort()[0]
					.slice(0, 7)}-01`
			: null,
	};
}

export type RescheduleApplyTo = 'this' | 'this_and_following';

/** Mueve `date` `months` meses y la deja en el día `day` del mes resultante, recortado al fin de mes (31 → 30 o 28/29). */
export function sameDayOfMonth(date: string, months: number, day: number): string {
	const [year, month] = date.slice(0, 10).split('-').map(Number);
	const index = year * 12 + (month - 1) + months;
	const targetYear = Math.floor(index / 12);
	const targetMonth = index % 12;
	const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

	return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

const monthIndex = (date: string) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7));

/**
 * Reprogramar una factura y, con `this_and_following`, llevar las Por Emitir posteriores del contrato al **mismo día del mes**
 * elegido, cada una en su mes y recortado al fin de mes (29 → 30 oct deja nov el 30 y feb el 28). Si la fecha nueva cae en
 * otro mes, las siguientes se corren esos mismos meses. El "mover al mes siguiente" masivo es `planRescheduleBulk`.
 * Devuelve un plan por factura; las que no se pueden mover quedan con bloqueos.
 */
export function planReschedule(
	target: ContractInvoiceRow,
	following: ContractInvoiceRow[],
	context: ContractInvoiceContext,
	issueDate: string,
	applyTo: RescheduleApplyTo = 'this'
): ReschedulePlanItem[] {
	const plans = [planRescheduleOne(target, context, issueDate)];

	if (applyTo !== 'this_and_following' || !target.issue_date) return plans;
	if (diffDays(target.issue_date, issueDate) === 0) return plans;
	const months = monthIndex(issueDate) - monthIndex(target.issue_date);
	const day = Number(issueDate.slice(8, 10));

	for (const invoice of following) {
		if (invoice.id === target.id || !invoice.issue_date || invoice.issue_date <= target.issue_date) continue;
		plans.push(planRescheduleOne(invoice, context, sameDayOfMonth(invoice.issue_date, months, day)));
	}

	return plans;
}

/** Masivo: cada factura a `issue_date` o corrida `shift_months` meses (fin de mes se recorta, `addMonths`). */
export function planRescheduleBulk(
	invoices: ContractInvoiceRow[],
	context: ContractInvoiceContext,
	shift: { shift_months?: number | null; issue_date?: string | null }
): ReschedulePlanItem[] {
	return invoices.map((invoice) => {
		if (shift.issue_date) return planRescheduleOne(invoice, context, shift.issue_date);
		const months = Number(shift.shift_months ?? 1) || 1;
		const base = invoice.issue_date ?? invoice.scheduled_at;

		if (!base) {
			return {
				...planRescheduleOne(invoice, context, context.today),
				blockers: [
					{
						code: 'no_issue_date',
						message: 'La factura no tiene fecha de emisión que correr',
						next_step: 'Reprográmala a una fecha concreta',
					},
				],
			};
		}

		return planRescheduleOne(invoice, context, addMonths(base, months));
	});
}

// ---------------------------------------------------------------- tipo de cambio por factura (§3.2)

export interface FxInput {
	policy: InvoiceFxPolicy;
	rate?: number | null;
	target_net_amount?: number | null;
	/** Multimoneda (spec-multimoneda §4): tasa fija por par (`USD>CLP`: 1 USD = rate CLP). Con un solo par basta `rate`. */
	rates_by_pair?: Record<string, number> | null;
}

export interface FxLineAmounts {
	id: string;
	/** Multimoneda: moneda de origen y tasa de la línea (su par); ausente = la tasa del encabezado (`write.fx`). */
	currency?: string;
	fx?: number | null;
	before: {
		unit_price_invoice_currency: number | null;
		subtotal_invoice_currency: number | null;
		tax_amount_invoice_currency: number | null;
		total_invoice_currency: number | null;
	};
	after: {
		unit_price_invoice_currency: number | null;
		subtotal_invoice_currency: number | null;
		tax_amount_invoice_currency: number | null;
		total_invoice_currency: number | null;
	};
}

export interface FxSnapshot {
	fx_policy: StoredFxPolicy | null;
	fx_rate: number | null;
	fx_rate_source: FxRateSource | null;
	fx_contract_to_invoice: number | null;
	amount_contract_currency: number;
	amount_invoice_currency: number | null;
	vat: number | null;
	total_invoice_currency: number | null;
}

export interface FxPlanItem {
	id: string;
	invoice_number: string | null;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	before: FxSnapshot;
	after: FxSnapshot;
	lines: FxLineAmounts[];
	/** Lo que se escribe (null si hay bloqueos). */
	write: { fx: number | null; fx_rate_source: FxRateSource | null; header: HeaderAmounts } | null;
}

const lineBefore = (line: ContractInvoiceLineRow): FxLineAmounts['before'] => ({
	unit_price_invoice_currency: line.unit_price_invoice_currency,
	subtotal_invoice_currency: line.subtotal_invoice_currency,
	tax_amount_invoice_currency: line.tax_amount_invoice_currency,
	total_invoice_currency: line.total_invoice_currency,
});

/**
 * Líneas a tasa fija: cada monto en moneda de contrato × fx (unitario a 6 decimales; subtotal e IVA a 2; total = subtotal + IVA). Los
 * centavos residuales de convertir (Σ redondeada de las líneas ≠ Σ en moneda de contrato × fx, a 2 decimales) van a la línea de mayor
 * subtotal, como `netExactFx`: así el encabezado (Σ líneas, `headerFromLines`) es la conversión exacta del total.
 */
export function fixedFxLines(lines: ContractInvoiceLineRow[], fx: number): FxLineAmounts[] {
	const subtotals = lines.map((line) => round2(line.subtotal_contract_currency * fx));
	const taxes = lines.map((line) => round2(line.tax_amount_contract_currency * fx));

	if (lines.length) {
		let largest = 0;

		lines.forEach((line, index) => {
			if (Math.abs(line.subtotal_contract_currency) > Math.abs(lines[largest].subtotal_contract_currency)) largest = index;
		});
		const subtotalResidual = round2(
			round2(lines.reduce((sum, line) => sum + line.subtotal_contract_currency, 0) * fx) - subtotals.reduce((sum, value) => sum + value, 0)
		);
		const taxResidual = round2(
			round2(lines.reduce((sum, line) => sum + line.tax_amount_contract_currency, 0) * fx) - taxes.reduce((sum, value) => sum + value, 0)
		);

		subtotals[largest] = round2(subtotals[largest] + subtotalResidual);
		taxes[largest] = round2(taxes[largest] + taxResidual);
	}

	return lines.map((line, index) => ({
		id: line.id,
		before: lineBefore(line),
		after: {
			unit_price_invoice_currency: round6(line.unit_price_contract_currency * fx),
			subtotal_invoice_currency: subtotals[index],
			tax_amount_invoice_currency: taxes[index],
			total_invoice_currency: round2(subtotals[index] + taxes[index]),
		},
	}));
}

/** Spot: los montos en moneda de factura quedan en NULL hasta emitir (se valorizan con la tasa oficial de la fecha de emisión). */
export function spotFxLines(lines: ContractInvoiceLineRow[]): FxLineAmounts[] {
	return lines.map((line) => ({
		id: line.id,
		before: lineBefore(line),
		after: {
			unit_price_invoice_currency: null,
			subtotal_invoice_currency: null,
			tax_amount_invoice_currency: null,
			total_invoice_currency: null,
		},
	}));
}

/**
 * Neto exacto en moneda de factura (caso OC), matemática de `apply_fixed_fx_to_contract` con `p_target_amount` sobre el **unitario efectivo**
 * (subtotal ÷ cantidad, así el descuento de la línea se conserva): fx = neto ÷ Σ (cantidad × unitario efectivo); subtotal de línea = cantidad
 * × unitario efectivo × fx a 2 decimales; la diferencia de redondeo va a la línea de mayor subtotal (el ERP suma líneas); unitario en moneda
 * de factura = subtotal ÷ cantidad sin redondear; IVA de línea a 2 decimales; encabezado = Σ líneas (`headerFromLines`).
 */
export function netExactFx(
	lines: ContractInvoiceLineRow[],
	taxRate: number,
	target: number
): { fx: number; lines: FxLineAmounts[]; header: HeaderAmounts } | null {
	const effective = (line: ContractInvoiceLineRow) => (line.quantity ? line.subtotal_contract_currency / line.quantity : 0);
	const base = lines.reduce((sum, line) => sum + line.quantity * effective(line), 0);

	if (base <= 0 || target <= 0) return null;
	const fx = round6(target / base);
	const factor = taxRate / 100;
	const subtotals = lines.map((line) => round2(line.quantity * effective(line) * (target / base)));
	const diff = round2(target - subtotals.reduce((sum, value) => sum + value, 0));

	if (diff !== 0 && subtotals.length) {
		let largest = 0;

		subtotals.forEach((value, index) => {
			if (value > subtotals[largest]) largest = index;
		});
		subtotals[largest] = round2(subtotals[largest] + diff);
	}
	const planned = lines.map((line, index) => {
		const subtotal = subtotals[index];
		const tax = round2(subtotal * factor);

		return {
			id: line.id,
			before: lineBefore(line),
			after: {
				unit_price_invoice_currency: line.quantity ? subtotal / line.quantity : subtotal,
				subtotal_invoice_currency: subtotal,
				tax_amount_invoice_currency: tax,
				total_invoice_currency: round2(subtotal + tax),
			},
		};
	});

	return {
		fx,
		lines: planned,
		header: headerFromLines(
			lines.map((line, index) => ({ ...line, ...afterAsRow(planned[index].after) })),
			{ sameCurrency: false, fx, taxRate }
		),
	};
}

const fxSnapshot = (invoice: ContractInvoiceRow): FxSnapshot => ({
	fx_policy: derivedFxPolicy(invoice),
	fx_rate: invoice.fx_contract_to_invoice,
	fx_rate_source: invoice.fx_rate_source,
	fx_contract_to_invoice: invoice.fx_contract_to_invoice,
	amount_contract_currency: invoice.amount_contract_currency,
	amount_invoice_currency: invoice.amount_invoice_currency,
	vat: invoice.vat,
	total_invoice_currency: invoice.total_invoice_currency,
});

/** ¿La factura tiene líneas en otra moneda que la del encabezado (documento de un contrato multimoneda, valorizado por par)? */
export const hasPairLines = (invoice: Pick<ContractInvoiceRow, 'contract_currency'>, lines: Array<Pick<ContractInvoiceLineRow, 'currency'>>) =>
	lines.some((line) => Boolean(line.currency) && upperCode(line.currency) !== upperCode(invoice.contract_currency));

/**
 * Tipo de cambio de una factura de un contrato multimoneda (spec-multimoneda §4 "FX por factura"): cada línea con la tasa de su par.
 * `fixed`: `rates_by_pair['USD>CLP']` (o `rate` si hay un solo par); un par sin tasa → `fixed_fx_without_rate` con el par. `spot`: las
 * líneas que convierten a NULL (las de la moneda de factura quedan a 1). `net_exact`: solo con **un** par convertidor (400
 * `net_exact_multi_pair`): el neto objetivo menos las líneas en la moneda de factura se reparte en las del par. El monto en moneda de
 * contrato del encabezado no cambia (las métricas usan la tasa pactada ítem → contrato).
 */
function planFxByPair(
	invoice: ContractInvoiceRow,
	lines: ContractInvoiceLineRow[],
	input: FxInput,
	blockers: InvoiceBlocker[],
	warnings: InvoiceWarning[],
	before: FxSnapshot,
	empty: () => FxPlanItem
): FxPlanItem {
	const invoiceCurrency = upperCode(invoice.invoice_currency) || upperCode(invoice.contract_currency);
	const taxRate = invoice.tax_rate ?? 0;
	const pairLines = lines.map((line) => ({
		id: line.id,
		currency: upperCode(line.currency) || upperCode(invoice.contract_currency),
		unit_price: line.unit_price_contract_currency,
		subtotal: line.subtotal_contract_currency,
		tax_amount: line.tax_amount_contract_currency,
		period_start: line.billing_period_start ?? invoice.period_start ?? '',
	}));
	const pairs = [...new Set(pairLines.map((line) => line.currency).filter((currency) => currency !== invoiceCurrency))];

	if (!pairs.length) {
		blockers.push({ code: 'same_currency', message: `Todas las líneas están en ${invoiceCurrency}: no aplica tipo de cambio`, next_step: null });

		return empty();
	}
	const byId = new Map(lines.map((line) => [line.id, line]));
	const finish = (valuation: ReturnType<typeof valuateLinesByPair>, source: FxRateSource | null, policy: 'spot' | 'fixed'): FxPlanItem => {
		const header: HeaderAmounts = valuation.invoice
			? {
					amount_contract_currency: invoice.amount_contract_currency,
					vat: valuation.invoice.tax,
					amount_invoice_currency: valuation.invoice.subtotal,
					total_invoice_currency: valuation.invoice.total,
				}
			: {
					amount_contract_currency: invoice.amount_contract_currency,
					// Spot: IVA del encabezado en moneda de contrato (como el spot de siempre), sobre el monto ya convertido a tasa pactada.
					vat: round2((invoice.amount_contract_currency * taxRate) / 100),
					amount_invoice_currency: null,
					total_invoice_currency: null,
				};
		const planned: FxLineAmounts[] = valuation.lines.map((line) => ({
			id: line.id,
			currency: line.currency,
			fx: line.fx,
			before: lineBefore(byId.get(line.id)!),
			after: {
				unit_price_invoice_currency: line.unit_price,
				subtotal_invoice_currency: line.subtotal,
				tax_amount_invoice_currency: line.tax,
				total_invoice_currency: line.total,
			},
		}));

		return {
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			blockers,
			warnings,
			before,
			after: { fx_policy: policy, fx_rate: valuation.fx, fx_rate_source: source, fx_contract_to_invoice: valuation.fx, ...header },
			lines: planned,
			write: { fx: valuation.fx, fx_rate_source: source, header },
		};
	};

	if (input.policy === 'spot')
		return finish(
			valuateLinesByPair(pairLines, invoiceCurrency, () => null, taxRate),
			null,
			'spot'
		);
	if (input.policy === 'net_exact') {
		if (pairs.length > 1)
			throw codedValidationException([
				{
					field: 'policy',
					message: `El neto exacto se aplica a documentos con un solo par que convierte; esta factura tiene ${pairs.map((code) => pairKey(code, invoiceCurrency)).join(', ')}: usa tasa fija por par`,
					code: MULTICURRENCY_CODES.net_exact_multi_pair,
				},
			]);
		const same = pairLines.filter((line) => line.currency === invoiceCurrency);
		const target = Number(input.target_net_amount ?? 0) - same.reduce((sum, line) => sum + line.subtotal, 0);
		const converting = lines.filter((line) => (upperCode(line.currency) || upperCode(invoice.contract_currency)) !== invoiceCurrency);
		const result = netExactFx(converting, taxRate, round2(target));

		if (!result) {
			blockers.push({
				code: 'no_priced_lines',
				message: `El neto exacto (${input.target_net_amount}) no alcanza a cubrir las líneas en ${invoiceCurrency} o no hay líneas en ${pairs[0]} con cantidad y precio`,
				next_step: null,
			});

			return empty();
		}
		// Montos exactos del neto (residuo de redondeo a la línea mayor, `netExactFx`) en las líneas del par; las de la moneda de factura a 1.
		const exact = new Map(result.lines.map((line) => [line.id, line.after]));
		const plan = finish(
			valuateLinesByPair(pairLines, invoiceCurrency, () => result.fx, taxRate),
			'net_exact',
			'fixed'
		);
		const linesAfter = plan.lines.map((line) => (exact.has(line.id) ? { ...line, after: exact.get(line.id)! } : line));
		const subtotal = round2(linesAfter.reduce((sum, line) => sum + (line.after.subtotal_invoice_currency ?? 0), 0));
		const tax = round2(linesAfter.reduce((sum, line) => sum + (line.after.tax_amount_invoice_currency ?? 0), 0));
		const header: HeaderAmounts = {
			amount_contract_currency: invoice.amount_contract_currency,
			vat: tax,
			amount_invoice_currency: subtotal,
			total_invoice_currency: round2(subtotal + tax),
		};

		return { ...plan, lines: linesAfter, after: { ...plan.after, ...header }, write: { fx: result.fx, fx_rate_source: 'net_exact', header } };
	}
	const rates = input.rates_by_pair ?? {};
	const rateFor = (currency: string): number | null => {
		const value = rates[pairKey(currency, invoiceCurrency)] ?? (pairs.length === 1 ? input.rate : undefined);

		return value !== undefined && value !== null && Number(value) > 0 ? Math.round(Number(value) * 1e6) / 1e6 : null;
	};

	for (const currency of pairs.filter((code) => rateFor(code) === null)) {
		blockers.push({
			code: 'fixed_fx_without_rate',
			message: `Falta la tasa fija ${currency} → ${invoiceCurrency} (rates_by_pair['${pairKey(currency, invoiceCurrency)}'])`,
			next_step: `Escribe la tasa del par (1 ${currency} = X ${invoiceCurrency})`,
		});
	}
	for (const key of Object.keys(rates).filter((key) => !pairs.some((code) => pairKey(code, invoiceCurrency) === key))) {
		warnings.push({ code: 'pair_not_in_invoice', message: `La factura no tiene líneas del par ${key}: esa tasa no se usa` });
	}
	if (blockers.length) return empty();

	return finish(
		valuateLinesByPair(pairLines, invoiceCurrency, (line) => rateFor(line.currency), taxRate),
		'manual',
		'fixed'
	);
}

/** Política y tasa de UNA factura: bloqueos comunes + `same_currency`, `uf_invoice_currency`, `sent_to_erp_draft`; matemática por política. */
export function planFx(invoice: ContractInvoiceRow, lines: ContractInvoiceLineRow[], context: ContractInvoiceContext, input: FxInput): FxPlanItem {
	const blockers = commonBlockers(invoice);
	const warnings: InvoiceWarning[] = [];
	const draft = erpDraftBlocker(invoice);
	const before = fxSnapshot(invoice);
	const empty = (): FxPlanItem => ({
		id: invoice.id,
		invoice_number: invoice.invoice_number,
		blockers,
		warnings,
		before,
		after: before,
		lines: [],
		write: null,
	});

	if (draft) blockers.push(draft);
	const partial = partialBillingBlocker(invoice);

	if (partial) blockers.push(partial);
	// Multimoneda: el documento se valoriza por par (líneas en monedas de ítem distintas).
	if (hasPairLines(invoice, lines)) {
		if ((invoice.invoice_currency ?? '').toUpperCase() === 'CLF') {
			blockers.push({
				code: 'uf_invoice_currency',
				message: 'La UF no se factura: cambia la moneda de facturación en Condiciones',
				next_step: null,
			});
		}
		if (blockers.length) return empty();

		return planFxByPair(invoice, lines, input, blockers, warnings, before, empty);
	}
	if (!isMultiCurrency(invoice)) {
		blockers.push({
			code: 'same_currency',
			message: `La factura se emite en la moneda del contrato (${invoice.contract_currency ?? 'sin moneda'}): no aplica tipo de cambio`,
			next_step: null,
		});
	}
	if ((invoice.invoice_currency ?? '').toUpperCase() === 'CLF') {
		blockers.push({
			code: 'uf_invoice_currency',
			message: 'La UF no se factura: cambia la moneda de facturación en Condiciones',
			next_step: null,
		});
	}
	if (blockers.length) return empty();
	const taxRate = invoice.tax_rate ?? 0;

	if (invoice.tax_rate === null)
		warnings.push({
			code: 'tax_rate_missing',
			message: 'La factura no tiene tasa de IVA: el IVA en moneda de factura sale del IVA guardado en cada línea (revísalo antes de enviar)',
		});
	if (input.policy === 'spot') {
		if (invoice.fx_contract_to_invoice === null) warnings.push({ code: 'no_change', message: 'La factura ya está en spot sin tasa pegada' });
		const header = headerFromLines(lines, { sameCurrency: false, fx: null, taxRate });

		return {
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			blockers,
			warnings,
			before,
			after: { fx_policy: 'spot', fx_rate: null, fx_rate_source: null, fx_contract_to_invoice: null, ...header },
			lines: spotFxLines(lines),
			write: { fx: null, fx_rate_source: null, header },
		};
	}
	if (input.policy === 'net_exact') {
		const result = netExactFx(lines, taxRate, Number(input.target_net_amount ?? 0));

		if (!result) {
			blockers.push({
				code: 'no_priced_lines',
				message: 'La factura no tiene líneas con cantidad y precio unitario en moneda de contrato para derivar la tasa',
				next_step: null,
			});

			return empty();
		}
		const current = invoice.fx_contract_to_invoice;

		if (current !== null && Math.abs(current - result.fx) > 0.05 * current) {
			warnings.push({
				code: 'rate_far_from_current',
				message: `La tasa derivada (${result.fx}) difiere más de 5 % de la fija actual (${current})`,
			});
		}

		return {
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			blockers,
			warnings,
			before,
			after: { fx_policy: 'fixed', fx_rate: result.fx, fx_rate_source: 'net_exact', fx_contract_to_invoice: result.fx, ...result.header },
			lines: result.lines,
			write: { fx: result.fx, fx_rate_source: 'net_exact', header: result.header },
		};
	}
	const fx = round6(Number(input.rate ?? 0));

	if (!(fx > 0)) {
		blockers.push({
			code: 'fixed_fx_without_rate',
			message: 'El tipo de cambio fijo debe ser mayor que 0',
			next_step: 'Escribe la tasa (1 moneda de contrato = X moneda de factura)',
		});

		return empty();
	}
	if (invoice.fx_contract_to_invoice === fx) warnings.push({ code: 'no_change', message: 'La factura ya tiene esa tasa fija' });
	const fixed = fixedFxLines(lines, fx);
	const header = headerFromLines(
		lines.map((line, index) => ({ ...line, ...afterAsRow(fixed[index].after) })),
		{ sameCurrency: false, fx, taxRate }
	);

	return {
		id: invoice.id,
		invoice_number: invoice.invoice_number,
		blockers,
		warnings,
		before,
		after: { fx_policy: 'fixed', fx_rate: fx, fx_rate_source: 'manual', fx_contract_to_invoice: fx, ...header },
		lines: fixed,
		write: { fx, fx_rate_source: 'manual', header },
	};
}

// ---------------------------------------------------------------- restablecer el borrador del ERP (§3.1, decisión de Domi 30-09)

export const ERP_DRAFT_REMAINS_WARNING: InvoiceWarning = {
	code: 'erp_draft_remains',
	message: 'El borrador sigue en el ERP: elimínalo allí para que no quede duplicado al reenviar.',
};

export interface ErpResetSnapshot {
	odoo_invoice_id: number | null;
	sent_to_odoo_at: string | null;
	sent_at: string | null;
	/** Tasa y montos en moneda de factura (vuelven a NULL si la tasa la escribió el envío spot, `spot_reset`). */
	fx_contract_to_invoice: number | null;
	fx_rate_source: FxRateSource | null;
	amount_invoice_currency: number | null;
	vat: number | null;
	total_invoice_currency: number | null;
}

export interface ErpResetPlan {
	id: string;
	invoice_number: string | null;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	before: ErpResetSnapshot;
	after: ErpResetSnapshot;
	/**
	 * Contrato spot y la tasa de la factura la escribió el envío al ERP (sin origen explícito `EXPLICIT_FX_SOURCES`): restablecer también
	 * devuelve la factura a spot (tasa, montos en moneda de factura y origen de la tasa de las líneas en NULL; `vat` en moneda de contrato).
	 */
	spot_reset: boolean;
}

/**
 * "Restablecer borrador del ERP" (reemplaza por ahora el `erp-withdraw` oculto; misma acción que `reset_invoice_odoo_draft`): solo una Por
 * Emitir activa vinculada al ERP (`odoo_invoice_id` o `sent_to_odoo_at`); deja `odoo_invoice_id`, `sent_to_odoo_at` y `sent_at` en NULL.
 * Si el contrato es spot y la tasa la escribió el envío (`spot_reset`), la factura vuelve a leerse spot: tasa, montos en moneda de factura
 * (líneas y encabezado) y origen de la tasa en NULL (queda en el before/after del evento). El borrador en Odoo NO se elimina por API
 * (pendiente con Leon): aviso `erp_draft_remains` siempre.
 */
export function planErpReset(invoice: ContractInvoiceRow, context: ContractInvoiceContext, lines: ContractInvoiceLineRow[] = []): ErpResetPlan {
	const blockers = commonBlockers(invoice);

	if (!blockers.some((blocker) => blocker.code === 'credit_note') && invoice.odoo_invoice_id === null && invoice.sent_to_odoo_at === null) {
		blockers.push({ code: 'not_sent_to_erp', message: 'La factura no está vinculada al ERP: no hay borrador que restablecer', next_step: null });
	}
	const spotReset =
		isMultiCurrency(invoice) &&
		context.contract_fx_invoice_policy === 'spot' &&
		invoice.fx_contract_to_invoice !== null &&
		!invoice.fx_explicit &&
		!invoice.internal_lines;
	const before: ErpResetSnapshot = {
		odoo_invoice_id: invoice.odoo_invoice_id,
		sent_to_odoo_at: invoice.sent_to_odoo_at,
		sent_at: invoice.sent_at,
		fx_contract_to_invoice: invoice.fx_contract_to_invoice,
		fx_rate_source: invoice.fx_rate_source,
		amount_invoice_currency: invoice.amount_invoice_currency,
		vat: invoice.vat,
		total_invoice_currency: invoice.total_invoice_currency,
	};
	const spotHeader = spotReset ? headerFromLines(lines, { sameCurrency: false, fx: null, taxRate: invoice.tax_rate ?? 0 }) : null;

	return {
		id: invoice.id,
		invoice_number: invoice.invoice_number,
		blockers,
		warnings: [ERP_DRAFT_REMAINS_WARNING],
		before,
		after: {
			...before,
			odoo_invoice_id: null,
			sent_to_odoo_at: null,
			sent_at: null,
			...(spotHeader
				? {
						fx_contract_to_invoice: null,
						fx_rate_source: null,
						amount_invoice_currency: null,
						vat: lines.length ? spotHeader.vat : invoice.vat,
						total_invoice_currency: null,
					}
				: {}),
		},
		spot_reset: spotReset,
	};
}

// ---------------------------------------------------------------- referencias OC/HES por factura (§3.7a)

/** Código SII (`invoice_references.document_type_code`) y nombre por defecto de cada tipo de referencia (misma tabla que Facturación). */
export const REFERENCE_DOCUMENT_TYPES = {
	OC: { code: '801', name: 'Orden de Compra' },
	HES: { code: 'HES', name: 'Hoja de Entrada de Servicio' },
} as const;

export interface ReferenceInput {
	type: 'OC' | 'HES' | 'OTHER';
	code: string;
	date?: string | null;
	name?: string | null;
	/** Solo OTHER: código SII del documento referenciado (802, 803…). */
	document_type_code?: string | null;
}

/** Fila propia de la factura en `invoice_references` (las columnas reales; `reference_code`/`reason` se conservan si la referencia ya existía). */
export interface InvoiceReferenceRow {
	document_type_code: string;
	document_type_name: string | null;
	document_number: string;
	reference_date: string | null;
	reference_code: string | null;
	reason: string | null;
}

export interface ReferencesPlan {
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	can_apply: boolean;
	rows: InvoiceReferenceRow[];
	/** Pares repetidos (tipo + número) en el cuerpo: índices para `errors[{ field: 'references.N.code' }]`. */
	duplicates: number[];
}

const referenceKey = (code: string, number: string) => `${code.trim().toUpperCase()}|${number.trim().toUpperCase()}`;

/**
 * Juego completo de referencias propias de una factura (spec §3.7a): mismo mapeo que lee el detalle (`type` ← `document_type_code`, `code` ←
 * `document_number`, `name` ← `document_type_name`, `date` ← `reference_date`); OC = SII 801, HES = HES, OTHER con su código. Editable
 * en Por Emitir (con aviso si ya hay borrador en el ERP) y en emitidas **solo** si aún no se enviaron al ERP; nunca en NC/ND, legacy,
 * unificadas, canceladas o inactivas.
 */
export function planReferences(invoice: ContractInvoiceRow, input: ReferenceInput[], existing: InvoiceReferenceRow[]): ReferencesPlan {
	const blockers: InvoiceBlocker[] = [];
	const warnings: InvoiceWarning[] = [];
	const pending = invoice.status === PENDING_STATUS;

	if (isCreditNote(invoice.document_type) || invoice.document_type === 'ND') {
		blockers.push({
			code: 'credit_note',
			message: 'Las notas de crédito y débito no se editan desde el contrato',
			next_step: 'Gestiónala en Facturación',
		});
	} else {
		if (!invoice.is_active || invoice.status === 'Cancelada') {
			blockers.push({ code: 'not_editable', message: 'La factura está cancelada o inactiva', next_step: null });
		}
		if (invoice.consolidated_into_invoice_id || invoice.invoice_type === 'Unificada' || invoice.invoice_type === 'Consolidada') {
			blockers.push({ code: 'unified_invoice', message: 'Es un documento unificado o consolidado entre facturas', next_step: UNIFY_STEP });
		}
		if (invoice.is_legacy) {
			blockers.push({ code: 'legacy_invoice', message: 'Es una factura importada (legacy): no se opera desde el contrato', next_step: null });
		}
		if (!pending && (invoice.odoo_invoice_id !== null || invoice.sent_to_odoo_at !== null)) {
			blockers.push({
				code: 'sent_to_erp',
				message: 'La factura ya se envió al ERP: sus referencias se ajustan en el ERP',
				next_step: 'Corrígelas en el ERP',
			});
		}
		if (pending && invoice.odoo_invoice_id !== null) {
			warnings.push({
				code: 'sent_to_erp_draft',
				message: 'La factura ya está en el ERP como borrador: el borrador no se actualiza con las referencias nuevas',
			});
		}
	}
	const previous = new Map(existing.map((row) => [referenceKey(row.document_type_code, row.document_number), row]));
	const seen = new Set<string>();
	const duplicates: number[] = [];
	const rows: InvoiceReferenceRow[] = [];

	input.forEach((reference, index) => {
		const known = reference.type === 'OTHER' ? null : REFERENCE_DOCUMENT_TYPES[reference.type];
		const documentTypeCode = (known?.code ?? reference.document_type_code ?? '').trim();
		const number = reference.code.trim();
		const key = referenceKey(documentTypeCode, number);

		if (seen.has(key)) {
			duplicates.push(index);

			return;
		}
		seen.add(key);
		const before = previous.get(key);

		rows.push({
			document_type_code: documentTypeCode,
			document_type_name: reference.name?.trim() || known?.name || before?.document_type_name || null,
			document_number: number,
			reference_date: reference.date ?? null,
			reference_code: before?.reference_code ?? null,
			reason: before?.reason ?? null,
		});
	});

	return { blockers, warnings, can_apply: blockers.length === 0 && duplicates.length === 0, rows, duplicates };
}
