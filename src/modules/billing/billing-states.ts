/**
 * Facturación v2 (`docs/v2-rediseno/spec-facturacion-v2.md` §3, §6): reglas puras, sin base. Estados derivados de lectura (documento, ERP,
 * emisión electrónica, pago), recálculo del estado por pagos (también hacia atrás al anular un pago), antigüedad de cuentas por cobrar,
 * grupos de la cola Por emitir, agrupación del fan-out por contrato, días de recordatorio y plantillas de correo escapadas.
 *
 * Cada estado derivado tiene su gemelo SQL en `billing-sql.ts` (mismo orden de reglas) para filtrar y paginar en la base.
 * Fechas `YYYY-MM-DD` (texto, `todayFor`): se comparan como string; nunca `toISOString()`.
 */
import { diffDays } from '@/modules/contracts/billing-engine';
import { CANCELLED_STATUS, creditNotePendingEmission, isCreditNote, PENDING_STATUS } from '@/modules/contracts/contract-360';

// ---------------------------------------------------------------- catálogos

export const INVOICE_STATUSES = ['Por Emitir', 'Emitida', 'Enviada', 'Pagada', 'Vencida', 'Cancelada', 'Consolidada', 'Dividida'] as const;
/** Emitidas que pueden tener saldo (las únicas que reciben pagos y entran en cuentas por cobrar). */
export const RECEIVABLE_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'] as const;
export const DOCUMENT_KINDS = ['invoice', 'credit_note', 'debit_note'] as const;
export const ERP_STATES = ['none', 'draft', 'sent', 'not_applicable'] as const;
export const ELECTRONIC_STATES = ['pending_emission', 'issued_erp', 'issued_external', 'not_issued', 'voided'] as const;
export const PAYMENT_STATES = ['unpaid', 'partial', 'paid', 'overdue', 'not_applicable'] as const;
export const TO_ISSUE_GROUPS = ['ready', 'blocked', 'late', 'erp_draft'] as const;
export const CREDIT_TYPES = ['cancellation', 'discount'] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type ErpState = (typeof ERP_STATES)[number];
export type ElectronicState = (typeof ELECTRONIC_STATES)[number];
export type PaymentState = (typeof PAYMENT_STATES)[number];
export type ToIssueGroup = (typeof TO_ISSUE_GROUPS)[number];

/** Bloqueo de Facturación: `{ code, message, next_step }` (mismo contrato que el 360) + la acción que lo resuelve en la UI. */
export interface BillingBlocker {
	code: string;
	message: string;
	next_step?: string | null;
	action?: string | null;
}

export const PAYMENT_EVENT_TYPES = {
	registered: 'INVOICE_PAYMENT_REGISTERED',
	voided: 'INVOICE_PAYMENT_VOIDED',
	collection: 'INVOICE_COLLECTION_SENT',
} as const;

/**
 * Motivos de un ajuste no monetario (`invoice_payments.settlement_reason`, spec-conciliacion-v2 §2.1 #5, decisión 3): cierran la diferencia
 * entre lo recibido y el saldo sin NC. Un descuento o rebaja comercial NO es un motivo: va por NC ligada a la factura.
 */
export const SETTLEMENT_REASONS = ['bank_fee', 'withholding', 'fx_difference', 'rounding', 'other'] as const;
export type SettlementReason = (typeof SETTLEMENT_REASONS)[number];

/** Tolerancia de redondeo al comparar pagos contra el total (centavos). */
export const PAYMENT_EPSILON = 0.005;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- estados derivados (§3)

/** `invoice` (FACTURA, FACTURA_EXPORTACION, Invoice, NULL) · `credit_note` (NC) · `debit_note` (ND). */
export function documentKindOf(documentType: string | null | undefined): DocumentKind {
	if ((documentType ?? '').trim().toUpperCase() === 'ND') return 'debit_note';

	return isCreditNote(documentType) ? 'credit_note' : 'invoice';
}

export interface DerivedInput {
	status: string | null;
	document_type: string | null;
	is_active: boolean;
	invoice_number?: string | null;
	issue_date: string | null;
	scheduled_at?: string | null;
	due_date: string | null;
	total: number | null;
	paid: number;
	odoo_invoice_id: number | string | null;
	sent_to_odoo_at: string | null;
	auto_invoice?: boolean;
	issued_externally?: boolean;
	voided?: boolean;
	no_charge?: boolean;
	has_erp_integration?: boolean;
	has_erp_partner?: boolean;
}

const erpLinked = (row: Pick<DerivedInput, 'odoo_invoice_id' | 'sent_to_odoo_at'>) =>
	(row.odoo_invoice_id !== null && row.odoo_invoice_id !== undefined) || (row.sent_to_odoo_at !== null && row.sent_to_odoo_at !== undefined);

/**
 * Estado frente al ERP: el `erp_sync_state` del 360 (`none` · `draft` · `sent`) y `not_applicable` cuando no hay ERP en juego (NC/ND hasta que
 * exista la emisión de NC, compañía sin integración o razón social sin cliente en el ERP). Una factura vinculada siempre muestra su vínculo.
 */
export function erpStateOf(row: DerivedInput): ErpState {
	if (erpLinked(row)) return row.status === PENDING_STATUS ? 'draft' : 'sent';
	if (documentKindOf(row.document_type) !== 'invoice' || !row.has_erp_integration || !row.has_erp_partner) return 'not_applicable';

	return 'none';
}

