/**
 * Reglas **puras** de las modificaciones de contrato v2 (`docs/v2-rediseno/spec-modificaciones-contrato-v2.md` §1, §2 y §4).
 * Sin base de datos: reciben el contexto ya leído (`ChangeContext`) y el pedido, y devuelven el `ChangePlan`: el preview
 * exacto de §4 más la lista ordenada de escrituras (`ops`) que `ContractChangesService` ejecuta en una transacción.
 * El preview y la aplicación usan **el mismo cálculo** (mapa §1.2).
 *
 * Construido: `billing_conditions`, `change_entity` (fase A; razón social nueva §9.3.10), `item_remove`, `contract_cancel` (fase B;
 * decisión por factura §9.3.1), `renewal` (fase C; precio nuevo, pactos `on_renewal` y extensión de FX §9.3.4), `item_add` e
 * `item_change` (fase D; frecuencia/plazo §9.3.7, ciclo propio §9.3.9, ítems de cotización), `multicurrency`, `reactivate` (§9.3.2) y
 * `pause` / `resume` (§9.3.3, B2-5) e `item_update` (§9.2 / F4: corregir un dato mal cargado). Pactos materializados con `PlanOptions.scheduled_change` (§9.3.6); confirmar una propuesta de
 * renovación = `renewal` con origen `renewal_proposal` (§9.3.5). No construido: `price_adjustment` (es un pacto), cambio de moneda del
 * contrato (§2.9), cambio de cliente comercial o compañía emisora (§2.10).
 *
 * Fechas siempre `YYYY-MM-DD` (texto).
 */

import { type FieldError, validationException } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';

import { classifyClientItem, type ClientContractRef, latestContractEnd, pricingFields } from './api-written-fields';
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
	isIndefiniteItem,
	itemEndDate,
	itemPeriods,
	itemPricing,
	monthsBetween,
	nextPeriodStart,
	type PreviewInvoice,
	type PreviewLine,
	pricedMonthlyEquivalent,
	resolveTaxRate,
	round2,
	suggestDocumentType,
	type TaxDocumentRate,
	validAnchorDay,
} from './billing-engine';
import { type CatalogPrice, catalogPriceErrors } from './catalog-prices';
import { priceStandardLine, UNIFIED_INVOICE_TYPE } from './consumption';
import { creditNotePendingEmission, ISSUED_STATUSES, PENDING_STATUS } from './contract-360';
import { cleanPaymentTerms, ContractDraftsService, isWholeContractRate, METERED_ADVANCE_MESSAGE } from './contract-drafts.service';
import { buildItemGroups, type ContractItem, deriveItemStatus, type ItemGroup, type PendingInvoiceLine } from './contract-items';
import { type ContractDerivedStatus, deriveContractStatus, isItemPausedOn, type StatusPause } from './contract-status';
import {
	CHANGE_TYPES,
	type ChangeType,
	type ContractChangeDto,
	type ContractChangeRequestDto,
	DEFERRED_CHANGE_TYPES,
	type InvoiceDecisionAction,
} from './dtos/contract-changes.dto';
import { hasPricingModel, type PriceSpecDto, UF_CURRENCY } from './dtos/create-contract.dto';
import { DESCRIPTION_FITTED_CODE, type DescriptionTemplate } from './invoice-description';
import {
	type CodedFieldError,
	codedValidationException,
	type ContractConversion,
	MULTICURRENCY_CODES,
	MULTICURRENCY_NOT_ENABLED_STEP,
	pairKey,
	toContractCurrency,
	upperCode,
	valuateLinesByPair,
} from './multicurrency';
import { oneOffOf, withoutOneOff } from './one-off-discount';
import { normalizePriceSpec, priceSpecFromRow } from './price-rows';
import {
	type ConsumptionInput,
	isMetered,
	isStandardFixed,
	type PricedLine,
	type PricedSubline,
	priceLine,
	type PriceSpec,
	type QuantitySource,
	validatePriceSpec,
} from './pricing-engine';
import { frequencyOfMonths, type ScheduledChangeRow } from './scheduled-change-rows';

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
	/** Tasa del documento tributario del contrato (`tax_document_types.tax_rate`, %; null = la de la compañía). Ronda 3 de Configuración. */
	tax_document_tax_rate?: number | string | null;
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
	/** Tasas fijas de facturación guardadas (`purpose = 'invoice'`, por par moneda del ítem → factura). */
	fx_invoice_rates: FxPeriodRate[];
	/** Multimoneda: `contracts.requires_multicurrency_billing`. */
	requires_multicurrency_billing?: boolean;
	/** Multimoneda: tasas pactadas ítem → contrato (`purpose = 'item'`), para MRR/TCV y el encabezado en moneda de contrato. */
	fx_item_rates?: FxPeriodRate[];
	/** Cierre de períodos de la compañía (`get_cutoff_date`), o null. */
	cutoff_date: string | null;
	/** Plantilla de descripción de líneas (`contracts.invoice_description_template`, spec facturas §3.6); null/ausente = la glosa de hoy. */
	invoice_description_template?: DescriptionTemplate | null;
	/** Límite de caracteres de la descripción del documento (`description_max_chars`); null/ausente = sin límite. Las glosas se ajustan a él. */
	description_max_chars?: number | null;
	/** `contracts.churn_date` (fecha de la cancelación del contrato; `reactivate` sin lista revierte los ítems con ese churn). */
	churn_date?: string | null;
	/** Todas las tasas fijas del contrato con id y propósito (renovación: extensión de las tasas de todo el contrato, §9.3.4). */
	fx_rates?: ContractFxRateRow[];
}

/** Pausa de un ítem (`contract_item_pauses`, §9.3.3) tal como la lee el plan. */
export interface ItemPauseRow extends StatusPause {
	id: string;
	extend_term: boolean;
	reason: string | null;
}

/** Fila de `contract_fx_period_rates` con su id y propósito. */
export interface ContractFxRateRow extends FxPeriodRate {
	id: string;
	purpose: 'company' | 'invoice' | 'item';
}

/** Ítem de la cotización de origen (`quote_items`) para `item_add` / `item_change` con `quote_item_id`. */
export interface QuoteItemRow {
	id: string;
	quote_id: string;
	product_id: string | null;
	product_name: string | null;
	account: string | null;
	item_type: string | null;
	unit_of_measure: string | null;
	quantity: number | null;
	/** Unitario mensual (el anual ÷ 12 si `price_entry_mode = annual`). */
	unit_price: number | null;
	annual_unit_price: number | null;
	price_entry_mode: string | null;
	discount_value: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
	start_date: string | null;
	is_recurring: boolean;
	currency: string | null;
	/** Modelo de precio del ítem cotizado (`prices`), o null = standard fijo. */
	price_spec: PriceSpec | null;
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
	/** Multimoneda: moneda de origen de la línea (`invoice_items.contract_currency` = moneda del ítem); los montos `subtotal`… están en ella. */
	currency?: string | null;
	/** Multimoneda: tasa de la línea moneda del ítem → factura (`invoice_items.fx_contract_to_invoice`). */
	fx?: number | null;
	/** Fecha de la tasa de la línea (`invoice_items.fx_rate_date`). */
	fx_rate_date?: string | null;
	/** Glosa escrita a mano (`invoice_items.description_locked`, spec facturas §3.6): ninguna regeneración la toca. */
	description_locked?: boolean;
	/** Desglose guardado (`invoice_items.pricing_breakdown`): la corrección (`item_update`) lee de aquí el descuento puntual de la línea. */
	pricing_breakdown?: PricedSubline[] | null;
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
	/** NC: motivo (`churn`, `downsell`…) y factura que acredita. `reactivate` cancela las NC del churn pendientes de emisión electrónica (`creditNotePendingEmission`). */
	credit_reason?: string | null;
	related_invoice_id?: string | null;
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
	/** Documento elegido en `billing_conditions` (del país de la compañía o genérico). `tax_rate` = su tasa (ronda 3 de Configuración). */
	tax_document_type: { id: string; code: string; name: string; kind: string; tax_rate?: number | null } | null;
	/** Origen cotización: la cotización si existe en el holding (multimoneda: su moneda, que hereda el ítem nuevo). */
	quote: { id: string; quote_type: string | null; already_applied: boolean; currency?: string | null } | null;
	/** `item_add` con precios medidos: métricas facturables del holding referenciadas (id → estado). */
	billable_metrics?: Map<string, string>;
	/** `item_add` con `price_id` (etapa 3): precios de catálogo del holding referenciados (solo los que existen). */
	catalog_prices?: Map<string, CatalogPrice>;
	/** `change_entity` con `new_entity` (§9.3.10): razón social del holding con el mismo identificador tributario normalizado, si existe. */
	entity_lookup?: { id: string; legal_name: string | null; tax_id: string | null; country: string | null; belongs_to_client: boolean } | null;
	/** Pactos del contrato (`contract_scheduled_changes`, §9.3.6); la renovación aplica los `on_renewal` `scheduled` de sus ítems. */
	scheduled_changes?: ScheduledChangeRow[];
	/** Series de índices (`indicadores_economicos`) que piden los pactos `index`: código → valores ordenados por fecha. */
	index_series?: Map<string, Array<{ date: string; value: number }>>;
	/** `reactivate`: eventos de baja (CHURN/DOWNSELL) del contrato, para marcar el original con `metadata.reversed_by`. */
	churn_events?: Array<{ id: string; event_type: string; items_affected: string[]; effective_date: string | null; reversed: boolean }>;
	/** Origen cotización: sus ítems (`quote_item_id` de `item_add` / `item_change`). */
	quote_items?: Map<string, QuoteItemRow>;
	/** `reactivate` rama c: los otros contratos del cliente (clasificación a nivel cliente, `classifyClientItem`, §9.1 #9). */
	client_contracts?: ClientContractRef[];
	/** Pausas de los ítems del contrato (`contract_item_pauses`, §9.3.3): estado derivado, MRR, pausar y reanudar. */
	pauses?: ItemPauseRow[];
	/** Origen `renewal_proposal` (§9.3.5): el evento RENEWAL_PROPOSED pedido si existe en el contrato (`status` = `metadata.status`). */
	renewal_proposal?: { id: string; status: string; item_ids: string[] } | null;
	today: string;
}

export { frequencyOfMonths, type ScheduledChangeRow };

// ------------------------------------------------------------------ resultado

export interface ChangeBlocker {
	code: string;
	message: string;
	next_step: string | null;
}

/** `contract_cancel` (§9.3.1): factura con período desde la fecha efectiva que necesita una decisión. */
export interface InvoiceDecisionRequired {
	invoice_id: string;
	invoice_number: string | null;
	issue_date: string | null;
	status_group: 'pending' | 'issued';
	/** Neto (moneda de contrato) de lo que cae desde la fecha efectiva: lo que `cancel`/`void` quita o acredita. */
	amount_after_effective: number;
	options: Array<'emit' | 'cancel' | 'keep' | 'void'>;
	default: 'cancel' | 'void';
	reason_hint: string;
}

/** `contract_cancel`: fechas efectivas sugeridas para ajustar la cancelación (§9.3.1). */
export interface EffectiveDateSuggestion {
	effective_date: string;
	reason: 'last_issued_period' | 'current_period';
	message: string;
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
	/** `false` = pago único: la UI no lo presenta como mensual (no suma MRR). */
	is_recurring: boolean;
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

/** Línea de una factura afectada en el preview (antes → después). Montos en la moneda de la línea (`currency`). */
export interface ChangeInvoiceDetailLine {
	key: string;
	product_name: string | null;
	account: string | null;
	description: string | null;
	quantity: number;
	unit_price: number;
	subtotal: number;
	currency: string | null;
	/** Tasa moneda de la línea → factura (multimoneda; null = spot o sin conversión). */
	fx: number | null;
	fx_rate_source: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	/** `same` = no cambia; `changed` = cambia (con `before`); `added` = línea nueva; `removed` = se quita. */
	status: 'same' | 'changed' | 'added' | 'removed';
	before: { quantity: number; unit_price: number; subtotal: number } | null;
}

/**
 * Factura afectada como factura (emisión, período, documento, líneas y totales antes → después), para que la vista previa del
 * cambio muestre la factura real y no una línea por factura. `after` null = la factura se anula. Totales en moneda de contrato;
 * `invoice_currency_amounts` solo con moneda de factura distinta, tasa de la factura y sin multimoneda.
 */
export interface ChangeInvoiceDetail {
	document_type: string | null;
	issue_date: string | null;
	due_date: string | null;
	billing_period_start: string | null;
	billing_period_end: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	fx: number | null;
	tax_rate: number;
	lines: ChangeInvoiceDetailLine[];
	before: { subtotal: number; tax: number; total: number } | null;
	after: { subtotal: number; tax: number; total: number } | null;
	invoice_currency_amounts?: { before: number | null; after: number | null } | null;
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
			detail?: ChangeInvoiceDetail | null;
		}>;
		created: PreviewInvoice[];
		cancelled: Array<{ id: string; invoice_number: string | null; issue_date: string | null; detail?: ChangeInvoiceDetail | null }>;
		credit_notes: Array<{
			mirrors_invoice_id: string;
			mirrors_invoice_number: string | null;
			total: number;
			currency: string | null;
			fx: number | null;
			detail?: ChangeInvoiceDetail | null;
		}>;
	};
	rsm: { mrr_delta: number; momentum: string | null; first_month: string | null; months_rebuilt: number; closed_months_skipped: number };
	warnings: ChangeWarning[];
	blockers: ChangeBlocker[];
	can_apply: boolean;
	/** `billing_conditions` con `apply_to_pending`: Por Emitir que toman el texto nuevo y las omitidas (bloqueos del masivo de facturas). */
	pending_terms?: PendingTermsResult;
	/** `contract_cancel` (§9.3.1): facturas que piden decisión (`change.invoice_decisions`) y la decisión usada en este cálculo. */
	invoice_decisions_required?: Array<InvoiceDecisionRequired & { action: 'emit' | 'cancel' | 'keep' | 'void' }>;
	/** `contract_cancel` (§9.3.1), `item_remove` y `pause`: fechas sugeridas (fin del último período emitido = sin NC; fin del período en curso). */
	effective_date_suggestions?: EffectiveDateSuggestion[];
	/** Pactos (§9.3.4/§9.3.6/§9.3.7): pactos que el cambio aplica, omite, cancela o registra como aplicados. */
	scheduled_changes?: {
		applied: Array<{ id: string | null; kind: string; item_id: string | null; value: number; applied_value: number; trigger: string }>;
		skipped: Array<{ id: string; kind: string; item_id: string | null; reason: string }>;
		created: Array<{ kind: string; item_id: string | null; value: number; trigger: string; status: string }>;
	};
	/** Renovación (§9.3.4): tasas "de todo el contrato" que se extienden al nuevo fin (op `extend_fx_rates`). */
	fx_rates_extended?: Array<{
		id: string;
		purpose: string;
		from_currency: string;
		to_currency: string;
		period_end_before: string;
		period_end_after: string;
	}>;
	/** `reactivate` (§9.3.2): rama por ítem (annul = churn aún no vigente; revert = vigente en mes abierto; reactivation = mes cerrado). */
	reactivation?: Array<{ item_id: string; branch: 'annul' | 'revert' | 'reactivation'; churn_date: string | null; mirror_item_id: string | null }>;
	/** `pause` / `resume` (§9.3.3): pausa por ítem (la nueva o la que se cierra), días pausados y corrimiento del fin (`extend_term`). */
	pauses?: PausePreview[];
	/** `item_update` (§9.2, corregir un dato): cada ítem con su cuenta antes y después y los datos corregidos. */
	items_after?: ItemUpdatePreview[];
	/** `item_update` con cantidad/precio/descuento: diferencia con lo ya emitido y entre qué Por Emitir se reparte. */
	issued_difference?: IssuedDifferencePreview;
}

/** Un ítem en el preview de `item_update` (§9.2): cuenta antes y después y cada dato corregido (antes → después). */
export interface ItemUpdatePreview {
	item_id: string;
	product_name: string | null;
	account_before: string | null;
	account: string | null;
	changes: ItemCorrectionChange[];
}

/** Una pausa en el preview de `pause` / `resume` (§9.3.3). */
export interface PausePreview {
	item_id: string;
	product_name: string | null;
	/** Pausa existente que cierra `resume` (null en `pause`: se crea). */
	pause_id: string | null;
	pause_start: string;
	pause_end_before: string | null;
	pause_end: string | null;
	status: 'scheduled' | 'active' | 'ended' | 'cancelled';
	extend_term: boolean;
	/** Días pausados (null = pausa abierta, hasta reanudar). */
	days_paused: number | null;
	end_date_before: string | null;
	end_date_after: string | null;
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
	/** Ciclo propio (§9.3.9): día de ciclo del ítem; null/ausente = ciclo del contrato. */
	billing_anchor_day?: number | null;
	/** `price_model_change`: el precio nuevo es la versión siguiente del anterior (`prices.version`, `supersedes_price_id`). */
	price_version?: number | null;
	supersedes_price_id?: string | null;
	/** RENEWAL con otro mensual: unitario base (mensual anterior ÷ cantidad del original) para `apply_renewal_price_split`. */
	renewal_base_unit_price?: number | null;
	/** Consumos registrados por período que el generador usa al tarifar el ítem nuevo (precio medido). */
	consumption?: ConsumptionInput[];
}

/** Fila nueva de `contract_scheduled_changes` (pacto registrado por el propio cambio, p. ej. la renovación con precio nuevo). */
export interface ScheduledChangeInsert {
	/** Ítem existente o clave `new:N` de un ítem que crea el mismo cambio; null = alcance contrato. */
	contract_item_ref: string | null;
	group_key: string | null;
	parent_id: string | null;
	trigger: 'on_renewal' | 'on_date' | 'every_n_months';
	effective_date: string | null;
	kind: ScheduledChangeRow['kind'];
	value: number;
	status: 'applied' | 'skipped' | 'scheduled';
	status_reason: string | null;
	applied_value: number | null;
	origin: Record<string, unknown>;
	notes: string | null;
}

export interface ChangeLineAmounts {
	quantity: number;
	unit_price: number;
	discount_pct: number;
	subtotal: number;
	tax_amount: number;
	total: number;
	billing_period_end?: string;
	/** Pausa (§9.3.3): la línea queda desde el día siguiente al fin de la pausa. */
	billing_period_start?: string;
	description_suffix?: string;
	/** Línea con consumo registrado: desglose del motor recalculado con la cantidad registrada (null/ausente = no se toca). */
	pricing_breakdown?: PricedSubline[] | null;
	quantity_source?: string | null;
}

/** Clave de la razón social que crea `change_entity` con `new_entity` (se resuelve al id real al escribir). */
export const NEW_ENTITY_KEY = 'new:entity';

export type WriteOp =
	| { kind: 'insert_item'; item: NewItemRow }
	| {
			kind: 'update_item';
			item_id: string;
			set: {
				churn_date?: string | null;
				churn_monthly_amount?: number | null;
				renewed_by_key?: string;
				end_date?: string;
				term_months?: number;
				price?: number;
				final_price?: number;
				/** `billing_conditions.auto_renew` (§9.3.5). */
				auto_renew?: boolean;
				/** `item_update` (§9.2): cuenta del ítem (NULL = sin cuenta). */
				account?: string | null;
				/** `item_update` (corregir la fecha de inicio): inicio corregido (con `term_months`, `price` y `final_price` de los meses nuevos). */
				start_date?: string;
				/** `item_update` (corregir un dato): glosa, tipo y valores del ítem (precios derivados ya calculados con `pricingFields`). */
				product_name?: string;
				item_type?: string | null;
				quantity?: number;
				unit_price?: number | null;
				annual_unit_price?: number | null;
				annual_price?: number | null;
				price_entry_mode?: string | null;
				discount_type?: string | null;
				discount_value?: number;
				monthly_price?: number | null;
				billing_period_price?: number | null;
			};
	  }
	/** `item_update` (corrección): motivo del desvío de la Por Emitir que recibe su parte de la diferencia emitida (`invoice_adjustments`). */
	| { kind: 'insert_invoice_adjustment'; invoice_id: string; type: 'correction'; amount_diff: number; notes: string }
	/** `pause` (§9.3.3): fila nueva en `contract_item_pauses` (se liga al evento con `pause_event_id`). */
	| {
			kind: 'insert_pause';
			pause: {
				contract_item_id: string;
				pause_start: string;
				pause_end: string | null;
				extend_term: boolean;
				status: 'scheduled' | 'active';
				reason: string | null;
			};
	  }
	/** `resume` (§9.3.3): cierra la pausa (`pause_end = reanudación − 1`, `ended`; o `cancelled` si aún no empezaba) y la liga al evento. */
	| { kind: 'update_pause'; id: string; set: { pause_end: string | null; status: 'ended' | 'cancelled' } }
	/** `reactivate` (rama anular/revertir): quita el espejo CHURN/DOWNSELL (sin facturas propias) y sus filas de RSM. */
	| { kind: 'delete_item'; item_id: string }
	/** `price_model_change`: los consumos del ítem desde el corte pasan al ítem que lo continúa (RENEWAL con el modelo nuevo). */
	| { kind: 'move_consumption'; from_item_id: string; to_key: string; from_period: string }
	/** `change_entity` con `new_entity`: `client_entities` + `client_entity_clients` (`is_primary = false`); id → `NEW_ENTITY_KEY`. */
	| {
			kind: 'insert_entity';
			entity: {
				client_id: string;
				legal_name: string;
				tax_id: string;
				country: string;
				address: string | null;
				email: string | null;
				payment_terms: PaymentTerms | null;
			};
	  }
	/** Renovación (§9.3.4): mueve `period_end` de las tasas "de todo el contrato" al nuevo fin. */
	| { kind: 'extend_fx_rates'; rates: Array<{ id: string; period_end: string }> }
	/** Pacto nuevo (aplicado/omitido en el acto, o hija de `every_n_months`); los `applied` se ligan al evento del cambio. */
	| { kind: 'insert_scheduled_change'; row: ScheduledChangeInsert }
	/** Pacto existente: estado, motivo, valor aplicado o próxima fecha; `applied` se liga al evento del cambio. */
	| {
			kind: 'update_scheduled_change';
			id: string;
			set: {
				status?: ScheduledChangeRow['status'];
				status_reason?: string | null;
				applied_value?: number | null;
				next_effective_date?: string;
			};
	  }
	/** `reactivate`: el evento de baja original recibe `metadata.reversed_by` (id del evento nuevo). */
	| { kind: 'mark_events_reversed'; event_ids: string[] }
	/** `item_update` (§9.2): regenera con la plantilla del contrato la glosa de estas líneas Por Emitir no protegidas (después de `update_item`). */
	| { kind: 'regenerate_descriptions'; line_ids: string[] }
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
	| {
			kind: 'update_invoices_fx';
			/** `lines` (multimoneda): tasa por línea (su par); el encabezado toma `fx` (la del único par convertidor o null). */
			targets: Array<{
				invoice_id: string;
				fx: number | null;
				lines?: Array<{
					line_id: string;
					fx: number | null;
					amounts: { unit_price: number; subtotal: number; tax: number; total: number } | null;
				}>;
			}>;
			invoice_currency: string;
	  }
	| {
			kind: 'insert_fx_rates';
			rates: Array<{
				/** Default `invoice`; `item` = tasa pactada ítem → contrato (multimoneda). */
				purpose?: 'invoice' | 'item';
				from_currency: string;
				to_currency: string;
				rate: number;
				period_start: string;
				period_end: string;
			}>;
	  }
	/** Multimoneda: enciende/apaga `requires_multicurrency_billing` (va antes de los ítems: el validador de ítems lo lee). */
	| { kind: 'set_multicurrency'; enabled: boolean }
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
	billing_conditions: ['draft', 'active', 'pending_renewal', 'paused'],
	change_entity: ['active', 'pending_renewal', 'paused'],
	item_remove: ['active', 'pending_renewal', 'paused'],
	contract_cancel: ['active', 'pending_renewal', 'expired', 'paused'],
	renewal: ['active', 'pending_renewal', 'expired', 'paused'],
	item_add: ['active'],
	item_change: ['active', 'pending_renewal'],
	multicurrency: ['active', 'pending_renewal', 'expired', 'paused'],
	// Reactivar (§9.3.2): contrato Cancelado o ítems con churn de un contrato vigente (S3-9); sin nada que reactivar → `not_cancelled`.
	reactivate: ['cancelled', 'active', 'pending_renewal', 'expired'],
	// Pausa / reanudación (§9.3.3): pausar un contrato vigente; reanudar también uno Pausado (todos sus recurrentes pausados).
	pause: ['active', 'pending_renewal'],
	resume: ['active', 'pending_renewal', 'paused'],
	// Datos no comerciales del ítem (§9.2, cuenta): cualquier estado salvo En revisión (borrador: se edita el borrador) y Cancelado.
	item_update: ['active', 'pending_renewal', 'expired', 'paused'],
	// Cambio de modelo de precio (§9.3.11): contrato vigente (Activo o Por renovar).
	price_model_change: ['active', 'pending_renewal'],
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

/** Por qué cada tipo diferido no es un cambio (el reajuste es un pacto, §9.3.6). */
export const DEFERRED_MESSAGES: Record<(typeof DEFERRED_CHANGE_TYPES)[number], string> = {
	price_adjustment:
		'El reajuste (IPC, UF, escalamientos) es un pacto: créalo en POST /contracts/:id/scheduled-changes y aplícalo con …/:changeId/apply (spec §9.3.6)',
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

/**
 * Fin del contrato (decisión de Domi 01-10, una sola regla con el alta y la activación): el MAYOR fin de los recurrentes vivos
 * (`latestContractEnd` de `api-written-fields.ts`); `null` si alguno es indefinido o no queda ninguno vivo.
 */
export const contractEndOf = (items: ChangeItemRow[]): string | null => latestContractEnd(items) ?? null;

/**
 * Multimoneda (spec §5): copia del ítem con sus montos (mensual, valor) en moneda de contrato con la tasa pactada ítem → contrato (a su
 * inicio). Sin conversión o en la moneda del contrato, el mismo ítem.
 */
const inContractCurrency = (item: ChangeItemRow, conversion?: ContractConversion | null): ChangeItemRow => {
	if (!conversion || !item.currency || upperCode(item.currency) === upperCode(conversion.contract_currency)) return item;
	const date = item.start_date ?? '';
	const convert = (value: number | null) =>
		value === null || value === undefined
			? value
			: toContractCurrency(num(value), item.currency, conversion.contract_currency, conversion.item_rates, date);

	return { ...item, monthly_price: convert(item.monthly_price), final_price: convert(item.final_price), price: convert(item.price) };
};

/** MRR del contrato a una fecha = Σ MRR del ítem madre (misma regla del 360); multimoneda: cada ítem a moneda de contrato con su tasa `item`. */
export const contractMrr = (items: ChangeItemRow[], date: string, conversion?: ContractConversion | null): number =>
	round2(
		buildItemGroups(
			items.map((item) => inContractCurrency(item, conversion)),
			date
		).reduce((sum, group) => sum + group.mrr, 0)
	);

/**
 * Ítems que cuentan para el MRR a una fecha (§9.3.3): sin los pausados ese día ni los ajustes ligados a un ítem pausado (MRR 0 en el tramo).
 * Sin pausas, la misma lista.
 */
export const unpausedOn = (items: ChangeItemRow[], pauses: StatusPause[] | undefined, date: string): ChangeItemRow[] => {
	if (!pauses?.length) return items;
	const paused = new Set(items.filter((item) => isItemPausedOn(pauses, item.id, date)).map((item) => item.id));

	return items.filter((item) => !paused.has(item.id) && !(item.related_item_id && paused.has(item.related_item_id)));
};

/** TCV (`contracts.total_value`) = Σ `final_price`; multimoneda: cada ítem × su tasa `item` (spec §5). */
const totalValue = (items: ChangeItemRow[], conversion?: ContractConversion | null) =>
	round2(items.reduce((sum, item) => sum + num(inContractCurrency(item, conversion).final_price), 0));

/** Conversión del contrato (moneda + tasas `item`), con tasas extra que agrega el propio cambio. */
export const conversionOf = (contract: ChangeContractRow, extra: FxPeriodRate[] = []): ContractConversion => ({
	contract_currency: upperCode(contract.contract_currency),
	item_rates: [...(contract.fx_item_rates ?? []), ...extra],
});

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
	// Multimoneda: tasas pactadas ítem → contrato (encabezado y totales en moneda de contrato).
	fixed_item_rates: contract.fx_item_rates ?? [],
	multicurrency: contract.requires_multicurrency_billing === true,
	document_type: contract.document_type,
	company: { country: contract.company.country, tax_rate: contract.company.tax_rate },
	tax_document: contract.tax_document_type_id ? { kind: contract.tax_document_type_kind, tax_rate: contract.tax_document_tax_rate ?? null } : null,
	entity_country: contract.entity.country,
	description_template: contract.invoice_description_template ?? null,
	description_context: { contract_number: contract.contract_number, client_name: contract.entity.legal_name },
	description_max_chars: contract.description_max_chars ?? null,
	...overrides,
});

/** Día de ciclo efectivo del contrato (guardado o el del primer recurrente de ciclo del contrato; §9.3.9: los de ciclo propio no cuentan). */
export const anchorDayOf = (contract: ChangeContractRow, items: ChangeItemRow[]): number => {
	const saved = Number(contract.billing_anchor_day);

	if (Number.isInteger(saved) && saved >= 1 && saved <= 31) return saved;
	const live = liveRecurring(items);
	const contractCycle = live.filter((item) => !validAnchorDay(item.billing_anchor_day));
	const first = (contractCycle.length ? contractCycle : live)
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
	currency: item.currency,
	billing_anchor_day: item.billing_anchor_day ?? null,
	...(item.consumption?.length ? { consumption: item.consumption } : {}),
});

/** Ítem existente al formato del generador (solo lo que necesita `itemPeriods`/`nextPeriodStart`; con su ciclo propio, §9.3.9). */
export const engineShape = (item: ChangeItemRow) => ({
	start_date: item.start_date ?? '',
	end_date: item.end_date,
	term_months: num(item.term_months),
	billing_frequency: item.billing_frequency ?? 'Mensual',
	billing_method: item.billing_method ?? 'Anticipado',
	billing_anchor_day: validAnchorDay(item.billing_anchor_day),
});

/** Día de ciclo con que se factura un ítem existente: el propio (§9.3.9) o el del contrato. */
export const anchorOfItem = (item: Pick<ChangeItemRow, 'billing_anchor_day'>, contractAnchor: number) =>
	validAnchorDay(item.billing_anchor_day) ?? contractAnchor;

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
		billing_anchor_day: item.billing_anchor_day ?? null,
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
	is_recurring: item.is_recurring !== false,
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

/**
 * Identificador tributario normalizado para buscar duplicados (misma regla que el directorio de clientes:
 * `lower(regexp_replace(tax_id, '[^0-9kK]', '', 'g'))`).
 */
export const normalizeTaxId = (taxId: string | null | undefined) =>
	String(taxId ?? '')
		.replace(/[^0-9kK]/g, '')
		.toLowerCase();

/** Mensaje de un tipo diferido (400) o null si está construido. */
export const deferredMessage = (type: string): string | null =>
	(DEFERRED_CHANGE_TYPES as readonly string[]).includes(type) ? DEFERRED_MESSAGES[type as (typeof DEFERRED_CHANGE_TYPES)[number]] : null;

// ------------------------------------------------------------------ constructor del plan

