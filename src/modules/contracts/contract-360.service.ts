import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
	type BlockerContext,
	buildConsumption,
	buildLifecycle,
	buildSchedule,
	computeBlockers,
	computeFinancial,
	type ConsumptionInvoiceLine,
	type ConsumptionItem,
	type FactsItem,
	fixedFxRate,
	fxPairLabel,
	invoiceCurrencyInUse,
	paymentTermsLabel,
	pickNextInvoice,
	type QuantityRow,
	type ScheduleInvoice,
	summarizeItems,
	typicalPaymentTermsLabel,
} from './contract-360';
import { type ContractDerivedStatus, derivedStatusLateral } from './contract-status';
import { ContractsService, NEXT_ITEM_END_LATERAL, NOT_PENDING_RENEWAL } from './contracts.service';

type Row = Record<string, unknown>;

const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toBool = (value: unknown) => (value === null || value === undefined ? null : Boolean(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const isoDay = (value: unknown) => iso(value)?.slice(0, 10) ?? null;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Tipos de evento (normalizados) que marcan el cierre del contrato. */
const CLOSING_EVENT_TYPES = new Set(['CHURN', 'CANCELLED', 'CONTRACT_CANCELLED', 'CANCELLATION']);

/**
 * Contrato 360 enriquecido (solo lectura): resumen (`overview`), calendario de facturación por período (`schedule`),
 * cantidades registradas (`consumption`) y documentos. Cada ruta resuelve primero el contrato en el holding (404 si
 * no es suyo) y toda consulta se acota al contrato y al holding. Reglas en `contract-360.ts`.
 */
@Injectable()
export class Contract360Service {
	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService
	) {}

	/** Contrato con lo necesario para el resumen y el calendario. `$3` = hoy. */
	private async loadContext(contractId: string, holdingId: string, today: string): Promise<Row> {
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT c.id, c.status, c.created_at, c.contract_currency, c.invoice_currency, c.system_currency,
				c.fx_invoice_policy, c.fx_invoice_confirmed_at, c.fx_company_policy,
				c.total_value, c.total_value_system_currency, c.churn_date::text AS churn_date, c.contract_end_date::text AS end_date,
				c.term, c.requires_references_for_billing, c.group_invoices_by_period, c.auto_send_to_odoo,
				c.client_entity_id, ce.odoo_partner_id,
				-- Columna nueva (migración 1790358766159): vía to_jsonb para que la consulta no falle donde aún no existe.
				to_jsonb(c)->'payment_terms' AS payment_terms,
				(SELECT MIN(ci.start_date) FROM contract_items ci WHERE ci.contract_id = c.id)::text AS start_date,
				nx.next_item_end_date::text AS next_item_end_date, ds.derived_status,
				q.id AS quote_id, q.quote_number, sl.id AS seller_id, sl.name AS seller_name,
				(SELECT COUNT(*) FROM contract_documents d WHERE d.contract_id = c.id AND d.holding_id = $2) AS documents_count,
				rsm.mrr_system, rsm.mrr_contract
			FROM contracts c
			LEFT JOIN client_entities ce ON ce.id = c.client_entity_id
			LEFT JOIN quotes q ON q.id = c.quote_id
			LEFT JOIN sellers sl ON sl.id = q.seller_id
			${NEXT_ITEM_END_LATERAL.replace(/\$2::date/g, '$3::date')}
			${derivedStatusLateral('$3')}
			LEFT JOIN LATERAL (
				SELECT SUM(r.mrr_period_system_ccy) AS mrr_system, SUM(r.mrr_period_contract_ccy) AS mrr_contract
				FROM revenue_schedule_monthly r
				WHERE r.contract_id = c.id AND r.holding_id = $2 AND r.is_total_row = false
					AND r.period_month = date_trunc('month', $3::date) AND ${NOT_PENDING_RENEWAL}
			) rsm ON true
			WHERE c.id = $1 AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL`,
			[contractId, holdingId, today]
		);

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return row;
	}

	/** Todas las facturas del contrato (también inactivas y canceladas) con su período, líneas y referencias. */
	private async loadInvoices(contractId: string, holdingId: string): Promise<ScheduleInvoice[]> {
		const rows = await this.dataSource.query<Row[]>(
			`SELECT i.id, i.invoice_number, i.status, i.document_type, i.is_active,
				i.issue_date::text AS issue_date, i.due_date::text AS due_date,
				i.contract_currency, i.invoice_currency, i.amount_contract_currency, i.amount_invoice_currency, i.fx_contract_to_invoice,
				i.requires_references_for_billing, i.related_invoice_id,
				l.period_start::text AS period_start, l.period_end::text AS period_end,
				COALESCE(l.lines_count, 0) AS lines_count, COALESCE(l.lines_without_product, 0) AS lines_without_product,
				COALESCE(l.has_non_recurring, false) AS has_non_recurring,
				(SELECT COUNT(*) FROM invoice_references r WHERE r.invoice_id = i.id)
					+ (SELECT COUNT(*) FROM invoice_reference_links rl WHERE rl.invoice_id = i.id) AS references_count
			FROM invoices i
			LEFT JOIN LATERAL (
				SELECT MIN(ii.billing_period_start) AS period_start, MAX(ii.billing_period_end) AS period_end, COUNT(*) AS lines_count,
					COUNT(*) FILTER (WHERE ii.product_id IS NULL) AS lines_without_product,
					bool_or(ci.is_recurring = false) AS has_non_recurring
				FROM invoice_items ii
				LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
				WHERE ii.invoice_id = i.id
			) l ON true
			WHERE i.contract_id = $1 AND i.holding_id = $2`,
			[contractId, holdingId]
		);

		return rows.map((row) => ({
			id: row.id as string,
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			document_type: toText(row.document_type),
			is_active: row.is_active !== false,
			issue_date: toText(row.issue_date),
			due_date: toText(row.due_date),
			contract_currency: toText(row.contract_currency),
			invoice_currency: toText(row.invoice_currency),
			amount_contract_ccy: toNumber(row.amount_contract_currency),
			amount_invoice_ccy: toNullableNumber(row.amount_invoice_currency),
			fx_contract_to_invoice: toNullableNumber(row.fx_contract_to_invoice),
			requires_references: row.requires_references_for_billing === true,
			period_start: toText(row.period_start),
			period_end: toText(row.period_end),
			lines_count: toNumber(row.lines_count),
			lines_without_product: toNumber(row.lines_without_product),
			has_non_recurring: row.has_non_recurring === true,
			references_count: toNumber(row.references_count),
			related_invoice_id: toText(row.related_invoice_id),
		}));
	}

	private static blockerContext(context: Row, today: string): BlockerContext {
		return {
			requires_references: context.requires_references_for_billing === true,
			fx_invoice_policy: toText(context.fx_invoice_policy),
			contract_currency: toText(context.contract_currency),
			// Mismo criterio que el scheduler: NULL cuenta como envío automático.
			auto_send: context.auto_send_to_odoo !== false,
			has_erp_partner: context.odoo_partner_id !== null && context.odoo_partner_id !== undefined,
			has_entity: !!context.client_entity_id,
			today,
		};
	}

	// ---------------------------------------------------------------- resumen

	async overview(idOrNumber: string, holdingId: string, asOfDate = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const today = isoDate(asOfDate);
		const [context, invoices, itemRows, history] = await Promise.all([
			this.loadContext(contract.id, holdingId, today),
			this.loadInvoices(contract.id, holdingId),
			this.dataSource.query<Row[]>(
				`SELECT ci.is_recurring, ci.categoria, ci.churn_date::text AS churn_date, ci.start_date::text AS start_date,
					ci.end_date::text AS end_date, ci.renewed_by_item_id, ci.auto_renew, ci.auto_renew_term_months, ci.term_months,
					ci.billing_frequency, ci.billing_method
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				WHERE ci.contract_id = $1 AND c.holding_id = $2`,
				[contract.id, holdingId]
			),
			this.contracts.history(contract.id, holdingId),
		]);
		const items: FactsItem[] = itemRows.map((row) => ({
			is_recurring: row.is_recurring !== false,
			categoria: toText(row.categoria),
			churn_date: toText(row.churn_date),
			start_date: toText(row.start_date),
			end_date: toText(row.end_date),
			renewed_by_item_id: toText(row.renewed_by_item_id),
			auto_renew: row.auto_renew === true,
			auto_renew_term_months: toNullableNumber(row.auto_renew_term_months),
			term_months: toNullableNumber(row.term_months),
			billing_frequency: toText(row.billing_frequency) || null,
			billing_method: toText(row.billing_method) || null,
		}));
		const derivedStatus = (toText(context.derived_status) ?? 'other') as ContractDerivedStatus;
		const contractCurrency = toText(context.contract_currency);
		const tcv = toNumber(context.total_value);
		const itemFacts = summarizeItems(items, today, toNullableNumber(context.term));
		const financial = computeFinancial(invoices, tcv, today);
		const eventDate = (event: { effective_date: string | null; created_at: string | null }) =>
			event.effective_date ?? event.created_at?.slice(0, 10) ?? null;
		// `history` viene más nuevo primero.
		const activationEvent = [...history.data].reverse().find((event) => event.type === 'ACTIVATION');
		const closingEvent = history.data.find((event) => CLOSING_EVENT_TYPES.has(event.type));
		const startDate = toText(context.start_date);
		const lastEvent = history.data[0];
		const next = pickNextInvoice(invoices);

		return {
			lifecycle: buildLifecycle({
				derived_status: derivedStatus,
				created_at: isoDay(context.created_at),
				activation_date: activationEvent ? eventDate(activationEvent) : startDate,
				next_item_end_date: toText(context.next_item_end_date),
				overdue_renewal_date: itemFacts.overdue_renewal_date,
				closed_date: toText(context.churn_date) ?? (closingEvent ? eventDate(closingEvent) : null),
			}),
			facts: {
				contract_currency: contractCurrency,
				invoice_currency: invoiceCurrencyInUse(contractCurrency, toText(context.invoice_currency), invoices),
				fx_invoice_policy: toText(context.fx_invoice_policy),
				fx_rate: fixedFxRate(toText(context.fx_invoice_policy), invoices, contractCurrency),
				fx_confirmed_at: iso(context.fx_invoice_confirmed_at),
				fx_company_policy: toText(context.fx_company_policy),
				start_date: startDate,
				end_date: toText(context.end_date),
				next_item_end_date: toText(context.next_item_end_date),
				renewal: itemFacts.renewal,
				billing: {
					frequency: itemFacts.frequency,
					method: itemFacts.method,
					payment_terms_label:
						paymentTermsLabel(context.payment_terms) ?? typicalPaymentTermsLabel(invoices.filter((invoice) => invoice.is_active)),
					group_invoices_by_period: toBool(context.group_invoices_by_period),
				},
				references: { required: context.requires_references_for_billing === true },
			},
			financial: {
				currency: contractCurrency,
				system_currency: toText(context.system_currency),
				mrr: toNumber(context.mrr_contract),
				mrr_system: toNumber(context.mrr_system),
				tcv,
				tcv_system: toNumber(context.total_value_system_currency),
				invoiced_to_date: financial.invoiced_to_date,
				invoiced_pct: financial.invoiced_pct,
				pending_to_invoice: financial.pending_to_invoice,
				pending_periods: financial.pending_periods,
				collected: financial.collected,
				overdue: financial.overdue,
				overdue_count: financial.overdue_count,
				open_receivable: financial.open_receivable,
			},
			next_invoice: next
				? {
						id: next.id,
						issue_date: next.issue_date,
						due_date: next.due_date,
						amount_contract_ccy: round2(next.amount_contract_ccy),
						amount_invoice_ccy: next.amount_invoice_ccy === null ? null : round2(next.amount_invoice_ccy),
						contract_currency: next.contract_currency ?? contractCurrency,
						invoice_currency: next.invoice_currency,
						status: next.status,
						blockers: computeBlockers(next, Contract360Service.blockerContext(context, today)),
					}
				: null,
			links: {
				quote: context.quote_id ? { id: context.quote_id as string, number: toText(context.quote_number) } : null,
				seller: context.seller_id ? { id: context.seller_id as string, name: toText(context.seller_name) } : null,
				documents_count: toNumber(context.documents_count),
				last_change: lastEvent
					? { title: lastEvent.title ?? 'Cambio en el contrato', date: eventDate(lastEvent), type: lastEvent.type }
					: null,
			},
		};
	}

	// ---------------------------------------------------------------- calendario de facturación

	async schedule(idOrNumber: string, holdingId: string, options: { includeCancelled?: boolean } = {}, asOfDate = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const today = isoDate(asOfDate);
		const [context, invoices] = await Promise.all([this.loadContext(contract.id, holdingId, today), this.loadInvoices(contract.id, holdingId)]);
		const policy = toText(context.fx_invoice_policy);
		const contractCurrency = toText(context.contract_currency);
		const invoiceCurrency = toText(context.invoice_currency);
		const currencyInUse = invoiceCurrencyInUse(contractCurrency, invoiceCurrency, invoices);
		const schedule = buildSchedule(invoices, {
			includeCancelled: options.includeCancelled === true,
			tcv: toNumber(context.total_value),
			today,
			blockerContext: Contract360Service.blockerContext(context, today),
		});

		return {
			currency: contractCurrency,
			invoice_currency: currencyInUse,
			...schedule,
			fx: {
				policy,
				rate: fixedFxRate(policy, invoices, contractCurrency),
				pair: fxPairLabel(contractCurrency, currencyInUse),
				confirmed_at: iso(context.fx_invoice_confirmed_at),
				// Ni la columna ni un evento registran quién confirmó el tipo de cambio (apply_fixed_fx_to_contract solo fija la fecha).
				confirmed_by: null as string | null,
			},
		};
	}

	// ---------------------------------------------------------------- cantidades

	async consumption(idOrNumber: string, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const [quantityRows, itemRows, lineRows] = await Promise.all([
			this.dataSource.query<Row[]>(
				`SELECT q.id, q.contract_item_id, q.period::text AS period, q.quantity, q.unit_price, q.amount, q.account
				FROM quantities q
				JOIN contract_items ci ON ci.id = q.contract_item_id
				JOIN contracts c ON c.id = ci.contract_id
				WHERE ci.contract_id = $1 AND c.holding_id = $2 AND q.period IS NOT NULL`,
				[contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ci.id, ci.product_name, ci.account
				FROM contract_items ci
				JOIN contracts c ON c.id = ci.contract_id
				WHERE ci.contract_id = $1 AND c.holding_id = $2
				ORDER BY ci.product_name, ci.account NULLS FIRST, ci.start_date NULLS FIRST, ci.id`,
				[contract.id, holdingId]
			),
			this.dataSource.query<Row[]>(
				`SELECT ii.contract_item_id, ii.billing_period_start::text AS billing_period_start,
					i.id AS invoice_id, i.invoice_number, i.status, i.is_active
				FROM invoice_items ii
				JOIN invoices i ON i.id = ii.invoice_id
				WHERE i.contract_id = $1 AND i.holding_id = $2
					AND ii.contract_item_id IN (
						SELECT q.contract_item_id FROM quantities q JOIN contract_items qi ON qi.id = q.contract_item_id WHERE qi.contract_id = $1
					)
				ORDER BY i.issue_date DESC NULLS LAST, i.id`,
				[contract.id, holdingId]
			),
		]);
		const quantities: QuantityRow[] = quantityRows.map((row) => ({
			id: row.id as string,
			contract_item_id: row.contract_item_id as string,
			period: String(row.period).slice(0, 10),
			quantity: toNullableNumber(row.quantity),
			unit_price: toNullableNumber(row.unit_price),
			amount: toNullableNumber(row.amount),
			account: toText(row.account) || null,
		}));
		const items: ConsumptionItem[] = itemRows.map((row) => ({
			id: row.id as string,
			product_name: toText(row.product_name),
			account: toText(row.account) || null,
		}));
		const lines: ConsumptionInvoiceLine[] = lineRows.map((row) => ({
			contract_item_id: row.contract_item_id as string,
			billing_period_start: toText(row.billing_period_start),
			invoice_id: row.invoice_id as string,
			invoice_number: toText(row.invoice_number),
			status: toText(row.status),
			is_active: row.is_active !== false,
		}));

		return buildConsumption(quantities, items, lines);
	}

	// ---------------------------------------------------------------- documentos

	/**
	 * Documentos del contrato (solo la lista). Los archivos viven en el bucket privado `contract-documents` con ruta
	 * `<contract_id>/<timestamp>.<ext>` y `file_url` guarda una URL pública que no abre (el bucket es privado): la
	 * descarga necesitará una URL firmada emitida por la API, como los documentos de clientes.
	 */
	async documents(idOrNumber: string, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const rows = await this.dataSource.query<Row[]>(
			`SELECT d.id, d.document_name, d.file_size, d.file_type, d.category,
				COALESCE(d.uploaded_at, d.created_at) AS created_at, NULLIF(TRIM(d.file_url), '') IS NOT NULL AS has_file,
				u.id AS user_id, u.name AS user_name
			FROM contract_documents d
			-- uploaded_by apunta a auth.users: se resuelve el usuario de la app por auth_id.
			LEFT JOIN LATERAL (
				SELECT pu.id, COALESCE(pu.name, pu.email) AS name FROM users pu WHERE pu.auth_id = d.uploaded_by LIMIT 1
			) u ON true
			WHERE d.contract_id = $1 AND d.holding_id = $2
			ORDER BY COALESCE(d.uploaded_at, d.created_at) DESC NULLS LAST, d.id`,
			[contract.id, holdingId]
		);

		return {
			data: rows.map((row) => ({
				id: row.id as string,
				name: toText(row.document_name) || 'Documento',
				size_bytes: toNullableNumber(row.file_size),
				mime_type: toText(row.file_type) || null,
				category: toText(row.category) || null,
				created_at: iso(row.created_at),
				uploaded_by: row.user_id ? { id: row.user_id as string, name: toText(row.user_name) } : null,
				has_file: row.has_file === true,
			})),
		};
	}
}