/** Emisión legal (§3): sin estados SII/SUNAT/CFDI propios hasta el vínculo invoice ↔ DTE (Leon). */
export function electronicStateOf(row: DerivedInput, today: string): ElectronicState {
	if (row.voided) return 'voided';
	if (row.status === CANCELLED_STATUS) return row.no_charge ? 'not_issued' : 'voided';
	if (documentKindOf(row.document_type) !== 'invoice') {
		if (creditNotePendingEmission({ ...row, odoo_invoice_id: row.odoo_invoice_id ?? null })) return 'pending_emission';

		return erpLinked(row) ? 'issued_erp' : 'issued_external';
	}
	if (row.status === PENDING_STATUS) {
		const date = row.issue_date ?? row.scheduled_at ?? null;

		return row.auto_invoice && date !== null && date < today && !erpLinked(row) ? 'pending_emission' : 'not_issued';
	}
	if (row.issued_externally) return 'issued_external';

	return erpLinked(row) ? 'issued_erp' : 'issued_external';
}

/** ¿La factura admite pagos y entra en cuentas por cobrar? Emitida activa, factura (no NC/ND), no anulada. */
export function isReceivable(row: Pick<DerivedInput, 'status' | 'document_type' | 'is_active' | 'voided'>): boolean {
	return (
		row.is_active &&
		!row.voided &&
		documentKindOf(row.document_type) === 'invoice' &&
		(RECEIVABLE_STATUSES as readonly string[]).includes(row.status ?? '')
	);
}

/**
 * Estado de pago desde `invoice_payments` confirmados en la moneda de la factura (no desde `status`, que no tiene "parcial"):
 * `paid` (estado Pagada del ERP o Σ ≥ total) > `partial` (0 < Σ < total) > `overdue` (sin pagos y vencida) > `unpaid`; `not_applicable`
 * para Por Emitir, Cancelada, NC/ND, inactivas y anuladas. Una parcial vencida sigue `partial` (el saldo y `overdue` lo muestran).
 */
export function paymentStateOf(row: DerivedInput, today: string): PaymentState {
	if (!isReceivable(row)) return 'not_applicable';
	if (row.status === 'Pagada' || (row.total !== null && row.total > 0 && row.paid >= row.total - PAYMENT_EPSILON)) return 'paid';
	if (row.paid > 0) return 'partial';
	if (row.due_date && row.due_date < today) return 'overdue';

	return 'unpaid';
}

/** Saldo = total − pagos confirmados (≥ 0); null si no aplica o si el total aún no se valoriza (spot). */
export function balanceOf(row: DerivedInput): number | null {
	if (!isReceivable(row) || row.total === null) return null;
	if (row.status === 'Pagada') return 0;

	return Math.max(round2(row.total - row.paid), 0);
}

/** `Pagada` con pagos registrados que no cubren el total (gemelo de `paidWithoutFullPaymentsSql`): saldo 0, `paid`, y se informa como aviso. */
export function paidWithoutFullPayments(row: DerivedInput): boolean {
	return isReceivable(row) && row.status === 'Pagada' && row.total !== null && row.total > 0 && row.paid < row.total - PAYMENT_EPSILON;
}

/** Bloqueo común de escrituras sobre una factura sin contrato (solo lectura en v2, spec §11.1): pagos, cobranza y proforma. */
export const noContractBlocker = (label: string): BillingBlocker => ({
	code: 'no_contract',
	message: `La factura ${label} no pertenece a un contrato: es de solo lectura`,
	next_step: 'Opérala en la app actual mientras exista',
});

/** Días vencidos a `today` (0 si no vence o sin saldo). */
export function daysOverdue(row: DerivedInput, today: string): number {
	const balance = balanceOf(row);

	if (!row.due_date || !balance || row.due_date >= today) return 0;

	return diffDays(row.due_date, today);
}

// ---------------------------------------------------------------- recálculo del estado por pagos (§6.7, Q3, B-F3, B-F14)

export interface StatusRecalcInput {
	status: string | null;
	total: number | null;
	paid: number;
	due_date: string | null;
	odoo_invoice_id: number | string | null;
	sent_to_odoo_at: string | null;
}

/**
 * Estado tras registrar o anular pagos. Nunca toca Por Emitir, Cancelada ni legacy (Consolidada/Dividida). Σ ≥ total → Pagada; si no
 * (también al anular un pago de una Pagada): vencida → Vencida; si no, el estado emitido anterior (Enviada si está en el ERP, Emitida si
 * no). Una Vencida cuyo vencimiento se movió al futuro vuelve a Emitida/Enviada.
 */
export function statusAfterPayments(input: StatusRecalcInput, today: string): string | null {
	const status = input.status;

	if (!status || !(RECEIVABLE_STATUSES as readonly string[]).includes(status)) return status;
	if (input.total !== null && input.total > 0 && input.paid >= input.total - PAYMENT_EPSILON) return 'Pagada';
	if (input.total === null || input.total <= 0) return status;
	if (input.due_date && input.due_date < today) return 'Vencida';
	if (status === 'Pagada' || status === 'Vencida') return erpLinked(input) ? 'Enviada' : 'Emitida';

	return status;
}

// ---------------------------------------------------------------- pagos (§4.5, §5.2)

