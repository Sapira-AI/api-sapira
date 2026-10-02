/**
 * SQL de lectura de Facturación v2 (spec-facturacion-v2 §3, §5.1): una sola CTE por holding (`base` → `d`) con los joins, los pagos
 * confirmados en la moneda de la factura y los estados derivados. Los estados son el gemelo SQL de `billing-states.ts` (mismo orden de
 * reglas); los filtros por estado derivado van sobre `d`. Parámetros posicionales con `SqlParams` (patrón `metrics`): todo `$n` agregado
 * queda referenciado (lo prueba `billing-sql.spec.ts`).
 */
import { CANCELLED_STATUS, noChargeSql, PENDING_STATUS, relatedDocumentsSql, voidedSql } from '@/modules/contracts/contract-360';
import { DEVIATION_ADJUSTMENT_TYPES } from '@/modules/contracts/contracts.service';
import { SqlParams } from '@/modules/metrics/metrics-data.service';

import { INVOICE_SOURCES, type InvoiceSource, PAYMENT_EPSILON, RECEIVABLE_STATUSES } from './billing-states';

import type { BillingFiltersDto, InvoiceSortField } from './dtos/billing.dto';

export { SqlParams };

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

export const splitList = (value?: string | null): string[] =>
	value
		? [
				...new Set(
					value
						.split(',')
						.map((item) => item.trim())
						.filter(Boolean)
				),
			]
		: [];

/** Primer día del mes siguiente a `YYYY-MM` (cota superior exclusiva). */
export const nextMonthStart = (month: string): string => {
	const year = Number(month.slice(0, 4));
	const index = Number(month.slice(5, 7));

	return index === 12 ? `${year + 1}-01-01` : `${year}-${String(index + 1).padStart(2, '0')}-01`;
};

/** Último día del mes de una fecha `YYYY-MM-DD`. */
export const monthEndOf = (date: string): string => {
	const next = nextMonthStart(date.slice(0, 7));
	const time = Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, 1) - 86_400_000;
	const end = new Date(time);

	return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
};

/** `invoice` · `credit_note` · `debit_note` (misma regla que `isCreditNote`/`documentKindOf`). */
export const documentKindSql = (alias = 'i') => `CASE
		WHEN UPPER(TRIM(COALESCE(${alias}.document_type, ''))) = 'ND' THEN 'debit_note'
		WHEN TRIM(COALESCE(${alias}.document_type, '')) ~* '^(NC|NOTA[[:space:]_-]*(DE[[:space:]_-]*)?CR[EÉ]DITO)' THEN 'credit_note'
		ELSE 'invoice' END`;

/** ¿Admite pagos y entra en AR? Gemelo SQL de `isReceivable` (columnas de `base`: `is_active`, `voided`, `document_kind`, `status`). */
export const receivableSql = (alias = 'b') =>
	`(${alias}.is_active AND NOT ${alias}.voided AND ${alias}.document_kind = 'invoice' AND ${alias}.status IN (${quoted(RECEIVABLE_STATUSES)}))`;

/**
 * Regla única de saldo (gemelo SQL de `balanceOf`), la usan la lista, el resumen y la antigüedad: total − pagos confirmados en la moneda de
 * la factura (≥ 0); `Pagada` ⇒ 0 aunque los pagos registrados no cubran el total (ese caso se informa como `paid_without_full_payments`).
 */
export const balanceSql = (alias = 'b') => `CASE WHEN NOT ${receivableSql(alias)} OR ${alias}.total_due IS NULL THEN NULL
			WHEN ${alias}.status = 'Pagada' THEN 0
			ELSE GREATEST(ROUND((${alias}.total_due - ${alias}.paid_amount)::numeric, 2), 0) END`;

/** `Pagada` (por el ERP o a mano) con pagos registrados que no cubren el total: se muestra pagada con saldo 0 y se cuenta como aviso. */
export const paidWithoutFullPaymentsSql = (alias = 'd') =>
	`(${receivableSql(alias)} AND ${alias}.status = 'Pagada' AND ${alias}.total_due > 0 AND ${alias}.paid_amount < ${alias}.total_due - ${PAYMENT_EPSILON})`;

export const PAID_WITHOUT_FULL_PAYMENTS = 'paid_without_full_payments';

/** Aviso `paid_without_full_payments` (o ninguno) para `summary` y `aging`. */
export const paidWithoutFullPaymentsWarnings = (count: number) =>
	count > 0
		? [
				{
					code: PAID_WITHOUT_FULL_PAYMENTS,
					count,
					message: `${count} factura(s) en estado Pagada con pagos registrados que no cubren el total: se cuentan con saldo 0`,
				},
			]
		: [];

