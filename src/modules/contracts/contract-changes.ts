/**
 * Reglas **puras** de las modificaciones de contrato v2 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §1, §2 y §4).
 * Sin base de datos: reciben el contexto ya leído (`ChangeContext`) y el pedido, y devuelven el `ChangePlan`: el preview
 * exacto de §4 más la lista ordenada de escrituras (`ops`) que `ContractChangesService` ejecuta en una transacción.
 * El preview y la aplicación usan **el mismo cálculo** (mapa §1.2).
 *
 * Construido (DECIDIDO): `billing_conditions`, `change_entity` (fase A), `item_remove`, `contract_cancel` (fase B),
 * `renewal` al mismo precio (fase C), `item_add` e `item_change` sin cambio de frecuencia ni término (fase D).
 * No construido (ABIERTO): `reactivate` (§2.7 ventana de reversión), `pause`/`resume` (§2.6), `price_adjustment` (§2.8),
 * renegociación con cambio de frecuencia/término (S3-15), renovación con cambio de precio (S3-15), cambio de moneda del
 * contrato (§2.9), cambio de cliente comercial o compañía emisora (§2.10).
 *
 * Fechas siempre `YYYY-MM-DD` (texto).
 */

import { type FieldError, validationException } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';

import {
	addDays,
	addMonths,
	BILLING_FREQUENCY_MONTHS,
	type BillingEngineContract,
	type BillingEngineItem,
	type BillingFrequency,
	computeDueDate,
	descriptionFittedWarning,
	diffDays,
	findFixedRate,
	type FxPeriodRate,
	generateInvoices,
	itemEndDate,
	monthsBetween,
	nextPeriodStart,
	normalizeCountry,
	normalizeTaxRate,
	type PreviewInvoice,
	round2,
	suggestDocumentType,
} from './billing-engine';
import { type CatalogPrice, catalogPriceErrors } from './catalog-prices';
import { priceStandardLine, UNIFIED_INVOICE_TYPE } from './consumption';
import { ISSUED_STATUSES, PENDING_STATUS } from './contract-360';
import { cleanPaymentTerms, ContractDraftsService, METERED_ADVANCE_MESSAGE } from './contract-drafts.service';
import { buildItemGroups, type ContractItem, deriveItemStatus, type ItemGroup, type PendingInvoiceLine } from './contract-items';
import { type ContractDerivedStatus, deriveContractStatus } from './contract-status';
import {
	CHANGE_TYPES,
	type ChangeType,
	type ContractChangeDto,
	type ContractChangeRequestDto,
	DEFERRED_CHANGE_TYPES,
} from './dtos/contract-changes.dto';
import { hasPricingModel, type PriceSpecDto, UF_CURRENCY } from './dtos/create-contract.dto';
import { DESCRIPTION_FITTED_CODE, type DescriptionTemplate } from './invoice-description';
import { normalizePriceSpec, priceSpecFromRow } from './price-rows';
import { isMetered, type PricedLine, type PricedSubline, priceLine, type PriceSpec, type QuantitySource, validatePriceSpec } from './pricing-engine';

// ------------------------------------------------------------------ contexto (lo que lee el servicio)

export interface ChangeContractRow {
	id: string;
	contract_number: string | null;
	status: string | null;
	client_id: string | null;
	client_entity_id: string | null;
	company_id: string | null;
	contract_currency: string;
	invoice_currency: string | null;
	system_currency: string | null;
	company_currency: string | null;
	fx_invoice_policy: string | null;
	fx_company_policy: string | null;
	group_invoices_by_period: boolean;
	auto_invoice: boolean;
	auto_send_to_odoo: boolean;
	requires_references_for_billing: boolean;
	billing_anchor_day: number | null;
	payment_terms: PaymentTerms | null;
	document_type: string | null;
	tax_document_type_id: string | null;
	tax_document_type_kind: string | null;
	invoice_terms_and_conditions: string | null;
	total_value: number | null;
	contract_end_date: string | null;
	quote_id: string | null;
	company: {
		legal_name: string | null;
		tax_id: string | null;
		address: string | null;
		country: string | null;
		tax_rate: number | string | null;
		currency: string | null;
	};
	entity: { id: string | null; legal_name: string | null; tax_id: string | null; country: string | null; payment_terms: PaymentTerms | null };
	/** Tasas fijas de facturación guardadas (`purpose = 'invoice'`). */
	fx_invoice_rates: FxPeriodRate[];
	/** Cierre de períodos de la compañía (`get_cutoff_date`), o null. */
	cutoff_date: string | null;
	/** Plantilla de descripción de líneas (`contracts.invoice_description_template`, spec facturas §3.6); null/ausente = la glosa de hoy. */
	invoice_description_template?: DescriptionTemplate | null;
	/** Límite de caracteres de la descripción del documento (`description_max_chars`); null/ausente = sin límite. Las glosas se ajustan a él. */
	description_max_chars?: number | null;
}

/** Ítem tal como está en la base (mismas columnas que `GET /contracts/:id/items`) más el modelo de precio crudo para el generador. */
export interface ChangeItemRow extends Omit<ContractItem, 'status'> {
	price: number | null;
	price_id: string | null;
	/** Fila cruda con las columnas `PRICE_COLUMNS` (para `ContractActivationService.engineItem`); vacía en ítems nuevos. */
	raw: Record<string, unknown>;
}

export interface ChangeInvoiceLineRow {
	id: string;
	invoice_id: string;
	contract_item_id: string | null;
	product_id: string | null;
	description: string | null;
	quantity: number;
	unit_price: number;
	unit_price_invoice: number | null;
	discount_pct: number;
	subtotal: number;
	subtotal_invoice: number | null;
	tax_amount: number;
	tax_amount_invoice: number | null;
	total: number;
	total_invoice: number | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	unit_of_measure: string | null;
	/** `manual` = línea editada a mano en el editor de la Por Emitir (spec facturas §3.4): las modificaciones no la reescriben. */
	quantity_source?: string | null;
	/** Etapa 6 (§3.7b): línea interna de facturar por OC, ligada a su línea visible; la NC espejo replica el vínculo. */
	visible_line_id?: string | null;
	/** Origen de la tasa de la línea (`net_exact` / `manual` = tasa fijada por factura desde el 360: la modificación no la pisa). */
	fx_rate_source?: string | null;
	/** Neto (moneda de contrato, positivo) ya acreditado por NC de descuento vigentes sobre esta línea (mismo ítem, período contenido). */
	previously_credited?: number;
	/** Consumo registrado del ítem y período (`consumption_entries`): la cantidad de la línea es esa y ninguna modificación la reinicia. */
	consumption?: { quantity: number; amount_override: number | null; apply_item_discount: boolean; is_estimated: boolean } | null;
}

/** Montos (positivos) de una línea de NC espejo: la parte `ratio` de la línea original en ambas monedas. */
export interface MirrorLineAmounts {
	subtotal: number;
	subtotal_invoice: number | null;
	tax: number;
	tax_invoice: number | null;
}

export interface MirrorCreditNoteAmounts {
	lines: MirrorLineAmounts[];
	/** Σ positivos; el encabezado de la NC los lleva con signo negativo. */
	subtotal: number;
	tax: number;
	subtotal_invoice: number | null;
	tax_invoice: number | null;
	/** Encabezado de la NC (negativo) con la convención de `insertMirrorCreditNote`: `vat` y total en moneda de factura (o de contrato en spot). */
	header: { amount_contract_currency: number; amount_invoice_currency: number | null; vat: number; total_invoice_currency: number | null };
}

/**
 * Montos de la NC espejo (la usa `insertMirrorCreditNote` y la vista previa de anular / NC de descuento, spec facturas §3.8): por línea, la
 * parte `ratio` del subtotal en ambas monedas e IVA = subtotal × tasa. Con `exact` (anulación completa, ratio 1) cada línea copia su IVA
 * guardado en ambas monedas: la NC cancela el documento al centavo aunque el IVA de la original no sea exactamente subtotal × tasa.
 */
export function mirrorCreditNoteAmounts(
	lines: Array<{ line: Pick<ChangeInvoiceLineRow, 'subtotal' | 'subtotal_invoice' | 'tax_amount' | 'tax_amount_invoice'>; ratio: number }>,
	taxRate: number,
	exact = false
): MirrorCreditNoteAmounts {
	const amounts = lines.map(({ line, ratio }) =>
		exact && ratio === 1
			? {
					subtotal: round2(line.subtotal),
					subtotal_invoice: line.subtotal_invoice === null ? null : round2(line.subtotal_invoice),
					tax: round2(line.tax_amount),
					tax_invoice: line.subtotal_invoice === null ? null : round2(line.tax_amount_invoice ?? 0),
				}
			: {
					subtotal: round2(line.subtotal * ratio),
					subtotal_invoice: line.subtotal_invoice === null ? null : round2(line.subtotal_invoice * ratio),
					tax: round2((line.subtotal * ratio * taxRate) / 100),
					tax_invoice: line.subtotal_invoice === null ? null : round2((line.subtotal_invoice * ratio * taxRate) / 100),
				}
	);
	const subtotal = round2(amounts.reduce((sum, amount) => sum + amount.subtotal, 0));
	const tax = round2(amounts.reduce((sum, amount) => sum + amount.tax, 0));
	const hasInvoiceAmounts = amounts.every((amount) => amount.subtotal_invoice !== null);
	const subtotalInvoice = hasInvoiceAmounts ? round2(amounts.reduce((sum, amount) => sum + (amount.subtotal_invoice ?? 0), 0)) : null;
	const taxInvoice = hasInvoiceAmounts ? round2(amounts.reduce((sum, amount) => sum + (amount.tax_invoice ?? 0), 0)) : null;

	return {
		lines: amounts,
		subtotal,
		tax,
		subtotal_invoice: subtotalInvoice,
		tax_invoice: taxInvoice,
		header: {
			amount_contract_currency: -subtotal,
			amount_invoice_currency: subtotalInvoice === null ? null : -subtotalInvoice,
			vat: -(taxInvoice ?? tax),
			total_invoice_currency: subtotalInvoice === null ? null : -round2(subtotalInvoice + (taxInvoice ?? 0)),
		},
	};
}

export interface ChangeInvoiceRow {
	id: string;
	invoice_number: string | null;
	status: string | null;
	is_active: boolean;
	is_legacy: boolean;
	invoice_type: string | null;
	document_type: string | null;
	export_type: number | null;
	issue_date: string | null;
	due_date: string | null;
	client_entity_id: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx: number | null;
	tax_rate: number;
	subtotal: number;
	vat: number;
	amount_invoice: number | null;
	total_invoice: number | null;
	lines: ChangeInvoiceLineRow[];
	/** Borrador en el ERP (`odoo_invoice_id` / `sent_to_odoo_at`): no bloquea, pero la modificación avisa `erp_draft_stale`. */
	odoo_invoice_id?: number | null;
	sent_to_odoo_at?: string | null;
	/** Emitida anulada con NC de anulación activa (`voidedSql`): no recibe otra NC. */
	voided?: boolean;
	/** RUT/tax id del receptor guardado en la factura (para el antes del cambio de razón social). */
	client_tax_id?: string | null;
}

export interface ChangeContext {
	contract: ChangeContractRow;
	items: ChangeItemRow[];
	/** Todas las facturas no legacy del contrato con sus líneas (Por Emitir, emitidas, NC, canceladas). */
	invoices: ChangeInvoiceRow[];
	/** Ítems con filas en `quantities` (cantidades variables del front viejo). */
	quantity_override_item_ids: string[];
	/** Motivo de catálogo pedido (`reason_id`) si existe y está activo en el holding. */
	churn_reason: { id: string; name: string } | null;
	/** `change_entity`: razón social pedida, si existe en el holding. */
	new_entity: { id: string; legal_name: string | null; tax_id: string | null; country: string | null; belongs_to_client: boolean } | null;
	/** `item_add`: nombre de los productos pedidos que existen en el holding. */
	products: Map<string, string>;
	/** `billing_conditions`: documento tributario pedido si existe y corresponde a la compañía emisora. */
	tax_document_type: { id: string; code: string; name: string; kind: string } | null;
	/** Origen cotización: la cotización si existe en el holding. */
	quote: { id: string; quote_type: string | null; already_applied: boolean } | null;
	/** `item_add` con precios medidos: métricas facturables del holding referenciadas (id → estado). */
	billable_metrics?: Map<string, string>;
	/** `item_add` con `price_id` (etapa 3): precios de catálogo del holding referenciados (solo los que existen). */
	catalog_prices?: Map<string, CatalogPrice>;
	today: string;
}

// ------------------------------------------------------------------ resultado

export interface ChangeBlocker {
	code: string;
	message: string;
	next_step: string | null;
}
export interface ChangeWarning {
	code: string;
	message: string;
	/** Qué hacer (solo en los avisos que piden una acción aparte: `partial_billing_skipped`, `erp_draft_stale`). */
	next_step?: string | null;
}

export interface PreviewItem {
	item_id: string | null;
	/** Clave temporal de un ítem nuevo (`new:N`), para cruzar con `ops`. */
	key?: string;
	product_name: string | null;
	account: string | null;
	categoria: string | null;
	quantity: number | null;
	unit_price: number | null;
	monthly_price: number | null;
	start_date: string | null;
	end_date: string | null;
	related_item_id: string | null;
	renews_item_id: string | null;
}

export interface ChangeContractSnapshot {
	mrr: number;
	total_value: number;
	end_date: string | null;
	status: string;
}

export interface ChangePreview {
	type: ChangeType;
	effective_date: string;
	contract: { before: ChangeContractSnapshot; after: ChangeContractSnapshot };
	items: {
		added: PreviewItem[];
		adjusted: PreviewItem[];
		ended: Array<{ item_id: string; churn_date: string; timing: 'early' | 'non_renewal' }>;
		groups_after: ItemGroup[];
	};
	invoices: {
		updated: Array<{
			id: string;
			invoice_number: string | null;
			issue_date: string | null;
			lines_changed: number;
			subtotal_before: number;
			subtotal_after: number;
			change: string;
		}>;
		created: PreviewInvoice[];
		cancelled: Array<{ id: string; invoice_number: string | null; issue_date: string | null }>;
		credit_notes: Array<{
			mirrors_invoice_id: string;
			mirrors_invoice_number: string | null;
			total: number;
			currency: string | null;
			fx: number | null;
		}>;
	};
	rsm: { mrr_delta: number; momentum: string | null; first_month: string | null; months_rebuilt: number; closed_months_skipped: number };
	warnings: ChangeWarning[];
	blockers: ChangeBlocker[];
	can_apply: boolean;
	/** `billing_conditions` con `apply_to_pending`: Por Emitir que toman el texto nuevo y las omitidas (bloqueos del masivo de facturas). */
	pending_terms?: PendingTermsResult;
}