export interface PaymentInvoiceRow {
	id: string;
	invoice_number: string | null;
	status: string | null;
	document_type: string | null;
	is_active: boolean;
	voided: boolean;
	client_id: string | null;
	contract_id: string | null;
	invoice_currency: string | null;
	total: number | null;
	paid: number;
	due_date: string | null;
	odoo_invoice_id: number | string | null;
	sent_to_odoo_at: string | null;
}

export interface PaymentInput {
	allocations: Array<{ invoice_id: string; amount: number }>;
	currency: string;
	payment_date: string;
}

export interface PaymentSnapshot {
	status: string | null;
	paid: number;
	balance: number | null;
	payment_state: PaymentState;
}

export interface PaymentPlanItem {
	invoice_id: string;
	invoice_number: string | null;
	contract_id: string | null;
	amount: number;
	before: PaymentSnapshot;
	after: PaymentSnapshot;
	blockers: BillingBlocker[];
}

export interface PaymentPlan {
	allocations: PaymentPlanItem[];
	blockers: BillingBlocker[];
	/** Avisos que no bloquean (hoy: `multiple_clients` en el camino manual de conciliación). Siempre presente. */
	warnings: BillingBlocker[];
	total_amount: number;
	currency: string;
	can_apply: boolean;
}

const snapshotOf = (invoice: PaymentInvoiceRow, status: string | null, paid: number, today: string): PaymentSnapshot => {
	const derived: DerivedInput = { ...invoice, status, paid, issue_date: null };

	return { status, paid: round2(paid), balance: balanceOf(derived), payment_state: paymentStateOf(derived, today) };
};

/**
 * Registrar pago(s) (todo o nada): una o varias facturas emitidas del mismo cliente y moneda. Bloqueos por factura: `no_contract` (solo lectura, §11.1), `credit_note`,
 * `not_issued` (B-F3: nunca sobre Por Emitir), `cancelled` (Cancelada, inactiva o anulada con NC), `payment_currency_mismatch` (B-F14),
 * `overpayment` (Σ asignado a la factura > saldo); globales
 * `client_mismatch` (§4.5) y `currency_mismatch` entre facturas.
 *
 * `allowMultipleClients` (solo el camino manual de conciliación, spec-conciliacion-v2 decisión 4): `client_mismatch` pasa a aviso
 * `multiple_clients` en `warnings` y no bloquea.
 */
export function planPayments(
	invoices: PaymentInvoiceRow[],
	input: PaymentInput,
	today: string,
	options: { allowMultipleClients?: boolean } = {}
): PaymentPlan {
	const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
	const currency = input.currency.trim().toUpperCase();
	const assigned = new Map<string, number>();
	const allocations: PaymentPlanItem[] = [];

	for (const allocation of input.allocations) {
		const invoice = byId.get(allocation.invoice_id);

		if (!invoice) continue;
		const blockers: BillingBlocker[] = [];
		const kind = documentKindOf(invoice.document_type);
		const previous = assigned.get(invoice.id) ?? 0;
		const before = snapshotOf(invoice, invoice.status, invoice.paid, today);
		const label = invoice.invoice_number ?? invoice.id;

		assigned.set(invoice.id, previous + allocation.amount);
		// Sin contrato (manual suelta, suscripción, importada): solo lectura en v2 (spec §11.1); el front ya no la deja elegir.
		if (!invoice.contract_id) blockers.push(noContractBlocker(label));
		if (kind !== 'invoice') {
			blockers.push({ code: 'credit_note', message: `${label} es una nota de crédito o débito: no recibe pagos`, next_step: null });
		} else if (invoice.status === PENDING_STATUS) {
			blockers.push({
				code: 'not_issued',
				message: `La factura ${label} todavía no se emite`,
				next_step: 'Emítela (envío al ERP o emisión externa) antes de registrar el pago',
				action: 'issue',
			});
		} else if (!isReceivable(invoice)) {
			blockers.push({
				code: 'cancelled',
				message: `La factura ${label} está ${invoice.voided ? 'anulada con nota de crédito' : (invoice.status ?? 'sin estado').toLowerCase()}`,
				next_step: null,
			});
		}
		if (kind === 'invoice' && (invoice.invoice_currency ?? '').toUpperCase() !== currency) {
			blockers.push({
				code: 'payment_currency_mismatch',
				message: `El pago es en ${currency} y la factura ${label} en ${invoice.invoice_currency ?? 'sin moneda'}`,
				next_step: 'Registra el pago en la moneda de la factura',
			});
		}
		const balance = before.balance;

		if (!blockers.length && balance !== null && previous + allocation.amount > balance + PAYMENT_EPSILON) {
			blockers.push({
				code: 'overpayment',
				message:
					`El pago a ${label} (${round2(previous + allocation.amount)}) supera su saldo (${balance} ${invoice.invoice_currency ?? ''})`.trim(),
				next_step: 'Ajusta el monto al saldo pendiente',
			});
		}
		if (!blockers.length && balance === null) {
			blockers.push({ code: 'not_issued', message: `La factura ${label} no tiene total valorizado`, next_step: null, action: 'issue' });
		}
		// Sin `period_closed`: el cierre de períodos protege contratos e ítems, no pagos (Domi 03-10).
		const paidAfter = invoice.paid + previous + allocation.amount;
		const statusAfter = blockers.length ? invoice.status : statusAfterPayments({ ...invoice, paid: paidAfter }, today);

		allocations.push({
			invoice_id: invoice.id,
			invoice_number: invoice.invoice_number,
			contract_id: invoice.contract_id,
			amount: round2(allocation.amount),
			before,
			after: blockers.length ? before : snapshotOf(invoice, statusAfter, paidAfter, today),
			blockers,
		});
	}
	const blockers: BillingBlocker[] = [];
	const warnings: BillingBlocker[] = [];
	const clients = new Set(invoices.map((invoice) => invoice.client_id ?? 'none'));

	if (clients.size > 1 && options.allowMultipleClients) {
		warnings.push({
			code: 'multiple_clients',
			message: `El pago se reparte entre facturas de ${clients.size} clientes distintos`,
			next_step: 'Confirma que la transferencia paga facturas de todos esos clientes',
		});
	} else if (clients.size > 1) {
		blockers.push({
			code: 'client_mismatch',
			message: 'Un pago se registra sobre facturas de un mismo cliente',
			next_step: 'Registra un pago por cliente',
		});
	}
	const all = [...blockers, ...allocations.flatMap((allocation) => allocation.blockers)];

	return {
		allocations,
		blockers,
		warnings,
		total_amount: round2(input.allocations.reduce((sum, allocation) => sum + allocation.amount, 0)),
		currency,
		can_apply: all.length === 0 && allocations.length > 0,
	};
}

