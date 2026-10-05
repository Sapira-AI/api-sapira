/**
 * Reglas puras del Contrato 360 enriquecido (resumen, calendario de facturación y consumo). Sin base de datos: el
 * servicio (`contract-360.service.ts`) lee las filas y estas funciones arman las respuestas, así se prueban aisladas.
 *
 * Fechas `YYYY-MM-DD` (texto): se comparan como string. Montos en moneda del contrato salvo que el nombre diga otra cosa.
 * Los mensajes son para la usuaria: español neutro, sin nombres de columnas y "ERP" (nunca el nombre del proveedor).
 */
import { diffDays } from './billing-engine';

import type { ContractDerivedStatus } from './contract-status';
import type { PricedSubline, PriceSpec } from './pricing-engine';

// ---------------------------------------------------------------- utilidades

export const ISSUED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'] as const;
export const PENDING_STATUS = 'Por Emitir';
export const CANCELLED_STATUS = 'Cancelada';

/**
 * ¿La factura está "sin cobro"? Derivado de los eventos (sin columna nueva): Cancelada y su último evento de sin cobro es
 * `INVOICE_NO_CHARGE` (no seguido de `INVOICE_NO_CHARGE_REVERTED`). Fragmento SQL sobre el alias de `invoices` dado.
 */
export const noChargeSql = (alias = 'i') => `(${alias}.status = 'Cancelada' AND (SELECT e.event_type FROM contract_lifecycle_events e
		WHERE e.contract_id = ${alias}.contract_id AND e.holding_id = ${alias}.holding_id AND e.metadata->>'invoice_id' = ${alias}.id::text
			AND e.event_type IN ('INVOICE_NO_CHARGE', 'INVOICE_NO_CHARGE_REVERTED')
		ORDER BY e.created_at DESC, e.id DESC FETCH FIRST 1 ROW ONLY) = 'INVOICE_NO_CHARGE')`;

/**
 * Regla única de visibilidad de una línea (derivada, sin columna `is_visible`; etapa 6, §3.7b): va al documento y al ERP si su cantidad no
 * es 0 y no es una línea interna de facturar por OC (`invoice_items.visible_line_id` NULL). Misma regla en el detalle, el editor,
 * Reorganizar y el filtro que debe aplicar el envío al ERP (`quantity <> 0 AND visible_line_id IS NULL`).
 */
export const isVisibleLine = (quantity: number, visibleLineId?: string | null): boolean => Number(quantity) !== 0 && !visibleLineId;

/**
 * ¿La factura está anulada con NC? (etapa 6, §3.8; derivado, sin columna): tiene una NC de anulación activa vinculada
 * (`related_invoice_id`, `credit_type = 'cancellation'`). Vale para v2 (la original conserva su estado y la NC nace con ese estado, pendiente de emisión electrónica) y para el
 * flujo viejo (`create_credit_note_safe`: original y NC quedan Canceladas). Fragmento SQL sobre el alias de `invoices` dado.
 */
export const voidedSql = (
	alias = 'i'
) => `EXISTS (SELECT 1 FROM invoices vn WHERE vn.related_invoice_id = ${alias}.id AND vn.holding_id = ${alias}.holding_id
		AND vn.document_type = 'NC' AND vn.credit_type = 'cancellation' AND vn.is_active = true)`;

/**
 * Documentos vinculados por `related_invoice_id` en ambos sentidos (NC y reemisión de la factura; original de una NC o de una reemisión),
 * como jsonb `[{ id, invoice_number, document_type, credit_type, status, issue_date, total, relation }]`. `total` = total en moneda de
 * factura (o el neto en moneda de contrato si aún no se valoriza).
 */
export const relatedDocumentsSql = (alias = 'i') => `(SELECT COALESCE(jsonb_agg(jsonb_build_object(
			'id', o.id, 'invoice_number', o.invoice_number, 'document_type', o.document_type, 'credit_type', o.credit_type, 'status', o.status,
			'issue_date', o.issue_date, 'total', COALESCE(o.total_invoice_currency, o.amount_contract_currency),
			'relation', CASE
				WHEN o.related_invoice_id = ${alias}.id AND o.document_type = 'NC' THEN 'credit_note'
				WHEN o.related_invoice_id = ${alias}.id THEN 'reissue'
				ELSE 'original'
			END) ORDER BY o.created_at, o.id), '[]'::jsonb)
		FROM invoices o
		WHERE o.holding_id = ${alias}.holding_id AND o.id <> ${alias}.id AND (o.related_invoice_id = ${alias}.id OR o.id = ${alias}.related_invoice_id))`;

/**
 * Último evento `INVOICE_PARTIAL_BILLING` que nombra la factura como cubierta o como saldo (metadata), o NULL (§3.7b). Resuelve por la cadena
 * de reemisiones (`related_invoice_id` con `split_reason = 'reissue'`): la reemisión de una factura por OC muestra el chip de su original. La
 * metadata vuelve con `chain_invoice_id` = la factura de la cadena que nombra el evento (la propia o una original).
 */
export const partialBillingEventSql = (alias = 'i') => `(WITH RECURSIVE chain AS (
			SELECT x.id, x.related_invoice_id, x.split_reason, 0 AS depth FROM invoices x WHERE x.id = ${alias}.id
			UNION ALL
			SELECT p.id, p.related_invoice_id, p.split_reason, chain.depth + 1
			FROM chain JOIN invoices p ON p.id = chain.related_invoice_id AND p.holding_id = ${alias}.holding_id
			WHERE chain.split_reason = 'reissue' AND chain.depth < 20
		)
		SELECT e.metadata || jsonb_build_object('chain_invoice_id', chain.id::text)
		FROM contract_lifecycle_events e JOIN chain ON (e.metadata->>'invoice_id' = chain.id::text OR e.metadata->>'remainder_invoice_id' = chain.id::text)
		WHERE e.contract_id = ${alias}.contract_id AND e.holding_id = ${alias}.holding_id AND e.event_type = 'INVOICE_PARTIAL_BILLING'
		ORDER BY chain.depth, e.created_at DESC, e.id DESC FETCH FIRST 1 ROW ONLY)`;

export interface PartialBillingView {
	/** covered = esta factura lleva la línea visible de la OC · remainder = es la factura de saldo. */
	role: 'covered' | 'remainder';
	reference_code: string | null;
	reference_type: string | null;
	covered_total: number | null;
	covered_invoice_id: string | null;
	remainder_invoice_id: string | null;
}

/** Vista `partial_billing` de una factura desde la metadata de su evento `INVOICE_PARTIAL_BILLING` (null si no tiene). */
export function partialBillingOf(invoiceId: string, metadata: unknown): PartialBillingView | null {
	const raw = typeof metadata === 'string' ? (JSON.parse(metadata) as unknown) : metadata;

	if (!raw || typeof raw !== 'object') return null;
	const md = raw as Record<string, unknown>;
	const reference = (md.reference ?? {}) as Record<string, unknown>;
	const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
	const covered = text(md.invoice_id);
	const total = md.covered_total === null || md.covered_total === undefined ? null : Number(md.covered_total);
	// Una reemisión hereda el rol de la factura de su cadena que nombra el evento.
	const subject = text(md.chain_invoice_id) ?? invoiceId;

	return {
		role: covered === subject ? 'covered' : 'remainder',
		reference_code: text(reference.code),
		reference_type: text(reference.type),
		covered_total: total !== null && Number.isFinite(total) ? total : null,
		covered_invoice_id: covered,
		remainder_invoice_id: text(md.remainder_invoice_id),
	};
}