export interface PendingTermsResult {
	updated: string[];
	skipped: Array<{ invoice_id: string; invoice_number: string | null; reason: string; message: string }>;
}

/** Fila a insertar en `contract_items` (explícita: categoría, fin, precios; mapa §4 regla 3). */
export interface NewItemRow {
	key: string;
	product_id: string | null;
	product_name: string;
	account: string | null;
	item_type: string | null;
	unit_of_measure: string | null;
	categoria: string;
	quantity: number;
	/** Unitario mensual (null si `price_entry_mode = annual`: el trigger lo deriva). */
	unit_price: number | null;
	annual_unit_price: number | null;
	price_entry_mode: 'monthly' | 'annual';
	discount_type: string | null;
	discount_value: number;
	price: number;
	final_price: number;
	currency: string;
	billing_frequency: string;
	billing_method: string;
	is_recurring: boolean;
	start_date: string;
	end_date: string;
	term_months: number;
	related_item_id: string | null;
	renews_item_id: string | null;
	booking_date: string;
	auto_renew: boolean;
	price_id: string | null;
	quote_item_id: string | null;
	/** Pricing v2: modelo de precio (inline o copiado del catálogo) a guardar en `prices` (owner = contract) y apuntar con `price_id`; null = standard fijo. */
	price_spec?: PriceSpec | null;
	/** Etapa 3: precio de catálogo del que sale la copia (`list_price_id`), o null en inline. */
	list_price_id?: string | null;
	/** Nombre a guardar en la copia (el del catálogo); null = nombre del producto. */
	price_name?: string | null;
}

export interface ChangeLineAmounts {
	quantity: number;
	unit_price: number;
	discount_pct: number;
	subtotal: number;
	tax_amount: number;
	total: number;
	billing_period_end?: string;
	description_suffix?: string;
	/** Línea con consumo registrado: desglose del motor recalculado con la cantidad registrada (null/ausente = no se toca). */
	pricing_breakdown?: PricedSubline[] | null;
	quantity_source?: string | null;
}

export type WriteOp =
	| { kind: 'insert_item'; item: NewItemRow }
	| { kind: 'update_item'; item_id: string; set: { churn_date?: string; churn_monthly_amount?: number; renewed_by_key?: string } }
	| { kind: 'update_line'; invoice_id: string; line_id: string; values: ChangeLineAmounts }
	| { kind: 'delete_line'; invoice_id: string; line_id: string }
	| { kind: 'recompute_header'; invoice_id: string; cancel_if_empty: boolean; note: string }
	| { kind: 'cancel_invoice'; invoice_id: string; note: string }
	| { kind: 'create_invoices'; invoices: PreviewInvoice[]; fixed_rates: Array<number | null>; merge_into: Array<string | null> }
	| {
			kind: 'credit_note';
			mirrors: ChangeInvoiceRow;
			lines: Array<{ line: ChangeInvoiceLineRow; ratio: number; period_start: string }>;
			note: string;
	  }
	| { kind: 'update_invoices_fields'; invoice_ids: string[]; set: Record<string, unknown> }
	| { kind: 'update_invoices_document'; invoice_ids: string[]; document_type: string; export_type: 0 | 1; tax_rate: number }
	| { kind: 'update_invoices_fx'; targets: Array<{ invoice_id: string; fx: number | null }>; invoice_currency: string }
	| {
			kind: 'insert_fx_rates';
			rates: Array<{ from_currency: string; to_currency: string; rate: number; period_start: string; period_end: string }>;
	  }
	| { kind: 'update_contract'; set: Record<string, unknown>; bypass_end_date_guard: boolean };

export interface ChangeEvent {
	type: string;
	subtype: string | null;
	title: string;
	description: string;
	amount_delta: number;
	/** Ids de ítems existentes afectados; los nuevos se agregan al escribir. */
	items_affected: string[];
	new_item_keys: string[];
	/** Mes desde el que se reconstruye el RSM (null = sin RSM). */
	rsm_from_month: string | null;
	metadata: Record<string, unknown>;
}

export interface ChangePlan {
	preview: ChangePreview;
	ops: WriteOp[];
	event: ChangeEvent;
	/** Ítems del contrato después del cambio (los nuevos con `id = key`). */
	items_after: ChangeItemRow[];
}

// ------------------------------------------------------------------ catálogos

/** Estados mostrados en que se admite cada tipo (Supuesto 1 de la spec: siguen el estado derivado). */
export const ALLOWED_STATES: Record<ChangeType, ContractDerivedStatus[]> = {
	billing_conditions: ['draft', 'active', 'pending_renewal'],
	change_entity: ['active', 'pending_renewal'],
	item_remove: ['active', 'pending_renewal'],
	contract_cancel: ['active', 'pending_renewal', 'expired'],
	renewal: ['active', 'pending_renewal', 'expired'],
	item_add: ['active'],
	item_change: ['active', 'pending_renewal'],
};

export const STATUS_LABELS: Record<ContractDerivedStatus, string> = {
	active: 'Activo',
	pending_renewal: 'Por renovar',
	expired: 'Vencido',
	draft: 'En revisión',
	paused: 'Pausado',
	cancelled: 'Cancelado',
	other: 'sin estado',
};

/** Por qué cada tipo diferido no se construye todavía (spec §2.6, §2.7, §2.8). */
export const DEFERRED_MESSAGES: Record<(typeof DEFERRED_CHANGE_TYPES)[number], string> = {
	reactivate: 'Reactivar todavía no se construye: falta decidir la ventana de reversión del churn (spec §2.7, decisión 8)',
	pause: 'Pausar todavía no se construye: falta cerrar el diseño de pausa (spec §2.6, decisión 7)',
	resume: 'Reanudar todavía no se construye: falta cerrar el diseño de pausa (spec §2.6, decisión 7)',
	price_adjustment: 'El reajuste (IPC, UF, escalamientos) todavía no se construye: falta decidir el modelo (spec §2.8, decisión 6)',
};

export const REOPEN_PERIOD_STEP = 'Reabrir el período en Configuración → Sistema → Cierre de períodos';
export const CONTRACT_CANCELLED = 'Cancelado';
const REMOVAL_CATEGORIES = new Set(['CHURN', 'DOWNSELL']);
const DELTA_CATEGORIES = new Set(['UPSELL', 'DOWNSELL']);

// ------------------------------------------------------------------ helpers

const num = (value: unknown) => Number(value ?? 0) || 0;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
const upper = (value: unknown) =>
	String(value ?? '')
		.trim()
		.toUpperCase();
const money = (value: number) => value.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const month = (iso: string) => `${iso.slice(0, 7)}-01`;

/** Meses (entero, hacia arriba) que cubre `[start, end]` en meses calendario del propio ítem (mínimo 1). */
export const monthsCeil = (start: string, end: string): number => {
	let months = 0;

	while (addDays(addMonths(start, months + 1), -1) < end) months += 1;

	return months + 1;
};

/** `end` es un número entero de meses desde `start` (fin = inicio + n meses − 1 día)? Devuelve n o null. */
export const wholeMonths = (start: string, end: string): number | null => {
	const n = monthsCeil(start, end);

	return itemEndDate(start, n) === end ? n : null;
};

/** Mensual del ítem: `monthly_price` o, si falta, `final_price / term_months`. */
export const itemMonthly = (item: Pick<ChangeItemRow, 'monthly_price' | 'final_price' | 'price' | 'term_months'>): number => {
	if (item.monthly_price !== null && item.monthly_price !== undefined) return num(item.monthly_price);
	const term = num(item.term_months);

	return term > 0 ? round2(num(item.final_price ?? item.price) / term) : num(item.final_price ?? item.price);
};

/** Ítems recurrentes "vivos": no son espejos de baja, no tienen churn ni renovación. */
const liveRecurring = (items: ChangeItemRow[]) =>
	items.filter(
		(item) => item.is_recurring !== false && !REMOVAL_CATEGORIES.has(item.categoria ?? '') && !item.churn_date && !item.renewed_by_item_id
	);

/** Fin del contrato = el más próximo de los recurrentes no renovados ni cancelados (S2-13/S3-11). */
export const nearestContractEnd = (items: ChangeItemRow[]): string | null => {
	const ends = liveRecurring(items)
		.map((item) => item.end_date)
		.filter((date): date is string => Boolean(date))
		.sort();

	return ends[0] ?? null;
};

/** MRR del contrato a una fecha = Σ MRR del ítem madre (misma regla del 360). */
export const contractMrr = (items: ChangeItemRow[], date: string): number =>
	round2(buildItemGroups(items, date).reduce((sum, group) => sum + group.mrr, 0));

const totalValue = (items: ChangeItemRow[]) => round2(items.reduce((sum, item) => sum + num(item.final_price), 0));

/** Por Emitir activa recalculable: no legacy, no unificada, no NC/ND. */
export const isEditablePending = (invoice: ChangeInvoiceRow) =>
	invoice.status === PENDING_STATUS &&
	invoice.is_active &&
	!invoice.is_legacy &&
	invoice.invoice_type !== UNIFIED_INVOICE_TYPE &&
	!/^(NC|ND)$/i.test(invoice.document_type ?? '');

/** Emitida (no NC/ND) **sin anular**: una anulada con NC de anulación activa no recibe otra NC (spec facturas §3.8). */
export const isIssued = (invoice: ChangeInvoiceRow) =>
	ISSUED_STATUSES.includes((invoice.status ?? '') as (typeof ISSUED_STATUSES)[number]) &&
	!/^(NC|ND)$/i.test(invoice.document_type ?? '') &&
	invoice.voided !== true;

/** Por Emitir facturada por OC (§3.7b: tiene líneas internas con `visible_line_id`): fija en el calendario, las modificaciones no la tocan. */
export const isPartialBilled = (invoice: ChangeInvoiceRow) => invoice.lines.some((line) => Boolean(line.visible_line_id));

/** ¿La factura ya tiene borrador en el ERP? (`odoo_invoice_id` o `sent_to_odoo_at`). */
export const hasErpDraft = (invoice: Pick<ChangeInvoiceRow, 'odoo_invoice_id' | 'sent_to_odoo_at'>) =>
	(invoice.odoo_invoice_id !== null && invoice.odoo_invoice_id !== undefined) || Boolean(invoice.sent_to_odoo_at);

/** Tasa fijada por factura desde el 360 (política por factura: `manual` o `net_exact`): el cambio de moneda/FX del contrato no la pisa. */
export const PER_INVOICE_FX_SOURCES = new Set(['manual', 'net_exact']);
export const hasPerInvoiceFx = (invoice: ChangeInvoiceRow) => invoice.lines.some((line) => PER_INVOICE_FX_SOURCES.has(line.fx_rate_source ?? ''));

/** Línea cuya cantidad sale de un consumo registrado (`consumption` / `estimated` o con fila en `consumption_entries`). */
export const isConsumptionLine = (line: Pick<ChangeInvoiceLineRow, 'quantity_source' | 'consumption'>) =>
	Boolean(line.consumption) || line.quantity_source === 'consumption' || line.quantity_source === 'estimated';

export const PARTIAL_BILLING_STEP = 'Edítala desde su vista rápida';
export const ERP_DRAFT_STALE_MESSAGE = 'La factura ya tiene un borrador en el ERP: elimínalo allí y restablece el borrador aquí para reenviarla';
export const ERP_DRAFT_STALE_STEP = 'Elimina el borrador en el ERP y usa "Restablecer borrador" en la factura para reenviarla';

/**
 * Recalcula una línea con consumo registrado **conservando su cantidad** (nunca la base del ítem): motor de precios con el modelo del ítem
 * (o estándar con `unitPerPeriod` si se indica, p. ej. el unitario nuevo de un cambio de precio), descuento y monto informado del consumo.
 */
export function repriceConsumptionLine(
	line: ChangeInvoiceLineRow,
	item: Pick<ChangeItemRow, 'raw'> | null,
	discountPct: number,
	unitPerPeriod: number | null
): PricedLine {
	const spec = item ? priceSpecFromRow(item.raw) : null;
	const source: QuantitySource = line.quantity_source === 'estimated' || line.consumption?.is_estimated ? 'estimated' : 'consumption';
	const options = {
		amount_override: line.consumption?.amount_override ?? null,
		apply_item_discount: line.consumption?.apply_item_discount !== false,
		quantity_source: source,
	};
	const quantity = line.consumption?.quantity ?? line.quantity;

	if (spec && spec.model !== 'standard' && spec.model !== 'seat') return priceLine(spec, quantity, discountPct, options);
	const unit = unitPerPeriod ?? (spec ? num(spec.unit_amount) : line.unit_price);

	if (spec) return priceLine({ ...spec, unit_amount: unit }, quantity, discountPct, options);

	return priceStandardLine(unit, quantity, discountPct, options);
}

const isUnified = (invoice: ChangeInvoiceRow) => invoice.invoice_type === UNIFIED_INVOICE_TYPE && invoice.status !== 'Cancelada';

/** Configuración del contrato para el generador (mismos defaults que la activación). */
export const engineContract = (contract: ChangeContractRow, overrides: Partial<BillingEngineContract> = {}): BillingEngineContract => ({
	billing_anchor_day: contract.billing_anchor_day,
	group_invoices_by_period: contract.group_invoices_by_period !== false,
	invoice_currency: upper(contract.invoice_currency) || upper(contract.contract_currency),
	contract_currency: upper(contract.contract_currency),
	fx_invoice_policy: contract.fx_invoice_policy,
	payment_terms: cleanPaymentTerms(contract.payment_terms) ?? cleanPaymentTerms(contract.entity.payment_terms),
	fixed_invoice_rates: contract.fx_invoice_rates,
	document_type: contract.document_type,
	company: { country: contract.company.country, tax_rate: contract.company.tax_rate },
	entity_country: contract.entity.country,
	description_template: contract.invoice_description_template ?? null,
	description_context: { contract_number: contract.contract_number, client_name: contract.entity.legal_name },
	description_max_chars: contract.description_max_chars ?? null,
	...overrides,
});

/** Día de ciclo efectivo del contrato (guardado o el del primer recurrente). */
export const anchorDayOf = (contract: ChangeContractRow, items: ChangeItemRow[]): number => {
	const saved = Number(contract.billing_anchor_day);

	if (Number.isInteger(saved) && saved >= 1 && saved <= 31) return saved;
	const first = liveRecurring(items)
		.map((item) => item.start_date)
		.filter((date): date is string => Boolean(date))
		.sort()[0];

	return first ? Number(first.slice(8, 10)) : 1;
};