/** Opciones internas del plan (no vienen del body). */
export interface PlanOptions {
	/** Pacto que se materializa (`…/scheduled-changes/:changeId/apply`): valor a usar, su disparo y la marca en el evento. */
	scheduled_change?: {
		id: string;
		value: number;
		kind: ScheduledChangeRow['kind'];
		trigger: ScheduledChangeRow['trigger'];
		/** Fecha del pacto que se aplica (`on_date` / la próxima de `every_n_months`). */
		effective_date: string | null;
		interval_months: number | null;
	};
}

class Planner {
	readonly blockers: ChangeBlocker[] = [];
	readonly warnings: ChangeWarning[] = [];
	readonly ops: WriteOp[] = [];
	readonly errors: CodedFieldError[] = [];
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
	/** Multimoneda: tasas que agrega el propio cambio (ya en `ops`), para el generador y el MRR/TCV del preview. */
	extraInvoiceRates: FxPeriodRate[] = [];
	extraItemRates: FxPeriodRate[] = [];
	/** Multimoneda: el cambio enciende/apaga el flag (`set_multicurrency`). */
	multicurrencyAfter: boolean | null = null;
	/** `contract_cancel` (§9.3.1): decisión por factura (`emit`/`keep` = no se toca; `cancel`/`void` = regla de la baja). */
	readonly invoiceDecisions = new Map<string, InvoiceDecisionAction>();
	/** `contract_cancel` con decisión `cancel`: las líneas editadas a mano también se quitan (entran a la misma decisión, §9.3.1). */
	forceManual = false;
	/** Ítems de ciclo propio (§9.3.9), existentes y nuevos (`new:N`): `mergeTarget` solo los funde con PE de la misma fecha exacta. */
	readonly ownCycleKeys = new Set<string>();
	/** Campos opcionales del preview que agrega cada tipo (decisiones, sugerencias, pactos, tasas extendidas, ramas de reactivación). */
	readonly extras: Partial<ChangePreview> = {};
	/** Pausas después del cambio (§9.3.3): estado derivado y MRR del preview; `pause` agrega y `resume` cierra. */
	pausesAfter: StatusPause[];
	private counter = 0;
	/** Facturas como estaban antes del cambio (el plan muta `ctx.invoices`): el "antes" de la vista previa por factura. */
	private readonly invoicesBefore: Map<string, ChangeInvoiceRow>;
	/** Encabezados ya marcados para recálculo (una sola vez por factura). */
	private readonly headersTouched = new Map<string, { before: number; lines: number; change: string }>();
	/** Por Emitir facturadas por OC que el cambio habría tocado y deja como están (aviso `partial_billing_skipped`). */
	private readonly partialSkipped = new Map<string, ChangeInvoiceRow>();