/** Regla SQL de cada origen (sobre `invoices i`): suscripción manda; luego contrato; el resto es "otra". */
export const SOURCE_SQL: Record<InvoiceSource, string> = {
	subscription: 'i.subscription_id IS NOT NULL',
	contract: '(i.subscription_id IS NULL AND i.contract_id IS NOT NULL)',
	other: '(i.subscription_id IS NULL AND i.contract_id IS NULL)',
};

export interface CteOptions {
	/** Hoy del negocio (`todayFor`), para vencidas y pendientes de emisión. */
	today: string;
	/** Aplica `from`/`to` en la CTE (la lista sí; el resumen los aplica en sus FILTER). */
	applyPeriod?: boolean;
	/** Sin `status` en la query: excluye Canceladas salvo `include_cancelled` (lista); las NC las muestran todas. */
	excludeCancelledByDefault?: boolean;
	/** Corte de pagos (antigüedad al `as_of`): solo pagos con `payment_date <= asOf`. */
	paymentsAsOf?: string;
	/** Ids precalculados (bloqueadas de la cola) para `blocked=true|false`. */
	blockedIds?: string[] | null;
	/** Solo estas facturas (detalle de una, página de la cola). */
	ids?: string[] | null;
	/** Solo NC/ND (`/credit-notes`) con `credit_type` opcional. */
	creditNotes?: { creditTypes: string[] } | null;
}

/**
 * `WITH base AS (…), d AS (…)` + el WHERE de `d` (filtros por estado derivado). El holding va siempre como `$1`-equivalente del `params`.
 * Columnas de `d`: las de la factura (fechas como texto), contrato, cliente, razón social, compañía, documento acreditado, desvío y los
 * derivados `document_kind`, `paid_amount`, `total_due`, `balance`, `payment_state`, `erp_state`, `electronic_state`, `is_overdue`,
 * `days_overdue`, `voided`, `issued_externally`.
 */