/** Ítem nuevo al formato del generador (precio estándar fijo). */
export const engineItemFromNew = (item: NewItemRow): BillingEngineItem => ({
	key: item.key,
	product_id: item.product_id,
	product_name: item.product_name,
	account: item.account,
	quantity: item.quantity,
	unit_price: item.unit_price ?? num(item.annual_unit_price) / 12,
	discount_value: item.discount_value,
	discount_type: item.discount_type,
	billing_frequency: item.billing_frequency,
	billing_method: item.billing_method,
	start_date: item.start_date,
	term_months: item.term_months,
	end_date: item.end_date,
	is_recurring: item.is_recurring,
	final_price: item.final_price,
	price: item.price_spec ?? null,
});

/** Ítem existente al formato del generador (solo lo que necesita `itemPeriods`/`nextPeriodStart`). */
const engineShape = (item: ChangeItemRow) => ({
	start_date: item.start_date ?? '',
	end_date: item.end_date,
	term_months: num(item.term_months),
	billing_frequency: item.billing_frequency ?? 'Mensual',
	billing_method: item.billing_method ?? 'Anticipado',
});

/** Ítem nuevo como fila del contrato (para `items_after`, grupos y MRR). */
const asItemRow = (item: NewItemRow): ChangeItemRow => {
	const unit = item.unit_price ?? num(item.annual_unit_price) / 12;
	const pct = item.discount_type === 'Porcentaje' ? item.discount_value : 0;
	const monthly = REMOVAL_CATEGORIES.has(item.categoria)
		? round2(item.final_price / item.term_months)
		: round2(unit * item.quantity * (1 - pct / 100));
	const frequency = BILLING_FREQUENCY_MONTHS[item.billing_frequency as keyof typeof BILLING_FREQUENCY_MONTHS] ?? 1;

	return {
		id: item.key,
		product_id: item.product_id,
		product_name: item.product_name,
		account: item.account,
		item_type: item.item_type,
		categoria: item.categoria,
		unit_of_measure: item.unit_of_measure,
		quantity: item.quantity,
		unit_price: round6(unit),
		price_entry_mode: item.price_entry_mode,
		annual_unit_price: item.annual_unit_price,
		discount_type: item.discount_type,
		discount_value: item.discount_value,
		monthly_price: monthly,
		billing_period_price: round2(monthly * frequency),
		price: item.price,
		final_price: item.final_price,
		term_months: item.term_months,
		billing_frequency: item.billing_frequency,
		billing_method: item.billing_method,
		is_recurring: item.is_recurring,
		start_date: item.start_date,
		end_date: item.end_date,
		booking_date: item.booking_date,
		churn_date: null,
		related_item_id: item.related_item_id,
		renews_item_id: item.renews_item_id,
		renewed_by_item_id: null,
		auto_renew: item.auto_renew,
		currency: item.currency,
		price_id: item.price_id,
		raw: {},
	};
};

const previewOf = (item: ChangeItemRow, key?: string): PreviewItem => ({
	item_id: key ? null : item.id,
	key,
	product_name: item.product_name,
	account: item.account,
	categoria: item.categoria,
	quantity: item.quantity,
	unit_price: item.unit_price,
	monthly_price: item.monthly_price,
	start_date: item.start_date,
	end_date: item.end_date,
	related_item_id: item.related_item_id,
	renews_item_id: item.renews_item_id,
});

const monthsCount = (from: string, to: string) => {
	const [fy, fm] = from.split('-').map(Number);
	const [ty, tm] = to.split('-').map(Number);

	return Math.max(0, (ty - fy) * 12 + (tm - fm)) + 1;
};

/** Mensaje de un tipo diferido (400) o null si está construido. */
export const deferredMessage = (type: string): string | null =>
	(DEFERRED_CHANGE_TYPES as readonly string[]).includes(type) ? DEFERRED_MESSAGES[type as (typeof DEFERRED_CHANGE_TYPES)[number]] : null;

// ------------------------------------------------------------------ constructor del plan

class Planner {
	readonly blockers: ChangeBlocker[] = [];
	readonly warnings: ChangeWarning[] = [];
	readonly ops: WriteOp[] = [];
	readonly errors: FieldError[] = [];
	readonly added: PreviewItem[] = [];
	readonly adjusted: PreviewItem[] = [];
	readonly ended: ChangePreview['items']['ended'] = [];
	readonly updatedInvoices: ChangePreview['invoices']['updated'] = [];
	readonly createdInvoices: PreviewInvoice[] = [];
	readonly cancelledInvoices: ChangePreview['invoices']['cancelled'] = [];
	readonly creditNotes: ChangePreview['invoices']['credit_notes'] = [];
	itemsAfter: ChangeItemRow[];
	contractSet: Record<string, unknown> = {};
	bypassEndDate = false;
	mrrDelta = 0;
	rsmFromMonth: string | null = null;
	private counter = 0;
	/** Encabezados ya marcados para recálculo (una sola vez por factura). */
	private readonly headersTouched = new Map<string, { before: number; lines: number; change: string }>();
	/** Por Emitir facturadas por OC que el cambio habría tocado y deja como están (aviso `partial_billing_skipped`). */
	private readonly partialSkipped = new Map<string, ChangeInvoiceRow>();

	constructor(
		readonly ctx: ChangeContext,
		readonly req: ContractChangeRequestDto,
		readonly type: ChangeType
	) {
		this.itemsAfter = ctx.items.map((item) => ({ ...item }));
	}

	get effective() {
		return this.req.effective_date;
	}
	get change(): ContractChangeDto {
		return this.req.change;
	}

	block(code: string, message: string, nextStep: string | null = null) {
		if (!this.blockers.some((blocker) => blocker.code === code && blocker.message === message))
			this.blockers.push({ code, message, next_step: nextStep });
	}
	warn(code: string, message: string) {
		if (!this.warnings.some((warning) => warning.code === code && warning.message === message)) this.warnings.push({ code, message });
	}
	error(field: string, message: string) {
		this.errors.push({ field, message });
	}
	newKey() {
		this.counter += 1;

		return `new:${this.counter}`;
	}
	touchRsm(monthIso: string) {
		const first = month(monthIso);

		if (!this.rsmFromMonth || first < this.rsmFromMonth) this.rsmFromMonth = first;
	}

	// ---- estado y guardas comunes

	/** Estado mostrado hoy; bloquea si el tipo no lo admite. */
	assertState(): ContractDerivedStatus {
		const status = deriveContractStatus(this.ctx.contract.status, this.ctx.items, this.ctx.today);
		const allowed = ALLOWED_STATES[this.type];

		if (!allowed.includes(status)) {
			this.block(
				'not_active',
				`El contrato está ${STATUS_LABELS[status]}: este cambio se admite en ${allowed.map((state) => STATUS_LABELS[state]).join(', ')}`,
				status === 'cancelled' ? 'Reactivar el contrato (cuando exista) o crear uno nuevo' : null
			);
		}

		return status;
	}

	/** Fecha en período cerrado → `period_closed` (guard de ítems al insertar con `start_date <= cutoff`). */
	assertOpenPeriod(date: string, what = 'La fecha efectiva') {
		const cutoff = this.ctx.contract.cutoff_date;

		if (cutoff && date <= cutoff)
			this.block('period_closed', `${what} (${date}) cae en un período cerrado (cierre al ${cutoff})`, REOPEN_PERIOD_STEP);
	}

	findItem(itemId: string, field: string): ChangeItemRow | null {
		const item = this.ctx.items.find((row) => row.id === itemId);

		if (!item) this.error(field, 'El ítem no pertenece al contrato');

		return item ?? null;
	}

	assertRemovable(item: ChangeItemRow) {
		if (item.churn_date || REMOVAL_CATEGORIES.has(item.categoria ?? '')) {
			this.block(
				'item_already_churned',
				`"${item.product_name}" ya tiene una baja registrada${item.churn_date ? ` (desde el ${item.churn_date})` : ''}`
			);

			return false;
		}
		if (item.renewed_by_item_id) {
			this.block('item_already_renewed', `"${item.product_name}" ya fue renovado: la baja o el cambio se hace sobre el ítem de la renovación`);

			return false;
		}

		return true;
	}

	// ---- ítems

	insertItem(item: NewItemRow) {
		this.ops.push({ kind: 'insert_item', item });
		const row = asItemRow(item);

		this.itemsAfter.push(row);
		this.added.push(previewOf(row, item.key));
		this.touchRsm(item.start_date);

		return row;
	}

	churnItem(item: ChangeItemRow, timing: 'early' | 'non_renewal', monthly: number) {
		this.ops.push({ kind: 'update_item', item_id: item.id, set: { churn_date: this.effective, churn_monthly_amount: monthly } });
		const after = this.itemsAfter.find((row) => row.id === item.id)!;

		after.churn_date = this.effective;
		this.ended.push({ item_id: item.id, churn_date: this.effective, timing });
		this.touchRsm(timing === 'non_renewal' && item.end_date ? addDays(item.end_date, 1) : this.effective);
	}

	// ---- facturas Por Emitir (cambio mínimo, F3)

	/** Facturada por OC (§3.7b): fija en el calendario; se omite y se lista en `partial_billing_skipped`. */
	skipPartial(invoice: ChangeInvoiceRow): boolean {
		if (!isPartialBilled(invoice)) return false;
		this.partialSkipped.set(invoice.id, invoice);

		return true;
	}