	constructor(
		readonly ctx: ChangeContext,
		readonly req: ContractChangeRequestDto,
		readonly type: ChangeType,
		readonly options: PlanOptions = {}
	) {
		this.itemsAfter = ctx.items.map((item) => ({ ...item }));
		this.invoicesBefore = new Map(ctx.invoices.map((invoice) => [invoice.id, { ...invoice, lines: invoice.lines.map((line) => ({ ...line })) }]));
		this.pausesAfter = (ctx.pauses ?? []).map((pause) => ({ ...pause }));
		for (const item of ctx.items) if (validAnchorDay(item.billing_anchor_day)) this.ownCycleKeys.add(item.id);
		// Pacto que se materializa: tiene que seguir programado (otro apply concurrente o un skip/cancel lo cierran).
		const pact = options.scheduled_change ? (ctx.scheduled_changes ?? []).find((row) => row.id === options.scheduled_change!.id) : null;

		if (options.scheduled_change && (!pact || pact.status !== 'scheduled'))
			this.block(
				'scheduled_change_not_scheduled',
				`El pacto ya no está programado (${pact?.status ?? 'no existe'}): no se vuelve a aplicar`,
				'Revisa el historial de pactos del contrato'
			);
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
	error(field: string, message: string, code?: string) {
		this.errors.push({ field, message, ...(code ? { code } : {}) });
	}

	/** Multimoneda vigente después del cambio (el guardado o el que enciende/apaga el propio cambio). */
	get multicurrency(): boolean {
		return this.multicurrencyAfter ?? this.ctx.contract.requires_multicurrency_billing === true;
	}

	/** Contrato para el generador con lo que agrega el cambio (tasas nuevas y el flag). */
	engineContractAfter(): BillingEngineContract {
		const contract = this.ctx.contract;

		return engineContract(contract, {
			fixed_invoice_rates: [...contract.fx_invoice_rates, ...this.extraInvoiceRates],
			fixed_item_rates: [...(contract.fx_item_rates ?? []), ...this.extraItemRates],
			multicurrency: this.multicurrency,
		});
	}

	/** Un monto de un ítem en moneda de contrato (ΔMRR de eventos, multimoneda §5); sin conversión o en la moneda del contrato, igual. */
	toContract(amount: number, currency: string | null | undefined, date: string): number {
		const conversion = this.conversion();

		if (!conversion || !currency || upperCode(currency) === conversion.contract_currency) return amount;

		return toContractCurrency(amount, currency, conversion.contract_currency, conversion.item_rates, date);
	}

	/** Conversión a moneda de contrato para MRR/TCV (solo multimoneda; sin flag, los montos ya están en moneda de contrato). */
	conversion(): ContractConversion | null {
		return this.multicurrency || this.ctx.contract.requires_multicurrency_billing === true
			? conversionOf(this.ctx.contract, this.extraItemRates)
			: null;
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
		const status = deriveContractStatus(this.ctx.contract.status, this.ctx.items, this.ctx.today, this.ctx.pauses);
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

		if (validAnchorDay(item.billing_anchor_day)) this.ownCycleKeys.add(item.key);
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
		if (line.quantity_source !== 'manual' || this.forceManual) return false;
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
		// El neto vigente de la PE sigue a sus líneas (una línea que se suma después parte de él); multimoneda lo recalcula el encabezado.
		if (this.ctx.contract.requires_multicurrency_billing !== true) invoice.subtotal = round2(invoice.subtotal - line.subtotal);
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
		if (values.billing_period_start) line.billing_period_start = values.billing_period_start;
		this.touchHeader(invoice, change);
	}

	/** Cierra los encabezados tocados: recalcula (o cancela si quedó sin líneas) y arma `invoices.updated/cancelled`. */
	closeHeaders(note: string) {
		// PE que reciben líneas nuevas del generador (F3): aunque se queden sin sus líneas viejas no se cancelan.
		const mergedInto = new Set(
			this.ops.flatMap((op) => (op.kind === 'create_invoices' ? op.merge_into.filter((id): id is string => Boolean(id)) : []))
		);

		for (const [invoiceId, touched] of this.headersTouched) {
			const invoice = this.ctx.invoices.find((row) => row.id === invoiceId)!;
			const after = round2(invoice.lines.reduce((sum, line) => sum + line.subtotal, 0));
			const merged = this.updatedInvoices.find((entry) => entry.id === invoiceId);

			if (merged) {
				// Ya figura como destino de líneas nuevas: una sola fila en el preview (antes = el original, después = con todo).
				this.ops.push({ kind: 'recompute_header', invoice_id: invoiceId, cancel_if_empty: false, note });
				merged.subtotal_before = touched.before;
				merged.lines_changed += touched.lines;
				merged.change = `${touched.change} · ${merged.change}`;
				continue;
			}
			if (invoice.lines.length === 0 && !mergedInto.has(invoiceId)) {
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

	private itemOf(itemId: string | null | undefined) {
		if (!itemId) return null;

		return this.itemsAfter.find((item) => item.id === itemId) ?? this.ctx.items.find((item) => item.id === itemId) ?? null;
	}

	/**
	 * Una factura afectada como factura (vista previa §5): líneas antes → después desde los `ops` del plan (`update_line`, `delete_line`
	 * y las líneas del generador que se funden en ella) sobre la copia previa al cambio. `subtotalAfter` null = se anula.
	 */
	invoiceDetail(invoiceId: string, subtotalAfter: number | null): ChangeInvoiceDetail | null {
		const before = this.invoicesBefore.get(invoiceId);

		if (!before) return null;
		const cancelled = subtotalAfter === null;
		const updates = new Map<string, ChangeLineAmounts>();
		const deleted = new Set<string>();
		const merged: PreviewLine[] = [];

		for (const op of this.ops) {
			if (op.kind === 'update_line' && op.invoice_id === invoiceId) updates.set(op.line_id, op.values);
			if (op.kind === 'delete_line' && op.invoice_id === invoiceId) deleted.add(op.line_id);
			if (op.kind === 'create_invoices')
				op.merge_into.forEach((target, index) => target === invoiceId && merged.push(...op.invoices[index].lines));
		}
		const contractCurrency = before.contract_currency;
		const lines: ChangeInvoiceDetailLine[] = before.lines.map((line) => {
			const item = this.itemOf(line.contract_item_id);
			const was = { quantity: num(line.quantity), unit_price: num(line.unit_price), subtotal: num(line.subtotal) };
			const base = {
				key: line.id,
				product_name: item?.product_name ?? null,
				account: item?.account ?? null,
				description: line.description,
				currency: line.currency ?? contractCurrency,
				fx: line.fx ?? null,
				fx_rate_source: line.fx_rate_source ?? null,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
			};

			if (cancelled || deleted.has(line.id)) return { ...base, ...was, status: 'removed' as const, before: was };
			const values = updates.get(line.id);

			if (!values) return { ...base, ...was, status: 'same' as const, before: null };
			const now = { quantity: num(values.quantity), unit_price: num(values.unit_price), subtotal: num(values.subtotal) };
			const changed = now.quantity !== was.quantity || now.unit_price !== was.unit_price || now.subtotal !== was.subtotal;

			return {
				...base,
				...now,
				billing_period_start: values.billing_period_start ?? line.billing_period_start,
				billing_period_end: values.billing_period_end ?? line.billing_period_end,
				status: changed ? ('changed' as const) : ('same' as const),
				before: changed ? was : null,
			};
		});

		for (const line of merged)
			lines.push({
				key: `${line.item_key}|${line.billing_period_start}`,
				product_name: line.product_name,
				account: this.itemOf(line.item_key)?.account ?? null,
				description: line.description,
				quantity: line.quantity,
				unit_price: line.unit_price,
				subtotal: line.subtotal,
				currency: line.currency ?? contractCurrency,
				fx: line.fx ?? null,
				fx_rate_source: line.fx_rate_source ?? null,
				billing_period_start: line.billing_period_start,
				billing_period_end: line.billing_period_end,
				status: 'added',
				before: null,
			});
		const totals = (subtotal: number, tax: number) => ({ subtotal: round2(subtotal), tax: round2(tax), total: round2(subtotal + tax) });
		const beforeTotals = totals(num(before.subtotal), num(before.vat));
		const afterTotals = cancelled ? null : totals(subtotalAfter, (subtotalAfter * num(before.tax_rate)) / 100);
		const invoiceCurrency = upper(before.invoice_currency) || null;
		const converts =
			Boolean(invoiceCurrency) &&
			invoiceCurrency !== upper(contractCurrency) &&
			before.fx !== null &&
			this.ctx.contract.requires_multicurrency_billing !== true;
		const periods = lines.filter((line) => line.status !== 'removed' || cancelled);

		return {
			document_type: before.document_type,
			issue_date: before.issue_date,
			due_date: before.due_date,
			billing_period_start:
				periods
					.map((line) => line.billing_period_start)
					.filter((day): day is string => Boolean(day))
					.sort()[0] ?? null,
			billing_period_end:
				periods
					.map((line) => line.billing_period_end)
					.filter((day): day is string => Boolean(day))
					.sort()
					.at(-1) ?? null,
			contract_currency: contractCurrency,
			invoice_currency: before.invoice_currency,
			fx: before.fx,
			tax_rate: num(before.tax_rate),
			lines,
			before: beforeTotals,
			after: afterTotals,
			invoice_currency_amounts: converts
				? {
						before: before.total_invoice ?? round2(beforeTotals.total * num(before.fx)),
						after: afterTotals ? round2(afterTotals.total * num(before.fx)) : null,
					}
				: null,
		};
	}

	/** NC espejo como factura: las líneas acreditadas (la parte `ratio` de cada línea original) y sus totales (positivos). */
	creditNoteDetail(invoiceId: string): ChangeInvoiceDetail | null {
		const op = this.ops.find((candidate) => candidate.kind === 'credit_note' && candidate.mirrors.id === invoiceId);

		if (!op || op.kind !== 'credit_note') return null;
		const original = this.invoicesBefore.get(invoiceId) ?? op.mirrors;
		const lines: ChangeInvoiceDetailLine[] = op.lines.map(({ line, ratio, period_start }) => {
			const item = this.itemOf(line.contract_item_id);
			const subtotal = round2(num(line.subtotal) * ratio);

			return {
				key: line.id,
				product_name: item?.product_name ?? null,
				account: item?.account ?? null,
				description: line.description,
				quantity: num(line.quantity),
				unit_price: round6(num(line.unit_price) * ratio),
				subtotal,
				currency: line.currency ?? original.contract_currency,
				fx: line.fx ?? null,
				fx_rate_source: line.fx_rate_source ?? null,
				billing_period_start: period_start,
				billing_period_end: line.billing_period_end,
				status: 'added',
				before: null,
			};
		});
		const subtotal = round2(lines.reduce((sum, line) => sum + line.subtotal, 0));
		const tax = round2((subtotal * num(original.tax_rate)) / 100);

		return {
			document_type: 'NC',
			issue_date: null,
			due_date: null,
			billing_period_start:
				lines
					.map((line) => line.billing_period_start)
					.filter((day): day is string => Boolean(day))
					.sort()[0] ?? null,
			billing_period_end:
				lines
					.map((line) => line.billing_period_end)
					.filter((day): day is string => Boolean(day))
					.sort()
					.at(-1) ?? null,
			contract_currency: original.contract_currency,
			invoice_currency: original.invoice_currency,
			fx: original.fx,
			tax_rate: num(original.tax_rate),
			lines,
			before: null,
			after: { subtotal, tax, total: round2(subtotal + tax) },
			invoice_currency_amounts: null,
		};
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
			// `contract_cancel` (§9.3.1): emitir completa / conservar sin NC no tocan la factura; la facturada por OC con `cancel` se cancela entera aparte.
			const decision = this.invoiceDecisions.get(invoice.id);

			if (decision === 'emit' || decision === 'keep') continue;
			if (isEditablePending(invoice)) {
				if (decision === 'cancel' && isPartialBilled(invoice)) continue;
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

	/**
	 * MF-b / Huecos #4b: filas del motor de precios (una en `single`, una por tramo en `per_tier`, con su `pricing_breakdown`) que reemplazan
	 * las del ítem en una Por Emitir (las viejas ya se quitaron con `deleteLine`). Se escriben como líneas del generador fundidas en esa PE.
	 */
	mergePricedLines(invoice: ChangeInvoiceRow, generated: PreviewInvoice, change: string) {
		const added = round2(generated.lines.reduce((sum, line) => sum + line.subtotal, 0));
		const multicurrency = this.ctx.contract.requires_multicurrency_billing === true;
		const after = round2(invoice.subtotal + (multicurrency ? generated.subtotal : added));
		const merged = this.updatedInvoices.find((entry) => entry.id === invoice.id);

		if (merged) {
			merged.lines_changed += generated.lines.length;
			merged.subtotal_after = after;
		} else
			this.updatedInvoices.push({
				id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				lines_changed: generated.lines.length,
				subtotal_before: invoice.subtotal,
				subtotal_after: after,
				change,
			});
		invoice.subtotal = after;
		this.touchRsm(generated.billing_period_start);
		this.ops.push({ kind: 'create_invoices', invoices: [generated], fixed_rates: [null], merge_into: [invoice.id] });
	}

	/** Facturas del generador para ítems nuevos: bloqueo por tasa fija faltante, tramo inicial suelto y fusión con PE del mes (F3). */
	addGeneratedInvoices(items: NewItemRow[], firstPeriod: 'cycle' | 'immediate') {
		if (!items.length) return;
		const contract = this.ctx.contract;
		const engine = generateInvoices({ contract: this.engineContractAfter(), items: items.map(engineItemFromNew) });
		const contractCurrency = upper(contract.contract_currency);
		const invoiceCurrency = upper(contract.invoice_currency) || contractCurrency;
		// Multimoneda: la valorización es por línea (cada par con su tasa); los bloqueos van por par (`fx_missing`).
		const perLine = engine.fx_missing !== undefined;
		const usesFixedFx = !perLine && contract.fx_invoice_policy === 'fixed' && invoiceCurrency !== contractCurrency;

		for (const missing of engine.fx_missing ?? []) {
			if (missing.purpose === 'invoice')
				this.block(
					'fixed_fx_without_rate',
					`Falta la tasa fija ${missing.from_currency} → ${missing.to_currency} para facturar desde el ${missing.period_start}`,
					'Agrega la tasa del par en fx_invoice_rates o usa tipo de cambio del día'
				);
			else
				this.block(
					MULTICURRENCY_CODES.item_fx_rate_missing,
					`Falta la tasa pactada ${missing.from_currency} → ${missing.to_currency} (métricas) desde el ${missing.period_start}`,
					'Agrega la tasa ítem → contrato del par en fx_item_rates'
				);
		}
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
					// Multimoneda: el subtotal del generador ya está en moneda de contrato (líneas × tasa ítem → contrato).
					subtotal_after: round2(before + (perLine ? invoice.subtotal : added)),
					change: `se suma a la factura del ${existing.issue_date}`,
				});
				existing.subtotal = round2(before + (perLine ? invoice.subtotal : added));
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

	/**
	 * `reactivate` (ramas anular/revertir, §9.3.2): rehace las Por Emitir del ítem desde `from` con el generador, solo por los días que
	 * ninguna factura vigente cubre (emitidas no anuladas y Por Emitir; una NC vigente descubre sus días). Un período cubierto en parte
	 * (la PE prorrateada por la baja) recibe una línea por el resto, en proporción a sus días. Emisión = la del período o hoy si ya pasó.
	 */
	restoreItemBilling(
		item: ChangeItemRow,
		from: string,
		cancelledCreditNotes: Set<string>,
		/**
		 * `until`: fin con que se genera un ítem sin término (horizonte, `planHorizonExtension`); `note`: texto del tramo parcial;
		 * `through`: último día que se rehace (`item_update` con fecha de inicio: solo el tramo que cambia, nunca un período posterior).
		 */
		options: { until?: string; note?: string; through?: string } = {}
	): PreviewInvoice[] {
		const end = options.until ?? item.end_date;

		if (!item.start_date || !end) return [];
		const engine = generateInvoices({
			contract: this.engineContractAfter(),
			items: [
				{
					key: item.id,
					product_id: item.product_id,
					product_name: item.product_name ?? 'Producto',
					account: item.account,
					quantity: num(item.quantity),
					unit_price: num(item.unit_price ?? num(item.annual_unit_price) / 12),
					discount_value: num(item.discount_value),
					discount_type: item.discount_type,
					billing_frequency: item.billing_frequency ?? 'Mensual',
					billing_method: item.billing_method ?? 'Anticipado',
					start_date: item.start_date,
					term_months: options.until ? monthsCeil(item.start_date, end) : item.term_months,
					end_date: end,
					is_recurring: item.is_recurring !== false,
					final_price: item.final_price,
					price: priceSpecFromRow(item.raw),
					currency: item.currency,
					billing_anchor_day: validAnchorDay(item.billing_anchor_day),
				},
			],
		});
		const covered = new Set<string>();
		const days = (start: string, end: string) => {
			const list: string[] = [];

			for (let day = start; day <= end; day = addDays(day, 1)) list.push(day);

			return list;
		};

		for (const invoice of this.ctx.invoices) {
			if (invoice.status === 'Cancelada' || !invoice.is_active || invoice.voided || /^(NC|ND)$/i.test(invoice.document_type ?? '')) continue;
			for (const line of invoice.lines)
				if (line.contract_item_id === item.id && line.billing_period_start && line.billing_period_end)
					days(line.billing_period_start, line.billing_period_end).forEach((day) => covered.add(day));
		}
		for (const invoice of this.ctx.invoices) {
			if (
				!/^NC$/i.test(invoice.document_type ?? '') ||
				invoice.status === 'Cancelada' ||
				!invoice.is_active ||
				cancelledCreditNotes.has(invoice.id)
			)
				continue;
			for (const line of invoice.lines)
				if (line.contract_item_id === item.id && line.billing_period_start && line.billing_period_end && line.billing_period_start >= from)
					days(line.billing_period_start, line.billing_period_end).forEach((day) => covered.delete(day));
		}
		const restored: PreviewInvoice[] = [];

		for (const invoice of engine.invoices) {
			const lines: PreviewInvoice['lines'] = [];

			for (const line of invoice.lines) {
				if (line.billing_period_end < from) continue;
				const periodDays = days(line.billing_period_start, line.billing_period_end);
				const runs: Array<[string, string]> = [];

				for (const day of periodDays) {
					if (day < from || covered.has(day) || (options.through && day > options.through)) continue;
					const last = runs[runs.length - 1];

					if (last && addDays(last[1], 1) === day) last[1] = day;
					else runs.push([day, day]);
				}
				for (const [start, end] of runs) {
					const ratio = (diffDays(start, end) + 1) / periodDays.length;

					if (ratio === 1) {
						lines.push(line);
						continue;
					}
					const subtotal = round2(line.subtotal * ratio);
					const tax = round2((subtotal * invoice.tax_rate) / 100);

					lines.push({
						...line,
						description: `${line.description} (${options.note ?? 'reactivado'}: ${start} a ${end})`,
						unit_price: round6(line.unit_price * ratio),
						subtotal,
						tax_amount: tax,
						total: round2(subtotal + tax),
						billing_period_start: start,
						billing_period_end: end,
						prorated: true,
						prorated_days: diffDays(start, end) + 1,
						...(line.amounts_invoice_currency
							? {
									amounts_invoice_currency: {
										unit_price: round6(line.amounts_invoice_currency.unit_price * ratio),
										subtotal: round2(line.amounts_invoice_currency.subtotal * ratio),
										tax: round2(line.amounts_invoice_currency.tax * ratio),
										total: round2(line.amounts_invoice_currency.total * ratio),
									},
								}
							: {}),
					});
				}
			}
			if (!lines.length) continue;
			const subtotal = round2(lines.reduce((sum, line) => sum + line.subtotal, 0));
			const tax = round2(lines.reduce((sum, line) => sum + line.tax_amount, 0));
			const issueDate = invoice.issue_date < this.ctx.today ? this.ctx.today : invoice.issue_date;
			const terms = cleanPaymentTerms(this.ctx.contract.payment_terms) ?? cleanPaymentTerms(this.ctx.contract.entity.payment_terms);

			restored.push({
				...invoice,
				issue_date: issueDate,
				due_date: computeDueDate(issueDate, terms, this.ctx.contract.company.country),
				billing_period_start: lines.map((line) => line.billing_period_start).sort()[0],
				billing_period_end: lines
					.map((line) => line.billing_period_end)
					.sort()
					.reverse()[0],
				lines,
				subtotal,
				tax,
				total: round2(subtotal + tax),
				amounts_invoice_currency: invoice.fx !== null && engine.fx_missing === undefined ? undefined : invoice.amounts_invoice_currency,
			});
		}

		return restored;
	}

	/**
	 * Facturas rehechas por `restoreItemBilling` (de uno o varios ítems): juntas por fecha de emisión si el contrato agrupa, fusionadas con
	 * una PE vigente del mes (F3) o creadas.
	 */
	addRestoredInvoices(invoices: PreviewInvoice[], change = 'se suma lo reactivado') {
		if (!invoices.length) return;
		const together = this.ctx.contract.group_invoices_by_period !== false;
		const byDate = new Map<string, PreviewInvoice>();
		const restored: PreviewInvoice[] = [];

		for (const invoice of [...invoices].sort((a, b) => a.issue_date.localeCompare(b.issue_date))) {
			const same = together ? byDate.get(invoice.issue_date) : undefined;

			if (!same) {
				const copy = { ...invoice, lines: [...invoice.lines] };

				byDate.set(invoice.issue_date, copy);
				restored.push(copy);
				continue;
			}
			same.lines.push(...invoice.lines);
			same.subtotal = round2(same.subtotal + invoice.subtotal);
			same.tax = round2(same.tax + invoice.tax);
			same.total = round2(same.subtotal + same.tax);
			same.billing_period_start = [same.billing_period_start, invoice.billing_period_start].sort()[0];
			same.billing_period_end = [same.billing_period_end, invoice.billing_period_end].sort().reverse()[0];
			same.amounts_invoice_currency = undefined;
		}
		const fixed = this.ctx.contract.fx_invoice_policy === 'fixed' && this.ctx.contract.requires_multicurrency_billing !== true;
		const mergeInto = restored.map((invoice) => this.mergeTarget(invoice));

		for (const [index, invoice] of restored.entries()) {
			const target = mergeInto[index];

			if (target) {
				const existing = this.ctx.invoices.find((row) => row.id === target)!;
				const before = existing.subtotal;

				existing.subtotal = round2(before + invoice.subtotal);
				this.updatedInvoices.push({
					id: existing.id,
					invoice_number: existing.invoice_number,
					issue_date: existing.issue_date,
					lines_changed: invoice.lines.length,
					subtotal_before: before,
					subtotal_after: existing.subtotal,
					change: `${change} a la factura del ${existing.issue_date}`,
				});
			} else this.createdInvoices.push(invoice);
			this.touchRsm(invoice.billing_period_start);
		}
		this.ops.push({
			kind: 'create_invoices',
			invoices: restored,
			fixed_rates: restored.map((invoice) => (fixed && invoice.fx !== null && invoice.fx !== 1 ? invoice.fx : null)),
			merge_into: mergeInto,
		});
	}

	/** ¿La Por Emitir es de ciclo propio? (todas sus líneas de ítem son de ítems con día de ciclo propio, §9.3.9). */
	isOwnCyclePending(invoice: ChangeInvoiceRow): boolean {
		const itemLines = invoice.lines.filter((line) => line.contract_item_id);

		return itemLines.length > 0 && itemLines.every((line) => this.ownCycleKeys.has(line.contract_item_id!));
	}

	/**
	 * PE activa del mismo receptor, moneda, tipo de documento y mes de emisión (S3-13); solo si el contrato agrupa juntas. Ciclo propio
	 * (§9.3.9): una factura con líneas de ciclo propio solo se funde con una PE de la **misma fecha de emisión**; una de ciclo del
	 * contrato no se funde con una PE de ciclo propio.
	 */
	mergeTarget(invoice: PreviewInvoice): string | null {
		const contract = this.ctx.contract;

		if (contract.group_invoices_by_period === false) return null;
		const ownCycle = invoice.lines.some((line) => this.ownCycleKeys.has(line.item_key));
		const candidates = this.ctx.invoices
			.filter(isEditablePending)
			.filter(
				(row) =>
					(row.client_entity_id ?? contract.client_entity_id) === contract.client_entity_id &&
					upper(row.invoice_currency) === upper(invoice.currency) &&
					(row.document_type ?? 'FACTURA') === invoice.document_type &&
					(row.issue_date ?? '').slice(0, 7) === invoice.issue_date.slice(0, 7) &&
					(row.issue_date ?? '') >= this.ctx.today &&
					(ownCycle ? row.issue_date === invoice.issue_date : !this.isOwnCyclePending(row))
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
		if (this.errors.length) throw codedValidationException(this.errors);
		this.closeInvoiceWarnings();
		const { contract, items, today } = this.ctx;
		const statusBefore = deriveContractStatus(contract.status, items, today, this.ctx.pauses);
		const statusAfterRaw = typeof this.contractSet.status === 'string' ? this.contractSet.status : contract.status;
		const statusAfter = deriveContractStatus(statusAfterRaw, this.itemsAfter, today, this.pausesAfter);
		// Fin del contrato = mayor fin de los recurrentes vivos (null con alguno indefinido); sin vivos (o cancelación) se conserva el guardado.
		const latestEnd = latestContractEnd(this.itemsAfter);
		const endAfter = this.type === 'contract_cancel' || latestEnd === undefined ? contract.contract_end_date : latestEnd;
		const touchesItems = this.added.length > 0 || this.ended.length > 0 || this.adjusted.length > 0;
		const conversion = this.conversion();

		if (touchesItems) {
			this.contractSet.total_value = totalValue(this.itemsAfter, conversion);
			if (endAfter !== contract.contract_end_date) {
				this.contractSet.contract_end_date = endAfter;
				this.bypassEndDate = true;
			}
		}
		if (Object.keys(this.contractSet).length)
			this.ops.push({ kind: 'update_contract', set: this.contractSet, bypass_end_date_guard: this.bypassEndDate });

		// §9.3.3: un ítem pausado a la fecha efectiva no suma MRR (antes con las pausas guardadas, después con las del cambio).
		const mrrBefore = contractMrr(unpausedOn(items, this.ctx.pauses, this.effective), this.effective, conversion);
		const mrrAfter = contractMrr(unpausedOn(this.itemsAfter, this.pausesAfter, this.effective), this.effective, conversion);
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
					total_value: touchesItems ? totalValue(this.itemsAfter, conversion) : num(contract.total_value),
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
				updated: this.updatedInvoices.map((entry) => ({ ...entry, detail: this.invoiceDetail(entry.id, entry.subtotal_after) })),
				created: this.createdInvoices,
				cancelled: this.cancelledInvoices.map((entry) => ({ ...entry, detail: this.invoiceDetail(entry.id, null) })),
				credit_notes: this.creditNotes.map((entry) => ({ ...entry, detail: this.creditNoteDetail(entry.mirrors_invoice_id) })),
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
			...this.extras,
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
					// Pacto aplicado desde `POST /contracts/:id/scheduled-changes/:changeId/apply` (§9.3.6).
					...(this.options.scheduled_change
						? { scheduled_change_id: this.options.scheduled_change.id, trigger: `scheduled_change:${this.options.scheduled_change.id}` }
						: {}),
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
				// D-CTR-4 (spec-revenue-y-metricas §6, Domi 01-10): la baja/ajuste se registra hoy; `start_date` es la fecha efectiva. Así el CMRR anticipa la contracción desde el booking.
				booking_date: p.ctx.today,
				auto_renew: false,
				price_id: null,
				quote_item_id: null,
			});
		}
		p.churnItem(item, itemTiming, monthly);
		p.removeItemFromInvoices(item, p.effective, label === 'contract_cancel' ? 'cancelación' : 'baja');
		totalDelta -= p.toContract(monthly, item.currency, item.start_date ?? p.effective);
	}
	p.assertNoUnified(removed, p.effective);
	// Pactos programados de los ítems que se dan de baja: `cancelled` (`item_ended`).
	cancelPactsOfEndedItems(p, removed);
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
	// Mismas sugerencias que contract_cancel, para los ítems que se quitan y sus ajustes vivos.
	const removed = ctx.items.filter((item) => refs.some((ref) => ref.item_id === item.id));

	p.extras.effective_date_suggestions = effectiveDateSuggestions(
		ctx,
		[...removed, ...removed.flatMap((item) => liveAdjustmentsOf(ctx, item, p.effective))],
		p.effective
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

/** Ítems que cancela `contract_cancel`: recurrentes vivos (no espejos de baja, sin churn ni renovación). */
const cancelTargets = (items: ChangeItemRow[]) =>
	items.filter(
		(item) => item.is_recurring !== false && !REMOVAL_CATEGORIES.has(item.categoria ?? '') && !item.churn_date && !item.renewed_by_item_id
	);

/**
 * `contract_cancel` (§9.3.1): facturas con período desde la fecha efectiva que piden decisión. **Por Emitir** (no NC, no unificada) con
 * líneas de los ítems que se cancelan desde la fecha, o emitida en/desde la fecha → `emit` | `cancel` (default `cancel`); **emitida**
 * (no anulada) con líneas de esos ítems desde la fecha → `keep` | `void` (default `void`). `amount_after_effective` = lo que `cancel`/`void`
 * quita o acredita (neto, moneda de contrato; la PE facturada por OC se cancela entera).
 */
export function cancelDecisionsRequired(ctx: ChangeContext, effective: string): InvoiceDecisionRequired[] {
	const targets = new Set(cancelTargets(ctx.items).map((item) => item.id));
	const label = (invoice: ChangeInvoiceRow) => invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`;
	const afterRatio = (line: ChangeInvoiceLineRow) => {
		const start = line.billing_period_start ?? line.billing_period_end!;

		if (start >= effective) return 1;
		const total = diffDays(start, line.billing_period_end!) + 1;

		return total > 0 ? (diffDays(effective, line.billing_period_end!) + 1) / total : 1;
	};
	const result: InvoiceDecisionRequired[] = [];

	for (const invoice of ctx.invoices) {
		const targetLines = invoice.lines.filter(
			(line) => line.contract_item_id && targets.has(line.contract_item_id) && line.billing_period_end && line.billing_period_end >= effective
		);

		if (isEditablePending(invoice)) {
			const issuedAfter = (invoice.issue_date ?? '') >= effective && invoice.lines.length > 0;

			if (!targetLines.length && !issuedAfter) continue;
			const partial = isPartialBilled(invoice);
			const amount = partial
				? invoice.subtotal
				: round2(
						invoice.lines.reduce((sum, line) => {
							if (targetLines.includes(line))
								return sum + (isConsumptionLine(line) && afterRatio(line) < 1 ? 0 : line.subtotal * afterRatio(line));

							return issuedAfter ? sum + line.subtotal : sum;
						}, 0)
					);
			const manual = invoice.lines.some((line) => line.quantity_source === 'manual');

			result.push({
				invoice_id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				status_group: 'pending',
				amount_after_effective: amount,
				options: ['emit', 'cancel'],
				default: 'cancel',
				reason_hint: `Por emitir ${label(invoice)}: ${money(amount)} corresponden a servicio desde el ${effective}${
					partial ? ' (facturada por OC: cancelarla la anula entera)' : ''
				}${manual ? ' (tiene líneas editadas a mano: entran a la misma decisión)' : ''}`,
			});
		} else if (isIssued(invoice) && targetLines.length) {
			const amount = round2(
				targetLines.reduce((sum, line) => {
					const remaining = line.subtotal > 0 ? Math.max(0, line.subtotal - num(line.previously_credited)) / line.subtotal : 1;

					return sum + line.subtotal * afterRatio(line) * remaining;
				}, 0)
			);

			if (amount <= 0) continue;
			result.push({
				invoice_id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				status_group: 'issued',
				amount_after_effective: amount,
				options: ['keep', 'void'],
				default: 'void',
				reason_hint: `Emitida ${label(invoice)}: ${money(amount)} de servicio desde el ${effective}; anular emite una NC proporcional, conservar no`,
			});
		}
	}

	return result;
}

/** `contract_cancel` (§9.3.1): fechas para ajustar la cancelación (fin del último período emitido = sin NC; fin del período en curso). */
export function cancelDateSuggestions(ctx: ChangeContext, effective: string): EffectiveDateSuggestion[] {
	return effectiveDateSuggestions(ctx, cancelTargets(ctx.items), effective);
}

/**
 * Fechas efectivas sugeridas (mismo formato y motivos que `contract_cancel`) para los ítems dados: `last_issued_period` = el día después del
 * fin del último período emitido de esos ítems (sin nota de crédito) y `current_period` = el día después del fin del período en curso. La
 * usan `contract_cancel`, `item_remove` y `pause` para que el front ofrezca "Usar <fecha>" cuando la fecha cae dentro de un período emitido.
 */
export function effectiveDateSuggestions(
	ctx: ChangeContext,
	targets: ChangeItemRow[],
	effective: string,
	action: 'end' | 'pause' = 'end'
): EffectiveDateSuggestion[] {
	const ids = new Set(targets.map((item) => item.id));
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const frontier = ctx.invoices
		.filter(isIssued)
		.flatMap((invoice) => invoice.lines)
		.filter((line) => line.contract_item_id && ids.has(line.contract_item_id))
		.map((line) => line.billing_period_end ?? '')
		.sort()
		.reverse()[0];
	const current = targets
		.filter((item) => item.start_date)
		.flatMap((item) => itemPeriods(engineShape(item), anchorOfItem(item, anchor)))
		.filter((period) => period.period_start <= ctx.today && period.period_end >= ctx.today)
		.map((period) => period.period_end)
		.sort()
		.reverse()[0];
	const suggestions: EffectiveDateSuggestion[] = [];

	if (frontier)
		suggestions.push({
			effective_date: addDays(frontier, 1),
			reason: 'last_issued_period',
			message:
				action === 'pause'
					? `Pausar desde el ${addDays(frontier, 1)} (después del último período emitido, ${frontier}): no hace falta nota de crédito`
					: `Terminar el ${frontier} (fin del último período emitido): no hace falta nota de crédito`,
		});
	if (current && !suggestions.some((entry) => entry.effective_date === addDays(current, 1)))
		suggestions.push({
			effective_date: addDays(current, 1),
			reason: 'current_period',
			message:
				action === 'pause'
					? `Pausar desde el ${addDays(current, 1)} (después del período en curso, ${current})`
					: `Terminar el ${current} (fin del período en curso)`,
		});

	return suggestions.filter((entry) => entry.effective_date !== effective);
}

export function planCancel(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'contract_cancel');

	p.assertState();
	assertReason(p);
	// §9.3.1: cada factura con período desde la fecha efectiva pide decisión (reemplaza el bloqueo `manual_lines_pending`).
	const required = cancelDecisionsRequired(ctx, req.effective_date);
	const byId = new Map(required.map((entry) => [entry.invoice_id, entry]));
	const sent = new Map<string, InvoiceDecisionAction>();

	for (const [index, decision] of (req.change.invoice_decisions ?? []).entries()) {
		const entry = byId.get(decision.invoice_id);

		if (!entry) p.error(`change.invoice_decisions.${index}.invoice_id`, 'La factura no está entre las que piden decisión para esta fecha');
		else if (!entry.options.includes(decision.action))
			p.error(
				`change.invoice_decisions.${index}.action`,
				`Para una factura ${entry.status_group === 'pending' ? 'por emitir' : 'emitida'} la decisión es ${entry.options.join(' o ')}`
			);
		else sent.set(decision.invoice_id, decision.action);
	}
	const missing = required.filter((entry) => !sent.has(entry.invoice_id));

	if (missing.length)
		p.block(
			'invoice_decision_required',
			`Decide qué hacer con ${missing.length === 1 ? 'la factura' : 'las facturas'} ${missing
				.map((entry) => entry.invoice_number ?? `del ${entry.issue_date ?? entry.invoice_id}`)
				.join(', ')} (período desde el ${req.effective_date})`,
			'Elige emitir o cancelar cada Por Emitir y conservar o anular con NC cada emitida (change.invoice_decisions)'
		);
	for (const entry of required) p.invoiceDecisions.set(entry.invoice_id, sent.get(entry.invoice_id) ?? entry.default);
	p.forceManual = true;
	const targets = cancelTargets(ctx.items);
	const { totalDelta, timing } = planItemRemove(
		p,
		targets.map((item) => item.id),
		'contract_cancel'
	);

	// PE futuras del contrato sin líneas de ítems recurrentes (no recurrentes, líneas sin ítem) también se cancelan; la facturada por OC
	// con `cancel` se cancela entera (§9.3.1); con `emit` queda completa.
	for (const invoice of ctx.invoices.filter(isEditablePending)) {
		const decision = p.invoiceDecisions.get(invoice.id);

		if (decision === 'emit') continue;
		if (decision === 'cancel' && isPartialBilled(invoice)) {
			p.ops.push({ kind: 'cancel_invoice', invoice_id: invoice.id, note: `Cancelada por cancelación del contrato desde el ${p.effective}` });
			p.cancelledInvoices.push({ id: invoice.id, invoice_number: invoice.invoice_number, issue_date: invoice.issue_date });
			continue;
		}
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
	const kept = required.filter((entry) => ['emit', 'keep'].includes(p.invoiceDecisions.get(entry.invoice_id) ?? ''));

	if (kept.length)
		p.warn(
			'billed_beyond_effective_date',
			`${kept.length === 1 ? 'La factura' : 'Las facturas'} ${kept
				.map((entry) => entry.invoice_number ?? `del ${entry.issue_date ?? entry.invoice_id}`)
				.join(', ')} ${kept.length === 1 ? 'queda' : 'quedan'} completa(s): lo de después del ${p.effective} queda facturado`
		);
	p.contractSet = {
		status: CONTRACT_CANCELLED,
		churn_date: p.effective,
		churn_reason_id: ctx.churn_reason?.id ?? null,
		churn_reason: ctx.churn_reason?.name ?? req.reason ?? null,
	};
	const decisions = required.map((entry) => ({ ...entry, action: p.invoiceDecisions.get(entry.invoice_id) ?? entry.default }));

	p.extras.invoice_decisions_required = decisions;
	p.extras.effective_date_suggestions = cancelDateSuggestions(ctx, req.effective_date);

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
		metadata: {
			timing,
			churn_reason: ctx.churn_reason?.name ?? null,
			invoice_decisions: decisions.map((entry) => ({
				invoice_id: entry.invoice_id,
				invoice_number: entry.invoice_number,
				status_group: entry.status_group,
				action: entry.action,
				defaulted: !sent.has(entry.invoice_id),
				amount_after_effective: entry.amount_after_effective,
			})),
		},
	});
}

// ------------------------------------------------------------------ pactos (contract_scheduled_changes, §9.3.6)

/** Orden de aplicación de los pactos de un mismo acto: volumen, precio fijo, porcentajes/índice y luego término y frecuencia. */
const PACT_ORDER: Array<ScheduledChangeRow['kind']> = ['quantity', 'new_unit_price', 'percent_uplift', 'index', 'term', 'billing_frequency'];

/** Redondeo del unitario resultante de un pacto (`rounding`, §3.1 de la spec de pactos). */
export const roundPactUnit = (unit: number, quantity: number, rounding: ScheduledChangeRow['rounding']): number => {
	if (rounding === 'unit_0') return Math.round(unit);
	if (rounding === 'monthly_0') return quantity > 0 ? round6(Math.round(unit * quantity) / quantity) : round6(unit);
	if (rounding === 'none') return round6(unit);

	return round2(unit);
};

/**
 * Variación (%) de un pacto `index` a una fecha: último valor publicado ≤ fecha − `index_lag_months` contra `index_base_value`, más `value`
 * puntos (Supuesto: `value` = spread sobre el índice, p. ej. IPC + 2; 0 = solo el índice). null si no hay dato (blocker `index_value_missing`).
 */
export function indexVariation(
	pact: Pick<ScheduledChangeRow, 'index_code' | 'index_base_value' | 'index_lag_months' | 'value'>,
	series: Map<string, Array<{ date: string; value: number }>> | undefined,
	date: string
): { percent: number; index_value: number; index_date: string } | null {
	const base = num(pact.index_base_value);
	const asOf = addMonths(date, -Math.max(0, num(pact.index_lag_months)));
	const point = [...(series?.get(pact.index_code ?? '') ?? [])].filter((row) => row.date <= asOf).sort((a, b) => b.date.localeCompare(a.date))[0];

	if (!point || base <= 0) return null;

	return { percent: round6((point.value / base - 1) * 100 + num(pact.value)), index_value: point.value, index_date: point.date };
}

/** Valores del ítem que un pacto mueve. */
interface PactTarget {
	quantity: number;
	unit: number;
	term: number;
	frequency: string;
}

/**
 * Aplica un pacto sobre los valores del ítem: devuelve el valor efectivamente usado (`applied_value`) o null si falta el índice (bloquea).
 * `quantity` → cantidad; `new_unit_price` → unitario (moneda del ítem); `percent_uplift` / `index` → unitario × (1 + %); `term` → meses;
 * `billing_frequency` → meses de la frecuencia (§3.2 de la spec de pactos).
 */
function applyPact(
	p: Planner,
	pact: ScheduledChangeRow,
	target: PactTarget,
	date: string,
	override: number | null,
	locks: { term: boolean; frequency: boolean }
): number | null {
	const value = override ?? num(pact.value);

	switch (pact.kind) {
		case 'quantity':
			target.quantity = value;

			return value;
		case 'new_unit_price':
			target.unit = roundPactUnit(value, target.quantity, pact.rounding);

			return value;
		case 'percent_uplift':
			target.unit = roundPactUnit(target.unit * (1 + value / 100), target.quantity, pact.rounding);

			return value;
		case 'index': {
			const variation = override !== null ? { percent: override } : indexVariation(pact, p.ctx.index_series, date);

			if (!variation) {
				p.block(
					'index_value_missing',
					`No hay valor publicado del índice ${pact.index_code ?? ''} para aplicar el reajuste al ${date}`.replace(/\s+/g, ' '),
					'Espera la publicación del índice o aplica el pacto con un valor (value) explícito'
				);

				return null;
			}
			target.unit = roundPactUnit(target.unit * (1 + variation.percent / 100), target.quantity, pact.rounding);

			return variation.percent;
		}
		case 'term':
			if (!locks.term) target.term = Math.max(1, Math.round(value));

			return value;
		case 'billing_frequency': {
			const frequency = frequencyOfMonths(value);

			if (!frequency) {
				p.error(
					`scheduled_changes.${pact.id}`,
					`El pacto de frecuencia vale ${value} meses: no corresponde a una frecuencia (1, 3, 6, 12 o 24)`
				);

				return null;
			}
			if (!locks.frequency) target.frequency = frequency;

			return value;
		}
	}
}

/** Pactos `scheduled` de un disparo que alcanzan a un ítem (los suyos y los de alcance contrato), en orden de aplicación. */
export const pactsFor = (ctx: ChangeContext, itemId: string, trigger: ScheduledChangeRow['trigger']) =>
	(ctx.scheduled_changes ?? [])
		.filter((row) => row.status === 'scheduled' && row.trigger === trigger && (row.contract_item_id === itemId || row.contract_item_id === null))
		.sort((a, b) => PACT_ORDER.indexOf(a.kind) - PACT_ORDER.indexOf(b.kind));

/** Pactos `scheduled` de los ítems que se dan de baja → `cancelled` con `status_reason = item_ended` (spec de pactos §3.3). */
function cancelPactsOfEndedItems(p: Planner, itemIds: Set<string>) {
	for (const pact of p.ctx.scheduled_changes ?? []) {
		if (pact.status !== 'scheduled' || !pact.contract_item_id || !itemIds.has(pact.contract_item_id)) continue;
		p.ops.push({ kind: 'update_scheduled_change', id: pact.id, set: { status: 'cancelled', status_reason: 'item_ended' } });
	}
}

// ------------------------------------------------------------------ renovación (§9.3.4)

/**
 * Tasas "de todo el contrato" (`isWholeContractRate`, una sola fila por propósito y par que cubre el rango de los ítems) que la renovación
 * extiende al nuevo fin (op `extend_fx_rates`, aviso `fx_rate_extended` por par y propósito). No se extienden las de un par para el que el
 * pedido trae tasa nueva. Las extendidas entran al generador del preview (`extraInvoiceRates` / `extraItemRates`).
 */
function extendWholeContractRates(p: Planner, newEnd: string, sentPairs: Set<string>) {
	const { ctx } = p;
	const rows = ctx.contract.fx_rates ?? [];
	const starts = ctx.items.map((item) => item.start_date).filter((date): date is string => Boolean(date));

	if (!rows.length || !starts.length) return;
	const coverage = {
		start: starts.sort()[0],
		end: ctx.items
			.filter((item) => item.start_date)
			.map((item) => item.end_date ?? addMonths(item.start_date!, 12))
			.sort()
			.reverse()[0],
	};
	const groups = new Map<string, ContractFxRateRow[]>();

	for (const row of rows) {
		const key = `${row.purpose}|${upperCode(row.from_currency)}|${upperCode(row.to_currency)}`;

		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	const extended: NonNullable<ChangePreview['fx_rates_extended']> = [];

	for (const [key, group] of groups) {
		if (group.length !== 1 || sentPairs.has(key)) continue;
		const [row] = group;
		const periodEnd = String(row.period_end).slice(0, 10);

		if (!isWholeContractRate({ period_start: String(row.period_start), period_end: periodEnd }, coverage) || periodEnd >= newEnd) continue;
		extended.push({
			id: row.id,
			purpose: row.purpose,
			from_currency: upperCode(row.from_currency),
			to_currency: upperCode(row.to_currency),
			period_end_before: periodEnd,
			period_end_after: newEnd,
		});
		const copy: FxPeriodRate = { ...row, period_end: newEnd, created_at: '9999' };

		if (row.purpose === 'invoice') p.extraInvoiceRates.push(copy);
		if (row.purpose === 'item') p.extraItemRates.push(copy);
		p.warn(
			'fx_rate_extended',
			`La tasa ${row.purpose === 'item' ? 'pactada (métricas)' : row.purpose === 'invoice' ? 'de facturación' : 'de la compañía'} ${upperCode(
				row.from_currency
			)} → ${upperCode(row.to_currency)} (${num(row.rate)}) cubría todo el contrato: se extiende hasta el ${newEnd}`
		);
	}
	if (extended.length) {
		p.ops.push({ kind: 'extend_fx_rates', rates: extended.map((entry) => ({ id: entry.id, period_end: entry.period_end_after })) });
		p.extras.fx_rates_extended = extended;
	}
}

/** Pares (`propósito|from|to`) con tasa nueva en el pedido (`fx_invoice_rates` / `fx_item_rates`): no se extienden. */
const sentRatePairs = (p: Planner, contractCurrency: string, invoiceCurrency: string, currencies: string[]) => {
	const pairs = new Set<string>();
	const foreign = [...new Set(currencies)].filter((code) => code !== invoiceCurrency);

	for (const rate of p.req.change.fx_invoice_rates ?? [])
		pairs.add(`invoice|${upperCode(rate.from_currency) || (foreign.length === 1 ? foreign[0] : contractCurrency)}|${invoiceCurrency}`);
	for (const rate of p.req.change.fx_item_rates ?? []) pairs.add(`item|${upperCode(rate.from_currency)}|${contractCurrency}`);

	return pairs;
};

export function planRenewal(ctx: ChangeContext, req: ContractChangeRequestDto, options: PlanOptions = {}): ChangePlan {
	const p = new Planner(ctx, req, 'renewal', options);
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const engineItems: NewItemRow[] = [];
	const renewed: Array<{ item_id: string; key: string; absorbed: string[]; adjustment: string | null }> = [];
	const decisions = new Map((req.change.scheduled_change_decisions ?? []).map((decision) => [decision.scheduled_change_id, decision]));
	const appliedPacts: NonNullable<ChangePreview['scheduled_changes']>['applied'] = [];
	const skippedPacts: NonNullable<ChangePreview['scheduled_changes']>['skipped'] = [];
	const createdPacts: NonNullable<ChangePreview['scheduled_changes']>['created'] = [];
	const pactOps = new Set<string>();
	const contractCurrency = upperCode(ctx.contract.contract_currency);
	const invoiceCurrency = upperCode(ctx.contract.invoice_currency) || contractCurrency;
	let mrrDelta = 0;
	let groupCounter = 0;

	p.assertState();
	// Confirmar una propuesta del job `contracts-auto-renewal` (§9.3.5): debe ser del contrato y seguir abierta.
	if (req.origin?.type === 'renewal_proposal') {
		const proposal = ctx.renewal_proposal;

		if (!proposal) p.error('origin.event_id', 'La propuesta de renovación no existe en este contrato');
		else if (proposal.status !== 'open')
			p.block(
				'renewal_proposal_not_open',
				`La propuesta de renovación ya está ${proposal.status === 'confirmed' ? 'confirmada' : 'omitida'}: no se vuelve a confirmar`,
				'Revisa el historial del contrato'
			);
	}
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a renovar');
	if (req.change.catch_up === 'current_month') {
		p.error('change.catch_up', 'El catch-up en el mes actual todavía no está construido en el devengo: usa backdate (corregir hacia atrás)');
	}
	for (const [index, decision] of (req.change.scheduled_change_decisions ?? []).entries()) {
		const pact = (ctx.scheduled_changes ?? []).find((row) => row.id === decision.scheduled_change_id);

		if (!pact || pact.trigger !== 'on_renewal' || pact.status !== 'scheduled')
			p.error(
				`change.scheduled_change_decisions.${index}.scheduled_change_id`,
				'El pacto no existe, no es de renovación o ya no está programado'
			);
		if (decision.action === 'skip' && !decision.reason?.trim())
			p.error(`change.scheduled_change_decisions.${index}.reason`, 'Escribe el motivo para omitir el pacto');
	}
	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const item = p.findItem(String(ref.item_id ?? ''), `${field}.item_id`);

		if (!item) continue;
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
		const termLocked = ref.term_months !== undefined && ref.term_months !== null;
		let term = Number(ref.term_months ?? item.term_months) || 1;
		let endLocked = false;

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
			endLocked = true;
		}
		p.assertOpenPeriod(start, `El inicio de la renovación de "${item.product_name}"`);
		if (start < p.effective)
			p.warn(
				'retroactive_renewal',
				`"${item.product_name}" venció el ${item.end_date}: la renovación parte el ${start} y el devengo se corrige hacia atrás`
			);
		// Los ajustes vivos del ítem madre que llegan a su fin se absorben: la renovación parte del valor vigente (S3-15 "valor anterior").
		// D3/MF-h: un ajuste que termina DESPUÉS del madre también se absorbe y se corta al fin del madre (sin doble cobro desde la
		// renovación); uno que termina ANTES no se absorbe y se avisa (`adjustment_not_absorbed`) con su fin, en vez de ignorarlo en silencio.
		const adjustments = ctx.items.filter(
			(row) =>
				row.related_item_id === item.id &&
				DELTA_CATEGORIES.has(row.categoria ?? '') &&
				!row.churn_date &&
				!row.renewed_by_item_id &&
				row.is_recurring !== false
		);
		const children = adjustments.filter((row) => !row.end_date || row.end_date >= item.end_date!);
		const notAbsorbed = adjustments.filter((row) => row.end_date && row.end_date < item.end_date!);

		if (notAbsorbed.length)
			p.warn(
				'adjustment_not_absorbed',
				`La renovación de "${item.product_name}" no absorbe ${notAbsorbed.length} ajuste(s) que terminan antes que el ítem (${item.end_date}): ${notAbsorbed
					.map(
						(row) =>
							`${row.categoria} ${num(row.quantity)} × ${money(num(row.unit_price ?? num(row.annual_unit_price) / 12))} hasta el ${row.end_date}`
					)
					.join('; ')}. La renovación parte sin ellos`
			);
		for (const child of children) {
			if (child.end_date === item.end_date) continue;
			// Ajuste que sobrevive al madre (o sin fin): se corta al fin del madre; lo que facturaba desde la renovación lo cubre el RENEWAL.
			const after = p.itemsAfter.find((row) => row.id === child.id)!;

			p.ops.push({ kind: 'update_item', item_id: child.id, set: { end_date: item.end_date } });
			after.end_date = item.end_date;
			p.touchRsm(start);
			p.removeItemFromInvoices(after, start, 'renovación');
		}
		const group = buildItemGroups([item, ...children], item.end_date)[0];
		const quantity = group?.quantity ?? num(item.quantity);
		const mrr = group?.mrr ?? itemMonthly(item);
		const pct = item.discount_type === 'Porcentaje' ? num(item.discount_value) : 0;
		const unit = children.length ? round6(mrr / (quantity * (1 - pct / 100))) : num(item.unit_price ?? num(item.annual_unit_price) / 12);
		const key = p.newKey();
		const annual = item.price_entry_mode === 'annual';

		if (children.length)
			p.warn(
				'adjustments_absorbed',
				`La renovación de "${item.product_name}" absorbe ${children.length} ajuste(s) vigente(s): parte de ${quantity} × ${money(unit)}`
			);
		// Pactos `on_renewal` del ítem (y los de alcance contrato): se aplican en el mismo acto salvo que la usuaria los omita con motivo.
		const target: PactTarget = {
			quantity,
			unit,
			term,
			frequency: String(ref.billing_frequency ?? item.billing_frequency ?? 'Mensual'),
		};

		for (const pact of pactsFor(ctx, item.id, 'on_renewal')) {
			const decision = decisions.get(pact.id);

			if (decision?.action === 'skip') {
				if (!pactOps.has(pact.id)) {
					p.ops.push({ kind: 'update_scheduled_change', id: pact.id, set: { status: 'skipped', status_reason: decision.reason ?? null } });
					skippedPacts.push({ id: pact.id, kind: pact.kind, item_id: pact.contract_item_id, reason: decision.reason ?? '' });
					pactOps.add(pact.id);
				}
				continue;
			}
			const override = decision?.value ?? (options.scheduled_change?.id === pact.id ? options.scheduled_change.value : null) ?? null;
			const used = applyPact(p, pact, target, start, override, {
				term: termLocked || endLocked,
				frequency: ref.billing_frequency !== undefined,
			});

			if (used === null) continue;
			if (!pactOps.has(pact.id)) {
				p.ops.push({ kind: 'update_scheduled_change', id: pact.id, set: { status: 'applied', applied_value: used } });
				appliedPacts.push({
					id: pact.id,
					kind: pact.kind,
					item_id: pact.contract_item_id,
					value: num(pact.value),
					applied_value: used,
					trigger: pact.trigger,
				});
				pactOps.add(pact.id);
			}
		}
		term = target.term;
		// Valores pedidos explícitamente (precio libre): pisan a los pactos y quedan como pacto `on_renewal` `applied` (trazable).
		const groupKey = `group:${++groupCounter}`;
		const explicit: Array<{ kind: 'quantity' | 'new_unit_price'; value: number }> = [];

		if (ref.quantity !== undefined && ref.quantity !== null && Math.abs(num(ref.quantity) - target.quantity) > 1e-9) {
			target.quantity = num(ref.quantity);
			explicit.push({ kind: 'quantity', value: target.quantity });
		}
		if (ref.unit_price !== undefined && ref.unit_price !== null) {
			const requested = ref.price_entry_mode === 'annual' ? round6(num(ref.unit_price) / 12) : num(ref.unit_price);

			if (Math.abs(requested - target.unit) > 1e-6) {
				target.unit = requested;
				explicit.push({ kind: 'new_unit_price', value: requested });
			}
		}
		const pctNew = ref.discount_value !== undefined && ref.discount_value !== null ? num(ref.discount_value) : pct;
		const end = itemEndDate(start, term);
		const price = round2(unit * quantity * term);
		const renewalRow: NewItemRow = {
			key,
			product_id: item.product_id,
			product_name: item.product_name ?? 'Producto',
			account: item.account,
			item_type: item.item_type,
			unit_of_measure: item.unit_of_measure,
			categoria: 'RENEWAL',
			quantity,
			unit_price: annual ? null : unit,
			annual_unit_price: round6(unit * 12),
			price_entry_mode: annual ? 'annual' : 'monthly',
			discount_type: pct > 0 ? 'Porcentaje' : null,
			discount_value: pct,
			price,
			final_price: round2(price * (1 - pct / 100)),
			currency: item.currency ?? ctx.contract.contract_currency,
			billing_frequency: target.frequency,
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
			billing_anchor_day: validAnchorDay(item.billing_anchor_day),
		};

		p.insertItem(renewalRow);
		// S3-15 (§9.3.4): precio o cantidad nuevos = RENEWAL al valor vigente + ítem de ajuste (fórmula unificada de item_change).
		const delta = unifiedDelta({
			current_quantity: quantity,
			current_mrr: round2(unit * quantity * (1 - pct / 100)),
			new_quantity: target.quantity,
			new_unit_price: target.unit,
			discount_pct: pctNew,
		});
		let adjustmentKey: string | null = null;

		if (delta && delta.monthly_new <= 0) {
			p.error(`${field}.quantity`, 'El mensual renovado debe ser mayor que 0; para no renovar usa item_remove');
			continue;
		}
		if (delta) {
			adjustmentKey = p.newKey();
			p.insertItem({
				...renewalRow,
				key: adjustmentKey,
				categoria: delta.categoria,
				quantity: delta.quantity,
				unit_price: delta.unit_price,
				annual_unit_price: round6(delta.unit_price * 12),
				price_entry_mode: 'monthly',
				discount_type: null,
				discount_value: 0,
				price: round2(delta.mrr_delta * term),
				final_price: round2(delta.mrr_delta * term),
				related_item_id: key,
				renews_item_id: null,
				auto_renew: false,
				price_id: null,
			});
			mrrDelta += p.toContract(delta.mrr_delta, item.currency, start);
		}
		for (const entry of explicit) {
			p.ops.push({
				kind: 'insert_scheduled_change',
				row: {
					contract_item_ref: item.id,
					group_key: explicit.length > 1 ? groupKey : null,
					parent_id: null,
					trigger: 'on_renewal',
					effective_date: start,
					kind: entry.kind,
					value: entry.value,
					status: 'applied',
					status_reason: null,
					applied_value: entry.value,
					origin: { type: 'renewal', ...(req.origin ?? { type: 'manual' }) },
					notes: req.reason ?? null,
				},
			});
			createdPacts.push({ kind: entry.kind, item_id: item.id, value: entry.value, trigger: 'on_renewal', status: 'applied' });
		}
		// Facturas: una línea neta por período al valor renovado (como la línea neta de S3-14), ligada al RENEWAL.
		const monthlyNet = delta ? delta.monthly_new : round2(unit * quantity * (1 - pct / 100));

		engineItems.push({
			...renewalRow,
			quantity: delta ? target.quantity : quantity,
			unit_price: delta ? target.unit : unit,
			discount_type: (delta ? pctNew : pct) > 0 ? 'Porcentaje' : null,
			discount_value: delta ? pctNew : pct,
			final_price: round2(monthlyNet * term),
		});
		renewed.push({ item_id: item.id, key, absorbed: children.map((child) => child.id), adjustment: adjustmentKey });
	}
	for (const entry of renewed) {
		for (const itemId of [entry.item_id, ...entry.absorbed]) {
			p.ops.push({ kind: 'update_item', item_id: itemId, set: { renewed_by_key: entry.key } });
			const after = p.itemsAfter.find((row) => row.id === itemId)!;

			after.renewed_by_item_id = entry.key;
			p.adjusted.push({ ...previewOf(after), renews_item_id: null });
		}
	}
	// FX (§9.3.4): tasas nuevas del pedido (multimoneda por par) y extensión de las de todo el contrato al nuevo fin.
	const currencies = renewed.map((entry) => upperCode(ctx.items.find((item) => item.id === entry.item_id)?.currency) || contractCurrency);

	addChangeRates(p, contractCurrency, invoiceCurrency, currencies);
	const newEnd = engineItems
		.map((item) => item.end_date)
		.sort()
		.reverse()[0];

	if (newEnd) extendWholeContractRates(p, newEnd, sentRatePairs(p, contractCurrency, invoiceCurrency, currencies));
	p.addGeneratedInvoices(engineItems, 'cycle');
	p.closeHeaders('Renovación');
	p.mrrDelta = round2(mrrDelta);
	if (appliedPacts.length || skippedPacts.length || createdPacts.length)
		p.extras.scheduled_changes = { applied: appliedPacts, skipped: skippedPacts, created: createdPacts };
	const names = engineItems.map((item) => item.product_name);
	const withPrice = renewed.some((entry) => entry.adjustment);

	return p.finish({
		type: 'RENEWAL',
		subtype: withPrice ? 'price_change' : null,
		title: `Renovación de ${engineItems.length} ítem(s)`,
		description: `Se renovó ${names.join(', ')} ${withPrice ? `con valor nuevo (MRR ${mrrDelta >= 0 ? '+' : ''}${money(mrrDelta)})` : 'al mismo precio'}${
			engineItems[0] ? ` desde el ${engineItems.map((item) => item.start_date).sort()[0]}` : ''
		}`,
		amount_delta: round2(mrrDelta),
		items_affected: renewed.flatMap((entry) => [entry.item_id, ...entry.absorbed]),
		metadata: {
			renewals: renewed.map((entry) => ({
				item_id: entry.item_id,
				renewed_by: entry.key,
				absorbed: entry.absorbed,
				adjustment: entry.adjustment,
			})),
			catch_up: req.change.catch_up ?? 'backdate',
			scheduled_changes: {
				applied: appliedPacts.map((pact) => pact.id),
				skipped: skippedPacts.map((pact) => pact.id),
				created: createdPacts.length,
			},
			fx_rates_extended: p.extras.fx_rates_extended ?? [],
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
			'Esta cotización es de nuevo negocio (cliente nuevo) y no se suma a un contrato existente',
			'Si es un producto nuevo para este cliente, cámbiala a Cross-sell; si amplía uno que ya tiene, a Upsell'
		);
	}
}

/**
 * Aviso `possible_duplicate`: ya hay un ítem del mismo producto y cuenta que parte el mismo día (sin contar espejos de baja ni el propio
 * ítem). Lo usan `item_add` y `item_update` (cambio de cuenta).
 */
function warnPossibleDuplicate(
	p: Planner,
	items: ChangeItemRow[],
	target: { id?: string; product_id: string | null; product_name: string | null; account: string | null; start_date: string | null }
) {
	const account = target.account ?? '';
	const duplicate = items.find(
		(item) =>
			item.id !== target.id &&
			item.product_id === target.product_id &&
			(item.account ?? '').trim() === account &&
			item.start_date === target.start_date &&
			!REMOVAL_CATEGORIES.has(item.categoria ?? '')
	);

	if (duplicate)
		p.warn(
			'possible_duplicate',
			`Ya hay un ítem "${target.product_name}"${account ? ` cuenta ${account}` : ''} que parte el ${target.start_date}: revisa que no sea un duplicado`
		);
}

/** `item_add` desde cotización: completa el ítem del pedido con los valores del ítem cotizado (lo pedido explícitamente manda). */
export function withQuoteDefaults(ref: Record<string, unknown>, quote: QuoteItemRow, effective: string): Record<string, unknown> {
	const has = (key: string) => ref[key] !== undefined && ref[key] !== null;
	const annual = quote.price_entry_mode === 'annual';
	const usesQuotePrice = !has('unit_price') && !has('price') && !has('price_id');

	return {
		...ref,
		product_id: has('product_id') ? ref.product_id : quote.product_id,
		quantity: has('quantity') ? ref.quantity : quote.quantity,
		...(usesQuotePrice && !quote.price_spec
			? { unit_price: annual ? quote.annual_unit_price : quote.unit_price, price_entry_mode: annual ? 'annual' : 'monthly' }
			: {}),
		discount_value: has('discount_value') ? ref.discount_value : quote.discount_value,
		billing_frequency: has('billing_frequency') ? ref.billing_frequency : (quote.billing_frequency ?? undefined),
		billing_method: has('billing_method') ? ref.billing_method : (quote.billing_method ?? undefined),
		// S3-4: fecha efectiva por defecto = inicio del ítem cotizado (si no es anterior a la fecha efectiva).
		start_date: has('start_date') ? ref.start_date : quote.start_date && quote.start_date >= effective ? quote.start_date : undefined,
		account: has('account') ? ref.account : (quote.account ?? undefined),
		item_type: has('item_type') ? ref.item_type : (quote.item_type ?? undefined),
		unit_of_measure: has('unit_of_measure') ? ref.unit_of_measure : (quote.unit_of_measure ?? undefined),
		is_recurring: has('is_recurring') ? ref.is_recurring : quote.is_recurring,
		currency: has('currency') ? ref.currency : (quote.currency ?? undefined),
	};
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
	const contractCurrency = upperCode(ctx.contract.contract_currency);
	const invoiceCurrency = upperCode(ctx.contract.invoice_currency) || contractCurrency;
	const multicurrencyBefore = ctx.contract.requires_multicurrency_billing === true;
	const enableMulticurrency = req.change.enable_multicurrency === true && !multicurrencyBefore;

	// Multimoneda (spec §6): `enable_multicurrency` enciende el flag en la misma transacción (antes de insertar los ítems).
	if (enableMulticurrency) {
		p.multicurrencyAfter = true;
		p.ops.push({ kind: 'set_multicurrency', enabled: true });
	}
	addChangeRates(p, contractCurrency, invoiceCurrency);
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const firstLive = liveRecurring(ctx.items).sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))[0] ?? ctx.items[0];

	for (const [index, rawRef] of refs.entries()) {
		const field = `change.items.${index}`;
		// Desde cotización (`quote_item_id`): lo que el pedido no trae sale del ítem cotizado (producto, cantidad, precio o modelo, descuento,
		// frecuencia, método, inicio, cuenta); el ítem nuevo queda con `quote_item_id`.
		const quoteItem = quoteItemOf(p, rawRef, field);
		const ref = quoteItem ? withQuoteDefaults(rawRef, quoteItem, p.effective) : rawRef;
		const productId = String(ref.product_id ?? '');
		const productName =
			ctx.products.get(productId) ?? (quoteItem && quoteItem.product_id === productId ? (quoteItem.product_name ?? undefined) : undefined);

		if (!productName) {
			p.error(`${field}.product_id`, 'El producto no existe en el catálogo del holding');
			continue;
		}
		const isRecurring = ref.is_recurring !== false;
		const start = typeof ref.start_date === 'string' ? ref.start_date : p.effective;
		// §9.3.9: ciclo propio = día de su inicio (sin tramo prorrateado); si no, el del contrato.
		const ownAnchor = ref.billing_cycle === 'own' && isRecurring ? Number(start.slice(8, 10)) : null;
		// Multimoneda: la moneda del ítem es la pedida; desde cotización, la de la cotización (cierra U10); si no, la del contrato.
		const quoteCurrency = req.origin?.type === 'quote' ? upperCode(ctx.quote?.currency) : '';
		const currency = upperCode(ref.currency) || quoteCurrency || contractCurrency;

		if (currency !== contractCurrency && !p.multicurrency) {
			p.block(
				MULTICURRENCY_CODES.multicurrency_not_enabled,
				`"${productName}" está en ${currency} y el contrato en ${contractCurrency}: el contrato no factura ítems en distintas monedas`,
				MULTICURRENCY_NOT_ENABLED_STEP
			);
		}

		if (start < p.effective) {
			p.error(`${field}.start_date`, `El ítem no puede partir antes de la fecha efectiva (${p.effective})`);
			continue;
		}
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
		// Co-terminación (D-B): el fin del contrato que rige (mayor fin de los recurrentes vigentes que siguen después del inicio, la misma
		// regla de `contract_end_date`, sobre los que tienen fin: un ítem indefinido no aporta fin del que heredar).
		const contractEnd = contractEndOf(ctx.items.filter((item) => Boolean(item.end_date) && item.end_date! >= start));
		// D3 / MF-h: el ajuste de un producto existente termina con su ítem relacionado (`related_item_id`), no con el contrato, salvo
		// que el pedido traiga `end_date` o `term_months`. Si el relacionado termina después del fin que rige, ese fin es el tope.
		const relatedEnd =
			isRecurring && related && related.is_recurring !== false && related.end_date && related.end_date >= start ? related.end_date : null;
		const capEnd = relatedEnd && (!contractEnd || relatedEnd > contractEnd) ? relatedEnd : contractEnd;
		const termInput = ref.term_months !== undefined && ref.term_months !== null ? Number(ref.term_months) : null;
		let end: string;

		if (termInput !== null && (!Number.isInteger(termInput) || termInput < 1 || termInput > 120)) {
			p.error(`${field}.term_months`, 'El plazo debe ser un entero de meses entre 1 y 120');
			continue;
		}
		if (isRecurring) {
			const explicitEnd = typeof ref.end_date === 'string' ? ref.end_date : termInput !== null ? itemEndDate(start, termInput) : null;

			if (!explicitEnd && !relatedEnd && !contractEnd) {
				p.error(`${field}.end_date`, 'Indica la fecha de fin: el contrato no tiene ítems recurrentes vigentes de los que heredarla');
				continue;
			}
			end = explicitEnd ?? relatedEnd ?? contractEnd!;
			if (capEnd && end > capEnd) {
				p.warn(
					'term_exceeds_contract_capped',
					`"${productName}" terminaría el ${end}, después del contrato (${capEnd}): se acota al fin del contrato (D-B). Para extender, renueva`
				);
				end = capEnd;
			}
		} else end = typeof ref.end_date === 'string' ? ref.end_date : start;
		if (end < start) {
			p.error(`${field}.end_date`, `El fin (${end}) es anterior al inicio (${start})`);
			continue;
		}
		p.assertOpenPeriod(start, `El inicio de "${productName}"`);
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

		// Ítem cotizado con modelo de precio y sin precio en el pedido: se copia su modelo (como al crear desde cotización).
		if (!priceSpec && !catalogId && quoteItem?.price_spec && (rawRef.unit_price === undefined || rawRef.unit_price === null))
			priceSpec = normalizePriceSpec(quoteItem.price_spec);
		let priceInvalid = false;

		if (catalogId) {
			const catalogErrors = catalogPriceErrors({
				field,
				catalog,
				inline: Boolean(priceSpec),
				product_id: productId,
				// Multimoneda: el precio de catálogo debe estar en la moneda del ítem (400 price_currency_mismatch).
				contract_currency: currency,
			});

			for (const error of catalogErrors) p.error(error.field, error.message, error.code);
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
		const months = isRecurring ? monthsBetween(start, end, ownAnchor ?? anchor) : term;
		const price = round2(unit * quantity * months);
		warnPossibleDuplicate(p, ctx.items, { product_id: productId, product_name: productName, account, start_date: start });
		categories.add(categoria);
		// ΔMRR en moneda de contrato (multimoneda: con la tasa pactada ítem → contrato del par, spec §5).
		mrrDelta += isRecurring
			? currency === contractCurrency
				? round2(unit * quantity * (1 - pct / 100))
				: toContractCurrency(
						unit * quantity * (1 - pct / 100),
						currency,
						contractCurrency,
						[...(ctx.contract.fx_item_rates ?? []), ...p.extraItemRates],
						start
					)
			: 0;
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
			currency,
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
			quote_item_id: quoteItem?.id ?? null,
			price_spec: priceSpec,
			list_price_id: catalog?.id ?? null,
			price_name: catalog?.name ?? null,
			billing_anchor_day: ownAnchor,
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
		metadata: {
			first_period_invoice: req.change.first_period_invoice ?? 'cycle',
			own_cycle_items: newItems.filter((item) => item.billing_anchor_day).map((item) => item.key),
			quote_items: newItems.map((item) => item.quote_item_id).filter(Boolean),
			// Multimoneda: monedas de los ítems nuevos, tasas agregadas y si el alta encendió el flag.
			...(p.multicurrency
				? {
						currencies: [...new Set(newItems.map((item) => upperCode(item.currency)))],
						fx_item_rates_added: p.extraItemRates.length,
						fx_invoice_rates_added: p.extraInvoiceRates.length,
						multicurrency_enabled: enableMulticurrency,
					}
				: {}),
		},
	});
}

/**
 * Multimoneda en `item_add` (spec §6): `fx_item_rates[]` (pactadas ítem → contrato) y `fx_invoice_rates[]` (moneda del ítem → factura) del
 * pedido se agregan a las guardadas (`insert_fx_rates`) y el generador del preview ya las usa. Sin fechas = desde la fecha efectiva sin fin.
 */
function addChangeRates(p: Planner, contractCurrency: string, invoiceCurrency: string, itemCurrencies?: string[]) {
	const change = p.req.change;
	const itemRates = (change.fx_item_rates ?? []).map((rate, index) => {
		const from = upperCode(rate.from_currency);

		if (!p.multicurrency)
			p.error(
				`change.fx_item_rates.${index}`,
				'Las tasas ítem → contrato solo aplican a contratos multimoneda',
				MULTICURRENCY_CODES.multicurrency_not_enabled
			);
		if (!from || from === contractCurrency)
			p.error(`change.fx_item_rates.${index}.from_currency`, `La tasa ítem → contrato es de una moneda distinta de ${contractCurrency}`);

		return {
			purpose: 'item' as const,
			from_currency: from,
			to_currency: contractCurrency,
			rate: Number(rate.rate),
			period_start: rate.period_start ?? p.effective,
			period_end: rate.period_end ?? '9999-12-31',
		};
	});
	const foreign = [
		...new Set(
			(
				itemCurrencies ??
				((change.items ?? []) as Array<Record<string, unknown>>).map(
					(item) => upperCode(item.currency) || (p.req.origin?.type === 'quote' ? upperCode(p.ctx.quote?.currency) : '') || contractCurrency
				)
			).filter((code) => code !== invoiceCurrency)
		),
	];
	const invoiceRates = (change.fx_invoice_rates ?? []).map((rate, index) => {
		const from = upperCode(rate.from_currency) || (foreign.length === 1 ? foreign[0] : '');

		if (!from) p.error(`change.fx_invoice_rates.${index}.from_currency`, 'Indica de qué moneda es la tasa (hay más de un par)');
		else if (from === invoiceCurrency)
			p.error(`change.fx_invoice_rates.${index}.from_currency`, `Se factura en ${invoiceCurrency}: esa moneda no lleva tasa de facturación`);

		return {
			purpose: 'invoice' as const,
			from_currency: from,
			to_currency: invoiceCurrency,
			rate: Number(rate.rate),
			period_start: rate.period_start ?? p.effective,
			period_end: rate.period_end ?? '9999-12-31',
		};
	});

	if (invoiceRates.length && p.ctx.contract.fx_invoice_policy !== 'fixed')
		p.error('change.fx_invoice_rates', 'El contrato factura con tipo de cambio del día: cambia la política en Condiciones de facturación');
	const rates = [...itemRates, ...invoiceRates];

	if (rates.length) p.ops.push({ kind: 'insert_fx_rates', rates });
	p.extraItemRates.push(...itemRates.map((rate) => ({ ...rate, created_at: '9999' })));
	p.extraInvoiceRates.push(...invoiceRates.map((rate) => ({ ...rate, created_at: '9999' })));
}

/**
 * `multicurrency { enabled }` (spec-multimoneda §6): enciende o apaga `requires_multicurrency_billing`. Encender no toca ítems, facturas ni
 * RSM (evento `MULTICURRENCY_ENABLED`). Apagar con algún ítem —vivo o histórico— en otra moneda que la del contrato se bloquea
 * (`foreign_currency_items_present`; el validador de contratos también lo rechaza); sin ellos, evento `MULTICURRENCY_DISABLED`.
 */
export function planMulticurrency(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'multicurrency');
	const enabled = req.change.enabled;
	const current = ctx.contract.requires_multicurrency_billing === true;
	const contractCurrency = upperCode(ctx.contract.contract_currency);

	p.assertState();
	if (typeof enabled !== 'boolean') p.error('change.enabled', 'Indica si se activa (true) o se desactiva (false) la facturación multimoneda');
	else if (enabled === current)
		p.error('change.enabled', current ? 'El contrato ya factura ítems en distintas monedas' : 'El contrato ya factura todo en su moneda');
	if (enabled === false) {
		const foreign = ctx.items.filter((item) => (upperCode(item.currency) || contractCurrency) !== contractCurrency);

		if (foreign.length)
			p.block(
				MULTICURRENCY_CODES.foreign_currency_items_present,
				`No se puede desactivar multimoneda: ${foreign.length === 1 ? 'el ítem' : 'los ítems'} ${foreign
					.map((item) => `"${item.product_name ?? item.id}" (${upperCode(item.currency)})`)
					.join(', ')} ${foreign.length === 1 ? 'está' : 'están'} en otra moneda que la del contrato (${contractCurrency})`,
				'Los ítems en otra moneda (vigentes o históricos) mantienen el contrato multimoneda'
			);
	}
	if (typeof enabled === 'boolean' && enabled !== current) {
		p.multicurrencyAfter = enabled;
		p.ops.push({ kind: 'set_multicurrency', enabled });
	}

	return p.finish({
		type: enabled ? 'MULTICURRENCY_ENABLED' : 'MULTICURRENCY_DISABLED',
		subtype: null,
		title: enabled ? 'Multimoneda activada' : 'Multimoneda desactivada',
		description: enabled
			? `${ctx.contract.contract_number ?? 'El contrato'} puede facturar ítems en distintas monedas desde el ${p.effective}`
			: `${ctx.contract.contract_number ?? 'El contrato'} vuelve a facturar todo en ${contractCurrency} desde el ${p.effective}`,
		amount_delta: 0,
		items_affected: [],
		metadata: { requires_multicurrency_billing: { before: current, after: enabled === true } },
	});
}

/**
 * Pacto materializado por `…/scheduled-changes/:changeId/apply` (§9.3.6): `on_date` → la fila pasa a `applied` con el valor usado;
 * `every_n_months` → nace una hija `applied` (`parent_id`) y la madre avanza `next_effective_date` un intervalo. El evento se liga al
 * escribir (`applied_event_id`). `on_renewal` lo registra `planRenewal` en su ciclo de pactos.
 */
function recordPactApplication(p: Planner) {
	const pact = p.options.scheduled_change;

	if (!pact || pact.trigger === 'on_renewal') return;
	const row = (p.ctx.scheduled_changes ?? []).find((entry) => entry.id === pact.id);

	if (!row) return;
	if (pact.trigger === 'every_n_months') {
		p.ops.push({
			kind: 'insert_scheduled_change',
			row: {
				contract_item_ref: row.contract_item_id,
				group_key: row.group_key,
				parent_id: row.id,
				trigger: 'every_n_months',
				effective_date: pact.effective_date,
				kind: row.kind,
				value: row.value,
				status: 'applied',
				status_reason: null,
				applied_value: pact.value,
				origin: { type: 'scheduled_change', parent_id: row.id },
				notes: p.req.notes ?? null,
			},
		});
		if (pact.effective_date && pact.interval_months)
			p.ops.push({
				kind: 'update_scheduled_change',
				id: row.id,
				set: { next_effective_date: addMonths(pact.effective_date, pact.interval_months) },
			});
	} else p.ops.push({ kind: 'update_scheduled_change', id: row.id, set: { status: 'applied', applied_value: pact.value } });
	p.extras.scheduled_changes = {
		applied: [{ id: row.id, kind: row.kind, item_id: row.contract_item_id, value: row.value, applied_value: pact.value, trigger: row.trigger }],
		skipped: [],
		created: [],
	};
}

/** `quote_item_id` de un ítem del pedido: debe ser de la cotización de origen (400 si no). */
function quoteItemOf(p: Planner, ref: Record<string, unknown>, field: string): QuoteItemRow | null {
	const id = typeof ref.quote_item_id === 'string' && ref.quote_item_id ? ref.quote_item_id : null;

	if (!id) return null;
	if (p.req.origin?.type !== 'quote') {
		p.error(`${field}.quote_item_id`, 'El ítem de cotización solo se usa con origen cotización (origin.type = quote)');

		return null;
	}
	const row = p.ctx.quote_items?.get(id) ?? null;

	if (!row || row.quote_id !== p.req.origin.quote_id) p.error(`${field}.quote_item_id`, 'El ítem no pertenece a la cotización de origen');

	return row && row.quote_id === p.req.origin.quote_id ? row : null;
}

interface RetermResult {
	categoria: 'UPSELL' | 'DOWNSELL' | 'RENEWAL';
	mrr_delta: number;
	engine_item: NewItemRow;
	reterm: {
		item_id: string;
		cut: string;
		frequency_before: string | null;
		frequency_after: string;
		term_before: number | null;
		term_after: number;
	};
}

/**
 * §9.3.7 · cambio de frecuencia o término (S3-15): el ítem madre (y sus ajustes co-terminados) se corta al **próximo inicio de período**
 * (`end_date` = corte − 1, `renewed_by_item_id`), nace un **RENEWAL** con la frecuencia/plazo nuevos al mismo mensual (+ ajuste
 * UPSELL/DOWNSELL si cambia el precio) y una fila `contract_scheduled_changes` `applied` (`billing_frequency` = meses / `term`). Las PE del
 * original desde el corte pierden sus líneas; el generador crea las del ítem nuevo (fusión F3). Emitidas después del corte →
 * `issued_after_effective_date` con fecha sugerida.
 */
function planReterm(
	p: Planner,
	item: ChangeItemRow,
	ref: Record<string, unknown>,
	field: string,
	contractAnchor: number,
	quoteItem: QuoteItemRow | null
): RetermResult | null {
	const { ctx } = p;
	const anchor = anchorOfItem(item, contractAnchor);
	const cut = nextPeriodStart(engineShape(item), anchor, p.effective);

	if (!cut || !item.end_date || cut > item.end_date) {
		p.error(`${field}.item_id`, `"${item.product_name}" no tiene un próximo período antes de su fin (${item.end_date}): renuévalo`);

		return null;
	}
	p.assertOpenPeriod(cut, `El corte de "${item.product_name}"`);
	const groups = buildItemGroups(ctx.items, addDays(cut, -1));
	const group = groups.find((row) => row.item_ids.includes(item.id));
	// Ajustes vivos al corte: terminan con el original (D3/MF-h), así que se cortan y se absorben con él aunque su fin guardado difiera
	// (legado); su valor ya está en el grupo que parte el RENEWAL. Los desalineados se avisan (`adjustment_end_mismatch`).
	const children = ctx.items.filter(
		(row) =>
			row.related_item_id === item.id &&
			DELTA_CATEGORIES.has(row.categoria ?? '') &&
			!row.churn_date &&
			!row.renewed_by_item_id &&
			(row.end_date ?? '9999-12-31') >= cut &&
			(row.start_date ?? '') < cut
	);
	const misaligned = children.filter((row) => row.end_date !== item.end_date);

	if (misaligned.length)
		p.warn(
			'adjustment_end_mismatch',
			`"${item.product_name}" tiene ${misaligned.length} ajuste(s) con un fin distinto al suyo (${misaligned
				.map((row) => `${row.categoria} hasta el ${row.end_date ?? 'sin fin'}`)
				.join('; ')}): se cortan junto con el ítem y quedan en la renegociación`
		);
	const cutIds = new Set([item.id, ...children.map((child) => child.id)]);
	const frontier = ctx.invoices
		.filter(isIssued)
		.flatMap((invoice) => invoice.lines)
		.filter((line) => line.contract_item_id && cutIds.has(line.contract_item_id) && (line.billing_period_end ?? '') >= cut)
		.map((line) => line.billing_period_end ?? '')
		.sort()
		.reverse()[0];

	if (frontier)
		p.block(
			'issued_after_effective_date',
			`"${item.product_name}" ya está facturado en firme hasta el ${frontier}: el corte (${cut}) cae en un período emitido`,
			`Usa fecha efectiva ${addDays(frontier, 1)} o posterior; lo emitido se corrige con nota de crédito`
		);
	p.assertNoUnified(cutIds, cut);
	const quantity = group?.quantity ?? num(item.quantity);
	const mrr = group?.mrr ?? itemMonthly(item);
	const pct = item.discount_type === 'Porcentaje' ? num(item.discount_value) : 0;
	const unit = quantity > 0 && pct < 100 ? round6(mrr / (quantity * (1 - pct / 100))) : num(item.unit_price);
	const frequencyAfter = String(ref.billing_frequency ?? item.billing_frequency ?? 'Mensual');
	const termAfter = ref.term_months !== undefined && ref.term_months !== null ? Number(ref.term_months) : monthsCeil(cut, item.end_date);
	const end = itemEndDate(cut, termAfter);
	const key = p.newKey();
	const annual = item.price_entry_mode === 'annual';
	const price = round2(unit * quantity * termAfter);
	const renewalRow: NewItemRow = {
		key,
		product_id: item.product_id,
		product_name: item.product_name ?? 'Producto',
		account: item.account,
		item_type: item.item_type,
		unit_of_measure: item.unit_of_measure,
		categoria: 'RENEWAL',
		quantity,
		unit_price: annual ? null : unit,
		annual_unit_price: round6(unit * 12),
		price_entry_mode: annual ? 'annual' : 'monthly',
		discount_type: pct > 0 ? 'Porcentaje' : null,
		discount_value: pct,
		price,
		final_price: round2(price * (1 - pct / 100)),
		currency: item.currency ?? ctx.contract.contract_currency,
		billing_frequency: frequencyAfter,
		billing_method: item.billing_method ?? 'Anticipado',
		is_recurring: true,
		start_date: cut,
		end_date: end,
		term_months: termAfter,
		related_item_id: null,
		renews_item_id: item.id,
		booking_date: p.effective,
		auto_renew: item.auto_renew,
		price_id: item.price_id,
		quote_item_id: quoteItem?.id ?? null,
		billing_anchor_day: validAnchorDay(item.billing_anchor_day),
	};

	p.insertItem(renewalRow);
	const unitNew = ref.price_entry_mode === 'annual' ? round6(num(ref.unit_price) / 12) : num(ref.unit_price);
	const pctNew = ref.discount_value !== undefined && ref.discount_value !== null ? num(ref.discount_value) : pct;
	const delta = unifiedDelta({
		current_quantity: quantity,
		current_mrr: round2(unit * quantity * (1 - pct / 100)),
		new_quantity: num(ref.quantity) || quantity,
		new_unit_price: unitNew || unit,
		discount_pct: pctNew,
	});

	if (delta && delta.monthly_new <= 0) {
		p.error(`${field}.quantity`, 'El mensual nuevo debe ser mayor que 0; para quitar el producto usa item_remove');

		return null;
	}
	if (delta)
		p.insertItem({
			...renewalRow,
			key: p.newKey(),
			categoria: delta.categoria,
			quantity: delta.quantity,
			unit_price: delta.unit_price,
			annual_unit_price: round6(delta.unit_price * 12),
			price_entry_mode: 'monthly',
			discount_type: null,
			discount_value: 0,
			price: round2(delta.mrr_delta * termAfter),
			final_price: round2(delta.mrr_delta * termAfter),
			related_item_id: key,
			renews_item_id: null,
			auto_renew: false,
			price_id: null,
		});
	// El original y sus ajustes co-terminados terminan el día antes del corte (mismo mensual: valor = mensual × meses que quedan).
	for (const row of [item, ...children]) {
		const start = row.start_date ?? cut;
		const termBefore = monthsCeil(start, addDays(cut, -1));
		const finalAfter = round2(itemMonthly(row) * termBefore);
		const oldTerm = num(row.term_months);

		p.ops.push({
			kind: 'update_item',
			item_id: row.id,
			set: {
				end_date: addDays(cut, -1),
				term_months: termBefore,
				final_price: finalAfter,
				price: oldTerm > 0 ? round2((num(row.price) * termBefore) / oldTerm) : finalAfter,
				renewed_by_key: key,
			},
		});
		const after = p.itemsAfter.find((entry) => entry.id === row.id)!;

		after.end_date = addDays(cut, -1);
		after.term_months = termBefore;
		after.final_price = finalAfter;
		after.renewed_by_item_id = key;
		p.adjusted.push({ ...previewOf(after), renews_item_id: null });
	}
	// Por Emitir del original desde el corte: se quitan sus líneas (el generador crea las del RENEWAL).
	for (const invoice of ctx.invoices.filter(isEditablePending)) {
		const lines = invoice.lines.filter(
			(line) => line.contract_item_id && cutIds.has(line.contract_item_id) && (line.billing_period_start ?? '') >= cut
		);

		if (!lines.length || p.skipPartial(invoice)) continue;
		for (const line of lines) p.deleteLine(invoice, line);
	}
	// Pacto registrado (aplicado en el acto): frecuencia en meses y/o plazo nuevo.
	const groupKey = `group:reterm:${item.id}`;
	const frequencyChanged = frequencyAfter !== (item.billing_frequency ?? 'Mensual');
	const termChanged = ref.term_months !== undefined && ref.term_months !== null;
	const pacts: Array<{ kind: 'billing_frequency' | 'term'; value: number }> = [
		...(frequencyChanged
			? [{ kind: 'billing_frequency' as const, value: BILLING_FREQUENCY_MONTHS[frequencyAfter as BillingFrequency] ?? 1 }]
			: []),
		...(termChanged ? [{ kind: 'term' as const, value: termAfter }] : []),
	];
	const isPactApply = p.options.scheduled_change && p.options.scheduled_change.trigger !== 'on_renewal';

	if (!isPactApply)
		for (const pact of pacts)
			p.ops.push({
				kind: 'insert_scheduled_change',
				row: {
					contract_item_ref: item.id,
					group_key: pacts.length > 1 ? groupKey : null,
					parent_id: null,
					trigger: 'on_date',
					effective_date: cut,
					kind: pact.kind,
					value: pact.value,
					status: 'applied',
					status_reason: null,
					applied_value: pact.value,
					origin: { ...(p.req.origin ?? { type: 'manual' }) },
					notes: p.req.reason ?? null,
				},
			});
	p.touchRsm(cut);

	return {
		categoria: delta ? delta.categoria : 'RENEWAL',
		mrr_delta: delta ? p.toContract(delta.mrr_delta, item.currency, cut) : 0,
		engine_item: {
			...renewalRow,
			quantity: delta ? num(ref.quantity) || quantity : quantity,
			unit_price: delta ? unitNew || unit : unit,
			discount_type: (delta ? pctNew : pct) > 0 ? 'Porcentaje' : null,
			discount_value: delta ? pctNew : pct,
			final_price: round2((delta ? delta.monthly_new : round2(unit * quantity * (1 - pct / 100))) * termAfter),
		},
		reterm: {
			item_id: item.id,
			cut,
			frequency_before: item.billing_frequency,
			frequency_after: frequencyAfter,
			term_before: item.term_months,
			term_after: termAfter,
		},
	};
}

/**
 * Cuotas del motor para un ítem existente con modelo de precio a una cantidad (y descuento) nuevos, indexadas por inicio de período: cada una
 * trae las filas del ítem en ese período según su `invoice_line_mode` (`single` o `per_tier`) con el desglose recalculado. `consumption` =
 * consumos registrados por período (Huecos F4-C): esos períodos se tarifan con la cantidad registrada (monto informado, descuento y origen
 * `consumption`/`estimated` del consumo, sin prorrateo, igual que `repriceConsumptionLine`) y conservan una fila por tramo en `per_tier`.
 */
function pricedItemInvoicesByPeriod(
	p: Planner,
	item: ChangeItemRow,
	spec: PriceSpec,
	quantity: number,
	pct: number,
	consumption: ConsumptionInput[] = []
): Map<string, PreviewInvoice> {
	const byPeriod = pricedPeriodsOf(p, item, spec, quantity, pct, []);

	if (consumption.length) {
		// El motor solo lee consumos en precios medidos: el período con consumo registrado se tarifa como medido con esa cantidad.
		const recorded = pricedPeriodsOf(p, item, { ...spec, quantity_type: 'metered' }, quantity, pct, consumption);

		for (const entry of consumption) {
			const period = String(entry.period_start).slice(0, 10);
			const priced = recorded.get(period);

			if (priced) byPeriod.set(period, priced);
		}
	}

	return byPeriod;
}

function pricedPeriodsOf(
	p: Planner,
	item: ChangeItemRow,
	spec: PriceSpec,
	quantity: number,
	pct: number,
	consumption: ConsumptionInput[]
): Map<string, PreviewInvoice> {
	const engine = generateInvoices({
		contract: p.engineContractAfter(),
		items: [
			{
				key: item.id,
				product_id: item.product_id,
				product_name: item.product_name ?? 'Producto',
				account: item.account,
				quantity,
				unit_price: num(item.unit_price ?? num(item.annual_unit_price) / 12),
				discount_value: pct,
				discount_type: pct > 0 ? 'Porcentaje' : null,
				billing_frequency: item.billing_frequency ?? 'Mensual',
				billing_method: item.billing_method ?? 'Anticipado',
				start_date: item.start_date!,
				term_months: item.term_months,
				end_date: item.end_date,
				is_recurring: true,
				final_price: item.final_price,
				price: spec,
				currency: item.currency,
				billing_anchor_day: validAnchorDay(item.billing_anchor_day),
				consumption,
			},
		],
	});
	const byPeriod = new Map<string, PreviewInvoice>();

	for (const invoice of engine.invoices) {
		for (const periodStart of new Set(invoice.lines.map((line) => line.billing_period_start))) {
			const lines = invoice.lines.filter((line) => line.billing_period_start === periodStart);
			const subtotal = round2(lines.reduce((sum, line) => sum + line.subtotal, 0));
			const tax = round2(lines.reduce((sum, line) => sum + line.tax_amount, 0));

			byPeriod.set(periodStart, {
				...invoice,
				billing_period_start: periodStart,
				billing_period_end: lines[0].billing_period_end,
				lines,
				subtotal: lines.length === invoice.lines.length ? invoice.subtotal : subtotal,
				tax: lines.length === invoice.lines.length ? invoice.tax : tax,
				total: lines.length === invoice.lines.length ? invoice.total : round2(subtotal + tax),
			});
		}
	}

	return byPeriod;
}

/**
 * Consumos registrados de un ítem en sus Por Emitir desde `from` (uno por período), como entrada del motor: cantidad, monto informado,
 * descuento y estimado del consumo (`consumption_entries`); sin fila de consumo, la cantidad de las filas del período.
 */
function recordedConsumption(ctx: ChangeContext, itemId: string, from: string): ConsumptionInput[] {
	const byPeriod = new Map<string, ConsumptionInput>();
	const lines = ctx.invoices
		.filter((invoice) => isEditablePending(invoice) && !isPartialBilled(invoice))
		.flatMap((invoice) => invoice.lines)
		.filter((line) => line.contract_item_id === itemId && isConsumptionLine(line) && (line.billing_period_start ?? '') >= from);

	for (const line of lines) {
		const period = line.billing_period_start!;

		if (byPeriod.has(period)) continue;
		const rows = lines.filter((row) => row.billing_period_start === period);

		byPeriod.set(period, {
			period_start: period,
			quantity: line.consumption?.quantity ?? rows.reduce((sum, row) => sum + num(row.quantity), 0),
			amount_override: line.consumption?.amount_override ?? null,
			apply_item_discount: line.consumption?.apply_item_discount !== false,
			is_estimated: line.quantity_source === 'estimated' || line.consumption?.is_estimated === true,
		});
	}

	return [...byPeriod.values()];
}

export function planItemChange(ctx: ChangeContext, req: ContractChangeRequestDto, options: PlanOptions = {}): ChangePlan {
	const p = new Planner(ctx, req, 'item_change', options);
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const groups = buildItemGroups(ctx.items, p.effective);
	const newItems: NewItemRow[] = [];
	const categories = new Set<string>();
	const subtypes = new Set<string>();
	const reterms: RetermResult['reterm'][] = [];
	let mrrDelta = 0;

	p.assertState();
	assertQuoteOrigin(p);
	if (!refs.length) p.error('change.items', 'Indica al menos un ítem a cambiar');
	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const item = p.findItem(String(ref.item_id ?? ''), `${field}.item_id`);
		const quoteItem = quoteItemOf(p, ref, field);

		if (!item) continue;
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
		// §9.3.7: frecuencia o plazo nuevos → corte al próximo período + RENEWAL (+ ajuste si cambia el precio).
		const frequencyChanged =
			ref.billing_frequency !== undefined && ref.billing_frequency !== null && ref.billing_frequency !== (item.billing_frequency ?? 'Mensual');

		if (frequencyChanged || (ref.term_months !== undefined && ref.term_months !== null)) {
			const result = planReterm(p, item, ref, field, anchor, quoteItem);

			if (!result) continue;
			categories.add(result.categoria);
			subtypes.add('RENEGOTIATION');
			mrrDelta += result.mrr_delta;
			newItems.push(result.engine_item);
			reterms.push(result.reterm);
			continue;
		}
		const itemAnchor = anchorOfItem(item, anchor);
		const annual = ref.price_entry_mode === 'annual';
		let unitNew = annual ? round6(num(ref.unit_price) / 12) : num(ref.unit_price);
		const pct =
			ref.discount_value !== undefined && ref.discount_value !== null
				? num(ref.discount_value)
				: item.discount_type === 'Porcentaje'
					? num(item.discount_value)
					: 0;
		// MF-b / Huecos #4b: ítem con modelo de precio (tramos, paquete, asiento, medido): el precio lo fija el motor para la cantidad nueva
		// (mensual equivalente), no el unitario del pedido; las Por Emitir se re-tarifan con sus filas (single / per_tier) y su desglose.
		const spec = priceSpecFromRow(item.raw);
		const pricedSpec = spec && !isStandardFixed(spec) ? spec : null;

		if (pricedSpec) {
			const quantityNew = num(ref.quantity);
			const monthlyNew = pricedMonthlyEquivalent(
				pricedSpec,
				{
					quantity: quantityNew,
					billing_frequency: (item.billing_frequency ?? 'Mensual') as BillingFrequency,
					is_recurring: true,
					term_months: item.term_months,
				},
				pct
			);
			const unitEngine = quantityNew > 0 && pct < 100 ? round6(monthlyNew / (quantityNew * (1 - pct / 100))) : 0;

			if (ref.unit_price !== undefined && ref.unit_price !== null && Math.abs(unitEngine - unitNew) > 1e-4)
				p.warn(
					'priced_item_engine_price',
					`"${item.product_name}" tiene modelo de precio (${pricedSpec.model}): el valor sale de sus tramos para ${quantityNew} (mensual ${money(monthlyNew)}), no del unitario indicado. Para cambiar la tarifa edita el precio del ítem`
				);
			unitNew = unitEngine;
		}
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
			p.error(`${field}.quantity`, 'El mensual nuevo debe ser mayor que 0; para quitar el producto usa item_remove');
			continue;
		}
		// Downsell rige desde el próximo inicio de período sin prorrateo (S3-5/S3-6); upsell parte el día efectivo y prorratea el primer tramo.
		let start = p.effective;

		if (delta.categoria === 'DOWNSELL' || pricedSpec) {
			const next = nextPeriodStart(engineShape(item), itemAnchor, p.effective) ?? p.effective;

			if (next !== p.effective)
				p.warn(
					delta.categoria === 'DOWNSELL' ? 'downsell_from_next_period' : 'priced_item_from_next_period',
					delta.categoria === 'DOWNSELL'
						? `La rebaja de "${item.product_name}" rige desde el próximo inicio de período (${next}), sin prorrateo`
						: `"${item.product_name}" se tarifa por período con su modelo de precio: el cambio rige desde el próximo inicio de período (${next})`
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
		const coveredMonths = delta.categoria === 'UPSELL' ? monthsBetween(start, item.end_date, itemAnchor) : term;
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
		mrrDelta += p.toContract(delta.mrr_delta, item.currency, item.start_date ?? start);
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
			// D-CTR-4 (spec-revenue-y-metricas §6, Domi 01-10): la baja/ajuste se registra hoy; `start_date` es la fecha efectiva. Así el CMRR anticipa la contracción desde el booking.
			booking_date: ctx.today,
			auto_renew: false,
			price_id: null,
			// Desde cotización: el ajuste queda ligado a su ítem cotizado.
			quote_item_id: quoteItem?.id ?? null,
			// El ajuste sigue el ciclo de su ítem (§9.3.9).
			billing_anchor_day: validAnchorDay(item.billing_anchor_day),
		};

		p.insertItem(newItem);
		// Facturas: línea neta (obligatoria en downsell, opcional en upsell, S3-14) o línea propia del delta (upsell). Con consumo registrado
		// en alguna Por Emitir del ítem la línea es neta: la cantidad consumida se conserva y se tarifa al precio nuevo (nunca la base).
		const inScope = (line: ChangeInvoiceLineRow) =>
			Boolean(line.contract_item_id && groupIds.has(line.contract_item_id) && (line.billing_period_start ?? '') >= start);
		const withConsumption = ctx.invoices
			.filter(isEditablePending)
			.some((invoice) => !isPartialBilled(invoice) && invoice.lines.some((line) => inScope(line) && isConsumptionLine(line)));
		// Con modelo de precio la línea siempre es neta: las filas del ítem se re-tarifan con el motor (nunca una línea estándar del delta).
		const netLine = delta.categoria === 'DOWNSELL' || ref.net_line === true || withConsumption || Boolean(pricedSpec);

		if (withConsumption && delta.categoria !== 'DOWNSELL' && ref.net_line !== true)
			p.warn(
				'consumption_net_line',
				`"${item.product_name}" tiene consumo registrado en facturas por emitir: el cambio se aplica como línea neta al precio nuevo`
			);
		if (netLine) {
			// Consumos registrados del ítem en las Por Emitir del cambio: con modelo de precio se re-tarifan por período con su cantidad
			// (una fila por tramo en `per_tier`; nunca una sola fila con el total).
			const recorded = pricedSpec ? recordedConsumption(ctx, item.id, start) : [];
			const pricedPeriods = pricedSpec ? pricedItemInvoicesByPeriod(p, item, pricedSpec, num(ref.quantity), pct, recorded) : null;

			for (const invoice of ctx.invoices.filter(isEditablePending)) {
				const groupLines = invoice.lines.filter(inScope);

				if (!groupLines.length || p.skipPartial(invoice)) continue;
				const baseLine = groupLines.find((line) => line.contract_item_id === item.id);
				const ownLines = groupLines.filter((line) => line.contract_item_id === item.id);

				// Modelo de precio: se quitan TODAS las filas del grupo en el período (las del ítem, una o varias por tramo, y las de sus
				// ajustes) y entran las del motor con su desglose (nunca se aplanan): a la cantidad nueva, o a la registrada si el período
				// tiene consumo (la fila de consumo se reescribe por tramo, como al registrar el consumo; la factura sigue siendo la misma).
				if (pricedPeriods && ownLines.length) {
					const manual = groupLines.find((line) => line.quantity_source === 'manual');

					if (manual) {
						p.deleteLine(invoice, manual); // no la quita: deja el aviso manual_edit_kept
						continue;
					}
					const periods = [...new Set(ownLines.map((line) => line.billing_period_start ?? ''))].filter((period) =>
						pricedPeriods.has(period)
					);

					if (!periods.length) continue;
					for (const line of groupLines) p.deleteLine(invoice, line);
					for (const period of periods) {
						const priced = pricedPeriods.get(period)!;
						const kept = recorded.find((entry) => entry.period_start === period);

						if (kept)
							p.warn(
								'consumption_quantity_kept',
								`La factura ${invoice.invoice_number ?? invoice.issue_date ?? invoice.id} conserva el consumo registrado de "${item.product_name}" (${kept.quantity}) y se recalcula por tramo con su modelo de precio`
							);
						p.mergePricedLines(invoice, priced, 'filas del ítem re-tarifadas con su modelo de precio');
					}
					continue;
				}

				for (const line of groupLines) {
					if (line === baseLine) continue;
					// Una línea con consumo registrado no se quita (su `consumption_entries.invoice_id` la apunta).
					if (isConsumptionLine(line)) continue;
					p.deleteLine(invoice, line);
				}
				if (baseLine && isConsumptionLine(baseLine)) {
					const months = monthsBetween(baseLine.billing_period_start!, baseLine.billing_period_end!, itemAnchor);
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
					const months = monthsBetween(baseLine.billing_period_start!, baseLine.billing_period_end!, itemAnchor);
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
	p.closeHeaders(reterms.length ? 'Cambio de frecuencia o plazo' : 'Cambio de precio o cantidad');
	p.mrrDelta = round2(mrrDelta);
	recordPactApplication(p);
	const priced = [...categories].filter((category) => category !== 'RENEWAL');
	const type = !priced.length ? 'RENEWAL' : priced.every((category) => category === 'DOWNSELL') ? 'DOWNSELL' : 'UPSELL';
	const pactKind = options.scheduled_change?.kind;
	const subtype = subtypes.has('RENEGOTIATION')
		? 'RENEGOTIATION'
		: pactKind === 'index'
			? 'index'
			: pactKind === 'percent_uplift' || pactKind === 'new_unit_price'
				? 'price_step'
				: ([...subtypes][0] ?? null);
	const names = refs
		.map((ref) => ctx.items.find((item) => item.id === ref.item_id)?.product_name)
		.filter(Boolean)
		.join(', ');

	return p.finish({
		type,
		subtype,
		title: reterms.length
			? 'Cambio de frecuencia o plazo (renegociación)'
			: type === 'DOWNSELL'
				? 'Reducción de precio o cantidad (downsell)'
				: 'Aumento de precio o cantidad (upsell)',
		description: reterms.length
			? `Se renegoció ${names}: ${reterms
					.map(
						(entry) =>
							`${entry.frequency_before ?? '—'} → ${entry.frequency_after}, ${entry.term_before ?? '—'} → ${entry.term_after} meses desde el ${entry.cut}`
					)
					.join('; ')}${mrrDelta ? ` · MRR ${mrrDelta >= 0 ? '+' : ''}${money(mrrDelta)}` : ''}`
			: `Se ${type === 'DOWNSELL' ? 'redujo' : 'aumentó'} ${names}: MRR ${mrrDelta >= 0 ? '+' : ''}${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: refs.map((ref) => String(ref.item_id ?? '')).filter(Boolean),
		metadata: {
			first_period_invoice: req.change.first_period_invoice ?? 'cycle',
			...(reterms.length
				? {
						reterm:
							reterms.length === 1
								? {
										frequency_before: reterms[0].frequency_before,
										frequency_after: reterms[0].frequency_after,
										term_before: reterms[0].term_before,
										term_after: reterms[0].term_after,
										cut: reterms[0].cut,
									}
								: reterms,
					}
				: {}),
			quote_items: refs.map((ref) => ref.quote_item_id).filter(Boolean),
		},
	});
}

/** Modelos que acepta `price_model_change` (los de la etapa 1 de Pricing v2). */
export const PRICE_MODEL_CHANGE_CODES = {
	same_model: 'price_model_unchanged',
	corrections_on_fixed: 'quantity_corrections_after_cut',
} as const;

/**
 * `price_model_change` (Domi 05-10, spec-modificaciones-contrato-v2 §9.3.11): cambiar el modelo de precio de UN ítem recurrente vigente
 * (estándar ↔ tramos / volumen / paquete / asiento; cantidad fija ↔ por consumo con métrica; gratis, mínimo, tope, `invoice_line_mode`).
 * Mismo patrón que el cambio de frecuencia (§9.3.7): el ítem (y sus ajustes vivos) se corta el día antes del **próximo inicio de período
 * desde la fecha efectiva** y nace un **RENEWAL** que lo continúa con un precio propio del contrato nuevo (`version` + 1,
 * `supersedes_price_id` = el anterior); los períodos ya facturados y los anteriores al corte siguen con el modelo anterior (el ítem
 * original conserva su precio). Las Por Emitir desde el corte se regeneran con el modelo nuevo y con el consumo registrado de cada
 * período (que pasa al RENEWAL: `move_consumption`); un período emitido después del corte bloquea (`issued_after_effective_date`).
 * **MRR** = el nuevo monto base del plan: el modelo nuevo tarifado a la **cantidad base** (`quantity` del pedido o la del ítem) y
 * mensualizado (`pricedMonthlyEquivalent`), con el descuento % del ítem; con tramos es el precio de esa cantidad por tramos. El delta va
 * en el mismo RENEWAL (`renewal_base_unit_price`: el RSM separa el delta como UPSELL / DOWNSELL, `apply_renewal_price_split`). El
 * devengo sigue lo facturado en los períodos con consumo (regla D2-c del rebuild).
 */
export function planPriceModelChange(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'price_model_change');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const field = 'change.items.0';
	const ref = refs[0] ?? {};
	const contractAnchor = anchorDayOf(ctx.contract, ctx.items);
	let mrrDelta = 0;
	let engineItem: NewItemRow | null = null;
	let summary: Record<string, unknown> = {};

	p.assertState();
	if (req.origin?.type && req.origin.type !== 'manual') p.error('origin.type', 'El cambio de modelo de precio se registra a mano');
	if (refs.length !== 1) p.error('change.items', 'Cambia el modelo de precio de un ítem a la vez');
	const item = p.findItem(String(ref.item_id ?? ''), `${field}.item_id`);
	const priceDto = (ref.price ?? null) as PriceSpec | null;

	if (!priceDto || typeof priceDto !== 'object') p.error(`${field}.price`, 'Indica el modelo de precio nuevo');
	const spec = priceDto && typeof priceDto === 'object' ? normalizePriceSpec(priceDto) : null;
	let valid = Boolean(spec);

	for (const error of spec ? validatePriceSpec(spec) : []) {
		p.error(`${field}.price.${error.field}`, error.message);
		valid = false;
	}
	if (item && spec && valid) {
		const billingMethod = item.billing_method ?? 'Anticipado';

		if (isMetered(spec)) {
			const metricId = spec.billable_metric_id ?? null;
			const status = metricId ? ctx.billable_metrics?.get(metricId) : undefined;

			if (!metricId) p.error(`${field}.price.billable_metric_id`, 'Elige la métrica que se mide');
			else if (!status) p.error(`${field}.price.billable_metric_id`, 'La métrica facturable no existe en el holding');
			else if (status !== 'active') p.error(`${field}.price.billable_metric_id`, 'La métrica facturable está archivada');
			if (billingMethod === 'Anticipado' && spec.model !== 'seat') p.error(`${field}.price`, METERED_ADVANCE_MESSAGE);
		}
		if (item.is_recurring === false || !item.start_date)
			p.error(`${field}.item_id`, `"${item.product_name}" no es recurrente o no tiene inicio: su precio se corrige como dato del ítem`);
	}
	const current = item ? priceSpecFromRow(item.raw) : null;

	if (item && spec && current && JSON.stringify(normalizePriceSpec(current)) === JSON.stringify(spec))
		p.error(`${field}.price`, `"${item.product_name}" ya tiene ese modelo de precio`, PRICE_MODEL_CHANGE_CODES.same_model);

	if (item && spec && valid && item.is_recurring !== false && item.start_date && p.assertRemovable(item)) {
		const anchor = anchorOfItem(item, contractAnchor);
		const cut = nextPeriodStart(engineShape(item), anchor, p.effective);

		if (!cut || !item.end_date || cut > item.end_date) {
			p.error(`${field}.item_id`, `"${item.product_name}" no tiene un próximo período antes de su fin (${item.end_date}): renuévalo primero`);
		} else {
			if (cut !== p.effective)
				p.warn(
					'price_model_from_next_period',
					`El modelo nuevo de "${item.product_name}" rige desde el próximo inicio de período (${cut}): el período en curso sigue con el anterior`
				);
			p.assertOpenPeriod(cut, `El corte de "${item.product_name}"`);
			const group = buildItemGroups(ctx.items, addDays(cut, -1)).find((row) => row.item_ids.includes(item.id));
			const children = ctx.items.filter(
				(row) =>
					row.related_item_id === item.id &&
					DELTA_CATEGORIES.has(row.categoria ?? '') &&
					!row.churn_date &&
					!row.renewed_by_item_id &&
					(row.end_date ?? '9999-12-31') >= cut &&
					(row.start_date ?? '') < cut
			);
			const cutIds = new Set([item.id, ...children.map((child) => child.id)]);
			const frontier = ctx.invoices
				.filter(isIssued)
				.flatMap((invoice) => invoice.lines)
				.filter((line) => line.contract_item_id && cutIds.has(line.contract_item_id) && (line.billing_period_end ?? '') >= cut)
				.map((line) => line.billing_period_end ?? '')
				.sort()
				.reverse()[0];

			if (frontier)
				p.block(
					'issued_after_effective_date',
					`"${item.product_name}" ya está facturado en firme hasta el ${frontier}: el modelo nuevo (desde el ${cut}) caería en un período emitido`,
					`Usa fecha efectiva ${addDays(frontier, 1)} o posterior; lo emitido se corrige con nota de crédito`
				);
			p.assertNoUnified(cutIds, cut);
			const recorded = recordedConsumption(ctx, item.id, cut);

			if (recorded.length && !isMetered(spec))
				p.block(
					PRICE_MODEL_CHANGE_CODES.corrections_on_fixed,
					`"${item.product_name}" tiene consumos registrados desde el ${cut} (${recorded.map((entry) => entry.period_start).join(', ')}) y el modelo nuevo es de cantidad fija`,
					'Elige cantidad por consumo, o usa como fecha efectiva el período siguiente a la última corrección'
				);
			if (
				ctx.invoices.some(
					(invoice) =>
						isEditablePending(invoice) &&
						invoice.lines.some(
							(line) =>
								line.contract_item_id &&
								cutIds.has(line.contract_item_id) &&
								(line.billing_period_start ?? '') >= cut &&
								line.quantity_source === 'manual'
						)
				)
			)
				p.warn(
					'manual_edit_replaced',
					`Hay líneas de "${item.product_name}" editadas a mano desde el ${cut}: se reemplazan por las del modelo nuevo`
				);
			const quantity = ref.quantity !== undefined && ref.quantity !== null ? num(ref.quantity) : (group?.quantity ?? num(item.quantity));
			const pct =
				ref.discount_value !== undefined && ref.discount_value !== null
					? num(ref.discount_value)
					: item.discount_type === 'Porcentaje'
						? num(item.discount_value)
						: 0;

			if (item.discount_type === 'Monto fijo' && num(item.discount_value) > 0)
				p.warn(
					'fixed_discount_dropped',
					`El descuento en monto fijo de "${item.product_name}" no aplica a un modelo de precio: el modelo nuevo se tarifa sin él`
				);
			const frequency = (item.billing_frequency ?? 'Mensual') as BillingFrequency;
			const term = monthsCeil(cut, item.end_date);
			const oldMonthly = round2(group?.mrr ?? itemMonthly(item));
			const monthlyNew = round2(
				pricedMonthlyEquivalent(spec, { quantity, billing_frequency: frequency, is_recurring: true, term_months: term }, pct)
			);

			if (quantity <= 0) p.error(`${field}.quantity`, 'La cantidad base debe ser mayor que 0');
			const unit = quantity > 0 && pct < 100 ? round6(monthlyNew / (quantity * (1 - pct / 100))) : 0;
			const origQuantity = num(item.quantity) > 0 ? num(item.quantity) : 1;
			const key = p.newKey();
			const renewalRow: NewItemRow = {
				key,
				product_id: item.product_id,
				product_name: item.product_name ?? 'Producto',
				account: item.account,
				item_type: item.item_type,
				unit_of_measure: item.unit_of_measure,
				categoria: 'RENEWAL',
				quantity,
				unit_price: unit,
				annual_unit_price: round6(unit * 12),
				price_entry_mode: 'monthly',
				discount_type: pct > 0 ? 'Porcentaje' : null,
				discount_value: pct,
				price: round2(unit * quantity * term),
				final_price: round2(monthlyNew * term),
				currency: item.currency ?? ctx.contract.contract_currency,
				billing_frequency: frequency,
				billing_method: item.billing_method ?? 'Anticipado',
				is_recurring: true,
				start_date: cut,
				end_date: item.end_date,
				term_months: term,
				related_item_id: null,
				renews_item_id: item.id,
				booking_date: ctx.today,
				auto_renew: item.auto_renew,
				price_id: null,
				quote_item_id: null,
				billing_anchor_day: validAnchorDay(item.billing_anchor_day),
				price_spec: spec,
				price_name: typeof item.raw.price_name === 'string' && item.raw.price_name ? item.raw.price_name : null,
				price_version: item.price_id ? num(item.raw.price_version ?? 1) + 1 : 1,
				supersedes_price_id: item.price_id ?? null,
				renewal_base_unit_price: Math.abs(monthlyNew - oldMonthly) >= 0.01 ? round6(oldMonthly / origQuantity) : null,
				consumption: recorded,
			};

			p.insertItem(renewalRow);
			// El original y sus ajustes vivos terminan el día antes del corte (mismo mensual: valor = mensual × meses que quedan).
			for (const row of [item, ...children]) {
				const start = row.start_date ?? cut;
				const termBefore = monthsCeil(start, addDays(cut, -1));
				const finalAfter = round2(itemMonthly(row) * termBefore);
				const oldTerm = num(row.term_months);

				p.ops.push({
					kind: 'update_item',
					item_id: row.id,
					set: {
						end_date: addDays(cut, -1),
						term_months: termBefore,
						final_price: finalAfter,
						price: oldTerm > 0 ? round2((num(row.price) * termBefore) / oldTerm) : finalAfter,
						renewed_by_key: key,
					},
				});
				const after = p.itemsAfter.find((entry) => entry.id === row.id)!;

				after.end_date = addDays(cut, -1);
				after.term_months = termBefore;
				after.final_price = finalAfter;
				after.renewed_by_item_id = key;
				p.adjusted.push({ ...previewOf(after), renews_item_id: null });
			}
			if (children.length)
				p.warn(
					'adjustments_absorbed',
					`"${item.product_name}" tiene ${children.length} ajuste(s) vigentes: terminan con el corte y el modelo nuevo los reemplaza`
				);
			// Por Emitir del original (y sus ajustes) desde el corte: se quitan sus líneas; el generador crea las del modelo nuevo.
			for (const invoice of ctx.invoices.filter(isEditablePending)) {
				const lines = invoice.lines.filter(
					(line) => line.contract_item_id && cutIds.has(line.contract_item_id) && (line.billing_period_start ?? '') >= cut
				);

				if (!lines.length || p.skipPartial(invoice)) continue;
				for (const line of lines) p.deleteLine(invoice, line);
			}
			if (recorded.length) {
				p.ops.push({ kind: 'move_consumption', from_item_id: item.id, to_key: key, from_period: cut });
				p.warn(
					'consumption_quantity_kept',
					`Los consumos registrados de "${item.product_name}" desde el ${cut} (${recorded.length}) se conservan y se tarifan con el modelo nuevo`
				);
			}
			p.touchRsm(cut);
			mrrDelta = p.toContract(round2(monthlyNew - oldMonthly), item.currency, cut);
			engineItem = renewalRow;
			summary = {
				item_id: item.id,
				cut,
				model_before: current?.model ?? 'standard',
				quantity_type_before: current?.quantity_type ?? 'fixed',
				model_after: spec.model,
				quantity_type_after: spec.quantity_type,
				base_quantity: quantity,
				monthly_before: oldMonthly,
				monthly_after: monthlyNew,
				supersedes_price_id: item.price_id ?? null,
				consumption_periods: recorded.map((entry) => entry.period_start),
			};
		}
	}
	if (engineItem) p.addGeneratedInvoices([engineItem], 'cycle');
	p.closeHeaders('Cambio de modelo de precio');
	p.mrrDelta = round2(mrrDelta);
	const type = Math.abs(mrrDelta) < 0.005 ? 'RENEWAL' : mrrDelta > 0 ? 'UPSELL' : 'DOWNSELL';
	const label: Record<string, string> = {
		standard: 'estándar',
		graduated: 'por tramos',
		volume: 'por volumen',
		package: 'por paquete',
		seat: 'por asiento',
	};

	return p.finish({
		type,
		subtype: 'price_model',
		title: 'Cambio de modelo de precio',
		description: item
			? `"${item.product_name}" pasa a precio ${label[String(spec?.model)] ?? spec?.model ?? ''}${
					spec && isMetered(spec) ? ' por consumo' : ''
				} desde el ${String(summary.cut ?? p.effective)}${mrrDelta ? ` · MRR ${mrrDelta >= 0 ? '+' : ''}${money(mrrDelta)}` : ''}`
			: 'Cambio de modelo de precio',
		amount_delta: round2(mrrDelta),
		items_affected: item ? [item.id] : [],
		metadata: { price_model: summary },
	});
}

/**
 * IVA de las Por Emitir según la familia del documento (`resolveTaxRate`: exportación 0; Colombia 0; la tasa del documento tributario si
 * la tiene y es de esa familia; si no, la de la compañía). `document` permite evaluar el documento NUEVO de un cambio de condiciones.
 */
export const taxRateFor = (
	documentType: string,
	contract: ChangeContractRow,
	document: TaxDocumentRate | null = contract.tax_document_type_id
		? { kind: contract.tax_document_type_kind, tax_rate: contract.tax_document_tax_rate ?? null }
		: null
): number =>
	resolveTaxRate({ documentType, companyCountry: contract.company.country, companyTaxRate: contract.company.tax_rate, document }).rate ?? 0;

/** Bloqueo del documento tributario cambiado por sí solo (ronda 4): aplicar responde 409 con este mensaje. */
export const TAX_DOCUMENT_REQUIRES_PARTY_CHANGE = 'tax_document_requires_party_change';
export const TAX_DOCUMENT_REQUIRES_PARTY_CHANGE_MESSAGE = 'El documento tributario solo cambia junto con la razón social emisora o receptora';
const blockDocumentAlone = (p: Planner) =>
	p.block(
		TAX_DOCUMENT_REQUIRES_PARTY_CHANGE,
		TAX_DOCUMENT_REQUIRES_PARTY_CHANGE_MESSAGE,
		'Si cambia la razón social receptora, elige el documento nuevo en "Cambiar razón social"'
	);

/** Documento y IVA nuevos en las Por Emitir desde la fecha efectiva (cambio de documento junto con la razón social). */
const retaxPending = (p: Planner, pending: ChangeInvoiceRow[], documentType: string, taxRate: number) => {
	if (!pending.length) return;
	p.ops.push({
		kind: 'update_invoices_document',
		invoice_ids: pending.map((invoice) => invoice.id),
		document_type: documentType,
		export_type: documentType === 'FACTURA_EXPORTACION' ? 1 : 0,
		tax_rate: taxRate,
	});
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
	// Decisión de Domi (03-10, ronda 4 de Configuración): el documento tributario no cambia solo; solo junto con la razón social emisora o
	// receptora (`change_entity` con `tax_document_type_id`). Mandar el mismo documento no cuenta como cambio.
	if (has('tax_document_type_id')) {
		if (!ctx.tax_document_type)
			p.error('change.tax_document_type_id', 'El documento tributario no existe o no corresponde al país de la compañía emisora');
		else if (ctx.tax_document_type.id !== contract.tax_document_type_id) blockDocumentAlone(p);
	} else if (has('document_type') && change.document_type !== contract.document_type) {
		if (contract.tax_document_type_id) p.error('change.document_type', 'El contrato usa el catálogo de documentos: indica tax_document_type_id');
		else blockDocumentAlone(p);
	}

	// Envío al ERP y emisión automática (S6-10) y referencias: contrato + Por Emitir desde la fecha efectiva.
	const sendAfter = has('auto_send_to_odoo') ? change.auto_send_to_odoo! : contract.auto_send_to_odoo;
	const invoiceAfter = has('auto_invoice') ? change.auto_invoice! : contract.auto_invoice;

	if (invoiceAfter && !sendAfter) p.error('change.auto_invoice', 'La emisión automática requiere el envío automático al ERP');
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
	// Multimoneda (spec §6): los pares que convierten son las monedas de ítem ≠ moneda de factura; la política aplica a cada par.
	const multi = p.multicurrency;
	const itemCurrencies = [...new Set(ctx.items.map((item) => upperCode(item.currency) || contractCurrency))];
	const converting = multi ? itemCurrencies.filter((code) => code !== currencyAfter) : currencyAfter !== contractCurrency ? [contractCurrency] : [];
	const policyBefore = contract.fx_invoice_policy ?? 'spot';
	const policyAfter = has('fx_invoice_policy') ? change.fx_invoice_policy! : converting.length === 0 ? 'spot' : policyBefore;
	const newRates = (change.fx_invoice_rates ?? []).map((rate, index) => {
		const from =
			upperCode(rate.from_currency) || (multi ? (itemCurrencies.length > 1 ? '' : (converting[0] ?? contractCurrency)) : contractCurrency);

		if (!from)
			p.error(
				`change.fx_invoice_rates.${index}.from_currency`,
				'Indica de qué moneda es la tasa: el contrato tiene ítems en más de una moneda'
			);
		else if (!converting.includes(from))
			p.error(
				`change.fx_invoice_rates.${index}.from_currency`,
				`Ningún ítem en ${from} se factura en ${currencyAfter}: la tasa ${from} → ${currencyAfter} no aplica`
			);

		return {
			from_currency: from,
			to_currency: currencyAfter,
			rate: Number(rate.rate),
			period_start: rate.period_start ?? p.effective,
			period_end: rate.period_end ?? '9999-12-31',
		};
	});

	if (currencyAfter === UF_CURRENCY) p.block('uf_invoice_currency', 'La UF no se factura: elige la moneda en que se emite (por ejemplo, CLP)');
	if (!multi && currencyAfter !== contractCurrency && policyAfter === 'fixed' && !contract.fx_invoice_rates.length && !newRates.length) {
		p.error('change.fx_invoice_rates', 'Con tipo de cambio fijo indica al menos una tasa contrato → moneda de factura');
	}
	if (multi && policyAfter === 'fixed') {
		// Multimoneda: una tasa por cada par nuevo (400 con el par faltante); la cobertura por período se bloquea por factura más abajo.
		const known = [...contract.fx_invoice_rates, ...newRates];

		for (const code of converting) {
			const covered = known.some(
				(rate) =>
					(upperCode(rate.from_currency) === code && upperCode(rate.to_currency) === currencyAfter) ||
					(upperCode(rate.from_currency) === currencyAfter && upperCode(rate.to_currency) === code)
			);

			if (!covered)
				p.error(
					'change.fx_invoice_rates',
					`Con tipo de cambio fijo falta la tasa ${code} → ${currencyAfter} (indica from_currency = ${code})`,
					'fixed_fx_without_rate'
				);
		}
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
		const targets: Extract<WriteOp, { kind: 'update_invoices_fx' }>['targets'] = [];
		const keptFx: ChangeInvoiceRow[] = [];

		for (const invoice of pending) {
			// Facturada por OC (fija) o con tasa fijada por factura (manual / neto exacto): conserva su moneda y tasa.
			if (p.skipPartial(invoice)) continue;
			if (hasPerInvoiceFx(invoice)) {
				keptFx.push(invoice);
				continue;
			}
			const periodStart = invoice.lines.map((line) => line.billing_period_start ?? '').sort()[0] || invoice.issue_date || p.effective;

			if (multi) {
				// Multimoneda: cada línea con la tasa de su par (fija) o NULL (spot); el encabezado toma la del único par convertidor.
				const valuation = valuateLinesByPair(
					invoice.lines.map((line) => ({
						id: line.id,
						currency: upperCode(line.currency) || upperCode(invoice.contract_currency) || contractCurrency,
						unit_price: line.unit_price,
						subtotal: line.subtotal,
						tax_amount: line.tax_amount,
						period_start: line.billing_period_start ?? periodStart,
					})),
					currencyAfter,
					(line) => (policyAfter === 'fixed' ? findFixedRate(allRates, line.currency, currencyAfter, line.period_start) : null),
					invoice.tax_rate
				);

				if (policyAfter === 'fixed')
					for (const line of valuation.lines.filter((row) => row.fx === null)) {
						p.block(
							'fixed_fx_without_rate',
							`La factura del ${invoice.issue_date} no tiene tasa ${line.currency} → ${currencyAfter} para el período de una de sus líneas`,
							'Agrega la tasa del par en fx_invoice_rates (con from_currency) o usa tipo de cambio del día'
						);
					}
				targets.push({
					invoice_id: invoice.id,
					fx: valuation.fx,
					lines: valuation.lines.map((line) => ({
						line_id: line.id,
						fx: line.fx,
						amounts:
							line.subtotal === null
								? null
								: { unit_price: line.unit_price!, subtotal: line.subtotal, tax: line.tax!, total: line.total! },
					})),
				});
				p.updatedInvoices.push({
					id: invoice.id,
					invoice_number: invoice.invoice_number,
					issue_date: invoice.issue_date,
					lines_changed: invoice.lines.length,
					subtotal_before: invoice.subtotal,
					subtotal_after: invoice.subtotal,
					change: `moneda ${currencyAfter}${valuation.pairs.length ? `, pares ${valuation.pairs.join(', ')}${valuation.invoice ? ' a tasa fija' : ' (se valorizan al emitir)'}` : ''}`,
				});
				continue;
			}
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
	// Auto-renovación (§9.3.5): `auto_renew` de los ítems recurrentes vivos (sin baja ni renovación); apagado, el job no los propone.
	const autoRenewItems = has('auto_renew') ? liveRecurring(ctx.items).filter((item) => item.auto_renew !== change.auto_renew) : [];

	for (const item of autoRenewItems) {
		p.ops.push({ kind: 'update_item', item_id: item.id, set: { auto_renew: change.auto_renew! } });
		p.itemsAfter.find((row) => row.id === item.id)!.auto_renew = change.auto_renew!;
	}
	if (autoRenewItems.length) {
		before.auto_renew = !change.auto_renew;
		after.auto_renew = change.auto_renew;
		after.auto_renew_items = autoRenewItems.map((item) => item.id);
	}
	// Un documento cambiado solo ya quedó bloqueado (`tax_document_requires_party_change`): se informa el bloqueo, no "sin diferencias".
	const documentBlocked = p.blockers.some((blocker) => blocker.code === TAX_DOCUMENT_REQUIRES_PARTY_CHANGE);

	if (!p.errors.length && !documentBlocked && !Object.keys(p.contractSet).length && !newRates.length && !autoRenewItems.length) {
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
		metadata: {
			changed_fields: changed,
			fields_before: before,
			fields_after: after,
			pending_invoices_updated: p.updatedInvoices.length,
			// Multimoneda: pares de las tasas agregadas.
			...(multi ? { fx_invoice_rate_pairs: [...new Set(newRates.map((rate) => pairKey(rate.from_currency, rate.to_currency)))] } : {}),
		},
	});
}

export function planChangeEntity(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'change_entity');
	const change = req.change;
	const contract = ctx.contract;
	let entity = ctx.new_entity;
	let entityCreated = false;

	p.assertState();
	if (change.client_id)
		p.error(
			'change.client_id',
			'Cambiar el cliente comercial de un contrato activo está fuera de las modificaciones (spec §9.1 #10): solo se cambia la razón social dentro del mismo cliente'
		);
	if (change.new_entity && change.client_entity_id)
		p.error('change.new_entity', 'Indica la razón social existente (client_entity_id) o la nueva (new_entity), no ambas');
	else if (change.new_entity) {
		// §9.3.10: se busca por identificador tributario normalizado en el holding antes de crear.
		const lookup = ctx.entity_lookup ?? null;
		const requested = change.new_entity;

		if (!requested.legal_name?.trim()) p.error('change.new_entity.legal_name', 'Escribe la razón social');
		if (!normalizeTaxId(requested.tax_id)) p.error('change.new_entity.tax_id', 'Escribe el identificador tributario');
		if (!requested.country?.trim()) p.error('change.new_entity.country', 'Escribe el país');
		if (!contract.client_id) p.error('change.new_entity', 'El contrato no tiene cliente comercial al que ligar la razón social');
		if (lookup && !lookup.belongs_to_client) {
			p.block(
				'entity_belongs_to_other_client',
				`La razón social ${lookup.legal_name ?? ''} (${lookup.tax_id ?? requested.tax_id}) ya existe en el holding ligada a otro cliente comercial`.replace(
					/\s+/g,
					' '
				),
				'Cambiar de cliente comercial está fuera de las modificaciones: revisa el identificador tributario'
			);
			entity = null;
		} else if (lookup) {
			p.warn(
				'entity_already_exists',
				`Ya existe la razón social ${lookup.legal_name ?? ''} con el identificador ${lookup.tax_id ?? requested.tax_id}: se usa esa (no se crea otra)`.replace(
					/\s+/g,
					' '
				)
			);
			entity = lookup;
			if (lookup.id === contract.client_entity_id) p.error('change.new_entity.tax_id', 'El contrato ya tiene esa razón social');
		} else if (!p.errors.length) {
			entityCreated = true;
			p.ops.push({
				kind: 'insert_entity',
				entity: {
					client_id: contract.client_id!,
					legal_name: requested.legal_name.trim(),
					tax_id: requested.tax_id.trim(),
					country: requested.country.trim(),
					address: requested.address?.trim() || null,
					email: requested.email?.trim() || null,
					payment_terms: cleanPaymentTerms(requested.payment_terms ?? null),
				},
			});
			entity = {
				id: NEW_ENTITY_KEY,
				legal_name: requested.legal_name.trim(),
				tax_id: requested.tax_id.trim(),
				country: requested.country.trim(),
				belongs_to_client: true,
			};
		}
	} else if (!change.client_entity_id) p.error('change.client_entity_id', 'Indica la razón social nueva (client_entity_id o new_entity)');
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
	// Ronda 4 de Configuración (Domi 03-10): el documento tributario solo cambia junto con la razón social; este es su camino. Con catálogo:
	// `tax_document_type_id` del país de la compañía emisora; sin catálogo: `document_type` (familia) en vez de la derivada por país.
	let newDocument: { id: string; label: string; family: string; rate: TaxDocumentRate } | null = null;

	if (change.tax_document_type_id) {
		if (!ctx.tax_document_type)
			p.error('change.tax_document_type_id', 'El documento tributario no existe o no corresponde al país de la compañía emisora');
		else if (ctx.tax_document_type.id !== contract.tax_document_type_id)
			newDocument = {
				id: ctx.tax_document_type.id,
				label: `${ctx.tax_document_type.code} ${ctx.tax_document_type.name}`,
				family: ctx.tax_document_type.kind === 'export_invoice' ? 'FACTURA_EXPORTACION' : 'FACTURA',
				rate: { kind: ctx.tax_document_type.kind, tax_rate: ctx.tax_document_type.tax_rate ?? null },
			};
	} else if (change.document_type && contract.tax_document_type_id)
		p.error('change.document_type', 'El contrato usa el catálogo de documentos: indica tax_document_type_id');
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
	const familyAfter =
		!contract.tax_document_type_id && change.document_type ? change.document_type : suggestDocumentType(contract.company.country, entity.country);
	const documentChanges = familyAfter !== familyBefore && !contract.tax_document_type_id;
	const retaxed = new Set<string>();
	const newDocumentRate = newDocument ? taxRateFor(newDocument.family, contract, newDocument.rate) : null;

	if (newDocument) {
		// Documento nuevo: el IVA de las Por Emitir desde la fecha efectiva se recalcula con el resolver único (`resolveTaxRate`).
		p.contractSet.tax_document_type_id = newDocument.id;
		p.contractSet.document_type = newDocument.family;
		if (pending.length) {
			p.ops.push({
				kind: 'update_invoices_fields',
				invoice_ids: pending.map((invoice) => invoice.id),
				set: { client_entity_id: entity.id, client_tax_id: entity.tax_id },
			});
			retaxPending(p, pending, newDocument.family, newDocumentRate!);
		}
	} else if (pending.length && documentChanges) {
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

	if (newDocument) docChange = `, documento ${newDocument.label}, IVA ${newDocumentRate} %`;
	else if (familyAfter !== familyBefore) {
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
		description: `La razón social receptora pasa de ${contract.entity.legal_name ?? contract.client_entity_id ?? '—'} a ${entity.legal_name ?? entity.id} desde el ${p.effective}${newDocument ? ` con documento ${newDocument.label}` : ''}; ${pending.length} factura(s) por emitir reasignadas`,
		amount_delta: 0,
		items_affected: [],
		metadata: {
			entity_before: { id: contract.client_entity_id, legal_name: contract.entity.legal_name, tax_id: contract.entity.tax_id },
			entity_after: { id: entity.id, legal_name: entity.legal_name, tax_id: entity.tax_id },
			// §9.3.10: la razón social se creó en el mismo acto (`client_entities` + `client_entity_clients` is_primary = false).
			entity_created: entityCreated,
			pending_invoices_updated: pending.length,
			// Ronda 4: documento tributario cambiado en el mismo acto (antes y después) y el IVA con que quedan las Por Emitir.
			...(newDocument
				? {
						tax_document_before: { id: contract.tax_document_type_id, document_type: contract.document_type },
						tax_document_after: { id: newDocument.id, document_type: newDocument.family, tax_rate: newDocumentRate },
					}
				: {}),
			// Antes de cada Por Emitir reasignada (para revertir o auditar): receptor y su identificador tributario.
			invoices_before: pending.map((invoice) => ({
				id: invoice.id,
				client_entity_id: invoice.client_entity_id,
				client_tax_id: invoice.client_tax_id ?? null,
			})),
		},
	});
}

// ------------------------------------------------------------------ reactivar (§9.3.2)

/**
 * `reactivate { items?[{ item_id, quantity?, unit_price? }] }` (§9.3.2, S2-8/S3-9): sin lista = todo lo que canceló la cancelación del
 * contrato (ítems con el `churn_date` del contrato). Rama por fecha del churn y cierre de período (S5-7):
 * - (a) churn **aún no vigente** (`churn_date > hoy`) → **anular**: se quita el espejo CHURN/DOWNSELL (sin facturas propias), se limpian
 *   `churn_date`/`churn_monthly_amount`, se cancelan las NC de la baja pendientes de emisión electrónica y el generador rehace las PE de lo no cubierto;
 * - (b) **vigente, mes abierto** → **revertir**: igual que (a); las NC ya emitidas quedan (`credit_notes_issued_kept`) y sus días se vuelven
 *   a facturar en PE nuevas;
 * - (c) **mes cerrado** (`churn_date ≤ cierre`) → ítems **REACTIVATION** nuevos desde la fecha efectiva al valor anterior (editable),
 *   clasificados a nivel cliente (`classifyClientItem`: REACTIVATION si todos los contratos activados del cliente están cancelados, si no
 *   UPSELL/CROSS-SELL); facturas del generador.
 * El contrato Cancelado vuelve a `Activo` (explícito). El evento de baja original recibe `metadata.reversed_by`; el nuevo es
 * `CHURN_REVERSED` (a/b) o `REACTIVATION` (c). Bloqueos: `not_cancelled` (nada que reactivar), `period_closed` (rama c en mes cerrado).
 */
export function planReactivate(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'reactivate');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const contract = ctx.contract;
	const contractCancelled = contract.status === CONTRACT_CANCELLED;
	const cutoff = contract.cutoff_date;
	const anchor = anchorDayOf(contract, ctx.items);
	const branches: NonNullable<ChangePreview['reactivation']> = [];
	const reactivationRows: NewItemRow[] = [];
	const cancelledCreditNotes = new Set<string>();
	const restore: Array<{ item: ChangeItemRow; from: string }> = [];
	const refById = new Map(refs.map((ref) => [String(ref.item_id ?? ''), ref]));
	let targets: ChangeItemRow[] = [];
	let mrrDelta = 0;

	p.assertState();
	if (refs.length) {
		for (const [index, ref] of refs.entries()) {
			const item = p.findItem(String(ref.item_id ?? ''), `change.items.${index}.item_id`);

			if (!item) continue;
			if (!item.churn_date || REMOVAL_CATEGORIES.has(item.categoria ?? '') || item.is_recurring === false)
				p.block('not_cancelled', `"${item.product_name}" no tiene una baja que revertir`, 'Elige ítems con baja (churn) registrada');
			else targets.push(item);
		}
	} else if (!contractCancelled) {
		p.block(
			'not_cancelled',
			'El contrato no está cancelado: indica los ítems con baja que vuelven',
			'Usa change.items con los ítems dados de baja que se reactivan'
		);
	} else {
		targets = ctx.items.filter(
			(item) =>
				item.churn_date &&
				item.is_recurring !== false &&
				!REMOVAL_CATEGORIES.has(item.categoria ?? '') &&
				(!contract.churn_date || item.churn_date === contract.churn_date)
		);
		if (!targets.length) p.block('not_cancelled', 'La cancelación no dejó ítems con baja que reactivar');
	}
	const others = ctx.client_contracts ?? [];
	const self = { status: contract.status, churn_date: contract.churn_date ?? null, product_ids: ctx.items.map((item) => item.product_id ?? '') };

	for (const item of targets) {
		const churn = item.churn_date!;
		const ref = refById.get(item.id);
		const mirror =
			ctx.items.find((row) => row.related_item_id === item.id && REMOVAL_CATEGORIES.has(row.categoria ?? '') && row.start_date === churn) ??
			null;
		const monthly = itemMonthly(item);

		if (!cutoff || churn > cutoff) {
			const branch = churn > ctx.today ? 'annul' : 'revert';

			branches.push({ item_id: item.id, branch, churn_date: churn, mirror_item_id: mirror?.id ?? null });
			if (mirror) {
				p.ops.push({ kind: 'delete_item', item_id: mirror.id });
				p.itemsAfter = p.itemsAfter.filter((row) => row.id !== mirror.id);
			}
			p.ops.push({ kind: 'update_item', item_id: item.id, set: { churn_date: null, churn_monthly_amount: null } });
			p.itemsAfter.find((row) => row.id === item.id)!.churn_date = null;
			p.adjusted.push(previewOf({ ...item, churn_date: null }));
			// NC de la baja aún sin emisión electrónica (espejo de la emitida; nacen Emitida, o Por Emitir las previas): se
			// cancelan; las ya emitidas electrónicamente quedan y sus días se vuelven a facturar.
			for (const invoice of ctx.invoices.filter(
				(row) => /^NC$/i.test(row.document_type ?? '') && creditNotePendingEmission(row) && row.is_active
			)) {
				const own = invoice.lines.filter((line) => line.contract_item_id === item.id && (line.billing_period_start ?? '') >= churn);

				if (!own.length) continue;
				if (own.length === invoice.lines.length) {
					p.ops.push({ kind: 'cancel_invoice', invoice_id: invoice.id, note: `Cancelada: se revirtió la baja del ${churn}` });
					p.cancelledInvoices.push({ id: invoice.id, invoice_number: invoice.invoice_number, issue_date: invoice.issue_date });
				} else for (const line of own) p.deleteLine(invoice, line);
				cancelledCreditNotes.add(invoice.id);
			}
			const issuedCredit = ctx.invoices.filter(
				(row) =>
					/^NC$/i.test(row.document_type ?? '') &&
					!creditNotePendingEmission(row) &&
					row.status !== 'Cancelada' &&
					row.is_active &&
					row.lines.some((line) => line.contract_item_id === item.id && (line.billing_period_start ?? '') >= churn)
			);

			if (issuedCredit.length)
				p.warn(
					'credit_notes_issued_kept',
					`${issuedCredit.length === 1 ? 'La NC' : 'Las NC'} ${issuedCredit
						.map((row) => row.invoice_number ?? row.id)
						.join(
							', '
						)} de la baja de "${item.product_name}" ya ${issuedCredit.length === 1 ? 'está emitida y queda' : 'están emitidas y quedan'}: lo acreditado se vuelve a facturar en Por Emitir nuevas`
				);
			restore.push({ item, from: churn });
			mrrDelta += p.toContract(monthly, item.currency, item.start_date ?? churn);
			p.touchRsm(churn);
		} else {
			// (c) mes cerrado: REACTIVATION nuevo desde la fecha efectiva (no se reescribe el pasado cerrado).
			branches.push({ item_id: item.id, branch: 'reactivation', churn_date: churn, mirror_item_id: mirror?.id ?? null });
			p.assertOpenPeriod(p.effective);
			const start = p.effective;
			const end = item.end_date && item.end_date >= start ? item.end_date : itemEndDate(start, num(item.term_months) || 12);
			const term = monthsCeil(start, end);
			const pct = item.discount_type === 'Porcentaje' ? num(item.discount_value) : 0;
			const quantity = ref?.quantity !== undefined && ref?.quantity !== null ? num(ref.quantity) : num(item.quantity) || 1;
			const unit =
				ref?.unit_price !== undefined && ref?.unit_price !== null
					? num(ref.unit_price)
					: num(item.unit_price ?? num(item.annual_unit_price) / 12);
			const ownAnchor = validAnchorDay(item.billing_anchor_day) ? Number(start.slice(8, 10)) : null;
			const months = monthsBetween(start, end, ownAnchor ?? anchor);
			const price = round2(unit * quantity * months);
			const clientCategory = classifyClientItem([...others, self], item.product_id, start);
			const row: NewItemRow = {
				key: p.newKey(),
				product_id: item.product_id,
				product_name: item.product_name ?? 'Producto',
				account: item.account,
				item_type: item.item_type,
				unit_of_measure: item.unit_of_measure,
				categoria: clientCategory === 'UPSELL' || clientCategory === 'CROSS-SELL' ? clientCategory : 'REACTIVATION',
				quantity,
				unit_price: unit,
				annual_unit_price: round6(unit * 12),
				price_entry_mode: 'monthly',
				discount_type: pct > 0 ? 'Porcentaje' : null,
				discount_value: pct,
				price,
				final_price: round2(price * (1 - pct / 100)),
				currency: item.currency ?? contract.contract_currency,
				billing_frequency: item.billing_frequency ?? 'Mensual',
				billing_method: item.billing_method ?? 'Anticipado',
				is_recurring: true,
				start_date: start,
				end_date: end,
				term_months: term,
				related_item_id: item.id,
				renews_item_id: null,
				booking_date: p.effective,
				auto_renew: item.auto_renew,
				price_id: item.price_id,
				quote_item_id: null,
				billing_anchor_day: ownAnchor,
			};

			p.insertItem(row);
			reactivationRows.push(row);
			mrrDelta += p.toContract(round2(unit * quantity * (1 - pct / 100)), item.currency, start);
		}
	}
	p.addRestoredInvoices(restore.flatMap((entry) => p.restoreItemBilling(entry.item, entry.from, cancelledCreditNotes)));
	p.addGeneratedInvoices(reactivationRows, 'cycle');
	p.closeHeaders('Reactivación del contrato');
	if (contractCancelled && targets.length) p.contractSet = { status: 'Activo', churn_date: null, churn_reason_id: null, churn_reason: null };
	// El evento de baja original queda marcado (`metadata.reversed_by`) para auditar la reversión.
	const targetIds = new Set(targets.map((item) => item.id));
	const reversed = (ctx.churn_events ?? []).filter((event) => !event.reversed && event.items_affected.some((id) => targetIds.has(id)));

	if (reversed.length) p.ops.push({ kind: 'mark_events_reversed', event_ids: reversed.map((event) => event.id) });
	p.mrrDelta = round2(mrrDelta);
	p.extras.reactivation = branches;
	const kinds = new Set(branches.map((entry) => entry.branch));
	const type = kinds.has('reactivation') ? 'REACTIVATION' : 'CHURN_REVERSED';

	return p.finish({
		type,
		subtype: kinds.size > 1 ? 'mixed' : ([...kinds][0] ?? null),
		title: type === 'REACTIVATION' ? 'Reactivación (ítems nuevos)' : 'Baja revertida',
		description: `${type === 'REACTIVATION' ? 'Se reactivó' : 'Se revirtió la baja de'} ${targets
			.map((item) => item.product_name)
			.join(', ')}${contractCancelled ? `; ${contract.contract_number ?? 'el contrato'} vuelve a Activo` : ''}: MRR +${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: targets.map((item) => item.id),
		metadata: {
			branches,
			reversed_events: reversed.map((event) => event.id),
			contract_reactivated: contractCancelled && targets.length > 0,
		},
	});
}

// ------------------------------------------------------------------ pausa / reanudación (§9.3.3)

/** Pausas no canceladas de un ítem. */
const pausesOfItem = (ctx: ChangeContext, itemId: string) =>
	(ctx.pauses ?? []).filter((pause) => pause.contract_item_id === itemId && pause.status !== 'cancelled');

/** Ajustes vivos ligados a un ítem (UPSELL/DOWNSELL con `related_item_id`): se pausan y reanudan con él. */
const liveAdjustmentsOf = (ctx: ChangeContext, item: ChangeItemRow, from: string) =>
	ctx.items.filter(
		(row) =>
			row.related_item_id === item.id &&
			DELTA_CATEGORIES.has(row.categoria ?? '') &&
			!row.churn_date &&
			!row.renewed_by_item_id &&
			(row.end_date ?? '9999-12-31') >= from
	);

/** Tramo `[start, end]` de una línea que cae en `[from, to]` (días), o null. */
const overlapOf = (line: ChangeInvoiceLineRow, from: string, to: string) => {
	if (!line.billing_period_end) return null;
	const start = line.billing_period_start ?? line.billing_period_end;
	const os = start > from ? start : from;
	const oe = line.billing_period_end < to ? line.billing_period_end : to;

	if (os > oe) return null;

	return { start, end: line.billing_period_end, os, oe, total: diffDays(start, line.billing_period_end) + 1, paused: diffDays(os, oe) + 1 };
};

/**
 * `pause` (§9.3.3): emitidas (no anuladas) con líneas de los ítems pausados en el tramo → decisión `keep | void` (default `void`), con lo
 * que `void` acredita (neto, días pausados × lo que queda sin NC de descuento). Las Por Emitir no piden decisión: pierden el tramo.
 */
export function pauseDecisionsRequired(ctx: ChangeContext, ranges: Map<string, { from: string; to: string }>): InvoiceDecisionRequired[] {
	const result: InvoiceDecisionRequired[] = [];

	for (const invoice of ctx.invoices.filter(isIssued)) {
		let amount = 0;

		for (const line of invoice.lines) {
			const range = line.contract_item_id ? ranges.get(line.contract_item_id) : undefined;
			const overlap = range ? overlapOf(line, range.from, range.to) : null;

			if (!overlap) continue;
			const remaining = line.subtotal > 0 ? Math.max(0, line.subtotal - num(line.previously_credited)) / line.subtotal : 1;

			amount += line.subtotal * (overlap.paused / overlap.total) * remaining;
		}
		amount = round2(amount);
		if (amount <= 0) continue;
		result.push({
			invoice_id: invoice.id,
			invoice_number: invoice.invoice_number,
			issue_date: invoice.issue_date,
			status_group: 'issued',
			amount_after_effective: amount,
			options: ['keep', 'void'],
			default: 'void',
			reason_hint: `Emitida ${invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`}: ${money(amount)} corresponden a días pausados; anular emite una NC por esos días, conservar no`,
		});
	}

	return result;
}

/**
 * Quita de las facturas el tramo pausado de un ítem: Por Emitir → línea fuera si todo su período cae en la pausa; si la pausa toca un
 * borde o queda dentro, prorrateo por días (el período se corta en el borde; en medio se conserva y baja el monto); consumo registrado se
 * conserva con aviso. Emitida con decisión `void` → NC por los días pausados (sobre lo que queda sin NC de descuento); `keep` → nada.
 */
function pauseItemInInvoices(p: Planner, item: ChangeItemRow, from: string, to: string) {
	for (const invoice of p.ctx.invoices) {
		const lines = invoice.lines.filter((line) => line.contract_item_id === item.id && overlapOf(line, from, to));

		if (!lines.length) continue;
		if (isEditablePending(invoice)) {
			if (p.skipPartial(invoice)) continue;
			for (const line of lines) {
				const overlap = overlapOf(line, from, to)!;

				if (overlap.paused >= overlap.total) {
					p.deleteLine(invoice, line);
					continue;
				}
				if (isConsumptionLine(line)) {
					p.warn(
						'consumption_line_kept',
						`La factura ${invoice.invoice_number ?? invoice.issue_date ?? invoice.id} lleva el consumo registrado de "${line.description ?? line.id}" (${line.quantity}): se conserva sin prorratear`
					);
					continue;
				}
				const kept = overlap.total - overlap.paused;
				const ratio = kept / overlap.total;
				const subtotal = round2(line.subtotal * ratio);
				const tax = round2((subtotal * invoice.tax_rate) / 100);

				p.updateLine(
					invoice,
					line,
					{
						quantity: line.quantity,
						unit_price: round6(line.unit_price * ratio),
						discount_pct: line.discount_pct,
						subtotal,
						tax_amount: tax,
						total: round2(subtotal + tax),
						// Pausa en un borde: el período se corta; en medio del período se conserva y solo baja el monto.
						...(overlap.os === overlap.start ? { billing_period_start: addDays(overlap.oe, 1) } : {}),
						...(overlap.oe === overlap.end ? { billing_period_end: addDays(overlap.os, -1) } : {}),
						description_suffix: ` (sin los días pausados del ${overlap.os} al ${overlap.oe}: ${kept}/${overlap.total} días)`,
					},
					'línea prorrateada por pausa'
				);
			}
		} else if (isIssued(invoice) && p.invoiceDecisions.get(invoice.id) === 'void') {
			const mirror = lines
				.map((line) => {
					const overlap = overlapOf(line, from, to)!;
					const remaining = line.subtotal > 0 ? Math.max(0, line.subtotal - num(line.previously_credited)) / line.subtotal : 1;

					return { line, ratio: (overlap.paused / overlap.total) * remaining, period_start: overlap.os };
				})
				.filter((entry) => entry.ratio > 0);
			const amount = round2(mirror.reduce((sum, entry) => sum + entry.line.subtotal * entry.ratio, 0));

			if (amount <= 0) continue;
			p.ops.push({
				kind: 'credit_note',
				mirrors: invoice,
				lines: mirror,
				note: `NC por pausa del servicio de "${item.product_name ?? 'Producto'}" (${from} a ${to}); factura original ${invoice.invoice_number ?? invoice.id}`,
			});
			p.creditNotes.push({
				mirrors_invoice_id: invoice.id,
				mirrors_invoice_number: invoice.invoice_number,
				total: round2(amount * (1 + invoice.tax_rate / 100)),
				currency: invoice.invoice_currency,
				fx: invoice.fx,
			});
		}
	}
}

/**
 * Corre el fin de un ítem `days` días (§9.3.3 `extend_term`): `update_item.end_date` + `adjusted` (el cierre mueve el fin del contrato si
 * es el más próximo, con bypass y evento). Días positivos → las Por Emitir del tramo nuevo con el generador (solo los días sin factura);
 * negativos → baja de las líneas desde el nuevo fin. Devuelve el ítem con el fin nuevo.
 */
function shiftItemEnd(p: Planner, item: ChangeItemRow, days: number): ChangeItemRow {
	const after = p.itemsAfter.find((row) => row.id === item.id)!;

	if (!days || !after.end_date) return after;
	const oldEnd = after.end_date;
	const newEnd = addDays(oldEnd, days);

	p.ops.push({ kind: 'update_item', item_id: item.id, set: { end_date: newEnd } });
	after.end_date = newEnd;
	p.adjusted.push(previewOf(after));
	p.touchRsm(days > 0 ? addDays(oldEnd, 1) : addDays(newEnd, 1));
	if (days < 0) p.removeItemFromInvoices(after, addDays(newEnd, 1), 'reanudación anticipada');

	return after;
}

/**
 * `pause { items?[], pause_start?, pause_end?, extend_term? }` (§9.3.3): por ítem (sin lista = todos los recurrentes vivos), `scope
 * service`. Fila en `contract_item_pauses` por ítem (y por sus ajustes vivos); Por Emitir del tramo sin sus líneas (prorrateo por días en los
 * bordes, vacía → Cancelada); emitidas que cubren el tramo → decisión `keep | void` (`invoice_decisions`, default `void`); RSM con devengo y
 * MRR 0 en el tramo (asset). `extend_term` con fin conocido corre el fin del ítem en el acto (pausa abierta: al reanudar). La fecha efectiva
 * es `pause_start`. Bloqueos: `item_already_paused`, `pause_overlaps`, `period_closed`, `invoice_decision_required`.
 */
/**
 * D3/MF-h (decisión de Domi 01-10): los ajustes vivos (UPSELL/DOWNSELL con `related_item_id`) terminan con su ítem original. Cuando el fin del
 * original cambia en la operación (extend_term al pausar o reanudar), el de cada ajuste vivo se lleva al mismo fin en el acto: los alineados
 * ya se corrieron los mismos días (no hay nada que hacer); uno desalineado (legado) se corre lo que falte, con su tramo facturado o quitado.
 */
function alignAdjustmentEnds(p: Planner, parentIds: Set<string>, restored: PreviewInvoice[]) {
	for (const child of p.itemsAfter) {
		if (!child.related_item_id || !parentIds.has(child.related_item_id) || !DELTA_CATEGORIES.has(child.categoria ?? '')) continue;
		if (child.churn_date || child.renewed_by_item_id || !child.end_date) continue;
		const parent = p.itemsAfter.find((row) => row.id === child.related_item_id);

		if (!parent?.end_date || parent.end_date === child.end_date || child.end_date < (child.start_date ?? '')) continue;
		const days = diffDays(child.end_date, parent.end_date);
		const oldEnd = child.end_date;
		const shifted = shiftItemEnd(p, child, days);

		if (days > 0) restored.push(...p.restoreItemBilling(shifted, addDays(oldEnd, 1), new Set()));
	}
}

export function planPause(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const pauseStart = req.change.pause_start ?? req.effective_date;
	const pauseEnd = req.change.pause_end ?? null;
	const extendTerm = req.change.extend_term === true;
	const p = new Planner(ctx, { ...req, effective_date: pauseStart }, 'pause');
	const refs = (req.change.items ?? []) as Array<{ item_id?: string }>;
	const targets: ChangeItemRow[] = [];
	const previews: PausePreview[] = [];
	let mrrDelta = 0;

	p.assertState();
	p.assertOpenPeriod(pauseStart, 'El inicio de la pausa');
	if (pauseEnd && pauseEnd < pauseStart) p.error('change.pause_end', 'El fin de la pausa no puede ser anterior a su inicio');
	if (refs.length) {
		for (const [index, ref] of refs.entries()) {
			const item = p.findItem(String(ref.item_id ?? ''), `change.items.${index}.item_id`);

			if (!item) continue;
			if (item.is_recurring === false) p.error(`change.items.${index}.item_id`, `"${item.product_name}" no es recurrente: no se pausa`);
			else if (p.assertRemovable(item)) targets.push(item);
		}
	} else {
		targets.push(
			...liveRecurring(ctx.items).filter(
				(item) => !(item.related_item_id && DELTA_CATEGORIES.has(item.categoria ?? '')) && (item.end_date ?? '9999-12-31') >= pauseStart
			)
		);
		if (!targets.length) p.error('change.items', 'El contrato no tiene ítems recurrentes vivos que pausar');
	}
	// Cada ítem con sus ajustes vivos (mismo tramo): el MRR del producto completo queda en 0.
	const withChildren = [...targets, ...targets.flatMap((item) => liveAdjustmentsOf(ctx, item, pauseStart))].filter(
		(item, index, list) => list.findIndex((row) => row.id === item.id) === index
	);
	const ranges = new Map<string, { from: string; to: string }>();

	p.extras.effective_date_suggestions = effectiveDateSuggestions(ctx, withChildren, pauseStart, 'pause');
	for (const item of withChildren) {
		const field = `change.items.${Math.max(0, targets.indexOf(item))}`;

		if (item.start_date && item.start_date > pauseStart) {
			p.error(`${field}.item_id`, `"${item.product_name}" empieza el ${item.start_date}: la pausa no puede empezar antes`);
			continue;
		}
		if (item.end_date && item.end_date < pauseStart) {
			p.error(`${field}.item_id`, `"${item.product_name}" terminó el ${item.end_date}: no hay servicio que pausar`);
			continue;
		}
		if (item.end_date && pauseEnd && pauseEnd > item.end_date) {
			p.error('change.pause_end', `La pausa termina después del fin de "${item.product_name}" (${item.end_date})`);
			continue;
		}
		const existing = pausesOfItem(ctx, item.id);
		const rangeEnd = pauseEnd ?? item.end_date ?? '9999-12-31';

		if (existing.some((pause) => pause.pause_end === null))
			p.block(
				'item_already_paused',
				`"${item.product_name}" ya está pausado (desde el ${existing.find((pause) => pause.pause_end === null)!.pause_start}, sin fin)`,
				'Reanúdalo (resume) antes de pausarlo de nuevo'
			);
		else if (existing.some((pause) => pause.pause_start <= rangeEnd && (pause.pause_end ?? '9999-12-31') >= pauseStart))
			p.block(
				'pause_overlaps',
				`La pausa de "${item.product_name}" se cruza con otra (${existing
					.filter((pause) => pause.pause_start <= rangeEnd && (pause.pause_end ?? '9999-12-31') >= pauseStart)
					.map((pause) => `${pause.pause_start} a ${pause.pause_end ?? 'sin fin'}`)
					.join(', ')})`,
				'Ajusta las fechas para que no se crucen'
			);
		ranges.set(item.id, { from: pauseStart, to: item.end_date && rangeEnd > item.end_date ? item.end_date : rangeEnd });
	}
	// Decisión por emitida que cubre el tramo (misma mecánica que contract_cancel, §9.3.1).
	const required = pauseDecisionsRequired(ctx, ranges);
	const byId = new Map(required.map((entry) => [entry.invoice_id, entry]));
	const sent = new Map<string, InvoiceDecisionAction>();

	for (const [index, decision] of (req.change.invoice_decisions ?? []).entries()) {
		const entry = byId.get(decision.invoice_id);

		if (!entry) p.error(`change.invoice_decisions.${index}.invoice_id`, 'La factura no está entre las emitidas que cubren la pausa');
		else if (!entry.options.includes(decision.action))
			p.error(`change.invoice_decisions.${index}.action`, 'Para una factura emitida la decisión es keep o void');
		else sent.set(decision.invoice_id, decision.action);
	}
	const missing = required.filter((entry) => !sent.has(entry.invoice_id));

	if (missing.length)
		p.block(
			'invoice_decision_required',
			`Decide qué hacer con ${missing.length === 1 ? 'la factura emitida' : 'las facturas emitidas'} ${missing
				.map((entry) => entry.invoice_number ?? `del ${entry.issue_date ?? entry.invoice_id}`)
				.join(', ')} que ${missing.length === 1 ? 'cubre' : 'cubren'} días pausados`,
			'Elige conservar (keep) o anular esos días con NC (void) en change.invoice_decisions'
		);
	for (const entry of required) p.invoiceDecisions.set(entry.invoice_id, sent.get(entry.invoice_id) ?? entry.default);
	p.assertNoUnified(new Set(ranges.keys()), pauseStart);
	const restored: PreviewInvoice[] = [];

	for (const item of withChildren) {
		const range = ranges.get(item.id);

		if (!range) continue;
		p.ops.push({
			kind: 'insert_pause',
			pause: {
				contract_item_id: item.id,
				pause_start: pauseStart,
				pause_end: pauseEnd,
				extend_term: extendTerm,
				status: pauseStart > ctx.today ? 'scheduled' : 'active',
				reason: req.reason?.trim() || null,
			},
		});
		p.pausesAfter.push({ contract_item_id: item.id, pause_start: pauseStart, pause_end: pauseEnd, status: 'active' });
		pauseItemInInvoices(p, item, range.from, range.to);
		const days = pauseEnd ? diffDays(pauseStart, pauseEnd) + 1 : null;
		let after = p.itemsAfter.find((row) => row.id === item.id)!;

		// Fin conocido + extend_term: el fin se corre en el acto (abierta: al reanudar) y el tramo nuevo se factura con el generador.
		if (extendTerm && days && item.end_date) {
			const oldEnd = item.end_date;

			after = shiftItemEnd(p, item, days);
			restored.push(...p.restoreItemBilling(after, addDays(oldEnd, 1), new Set()));
		}
		previews.push({
			item_id: item.id,
			product_name: item.product_name,
			pause_id: null,
			pause_start: pauseStart,
			pause_end_before: null,
			pause_end: pauseEnd,
			status: pauseStart > ctx.today ? 'scheduled' : 'active',
			extend_term: extendTerm,
			days_paused: days,
			end_date_before: item.end_date,
			end_date_after: after.end_date,
		});
		mrrDelta -= p.toContract(itemMonthly(item), item.currency, item.start_date ?? pauseStart);
	}
	if (extendTerm) alignAdjustmentEnds(p, new Set(targets.map((item) => item.id)), restored);
	p.addRestoredInvoices(restored);
	p.closeHeaders(`Pausa del servicio desde el ${pauseStart}`);
	p.touchRsm(pauseStart);
	if (pauseEnd === null && extendTerm)
		p.warn('extend_term_on_resume', 'La pausa no tiene fin: el plazo se extiende en los días pausados al reanudar');
	p.mrrDelta = round2(mrrDelta);
	p.extras.pauses = previews;
	p.extras.invoice_decisions_required = required.map((entry) => ({ ...entry, action: p.invoiceDecisions.get(entry.invoice_id) ?? entry.default }));
	const names = targets.map((item) => item.product_name).join(', ');

	return p.finish({
		type: 'PAUSE',
		subtype: pauseEnd ? 'fixed' : 'open',
		title: 'Pausa del servicio',
		description: `Se pausó ${names} desde el ${pauseStart}${pauseEnd ? ` hasta el ${pauseEnd}` : ' hasta reanudar'}${
			extendTerm ? ' (extiende el plazo)' : ''
		}: MRR ${ctx.contract.contract_currency} ${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: withChildren.filter((item) => ranges.has(item.id)).map((item) => item.id),
		metadata: {
			pause_start: pauseStart,
			pause_end: pauseEnd,
			extend_term: extendTerm,
			pauses: previews,
			invoice_decisions: required.map((entry) => ({
				invoice_id: entry.invoice_id,
				invoice_number: entry.invoice_number,
				action: p.invoiceDecisions.get(entry.invoice_id) ?? entry.default,
				defaulted: !sent.has(entry.invoice_id),
				amount_after_effective: entry.amount_after_effective,
			})),
		},
	});
}

/**
 * `resume { items?[], resume_date? }` (§9.3.3): cierra la pausa vigente o futura de cada ítem (sin lista = todos los pausados):
 * `pause_end = resume_date − 1` (`ended`; una pausa que aún no empezaba queda `cancelled`), rehace las Por Emitir desde la reanudación
 * (solo los días sin factura, F1/F3) y con `extend_term` corre el fin del ítem en los días pausados (descontando lo ya corrido al pausar
 * con fin conocido). La fecha efectiva es `resume_date`. Bloqueos: `not_paused`, `period_closed`.
 */
export function planResume(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const resumeDate = req.change.resume_date ?? req.effective_date;
	const p = new Planner(ctx, { ...req, effective_date: resumeDate }, 'resume');
	const refs = (req.change.items ?? []) as Array<{ item_id?: string }>;
	const lastPaused = addDays(resumeDate, -1);
	const openPause = (itemId: string) =>
		pausesOfItem(ctx, itemId).find((pause) => pause.status !== 'ended' && (pause.pause_end === null || pause.pause_end >= resumeDate)) ?? null;
	const targets: Array<{ item: ChangeItemRow; pause: ItemPauseRow }> = [];
	const previews: PausePreview[] = [];
	const restored: PreviewInvoice[] = [];
	let mrrDelta = 0;

	p.assertState();
	p.assertOpenPeriod(resumeDate, 'La reanudación');
	const add = (item: ChangeItemRow) => {
		const pause = openPause(item.id);

		if (pause && !targets.some((entry) => entry.item.id === item.id)) targets.push({ item, pause });

		return pause;
	};

	if (refs.length) {
		for (const [index, ref] of refs.entries()) {
			const item = p.findItem(String(ref.item_id ?? ''), `change.items.${index}.item_id`);

			if (!item) continue;
			if (!add(item)) p.block('not_paused', `"${item.product_name}" no tiene una pausa vigente o futura que cerrar al ${resumeDate}`);
			for (const child of liveAdjustmentsOf(ctx, item, resumeDate)) add(child);
		}
	} else {
		for (const item of ctx.items) add(item);
		if (!targets.length)
			p.block('not_paused', 'El contrato no tiene ítems con una pausa vigente o futura', 'Pausa primero (change.type = pause)');
	}
	for (const { item, pause } of targets) {
		const cancelled = pause.pause_start > lastPaused;
		const days = cancelled ? 0 : diffDays(pause.pause_start, lastPaused) + 1;
		// Con fin conocido y extend_term el fin ya se corrió al pausar: aquí solo la diferencia (reanudar antes la devuelve).
		const shifted = pause.extend_term && pause.pause_end ? diffDays(pause.pause_start, pause.pause_end) + 1 : 0;
		const delta = pause.extend_term ? days - shifted : 0;

		p.ops.push({
			kind: 'update_pause',
			id: pause.id,
			set: { pause_end: cancelled ? pause.pause_end : lastPaused, status: cancelled ? 'cancelled' : 'ended' },
		});
		const afterPause = p.pausesAfter.find(
			(row) => row.contract_item_id === item.id && row.pause_start === pause.pause_start && row.status !== 'cancelled'
		);

		if (afterPause) {
			afterPause.status = cancelled ? 'cancelled' : 'ended';
			if (!cancelled) afterPause.pause_end = lastPaused;
		}
		if (cancelled) p.warn('pause_cancelled', `La pausa de "${item.product_name}" aún no empezaba (${pause.pause_start}): queda cancelada`);
		const after = shiftItemEnd(p, item, delta);

		// Por Emitir desde la reanudación (los días que ninguna factura cubre: los que la pausa quitó y el tramo extendido).
		restored.push(...p.restoreItemBilling(after, resumeDate, new Set()));
		previews.push({
			item_id: item.id,
			product_name: item.product_name,
			pause_id: pause.id,
			pause_start: pause.pause_start,
			pause_end_before: pause.pause_end,
			pause_end: cancelled ? pause.pause_end : lastPaused,
			status: cancelled ? 'cancelled' : 'ended',
			extend_term: pause.extend_term,
			days_paused: days,
			end_date_before: item.end_date,
			end_date_after: after.end_date,
		});
		if (isItemPausedOn(ctx.pauses, item.id, resumeDate) || pause.pause_start <= resumeDate)
			mrrDelta += p.toContract(itemMonthly(item), item.currency, item.start_date ?? resumeDate);
	}
	if (targets.some((entry) => entry.pause.extend_term))
		alignAdjustmentEnds(p, new Set(targets.filter((entry) => !entry.item.related_item_id).map((entry) => entry.item.id)), restored);
	p.addRestoredInvoices(restored);
	p.closeHeaders(`Reanudación del servicio desde el ${resumeDate}`);
	p.touchRsm(resumeDate);
	p.mrrDelta = round2(mrrDelta);
	p.extras.pauses = previews;
	const names = targets.filter((entry) => !entry.item.related_item_id).map((entry) => entry.item.product_name);

	return p.finish({
		type: 'RESUME',
		subtype: targets.some((entry) => entry.pause.extend_term) ? 'extend_term' : null,
		title: 'Reanudación del servicio',
		description: `Se reanudó ${(names.length ? names : targets.map((entry) => entry.item.product_name)).join(', ')} desde el ${resumeDate}: MRR ${
			ctx.contract.contract_currency
		} +${money(mrrDelta)}`,
		amount_delta: round2(mrrDelta),
		items_affected: targets.map((entry) => entry.item.id),
		metadata: { resume_date: resumeDate, pauses: previews },
	});
}

/** Campos que corrige `item_update` ("Corregir un dato mal cargado", §9.2 / F4). */
export const ITEM_CORRECTION_FIELDS = [
	'account',
	'product_name',
	'item_type',
	'quantity',
	'unit_price',
	'price_entry_mode',
	'discount_value',
	'start_date',
] as const;
export type ItemCorrectionField = (typeof ITEM_CORRECTION_FIELDS)[number];
/** Campos que cambian el valor del ítem: reescriben las Por Emitir, reconstruyen el devengo y piden el período del mes abierto. */
const COMMERCIAL_CORRECTION_FIELDS = new Set<ItemCorrectionField>(['quantity', 'unit_price', 'price_entry_mode', 'discount_value']);
export const CORRECTION_FIELD_LABELS: Record<ItemCorrectionField, string> = {
	account: 'cuenta',
	product_name: 'glosa',
	item_type: 'tipo',
	quantity: 'cantidad',
	unit_price: 'precio',
	price_entry_mode: 'precio ingresado',
	discount_value: 'descuento',
	start_date: 'fecha de inicio',
};
export const CORRECTION_NEXT_STEP = 'Usa "Cambió el precio o la cantidad" para cambiar el acuerdo desde una fecha';

/** Valores corregidos de una línea (cantidad, unitario del período, descuento, neto y desglose con el descuento puntual). */
interface LineCorrection {
	quantity: number;
	unit_price: number;
	discount_pct: number;
	subtotal: number;
	pricing_breakdown: PricedSubline[] | null;
}

/** Valores comerciales del ítem antes y después de la corrección (unitario mensual, descuento %). */
interface CorrectionValues {
	quantity: number;
	unit: number;
	pct: number;
	quantity_changed: boolean;
	unit_changed: boolean;
	pct_given: boolean;
}

/**
 * La línea de un período del ítem con los valores corregidos: cantidad nueva (la registrada si es de consumo), unitario del período
 * escalado al unitario nuevo (conserva el prorrateo de la línea), descuento del ítem y, si la línea tiene descuento puntual (spec
 * facturas §3.4), ese descuento sobre el neto nuevo (% o monto, como se ingresó) con el porcentaje efectivo combinado.
 */
export function correctedLine(
	line: ChangeInvoiceLineRow,
	before: Pick<CorrectionValues, 'unit'>,
	after: CorrectionValues,
	anchor: number
): LineCorrection {
	const quantity = isConsumptionLine(line) || !after.quantity_changed ? num(line.quantity) : after.quantity;
	const unit = !after.unit_changed
		? num(line.unit_price)
		: before.unit > 0
			? round6((num(line.unit_price) * after.unit) / before.unit)
			: round6(after.unit * monthsBetween(line.billing_period_start ?? '', line.billing_period_end ?? '', anchor));
	const oneOff = oneOffOf(line.pricing_breakdown);
	const basePct = after.pct_given ? after.pct : num(oneOff?.base_discount_pct ?? line.discount_pct);
	const gross = quantity * unit;
	const base = round2(gross * (1 - basePct / 100));

	if (!oneOff) return { quantity, unit_price: unit, discount_pct: round6(basePct), subtotal: base, pricing_breakdown: null };
	const { total: _total, ...subline } = oneOff;
	const amount =
		subline.one_off_type === 'pct' && subline.one_off_value !== undefined && subline.one_off_value !== null
			? round2((base * num(subline.one_off_value)) / 100)
			: Math.abs(num(_total));
	const subtotal = round2(base - amount);

	return {
		quantity,
		unit_price: unit,
		discount_pct: gross > 0 ? round6((1 - subtotal / gross) * 100) : round6(basePct),
		subtotal,
		pricing_breakdown: [...(withoutOneOff(line.pricing_breakdown) ?? []), { ...subline, amount: -amount }],
	};
}

/** Reparte `total` en `n` partes que suman exacto (redondeo telescópico: parte k = r(total·k/n) − r(total·(k−1)/n)). */
export const telescopicShares = (total: number, n: number): number[] =>
	Array.from({ length: n }, (_, index) => round2(round2((total * (index + 1)) / n) - round2((total * index) / n)));

/** Diferencia de lo emitido de un ítem corregido y cómo se reparte (preview de `item_update`). */
export interface IssuedDifferencePreview {
	item_id: string;
	product_name: string | null;
	currency: string | null;
	/** Σ (lo que debió emitirse con los valores corregidos − lo emitido), en la moneda del ítem. */
	amount: number;
	issued_invoices: Array<{
		invoice_id: string;
		invoice_number: string | null;
		issue_date: string | null;
		issued: number;
		expected: number;
		difference: number;
	}>;
	distributed_over: Array<{ invoice_id: string; invoice_number: string | null; issue_date: string | null; amount: number }>;
}

const invoiceName = (invoice: Pick<ChangeInvoiceRow, 'invoice_number' | 'issue_date' | 'id'>) =>
	invoice.invoice_number ?? `del ${invoice.issue_date ?? invoice.id}`;

/** "Ya existe la factura F-0123 emitida por este ítem: la diferencia de USD 120,00 se distribuye entre las 3 facturas por emitir. …" */
export function issuedDifferenceSentence(
	difference: Pick<IssuedDifferencePreview, 'amount' | 'currency' | 'issued_invoices' | 'distributed_over'>,
	subject = 'este ítem'
) {
	const numbers = difference.issued_invoices.map((row) => row.invoice_number ?? `del ${row.issue_date ?? ''}`);
	const shown =
		numbers.length > 3
			? `${numbers.slice(0, 3).join(', ')} y ${numbers.length - 3} más`
			: numbers.length > 1
				? `${numbers.slice(0, -1).join(', ')} y ${numbers.at(-1)}`
				: numbers[0];
	const pending = difference.distributed_over.length;

	return `${numbers.length === 1 ? `Ya existe la factura ${shown} emitida` : `Ya existen las facturas ${shown} emitidas`} por ${subject}: la diferencia de ${
		difference.currency ? `${difference.currency} ` : ''
	}${money(difference.amount)} se distribuye entre ${pending === 1 ? 'la factura por emitir' : `las ${pending} facturas por emitir`}. Si lo que quieres es cambiar el acuerdo desde una fecha, usa Cambió el precio o la cantidad`;
}

/**
 * `item_update` = "Corregir un dato mal cargado" (§9.2, F4; decisión de Domi 01-10, el "editar ítem" de la app vieja). Es una
 * **corrección**, no una modificación: el ítem se reescribe en su lugar (sin ítem espejo, sin UPSELL/DOWNSELL, misma `categoria` y
 * `booking_date`). Campos: `account`, `product_name` (glosa del ítem), `item_type`, `quantity`, `unit_price`, `price_entry_mode`,
 * `discount_value` (%).
 * - Datos (cuenta, glosa, tipo): sin precios ni devengo; las Por Emitir del ítem con glosa generada se regeneran (aviso
 *   `pending_descriptions_updated`); aviso `possible_duplicate` (mismo producto y cuenta con el mismo inicio).
 * - Valor (cantidad, precio, descuento; un ítem por cambio, sin modelo de precio ni espejos de baja): el mes de la fecha efectiva debe
 *   estar abierto (`period_closed`); `monthly_price`/`final_price`/`total_value` con `itemPricing` + `pricingFields`; devengo
 *   reconstruido desde el primer mes del contrato. Las Por Emitir del ítem se reescriben con los valores corregidos respetando lo hecho
 *   a mano (línea editada, consumo registrado, glosa escrita a mano, descuento puntual, tasa fijada por factura; aviso
 *   `correction_overrides_preserved`). Las emitidas no se tocan: la diferencia entre lo emitido y lo que debió emitirse se reparte
 *   (telescópico) entre las Por Emitir del ítem como ajuste con su motivo en `invoice_adjustments` (`correction`); `issued_difference`
 *   y aviso `issued_difference_distributed`. Sin Por Emitir donde repartir → `no_pending_invoices_for_correction`.
 * - Fecha de inicio (`start_date`, caso CTR-2026-191, decisión 07-10; un ítem por cambio, sin valor en el mismo paso): reglas en
 *   `startCorrectionSet` (recurrente, ≤ fin, ciclo propio/del contrato, mes abierto) y facturas en `moveItemStartInvoices` (bloqueo
 *   `issued_invoice_before_start` si una emitida vigente cobra antes del nuevo inicio; Por Emitir anteriores quitadas o canceladas; el
 *   primer período prorrateado como al crear; al adelantar, se generan las Por Emitir del tramo que falta). `term_months`, `price` y
 *   `final_price` siguen a los meses nuevos; devengo reconstruido desde el inicio más temprano; evento con `subtype: 'start'`.
 * Bloqueo `item_not_found`. Evento `ITEM_CORRECTED` con `metadata.items[{ item_id, product_name, changes[{ field, before, after }] }]`.
 */
export function planItemUpdate(ctx: ChangeContext, req: ContractChangeRequestDto): ChangePlan {
	const p = new Planner(ctx, req, 'item_update');
	const refs = (req.change.items ?? []) as Array<Record<string, unknown>>;
	const seen = new Set<string>();
	const entries: Array<{
		item: ChangeItemRow;
		field: string;
		changes: ItemCorrectionChange[];
		set: ItemUpdateSet;
		values: CorrectionValues | null;
		start: string | null;
	}> = [];
	const anchor = anchorDayOf(ctx.contract, ctx.items);

	p.assertState();
	for (const [index, ref] of refs.entries()) {
		const field = `change.items.${index}`;
		const itemId = String(ref.item_id ?? '');

		if (!ITEM_CORRECTION_FIELDS.some((name) => name in ref)) {
			p.error(field, 'Indica al menos un dato a corregir del ítem (cuenta, glosa, tipo, cantidad, precio, descuento o fecha de inicio)');
			continue;
		}
		if (seen.has(itemId)) {
			p.error(`${field}.item_id`, 'El ítem está repetido en el cambio');
			continue;
		}
		seen.add(itemId);
		const item = ctx.items.find((row) => row.id === itemId);

		if (!item) {
			p.block('item_not_found', `El ítem ${itemId} no pertenece al contrato`, 'Recarga el contrato y elige el ítem de nuevo');
			continue;
		}
		const parsed = parseCorrection(p, item, ref, field);

		if (!parsed) continue;
		if (!parsed.changes.length) {
			p.error(field, `"${item.product_name}" ya tiene esos datos: no hay nada que corregir`);
			continue;
		}
		entries.push({ item, field, ...parsed });
	}
	const commercial = entries.filter((entry) => entry.values);
	const moves = entries.filter((entry) => entry.start);

	if (commercial.length > 1) p.error('change.items', 'Corrige la cantidad, el precio o el descuento de un ítem a la vez');
	// Fecha de inicio (CTR-2026-191): un ítem por cambio y sola o con datos (cuenta, glosa, tipo), nunca junto al valor.
	if (moves.length > 1 || (moves.length && commercial.length))
		p.error('change.items', 'Corrige la fecha de inicio de un ítem a la vez, sin cambiar en el mismo paso la cantidad, el precio o el descuento');
	else
		for (const entry of moves) {
			const extra = startCorrectionSet(p, entry.item, entry.start!, entry.field, anchor);

			if (extra) Object.assign(entry.set, extra);
		}
	for (const entry of entries) {
		p.ops.push({ kind: 'update_item', item_id: entry.item.id, set: entry.set });
		const row = p.itemsAfter.find((candidate) => candidate.id === entry.item.id)!;

		Object.assign(row, entry.set);
		if (entry.values || entry.set.start_date) p.adjusted.push(previewOf(row));
	}
	// El duplicado se mira contra los ítems ya con las cuentas nuevas (dos ítems del cambio pueden chocar entre sí), salvo los que se mueven
	// juntos desde la misma cuenta (el producto completo con sus ajustes y renovaciones: ya eran un solo producto).
	const accountOf = new Map(
		entries
			.filter((entry) => entry.changes.some((change) => change.field === 'account'))
			.map((entry) => [entry.item.id, { before: entry.item.account?.trim() || null, after: entry.set.account ?? null }])
	);

	for (const [itemId, account] of accountOf) {
		const item = ctx.items.find((row) => row.id === itemId)!;

		warnPossibleDuplicate(
			p,
			p.itemsAfter.filter(
				(row) => accountOf.get(row.id)?.before !== account.before || accountOf.get(row.id)?.after !== account.after || row.id === itemId
			),
			{ id: itemId, product_id: item.product_id, product_name: item.product_name, account: account.after, start_date: item.start_date }
		);
	}
	let issuedDifference: IssuedDifferencePreview | null = null;
	const preserved: string[] = [];

	for (const entry of commercial.slice(0, 1)) {
		p.assertOpenPeriod(month(p.effective), 'El mes de la corrección');
		issuedDifference = correctItemInvoices(
			p,
			entry.item,
			entry.values!,
			anchor,
			preserved,
			entries.length === 1 ? 'este ítem' : `"${entry.item.product_name}"`
		);
		// Corrección: el devengo del contrato se reconstruye completo (desde el primer mes; los cerrados se saltan).
		const first = ctx.items
			.map((item) => item.start_date)
			.filter((date): date is string => Boolean(date))
			.sort()[0];

		p.touchRsm(first ?? entry.item.start_date ?? p.effective);
	}
	for (const entry of moves.filter((candidate) => candidate.set.start_date)) {
		const row = p.itemsAfter.find((candidate) => candidate.id === entry.item.id)!;
		const start = entry.set.start_date!;

		moveItemStartInvoices(p, entry.item, row, anchor);
		// El devengo se reconstruye desde el mes del inicio más temprano (antes o después de corregirlo).
		p.touchRsm(start < entry.item.start_date! ? start : entry.item.start_date!);
		warnPossibleDuplicate(p, p.itemsAfter, {
			id: row.id,
			product_id: row.product_id,
			product_name: row.product_name,
			account: row.account?.trim() || null,
			start_date: start,
		});
	}
	p.closeHeaders('Corrección de un dato mal cargado');
	if (preserved.length)
		p.warn('correction_overrides_preserved', `Se respetan los ajustes hechos en las facturas por emitir: ${[...new Set(preserved)].join('; ')}`);
	// La glosa se regenera si cambió un dato o el valor; mover solo el inicio no cambia la glosa de las Por Emitir que quedan.
	const changedIds = new Set(
		entries.filter((entry) => entry.changes.some((change) => change.field !== 'start_date')).map((entry) => entry.item.id)
	);
	const lineIds = ctx.invoices
		.filter((invoice) => isEditablePending(invoice) && !hasErpDraft(invoice))
		.flatMap((invoice) => {
			const visible = new Set(invoice.lines.map((line) => line.visible_line_id).filter(Boolean));

			return invoice.lines.filter(
				(line) =>
					line.contract_item_id !== null &&
					changedIds.has(line.contract_item_id) &&
					line.description_locked !== true &&
					line.quantity_source !== 'manual' &&
					!visible.has(line.id)
			);
		})
		.map((line) => line.id);

	if (lineIds.length) {
		p.ops.push({ kind: 'regenerate_descriptions', line_ids: lineIds });
		p.warn(
			'pending_descriptions_updated',
			`${lineIds.length} ${lineIds.length === 1 ? 'línea' : 'líneas'} de facturas Por Emitir ${
				lineIds.length === 1 ? 'toma' : 'toman'
			} los datos corregidos en su descripción (las escritas a mano y las emitidas no se tocan)`
		);
	}
	p.extras.items_after = entries.map((entry) => ({
		item_id: entry.item.id,
		product_name: entry.set.product_name ?? entry.item.product_name,
		account_before: entry.item.account?.trim() || null,
		account: 'account' in entry.set ? (entry.set.account ?? null) : entry.item.account?.trim() || null,
		changes: entry.changes,
	}));
	if (issuedDifference) p.extras.issued_difference = issuedDifference;
	const describe = (entry: (typeof entries)[number]) =>
		`"${entry.item.product_name}": ${entry.changes.map((change) => `${CORRECTION_FIELD_LABELS[change.field]} ${correctionValueText(change.field, change.before)} → ${correctionValueText(change.field, change.after)}`).join(' · ')}`;

	return p.finish({
		type: 'ITEM_CORRECTED',
		subtype: commercial.length ? 'value' : moves.length ? 'start' : 'data',
		title: 'Dato corregido',
		description: entries.map(describe).join('; '),
		amount_delta: 0,
		items_affected: entries.map((entry) => entry.item.id),
		metadata: {
			items: entries.map((entry) => ({ item_id: entry.item.id, product_name: entry.item.product_name, changes: entry.changes })),
			pending_descriptions_updated: lineIds.length,
			...(issuedDifference ? { issued_difference: issuedDifference } : {}),
			...(preserved.length ? { preserved: [...new Set(preserved)] } : {}),
		},
	});
}

/** Un dato corregido del ítem (antes → después) en el preview y en `metadata.items[].changes` del evento `ITEM_CORRECTED`. */
export interface ItemCorrectionChange {
	field: ItemCorrectionField;
	before: string | number | null;
	after: string | number | null;
}

type ItemUpdateSet = Extract<WriteOp, { kind: 'update_item' }>['set'];

/** Texto de un valor corregido para la descripción del evento ("sin cuenta" / "sin tipo" para null; modo del precio en palabras). */
export const correctionValueText = (field: ItemCorrectionField, value: string | number | null) => {
	if (value === null)
		return field === 'account' ? 'sin cuenta' : field === 'item_type' ? 'sin tipo' : field === 'discount_value' ? '0 %' : 'sin valor';
	if (field === 'price_entry_mode') return value === 'annual' ? 'anual' : 'mensual';
	const text = typeof value === 'number' ? value.toLocaleString('es-CL', { maximumFractionDigits: 6 }) : value;

	return field === 'discount_value' ? `${text} %` : text;
};

/** Valida y normaliza un ítem del pedido: qué cambia (antes → después), la fila a escribir y, si cambia el valor, los valores comerciales. */
function parseCorrection(
	p: Planner,
	item: ChangeItemRow,
	ref: Record<string, unknown>,
	field: string
): { changes: ItemCorrectionChange[]; set: ItemUpdateSet; values: CorrectionValues | null; start: string | null } | null {
	const changes: ItemCorrectionChange[] = [];
	const set: ItemUpdateSet = {};
	let valid = true;
	const text = (name: 'account' | 'product_name' | 'item_type', max: number, required: boolean) => {
		if (!(name in ref)) return;
		const value = ref[name];

		if (value !== null && value !== undefined && typeof value !== 'string') {
			p.error(`${field}.${name}`, `${CORRECTION_FIELD_LABELS[name][0].toUpperCase()}${CORRECTION_FIELD_LABELS[name].slice(1)} inválida`);
			valid = false;

			return;
		}
		const after = typeof value === 'string' && value.trim() ? value.trim() : null;

		if (required && !after) {
			p.error(`${field}.${name}`, 'La glosa del ítem no puede quedar vacía');
			valid = false;

			return;
		}
		if (after && after.length > max) {
			p.error(`${field}.${name}`, `Máximo ${max} caracteres`);
			valid = false;

			return;
		}
		const before = (item[name] as string | null)?.trim() || null;

		if (after === before) {
			if (name === 'account' && Object.keys(ref).filter((key) => key !== 'item_id').length === 1) {
				p.error(`${field}.account`, `"${item.product_name}" ya tiene esa cuenta`);
				valid = false;
			}

			return;
		}
		changes.push({ field: name, before, after });
		set[name] = after as never;
	};

	text('account', 128, false);
	text('product_name', 500, true);
	text('item_type', 64, false);
	// Fecha de inicio (caso CTR-2026-191, 07-10): solo se valida la forma aquí; las reglas del movimiento las aplica `startCorrectionSet`.
	let start: string | null = null;

	if ('start_date' in ref && ref.start_date !== null && ref.start_date !== undefined) {
		if (!isIsoDay(ref.start_date)) {
			p.error(`${field}.start_date`, 'Fecha de inicio inválida (YYYY-MM-DD)');
			valid = false;
		} else if (ref.start_date !== item.start_date) {
			start = ref.start_date;
			changes.push({ field: 'start_date', before: item.start_date, after: start });
		}
	}
	const number = (name: 'quantity' | 'unit_price' | 'discount_value', check: (value: number) => string | null): number | null => {
		if (!(name in ref) || ref[name] === null || ref[name] === undefined) return null;
		const value = Number(ref[name]);
		const message = typeof ref[name] !== 'number' || !Number.isFinite(value) ? 'Número inválido' : check(value);

		if (message) {
			p.error(`${field}.${name}`, message);
			valid = false;

			return null;
		}

		return value;
	};
	const quantity = number('quantity', (value) => (value <= 0 ? 'La cantidad debe ser mayor que 0' : null));
	const unitIn = number('unit_price', (value) => (value < 0 ? 'El precio no puede ser negativo' : null));
	const pctIn = number('discount_value', (value) => (value < 0 || value > 100 ? 'El descuento va de 0 a 100 %' : null));
	const modeIn = ref.price_entry_mode;

	if (modeIn !== undefined && modeIn !== null && modeIn !== 'monthly' && modeIn !== 'annual') {
		p.error(`${field}.price_entry_mode`, 'Precio ingresado: mensual (monthly) o anual (annual)');
		valid = false;
	}
	if (!valid) return null;
	const modeBefore = item.price_entry_mode === 'annual' ? 'annual' : 'monthly';
	const mode = (modeIn as 'monthly' | 'annual' | null | undefined) ?? modeBefore;
	const unitBefore = num(item.unit_price ?? num(item.annual_unit_price) / 12);
	const unit = unitIn === null ? unitBefore : mode === 'annual' ? round6(unitIn / 12) : unitIn;
	const pctBefore = item.discount_type === 'Porcentaje' || !item.discount_type ? num(item.discount_value) : null;
	const pct = pctIn ?? pctBefore;
	const quantityBefore = num(item.quantity);
	const shown = (value: number, entry: 'monthly' | 'annual') => (entry === 'annual' ? round6(value * 12) : round6(value));

	if (quantity !== null && quantity !== quantityBefore) changes.push({ field: 'quantity', before: quantityBefore, after: quantity });
	if (mode !== modeBefore) changes.push({ field: 'price_entry_mode', before: modeBefore, after: mode });
	if (Math.abs(unit - unitBefore) > 1e-6) changes.push({ field: 'unit_price', before: shown(unitBefore, modeBefore), after: shown(unit, mode) });
	if (pctIn !== null && pctIn !== pctBefore) changes.push({ field: 'discount_value', before: pctBefore, after: pctIn });
	const valueChanged = changes.some((change) => COMMERCIAL_CORRECTION_FIELDS.has(change.field));

	if (!valueChanged) return { changes, set, values: null, start };
	if (REMOVAL_CATEGORIES.has(item.categoria ?? '')) {
		p.error(field, `"${item.product_name}" es el registro de una baja: su valor no se corrige`);

		return null;
	}
	const spec = priceSpecFromRow(item.raw);

	if (spec && !isStandardFixed(spec)) {
		p.error(field, `"${item.product_name}" tiene modelo de precio (${spec.model}): su valor se corrige editando el precio del ítem`);

		return null;
	}
	const quantityAfter = quantity ?? quantityBefore;
	// Descuento: el % pedido (0 = sin descuento); sin pedido, el del ítem (un "Monto fijo" se conserva tal cual).
	const discountType = pctIn === null ? item.discount_type : pctIn > 0 ? 'Porcentaje' : null;
	const discountValue = pctIn === null ? num(item.discount_value) : pctIn;
	const pricing = itemPricing({
		quantity: quantityAfter,
		unit_price: unit,
		term_months: item.term_months,
		billing_frequency: item.billing_frequency ?? 'Mensual',
		discount_value: discountValue,
		discount_type: discountType,
	});
	const fields = pricingFields(
		{
			unit_price: mode === 'annual' ? null : unit,
			annual_unit_price: mode === 'annual' ? round6(unit * 12) : null,
			price_entry_mode: mode,
			quantity: quantityAfter,
			billing_frequency: item.billing_frequency,
			is_recurring: item.is_recurring !== false,
			final_price: pricing.final_price,
			term_months: item.term_months,
			discount_type: discountType,
			discount_value: discountValue,
			categoria: item.categoria,
		},
		'contract_items'
	);

	Object.assign(set, {
		quantity: quantityAfter,
		unit_price: fields.unit_price,
		annual_unit_price: fields.annual_unit_price,
		annual_price: fields.annual_price,
		price_entry_mode: fields.price_entry_mode,
		discount_type: discountType,
		discount_value: discountValue,
		price: pricing.price,
		final_price: pricing.final_price,
		monthly_price: fields.monthly_price,
		billing_period_price: fields.billing_period_price,
	});

	return {
		changes,
		set,
		values: {
			quantity: quantityAfter,
			unit,
			pct: pct ?? 0,
			quantity_changed: quantityAfter !== quantityBefore,
			unit_changed: Math.abs(unit - unitBefore) > 1e-6,
			pct_given: pctIn !== null,
		},
		start,
	};
}

/** ¿Fecha ISO `YYYY-MM-DD` real? */
const isIsoDay = (value: unknown): value is string =>
	typeof value === 'string' &&
	/^\d{4}-\d{2}-\d{2}$/.test(value) &&
	!Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
	new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

/**
 * `item_update` con fecha de inicio (caso CTR-2026-191, decisión de Domi 07-10): reglas del movimiento y campos derivados del ítem.
 * Solo ítems recurrentes que no son baja ni renovación; el nuevo inicio ≤ fin del ítem y antes de su baja; un ítem de ciclo propio
 * (§9.3.9) parte su día; el día de ciclo del contrato (si sale del inicio de los ítems) no puede cambiar; sus ajustes no pueden partir
 * antes. El mes del inicio más temprano debe estar abierto. `term_months` = meses cubiertos; `price`/`final_price` escalan con los meses
 * de ciclo (`monthsBetween`, como al crear), así se respeta cómo se calculó el valor del ítem (modelo de precio, monto fijo).
 */
function startCorrectionSet(p: Planner, item: ChangeItemRow, to: string, field: string, contractAnchor: number): ItemUpdateSet | null {
	const from = item.start_date;
	const name = item.product_name ?? 'El ítem';
	const fail = (message: string) => {
		p.error(`${field}.start_date`, message);

		return null;
	};

	if (!from) return fail(`"${name}" no tiene fecha de inicio que corregir`);
	if (item.is_recurring === false)
		return fail(`"${name}" es un cargo único: su fecha no se corrige aquí (quítalo y agrégalo con la fecha correcta)`);
	if (REMOVAL_CATEGORIES.has(item.categoria ?? '')) return fail(`"${name}" es el registro de una baja: su inicio no se corrige`);
	if (item.renews_item_id) return fail(`"${name}" es la renovación de otro ítem: su inicio sigue al fin del anterior`);
	if (item.end_date && to > item.end_date) return fail(`El inicio no puede quedar después del fin del ítem (${item.end_date})`);
	if (item.churn_date && to >= item.churn_date) return fail(`El inicio debe ser anterior a la baja del ítem (${item.churn_date})`);
	const own = validAnchorDay(item.billing_anchor_day);

	if (own && Number(to.slice(8, 10)) !== own) return fail(`"${name}" se factura con ciclo propio el día ${own}: el nuevo inicio debe caer ese día`);
	const adjustment = p.ctx.items.find((row) => row.related_item_id === item.id && row.id !== item.id && row.start_date && row.start_date < to);

	if (adjustment)
		return fail(
			`"${adjustment.product_name}" ajusta este ítem desde el ${adjustment.start_date}: el inicio no puede quedar después de esa fecha`
		);
	const anchorAfter = anchorDayOf(
		p.ctx.contract,
		p.ctx.items.map((row) => (row.id === item.id ? { ...row, start_date: to } : row))
	);

	if (anchorAfter !== contractAnchor)
		return fail(`Con ese inicio cambiaría el día de facturación del contrato (día ${contractAnchor} → día ${anchorAfter}): revisa la fecha`);
	p.assertOpenPeriod(to < from ? to : from, 'El inicio del ítem');
	const set: ItemUpdateSet = { start_date: to };

	if (item.end_date) {
		const anchor = anchorOfItem(item, contractAnchor);
		const monthsBefore = monthsBetween(from, item.end_date, anchor);
		const monthsAfter = monthsBetween(to, item.end_date, anchor);

		set.term_months = monthsCeil(to, item.end_date);
		if (monthsBefore > 0) {
			set.price = round2((num(item.price) * monthsAfter) / monthsBefore);
			set.final_price = round2((num(item.final_price) * monthsAfter) / monthsBefore);
		}
	}

	return set;
}

/**
 * Facturas de un ítem con el inicio corregido (`from` → `row.start_date`):
 * - Bloqueo si una factura vigente que el cambio no puede tocar cobra el ítem antes del nuevo inicio: emitida sin anular
 *   (`issued_invoice_before_start`: anularla con NC sin reemitir) o Por Emitir unificada/heredada (`pending_invoice_before_start`).
 * - Por Emitir: se quitan las líneas del ítem con período antes del nuevo inicio (la factura sin líneas se cancela en `closeHeaders`) y,
 *   al adelantar, el tramo inicial prorrateado del inicio anterior.
 * - El generador rehace solo los días sin factura vigente entre el nuevo inicio y el fin del primer período (o el día antes del inicio
 *   anterior al adelantar, o el fin de lo quitado): mismo prorrateo que al crear el ítem; se funde con la Por Emitir del mes o va aparte.
 */
function moveItemStartInvoices(p: Planner, item: ChangeItemRow, row: ChangeItemRow, contractAnchor: number) {
	const from = item.start_date!;
	const to = row.start_date!;
	const name = item.product_name ?? 'el ítem';
	const lineStart = (line: ChangeInvoiceLineRow) => line.billing_period_start ?? line.billing_period_end ?? '';
	const itemLines = (invoice: ChangeInvoiceRow) => invoice.lines.filter((line) => line.contract_item_id === item.id);

	for (const invoice of p.ctx.invoices) {
		if (invoice.status === 'Cancelada' || !invoice.is_active || /^(NC|ND)$/i.test(invoice.document_type ?? '') || isEditablePending(invoice))
			continue;
		if (!itemLines(invoice).some((line) => lineStart(line) && lineStart(line) < to)) continue;
		if (isIssued(invoice))
			p.block(
				'issued_invoice_before_start',
				`Anula con nota de crédito la factura ${invoiceName(invoice)} antes de mover el inicio: cobra "${name}" antes del ${to}`,
				'Anúlala desde su vista rápida con una nota de crédito, sin reemitir, y vuelve a corregir la fecha'
			);
		else if (invoice.status === PENDING_STATUS)
			p.block(
				'pending_invoice_before_start',
				`La factura ${invoiceName(invoice)} cobra "${name}" antes del ${to} y el cambio no puede ajustarla`,
				'Desunifícala o cancélala desde Facturación y vuelve a corregir la fecha'
			);
	}
	const anchor = anchorOfItem(item, contractAnchor);
	// Al adelantar, el tramo inicial prorrateado del inicio anterior se rehace junto con los días nuevos (un solo período, como al crear).
	const oldStub = to < from && Number(from.slice(8, 10)) !== anchor;
	const firstPeriod = itemPeriods(engineShape(row), contractAnchor)[0];
	let through = firstPeriod?.period_end ?? to;

	if (to < from && addDays(from, -1) > through) through = addDays(from, -1);
	for (const invoice of p.ctx.invoices.filter(isEditablePending)) {
		const lines = itemLines(invoice).filter((line) => lineStart(line) < to || (oldStub && lineStart(line) === from && !isConsumptionLine(line)));

		if (!lines.length || p.skipPartial(invoice)) continue;
		for (const line of lines) {
			const manual = line.quantity_source === 'manual';

			p.deleteLine(invoice, line);
			if (!manual && line.billing_period_end && line.billing_period_end > through) through = line.billing_period_end;
		}
	}
	// Las NC no descubren días (el tramo a rehacer ya pasó por los bloqueos); las anuladas y canceladas no cubren.
	const creditNotes = new Set(p.ctx.invoices.filter((invoice) => /^NC$/i.test(invoice.document_type ?? '')).map((invoice) => invoice.id));
	const restored = p.restoreItemBilling(row, to, creditNotes, {
		through,
		note: 'inicio corregido',
		...(row.end_date ? {} : { until: through }),
	});

	p.addRestoredInvoices(restored, 'se suma el tramo del nuevo inicio');
}

/**
 * Facturas de un ítem corregido: reescribe sus Por Emitir con los valores corregidos (respetando lo hecho a mano) y reparte entre ellas la
 * diferencia de lo ya emitido. Devuelve la diferencia (o null si no hay emitidas del ítem con diferencia).
 */
function correctItemInvoices(
	p: Planner,
	item: ChangeItemRow,
	after: CorrectionValues,
	contractAnchor: number,
	preserved: string[],
	subject: string
): IssuedDifferencePreview | null {
	const anchor = anchorOfItem(item, contractAnchor);
	const before = { unit: num(item.unit_price ?? num(item.annual_unit_price) / 12) };
	const issued: IssuedDifferencePreview['issued_invoices'] = [];

	// Emitidas (no NC/ND, no anuladas, no unificadas): no se tocan; se mide lo que debió emitirse con los valores corregidos.
	for (const invoice of p.ctx.invoices.filter((row) => isIssued(row) && row.invoice_type !== UNIFIED_INVOICE_TYPE)) {
		const lines = invoice.lines.filter((line) => line.contract_item_id === item.id);

		if (!lines.length) continue;
		const was = round2(lines.reduce((sum, line) => sum + num(line.subtotal), 0));
		const expected = round2(lines.reduce((sum, line) => sum + correctedLine(line, before, after, anchor).subtotal, 0));

		if (Math.abs(expected - was) >= 0.005)
			issued.push({
				invoice_id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				issued: was,
				expected,
				difference: round2(expected - was),
			});
	}
	const candidates: Array<{ invoice: ChangeInvoiceRow; line: ChangeInvoiceLineRow; values: LineCorrection; target: boolean }> = [];

	for (const invoice of p.ctx.invoices.filter(isEditablePending)) {
		const lines = invoice.lines.filter((line) => line.contract_item_id === item.id);

		if (!lines.length || p.skipPartial(invoice)) continue;
		const label = `la factura ${invoiceName(invoice)}`;

		for (const line of lines) {
			if (line.quantity_source === 'manual') {
				preserved.push(`la línea editada a mano de ${label} (no se reescribe)`);
				continue;
			}
			if (line.consumption?.amount_override !== null && line.consumption?.amount_override !== undefined) {
				preserved.push(`el monto informado del consumo de ${label} (no se reescribe)`);
				continue;
			}
			const values = correctedLine(line, before, after, anchor);

			if (isConsumptionLine(line)) preserved.push(`la cantidad consumida registrada en ${label} (${num(line.quantity)})`);
			if (line.description_locked) preserved.push(`la glosa escrita a mano de ${label}`);
			if (values.pricing_breakdown) preserved.push(`el descuento puntual de ${label}`);
			if (PER_INVOICE_FX_SOURCES.has(line.fx_rate_source ?? '')) preserved.push(`el tipo de cambio fijado en ${label}`);
			candidates.push({ invoice, line, values, target: false });
		}
	}
	const amount = round2(issued.reduce((sum, row) => sum + row.difference, 0));
	let difference: IssuedDifferencePreview | null = null;

	if (issued.length && amount !== 0) {
		// Una parte por factura por emitir (en su primera línea del ítem que admite unitario: cantidad > 0 y descuento < 100 %), en orden de emisión.
		const byInvoice = new Map<string, (typeof candidates)[number]>();

		for (const candidate of candidates)
			if (!byInvoice.has(candidate.invoice.id) && candidate.values.quantity > 0 && candidate.values.discount_pct < 100)
				byInvoice.set(candidate.invoice.id, candidate);
		const targets = [...byInvoice.values()].sort((a, b) => (a.invoice.issue_date ?? '').localeCompare(b.invoice.issue_date ?? ''));
		const currency = item.currency ?? p.ctx.contract.contract_currency;

		difference = { item_id: item.id, product_name: item.product_name, currency, amount, issued_invoices: issued, distributed_over: [] };
		if (!targets.length) {
			p.block(
				'no_pending_invoices_for_correction',
				`"${item.product_name}" ya tiene facturas emitidas con otro valor (diferencia ${currency} ${money(amount)}) y no le quedan facturas por emitir donde repartirla`,
				CORRECTION_NEXT_STEP
			);
		} else {
			const shares = telescopicShares(amount, targets.length);

			for (const [index, target] of targets.entries()) {
				const share = shares[index];
				const subtotal = round2(target.values.subtotal + share);

				if (subtotal < 0) {
					p.block(
						'correction_difference_exceeds_pending',
						`La diferencia de "${item.product_name}" (${currency} ${money(amount)}) deja en negativo la factura ${invoiceName(target.invoice)}`,
						CORRECTION_NEXT_STEP
					);
					continue;
				}
				// El ajuste entra al unitario de la línea (cantidad y descuento se conservan; neto = cantidad × unitario × (1 − descuento)).
				target.values = {
					...target.values,
					subtotal,
					unit_price: round6(subtotal / (target.values.quantity * (1 - target.values.discount_pct / 100))),
				};
				target.target = true;
				difference.distributed_over.push({
					invoice_id: target.invoice.id,
					invoice_number: target.invoice.invoice_number,
					issue_date: target.invoice.issue_date,
					amount: share,
				});
				p.ops.push({
					kind: 'insert_invoice_adjustment',
					invoice_id: target.invoice.id,
					type: 'correction',
					amount_diff: round2(p.toContract(share, item.currency, target.invoice.issue_date ?? p.effective)),
					notes: `Corrección de "${item.product_name}": parte ${index + 1} de ${targets.length} de la diferencia con lo ya emitido (${issued
						.map((row) => row.invoice_number ?? row.issue_date)
						.join(', ')})`,
				});
			}
			p.warn('issued_difference_distributed', issuedDifferenceSentence(difference, subject));
		}
	}
	for (const { invoice, line, values, target } of candidates) {
		const unchanged =
			values.quantity === num(line.quantity) &&
			values.unit_price === num(line.unit_price) &&
			values.subtotal === num(line.subtotal) &&
			values.discount_pct === num(line.discount_pct);

		if (unchanged && !target) continue;
		const tax = round2((values.subtotal * invoice.tax_rate) / 100);

		p.updateLine(
			invoice,
			line,
			{
				quantity: values.quantity,
				unit_price: values.unit_price,
				discount_pct: values.discount_pct,
				subtotal: values.subtotal,
				tax_amount: tax,
				total: round2(values.subtotal + tax),
				pricing_breakdown: values.pricing_breakdown,
			},
			target ? 'línea corregida con su parte de la diferencia emitida' : 'línea corregida'
		);
	}

	return difference;
}

/**
 * Job diario `contracts-extend-horizon`: períodos por delante que siempre tienen factura los ítems sin término (B2, decisión 01-10).
 * **Fijo por sistema** (calendario rodante tipo ERP; Domi 03-10: no es configurable por holding).
 */
export const HORIZON_PERIODS_AHEAD = 12;
export const HORIZON_EXTENDED = 'HORIZON_EXTENDED';

/** ¿El ítem tiene una pausa abierta (sin fin) programada o activa? (§9.3.3: no se le generan facturas hasta reanudar). */
const hasOpenPause = (ctx: ChangeContext, itemId: string) =>
	(ctx.pauses ?? []).some(
		(pause) => pause.contract_item_id === itemId && !pause.pause_end && (pause.status === 'active' || pause.status === 'scheduled')
	);

/**
 * Fin del horizonte de un ítem sin término: fin del período n.º `HORIZON_PERIODS_AHEAD` contado desde el que contiene `today` (con su
 * frecuencia y su ciclo). null si el ítem aún no tiene períodos.
 */
export function horizonEndOf(item: ChangeItemRow, contractAnchor: number, today: string): string | null {
	const months = BILLING_FREQUENCY_MONTHS[(item.billing_frequency ?? 'Mensual') as BillingFrequency] ?? 1;
	const base = item.start_date && item.start_date > today ? item.start_date : today;
	const far = addDays(addMonths(base, (HORIZON_PERIODS_AHEAD + 2) * months), -1);
	const periods = itemPeriods(
		{ ...engineShape(item), end_date: far, term_months: monthsCeil(item.start_date ?? base, far) },
		anchorOfItem(item, contractAnchor)
	).filter((period) => period.period_end >= today);

	return periods[HORIZON_PERIODS_AHEAD - 1]?.period_end ?? periods.at(-1)?.period_end ?? null;
}

/**
 * `contracts-extend-horizon` (job diario, decisión de Domi 01-10): el generador factura los ítems sin término solo `HORIZON_PERIODS_AHEAD`
 * períodos desde su inicio; cada día, por contrato Activo, los recurrentes sin término vivos (sin churn, sin renovar, no espejos de baja, sin
 * pausa abierta) reciben las Por Emitir que faltan para tener siempre `HORIZON_PERIODS_AHEAD` (12, fijo) períodos desde hoy. Solo
 * extiende **hacia adelante** desde el último día facturado (nunca rellena huecos: una factura cancelada a propósito no vuelve), con el mismo generador que la reactivación
 * (`restoreItemBilling`) y la fusión con la Por Emitir del mes (`mergeTarget`). Idempotente: con el horizonte completo devuelve null. Sin
 * cambios de ítems ni devengo. Evento `HORIZON_EXTENDED` (uno por contrato y corrida, solo si creó algo).
 */
export function planHorizonExtension(ctx: ChangeContext): ChangePlan | null {
	const today = ctx.today;
	const p = new Planner(
		ctx,
		{ effective_date: today, origin: { type: 'manual' }, change: { type: 'item_add' } } as ContractChangeRequestDto,
		'item_add'
	);
	const anchor = anchorDayOf(ctx.contract, ctx.items);
	const extended: Array<{ item_id: string; product_name: string | null; from: string; until: string }> = [];
	const restored: PreviewInvoice[] = [];

	for (const item of ctx.items) {
		if (
			!item.start_date ||
			!isIndefiniteItem({ ...item, term_months: item.term_months ?? null }) ||
			item.churn_date ||
			item.renewed_by_item_id ||
			REMOVAL_CATEGORIES.has(item.categoria ?? '') ||
			hasOpenPause(ctx, item.id)
		)
			continue;
		const until = horizonEndOf(item, anchor, today);

		if (!until) continue;
		const lastCovered = ctx.invoices
			.filter(
				(invoice) => invoice.status !== 'Cancelada' && invoice.is_active && !invoice.voided && !/^(NC|ND)$/i.test(invoice.document_type ?? '')
			)
			.flatMap((invoice) => invoice.lines)
			.filter((line) => line.contract_item_id === item.id && line.billing_period_end)
			.map((line) => line.billing_period_end!)
			.sort()
			.at(-1);
		const from = lastCovered ? addDays(lastCovered, 1) : item.start_date;

		if (from > until) continue;
		const invoices = p.restoreItemBilling(item, from, new Set(), { until, note: 'horizonte' });

		if (!invoices.length) continue;
		restored.push(...invoices);
		extended.push({ item_id: item.id, product_name: item.product_name, from, until });
	}
	if (!restored.length) return null;
	p.addRestoredInvoices(restored);
	// Sin cambio de ítems: el devengo no se reconstruye.
	p.rsmFromMonth = null;
	const created = p.createdInvoices.length;
	const merged = p.updatedInvoices.length;
	const names = [...new Set(extended.map((entry) => `"${entry.product_name ?? 'Producto'}"`))].join(', ');
	const until = extended
		.map((entry) => entry.until)
		.sort()
		.at(-1)!;

	return p.finish({
		type: HORIZON_EXTENDED,
		subtype: null,
		title: 'Facturas por emitir extendidas (ítems sin término)',
		description: `Se generaron las facturas por emitir de ${names} hasta el ${until}${created ? ` (${created} nueva${created === 1 ? '' : 's'}` : ' ('}${
			created && merged ? ', ' : ''
		}${merged ? `${merged} sumada${merged === 1 ? '' : 's'} a una por emitir del mes` : ''})`,
		amount_delta: 0,
		items_affected: extended.map((entry) => entry.item_id),
		metadata: {
			change_type: 'horizon_extension',
			job: 'contracts-extend-horizon',
			created_by_system: true,
			periods_ahead: HORIZON_PERIODS_AHEAD,
			horizon_until: until,
			items: extended,
		},
	});
}

/** Preview sin cambios con bloqueos (p. ej. `index_value_missing` al materializar un pacto sin dato del índice). */
export function blockedPreview(ctx: ChangeContext, req: ContractChangeRequestDto, blockers: ChangeBlocker[]): ChangePreview {
	const p = new Planner(ctx, req, req.change.type as ChangeType);

	for (const blocker of blockers) p.block(blocker.code, blocker.message, blocker.next_step);

	return p.finish({ type: 'BLOCKED', subtype: null, title: '', description: '', amount_delta: 0, items_affected: [] }).preview;
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
	if (req.origin?.type === 'renewal_proposal') {
		if (!req.origin.event_id) errors.push({ field: 'origin.event_id', message: 'Indica la propuesta de renovación que se confirma' });
		if (req.change?.type !== 'renewal')
			errors.push({ field: 'origin.type', message: 'Una propuesta de renovación se confirma con change.type = renewal' });
	}
	const withItems: string[] = ['item_remove', 'renewal', 'item_add', 'item_change', 'item_update', 'price_model_change'];

	if (withItems.includes(req.change?.type ?? '') && (!Array.isArray(req.change.items) || !req.change.items.length)) {
		errors.push({ field: 'change.items', message: 'Indica al menos un ítem' });
	}
	if (errors.length) throw validationException(errors);
}

/**
 * Mismo cálculo para preview y aplicar. Lanza 400 (`errors[{ field, message }]`) si el pedido está mal formado. `options` = pacto que se
 * materializa (`…/scheduled-changes/:changeId/apply`), nunca del body.
 */
export function planChange(ctx: ChangeContext, req: ContractChangeRequestDto, options: PlanOptions = {}): ChangePlan {
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
			return planRenewal(ctx, req, options);
		case 'item_add':
			return planItemAdd(ctx, req);
		case 'item_change':
			return planItemChange(ctx, req, options);
		case 'multicurrency':
			return planMulticurrency(ctx, req);
		case 'reactivate':
			return planReactivate(ctx, req);
		case 'pause':
			return planPause(ctx, req);
		case 'resume':
			return planResume(ctx, req);
		case 'item_update':
			return planItemUpdate(ctx, req);
		case 'price_model_change':
			return planPriceModelChange(ctx, req);
	}
}

/** Estado del ítem hoy, para la respuesta (mismo criterio que el 360). */
export const itemStatusToday = (item: ChangeItemRow, today: string) => deriveItemStatus(item, today);