export function invoicesCte(
	holdingId: string,
	filters: BillingFiltersDto,
	params: SqlParams,
	options: CteOptions
): { cte: string; where: string; conditions: string[] } {
	const holding = params.add(holdingId);
	const today = params.add(options.today);
	const base: string[] = [`i.holding_id = ${holding}`];
	const derived: string[] = [];
	const statuses = splitList(filters.status);

	if (!filters.include_inactive) base.push('i.is_active = true');
	if (statuses.length) base.push(`i.status = ANY(${params.add(statuses)}::text[])`);
	else if (options.excludeCancelledByDefault && !filters.include_cancelled) base.push(`i.status IS DISTINCT FROM '${CANCELLED_STATUS}'`);
	if (options.applyPeriod !== false && (filters.from || filters.to)) {
		const column = filters.date_field === 'due' ? 'i.due_date' : 'COALESCE(i.issue_date, i.scheduled_at)';

		if (filters.from) base.push(`${column} >= ${params.add(`${filters.from}-01`)}::date`);
		if (filters.to) base.push(`${column} < ${params.add(nextMonthStart(filters.to))}::date`);
	}
	const lists: Array<[string | undefined, string, string]> = [
		[filters.company_id, 'i.company_id', 'uuid'],
		[filters.client_id, 'COALESCE(i.client_id, c.client_id)', 'uuid'],
		[filters.client_entity_id, 'i.client_entity_id', 'uuid'],
	];

	for (const [value, column, type] of lists) {
		const values = splitList(value);

		if (values.length) base.push(`${column} = ANY(${params.add(values)}::${type}[])`);
	}
	if (options.ids) base.push(`i.id = ANY(${params.add(options.ids)}::uuid[])`);
	const sources = splitList(filters.source).filter((value): value is InvoiceSource => (INVOICE_SOURCES as readonly string[]).includes(value));

	if (sources.length && sources.length < INVOICE_SOURCES.length) base.push(`(${sources.map((source) => SOURCE_SQL[source]).join(' OR ')})`);
	if (filters.contract_id) base.push(`i.contract_id = ${params.add(filters.contract_id)}::uuid`);
	const currencies = splitList(filters.invoice_currency).map((code) => code.toUpperCase());

	if (currencies.length) base.push(`UPPER(COALESCE(i.invoice_currency, i.contract_currency)) = ANY(${params.add(currencies)}::text[])`);
	if (filters.q) {
		const like = params.add(`%${filters.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);

		base.push(
			`(i.invoice_number ILIKE ${like} OR cl.name_commercial ILIKE ${like} OR ce.legal_name ILIKE ${like} OR c.contract_number ILIKE ${like})`
		);
	}
	if (options.creditNotes) {
		base.push(`${documentKindSql('i')} IN ('credit_note', 'debit_note')`);
		if (options.creditNotes.creditTypes.length) base.push(`i.credit_type = ANY(${params.add(options.creditNotes.creditTypes)}::text[])`);
	}
	const derivedLists: Array<[string | undefined, string]> = [
		[filters.document_kind, 'd.document_kind'],
		[filters.erp_state, 'd.erp_state'],
		[filters.electronic_state, 'd.electronic_state'],
		[filters.payment_state, 'd.payment_state'],
	];

	for (const [value, column] of derivedLists) {
		const values = splitList(value);

		if (values.length) derived.push(`${column} = ANY(${params.add(values)}::text[])`);
	}
	if (filters.blocked !== undefined && options.blockedIds) {
		const ids = params.add(options.blockedIds);

		derived.push(
			filters.blocked
				? `d.id = ANY(${ids}::uuid[])`
				: `d.status = '${PENDING_STATUS}' AND d.document_kind = 'invoice' AND NOT (d.id = ANY(${ids}::uuid[]))`
		);
	}
	if (filters.deviation_unexplained) derived.push(`d.deviation_id IS NOT NULL AND COALESCE(TRIM(d.deviation_reason), '') = ''`);
	const paymentCut = options.paymentsAsOf ? ` AND p.payment_date <= ${params.add(options.paymentsAsOf)}::date` : '';
	const receivable = receivableSql('b');
	const linked = `(b.odoo_invoice_id IS NOT NULL OR b.sent_to_odoo_at IS NOT NULL)`;
	const paid = `(b.status = 'Pagada' OR (b.total_due > 0 AND b.paid_amount >= b.total_due - ${PAYMENT_EPSILON}))`;
	const balance = balanceSql('b');

	const cte = `WITH base AS (
		SELECT i.id, i.contract_id, c.contract_number, COALESCE(i.client_id, c.client_id) AS client_id, cl.name_commercial AS client_name,
			i.client_entity_id, ce.legal_name AS client_entity_name, i.company_id, co.legal_name AS company_name,
			i.invoice_number, i.document_type, i.credit_type, i.credit_reason, i.nc_revenue_treatment, i.invoice_type, i.export_type, i.invoice_series,
			i.status, i.issue_date::text AS issue_date, i.scheduled_at::text AS scheduled_at, i.due_date::text AS due_date,
			i.contract_currency, UPPER(COALESCE(i.invoice_currency, i.contract_currency)) AS invoice_currency, i.fx_contract_to_invoice,
			i.amount_contract_currency, i.amount_invoice_currency, i.vat, i.total_invoice_currency, i.total_system_currency, i.amount_system_currency,
			i.related_invoice_id, ri.invoice_number AS related_invoice_number, ri.status AS related_invoice_status,
			ri.issue_date::text AS related_invoice_issue_date, ri.is_active AS related_invoice_active, i.is_active, COALESCE(i.is_legacy, false) AS is_legacy, COALESCE(i.auto_invoice, false) AS auto_invoice,
			i.odoo_invoice_id, i.sent_to_odoo_at, i.consolidated_into_invoice_id, i.created_at, i.subscription_id, i.stripe_id,
			COALESCE(i.total_invoice_currency, i.amount_invoice_currency) AS total_due,
			(co.odoo_integration_id IS NOT NULL) AS has_erp_integration, (ce.odoo_partner_id IS NOT NULL) AS has_erp_partner,
			${documentKindSql('i')} AS document_kind,
			COALESCE(pay.paid, 0) AS paid_amount,
			${voidedSql('i')} AS voided,
			EXISTS (SELECT 1 FROM contract_lifecycle_events e WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id
				AND e.event_type = 'INVOICE_ISSUED_EXTERNALLY' AND e.metadata->>'invoice_id' = i.id::text) AS issued_externally,
			(i.status = '${CANCELLED_STATUS}' AND ${noChargeSql('i')}) AS no_charge,
			adj.id AS deviation_id, adj.type AS deviation_type, adj.amount_diff AS deviation_amount_diff, adj.notes AS deviation_reason,
			adj.adjusted_at AS deviation_adjusted_at, adj.adjusted_by_name AS deviation_adjusted_by_name
		FROM invoices i
		LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id
		LEFT JOIN clients cl ON cl.id = COALESCE(i.client_id, c.client_id) AND cl.holding_id = i.holding_id
		LEFT JOIN client_entities ce ON ce.id = i.client_entity_id AND ce.holding_id = i.holding_id
		LEFT JOIN companies co ON co.id = i.company_id AND co.holding_id = i.holding_id
		LEFT JOIN invoices ri ON ri.id = i.related_invoice_id AND ri.holding_id = i.holding_id
		LEFT JOIN LATERAL (
			SELECT SUM(p.amount) AS paid FROM invoice_payments p
			WHERE p.invoice_id = i.id AND p.holding_id = i.holding_id AND p.confirmed = true
				AND UPPER(p.currency) = UPPER(COALESCE(i.invoice_currency, i.contract_currency))${paymentCut}
		) pay ON true
		LEFT JOIN LATERAL (
			SELECT a.id, a.type, a.amount_diff, a.notes, a.adjusted_at, COALESCE(u.name, u.email) AS adjusted_by_name
			FROM invoice_adjustments a LEFT JOIN users u ON u.id = a.adjusted_by
			WHERE a.invoice_id = i.id AND a.type IN ${DEVIATION_ADJUSTMENT_TYPES}
			ORDER BY a.adjusted_at DESC, a.created_at DESC FETCH FIRST 1 ROW ONLY
		) adj ON true
		WHERE ${base.join('\n\t\t\tAND ')}
	), d AS (
		SELECT b.*,
			${balance} AS balance,
			CASE WHEN NOT ${receivable} THEN 'not_applicable'
				WHEN ${paid} THEN 'paid'
				WHEN b.paid_amount > 0 THEN 'partial'
				WHEN b.due_date < ${today}::text THEN 'overdue'
				ELSE 'unpaid' END AS payment_state,
			CASE WHEN ${linked} THEN (CASE WHEN b.status = '${PENDING_STATUS}' THEN 'draft' ELSE 'sent' END)
				WHEN b.document_kind <> 'invoice' OR NOT b.has_erp_integration OR NOT b.has_erp_partner THEN 'not_applicable'
				ELSE 'none' END AS erp_state,
			CASE WHEN b.voided THEN 'voided'
				WHEN b.status = '${CANCELLED_STATUS}' THEN (CASE WHEN b.no_charge THEN 'not_issued' ELSE 'voided' END)
				WHEN b.document_kind <> 'invoice' THEN (CASE
					WHEN b.status = '${PENDING_STATUS}' OR (NOT ${linked} AND COALESCE(TRIM(b.invoice_number), '') = '') THEN 'pending_emission'
					WHEN ${linked} THEN 'issued_erp' ELSE 'issued_external' END)
				WHEN b.status = '${PENDING_STATUS}' THEN (CASE
					WHEN b.auto_invoice AND COALESCE(b.issue_date, b.scheduled_at) < ${today}::text AND NOT ${linked} THEN 'pending_emission'
					ELSE 'not_issued' END)
				WHEN b.issued_externally THEN 'issued_external'
				WHEN ${linked} THEN 'issued_erp'
				ELSE 'issued_external' END AS electronic_state,
			(${receivable} AND NOT ${paid} AND b.due_date < ${today}::text AND COALESCE(${balance}, 0) > 0) AS is_overdue,
			CASE WHEN ${receivable} AND NOT ${paid} AND b.due_date < ${today}::text AND COALESCE(${balance}, 0) > 0
				THEN (${today}::date - b.due_date::date) ELSE 0 END AS days_overdue
		FROM base b
	)`;

	return { cte, where: derived.length ? `WHERE ${derived.join(' AND ')}` : '', conditions: derived };
}

/** Lista blanca de orden (nunca columna del usuario tal cual); desempate estable por id. */
export function orderBySql(sortBy: InvoiceSortField | undefined, sortOrder: 'asc' | 'desc' | undefined): string {
	const column =
		{
			issue_date: 'COALESCE(d.issue_date, d.scheduled_at)',
			due_date: 'd.due_date',
			invoice_number: 'd.invoice_number',
			client_name: 'd.client_name',
			contract_number: 'd.contract_number',
			company_name: 'd.company_name',
			status: 'd.status',
			total_invoice_currency: 'd.total_due',
			balance: 'd.balance',
			created_at: 'd.created_at',
		}[sortBy ?? 'issue_date'] ?? 'COALESCE(d.issue_date, d.scheduled_at)';
	const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';

	return `ORDER BY ${column} ${direction} NULLS LAST, d.created_at ${direction}, d.id`;
}

/** Documentos vinculados por fila (los del 360: NC y reemisión en ambos sentidos), solo para la página. `$1` = ids, `$2` = holding. */
export const RELATED_DOCUMENTS_SQL = `SELECT i.id, ${relatedDocumentsSql('i')} AS related_documents
	FROM invoices i WHERE i.id = ANY($1::uuid[]) AND i.holding_id = $2`;