	/** Avisos agregados al cierre: facturas por OC omitidas y Por Emitir tocadas que ya tienen borrador en el ERP (no bloquean). */
	private closeInvoiceWarnings() {
		const label = (invoice: ChangeInvoiceRow) => invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`;

		if (this.partialSkipped.size) {
			const list = [...this.partialSkipped.values()].map(label).join(', ');

			this.warnings.push({
				code: 'partial_billing_skipped',
				message: `${this.partialSkipped.size === 1 ? 'La factura' : 'Las facturas'} ${list} ${
					this.partialSkipped.size === 1 ? 'está facturada' : 'están facturadas'
				} por OC: el cambio no ${this.partialSkipped.size === 1 ? 'la' : 'las'} toca (edítala desde su vista rápida)`,
				next_step: PARTIAL_BILLING_STEP,
			});
		}
		const touched = new Set<string>();

		for (const op of this.ops) {
			if ('invoice_id' in op) touched.add(op.invoice_id);
			if (op.kind === 'create_invoices') op.merge_into.forEach((id) => id && touched.add(id));
			if (op.kind === 'update_invoices_fields' || op.kind === 'update_invoices_document') op.invoice_ids.forEach((id) => touched.add(id));
			if (op.kind === 'update_invoices_fx') op.targets.forEach((target) => touched.add(target.invoice_id));
		}
		const stale = this.ctx.invoices.filter((invoice) => touched.has(invoice.id) && invoice.status === PENDING_STATUS && hasErpDraft(invoice));

		if (stale.length)
			this.warnings.push({
				code: 'erp_draft_stale',
				message: `${ERP_DRAFT_STALE_MESSAGE} (${stale.map(label).join(', ')})`,
				next_step: ERP_DRAFT_STALE_STEP,
			});
	}

	private touchHeader(invoice: ChangeInvoiceRow, change: string) {
		const touched = this.headersTouched.get(invoice.id);

		if (touched) {
			touched.lines += 1;
			if (!touched.change.includes(change)) touched.change = `${touched.change} · ${change}`;
		} else this.headersTouched.set(invoice.id, { before: invoice.subtotal, lines: 1, change });
	}

	/** Una línea editada a mano (spec facturas §3.4) no se quita ni se reescribe: se informa con `manual_edit_kept` y queda como está. */
	private keepManual(invoice: ChangeInvoiceRow, line: ChangeInvoiceLineRow): boolean {
		if (line.quantity_source !== 'manual') return false;
		this.warn(
			'manual_edit_kept',
			`La factura ${invoice.invoice_number ?? invoice.issue_date ?? invoice.id} tiene la línea "${line.description ?? line.id}" editada a mano: el cambio no la toca (ajústala desde la factura)`
		);

		return true;
	}

	deleteLine(invoice: ChangeInvoiceRow, line: ChangeInvoiceLineRow) {
		if (this.keepManual(invoice, line)) return;
		this.ops.push({ kind: 'delete_line', invoice_id: invoice.id, line_id: line.id });
		invoice.lines = invoice.lines.filter((row) => row.id !== line.id);
		this.touchHeader(invoice, 'línea quitada');
	}

	updateLine(invoice: ChangeInvoiceRow, line: ChangeInvoiceLineRow, values: ChangeLineAmounts, change: string) {
		if (this.keepManual(invoice, line)) return;
		this.ops.push({ kind: 'update_line', invoice_id: invoice.id, line_id: line.id, values });
		line.quantity = values.quantity;
		line.unit_price = values.unit_price;
		line.subtotal = values.subtotal;
		line.tax_amount = values.tax_amount;
		line.total = values.total;
		if (values.billing_period_end) line.billing_period_end = values.billing_period_end;
		this.touchHeader(invoice, change);
	}

	/** Cierra los encabezados tocados: recalcula (o cancela si quedó sin líneas) y arma `invoices.updated/cancelled`. */
	closeHeaders(note: string) {
		for (const [invoiceId, touched] of this.headersTouched) {
			const invoice = this.ctx.invoices.find((row) => row.id === invoiceId)!;
			const after = round2(invoice.lines.reduce((sum, line) => sum + line.subtotal, 0));

			if (invoice.lines.length === 0) {
				this.ops.push({ kind: 'cancel_invoice', invoice_id: invoiceId, note });
				this.cancelledInvoices.push({ id: invoiceId, invoice_number: invoice.invoice_number, issue_date: invoice.issue_date });
			} else {
				this.ops.push({ kind: 'recompute_header', invoice_id: invoiceId, cancel_if_empty: false, note });
				this.updatedInvoices.push({
					id: invoiceId,
					invoice_number: invoice.invoice_number,
					issue_date: invoice.issue_date,
					lines_changed: touched.lines,
					subtotal_before: touched.before,
					subtotal_after: after,
					change: touched.change,
				});
			}
		}
		this.headersTouched.clear();
	}

	/** Bloquea si una factura unificada vigente tiene líneas de los ítems en el rango (A.5 pendiente). */
	assertNoUnified(itemIds: Set<string>, from: string) {
		for (const invoice of this.ctx.invoices.filter(isUnified)) {
			if (
				invoice.lines.some((line) => line.contract_item_id && itemIds.has(line.contract_item_id) && (line.billing_period_end ?? '') >= from)
			) {
				this.block(
					'unified_invoice_in_range',
					`La factura unificada ${invoice.invoice_number ?? invoice.id} incluye líneas de los ítems afectados desde el ${from}`,
					'Desunificar la factura en Facturación antes de aplicar el cambio'
				);
			}
		}
	}

	/**
	 * Baja de un ítem en sus facturas: en Por Emitir se quita solo su línea con período ≥ fecha (y se prorratea por días la que
	 * contiene la fecha, cortes U5); emitidas con período ≥ fecha → NC espejo exacto de la original (ROADMAP #10).
	 */
	removeItemFromInvoices(item: ChangeItemRow, from: string, label: string) {
		for (const invoice of this.ctx.invoices) {
			const lines = invoice.lines.filter(
				(line) => line.contract_item_id === item.id && line.billing_period_end && line.billing_period_end >= from
			);

			if (!lines.length) continue;
			if (isEditablePending(invoice)) {
				if (this.skipPartial(invoice)) continue;
				for (const line of lines) {
					const start = line.billing_period_start ?? line.billing_period_end!;

					if (start >= from) {
						this.deleteLine(invoice, line);
						continue;
					}
					// Consumo registrado del período: la cantidad es lo realmente usado; no se prorratea ni se reinicia (queda como está).
					if (isConsumptionLine(line)) {
						this.warn(
							'consumption_line_kept',
							`La factura ${invoice.invoice_number ?? invoice.issue_date ?? invoice.id} lleva el consumo registrado de "${line.description ?? line.id}" (${line.quantity}): se conserva sin prorratear`
						);
						continue;
					}
					// Período que contiene la fecha: se cobra lo servido (días exactos), fin del período = fecha − 1.
					const total = diffDays(start, line.billing_period_end!) + 1;
					const served = diffDays(start, from);
					const ratio = served / total;
					const subtotal = round2(line.subtotal * ratio);
					const tax = round2((subtotal * invoice.tax_rate) / 100);

					this.updateLine(
						invoice,
						line,
						{
							quantity: line.quantity,
							unit_price: round6(line.unit_price * ratio),
							discount_pct: line.discount_pct,
							subtotal,
							tax_amount: tax,
							total: round2(subtotal + tax),
							billing_period_end: addDays(from, -1),
							description_suffix: ` (ajustada por ${label}: ${served}/${total} días, hasta ${addDays(from, -1)})`,
						},
						'línea prorrateada por días'
					);
				}
			} else if (isIssued(invoice)) {
				// La parte no consumida se acredita sobre lo que queda de cada línea después de las NC de descuento vigentes (nunca dos veces lo mismo).
				const mirror = lines
					.map((line) => {
						const start = line.billing_period_start ?? line.billing_period_end!;
						const periodStart = start > from ? start : from;
						const total = diffDays(start, line.billing_period_end!) + 1;
						const credited = diffDays(periodStart, line.billing_period_end!) + 1;
						const timeRatio = total > 0 ? credited / total : 1;
						const remaining = line.subtotal > 0 ? Math.max(0, line.subtotal - num(line.previously_credited)) / line.subtotal : 1;

						return { line, ratio: timeRatio * remaining, period_start: periodStart };
					})
					.filter((entry) => entry.ratio > 0);
				const amount = round2(mirror.reduce((sum, entry) => sum + entry.line.subtotal * entry.ratio, 0));

				if (amount <= 0) continue;
				this.ops.push({
					kind: 'credit_note',
					mirrors: invoice,
					lines: mirror,
					note: `NC por ${label} del contrato; factura original ${invoice.invoice_number ?? invoice.id}`,
				});
				this.creditNotes.push({
					mirrors_invoice_id: invoice.id,
					mirrors_invoice_number: invoice.invoice_number,
					total: round2(amount * (1 + invoice.tax_rate / 100)),
					currency: invoice.invoice_currency,
					fx: invoice.fx,
				});
				if (invoice.status !== 'Pagada') {
					this.warn(
						'unpaid_invoice_prorated',
						`La factura ${invoice.invoice_number ?? invoice.id} está ${invoice.status} y recibe una nota de crédito por ${invoice.invoice_currency ?? ''} ${money(amount)} neto`
					);
				}
			}
		}
	}

	/** Facturas del generador para ítems nuevos: bloqueo por tasa fija faltante, tramo inicial suelto y fusión con PE del mes (F3). */
	addGeneratedInvoices(items: NewItemRow[], firstPeriod: 'cycle' | 'immediate') {
		if (!items.length) return;
		const contract = this.ctx.contract;
		const engine = generateInvoices({ contract: engineContract(contract), items: items.map(engineItemFromNew) });
		const contractCurrency = upper(contract.contract_currency);
		const invoiceCurrency = upper(contract.invoice_currency) || contractCurrency;
		const usesFixedFx = contract.fx_invoice_policy === 'fixed' && invoiceCurrency !== contractCurrency;
		let invoices = engine.invoices;
		let stubs = new Set<number>();

		if (firstPeriod === 'immediate') ({ invoices, stubs } = splitImmediateStubs(invoices, items, contract));
		const fittedWarning = engine.description_fitted_lines
			? descriptionFittedWarning(engine.description_fitted_lines, contract.description_max_chars ?? null)
			: null;

		for (const warning of engine.warnings) this.warn(warning === fittedWarning ? DESCRIPTION_FITTED_CODE : 'generator', warning);
		if (usesFixedFx) {
			for (const invoice of invoices.filter((row) => row.fx === null)) {
				this.block(
					'fixed_fx_without_rate',
					`Se factura en ${invoiceCurrency} con tipo de cambio fijo y la factura del ${invoice.issue_date} no tiene tasa ${contractCurrency} → ${invoiceCurrency}`,
					'Cargar la tasa del período en las condiciones de facturación'
				);
			}
		}
		// El tramo suelto (S3-17) nunca se fusiona: es una factura propia el día de inicio del ítem.
		const mergeInto = invoices.map((invoice, index) => (stubs.has(index) ? null : this.mergeTarget(invoice)));

		for (const [index, invoice] of invoices.entries()) {
			const target = mergeInto[index];

			if (target) {
				const existing = this.ctx.invoices.find((row) => row.id === target)!;
				const before = existing.subtotal;
				const added = invoice.lines.reduce((sum, line) => sum + line.subtotal, 0);

				this.updatedInvoices.push({
					id: existing.id,
					invoice_number: existing.invoice_number,
					issue_date: existing.issue_date,
					lines_changed: invoice.lines.length,
					subtotal_before: before,
					subtotal_after: round2(before + added),
					change: `se suma a la factura del ${existing.issue_date}`,
				});
				existing.subtotal = round2(before + added);
			} else this.createdInvoices.push(invoice);
			this.touchRsm(invoice.billing_period_start);
		}
		this.ops.push({
			kind: 'create_invoices',
			invoices,
			fixed_rates: invoices.map((invoice) => (usesFixedFx && invoice.fx !== null ? invoice.fx : null)),
			merge_into: mergeInto,
		});
	}

	/** PE activa del mismo receptor, moneda, tipo de documento y mes de emisión (S3-13); solo si el contrato agrupa juntas. */
	mergeTarget(invoice: PreviewInvoice): string | null {
		const contract = this.ctx.contract;

		if (contract.group_invoices_by_period === false) return null;
		const candidates = this.ctx.invoices
			.filter(isEditablePending)
			.filter(
				(row) =>
					(row.client_entity_id ?? contract.client_entity_id) === contract.client_entity_id &&
					upper(row.invoice_currency) === upper(invoice.currency) &&
					(row.document_type ?? 'FACTURA') === invoice.document_type &&
					(row.issue_date ?? '').slice(0, 7) === invoice.issue_date.slice(0, 7) &&
					(row.issue_date ?? '') >= this.ctx.today
			)
			.sort((a, b) => (a.issue_date ?? '').localeCompare(b.issue_date ?? ''));
		// Una facturada por OC no recibe líneas: la nueva va a otra Por Emitir del mes o a una factura propia.
		const target = candidates.find((row) => !isPartialBilled(row)) ?? null;

		candidates
			.filter((row) => isPartialBilled(row) && (!target || (row.issue_date ?? '') <= (target.issue_date ?? '')))
			.forEach((row) => this.skipPartial(row));

		return target?.id ?? null;
	}

	// ---- cierre

	finish(
		event: Omit<ChangeEvent, 'items_affected' | 'new_item_keys' | 'rsm_from_month' | 'metadata'> & {
			items_affected?: string[];
			metadata?: Record<string, unknown>;
		}
	): ChangePlan {
		if (this.errors.length) throw validationException(this.errors);
		this.closeInvoiceWarnings();
		const { contract, items, today } = this.ctx;
		const statusBefore = deriveContractStatus(contract.status, items, today);
		const statusAfterRaw = this.contractSet.status === CONTRACT_CANCELLED ? CONTRACT_CANCELLED : contract.status;
		const statusAfter = deriveContractStatus(statusAfterRaw, this.itemsAfter, today);
		const endAfter = this.type === 'contract_cancel' ? contract.contract_end_date : nearestContractEnd(this.itemsAfter);
		const touchesItems = this.added.length > 0 || this.ended.length > 0 || this.adjusted.length > 0;

		if (touchesItems) {
			this.contractSet.total_value = totalValue(this.itemsAfter);
			if (endAfter && endAfter !== contract.contract_end_date) {
				this.contractSet.contract_end_date = endAfter;
				this.bypassEndDate = true;
			}
		}
		if (Object.keys(this.contractSet).length)
			this.ops.push({ kind: 'update_contract', set: this.contractSet, bypass_end_date_guard: this.bypassEndDate });

		const mrrBefore = contractMrr(items, this.effective);
		const mrrAfter = contractMrr(this.itemsAfter, this.effective);
		const cutoff = contract.cutoff_date;
		const lastMonth = this.itemsAfter
			.map((item) => item.end_date)
			.filter((date): date is string => Boolean(date))
			.sort()
			.reverse()[0];
		const pendingLines: PendingInvoiceLine[] = this.ctx.invoices.filter(isEditablePending).flatMap((invoice) =>
			invoice.lines
				.filter((line) => line.contract_item_id)
				.map((line) => ({
					invoice_id: invoice.id,
					issue_date: invoice.issue_date,
					contract_item_id: line.contract_item_id!,
					subtotal: line.subtotal,
				}))
		);
		const preview: ChangePreview = {
			type: this.type,
			effective_date: this.effective,
			contract: {
				before: { mrr: mrrBefore, total_value: num(contract.total_value), end_date: contract.contract_end_date, status: statusBefore },
				after: {
					mrr: mrrAfter,
					total_value: touchesItems ? totalValue(this.itemsAfter) : num(contract.total_value),
					end_date: touchesItems ? endAfter : contract.contract_end_date,
					status: statusAfter,
				},
			},
			items: {
				added: this.added,
				adjusted: this.adjusted,
				ended: this.ended,
				groups_after: buildItemGroups(this.itemsAfter, this.effective, pendingLines),
			},
			invoices: {
				updated: this.updatedInvoices,
				created: this.createdInvoices,
				cancelled: this.cancelledInvoices,
				credit_notes: this.creditNotes,
			},
			rsm: {
				mrr_delta: round2(this.mrrDelta || mrrAfter - mrrBefore),
				momentum: this.rsmFromMonth ? event.type : null,
				first_month: this.rsmFromMonth,
				months_rebuilt: this.rsmFromMonth && lastMonth ? monthsCount(this.rsmFromMonth, month(lastMonth)) : 0,
				closed_months_skipped: this.rsmFromMonth && cutoff && cutoff >= this.rsmFromMonth ? monthsCount(this.rsmFromMonth, month(cutoff)) : 0,
			},
			warnings: this.warnings,
			blockers: this.blockers,
			can_apply: this.blockers.length === 0,
		};

		return {
			preview,
			ops: this.ops,
			items_after: this.itemsAfter,
			event: {
				...event,
				items_affected: event.items_affected ?? [
					...this.ended.map((entry) => entry.item_id),
					...this.adjusted.map((entry) => entry.item_id!).filter(Boolean),
				],
				new_item_keys: this.added.map((entry) => entry.key!).filter(Boolean),
				rsm_from_month: this.rsmFromMonth,
				metadata: {
					source: 'api_v2',
					change_type: this.type,
					origin: this.req.origin ?? { type: 'manual' },
					reason: this.req.reason ?? null,
					reason_id: this.req.reason_id ?? null,
					notes: this.req.notes ?? null,
					before: preview.contract.before,
					after: preview.contract.after,
					warnings: this.warnings.map((warning) => warning.code),
					...(event.metadata ?? {}),
				},
			},
		};
	}
}

/**
 * S3-17 "factura suelta inmediata": el tramo inicial de cada ítem nuevo (período que empieza en su inicio y termina antes
 * del primer ciclo) sale de la factura del ciclo y se emite aparte el día de inicio del ítem.
 */
export function splitImmediateStubs(
	invoices: PreviewInvoice[],
	items: NewItemRow[],
	contract: ChangeContractRow
): { invoices: PreviewInvoice[]; stubs: Set<number> } {
	const result: Array<PreviewInvoice & { stub?: boolean }> = [];
	const terms = cleanPaymentTerms(contract.payment_terms) ?? cleanPaymentTerms(contract.entity.payment_terms);

	for (const invoice of invoices) {
		const stubs = invoice.lines.filter((line) => {
			const item = items.find((row) => row.key === line.item_key);

			return item?.is_recurring && line.billing_period_start === item.start_date && line.billing_period_end < invoice.issue_date;
		});

		if (!stubs.length) {
			result.push(invoice);
			continue;
		}
		const rest = invoice.lines.filter((line) => !stubs.includes(line));
		const sum = (lines: PreviewInvoice['lines']) => ({
			subtotal: round2(lines.reduce((total, line) => total + line.subtotal, 0)),
			tax: round2(lines.reduce((total, line) => total + line.tax_amount, 0)),
		});

		if (rest.length) {
			const amounts = sum(rest);

			result.push({
				...invoice,
				lines: rest,
				billing_period_start: rest.map((line) => line.billing_period_start).sort()[0],
				subtotal: amounts.subtotal,
				tax: amounts.tax,
				total: round2(amounts.subtotal + amounts.tax),
				amounts_invoice_currency: undefined,
			});
		}
		const byStart = new Map<string, typeof stubs>();

		for (const line of stubs) byStart.set(line.billing_period_start, [...(byStart.get(line.billing_period_start) ?? []), line]);
		for (const [start, lines] of byStart) {
			const amounts = sum(lines);

			result.push({
				...invoice,
				stub: true,
				issue_date: start,
				due_date: computeDueDate(start, terms, contract.company.country),
				billing_period_start: start,
				billing_period_end: lines
					.map((line) => line.billing_period_end)
					.sort()
					.reverse()[0],
				lines,
				subtotal: amounts.subtotal,
				tax: amounts.tax,
				total: round2(amounts.subtotal + amounts.tax),
				amounts_invoice_currency: undefined,
			});
		}
	}

	const sorted = result.sort((a, b) => a.issue_date.localeCompare(b.issue_date));

	return {
		stubs: new Set(sorted.map((invoice, index) => (invoice.stub ? index : -1)).filter((index) => index >= 0)),
		// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- se descarta la marca interna
		invoices: sorted.map(({ stub: _stub, ...invoice }) => invoice),
	};
}

// ------------------------------------------------------------------ fórmula unificada del delta (manual §8)

export interface DeltaInput {
	current_quantity: number;
	current_mrr: number;
	new_quantity: number;
	/** Unitario **mensual** nuevo. */
	new_unit_price: number;
	discount_pct: number;
}

export interface DeltaResult {
	monthly_new: number;
	mrr_delta: number;
	categoria: 'UPSELL' | 'DOWNSELL';
	quantity: number;
	unit_price: number;
	quantity_delta: number;
}

/**
 * `mensual_nuevo = round2(q_n × p_n × (1 − desc%))`, `ΔMRR = mensual_nuevo − mensual_actual`; el signo decide UPSELL/DOWNSELL.
 * `Δq ≠ 0`: `qty = (DOWNSELL ? −Δq : +Δq)`, `unit = ΔMRR / qty`; `Δq = 0`: `qty = q_actual` (ancla), `unit = ΔMRR / q_actual`.
 * Siempre `qty × unit = ΔMRR` (STG −46,40 vs +51,20; cruzado 100 × 10 → 120 × 7).
 */
export function unifiedDelta(input: DeltaInput): DeltaResult | null {
	const monthlyNew = round2(input.new_quantity * input.new_unit_price * (1 - input.discount_pct / 100));
	const mrrDelta = round2(monthlyNew - input.current_mrr);

	if (mrrDelta === 0) return null;
	const categoria = mrrDelta > 0 ? 'UPSELL' : 'DOWNSELL';
	const quantityDelta = round6(input.new_quantity - input.current_quantity);
	const quantity = quantityDelta !== 0 ? (categoria === 'DOWNSELL' ? -quantityDelta : quantityDelta) : input.current_quantity;

	return {
		monthly_new: monthlyNew,
		mrr_delta: mrrDelta,
		categoria,
		quantity,
		unit_price: round6(mrrDelta / quantity),
		quantity_delta: quantityDelta,
	};
}

// ------------------------------------------------------------------ planificadores por tipo

function planItemRemove(p: Planner, itemIds: string[], label: 'item_remove' | 'contract_cancel') {
	const removed = new Set<string>();
	let totalDelta = 0;
	let timing: 'early' | 'non_renewal' | 'mixed' | null = null;

	for (const [index, itemId] of itemIds.entries()) {
		const item = p.findItem(itemId, `change.items.${index}.item_id`);

		if (!item || !p.assertRemovable(item)) continue;
		const monthly = itemMonthly(item);
		const itemTiming: 'early' | 'non_renewal' = item.end_date && p.effective > item.end_date ? 'non_renewal' : 'early';

		timing = timing === null || timing === itemTiming ? itemTiming : 'mixed';
		removed.add(item.id);
		if (item.is_recurring === false || monthly === 0) {
			if (monthly === 0) p.warn('mrr_zero_items_skipped', `"${item.product_name}" tiene MRR 0: se marca la baja sin ajuste de MRR`);
			p.churnItem(item, itemTiming, 0);
			p.removeItemFromInvoices(item, p.effective, label === 'contract_cancel' ? 'cancelación' : 'baja');
			continue;
		}
		if (itemTiming === 'early') {
			p.assertOpenPeriod(p.effective);
			const term = monthsCeil(p.effective, item.end_date!);
			const quantity = num(item.quantity) || 1;
			const unit = round6(-monthly / quantity);

			p.insertItem({
				key: p.newKey(),
				product_id: item.product_id,
				product_name: item.product_name ?? 'Producto',
				account: item.account,
				item_type: item.item_type,
				unit_of_measure: item.unit_of_measure,
				categoria: 'CHURN', // se ajusta a DOWNSELL abajo si quedan otros productos
				quantity,
				unit_price: unit,
				annual_unit_price: round6(unit * 12),
				price_entry_mode: 'monthly',
				discount_type: null,
				discount_value: 0,
				price: round2(-monthly * term),
				final_price: round2(-monthly * term),
				currency: item.currency ?? p.ctx.contract.contract_currency,
				billing_frequency: item.billing_frequency ?? 'Mensual',
				billing_method: item.billing_method ?? 'Anticipado',
				is_recurring: true,
				start_date: p.effective,
				end_date: item.end_date!,
				term_months: term,
				related_item_id: item.id,
				renews_item_id: null,
				booking_date: p.effective,
				auto_renew: false,
				price_id: null,
				quote_item_id: null,
			});
		}
		p.churnItem(item, itemTiming, monthly);
		p.removeItemFromInvoices(item, p.effective, label === 'contract_cancel' ? 'cancelación' : 'baja');
		totalDelta -= monthly;
	}
	p.assertNoUnified(removed, p.effective);
	// Un producto que se quita mientras siguen otros es DOWNSELL a nivel métricas (benchmark §6); el último, CHURN.
	const remaining = liveRecurring(p.itemsAfter).filter((item) => !removed.has(item.id) && !item.id.startsWith('new:'));
	const categoria = remaining.length ? 'DOWNSELL' : 'CHURN';

	for (const op of p.ops)
		if (op.kind === 'insert_item' && op.item.categoria === 'CHURN' && categoria === 'DOWNSELL') op.item.categoria = 'DOWNSELL';
	for (const row of p.itemsAfter)
		if (row.id.startsWith('new:') && row.categoria === 'CHURN' && categoria === 'DOWNSELL') row.categoria = 'DOWNSELL';
	for (const entry of p.added) if (entry.categoria === 'CHURN' && categoria === 'DOWNSELL') entry.categoria = 'DOWNSELL';
	p.mrrDelta = round2(totalDelta);

	return { categoria, timing, removed, totalDelta: round2(totalDelta) };
}

function assertReason(p: Planner) {
	if (p.req.reason_id && !p.ctx.churn_reason) p.error('reason_id', 'El motivo de catálogo no existe o está inactivo en el holding');
	if (!p.req.reason_id && !p.req.reason?.trim()) p.error('reason', 'Indica el motivo de la baja (catálogo o texto)');
}

export function planRemove(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'item_remove');
	const refs = (req.change.items ?? []) as Array<{ item_id?: string }>;

	p.assertState();
	assertReason(p);
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a quitar');
	const { categoria, timing, totalDelta } = planItemRemove(
		p,
		refs.map((ref) => String(ref.item_id ?? '')),
		'item_remove'
	);

	p.closeHeaders(`Línea quitada por ${categoria === 'CHURN' ? 'churn' : 'downsell'} desde el ${p.effective}`);
	if (categoria === 'CHURN') {
		p.warn(
			'contract_without_live_items',
			'Con esta baja el contrato queda sin ítems recurrentes vigentes; el estado no cambia solo: para cancelarlo usa "Cancelar contrato"'
		);
	}
	const names = refs.map((ref) => ctx.items.find((item) => item.id === ref.item_id)?.product_name).filter(Boolean);

	return p.finish({
		type: categoria,
		subtype: timing,
		title: categoria === 'CHURN' ? 'Baja de ítems (churn parcial)' : 'Baja de producto (downsell)',
		description: `Se dio de baja ${names.join(', ')} desde el ${p.effective}: MRR ${ctx.contract.contract_currency} ${money(totalDelta)}`,
		amount_delta: totalDelta,
		metadata: { timing, churn_reason: ctx.churn_reason?.name ?? null },
	});
}

export function planCancel(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'contract_cancel');

	p.assertState();
	assertReason(p);
	// Por Emitir con líneas editadas a mano desde la fecha efectiva: la cancelación no decide por la usuaria (rediseño del flujo diferido).
	const manual = ctx.invoices
		.filter(isEditablePending)
		.filter((invoice) => !isPartialBilled(invoice))
		.filter((invoice) =>
			invoice.lines.some(
				(line) => line.quantity_source === 'manual' && (line.billing_period_end ?? invoice.issue_date ?? '') >= req.effective_date
			)
		);

	if (manual.length)
		p.block(
			'manual_lines_pending',
			`${manual.length === 1 ? 'La factura por emitir' : 'Las facturas por emitir'} ${manual
				.map((invoice) => invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`)
				.join(', ')} ${manual.length === 1 ? 'tiene' : 'tienen'} líneas editadas a mano desde el ${req.effective_date}`,
			'Edita o cancela esas facturas primero'
		);
	const targets = ctx.items.filter(
		(item) => item.is_recurring !== false && !REMOVAL_CATEGORIES.has(item.categoria ?? '') && !item.churn_date && !item.renewed_by_item_id
	);
	const { totalDelta, timing } = planItemRemove(
		p,
		targets.map((item) => item.id),
		'contract_cancel'
	);

	// PE futuras del contrato sin líneas de ítems recurrentes (no recurrentes, líneas sin ítem) también se cancelan.
	for (const invoice of ctx.invoices.filter(isEditablePending)) {
		if (
			(invoice.issue_date ?? '') >= p.effective &&
			invoice.lines.length &&
			!p.skipPartial(invoice) &&
			!p.ops.some((op) => op.kind !== 'insert_item' && op.kind !== 'update_item' && 'invoice_id' in op && op.invoice_id === invoice.id)
		) {
			for (const line of [...invoice.lines]) p.deleteLine(invoice, line);
		}
	}
	p.closeHeaders(`Cancelada por cancelación del contrato desde el ${p.effective}`);
	p.contractSet = {
		status: CONTRACT_CANCELLED,
		churn_date: p.effective,
		churn_reason_id: ctx.churn_reason?.id ?? null,
		churn_reason: ctx.churn_reason?.name ?? req.reason ?? null,
	};

	return p.finish({
		type: 'CHURN',
		subtype: 'contract_cancel',
		title: 'Cancelación de contrato (churn)',
		description:
			`Se canceló ${ctx.contract.contract_number ?? ''} desde el ${p.effective}: MRR ${ctx.contract.contract_currency} ${money(totalDelta)}`.replace(
				/\s+/g,
				' '
			),
		amount_delta: totalDelta,
		metadata: { timing, churn_reason: ctx.churn_reason?.name ?? null },
	});
}

export function planRenewal(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'renewal');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const newItems: NewItemRow[] = [];
	const renewed: Array<{ item_id: string; key: string; absorbed: string[] }> = [];

	p.assertState();
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a renovar');
	if (req.change.catch_up === 'current_month') {
		p.error('change.catch_up', 'El catch-up en el mes actual todavía no está construido en el devengo: usa backdate (corregir hacia atrás)');
	}
	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const item = p.findItem(String(ref.item_id ?? ''), `${field}.item_id`);

		if (!item) continue;
		for (const key of ['quantity', 'unit_price', 'discount_value'] as const) {
			if (ref[key] !== undefined && ref[key] !== null) {
				p.error(
					`${field}.${key}`,
					'La renovación con cambio de precio se construye cuando se confirme S3-15 (RENEWAL al precio anterior + ajuste explícito)'
				);
			}
		}
		if (item.is_recurring === false) {
			p.error(`${field}.item_id`, `"${item.product_name}" no es recurrente: no se renueva`);
			continue;
		}
		if (!item.end_date) {
			p.error(`${field}.item_id`, `"${item.product_name}" no tiene fecha de fin: no hay qué renovar`);
			continue;
		}
		if (!p.assertRemovable(item)) continue;
		const start = addDays(item.end_date, 1);
		let term = Number(ref.term_months ?? item.term_months) || 1;

		if (typeof ref.end_date === 'string') {
			const whole = wholeMonths(start, ref.end_date);

			if (!whole) {
				p.error(
					`${field}.end_date`,
					`El fin ${ref.end_date} no es un número entero de meses desde el ${start} (por ejemplo, ${itemEndDate(start, monthsCeil(start, ref.end_date))})`
				);
				continue;
			}
			term = whole;
		}
		const end = itemEndDate(start, term);

		p.assertOpenPeriod(start, `El inicio de la renovación de "${item.product_name}"`);
		if (start < p.effective)
			p.warn(
				'retroactive_renewal',
				`"${item.product_name}" venció el ${item.end_date}: la renovación parte el ${start} y el devengo se corrige hacia atrás`
			);
		// Los ajustes vivos co-terminados se absorben: la renovación parte del valor vigente del ítem madre (S3-15 "valor anterior").
		const children = ctx.items.filter(
			(row) =>
				row.related_item_id === item.id &&
				DELTA_CATEGORIES.has(row.categoria ?? '') &&
				!row.churn_date &&
				!row.renewed_by_item_id &&
				row.end_date === item.end_date
		);
		const group = buildItemGroups([item, ...children], item.end_date)[0];
		const quantity = group?.quantity ?? num(item.quantity);
		const mrr = group?.mrr ?? itemMonthly(item);
		const pct = item.discount_type === 'Porcentaje' ? num(item.discount_value) : 0;
		const unit = children.length ? round6(mrr / (quantity * (1 - pct / 100))) : num(item.unit_price ?? num(item.annual_unit_price) / 12);
		const price = round2(unit * quantity * term);
		const key = p.newKey();
		const annual = item.price_entry_mode === 'annual';

		if (children.length)
			p.warn(
				'adjustments_absorbed',
				`La renovación de "${item.product_name}" absorbe ${children.length} ajuste(s) vigente(s): parte de ${quantity} × ${money(unit)}`
			);
		newItems.push({
			key,
			product_id: item.product_id,
			product_name: item.product_name ?? 'Producto',
			account: item.account,
			item_type: item.item_type,
			unit_of_measure: item.unit_of_measure,
			categoria: 'RENEWAL',
			quantity,
			unit_price: annual ? null : unit,
			annual_unit_price: annual ? round6(unit * 12) : round6(unit * 12),
			price_entry_mode: annual ? 'annual' : 'monthly',
			discount_type: pct > 0 ? 'Porcentaje' : null,
			discount_value: pct,
			price,
			final_price: round2(price * (1 - pct / 100)),
			currency: item.currency ?? ctx.contract.contract_currency,
			billing_frequency: String(ref.billing_frequency ?? item.billing_frequency ?? 'Mensual'),
			billing_method: String(ref.billing_method ?? item.billing_method ?? 'Anticipado'),
			is_recurring: true,
			start_date: start,
			end_date: end,
			term_months: term,
			related_item_id: null,
			renews_item_id: item.id,
			booking_date: p.effective,
			auto_renew: item.auto_renew,
			price_id: item.price_id,
			quote_item_id: null,
		});
		renewed.push({ item_id: item.id, key, absorbed: children.map((child) => child.id) });
	}
	for (const item of newItems) p.insertItem(item);
	for (const entry of renewed) {
		for (const itemId of [entry.item_id, ...entry.absorbed]) {
			p.ops.push({ kind: 'update_item', item_id: itemId, set: { renewed_by_key: entry.key } });
			const after = p.itemsAfter.find((row) => row.id === itemId)!;

			after.renewed_by_item_id = entry.key;
			p.adjusted.push({ ...previewOf(after), renews_item_id: null });
		}
	}
	p.addGeneratedInvoices(newItems, 'cycle');
	p.closeHeaders('Renovación');
	const names = newItems.map((item) => item.product_name);