export interface RelatedDocumentView {
	id: string;
	invoice_number: string | null;
	document_type: string | null;
	credit_type: string | null;
	status: string | null;
	issue_date: string | null;
	total: number | null;
	relation: string | null;
}

/** `related_documents` desde el jsonb de `relatedDocumentsSql`. */
export function relatedDocumentsOf(value: unknown): RelatedDocumentView[] {
	const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
	const text = (entry: unknown) => (entry === null || entry === undefined ? null : String(entry));

	if (!Array.isArray(raw)) return [];

	return raw.map((row: Record<string, unknown>) => ({
		id: String(row.id),
		invoice_number: text(row.invoice_number),
		document_type: text(row.document_type),
		credit_type: text(row.credit_type),
		status: text(row.status),
		issue_date: text(row.issue_date)?.slice(0, 10) ?? null,
		total: row.total === null || row.total === undefined ? null : Number(row.total),
		relation: text(row.relation),
	}));
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round1 = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

/** Nota de crédito (`NC`, `NOTA_CREDITO`, `Nota de crédito`). */
export const isCreditNote = (documentType: string | null | undefined) => /^(NC|NOTA[\s_-]*(DE[\s_-]*)?CR[EÉ]DITO)/i.test((documentType ?? '').trim());

/**
 * Estado con que nace una NC creada por la API (decisiones de Domi 01-10): **siempre `Emitida`**, sea cual sea el estado emitido de la
 * factura que acredita (`Emitida`, `Enviada`, `Pagada`, `Vencida`, parcialmente pagada…): el cobro y el vencimiento son de la factura, no
 * de la NC (una NC no se paga ni vence). Nunca Por Emitir: sobre una factura Por Emitir no se crea NC (se reescribe la factura). La emisión
 * electrónica queda pendiente (`odoo_invoice_id`/`sent_to_odoo_at` NULL) hasta que exista la emisión de NC en Odoo (Leon): el 360 la
 * muestra "pendiente de emisión electrónica" (`creditNotePendingEmission`) y el scheduler no la envía.
 */
export const creditNoteStatusFor = (): string => 'Emitida';

/**
 * NC/ND pendiente de emisión electrónica (decisión de Domi 01-10): las NC que crea la API nacen siempre `Emitida` (no Por Emitir),
 * sin folio ni vínculo con el ERP hasta que exista la emisión de NC en Odoo (Leon). También cuentan las NC v2 previas que nacieron Por Emitir.
 * El 360 las muestra "pendiente de emisión electrónica", no como facturas por enviar.
 */
export const creditNotePendingEmission = (row: {
	document_type: string | null | undefined;
	status: string | null | undefined;
	invoice_number?: string | null;
	odoo_invoice_id?: number | string | null;
	sent_to_odoo_at?: string | Date | null;
}): boolean =>
	(isCreditNote(row.document_type) || (row.document_type ?? '').trim().toUpperCase() === 'ND') &&
	row.status !== CANCELLED_STATUS &&
	(row.status === PENDING_STATUS ||
		((row.odoo_invoice_id === null || row.odoo_invoice_id === undefined) &&
			(row.sent_to_odoo_at === null || row.sent_to_odoo_at === undefined) &&
			!(row.invoice_number ?? '').trim()));

/** Factura que suma: `FACTURA*`, `Invoice` o sin tipo (las facturas antiguas no lo guardan). */
export const isInvoiceDocument = (documentType: string | null | undefined) => {
	const value = (documentType ?? '').trim();

	return value === '' || /^FACTURA/i.test(value) || value.toLowerCase() === 'invoice';
};

/** Valor más frecuente (empate: el que apareció primero). Ignora `null`/`undefined`/''. */
export function mostCommon<T extends string | number>(values: Array<T | null | undefined>): T | null {
	const counts = new Map<T, number>();

	for (const value of values) {
		if (value === null || value === undefined || value === '') continue;
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	let best: T | null = null;
	let bestCount = 0;

	for (const [value, count] of counts) {
		if (count > bestCount) {
			best = value;
			bestCount = count;
		}
	}

	return best;
}

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const monthOf = (iso: string) => Number(iso.slice(5, 7)) - 1;
const shortMonth = (iso: string) => `${MONTHS_SHORT[monthOf(iso)]} ${iso.slice(0, 4)}`;

/** "Marzo 2026" si el período cae en un mes; "Mar 2026 → Feb 2027" si abarca varios. */
export function periodLabel(start: string | null, end: string | null): string {
	if (!start) return 'Sin período';
	if (!end || start.slice(0, 7) === end.slice(0, 7)) return `${MONTHS[monthOf(start)]} ${start.slice(0, 4)}`;

	return `${shortMonth(start)} → ${shortMonth(end)}`;
}

const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso: string) => {
	const [year, month] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];

	return `${iso.slice(0, 7)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
};

/** Código ISO tal como se guarda, salvo CLF que se muestra como UF. */
export const displayCurrency = (code: string | null | undefined) => {
	const value = (code ?? '').trim().toUpperCase();

	return value === 'CLF' ? 'UF' : value || null;
};

/** "UF → CLP" cuando la moneda de facturación difiere de la del contrato; `null` si son iguales o falta una. */
export function fxPairLabel(contractCurrency: string | null | undefined, invoiceCurrency: string | null | undefined): string | null {
	const from = displayCurrency(contractCurrency);
	const to = displayCurrency(invoiceCurrency);

	if (!from || !to || from === to) return null;

	return `${from} → ${to}`;
}

// ---------------------------------------------------------------- condiciones de pago

export type PaymentTermsValue = { kind: 'net' | 'end_of_month'; days: number } | { kind: 'day_of_next_month'; day: number };

/** Etiqueta de la condición de pago guardada (misma forma que `client_entities.payment_terms`). */
export function paymentTermsLabel(terms: unknown): string | null {
	if (!terms || typeof terms !== 'object') return null;
	const value = terms as Record<string, unknown>;
	const days = Number(value.days);

	if (value.kind === 'net' && Number.isFinite(days)) return days === 0 ? 'Contado' : `${days} días`;
	if (value.kind === 'end_of_month' && Number.isFinite(days)) return days === 0 ? 'Fin de mes' : `Fin de mes + ${days} días`;
	if (value.kind === 'day_of_next_month' && Number.isFinite(Number(value.day))) return `Día ${Number(value.day)} del mes siguiente`;

	return null;
}

/** Plazo típico (días entre emisión y vencimiento más frecuente) de las facturas del contrato, como etiqueta. */
export function typicalPaymentTermsLabel(invoices: Array<Pick<ScheduleInvoice, 'issue_date' | 'due_date' | 'document_type'>>): string | null {
	const days = mostCommon(
		invoices
			.filter((invoice) => invoice.issue_date && invoice.due_date && !isCreditNote(invoice.document_type))
			.map((invoice) => diffDays(invoice.issue_date!, invoice.due_date!))
			.filter((value) => value >= 0)
	);

	if (days === null) return null;

	return days === 0 ? 'Contado' : `${days} días`;
}

// ---------------------------------------------------------------- facturas

/** Factura del contrato con lo necesario para el resumen, el calendario y los bloqueos. */
export interface ScheduleInvoice {
	id: string;
	invoice_number: string | null;
	status: string | null;
	document_type: string | null;
	is_active: boolean;
	issue_date: string | null;
	/** Fecha de emisión con la que nació la factura; si difiere de `issue_date`, se reprogramó. */
	original_issue_date?: string | null;
	due_date: string | null;
	contract_currency: string | null;
	invoice_currency: string | null;
	amount_contract_ccy: number;
	amount_invoice_ccy: number | null;
	fx_contract_to_invoice: number | null;
	/** La factura misma exige referencias (se copia del contrato al generarla). */
	requires_references: boolean;
	/** Período facturado: mínimo inicio y máximo fin de sus líneas. */
	period_start: string | null;
	period_end: string | null;
	lines_count: number;
	lines_without_product: number;
	/** Productos de líneas que viajarían al ERP sin producto de Odoo resoluble (`UNMAPPED_PRODUCTS_SQL`); ausente = no se cargó. */
	unmapped_products?: string[];
	/** Tiene al menos una línea de un ítem no recurrente (implementación, setup). */
	has_non_recurring: boolean;
	/** Referencias cargadas (propias o vinculadas desde una referencia del contrato). */
	references_count: number;
	/** Factura que corrige (notas de crédito). */
	related_invoice_id?: string | null;
}

/** Monto con signo: las notas de crédito restan; otros documentos (ni factura ni NC) no cuentan. */
export const signedAmount = (invoice: Pick<ScheduleInvoice, 'document_type' | 'amount_contract_ccy'>) => {
	if (isCreditNote(invoice.document_type)) return -Math.abs(invoice.amount_contract_ccy);

	return isInvoiceDocument(invoice.document_type) ? invoice.amount_contract_ccy : 0;
};

const isCurrent = (invoice: Pick<ScheduleInvoice, 'is_active' | 'status'>) => invoice.is_active && invoice.status !== CANCELLED_STATUS;

/**
 * Documentos que cuentan en los montos: facturas y NC vigentes. Una NC que corrige una factura que ya no está vigente
 * (anulación: la factura quedó Cancelada) no resta de nuevo: la factura ya salió de los montos.
 */
export function countedInvoices(invoices: ScheduleInvoice[]): ScheduleInvoice[] {
	const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));

	return invoices.filter((invoice) => {
		if (!isCurrent(invoice)) return false;
		if (isCreditNote(invoice.document_type)) {
			const related = invoice.related_invoice_id ? byId.get(invoice.related_invoice_id) : undefined;

			return !related || isCurrent(related);
		}

		return isInvoiceDocument(invoice.document_type);
	});
}

const isOverdue = (invoice: Pick<ScheduleInvoice, 'status' | 'due_date'>, today: string) =>
	invoice.status === 'Vencida' ||
	((invoice.status === 'Emitida' || invoice.status === 'Enviada') && !!invoice.due_date && invoice.due_date < today);

export interface ContractFinancial {
	invoiced_to_date: number;
	invoiced_pct: number;
	pending_to_invoice: number;
	pending_periods: number;
	/** Por emitir con fecha de emisión de hoy en adelante. */
	pending_on_time: number;
	pending_on_time_count: number;
	/** Por emitir cuya fecha de emisión ya pasó: se debían haber emitido. */
	pending_overdue: number;
	pending_overdue_count: number;
	/** Fecha de emisión más antigua entre las atrasadas. */
	pending_overdue_since: string | null;
	/** Por emitir cuya fecha de emisión se movió respecto de la original. */
	pending_rescheduled: number;
	collected: number;
	paid_count: number;
	overdue: number;
	overdue_count: number;
	overdue_invoice_numbers: string[];
	/** Por cobrar vigente (emitida y aún no vencida). */
	open_receivable: number;
	/** Por cobrar total = vigente + vencido (`invoiced_to_date − collected`). */
	receivable: number;
	/** Total facturable = facturado a la fecha + por facturar (Por Emitir vigentes). */
	total_invoiceable: number;
	/** Total facturable − valor base del contrato (con signo): consumos variables o ajustes. */
	variance_vs_value: number;
}

/**
 * Montos del contrato en su moneda, sobre facturas vigentes (activas y no canceladas). Facturas suman y notas de
 * crédito restan en todos los montos (la NC hereda el estado de la factura que corrige) salvo si corrigen una factura
 * ya cancelada (`countedInvoices`); los conteos son solo de facturas. Invariantes: `facturado = cobrado + vencido +
 * por cobrar vigente`, `por cobrar (receivable) = vigente + vencido`, `por facturar = al día + atrasado` (atrasado: Por
 * Emitir con fecha de emisión anterior a hoy), `total facturable = facturado + por facturar` y `variance_vs_value =
 * total facturable − valor base` (los ítems variables facturan cantidades distintas al valor base del contrato).
 */
export function computeFinancial(invoices: ScheduleInvoice[], tcv: number, today: string): ContractFinancial {
	const result: ContractFinancial = {
		invoiced_to_date: 0,
		invoiced_pct: 0,
		pending_to_invoice: 0,
		pending_periods: 0,
		pending_on_time: 0,
		pending_on_time_count: 0,
		pending_overdue: 0,
		pending_overdue_count: 0,
		pending_overdue_since: null,
		pending_rescheduled: 0,
		collected: 0,
		paid_count: 0,
		overdue: 0,
		overdue_count: 0,
		overdue_invoice_numbers: [],
		open_receivable: 0,
		receivable: 0,
		total_invoiceable: 0,
		variance_vs_value: 0,
	};

	for (const invoice of countedInvoices(invoices)) {
		const amount = signedAmount(invoice);
		const isInvoice = !isCreditNote(invoice.document_type);

		if (invoice.status === PENDING_STATUS) {
			result.pending_to_invoice += amount;
			if (isInvoice) result.pending_periods += 1;
			if (isInvoice && invoice.issue_date && invoice.issue_date < today) {
				result.pending_overdue += amount;
				result.pending_overdue_count += 1;
				if (!result.pending_overdue_since || invoice.issue_date < result.pending_overdue_since)
					result.pending_overdue_since = invoice.issue_date;
			} else {
				result.pending_on_time += amount;
				if (isInvoice) result.pending_on_time_count += 1;
			}
			if (isInvoice && invoice.original_issue_date && invoice.issue_date && invoice.original_issue_date !== invoice.issue_date)
				result.pending_rescheduled += 1;
			continue;
		}
		if (!(ISSUED_STATUSES as readonly string[]).includes(invoice.status ?? '')) continue;
		result.invoiced_to_date += amount;
		if (invoice.status === 'Pagada') {
			result.collected += amount;
			if (isInvoice) result.paid_count += 1;
		} else if (isOverdue(invoice, today)) {
			result.overdue += amount;
			if (isInvoice) {
				result.overdue_count += 1;
				if (invoice.invoice_number) result.overdue_invoice_numbers.push(invoice.invoice_number);
			}
		} else {
			result.open_receivable += amount;
		}
	}

	for (const key of [
		'invoiced_to_date',
		'pending_to_invoice',
		'pending_on_time',
		'pending_overdue',
		'collected',
		'overdue',
		'open_receivable',
	] as const) {
		result[key] = round2(result[key]);
	}
	result.receivable = round2(result.open_receivable + result.overdue);
	result.total_invoiceable = round2(result.invoiced_to_date + result.pending_to_invoice);
	result.variance_vs_value = round2(result.total_invoiceable - tcv);
	result.invoiced_pct = tcv > 0 ? round1((result.invoiced_to_date / tcv) * 100) : 0;

	return result;
}

const inUse = (invoice: ScheduleInvoice) =>
	invoice.is_active && (invoice.status === PENDING_STATUS || (ISSUED_STATUSES as readonly string[]).includes(invoice.status ?? ''));
const isMulticurrency = (invoice: ScheduleInvoice, contractCurrency: string | null | undefined) =>
	!!invoice.invoice_currency && invoice.invoice_currency !== (invoice.contract_currency ?? contractCurrency);

/**
 * Tipo de cambio fijo en uso: con política `fixed`, el más frecuente en facturas por emitir o emitidas facturadas en
 * otra moneda que la del contrato; si no, `null`.
 */
export function fixedFxRate(policy: string | null | undefined, invoices: ScheduleInvoice[], contractCurrency?: string | null): number | null {
	if (policy !== 'fixed') return null;

	return mostCommon(
		invoices.filter((invoice) => inUse(invoice) && isMulticurrency(invoice, contractCurrency)).map((invoice) => invoice.fx_contract_to_invoice)
	);
}

/**
 * Moneda de facturación en uso: la del contrato si difiere de la del contrato; si no (o falta), la más frecuente entre
 * sus facturas en otra moneda. Las facturas mandan cuando el contrato guarda la misma moneda en ambos campos.
 */
export function invoiceCurrencyInUse(
	contractCurrency: string | null | undefined,
	storedInvoiceCurrency: string | null | undefined,
	invoices: ScheduleInvoice[]
): string | null {
	if (storedInvoiceCurrency && storedInvoiceCurrency !== contractCurrency) return storedInvoiceCurrency;

	return (
		mostCommon(
			invoices.filter((invoice) => inUse(invoice) && isMulticurrency(invoice, contractCurrency)).map((invoice) => invoice.invoice_currency)
		) ??
		storedInvoiceCurrency ??
		mostCommon(invoices.filter(inUse).map((invoice) => invoice.invoice_currency)) ??
		null
	);
}

// ---------------------------------------------------------------- bloqueos de envío

export const PRODUCT_WITHOUT_ERP_MAPPING_CODE = 'product_without_erp_mapping';

/**
 * Nombres de los productos de las líneas que viajarían al ERP sin producto de Odoo (alias de factura `invoiceAlias`). Replica EXACTO el
 * envío del scheduler (`invoice-scheduler.service.ts`, `mapInvoiceToOdooFormat` + `getProductMappingInfo`):
 * - viajan las líneas visibles (`visible_line_id IS NULL`) con cantidad ≠ 0; si todas las visibles están en 0, viajan todas las visibles;
 * - el producto resuelve si existe un `odoo_product_mappings` del holding (`holding_id`, `sapira_product_id`) o si
 *   `products.odoo_product_id` tiene valor (≠ 0; el scheduler lo evalúa por verdad).
 * Las líneas sin `product_id` no entran: ya las bloquea `item_without_product`. Devuelve `text[]` (vacío si todo resuelve).
 */
export const UNMAPPED_PRODUCTS_SQL = (
	invoiceAlias: string
) => `(SELECT COALESCE(array_agg(DISTINCT COALESCE(NULLIF(TRIM(p.name), ''), ii.product_id::text)
			ORDER BY COALESCE(NULLIF(TRIM(p.name), ''), ii.product_id::text)), '{}'::text[])
		FROM invoice_items ii
		LEFT JOIN products p ON p.id = ii.product_id
		WHERE ii.invoice_id = ${invoiceAlias}.id AND ii.visible_line_id IS NULL AND ii.product_id IS NOT NULL
			AND (COALESCE(ii.quantity, 0) <> 0 OR NOT EXISTS (
				SELECT 1 FROM invoice_items z WHERE z.invoice_id = ${invoiceAlias}.id AND z.visible_line_id IS NULL AND COALESCE(z.quantity, 0) <> 0))
			AND NOT EXISTS (
				SELECT 1 FROM odoo_product_mappings m WHERE m.holding_id = ${invoiceAlias}.holding_id AND m.sapira_product_id = ii.product_id)
			AND COALESCE(p.odoo_product_id, 0) = 0)`;

/** Mensaje del bloqueo con los productos nombrados (máximo 3 y "y N más"). */
export function unmappedProductsMessage(products: string[]): string {
	const shown = products.slice(0, 3).map((name) => `«${name}»`);
	const rest = products.length - shown.length;
	const list = rest > 0 ? `${shown.join(', ')} y ${rest} más` : shown.join(', ');

	return products.length === 1
		? `El producto ${list} no está mapeado a un producto del ERP (Odoo): la factura no se puede enviar`
		: `Los productos ${list} no están mapeados a productos del ERP (Odoo): la factura no se puede enviar`;
}

export type BlockerCode =
	| 'needs_reference'
	| 'fixed_fx_without_rate'
	| 'no_erp_partner'
	| 'item_without_product'
	| 'product_without_erp_mapping'
	| 'past_issue_date';

export interface Blocker {
	code: BlockerCode;
	message: string;
}

export interface BlockerContext {
	/** El contrato exige referencias para facturar. */
	requires_references: boolean;
	fx_invoice_policy: string | null;
	contract_currency: string | null;
	/** Envío automático al ERP (NULL cuenta como sí, igual que el scheduler). */
	auto_send: boolean;
	/** La razón social está vinculada a un cliente en el ERP. */
	has_erp_partner: boolean;
	has_entity: boolean;
	today: string;
}

/** Lo que impediría enviar una factura por emitir (o la dejaría mal). Solo aplica a facturas Por Emitir. */
export function computeBlockers(invoice: ScheduleInvoice, context: BlockerContext): Blocker[] {
	const blockers: Blocker[] = [];

	if ((context.requires_references || invoice.requires_references) && invoice.references_count === 0) {
		blockers.push({
			code: 'needs_reference',
			message: 'El contrato exige referencias para facturar (por ejemplo, una orden de compra) y esta factura todavía no tiene ninguna.',
		});
	}
	const contractCurrency = invoice.contract_currency ?? context.contract_currency;

	if (
		context.fx_invoice_policy === 'fixed' &&
		invoice.invoice_currency &&
		contractCurrency &&
		invoice.invoice_currency !== contractCurrency &&
		invoice.fx_contract_to_invoice === null
	) {
		blockers.push({
			code: 'fixed_fx_without_rate',
			message: 'Usa tipo de cambio fijo pero no tiene la tasa cargada: complétala antes de enviarla.',
		});
	}
	if (context.auto_send && !context.has_erp_partner) {
		blockers.push({
			code: 'no_erp_partner',
			message: context.has_entity
				? 'Se envía automáticamente al ERP, pero la razón social todavía no está vinculada a un cliente en el ERP.'
				: 'Se envía automáticamente al ERP, pero el contrato no tiene razón social asignada.',
		});
	}
	if (invoice.lines_without_product > 0) {
		const count = invoice.lines_without_product;

		blockers.push({
			code: 'item_without_product',
			message:
				count === 1
					? 'Una línea no tiene un producto del catálogo asociado.'
					: `${count} líneas no tienen un producto del catálogo asociado.`,
		});
	}
	// Mismo bloqueo que el envío (`productMappingBlocker` de `contract-invoices.ts`); aquí solo si el contrato envía al ERP.
	if (context.auto_send && invoice.unmapped_products?.length) {
		blockers.push({ code: 'product_without_erp_mapping', message: unmappedProductsMessage(invoice.unmapped_products) });
	}
	if (invoice.issue_date && invoice.issue_date.slice(0, 7) < context.today.slice(0, 7)) {
		blockers.push({ code: 'past_issue_date', message: 'La fecha de emisión quedó en un mes pasado: actualízala para que se envíe' });
	}

	return blockers;
}

/** Próxima factura: la Por Emitir activa con la fecha de emisión más temprana (puede estar en el pasado). */
export function pickNextInvoice(invoices: ScheduleInvoice[]): ScheduleInvoice | null {
	return (
		invoices
			.filter((invoice) => invoice.is_active && invoice.status === PENDING_STATUS && !isCreditNote(invoice.document_type))
			.sort((a, b) => (a.issue_date ?? '9999').localeCompare(b.issue_date ?? '9999') || a.id.localeCompare(b.id))[0] ?? null
	);
}

// ---------------------------------------------------------------- tipo de cambio guardado

/** Tasa guardada en `contract_fx_period_rates`, ya normalizada a "1 [moneda del contrato] = rate [otra moneda]". */
export interface StoredFxRate {
	rate: number;
	period_start: string | null;
	period_end: string | null;
}

export interface StoredFxRateRow {
	purpose: string | null;
	from_currency: string | null;
	to_currency: string | null;
	rate: number;
	period_start: string | null;
	period_end: string | null;
}

const round6 = (value: number) => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;

/**
 * Tasas de un propósito (`invoice` o `company`) con la regla única del mapa (§3b): la fila directa (`from` = moneda del
 * contrato) se usa tal cual y la inversa (`to` = moneda del contrato, datos viejos) como `1 / rate`. Orden: por inicio
 * de período, las sin fecha (cubren todo el contrato) primero.
 */
export function normalizeFxRates(
	rows: StoredFxRateRow[],
	purpose: 'invoice' | 'company',
	contractCurrency: string | null | undefined
): StoredFxRate[] {
	const contract = (contractCurrency ?? '').trim().toUpperCase();

	return rows
		.filter((row) => (row.purpose ?? 'company') === purpose && Number.isFinite(row.rate) && row.rate > 0)
		.map((row) => {
			const from = (row.from_currency ?? '').trim().toUpperCase();
			const to = (row.to_currency ?? '').trim().toUpperCase();
			const inverse = contract !== '' && from !== contract && to === contract;

			return { rate: inverse ? round6(1 / row.rate) : row.rate, period_start: row.period_start, period_end: row.period_end };
		})
		.sort((a, b) => (a.period_start ?? '').localeCompare(b.period_start ?? ''));
}

// ---------------------------------------------------------------- documentos

/** Bucket privado donde viven los documentos del contrato (`file_url` guarda una URL pública que no abre). */
export const CONTRACT_DOCUMENTS_BUCKET = 'contract-documents';

/**
 * Ruta del objeto dentro del bucket a partir de `file_url` (`…/storage/v1/object/public/contract-documents/<contrato>/<ts>.pdf`).
 * `null` si la URL no apunta al bucket o no tiene ruta.
 */
export function contractDocumentPath(fileUrl: string | null | undefined): string | null {
	const value = (fileUrl ?? '').trim();

	if (!value) return null;
	const match = new RegExp(`/storage/v1/object/(?:public|sign|authenticated)/${CONTRACT_DOCUMENTS_BUCKET}/([^?#]+)`).exec(value);

	if (!match) return null;
	try {
		const path = decodeURIComponent(match[1]).replace(/^\/+/, '');

		return path && !path.includes('..') ? path : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- ciclo de vida

export type LifecycleStageKey = 'draft' | 'active' | 'expiry' | 'closed';
export type LifecycleStageState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface LifecycleStage {
	key: LifecycleStageKey;
	label: string;
	date: string | null;
	state: LifecycleStageState;
	/** Por qué la etapa alcanzada no lleva fecha (p. ej. activación sin evento registrado). */
	note?: string;
	/** Solo en Activo: inicio del servicio (puede ser anterior a la creación: facturación retroactiva). */
	service_start_date?: string | null;
}

export const ACTIVATION_DATE_MISSING = 'Fecha de activación no registrada (contrato anterior a v2)';

export interface LifecycleInput {
	derived_status: ContractDerivedStatus;
	created_at: string | null;
	/**
	 * Fecha del evento `ACTIVATION`, únicamente: sin evento la etapa se muestra alcanzada pero sin fecha. Nunca se usa el
	 * inicio del servicio (en onboarding puede ser anterior a la creación: facturación retroactiva) ni la fecha de cierre.
	 */
	activation_date: string | null;
	/** Inicio del servicio (primer ítem vigente): se muestra bajo Activo como dato aparte, nunca como fecha de la etapa. */
	service_start_date?: string | null;
	next_item_end_date: string | null;
	/** Fin del primer ítem que terminó sin renovarse ni darse de baja (fecha de "Por renovar"/"Vencido"). */
	overdue_renewal_date: string | null;
	closed_date: string | null;
}

/**
 * Etapas del contrato según el estado mostrado: Borrador → Activo → Vencimiento (Por renovar | Vencido cuando toca) →
 * Cerrado. El cierre solo se marca si el contrato está cancelado; si no, queda `skipped`. Pausado y "otro" se ven como
 * activos. El borrador lleva `created_at` y Activo la fecha del evento de activación (sin evento, sin fecha y con nota);
 * vencimiento y cierre se omiten si quedaran antes de la etapa anterior (fechas monotónicas).
 */
export function buildLifecycle(input: LifecycleInput): { stages: LifecycleStage[] } {
	const status = input.derived_status;
	const expiryLabel = status === 'pending_renewal' ? 'Por renovar' : status === 'expired' ? 'Vencido' : 'Vencimiento';
	const expiryDate =
		status === 'pending_renewal' || status === 'expired' ? (input.overdue_renewal_date ?? input.next_item_end_date) : input.next_item_end_date;
	let states: Record<LifecycleStageKey, LifecycleStageState>;

	switch (status) {
		case 'draft':
			states = { draft: 'current', active: 'upcoming', expiry: 'upcoming', closed: 'skipped' };
			break;
		case 'pending_renewal':
		case 'expired':
			states = { draft: 'done', active: 'done', expiry: 'current', closed: 'skipped' };
			break;
		case 'cancelled':
			states = { draft: 'done', active: input.activation_date ? 'done' : 'skipped', expiry: 'skipped', closed: 'current' };
			break;
		default:
			states = { draft: 'done', active: 'current', expiry: 'upcoming', closed: 'skipped' };
	}
	const activation = status === 'draft' ? null : input.activation_date;
	const activeStage: LifecycleStage = {
		key: 'active',
		label: 'Activo',
		date: activation,
		state: states.active,
		service_start_date: input.service_start_date ?? null,
	};

	if (!activation && (states.active === 'done' || states.active === 'current')) activeStage.note = ACTIVATION_DATE_MISSING;
	const stages: LifecycleStage[] = [
		{ key: 'draft', label: 'Borrador', date: input.created_at, state: states.draft },
		activeStage,
		{ key: 'expiry', label: expiryLabel, date: status === 'cancelled' ? null : expiryDate, state: states.expiry },
		{ key: 'closed', label: 'Cancelado', date: status === 'cancelled' ? input.closed_date : null, state: states.closed },
	];
	// Vencimiento y cierre nunca quedan antes de la última fecha conocida (borrador o activación).
	let last = activation ?? input.created_at ?? null;

	for (const stage of stages.slice(2)) {
		if (!stage.date) continue;
		if (last && stage.date < last) stage.date = null;
		else last = stage.date;
	}

	return { stages };
}

// ---------------------------------------------------------------- calendario de facturación

export type ScheduleState = 'paid' | 'issued' | 'overdue' | 'scheduled' | 'cancelled' | 'credit_note';

/** Estado de la fila del calendario. Canceladas e inactivas primero; luego NC; luego el estado de cobro. */
export function scheduleState(invoice: Pick<ScheduleInvoice, 'is_active' | 'status' | 'document_type' | 'due_date'>, today: string): ScheduleState {
	if (!invoice.is_active || invoice.status === CANCELLED_STATUS) return 'cancelled';
	if (isCreditNote(invoice.document_type)) return 'credit_note';
	if (invoice.status === PENDING_STATUS) return 'scheduled';
	if (invoice.status === 'Pagada') return 'paid';
	if (isOverdue(invoice, today)) return 'overdue';

	return 'issued';
}

export interface ScheduleRow {
	key: string;
	period_start: string | null;
	period_end: string | null;
	period_label: string;
	invoice_id: string | null;
	invoice_number: string | null;
	issue_date: string | null;
	due_date: string | null;
	state: ScheduleState;
	amount_contract_ccy: number;
	amount_invoice_ccy: number | null;
	invoice_currency: string | null;
	lines_count: number;
	is_setup: boolean;
	blockers: Blocker[];
	/** Varias facturas futuras iguales en una fila: `amount_*` es el de cada una y `total_*` la suma. */
	grouped: { count: number; invoice_ids: string[]; total_contract_ccy: number; total_invoice_ccy: number | null } | null;
}

/** Filas de facturas futuras iguales que se juntan cuando son más de este número. */
export const GROUP_MIN_ROWS = 3;
/** Las primeras facturas futuras por emitir que siempre quedan sueltas. */
export const GROUP_KEEP_FIRST = 2;

/**
 * Agrupa la cola del calendario: facturas **futuras** por emitir, consecutivas al final, con el mismo monto, sin
 * bloqueos y sin ítems de única vez, en una sola fila cuando son más de `GROUP_MIN_ROWS`. Las primeras
 * `GROUP_KEEP_FIRST` facturas futuras por emitir siempre quedan sueltas.
 */
export function groupTrailingRows(rows: ScheduleRow[], today: string): ScheduleRow[] {
	const isFuture = (row: ScheduleRow) => row.state === 'scheduled' && !!row.issue_date && row.issue_date > today;
	const keep = new Set(rows.filter(isFuture).slice(0, GROUP_KEEP_FIRST));
	const last = rows[rows.length - 1];

	if (!last) return rows;
	const sameAmount = (row: ScheduleRow) =>
		row.amount_contract_ccy === last.amount_contract_ccy && row.amount_invoice_ccy === last.amount_invoice_ccy;
	const eligible = (row: ScheduleRow) => isFuture(row) && !keep.has(row) && row.blockers.length === 0 && !row.is_setup && sameAmount(row);
	let start = rows.length;

	while (start > 0 && eligible(rows[start - 1])) start -= 1;
	const run = rows.slice(start);

	if (run.length <= GROUP_MIN_ROWS) return rows;
	const first = run[0];
	const final = run[run.length - 1];

	return [
		...rows.slice(0, start),
		{
			...first,
			key: `group:${first.invoice_id}`,
			period_start: first.period_start,
			period_end: final.period_end,
			period_label: `${shortMonth(first.period_start ?? first.issue_date!)} → ${shortMonth(final.period_end ?? final.issue_date!)}`,
			invoice_id: null,
			invoice_number: null,
			grouped: {
				count: run.length,
				invoice_ids: run.map((row) => row.invoice_id!),
				total_contract_ccy: round2(run.reduce((sum, row) => sum + row.amount_contract_ccy, 0)),
				total_invoice_ccy:
					first.amount_invoice_ccy === null ? null : round2(run.reduce((sum, row) => sum + (row.amount_invoice_ccy ?? 0), 0)),
			},
		},
	];
}

export interface ScheduleOptions {
	includeCancelled: boolean;
	tcv: number;
	today: string;
	blockerContext: BlockerContext;
}

/** Arma el calendario por período (filas, totales y cobranza). */
export function buildSchedule(invoices: ScheduleInvoice[], options: ScheduleOptions) {
	const { today } = options;
	const withState = invoices.map((invoice) => ({ invoice, state: scheduleState(invoice, today) }));
	const rows: ScheduleRow[] = withState
		.filter(({ state }) => options.includeCancelled || state !== 'cancelled')
		.map(({ invoice, state }) => {
			const periodStart = invoice.period_start ?? (invoice.issue_date ? monthStart(invoice.issue_date) : null);
			const periodEnd = invoice.period_end ?? (invoice.issue_date ? monthEnd(invoice.issue_date) : null);
			const sign = isCreditNote(invoice.document_type) ? -1 : 1;

			return {
				key: invoice.id,
				period_start: periodStart,
				period_end: periodEnd,
				period_label: periodLabel(periodStart, periodEnd),
				invoice_id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				due_date: invoice.due_date,
				state,
				amount_contract_ccy: round2(sign * Math.abs(invoice.amount_contract_ccy)),
				amount_invoice_ccy: invoice.amount_invoice_ccy === null ? null : round2(sign * Math.abs(invoice.amount_invoice_ccy)),
				invoice_currency: invoice.invoice_currency,
				lines_count: invoice.lines_count,
				is_setup: invoice.has_non_recurring,
				blockers: state === 'scheduled' ? computeBlockers(invoice, options.blockerContext) : [],
				grouped: null,
			};
		})
		.sort(
			(a, b) =>
				(a.period_start ?? '9999').localeCompare(b.period_start ?? '9999') ||
				(a.issue_date ?? '9999').localeCompare(b.issue_date ?? '9999') ||
				(a.invoice_number ?? '').localeCompare(b.invoice_number ?? '') ||
				a.key.localeCompare(b.key)
		);
	const financial = computeFinancial(invoices, options.tcv, today);
	const byState = (state: ScheduleState) => withState.filter((row) => row.state === state);
	const scheduled = byState('scheduled');

	return {
		rows: groupTrailingRows(rows, today),
		totals: {
			periods: withState.filter(({ state }) => state !== 'cancelled' && state !== 'credit_note').length,
			issued: byState('paid').length + byState('issued').length + byState('overdue').length,
			scheduled: scheduled.length,
			cancelled: byState('cancelled').length,
			contract_total: round2(options.tcv),
			scheduled_total: financial.pending_to_invoice,
			issued_total: financial.invoiced_to_date,
		},
		collection: {
			paid: { amount: financial.collected, count: financial.paid_count },
			overdue: { amount: financial.overdue, count: financial.overdue_count, invoice_numbers: financial.overdue_invoice_numbers },
			to_invoice: { amount: financial.pending_to_invoice, count: financial.pending_periods },
		},
	};
}

// ---------------------------------------------------------------- consumo (Pricing v2 etapa 2 + cantidades del front viejo)

/** Fila histórica de `quantities` (la escribe solo el front viejo; v2 la lee, spec §7). */
export interface QuantityRow {
	id: string;
	contract_item_id: string;
	period: string;
	quantity: number | null;
	unit_price: number | null;
	amount: number | null;
	account: string | null;
}

/** Consumo vigente de `consumption_entries` (una fila por ítem y período). */
export interface ConsumptionEntryRow {
	id: string;
	contract_item_id: string;
	period_start: string;
	period_end: string;
	quantity: number;
	amount_override: number | null;
	apply_item_discount: boolean;
	account: string | null;
	is_estimated: boolean;
	source: string;
	revision: number;
	correction_reason: string | null;
	notes: string | null;
	idempotency_key: string | null;
	/** Factura que lleva el consumo (Por Emitir recalculada, complementaria o reemitida); null si solo había anuladas. */
	invoice_id: string | null;
	created_at: string | null;
	updated_at: string | null;
	revisions_count: number;
	recorded_by: { id: string; name: string | null } | null;
	/** = `updated_at` de la entry. */
	recorded_at: string | null;
	/** Historial desde `consumption_entry_revisions`, más nuevo primero (máx. 20). */
	revisions: Array<{
		revision: number;
		quantity: number;
		amount_override: number | null;
		correction_reason: string | null;
		recorded_by: { id: string; name: string | null } | null;
		recorded_at: string | null;
	}>;
}

export interface ConsumptionItem {
	id: string;
	product_name: string | null;
	account: string | null;
	quantity: number | null;
	unit_of_measure: string | null;
	/** Resumen del precio inline (`prices`), o null = standard fijo. */
	price: (PriceSpec & { id: string; name: string | null; version: number; status: string | null }) | null;
	metric: { id: string; code: string; name: string; unit: string; aggregation: string } | null;
}

export interface ConsumptionInvoiceLine {
	line_id: string;
	contract_item_id: string;
	billing_period_start: string | null;
	billing_period_end: string | null;
	quantity: number | null;
	quantity_source: string | null;
	subtotal: number | null;
	pricing_breakdown: PricedSubline[] | null;
	invoice_id: string;
	invoice_number: string | null;
	status: string | null;
	is_active: boolean;
	issue_date: string | null;
	document_type: string | null;
	invoice_type: string | null;
	is_legacy: boolean;
}

export interface ConsumptionBuildInput {
	entries: ConsumptionEntryRow[];
	quantities: QuantityRow[];
	items: ConsumptionItem[];
	lines: ConsumptionInvoiceLine[];
	/** `YYYY-MM-DD`: marca los períodos en curso y los pendientes con período terminado. */
	today: string;
}

const isMeteredItem = (item: ConsumptionItem) => item.price?.quantity_type === 'metered';
/** Factura que el consumo puede tocar (mismo criterio que `consumption.ts`): activa, tipo factura, no unificada ni legacy. */
const isRecomputableLine = (line: ConsumptionInvoiceLine) =>
	line.is_active && !line.is_legacy && line.invoice_type !== 'Unificada' && !isCreditNote(line.document_type) && line.document_type !== 'ND';
const complementsOf = (line: ConsumptionInvoiceLine) => line.pricing_breakdown?.find((subline) => subline.kind === 'invoiced') ?? null;
/** Factura de la línea; `is_complementary` y `complements_invoice_id` cuando es una complementaria por consumo adicional (spec §4.4). */
const lineInvoice = (line: ConsumptionInvoiceLine) => {
	const complements = complementsOf(line);

	return {
		id: line.invoice_id,
		number: line.invoice_number,
		status: line.status,
		issue_date: line.issue_date,
		is_complementary: Boolean(complements),
		complements_invoice_id: complements?.invoice_id ?? null,
	};
};

/**
 * Consumos del contrato (`GET /contracts/:id/consumption`, spec §5):
 * - `uses_usage_pricing`: existe un ítem con precio `metered`;
 * - `rows`: `consumption_entries` cruzadas con la línea del período (cantidad, origen, desglose, factura y estado) más las
 *   `quantities` históricas del front viejo (`source = legacy`), más nuevas primero;
 * - `items[]`: **todos** los ítems (medidos y estándar) con `uses_usage_pricing`, precio, métrica y sus períodos facturables
 *   (`accepts_consumption` cuando la factura del período está Por Emitir, sea el ítem medido o estándar);
 * - `pending[]`: líneas medidas (solo ítems medidos) con período terminado y sin consumo informado.
 * Si un período tiene varias facturas, gana la vigente (activa, tipo factura, no anulada).
 */
/**
 * Junta las filas `per_tier` (spec §3.8) de un mismo ítem, período y factura en una sola línea lógica: cantidad del período
 * (`period_quantity` de las sublíneas), subtotal = Σ filas y el desglose concatenado en el orden de las filas. Las líneas
 * `single` pasan tal cual.
 */
export function groupConsumptionLines(lines: ConsumptionInvoiceLine[]): Array<ConsumptionInvoiceLine & { line_ids: string[] }> {
	const groups = new Map<string, ConsumptionInvoiceLine[]>();

	for (const line of lines) {
		const key = `${line.contract_item_id}|${line.billing_period_start ?? ''}|${line.invoice_id}`;

		groups.set(key, [...(groups.get(key) ?? []), line]);
	}
	const indexOf = (line: ConsumptionInvoiceLine) => line.pricing_breakdown?.find((subline) => subline.line_index !== undefined)?.line_index ?? 0;

	return [...groups.values()].map((group) => {
		const ordered = [...group].sort((a, b) => indexOf(a) - indexOf(b) || a.line_id.localeCompare(b.line_id));
		const [first] = ordered;

		if (ordered.length === 1) return { ...first, line_ids: [first.line_id] };
		const marked = ordered.flatMap((line) => line.pricing_breakdown ?? []).find((subline) => subline.period_quantity !== undefined);
		const subtotal = ordered.every((line) => line.subtotal === null)
			? null
			: round2(ordered.reduce((sum, line) => sum + (line.subtotal ?? 0), 0));

		return {
			...first,
			line_ids: ordered.map((line) => line.line_id),
			quantity: marked ? Number(marked.period_quantity) : first.quantity,
			subtotal,
			pricing_breakdown: ordered.some((line) => line.pricing_breakdown) ? ordered.flatMap((line) => line.pricing_breakdown ?? []) : null,
		};
	});
}

export function buildConsumption(input: ConsumptionBuildInput) {
	const { entries, quantities, items, today } = input;
	const lines = groupConsumptionLines(input.lines);
	const itemById = new Map(items.map((item) => [item.id, item]));
	const linesFor = (itemId: string, periodStart: string) =>
		lines.filter((line) => line.contract_item_id === itemId && !!line.billing_period_start && line.billing_period_start === periodStart);
	const bestLine = (candidates: ConsumptionInvoiceLine[]) =>
		candidates.find((line) => isRecomputableLine(line) && line.status === 'Por Emitir') ??
		candidates.find((line) => isRecomputableLine(line) && line.status !== CANCELLED_STATUS && line.status !== 'Anulada') ??
		candidates[0] ??
		null;
	const legacyInvoice = (itemId: string, period: string) => {
		const matches = lines.filter(
			(line) => line.contract_item_id === itemId && !!line.billing_period_start && line.billing_period_start.slice(0, 7) === period.slice(0, 7)
		);
		const best = matches.find((line) => line.is_active && line.status !== CANCELLED_STATUS) ?? matches[0];

		return best ? { id: best.invoice_id, number: best.invoice_number, status: best.status, issue_date: best.issue_date } : null;
	};

	const entryRows = entries.map((entry) => {
		const item = itemById.get(entry.contract_item_id);
		const candidates = linesFor(entry.contract_item_id, entry.period_start);
		// La entry sabe qué factura la lleva (complementaria o reemitida); si no, gana la vigente del período.
		const line = (entry.invoice_id ? candidates.find((candidate) => candidate.invoice_id === entry.invoice_id) : null) ?? bestLine(candidates);

		return {
			id: entry.id,
			kind: 'entry' as const,
			item_id: entry.contract_item_id,
			product_name: item?.product_name ?? null,
			account: entry.account ?? item?.account ?? null,
			period: entry.period_start,
			period_start: entry.period_start,
			period_end: entry.period_end,
			quantity: entry.quantity,
			unit: item?.metric?.unit ?? item?.unit_of_measure ?? null,
			amount_override: entry.amount_override,
			apply_item_discount: entry.apply_item_discount,
			is_estimated: entry.is_estimated,
			in_progress: entry.period_end >= today && entry.period_start <= today,
			upcoming: entry.period_start > today,
			source: entry.source,
			revision: entry.revision,
			revisions_count: entry.revisions_count,
			correction_reason: entry.correction_reason,
			notes: entry.notes,
			created_at: entry.created_at,
			updated_at: entry.updated_at,
			recorded_by: entry.recorded_by,
			recorded_at: entry.recorded_at,
			revisions: entry.revisions,
			quantity_source: line?.quantity_source ?? null,
			amount: line?.subtotal ?? null,
			pricing_breakdown: line?.pricing_breakdown ?? null,
			invoice: line ? lineInvoice(line) : null,
		};
	});
	const legacyRows = quantities.map((row) => {
		const item = itemById.get(row.contract_item_id);
		const period = monthStart(row.period);

		return {
			id: row.id,
			kind: 'legacy' as const,
			item_id: row.contract_item_id,
			product_name: item?.product_name ?? null,
			account: row.account ?? item?.account ?? null,
			period,
			period_start: period,
			period_end: null,
			quantity: row.quantity,
			unit: item?.unit_of_measure ?? null,
			unit_price: row.unit_price,
			amount: row.amount ?? (row.quantity !== null && row.unit_price !== null ? round2(row.quantity * row.unit_price) : null),
			source: 'legacy',
			revision: 1,
			is_estimated: false,
			in_progress: false,
			upcoming: false,
			quantity_source: null,
			pricing_breakdown: null,
			invoice: legacyInvoice(row.contract_item_id, period),
		};
	});
	const rows = [...entryRows, ...legacyRows].sort(
		(a, b) => b.period.localeCompare(a.period) || (a.product_name ?? '').localeCompare(b.product_name ?? '')
	);
	const entryByKey = new Map(entries.map((entry) => [`${entry.contract_item_id}|${entry.period_start}`, entry]));
	const pending: Array<{
		item_id: string;
		product_name: string | null;
		account: string | null;
		period_start: string;
		period_end: string | null;
		invoice: ReturnType<typeof lineInvoice>;
	}> = [];

	const itemsOut = items.map((item) => {
		const periodStarts = [
			...new Set(
				lines.filter((line) => line.contract_item_id === item.id && line.billing_period_start).map((line) => line.billing_period_start!)
			),
		].sort();
		const periods = periodStarts.map((periodStart) => {
			const line = bestLine(linesFor(item.id, periodStart))!;
			const entry = entryByKey.get(`${item.id}|${periodStart}`) ?? null;
			const ended = !!line.billing_period_end && line.billing_period_end < today;
			const isPending =
				isMeteredItem(item) &&
				line.status === 'Por Emitir' &&
				isRecomputableLine(line) &&
				(line.quantity_source === 'pending' || (!entry && line.quantity_source === null));

			if (isPending && ended)
				pending.push({
					item_id: item.id,
					product_name: item.product_name,
					account: item.account,
					period_start: periodStart,
					period_end: line.billing_period_end,
					invoice: lineInvoice(line),
				});

			return {
				period_start: periodStart,
				period_end: line.billing_period_end,
				// En curso = hoy cae dentro del período; los que aún no empiezan son `upcoming` (no "en curso").
				in_progress: !ended && periodStart <= today,
				upcoming: periodStart > today,
				quantity: line.quantity,
				quantity_source: line.quantity_source,
				amount: line.subtotal,
				pricing_breakdown: line.pricing_breakdown,
				entry_id: entry?.id ?? null,
				invoice: lineInvoice(line),
				/**
				 * Solo una Por Emitir activa acepta cantidad (también en ítems estándar: cantidad × unitario del período); emitida =
				 * complementaria o reemisión (`apply_as`, S7-7).
				 */
				accepts_consumption: line.status === 'Por Emitir' && isRecomputableLine(line),
			};
		});

		return {
			item_id: item.id,
			product_name: item.product_name,
			account: item.account,
			quantity: item.quantity,
			unit_of_measure: item.unit_of_measure,
			uses_usage_pricing: isMeteredItem(item),
			price: item.price,
			metric: item.metric,
			periods,
		};
	});

	return {
		uses_usage_pricing: items.some(isMeteredItem),
		rows,
		items: itemsOut,
		pending: pending.sort((a, b) => a.period_start.localeCompare(b.period_start) || (a.product_name ?? '').localeCompare(b.product_name ?? '')),
	};
}

// ---------------------------------------------------------------- ítems: renovación y facturación

export interface FactsItem {
	is_recurring: boolean;
	categoria: string | null;
	churn_date: string | null;
	start_date: string | null;
	end_date: string | null;
	renewed_by_item_id: string | null;
	auto_renew: boolean;
	auto_renew_term_months: number | null;
	term_months: number | null;
	billing_frequency: string | null;
	billing_method: string | null;
}

/**
 * Renovación y facturación del contrato desde sus ítems. Mismo universo que el estado mostrado: ítems recurrentes que
 * no son ajustes de baja ni tienen churn. "Vigentes" = sin renovar y sin terminar hoy.
 */
export function summarizeItems(items: FactsItem[], today: string, contractTerm: number | null) {
	const considered = items.filter((item) => item.is_recurring && !['CHURN', 'DOWNSELL'].includes(item.categoria ?? '') && !item.churn_date);
	const live = considered.filter((item) => !item.renewed_by_item_id && (item.end_date === null || item.end_date >= today));
	const active = live.filter((item) => !item.start_date || item.start_date <= today);
	const autoRenew = live.filter((item) => item.auto_renew);
	const billingSource = active.length ? active : live.length ? live : considered.length ? considered : items;
	const overdue = considered
		.filter((item) => item.end_date !== null && item.end_date < today && !item.renewed_by_item_id)
		.map((item) => item.end_date!)
		.sort();

	return {
		renewal: {
			auto_renew_items: autoRenew.length,
			recurring_items: live.length,
			term_months:
				mostCommon(autoRenew.map((item) => item.auto_renew_term_months)) ?? mostCommon(live.map((item) => item.term_months)) ?? contractTerm,
		},
		frequency: mostCommon(billingSource.map((item) => item.billing_frequency)),
		method: mostCommon(billingSource.map((item) => item.billing_method)),
		overdue_renewal_date: overdue[0] ?? null,
	};
}
