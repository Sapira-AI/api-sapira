/**
 * Reglas puras del Contrato 360 enriquecido (resumen, calendario de facturación y consumo). Sin base de datos: el
 * servicio (`contract-360.service.ts`) lee las filas y estas funciones arman las respuestas, así se prueban aisladas.
 *
 * Fechas `YYYY-MM-DD` (texto): se comparan como string. Montos en moneda del contrato salvo que el nombre diga otra cosa.
 * Los mensajes son para la usuaria: español neutro, sin nombres de columnas y "ERP" (nunca el nombre del proveedor).
 */
import { diffDays } from './billing-engine';

import type { ContractDerivedStatus } from './contract-status';

// ---------------------------------------------------------------- utilidades

export const ISSUED_STATUSES = ['Emitida', 'Enviada', 'Vencida', 'Pagada'] as const;
export const PENDING_STATUS = 'Por Emitir';
export const CANCELLED_STATUS = 'Cancelada';

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round1 = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;

/** Nota de crédito (`NC`, `NOTA_CREDITO`, `Nota de crédito`). */
export const isCreditNote = (documentType: string | null | undefined) => /^(NC|NOTA[\s_-]*(DE[\s_-]*)?CR[EÉ]DITO)/i.test((documentType ?? '').trim());

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
	collected: number;
	paid_count: number;
	overdue: number;
	overdue_count: number;
	overdue_invoice_numbers: string[];
	open_receivable: number;
}

/**
 * Montos del contrato en su moneda, sobre facturas vigentes (activas y no canceladas). Facturas suman y notas de
 * crédito restan en todos los montos (la NC hereda el estado de la factura que corrige) salvo si corrigen una factura
 * ya cancelada (`countedInvoices`); los conteos son solo de facturas. `facturado = cobrado + vencido + por cobrar`.
 */