	return p.finish({
		type: 'RENEWAL',
		subtype: null,
		title: `Renovación de ${newItems.length} ítem(s)`,
		description: `Se renovó ${names.join(', ')} al mismo precio${newItems[0] ? ` desde el ${newItems.map((item) => item.start_date).sort()[0]}` : ''}`,
		amount_delta: 0,
		items_affected: renewed.flatMap((entry) => [entry.item_id, ...entry.absorbed]),
		metadata: {
			renewals: renewed.map((entry) => ({ item_id: entry.item_id, renewed_by: entry.key, absorbed: entry.absorbed })),
			catch_up: req.change.catch_up ?? 'backdate',
		},
	});
}

function assertQuoteOrigin(p: Planner) {
	const origin = p.req.origin;

	if (!origin || origin.type !== 'quote') return;
	const quote = p.ctx.quote;

	if (!quote) {
		p.error('origin.quote_id', 'La cotización no existe en el holding');

		return;
	}
	if (quote.already_applied)
		p.block('quote_already_applied', 'Esta cotización ya se aplicó a un contrato', 'Revisa el historial del contrato o usa origen manual');
	if (/nuevo\s*cliente|new\s*business|new\s*client/i.test(quote.quote_type ?? '')) {
		p.block(
			'new_business_quote_on_existing_contract',
			'La cotización es de tipo "Nuevo cliente": no se asocia a un contrato existente (S3-3)',
			'Crea el contrato desde la cotización o cambia su tipo'
		);
	}
}