// ---------------------------------------------------------------- origen y suscripciones

/** Origen de una factura: de contrato, de suscripción (Stripe, `subscription_id`) u otra (importada o histórica sin contrato). */
export const INVOICE_SOURCES = ['contract', 'subscription', 'other'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

/**
 * Estado del cobro de una factura de suscripción (Stripe): `paid` · `open` · `failed` (cargo fallido o incobrable) · `refunded` (con nota de
 * crédito posterior al pago) · `void` (anulada).
 */
export const CHARGE_STATES = ['paid', 'open', 'failed', 'refunded', 'void'] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

// ---------------------------------------------------------------- antigüedad de cuentas por cobrar (§4.5, B-F9, B-F17)

export const AGING_BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus', 'no_due_date'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type AgingBuckets = Record<AgingBucket, number>;

/** Tramo por días vencidos al corte: sin vencimiento = columna propia (no cuenta como vencida). */
export function agingBucketOf(dueDate: string | null, asOf: string): AgingBucket {
	if (!dueDate) return 'no_due_date';
	if (dueDate >= asOf) return 'not_due';
	const days = diffDays(dueDate, asOf);

	if (days <= 30) return 'd1_30';
	if (days <= 60) return 'd31_60';
	if (days <= 90) return 'd61_90';

	return 'd90_plus';
}

export const emptyBuckets = (): AgingBuckets => ({ not_due: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, no_due_date: 0 });

export interface AgingRow {
	client_id: string | null;
	client_name: string | null;
	currency: string | null;
	due_date: string | null;
	balance: number;
	/** Detalle por factura (reporte Cuentas por cobrar, `detail=invoices`); opcionales para no romper llamadas previas. */
	id?: string | null;
	invoice_number?: string | null;
	company_id?: string | null;
	company_name?: string | null;
	/** País de la compañía emisora (distingue compañías homónimas: "SimpliRoute S.A.S · Colombia"). */
	company_country?: string | null;
	contract_id?: string | null;
	contract_number?: string | null;
	issue_date?: string | null;
	status?: string | null;
	/** Saldo en moneda de sistema (`null` = sin conversión: no suma al total del sistema). */
	balance_system?: number | null;
	/** Último pago confirmado de la factura hasta el corte. */
	last_payment_date?: string | null;
}

/** Totales del cliente y de la moneda para el reporte: último pago, atraso (máximo y ponderado por saldo) y saldo en sistema. */
export interface AgingExtras {
	total_system: number;
	unconverted: number;
	last_payment_date: string | null;
	max_days_overdue: number;
	avg_days_overdue: number;
}

export interface AgingInvoice {
	id: string | null;
	invoice_number: string | null;
	client_id: string | null;
	client_name: string | null;
	company_id: string | null;
	company_name: string | null;
	company_country: string | null;
	contract_id: string | null;
	contract_number: string | null;
	status: string | null;
	currency: string;
	issue_date: string | null;
	due_date: string | null;
	days_overdue: number;
	bucket: AgingBucket;
	balance: number;
	balance_system: number | null;
	last_payment_date: string | null;
}

/**
 * Monedas que no son de facturación: una factura con `invoice_currency` CLF/UF es un dato por revisar (la UF se convierte a CLP al emitir).
 * La antigüedad y la proyección no las muestran como moneda: van en `review` (conteo por compañía), nunca como tramo ni columna.
 */
export const NON_INVOICING_CURRENCIES = ['CLF', 'UF'] as const;

export const isNonInvoicingCurrency = (currency: string | null | undefined) =>
	(NON_INVOICING_CURRENCIES as readonly string[]).includes((currency ?? '').trim().toUpperCase());

/** Facturas con saldo en una moneda que no es de facturación (CLF/UF): conteo por compañía, sin montos agregados. */
export interface AgingReview {
	invoices: number;
	by_company: Array<{ company_id: string | null; name: string | null; invoices: number; currencies: string[] }>;
}

/** Antigüedad de una compañía en una moneda de factura (`group=company`). */
export interface AgingCompany {
	company_id: string | null;
	name: string | null;
	/** País de la compañía (`companies.country`). */
	country: string | null;
	currency: string;
	buckets: AgingBuckets;
	bucket_counts: AgingBuckets;
	total: number;
	invoices: number;
	total_system: number;
	unconverted: number;
	/** Facturas CLF/UF de la compañía (datos por revisar, no suman). */
	review_invoices: number;
}

export interface AgingResult {
	/** `buckets` = montos (número, compatibilidad); `bucket_counts` = n° de facturas por tramo. */
	by_currency: Array<{ currency: string; buckets: AgingBuckets; bucket_counts: AgingBuckets; total: number; invoices: number } & AgingExtras>;
	clients: Array<
		{
			client_id: string | null;
			name: string | null;
			currency: string;
			buckets: AgingBuckets;
			bucket_counts: AgingBuckets;
			total: number;
			invoices: number;
		} & AgingExtras
	>;
	/** Una fila por factura con saldo (orden: cliente, moneda, más atrasada primero). */
	invoices: AgingInvoice[];
	/** Saldo en moneda de sistema por tramo (solo facturas convertidas). */
	system: { buckets: AgingBuckets; total: number; unconverted: number };
	/** Por compañía y moneda de factura (mayor saldo primero dentro de la compañía). */
	by_company: AgingCompany[];
	/** Facturas CLF/UF con saldo: fuera de los tramos, contadas por compañía. */
	review: AgingReview;
}

/** Días vencidos al corte (0 si no vence o vence hoy o después). */
export const daysOverdueAt = (dueDate: string | null, asOf: string) => (dueDate && dueDate < asOf ? diffDays(dueDate, asOf) : 0);

const emptyExtras = (): AgingExtras => ({ total_system: 0, unconverted: 0, last_payment_date: null, max_days_overdue: 0, avg_days_overdue: 0 });

/**
 * Antigüedad por cliente y moneda (nunca suma monedas distintas): saldo = total − pagos confirmados al corte. Además: una fila por factura,
 * último pago y días de atraso (máximo y promedio ponderado por saldo vencido) por cliente y por moneda, y el saldo en moneda de sistema
 * (las facturas sin conversión no suman y se cuentan en `unconverted`).
 */
export function buildAging(rows: AgingRow[], asOf: string): AgingResult {
	type Acc = AgingResult['clients'][number];
	const currencies = new Map<string, AgingResult['by_currency'][number]>();
	const clients = new Map<string, Acc>();
	// Atraso ponderado por saldo vencido de cada acumulador (cliente o moneda).
	const weights = new Map<object, { weighted: number; overdue: number }>();
	const invoices: AgingInvoice[] = [];
	const system = { buckets: emptyBuckets(), total: 0, unconverted: 0 };
	const companies = new Map<string, AgingCompany>();
	const review = new Map<string, AgingReview['by_company'][number]>();
	const companyOf = (row: AgingRow, currency: string) => {
		const key = `${row.company_id ?? 'none'}|${currency}`;
		const entry = companies.get(key) ?? {
			company_id: row.company_id ?? null,
			name: row.company_name ?? null,
			country: row.company_country ?? null,
			currency,
			buckets: emptyBuckets(),
			bucket_counts: emptyBuckets(),
			total: 0,
			invoices: 0,
			total_system: 0,
			unconverted: 0,
			review_invoices: 0,
		};

		companies.set(key, entry);

		return entry;
	};

	for (const row of rows) {
		if (!(row.balance > PAYMENT_EPSILON)) continue;
		const currency = (row.currency ?? '—').toUpperCase();

		if (isNonInvoicingCurrency(currency)) {
			const key = row.company_id ?? 'none';
			const entry = review.get(key) ?? { company_id: row.company_id ?? null, name: row.company_name ?? null, invoices: 0, currencies: [] };

			entry.invoices += 1;
			if (!entry.currencies.includes(currency)) entry.currencies.push(currency);
			review.set(key, entry);
			continue;
		}
		const bucket = agingBucketOf(row.due_date, asOf);
		const days = daysOverdueAt(row.due_date, asOf);
		const balanceSystem = row.balance_system === undefined || row.balance_system === null ? null : round2(row.balance_system);
		const lastPayment = row.last_payment_date ?? null;
		const total = currencies.get(currency) ?? {
			currency,
			buckets: emptyBuckets(),
			bucket_counts: emptyBuckets(),
			total: 0,
			invoices: 0,
			...emptyExtras(),
		};
		const key = `${row.client_id ?? 'none'}|${currency}`;
		const client = clients.get(key) ?? {
			client_id: row.client_id,
			name: row.client_name,
			currency,
			buckets: emptyBuckets(),
			bucket_counts: emptyBuckets(),
			total: 0,
			invoices: 0,
			...emptyExtras(),
		};

		for (const target of [total, client]) {
			target.buckets[bucket] = round2(target.buckets[bucket] + row.balance);
			target.bucket_counts[bucket] += 1;
			target.total = round2(target.total + row.balance);
			target.invoices += 1;
			if (balanceSystem === null) target.unconverted += 1;
			else target.total_system = round2(target.total_system + balanceSystem);
			if (lastPayment && (!target.last_payment_date || lastPayment > target.last_payment_date)) target.last_payment_date = lastPayment;
			if (days > 0) {
				const weight = weights.get(target) ?? { weighted: 0, overdue: 0 };

				weight.weighted += days * row.balance;
				weight.overdue += row.balance;
				weights.set(target, weight);
				target.max_days_overdue = Math.max(target.max_days_overdue, days);
				target.avg_days_overdue = Math.round(weight.weighted / weight.overdue);
			}
		}
		if (balanceSystem === null) system.unconverted += 1;
		else {
			system.buckets[bucket] = round2(system.buckets[bucket] + balanceSystem);
			system.total = round2(system.total + balanceSystem);
		}
		const company = companyOf(row, currency);

		company.buckets[bucket] = round2(company.buckets[bucket] + row.balance);
		company.bucket_counts[bucket] += 1;
		company.total = round2(company.total + row.balance);
		company.invoices += 1;
		if (balanceSystem === null) company.unconverted += 1;
		else company.total_system = round2(company.total_system + balanceSystem);
		currencies.set(currency, total);
		clients.set(key, client);
		invoices.push({
			id: row.id ?? null,
			invoice_number: row.invoice_number ?? null,
			client_id: row.client_id,
			client_name: row.client_name,
			company_id: row.company_id ?? null,
			company_name: row.company_name ?? null,
			company_country: row.company_country ?? null,
			contract_id: row.contract_id ?? null,
			contract_number: row.contract_number ?? null,
			status: row.status ?? null,
			currency,
			issue_date: row.issue_date ?? null,
			due_date: row.due_date,
			days_overdue: days,
			bucket,
			balance: round2(row.balance),
			balance_system: balanceSystem,
			last_payment_date: lastPayment,
		});
	}
	return {
		by_currency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
		clients: [...clients.values()].sort((a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? '')),
		invoices: invoices.sort(
			(a, b) =>
				(a.client_name ?? '￿').localeCompare(b.client_name ?? '￿', 'es') ||
				a.currency.localeCompare(b.currency) ||
				b.days_overdue - a.days_overdue ||
				b.balance - a.balance
		),
		system,
		by_company: [...companies.values()]
			.map((entry) => ({ ...entry, review_invoices: review.get(entry.company_id ?? 'none')?.invoices ?? 0 }))
			.sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿', 'es') || b.total - a.total),
		review: {
			invoices: [...review.values()].reduce((sum, entry) => sum + entry.invoices, 0),
			by_company: [...review.values()].sort((a, b) => b.invoices - a.invoices),
		},
	};
}

// ---------------------------------------------------------------- cola Por emitir (§4.2)

/** Bloqueos del envío al ERP que no aplican cuando la factura se emite fuera del ERP (2 de 3 clientes sin ERP, S4-14: `mark-issued`). */
export const ERP_ONLY_CODES = [
	'erp_send_disabled',
	'no_erp_integration',
	'no_erp_partner',
	'already_sent',
	'tax_rate_missing',
	'product_without_erp_mapping',
] as const;

/** Acción de la UI que resuelve cada bloqueo de la cola. */
export const BLOCKER_ACTIONS: Record<string, string> = {
	needs_reference: 'references',
	fixed_fx_without_rate: 'fx',
	fx_rate_missing: 'fx',
	period_closed: 'reschedule',
	sent_to_erp_draft: 'erp_reset',
	already_sent: 'erp_reset',
	no_erp_partner: 'client_entity',
	item_without_product: 'contract_items',
	product_without_erp_mapping: 'map_product',
	tax_rate_missing: 'company_settings',
	erp_send_disabled: 'billing_conditions',
	no_erp_integration: 'integrations',
	unified_invoice: 'open_invoice',
	legacy_invoice: 'open_invoice',
	no_lines: 'edit',
	credit_note_send_pending: 'none',
	not_pending: 'none',
};

export const withAction = (blocker: BillingBlocker): BillingBlocker => ({
	code: blocker.code,
	message: blocker.message,
	next_step: blocker.next_step ?? null,
	action: blocker.action ?? BLOCKER_ACTIONS[blocker.code] ?? null,
});

/** Camino de emisión: por el ERP (contrato que envía y compañía integrada) o fuera de él (`mark-issued`). */
export type IssuePath = 'erp' | 'external';

/**
 * Bloqueos de una Por Emitir en la cola: los del envío (`planSendNow`, que ya incluye `commonBlockers`) más `sent_to_erp_draft` (el cierre
 * de períodos no bloquea facturas, Domi 03-10); si la factura no va por el ERP se quitan los bloqueos propios del envío (`ERP_ONLY_CODES`). Sin duplicados por código.
 */
export function queueBlockers(blockers: BillingBlocker[], issuePath: IssuePath): BillingBlocker[] {
	const seen = new Set<string>();
	const out: BillingBlocker[] = [];

	for (const blocker of blockers) {
		if (issuePath === 'external' && (ERP_ONLY_CODES as readonly string[]).includes(blocker.code)) continue;
		if (seen.has(blocker.code)) continue;
		seen.add(blocker.code);
		out.push(withAction(blocker));
	}

	return out;
}

/** Grupo de la cola: en el ERP como borrador > con bloqueo > rezagada (emisión < hoy) > lista. */
export function toIssueGroupOf(
	row: { odoo_invoice_id: number | string | null; sent_to_odoo_at: string | null; issue_date: string | null; scheduled_at: string | null },
	blockers: BillingBlocker[],
	today: string
): ToIssueGroup {
	if (erpLinked(row)) return 'erp_draft';
	if (blockers.length) return 'blocked';
	const date = row.issue_date ?? row.scheduled_at;

	return date !== null && date < today ? 'late' : 'ready';
}

/** Monto de un grupo de la cola en una moneda de factura; `unvalued` = Por Emitir spot sin total aún (no suman, nunca 0). */
export interface GroupCurrencyAmount {
	currency: string;
	amount: number;
	invoices: number;
	unvalued: number;
}

export interface ToIssueGroups {
	ready: number;
	blocked: { count: number; by_code: Record<string, number> };
	late: number;
	erp_draft: number;
	/** Por grupo: total en moneda de factura, por moneda (nunca se suman monedas). */
	amount_invoice_currency_by_currency: Record<ToIssueGroup, GroupCurrencyAmount[]>;
}

export function countGroups(
	rows: Array<{ group: ToIssueGroup; blocked_reasons: BillingBlocker[]; currency?: string | null; amount?: number | null }>
): ToIssueGroups {
	const groups: ToIssueGroups = {
		ready: 0,
		blocked: { count: 0, by_code: {} },
		late: 0,
		erp_draft: 0,
		amount_invoice_currency_by_currency: { ready: [], blocked: [], late: [], erp_draft: [] },
	};
	const amounts = new Map<string, GroupCurrencyAmount>();

	for (const row of rows) {
		if (row.group === 'blocked') {
			groups.blocked.count += 1;
			for (const blocker of row.blocked_reasons) groups.blocked.by_code[blocker.code] = (groups.blocked.by_code[blocker.code] ?? 0) + 1;
		} else {
			groups[row.group] += 1;
		}
		const currency = (row.currency ?? '—').toUpperCase();
		const key = `${row.group}|${currency}`;
		const entry = amounts.get(key) ?? { currency, amount: 0, invoices: 0, unvalued: 0 };

		if (!amounts.has(key)) {
			amounts.set(key, entry);
			groups.amount_invoice_currency_by_currency[row.group].push(entry);
		}
		entry.invoices += 1;
		if (row.amount === null || row.amount === undefined) entry.unvalued += 1;
		else entry.amount = round2(entry.amount + row.amount);
	}
	for (const list of Object.values(groups.amount_invoice_currency_by_currency)) list.sort((a, b) => a.currency.localeCompare(b.currency));

	return groups;
}

// ---------------------------------------------------------------- fan-out por contrato (§4.7, §5.2)

export interface FanOutInvoice {
	id: string;
	contract_id: string | null;
	invoice_number: string | null;
}

export interface FanOutGrouping {
	/** Por contrato, en el orden en que aparece su primera factura pedida; ids sin duplicados. */
	groups: Array<{ contract_id: string; invoice_ids: string[] }>;
	/** Facturas que no se pueden operar desde un contrato: no existen en el holding o no tienen contrato. */
	orphans: Array<{ invoice_id: string; blockers: BillingBlocker[] }>;
}

export function groupByContract(requested: string[], invoices: FanOutInvoice[]): FanOutGrouping {
	const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
	const groups = new Map<string, string[]>();
	const orphans: FanOutGrouping['orphans'] = [];

	for (const id of [...new Set(requested)]) {
		const invoice = byId.get(id);

		if (!invoice) {
			orphans.push({ invoice_id: id, blockers: [{ code: 'not_found', message: 'Factura no encontrada en el holding', next_step: null }] });
		} else if (!invoice.contract_id) {
			orphans.push({
				invoice_id: id,
				blockers: [
					{ code: 'no_contract', message: `La factura ${invoice.invoice_number ?? id} no pertenece a un contrato`, next_step: null },
				],
			});
		} else {
			groups.set(invoice.contract_id, [...(groups.get(invoice.contract_id) ?? []), id]);
		}
	}

	return { groups: [...groups.entries()].map(([contract_id, invoice_ids]) => ({ contract_id, invoice_ids })), orphans };
}

export interface FanOutResult {
	invoice_id: string;
	invoice_number: string | null;
	contract_id: string | null;
	ok: boolean;
	blockers: BillingBlocker[];
	warnings: Array<{ code: string; message: string }>;
	message?: string | null;
	/** Envío al ERP que no salió: categoría, mensaje, paso siguiente, acción y texto técnico (`translateErpError`); ausente/null si no aplica. */
	error?: { category: string; message: string; next_step: string; action: string; raw: string | null } | null;
}

/**
 * Resultado por factura de una respuesta masiva del contrato (`{ updated[], skipped[{ id, blockers }], warnings[{ invoice_id }] }`), o de un
 * 409 (`{ blockers, preview }`): las que el contrato aplicó (o aplicaría) quedan `ok`; las demás con sus bloqueos.
 */
export function resultsFromContractBulk(
	contractId: string,
	invoiceIds: string[],
	numbers: Map<string, string | null>,
	response: {
		updated?: string[];
		skipped?: Array<{ id: string; blockers: BillingBlocker[] }>;
		warnings?: Array<{ code: string; message: string; invoice_id?: string }>;
	} | null,
	fallbackBlockers: BillingBlocker[] = []
): FanOutResult[] {
	const updated = new Set(response?.updated ?? []);
	const skipped = new Map((response?.skipped ?? []).map((entry) => [entry.id, entry.blockers]));

	return invoiceIds.map((id) => {
		const blockers = skipped.get(id) ?? (updated.has(id) ? [] : fallbackBlockers.length ? fallbackBlockers : []);
		const ok = updated.has(id) && !skipped.has(id);

		return {
			invoice_id: id,
			invoice_number: numbers.get(id) ?? null,
			contract_id: contractId,
			ok,
			blockers: (ok
				? []
				: blockers.length
					? blockers
					: [{ code: 'not_applied', message: 'El contrato no aplicó el cambio', next_step: null }]
			).map(withAction),
			warnings: (response?.warnings ?? [])
				.filter((warning) => !warning.invoice_id || warning.invoice_id === id)
				.map((warning) => ({ code: warning.code, message: warning.message })),
		};
	});
}

// ---------------------------------------------------------------- recordatorios y plantillas (§4.6, B-F18)

/** ¿Toca recordatorio hoy? `before` = días antes del vencimiento, `after` = días después. Nunca el mismo día dos veces. */
export function reminderMatch(
	dueDate: string | null,
	today: string,
	daysBefore: number[],
	daysAfter: number[]
): { trigger: 'before' | 'after'; days: number } | null {
	if (!dueDate) return null;
	if (dueDate > today) {
		const days = diffDays(today, dueDate);

		return daysBefore.includes(days) ? { trigger: 'before', days } : null;
	}
	const days = diffDays(dueDate, today);

	return days > 0 && daysAfter.includes(days) ? { trigger: 'after', days } : null;
}

/** Estados de un correo de Facturación en la respuesta (`GET /billing/invoices/:id/emails`). */
export const EMAIL_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'bounced', 'skipped'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/**
 * Normaliza el estado guardado (`invoice_collection_logs.status` es texto libre con default `sent`; `invoice_emails` no tiene columna: se
 * registra al enviar) al conjunto cerrado `EMAIL_STATUSES`. Desconocido o vacío → `sent` (la fila existe porque el envío se hizo).
 */
export function normalizeEmailStatus(value: string | null | undefined): EmailStatus {
	const raw = (value ?? '').trim().toLowerCase();

	if ((EMAIL_STATUSES as readonly string[]).includes(raw)) return raw as EmailStatus;
	if (['pending', 'queue', 'processing', 'scheduled'].includes(raw)) return 'queued';
	if (['delivery', 'opened', 'open', 'click', 'clicked'].includes(raw)) return 'delivered';
	if (['error', 'fail', 'dropped', 'rejected', 'deferred_failed'].includes(raw)) return 'failed';
	if (['bounce', 'spamreport', 'spam'].includes(raw)) return 'bounced';
	if (['skip', 'omitted', 'suppressed', 'unsubscribed'].includes(raw)) return 'skipped';

	return 'sent';
}

export const TEMPLATE_VARIABLES = [
	'invoice_number',
	'client_name',
	'amount_due',
	'due_date',
	'issue_date',
	'company_name',
	'days_overdue',
	'currency',
	'contract_number',
] as const;

/** Variables `{{x}}` de una plantilla que no están en el catálogo (para validar al guardar). */
export function unknownTemplateVariables(template: string): string[] {
	const found = [...template.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((match) => match[1]);

	return [...new Set(found.filter((name) => !(TEMPLATE_VARIABLES as readonly string[]).includes(name)))];
}

export const escapeHtml = (value: string): string =>
	value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Reemplaza `{{variable}}` (catálogo) por su valor; con `html` escapa los valores y convierte saltos de línea (B-F18: nada sin escapar). */
export function renderTemplate(template: string, values: Partial<Record<(typeof TEMPLATE_VARIABLES)[number], string | null>>, html: boolean): string {
	const text = template.replace(/\\n/g, '\n');
	const replaced = text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
		const value = values[name as (typeof TEMPLATE_VARIABLES)[number]] ?? '';

		return html ? escapeHtml(value) : value;
	});

	if (!html) return replaced;

	// El texto fijo de la plantilla también se escapa (solo los valores ya venían escapados): se escapa por segmentos.
	return template
		.replace(/\\n/g, '\n')
		.split(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g)
		.map((part) => {
			const variable = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(part);

			return variable ? escapeHtml(values[variable[1] as (typeof TEMPLATE_VARIABLES)[number]] ?? '') : escapeHtml(part);
		})
		.join('')
		.replace(/\n/g, '<br>');
}

/** Formato de monto para correos (es-CL, 2 decimales salvo CLP). */
export function formatAmount(amount: number | null, currency: string | null): string {
	if (amount === null) return '';
	const code = (currency ?? '').toUpperCase();
	const digits = code === 'CLP' ? 0 : 2;

	return `${code} ${amount.toLocaleString('es-CL', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`.trim();
}

/** Destinatarios: limpia, valida forma y quita duplicados (sin distinguir mayúsculas). */
export function cleanEmails(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	for (const value of values) {
		for (const part of (value ?? '').split(/[,;]/)) {
			const email = part.trim();

			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email.toLowerCase())) continue;
			seen.add(email.toLowerCase());
			out.push(email);
		}
	}

	return out;
}