export function computeFinancial(invoices: ScheduleInvoice[], tcv: number, today: string): ContractFinancial {
	const result: ContractFinancial = {
		invoiced_to_date: 0,
		invoiced_pct: 0,
		pending_to_invoice: 0,
		pending_periods: 0,
		collected: 0,
		paid_count: 0,
		overdue: 0,
		overdue_count: 0,
		overdue_invoice_numbers: [],
		open_receivable: 0,
	};

	for (const invoice of countedInvoices(invoices)) {
		const amount = signedAmount(invoice);
		const isInvoice = !isCreditNote(invoice.document_type);

		if (invoice.status === PENDING_STATUS) {
			result.pending_to_invoice += amount;
			if (isInvoice) result.pending_periods += 1;
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

	for (const key of ['invoiced_to_date', 'pending_to_invoice', 'collected', 'overdue', 'open_receivable'] as const) {
		result[key] = round2(result[key]);
	}
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

export type BlockerCode = 'needs_reference' | 'fixed_fx_without_rate' | 'no_erp_partner' | 'item_without_product' | 'past_issue_date';

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

// ---------------------------------------------------------------- ciclo de vida

export type LifecycleStageKey = 'draft' | 'active' | 'renewal' | 'closed';
export type LifecycleStageState = 'done' | 'current' | 'upcoming' | 'skipped';

export interface LifecycleStage {
	key: LifecycleStageKey;
	label: string;
	date: string | null;
	state: LifecycleStageState;
}

export interface LifecycleInput {
	derived_status: ContractDerivedStatus;
	created_at: string | null;
	activation_date: string | null;
	next_item_end_date: string | null;
	/** Fin del primer ítem que terminó sin renovarse ni darse de baja (fecha de "Por renovar"/"Vencido"). */
	overdue_renewal_date: string | null;
	closed_date: string | null;
}

/**
 * Etapas del contrato según el estado mostrado. El cierre solo se marca si el contrato está cancelado; si no, queda
 * `skipped` (el contrato no terminó). Pausado y "otro" se ven como activos.
 */
export function buildLifecycle(input: LifecycleInput): { stages: LifecycleStage[] } {
	const status = input.derived_status;
	const renewalLabel = status === 'pending_renewal' ? 'Por renovar' : status === 'expired' ? 'Vencido' : 'Próxima renovación';
	const renewalDate =
		status === 'pending_renewal' || status === 'expired' ? (input.overdue_renewal_date ?? input.next_item_end_date) : input.next_item_end_date;
	let states: Record<LifecycleStageKey, LifecycleStageState>;

	switch (status) {
		case 'draft':
			states = { draft: 'current', active: 'upcoming', renewal: 'upcoming', closed: 'skipped' };
			break;
		case 'pending_renewal':
		case 'expired':
			states = { draft: 'done', active: 'done', renewal: 'current', closed: 'skipped' };
			break;
		case 'cancelled':
			states = { draft: 'done', active: input.activation_date ? 'done' : 'skipped', renewal: 'skipped', closed: 'current' };
			break;
		default:
			states = { draft: 'done', active: 'current', renewal: 'upcoming', closed: 'skipped' };
	}

	return {
		stages: [
			{ key: 'draft', label: 'En revisión', date: input.created_at, state: states.draft },
			{ key: 'active', label: 'Activo', date: input.activation_date, state: states.active },
			{ key: 'renewal', label: renewalLabel, date: status === 'cancelled' ? null : renewalDate, state: states.renewal },
			{ key: 'closed', label: 'Cancelado', date: status === 'cancelled' ? input.closed_date : null, state: states.closed },
		],
	};
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

// ---------------------------------------------------------------- consumo (cantidades)

export interface QuantityRow {
	id: string;
	contract_item_id: string;
	period: string;
	quantity: number | null;
	unit_price: number | null;
	amount: number | null;
	account: string | null;
}

export interface ConsumptionItem {
	id: string;
	product_name: string | null;
	account: string | null;
}

export interface ConsumptionInvoiceLine {
	contract_item_id: string;
	billing_period_start: string | null;
	invoice_id: string;
	invoice_number: string | null;
	status: string | null;
	is_active: boolean;
}

/**
 * Cantidades registradas (dato histórico) cruzadas con los ítems del contrato y con la línea de factura del mismo ítem
 * cuyo período empieza en el mes de la cantidad. Si hay varias, gana la factura vigente (activa y no cancelada).
 *
 * `uses_usage_pricing` es `false` para todo hoy (decisión del dueño, 25-09): el tipo de ítem es master data del holding
 * y no define comportamiento. Lo moverá un campo futuro de modelo de precio del ítem (cantidad fija o medida).
 */
export function buildConsumption(quantities: QuantityRow[], items: ConsumptionItem[], lines: ConsumptionInvoiceLine[]) {
	const itemById = new Map(items.map((item) => [item.id, item]));
	const invoiceFor = (itemId: string, period: string) => {
		const matches = lines.filter(
			(line) => line.contract_item_id === itemId && !!line.billing_period_start && line.billing_period_start.slice(0, 7) === period.slice(0, 7)
		);
		const best = matches.find((line) => line.is_active && line.status !== CANCELLED_STATUS) ?? matches[0];

		return best ? { id: best.invoice_id, number: best.invoice_number, status: best.status } : null;
	};

	return {
		uses_usage_pricing: false,
		rows: quantities
			.map((row) => {
				const item = itemById.get(row.contract_item_id);
				const period = monthStart(row.period);

				return {
					id: row.id,
					item_id: row.contract_item_id,
					product_name: item?.product_name ?? null,
					account: row.account ?? item?.account ?? null,
					period,
					quantity: row.quantity,
					unit_price: row.unit_price,
					amount: row.amount ?? (row.quantity !== null && row.unit_price !== null ? round2(row.quantity * row.unit_price) : null),
					invoice: invoiceFor(row.contract_item_id, period),
				};
			})
			.sort((a, b) => b.period.localeCompare(a.period) || (a.product_name ?? '').localeCompare(b.product_name ?? '')),
		items: items.map((item) => ({
			item_id: item.id,
			product_name: item.product_name,
			account: item.account,
			uses_usage_pricing: false,
		})),
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