export function planItemAdd(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'item_add');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const newItems: NewItemRow[] = [];
	const categories = new Set<string>();
	let mrrDelta = 0;

	p.assertState();
	assertQuoteOrigin(p);
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a agregar');
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const firstLive = liveRecurring(ctx.items).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))[0] ?? ctx.items[0];

	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const productId = String(ref.product_id ?? '');
		const productName = ctx.products.get(productId);

		if (!productName) {
			p.error(`${field}.product_id`, 'El producto no existe en el catálogo del holding');
			continue;
		}
		const isRecurring = ref.is_recurring !== false;
		const start = typeof ref.start_date === 'string' ? ref.start_date : p.effective;

		if (start < p.effective) {
			p.error(`${field}.start_date`, `El ítem no puede partir antes de la fecha efectiva (${p.effective})`);
			continue;
		}
		// Co-terminación (D-B): el fin del contrato que rige es el más próximo de los recurrentes vigentes que siguen después del inicio.
		const contractEnd = nearestContractEnd(ctx.items.filter((item) => !item.end_date || item.end_date >= start));
		let end: string;

		if (isRecurring) {
			if (typeof ref.end_date !== 'string' && !contractEnd) {
				p.error(`${field}.end_date`, 'Indica la fecha de fin: el contrato no tiene ítems recurrentes vigentes de los que heredarla');
				continue;
			}
			end = typeof ref.end_date === 'string' ? ref.end_date : contractEnd!;
			if (contractEnd && end > contractEnd) {
				p.warn(
					'term_exceeds_contract_capped',
					`"${productName}" terminaría el ${end}, después del contrato (${contractEnd}): se acota al fin del contrato (D-B). Para extender, renueva`
				);
				end = contractEnd;
			}
		} else end = typeof ref.end_date === 'string' ? ref.end_date : start;
		if (end < start) {
			p.error(`${field}.end_date`, `El fin (${end}) es anterior al inicio (${start})`);
			continue;
		}
		p.assertOpenPeriod(start, `El inicio de "${productName}"`);
		const account = typeof ref.account === 'string' && ref.account.trim() ? ref.account.trim() : null;
		const sameProduct = ctx.items.filter((item) => item.product_id === productId);
		const related =
			[...sameProduct]
				.filter(
					(item) =>
						!DELTA_CATEGORIES.has(item.categoria ?? '') &&
						!REMOVAL_CATEGORIES.has(item.categoria ?? '') &&
						!item.churn_date &&
						(!account || (item.account ?? '').trim() === account)
				)
				.sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0] ?? null;
		const categoria = sameProduct.length ? 'UPSELL' : 'CROSS-SELL';

		if (categoria === 'UPSELL') {
			p.warn(
				'upsell_of_existing_product',
				`"${productName}" ya existe en el contrato: se agrega como ítem nuevo (UPSELL). Si quieres cambiar cantidad o precio del existente, usa "Cambiar precio o cantidad"`
			);
		}
		const parent = related ?? firstLive;
		const term = monthsCeil(start, end);
		const annual = ref.price_entry_mode === 'annual';
		const quantity = num(ref.quantity);
		const billingFrequency = String(ref.billing_frequency ?? parent?.billing_frequency ?? 'Mensual');
		const billingMethod = String(ref.billing_method ?? parent?.billing_method ?? 'Anticipado');
		// Pricing v2: precio inline validado como al crear (tramos, métrica, mínimo/tope; medido + Anticipado salvo seat), o
		// precio de catálogo (etapa 3: activo, mismo producto y moneda; el ítem recibe una copia con `list_price_id`).
		const priceDto = (ref.price ?? null) as PriceSpecDto | null;
		const catalogId = typeof ref.price_id === 'string' && ref.price_id ? ref.price_id : null;
		const catalog = catalogId ? ctx.catalog_prices?.get(catalogId) : undefined;
		let priceSpec = priceDto && hasPricingModel({ price: priceDto }) ? normalizePriceSpec(priceDto as PriceSpec) : null;
		let priceInvalid = false;

		if (catalogId) {
			const catalogErrors = catalogPriceErrors({
				field,
				catalog,
				inline: Boolean(priceSpec),
				product_id: productId,
				contract_currency: ctx.contract.contract_currency,
			});

			for (const error of catalogErrors) p.error(error.field, error.message);
			if (catalogErrors.length) continue;
			priceSpec = normalizePriceSpec(catalog!.spec);
			if (isMetered(priceSpec) && billingMethod === 'Anticipado' && priceSpec.model !== 'seat') {
				p.error(`${field}.billing_method`, METERED_ADVANCE_MESSAGE);
				continue;
			}
		} else if (priceDto) {
			for (const error of validatePriceSpec(priceDto as PriceSpec)) {
				p.error(`${field}.price.${error.field}`, error.message);
				priceInvalid = true;
			}
			if (isMetered(priceDto as PriceSpec)) {
				const metricId = priceDto.billable_metric_id ?? null;
				const status = metricId ? ctx.billable_metrics?.get(metricId) : undefined;

				if (metricId && !status) {
					p.error(`${field}.price.billable_metric_id`, 'La métrica facturable no existe en el holding');
					priceInvalid = true;
				} else if (status && status !== 'active') {
					p.error(`${field}.price.billable_metric_id`, 'La métrica facturable está archivada');
					priceInvalid = true;
				}
				if (billingMethod === 'Anticipado' && priceDto.model !== 'seat') {
					p.error(`${field}.billing_method`, METERED_ADVANCE_MESSAGE);
					priceInvalid = true;
				}
			}
		}
		if (!priceSpec && (ref.unit_price === undefined || ref.unit_price === null)) {
			p.error(`${field}.unit_price`, 'Escribe el precio unitario');
			continue;
		}
		if (priceInvalid) continue;
		const unitInput = num(ref.unit_price);
		// Con modelo de precio, el unitario mensual es el equivalente a la cantidad base sin descuento (MRR/RSM/columnas de hoy).
		const unit = priceSpec
			? ContractDraftsService.equivalentMonthlyUnit(priceSpec, {
					quantity,
					billing_frequency: billingFrequency as BillingFrequency,
					is_recurring: isRecurring,
					term_months: term,
				})
			: annual
				? round6(unitInput / 12)
				: unitInput;
		const pct = Math.min(100, Math.max(0, num(ref.discount_value)));
		// Valor del ítem = lo que suman sus cuotas: tramo inicial por días + períodos completos (Σ facturas = TV, manual #8). El
		// mensual (MRR) lo deriva el trigger de `unit × qty`; `term_months` queda como entero de meses cubiertos.
		const months = isRecurring ? monthsBetween(start, end, anchor) : term;
		const price = round2(unit * quantity * months);
		const duplicate = ctx.items.find(
			(item) =>
				item.product_id === productId &&
				(item.account ?? '').trim() === (account ?? '') &&
				item.start_date === start &&
				!REMOVAL_CATEGORIES.has(item.categoria ?? '')
		);

		if (duplicate)
			p.warn(
				'possible_duplicate',
				`Ya hay un ítem "${productName}"${account ? ` cuenta ${account}` : ''} que parte el ${start}: revisa que no sea un duplicado`
			);
		categories.add(categoria);
		mrrDelta += isRecurring ? round2(unit * quantity * (1 - pct / 100)) : 0;
		newItems.push({
			key: p.newKey(),
			product_id: productId,
			product_name: productName,
			account,
			item_type: typeof ref.item_type === 'string' && ref.item_type ? ref.item_type : (parent?.item_type ?? null),
			unit_of_measure: typeof ref.unit_of_measure === 'string' && ref.unit_of_measure ? ref.unit_of_measure : (parent?.unit_of_measure ?? null),
			categoria,
			quantity,
			unit_price: annual && !priceSpec ? null : unit,
			annual_unit_price: annual && !priceSpec ? unitInput : round6(unit * 12),
			price_entry_mode: annual && !priceSpec ? 'annual' : 'monthly',
			discount_type: pct > 0 ? 'Porcentaje' : null,
			discount_value: pct,
			price,
			final_price: round2(price * (1 - pct / 100)),
			currency: ctx.contract.contract_currency,
			billing_frequency: billingFrequency,
			billing_method: billingMethod,
			is_recurring: isRecurring,
			start_date: start,
			end_date: end,
			term_months: term,
			related_item_id: related?.id ?? null,
			renews_item_id: null,
			booking_date: p.effective,
			auto_renew: false,
			price_id: null,
			quote_item_id: null,
			price_spec: priceSpec,
			list_price_id: catalog?.id ?? null,
			price_name: catalog?.name ?? null,
		});
	}
	for (const item of newItems) p.insertItem(item);
	p.addGeneratedInvoices(newItems, req.change.first_period_invoice ?? 'cycle');
	p.closeHeaders('Alta de ítem');
	p.mrrDelta = round2(mrrDelta);
	const type = categories.size === 1 && categories.has('CROSS-SELL') ? 'CROSS_SELL' : 'UPSELL';

	return p.finish({
		type,
		subtype: categories.size > 1 ? 'mixed' : null,
		title: type === 'CROSS_SELL' ? 'Producto nuevo (cross-sell)' : 'Alta de ítem (upsell)',
		description: `Se agregó ${newItems.map((item) => `${item.product_name} ${item.quantity} × ${money(item.unit_price ?? num(item.annual_unit_price) / 12)}`).join(', ')} desde el ${p.effective}: MRR +${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: [],
		metadata: { first_period_invoice: req.change.first_period_invoice ?? 'cycle' },
	});
}

export function planItemChange(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'item_change');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const groups = buildItemGroups(ctx.items, p.effective);
	const newItems: NewItemRow[] = [];
	const categories = new Set<string>();
	const subtypes = new Set<string>();
	let mrrDelta = 0;

	p.assertState();
	assertQuoteOrigin(p);
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a cambiar');
	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const item = p.findItem(String(ref.item_id ?? ''), `${field}.item_id`);

		if (!item) continue;
		if (ref.billing_frequency !== undefined && ref.billing_frequency !== null) {
			p.error(`${field}.billing_frequency`, 'Cambiar la frecuencia es una renegociación de término (ABIERTO S3-15): usa "renewal"');
		}
		if (ref.end_date !== undefined && ref.end_date !== null) {
			p.error(
				`${field}.end_date`,
				'Cambiar el fin del ítem es renovar (extender) o dar de baja (acortar, item_remove): no es un cambio de precio o cantidad'
			);
		}
		if (item.is_recurring === false || !item.start_date) {
			p.error(`${field}.item_id`, `"${item.product_name}" no es recurrente o no tiene inicio: edítalo como corrección`);
			continue;
		}
		if (!p.assertRemovable(item)) continue;
		const group = groups.find((row) => row.item_ids.includes(item.id));

		if (!group) {
			p.error(`${field}.item_id`, `"${item.product_name}" no está vigente a la fecha efectiva (${p.effective})`);
			continue;
		}
		const annual = ref.price_entry_mode === 'annual';
		const unitNew = annual ? round6(num(ref.unit_price) / 12) : num(ref.unit_price);
		const pct =
			ref.discount_value !== undefined && ref.discount_value !== null
				? num(ref.discount_value)
				: item.discount_type === 'Porcentaje'
					? num(item.discount_value)
					: 0;
		const delta = unifiedDelta({
			current_quantity: group.quantity ?? num(item.quantity),
			current_mrr: group.mrr,
			new_quantity: num(ref.quantity),
			new_unit_price: unitNew,
			discount_pct: pct,
		});

		if (!delta) {
			p.error(
				`${field}.quantity`,
				`"${item.product_name}" no cambia el mensual (${money(group.mrr)}): si solo cambia el detalle, edítalo como corrección`
			);
			continue;
		}
		if (delta.monthly_new <= 0) {
			p.error(`${field}.quantity`, 'El mensual nuevo debe ser mayor que 0; para quitar el producto usa item_remove (S3-7)');
			continue;
		}
		// Downsell rige desde el próximo inicio de período sin prorrateo (S3-5/S3-6); upsell parte el día efectivo y prorratea el primer tramo.
		let start = p.effective;

		if (delta.categoria === 'DOWNSELL') {
			const next = nextPeriodStart(engineShape(item), anchor, p.effective) ?? p.effective;

			if (next !== p.effective)
				p.warn(
					'downsell_from_next_period',
					`La rebaja de "${item.product_name}" rige desde el próximo inicio de período (${next}), sin prorrateo`
				);
			start = next;
		}
		if (!item.end_date || start > item.end_date) {
			p.error(`${field}.item_id`, `"${item.product_name}" termina el ${item.end_date}: no queda período por cambiar; renuévalo primero`);
			continue;
		}
		p.assertOpenPeriod(start, `El inicio del cambio de "${item.product_name}"`);
		const groupIds = new Set(group.item_ids);
		const frontier = ctx.invoices
			.filter(isIssued)
			.flatMap((invoice) => invoice.lines)
			.filter((line) => line.contract_item_id && groupIds.has(line.contract_item_id))
			.map((line) => line.billing_period_end ?? '')
			.sort()
			.reverse()[0];

		if (frontier && start <= frontier) {
			p.block(
				'issued_after_effective_date',
				`"${item.product_name}" ya está facturado en firme hasta el ${frontier}`,
				`Usa fecha efectiva ${addDays(frontier, 1)} o posterior; lo emitido se corrige con nota de crédito`
			);
		}
		if (ctx.quantity_override_item_ids.some((id) => groupIds.has(id))) {
			p.warn(
				'quantity_overrides_present',
				`"${item.product_name}" tiene cantidades variables registradas: los períodos con consumo conservan su cantidad (S7-7)`
			);
		}
		p.assertNoUnified(groupIds, start);
		const term = monthsCeil(start, item.end_date);
		// UPSELL: el trigger deriva el mensual de `unit × qty`, así que el valor puede ser el real por días (Σ facturas = TV).
		// DOWNSELL: el trigger deriva el mensual de `final / term`, así que el valor es ΔMRR × término (rige desde un inicio de período).
		const coveredMonths = delta.categoria === 'UPSELL' ? monthsBetween(start, item.end_date, anchor) : term;
		const unitCurrent = num(item.unit_price ?? num(item.annual_unit_price) / 12);
		const bothAxes = delta.quantity_delta !== 0 && Math.abs(unitNew - unitCurrent) > 1e-6;
		const duplicate = ctx.items.find((row) => row.related_item_id === item.id && row.categoria === delta.categoria && row.start_date === start);

		if (duplicate)
			p.warn(
				'possible_duplicate',
				`Ya existe un ${delta.categoria} de "${item.product_name}" que parte el ${start}: revisa que no sea un duplicado`
			);
		categories.add(delta.categoria);
		subtypes.add(bothAxes ? 'RENEGOTIATION' : delta.quantity_delta !== 0 ? 'quantity' : 'price');
		mrrDelta += delta.mrr_delta;
		const newItem: NewItemRow = {
			key: p.newKey(),
			product_id: item.product_id,
			product_name: item.product_name ?? 'Producto',
			account: item.account,
			item_type: item.item_type,
			unit_of_measure: item.unit_of_measure,
			categoria: delta.categoria,
			quantity: delta.quantity,
			unit_price: delta.unit_price,
			annual_unit_price: round6(delta.unit_price * 12),
			price_entry_mode: 'monthly',
			discount_type: null,
			discount_value: 0,
			price: round2(delta.mrr_delta * coveredMonths),
			final_price: round2(delta.mrr_delta * coveredMonths),
			currency: item.currency ?? ctx.contract.contract_currency,
			billing_frequency: item.billing_frequency ?? 'Mensual',
			billing_method: item.billing_method ?? 'Anticipado',
			is_recurring: true,
			start_date: start,
			end_date: item.end_date,
			term_months: term,
			related_item_id: item.id,
			renews_item_id: null,
			booking_date: p.effective,
			auto_renew: false,
			price_id: null,
			quote_item_id: null,
		};

		p.insertItem(newItem);
		// Facturas: línea neta (obligatoria en downsell, opcional en upsell, S3-14) o línea propia del delta (upsell). Con consumo registrado
		// en alguna Por Emitir del ítem la línea es neta: la cantidad consumida se conserva y se tarifa al precio nuevo (nunca la base).
		const inScope = (line: ChangeInvoiceLineRow) =>
			Boolean(line.contract_item_id && groupIds.has(line.contract_item_id) && (line.billing_period_start ?? '') >= start);
		const withConsumption = ctx.invoices
			.filter(isEditablePending)
			.some((invoice) => !isPartialBilled(invoice) && invoice.lines.some((line) => inScope(line) && isConsumptionLine(line)));
		const netLine = delta.categoria === 'DOWNSELL' || ref.net_line === true || withConsumption;

		if (withConsumption && delta.categoria !== 'DOWNSELL' && ref.net_line !== true)
			p.warn(
				'consumption_net_line',
				`"${item.product_name}" tiene consumo registrado en facturas por emitir: el cambio se aplica como línea neta al precio nuevo`
			);
		if (netLine) {
			for (const invoice of ctx.invoices.filter(isEditablePending)) {
				const groupLines = invoice.lines.filter(inScope);

				if (!groupLines.length || p.skipPartial(invoice)) continue;
				const baseLine = groupLines.find((line) => line.contract_item_id === item.id);

				for (const line of groupLines) {
					if (line === baseLine) continue;
					// Una línea con consumo registrado no se quita (su `consumption_entries.invoice_id` la apunta).
					if (isConsumptionLine(line)) continue;
					p.deleteLine(invoice, line);
				}
				if (baseLine && isConsumptionLine(baseLine)) {
					const months = monthsBetween(baseLine.billing_period_start!, baseLine.billing_period_end!, anchor);
					const priced = repriceConsumptionLine(baseLine, item, pct, round6(unitNew * months));
					const tax = round2((priced.subtotal * invoice.tax_rate) / 100);

					p.warn(
						'consumption_quantity_kept',
						`La factura ${invoice.invoice_number ?? invoice.issue_date ?? invoice.id} conserva el consumo registrado de "${item.product_name}" (${priced.quantity}) y se recalcula al precio nuevo`
					);
					p.updateLine(
						invoice,
						baseLine,
						{
							quantity: priced.quantity,
							unit_price: priced.effective_unit_price,
							discount_pct: round6(pct),
							subtotal: priced.subtotal,
							tax_amount: tax,
							total: round2(priced.subtotal + tax),
							pricing_breakdown: priced.breakdown,
							quantity_source: priced.quantity_source,
						},
						'consumo registrado al valor nuevo'
					);
				} else if (baseLine) {
					const months = monthsBetween(baseLine.billing_period_start!, baseLine.billing_period_end!, anchor);
					const subtotal = round2(delta.monthly_new * months);
					const tax = round2((subtotal * invoice.tax_rate) / 100);

					p.updateLine(
						invoice,
						baseLine,
						{
							quantity: num(ref.quantity),
							unit_price: round6(unitNew * months),
							discount_pct: round6(pct),
							subtotal,
							tax_amount: tax,
							total: round2(subtotal + tax),
						},
						'línea neta al valor nuevo'
					);
				}
			}
		} else newItems.push(newItem);
	}
	p.addGeneratedInvoices(newItems, req.change.first_period_invoice ?? 'cycle');
	p.closeHeaders('Cambio de precio o cantidad');
	p.mrrDelta = round2(mrrDelta);
	const type = categories.size === 1 && categories.has('DOWNSELL') ? 'DOWNSELL' : 'UPSELL';
	const subtype = subtypes.has('RENEGOTIATION') ? 'RENEGOTIATION' : ([...subtypes][0] ?? null);

	return p.finish({
		type,
		subtype,
		title: type === 'DOWNSELL' ? 'Reducción de precio o cantidad (downsell)' : 'Aumento de precio o cantidad (upsell)',
		description: `Se ${type === 'DOWNSELL' ? 'redujo' : 'aumentó'} ${refs
			.map((ref) => ctx.items.find((item) => item.id === ref.item_id)?.product_name)
			.filter(Boolean)
			.join(', ')}: MRR ${mrrDelta >= 0 ? '+' : ''}${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: refs.map((ref) => String(ref.item_id ?? '')).filter(Boolean),
		metadata: { first_period_invoice: req.change.first_period_invoice ?? 'cycle' },
	});
}

/** IVA de las Por Emitir según la familia del documento (exportación 0; Colombia 0; si no, la tasa de la compañía). */
export const taxRateFor = (documentType: string, contract: ChangeContractRow): number => {
	if (documentType === 'FACTURA_EXPORTACION') return 0;
	if (normalizeCountry(contract.company.country) === 'CO') return 0;

	return normalizeTaxRate(contract.company.tax_rate) ?? 0;
};

export function planBillingConditions(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'billing_conditions');
	const change = req.change;
	const contract = ctx.contract;
	const before: Record<string, unknown> = {};
	const after: Record<string, unknown> = {};
	const pending = ctx.invoices.filter(isEditablePending).filter((invoice) => (invoice.issue_date ?? '') >= p.effective);
	const pendingIds = pending.map((invoice) => invoice.id);
	const pendingCount = pending.length;
	const has = (key: keyof ContractChangeDto) => change[key] !== undefined;
	const track = (key: string, valueBefore: unknown, valueAfter: unknown) => {
		before[key] = valueBefore;
		after[key] = valueAfter;
		p.contractSet[key] = valueAfter;
	};

	p.assertState();

	// Condición de pago: solo las facturas nuevas recalculan el vencimiento (S4-10); el preview dice cuántas conservan la anterior.
	if (has('payment_terms')) {
		const terms = change.payment_terms === null ? null : cleanPaymentTerms(change.payment_terms);

		if (change.payment_terms !== null && !terms) p.error('change.payment_terms', 'Condición de pago inválida');
		else if (JSON.stringify(terms) !== JSON.stringify(cleanPaymentTerms(contract.payment_terms))) {
			track('payment_terms', cleanPaymentTerms(contract.payment_terms), terms);
			if (pendingCount)
				p.warn(
					'pending_invoices_keep_old_terms',
					`${pendingCount} factura(s) por emitir conservan el vencimiento calculado con la condición anterior (S4-10)`
				);
		}
	}
	if (has('invoice_terms_and_conditions')) {
		const text =
			change.invoice_terms_and_conditions === null || change.invoice_terms_and_conditions?.trim() === ''
				? null
				: change.invoice_terms_and_conditions!;

		if (text !== contract.invoice_terms_and_conditions) {
			track('invoice_terms_and_conditions', contract.invoice_terms_and_conditions, text);
			// Con `apply_to_pending` el servicio informa `pending_invoices_updated` / `pending_invoices_skipped` (necesita leer las facturas).
			if (pendingCount && change.apply_to_pending !== true)
				p.warn(
					'pending_invoices_keep_old_terms',
					`${pendingCount} factura(s) por emitir conservan su texto de condiciones (se copia al crearlas)`
				);
		}
	}
	if (change.apply_to_pending === true && !('invoice_terms_and_conditions' in after))
		p.error('apply_to_pending', 'apply_to_pending requiere un cambio en las condiciones de factura (invoice_terms_and_conditions)');
	// Tipo de documento: del catálogo (deriva la familia) o la familia directa si el holding no tiene catálogo.
	let familyAfter: string | null = null;

	if (has('tax_document_type_id')) {
		if (!ctx.tax_document_type)
			p.error('change.tax_document_type_id', 'El documento tributario no existe o no corresponde al país de la compañía emisora');
		else if (ctx.tax_document_type.id !== contract.tax_document_type_id) {
			track('tax_document_type_id', contract.tax_document_type_id, ctx.tax_document_type.id);
			familyAfter = ctx.tax_document_type.kind === 'export_invoice' ? 'FACTURA_EXPORTACION' : 'FACTURA';
		}
	} else if (has('document_type') && change.document_type !== contract.document_type) {
		if (contract.tax_document_type_id) p.error('change.document_type', 'El contrato usa el catálogo de documentos: indica tax_document_type_id');
		else familyAfter = change.document_type!;
	}
	const familyBefore = contract.document_type ?? suggestDocumentType(contract.company.country, contract.entity.country);

	if (familyAfter && familyAfter !== familyBefore) {
		track('document_type', contract.document_type, familyAfter);
		const taxRate = taxRateFor(familyAfter, contract);

		if (pendingIds.length) {
			p.ops.push({
				kind: 'update_invoices_document',
				invoice_ids: pendingIds,
				document_type: familyAfter,
				export_type: familyAfter === 'FACTURA_EXPORTACION' ? 1 : 0,
				tax_rate: taxRate,
			});
			for (const invoice of pending) {
				p.updatedInvoices.push({
					id: invoice.id,
					invoice_number: invoice.invoice_number,
					issue_date: invoice.issue_date,
					lines_changed: invoice.lines.length,
					subtotal_before: invoice.subtotal,
					subtotal_after: invoice.subtotal,
					change: `documento ${familyAfter}, IVA ${taxRate} %`,
				});
			}
		}
	} else if (familyAfter && has('tax_document_type_id')) after.document_type = familyAfter;

	// Envío al ERP y emisión automática (S6-10) y referencias: contrato + Por Emitir desde la fecha efectiva.
	const sendAfter = has('auto_send_to_odoo') ? change.auto_send_to_odoo! : contract.auto_send_to_odoo;
	const invoiceAfter = has('auto_invoice') ? change.auto_invoice! : contract.auto_invoice;

	if (invoiceAfter && !sendAfter) p.error('change.auto_invoice', 'La emisión automática requiere el envío automático al ERP (S6-10)');
	if (has('auto_send_to_odoo') && sendAfter !== contract.auto_send_to_odoo) track('auto_send_to_odoo', contract.auto_send_to_odoo, sendAfter);
	const invoiceFields: Record<string, unknown> = {};

	if (has('auto_invoice') && invoiceAfter !== contract.auto_invoice) {
		track('auto_invoice', contract.auto_invoice, invoiceAfter);
		invoiceFields.auto_invoice = invoiceAfter;
	}
	if (has('requires_references_for_billing') && change.requires_references_for_billing !== contract.requires_references_for_billing) {
		track('requires_references_for_billing', contract.requires_references_for_billing, change.requires_references_for_billing);
		invoiceFields.requires_references_for_billing = change.requires_references_for_billing;
	}
	if (Object.keys(invoiceFields).length && pendingIds.length) {
		p.ops.push({ kind: 'update_invoices_fields', invoice_ids: pendingIds, set: invoiceFields });
		for (const invoice of pending) {
			p.updatedInvoices.push({
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				lines_changed: 0,
				subtotal_before: invoice.subtotal,
				subtotal_after: invoice.subtotal,
				change: Object.keys(invoiceFields)
					.map((key) => (key === 'auto_invoice' ? 'emisión automática' : 'referencias obligatorias'))
					.join(' · '),
			});
		}
	}
	if (has('group_invoices_by_period') && change.group_invoices_by_period !== contract.group_invoices_by_period) {
		track('group_invoices_by_period', contract.group_invoices_by_period, change.group_invoices_by_period);
		if (pendingCount)
			p.warn(
				'pending_invoices_keep_grouping',
				`${pendingCount} factura(s) por emitir conservan su agrupación; la nueva rige para lo que se genere después`
			);
	}
	// Moneda y política de tipo de cambio de facturación (S6-1/S6-2): solo las Por Emitir desde la fecha efectiva.
	const contractCurrency = upper(contract.contract_currency);
	const currencyBefore = upper(contract.invoice_currency) || contractCurrency;
	const currencyAfter = has('invoice_currency') ? upper(change.invoice_currency) : currencyBefore;
	const policyBefore = contract.fx_invoice_policy ?? 'spot';
	const policyAfter = has('fx_invoice_policy') ? change.fx_invoice_policy! : currencyAfter === contractCurrency ? 'spot' : policyBefore;
	const newRates = (change.fx_invoice_rates ?? []).map((rate) => ({
		from_currency: contractCurrency,
		to_currency: currencyAfter,
		rate: Number(rate.rate),
		period_start: rate.period_start ?? p.effective,
		period_end: rate.period_end ?? '9999-12-31',
	}));

	if (currencyAfter === UF_CURRENCY) p.block('uf_invoice_currency', 'La UF no se factura: elige la moneda en que se emite (por ejemplo, CLP)');
	if (currencyAfter !== contractCurrency && policyAfter === 'fixed' && !contract.fx_invoice_rates.length && !newRates.length) {
		p.error('change.fx_invoice_rates', 'Con tipo de cambio fijo indica al menos una tasa contrato → moneda de factura');
	}
	if (currencyAfter !== currencyBefore || policyAfter !== policyBefore || newRates.length) {
		if (currencyAfter !== currencyBefore) track('invoice_currency', currencyBefore, currencyAfter);
		if (policyAfter !== policyBefore) {
			track('fx_invoice_policy', policyBefore, policyAfter);
			p.contractSet.fx_invoice_confirmed_at = new Date().toISOString();
		}
		if (newRates.length) {
			p.ops.push({ kind: 'insert_fx_rates', rates: newRates });
			after.fx_invoice_rates_added = newRates.length;
		}
		const allRates: FxPeriodRate[] = [...contract.fx_invoice_rates, ...newRates.map((rate) => ({ ...rate, created_at: '9999' }))];
		const targets: Array<{ invoice_id: string; fx: number | null }> = [];
		const keptFx: ChangeInvoiceRow[] = [];

		for (const invoice of pending) {
			// Facturada por OC (fija) o con tasa fijada por factura (manual / neto exacto): conserva su moneda y tasa.
			if (p.skipPartial(invoice)) continue;
			if (hasPerInvoiceFx(invoice)) {
				keptFx.push(invoice);
				continue;
			}
			const periodStart = invoice.lines.map((line) => line.billing_period_start ?? '').sort()[0] || invoice.issue_date || p.effective;
			let fx: number | null = currencyAfter === contractCurrency ? 1 : null;

			if (currencyAfter !== contractCurrency && policyAfter === 'fixed') {
				fx = findFixedRate(allRates, contractCurrency, currencyAfter, periodStart);
				if (fx === null) {
					p.block(
						'fixed_fx_without_rate',
						`La factura del ${invoice.issue_date} no tiene tasa ${contractCurrency} → ${currencyAfter} para su período (desde el ${periodStart})`,
						'Agrega la tasa del período en fx_invoice_rates o usa tipo de cambio del día'
					);
				}
			}
			targets.push({ invoice_id: invoice.id, fx });
			p.updatedInvoices.push({
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				lines_changed: invoice.lines.length,
				subtotal_before: invoice.subtotal,
				subtotal_after: invoice.subtotal,
				change: `moneda ${currencyAfter}${fx === 1 ? '' : fx !== null ? `, tipo de cambio fijo ${fx}` : ', se valoriza al emitir'}`,
			});
		}
		if (targets.length) p.ops.push({ kind: 'update_invoices_fx', targets, invoice_currency: currencyAfter });
		if (keptFx.length)
			p.warn(
				'invoice_fx_kept',
				`${keptFx.map((invoice) => invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`).join(', ')}: ${
					keptFx.length === 1 ? 'tiene' : 'tienen'
				} un tipo de cambio fijado por factura y ${keptFx.length === 1 ? 'conserva' : 'conservan'} su moneda y tasa (cámbialo desde la factura)`
			);
	}
	if (!p.errors.length && !Object.keys(p.contractSet).length && !newRates.length) {
		p.error('change', 'Indica qué condición cambiar: no hay diferencias con las condiciones actuales');
	}
	const changed = Object.keys(before);

	return p.finish({
		type: 'CONDITIONS_UPDATED',
		subtype: null,
		title: 'Condiciones de facturación actualizadas',
		description:
			`Se actualizaron ${changed.length ? changed.join(', ') : 'las tasas de tipo de cambio'} de ${contract.contract_number ?? ''} desde el ${p.effective}`.replace(
				/\s+/g,
				' '
			),
		amount_delta: 0,
		items_affected: [],
		metadata: { changed_fields: changed, fields_before: before, fields_after: after, pending_invoices_updated: p.updatedInvoices.length },
	});
}

export function planChangeEntity(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'change_entity');
	const change = req.change;
	const contract = ctx.contract;
	const entity = ctx.new_entity;

	p.assertState();
	if (change.client_id)
		p.error(
			'change.client_id',
			'Cambiar el cliente comercial de un contrato activo está por decidir (spec §2.10 a): solo se cambia la razón social dentro del mismo cliente'
		);
	if (!change.client_entity_id) p.error('change.client_entity_id', 'Indica la razón social nueva');
	else if (!entity) p.error('change.client_entity_id', 'La razón social no existe en el holding');
	else if (!entity.belongs_to_client) p.error('change.client_entity_id', 'La razón social no pertenece al cliente comercial del contrato');
	else if (entity.id === contract.client_entity_id) p.error('change.client_entity_id', 'El contrato ya tiene esa razón social');
	// `trg_period_guard_contracts` bloquea el cambio de razón social si algún ítem tiene inicio en período cerrado.
	const cutoff = contract.cutoff_date;

	if (cutoff && ctx.items.some((item) => item.start_date && item.start_date <= cutoff)) {
		p.block(
			'period_closed',
			`El contrato tiene ítems que parten en un período cerrado (cierre al ${cutoff}): la razón social no se puede cambiar`,
			REOPEN_PERIOD_STEP
		);
	}
	if (!entity || p.errors.length)
		return p.finish({
			type: 'ENTITY_CHANGED',
			subtype: null,
			title: 'Cambio de razón social',
			description: '',
			amount_delta: 0,
			items_affected: [],
		});

	p.contractSet = { client_entity_id: entity.id, legal_client_name: entity.legal_name };
	// Las facturadas por OC quedan fijas (se avisan con `partial_billing_skipped`).
	const pending = (
		change.apply_to_pending_invoices === false
			? []
			: ctx.invoices.filter(isEditablePending).filter((invoice) => (invoice.issue_date ?? '') >= p.effective)
	).filter((invoice) => !p.skipPartial(invoice));
	// Tipo de documento: sin catálogo, se re-deriva por país emisor vs receptor (S1-7); con catálogo, se avisa si el país cambia.
	const familyBefore = contract.document_type ?? suggestDocumentType(contract.company.country, contract.entity.country);
	const familyAfter = suggestDocumentType(contract.company.country, entity.country);
	const documentChanges = familyAfter !== familyBefore && !contract.tax_document_type_id;
	const retaxed = new Set<string>();

	if (pending.length && documentChanges) {
		p.ops.push({
			kind: 'update_invoices_fields',
			invoice_ids: pending.map((invoice) => invoice.id),
			set: { client_entity_id: entity.id, client_tax_id: entity.tax_id },
		});
	} else if (pending.length) {
		// IVA de cada Por Emitir re-derivado de su documento como en el editor (`taxRateForDocument`) y guardado normalizado (0,19 → 19).
		const byRate = new Map<number, ChangeInvoiceRow[]>();
		const byDocument = new Map<string, { document_type: string; tax_rate: number; invoices: ChangeInvoiceRow[] }>();

		for (const invoice of pending) {
			const documentType = invoice.document_type ?? familyBefore;
			const rate = taxRateFor(documentType, contract);

			byRate.set(rate, [...(byRate.get(rate) ?? []), invoice]);
			if (rate !== invoice.tax_rate) {
				const key = `${documentType}|${rate}`;
				const group = byDocument.get(key) ?? { document_type: documentType, tax_rate: rate, invoices: [] };

				group.invoices.push(invoice);
				byDocument.set(key, group);
				retaxed.add(invoice.id);
			}
		}
		for (const [rate, invoices] of byRate)
			p.ops.push({
				kind: 'update_invoices_fields',
				invoice_ids: invoices.map((invoice) => invoice.id),
				set: { client_entity_id: entity.id, client_tax_id: entity.tax_id, tax_rate: rate },
			});
		for (const group of byDocument.values())
			p.ops.push({
				kind: 'update_invoices_document',
				invoice_ids: group.invoices.map((invoice) => invoice.id),
				document_type: group.document_type,
				export_type: group.document_type === 'FACTURA_EXPORTACION' ? 1 : 0,
				tax_rate: group.tax_rate,
			});
		if (retaxed.size)
			p.warn(
				'tax_rate_rederived',
				`${retaxed.size} factura(s) por emitir recalculan su IVA según su documento (${[...byDocument.values()]
					.map((group) => `${group.document_type} ${group.tax_rate} %`)
					.join(', ')})`
			);
	}
	let docChange = '';

	if (familyAfter !== familyBefore) {
		if (contract.tax_document_type_id) {
			p.warn(
				'document_type_review',
				`La razón social nueva es de ${entity.country ?? 'otro país'}: revisa el documento tributario del contrato (hoy del catálogo)`
			);
		} else {
			p.contractSet.document_type = familyAfter;
			const taxRate = taxRateFor(familyAfter, contract);

			docChange = `, documento ${familyAfter}, IVA ${taxRate} %`;
			if (pending.length)
				p.ops.push({
					kind: 'update_invoices_document',
					invoice_ids: pending.map((invoice) => invoice.id),
					document_type: familyAfter,
					export_type: familyAfter === 'FACTURA_EXPORTACION' ? 1 : 0,
					tax_rate: taxRate,
				});
			p.warn('document_type_changed', `El tipo de documento pasa de ${familyBefore} a ${familyAfter} por el país de la razón social nueva`);
		}
	}
	for (const invoice of pending) {
		p.updatedInvoices.push({
			id: invoice.id,
			invoice_number: invoice.invoice_number,
			issue_date: invoice.issue_date,
			lines_changed: docChange || retaxed.has(invoice.id) ? invoice.lines.length : 0,
			subtotal_before: invoice.subtotal,
			subtotal_after: invoice.subtotal,
			change: `receptor ${entity.legal_name ?? entity.id}${docChange}${retaxed.has(invoice.id) ? `, IVA ${taxRateFor(invoice.document_type ?? familyBefore, contract)} %` : ''}`,
		});
	}

	return p.finish({
		type: 'ENTITY_CHANGED',
		subtype: null,
		title: 'Cambio de razón social',
		description: `La razón social receptora pasa de ${contract.entity.legal_name ?? contract.client_entity_id ?? '—'} a ${entity.legal_name ?? entity.id} desde el ${p.effective}; ${pending.length} factura(s) por emitir reasignadas`,
		amount_delta: 0,
		items_affected: [],
		metadata: {
			entity_before: { id: contract.client_entity_id, legal_name: contract.entity.legal_name, tax_id: contract.entity.tax_id },
			entity_after: { id: entity.id, legal_name: entity.legal_name, tax_id: entity.tax_id },
			pending_invoices_updated: pending.length,
			// Antes de cada Por Emitir reasignada (para revertir o auditar): receptor y su identificador tributario.
			invoices_before: pending.map((invoice) => ({
				id: invoice.id,
				client_entity_id: invoice.client_entity_id,
				client_tax_id: invoice.client_tax_id ?? null,
			})),
		},
	});
}

// ------------------------------------------------------------------ entrada única

/** Validaciones de forma previas al contexto (400): tipo construido, fecha, cotización, lista de ítems según tipo. */
export function validateChangeRequest(req: ContractChangeRequestDto): void {
	const errors: FieldError[] = [];
	const deferred = deferredMessage(req.change?.type ?? '');

	if (deferred) errors.push({ field: 'change.type', message: deferred });
	else if (!(CHANGE_TYPES as readonly string[]).includes(req.change?.type ?? ''))
		errors.push({ field: 'change.type', message: 'Tipo de cambio inválido' });
	if (req.change?.apply_to_pending === true && req.change.type !== 'billing_conditions')
		errors.push({ field: 'apply_to_pending', message: 'apply_to_pending solo aplica a billing_conditions con cambio de condiciones de factura' });
	if (req.origin?.type === 'quote' && !req.origin.quote_id) errors.push({ field: 'origin.quote_id', message: 'Indica la cotización de origen' });
	const withItems: string[] = ['item_remove', 'renewal', 'item_add', 'item_change'];

	if (withItems.includes(req.change?.type ?? '') && (!Array.isArray(req.change.items) || !req.change.items.length)) {
		errors.push({ field: 'change.items', message: 'Indica al menos un ítem' });
	}
	if (errors.length) throw validationException(errors);
}

/** Mismo cálculo para preview y aplicar. Lanza 400 (`errors[{ field, message }]`) si el pedido está mal formado. */
export function planChange(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	validateChangeRequest(req);
	switch (req.change.type as ChangeType) {
		case 'billing_conditions':
			return planBillingConditions(ctx, req);
		case 'change_entity':
			return planChangeEntity(ctx, req);
		case 'item_remove':
			return planRemove(ctx, req);
		case 'contract_cancel':
			return planCancel(ctx, req);
		case 'renewal':
			return planRenewal(ctx, req);
		case 'item_add':
			return planItemAdd(ctx, req);
		case 'item_change':
			return planItemChange(ctx, req);
	}
}

/** Estado del ítem hoy, para la respuesta (mismo criterio que el 360). */
export const itemStatusToday = (item: ChangeItemRow, today: string) => deriveItemStatus(item, today);
