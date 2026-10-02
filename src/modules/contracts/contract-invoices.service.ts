import { randomUUID } from 'crypto';

import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';

import { setApiWriter } from './api-writer';
import { refreshInvoiceSystemAmounts } from './api-written-fields';
import { noChargeSql, PENDING_STATUS } from './contract-360';
import { resolveUserId } from './contract-drafts.service';
import {
	type ContractInvoiceContext,
	type ContractInvoiceLineRow,
	type ContractInvoiceRow,
	CREDIT_NOTE_SEND_PENDING_CODE,
	type ErpResetPlan,
	EXPLICIT_FX_SOURCES,
	type FxPlanItem,
	type FxRateSource,
	INVOICE_EVENT_TYPES,
	type InvoiceBlocker,
	type InvoiceEventType,
	type InvoiceWarning,
	type MarkIssuedPlan,
	planErpReset,
	planFx,
	planMarkIssued,
	planReschedule,
	planRescheduleBulk,
	planSendNow,
	type ReschedulePlanItem,
	type SendNowPlan,
	type StoredFxPolicy,
} from './contract-invoices';
import { ContractsService } from './contracts.service';

import type {
	ErpResetInvoiceDto,
	ErpResetInvoicesBulkDto,
	InvoiceFxBulkDto,
	InvoiceFxDto,
	MarkInvoiceIssuedDto,
	RescheduleInvoiceDto,
	RescheduleInvoicesBulkDto,
	SendInvoiceNowDto,
} from './dtos/contract-invoices.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const toIso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));
const parseJson = (value: unknown) => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * SELECT de una factura con lo que necesitan las operaciones (alias `i`); lo reutiliza la cola Por emitir de Facturación (`billing`), que
 * agrupa por `contract_id` para cargar el contexto de cada contrato (sin esa columna, toda factura quedaba como "sin contrato").
 */
export const CONTRACT_INVOICE_SELECT = `SELECT i.id, i.contract_id, i.invoice_number, i.status, i.document_type, i.invoice_type, i.is_active, i.is_legacy,
		i.issue_date::text AS issue_date, i.original_issue_date::text AS original_issue_date, i.scheduled_at::text AS scheduled_at, i.due_date::text AS due_date,
		i.contract_currency, i.invoice_currency, i.amount_contract_currency, i.amount_invoice_currency, i.vat, i.total_invoice_currency,
		i.fx_contract_to_invoice, i.tax_rate, l.fx_rate_source, COALESCE(l.fx_explicit, false) AS fx_explicit, i.nc_revenue_treatment,
		(SELECT MAX(e.created_at) FROM contract_lifecycle_events e
			WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id AND e.event_type = 'INVOICE_FX_CHANGED' AND e.metadata->>'invoice_id' = i.id::text) AS fx_confirmed_at,
		EXISTS (SELECT 1 FROM contract_lifecycle_events e
			WHERE e.contract_id = i.contract_id AND e.holding_id = i.holding_id AND e.event_type = 'INVOICE_ISSUED_EXTERNALLY' AND e.metadata->>'invoice_id' = i.id::text) AS issued_externally,
		${noChargeSql('i')} AS no_charge,
		i.odoo_invoice_id, i.sent_to_odoo_at, i.sent_at, i.auto_invoice, i.requires_references_for_billing, i.consolidated_into_invoice_id,
		i.client_entity_id, i.company_id, ce.legal_name,
		l.period_start::text AS period_start, l.period_end::text AS period_end,
		COALESCE(l.lines_count, 0) AS lines_count, COALESCE(l.lines_without_product, 0) AS lines_without_product, COALESCE(l.priced_base, 0) AS priced_base,
		COALESCE(l.internal_lines, 0) AS internal_lines,
		(SELECT COUNT(*) FROM invoice_references r WHERE r.invoice_id = i.id)
			+ (SELECT COUNT(*) FROM invoice_reference_links rl WHERE rl.invoice_id = i.id) AS references_count
	FROM invoices i
	LEFT JOIN client_entities ce ON ce.id = i.client_entity_id
	LEFT JOIN LATERAL (
		SELECT MIN(ii.billing_period_start) AS period_start, MAX(ii.billing_period_end) AS period_end, COUNT(*) AS lines_count,
			COUNT(*) FILTER (WHERE ii.product_id IS NULL) AS lines_without_product,
			COUNT(*) FILTER (WHERE ii.visible_line_id IS NOT NULL) AS internal_lines,
			SUM(ii.quantity * ii.unit_price_contract_currency) AS priced_base,
			mode() WITHIN GROUP (ORDER BY ii.fx_rate_source) FILTER (WHERE ii.fx_rate_source IS NOT NULL) AS fx_rate_source,
			bool_or(ii.fx_rate_source IN (${EXPLICIT_FX_SOURCES.map((source) => `'${source}'`).join(', ')})) AS fx_explicit
		FROM invoice_items ii WHERE ii.invoice_id = i.id
	) l ON true`;

/** Contrato, compañía y razón social que gobiernan sus facturas (alias `c`; se completa con el WHERE). Lo reutiliza `billing` por lote. */
export const CONTRACT_CONTEXT_SELECT = `SELECT c.id, c.contract_number, c.status, c.fx_invoice_policy, c.requires_references_for_billing, c.auto_send_to_odoo, c.payment_terms,
		c.client_entity_id, ce.odoo_partner_id, ce.payment_terms AS entity_payment_terms, co.country AS company_country, co.odoo_integration_id,
		public.get_cutoff_date(c.holding_id, c.company_id)::text AS cutoff_date
	FROM contracts c
	LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
	LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id`;

/** `ContractInvoiceContext` desde una fila de `CONTRACT_CONTEXT_SELECT`. */
export function contractInvoiceContextOf(row: Row, today: string): ContractInvoiceContext {
	return {
		contract_id: String(row.id),
		contract_number: toText(row.contract_number),
		contract_status: toText(row.status),
		contract_fx_invoice_policy: toText(row.fx_invoice_policy),
		contract_requires_references: row.requires_references_for_billing === true,
		auto_send_to_erp: row.auto_send_to_odoo !== false,
		payment_terms: parseJson(row.payment_terms),
		entity_payment_terms: parseJson(row.entity_payment_terms),
		company_country: toText(row.company_country),
		has_erp_integration: row.odoo_integration_id !== null && row.odoo_integration_id !== undefined,
		has_erp_partner: row.odoo_partner_id !== null && row.odoo_partner_id !== undefined,
		has_entity: !!row.client_entity_id,
		cutoff_date: toText(row.cutoff_date),
		today,
	};
}

/** `ContractInvoiceRow` desde una fila de `CONTRACT_INVOICE_SELECT`. */
export function contractInvoiceRowOf(row: Row): ContractInvoiceRow {
	return {
		id: String(row.id),
		invoice_number: toText(row.invoice_number),
		status: toText(row.status),
		document_type: toText(row.document_type),
		invoice_type: toText(row.invoice_type),
		is_active: row.is_active !== false,
		is_legacy: row.is_legacy === true,
		issue_date: toText(row.issue_date),
		original_issue_date: toText(row.original_issue_date),
		scheduled_at: toText(row.scheduled_at),
		due_date: toText(row.due_date),
		contract_currency: toText(row.contract_currency),
		invoice_currency: toText(row.invoice_currency),
		amount_contract_currency: toNumber(row.amount_contract_currency),
		amount_invoice_currency: toNullableNumber(row.amount_invoice_currency),
		vat: toNullableNumber(row.vat),
		total_invoice_currency: toNullableNumber(row.total_invoice_currency),
		fx_contract_to_invoice: toNullableNumber(row.fx_contract_to_invoice),
		tax_rate: toNullableNumber(row.tax_rate),
		fx_rate_source: toText(row.fx_rate_source),
		fx_confirmed_at: toIso(row.fx_confirmed_at),
		issued_externally: row.issued_externally === true,
		odoo_invoice_id: toNullableNumber(row.odoo_invoice_id),
		sent_to_odoo_at: toIso(row.sent_to_odoo_at),
		sent_at: toIso(row.sent_at),
		no_charge: row.no_charge === true,
		auto_invoice: row.auto_invoice === true,
		requires_references: row.requires_references_for_billing === true,
		consolidated_into_invoice_id: toText(row.consolidated_into_invoice_id),
		client_entity_id: toText(row.client_entity_id),
		company_id: toText(row.company_id),
		legal_name: toText(row.legal_name),
		period_start: toText(row.period_start),
		period_end: toText(row.period_end),
		lines_count: toNumber(row.lines_count),
		lines_without_product: toNumber(row.lines_without_product),
		references_count: toNumber(row.references_count),
		priced_base: toNumber(row.priced_base),
		internal_lines: toNumber(row.internal_lines),
		nc_revenue_treatment: toText(row.nc_revenue_treatment),
		fx_explicit: row.fx_explicit === true,
	};
}

export interface InvoiceOperationEvent {
	type: InvoiceEventType;
	title: string;
	description: string;
	effective_date: string | null;
	invoice_id: string;
	metadata: Record<string, unknown>;
}

export interface SendNowResult {
	sent: boolean;
	status: 'sent' | 'error' | 'skipped';
	odoo_invoice_id: number | null;
	message: string;
	blockers: InvoiceBlocker[];
	warnings: InvoiceWarning[];
	event_id: string | null;
	invoice: Awaited<ReturnType<ContractsService['invoiceDetail']>>;
}

/**
 * Facturas en el Contrato 360, etapas 1 y 2 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.1–3.3, §4): enviar al ERP ahora,
 * registrar emisión externa, reprogramar (una, una y las siguientes, masivo) y tipo de cambio por factura (una o masivo). Cada operación
 * tiene `preview` (mismo cálculo, sin escribir) y aplicación en **una transacción** con `setApiWriter` (`sapira.writer = 'api'`), `FOR UPDATE`
 * del contrato y de la factura, evento en `contract_lifecycle_events` (`metadata.invoice_id`, before/after) por factura, y nunca toca
 * emitidas (bloqueo `not_pending`). Las operaciones NO cambian la política FX del contrato (`contracts.fx_invoice_policy`).
 */
@Injectable()
export class ContractInvoicesService {
	private readonly logger = new Logger(ContractInvoicesService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly scheduler: InvoiceSchedulerService
	) {}

	// ---------------------------------------------------------------- enviar al ERP ahora (§3.1)

	async previewSendNow(idOrNumber: string, invoiceId: string, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoice = await this.loadInvoice(this.dataSource, contract.id, invoiceId, holdingId);

		return this.sendNowPreview(invoice, planSendNow(invoice, context));
	}

	/**
	 * Corre los bloqueos del 360 y, si pasa, delega en el scheduler para ESTA factura (`sendInvoiceById`, `dryRun = false`, origen
	 * `manual`): FX resuelto al enviar, borrador en Odoo, `odoo_invoice_id` + `sent_to_odoo_at`, `auto_invoice` → `auto_post`. Ignora la
	 * regla del mes en curso. Evento `INVOICE_SENT_MANUALLY` solo si el ERP devolvió el borrador.
	 */
	async sendNow(
		idOrNumber: string,
		invoiceId: string,
		dto: SendInvoiceNowDto,
		holdingId: string,
		authId: string,
		today = new Date()
	): Promise<SendNowResult> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoice = await this.loadInvoice(this.dataSource, contract.id, invoiceId, holdingId);
		const plan = planSendNow(invoice, context);

		if (plan.blockers.some((blocker) => blocker.code === CREDIT_NOTE_SEND_PENDING_CODE)) {
			throw new ConflictException({
				message: 'El envío de notas de crédito y débito al ERP todavía no está disponible',
				code: CREDIT_NOTE_SEND_PENDING_CODE,
				blockers: plan.blockers,
				preview: this.sendNowPreview(invoice, plan),
			});
		}
		if (!plan.can_apply) throw this.blocked(plan.blockers, this.sendNowPreview(invoice, plan));
		const result = await this.scheduler.sendInvoiceById(invoice.id, false, 'manual');
		const sent = result.status === 'sent';
		let eventId: string | null = null;

		if (sent) {
			// Antes/después del vínculo con el ERP (lo escribe el scheduler fuera de nuestra transacción): se relee la factura.
			const sentRow = await this.loadInvoice(this.dataSource, contract.id, invoice.id, holdingId).catch(() => null);
			const before = { odoo_invoice_id: invoice.odoo_invoice_id, sent_to_odoo_at: invoice.sent_to_odoo_at };
			const after = {
				odoo_invoice_id: sentRow?.odoo_invoice_id ?? result.odooInvoiceId ?? null,
				sent_to_odoo_at: sentRow?.sent_to_odoo_at ?? null,
			};

			eventId = await this.insertEventOutsideTransaction(contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.send_now,
				title: `Factura ${invoice.invoice_number ?? invoice.period_start ?? ''} enviada al ERP manualmente`.replace(/\s+/g, ' ').trim(),
				description: `Enviada al ERP desde el contrato (borrador ${result.odooInvoiceId ?? 'sin id'}) con fecha de emisión ${invoice.issue_date ?? 'sin fecha'}`,
				effective_date: invoice.issue_date,
				invoice_id: invoice.id,
				metadata: {
					invoice_number: invoice.invoice_number,
					odoo_invoice_id: result.odooInvoiceId ?? null,
					before,
					after,
					issue_date: invoice.issue_date,
					fx_policy: plan.summary.fx_policy,
					fx_rate: plan.summary.fx_rate,
					auto_invoice: invoice.auto_invoice,
					warnings: plan.warnings.map((warning) => warning.code),
					reason: dto.reason ?? null,
					notes: dto.notes ?? null,
				},
			});
		} else {
			this.logger.warn(`Envío manual de la factura ${invoice.id} no realizado (${result.status}): ${result.error ?? ''}`);
		}

		return {
			sent,
			status: result.status,
			odoo_invoice_id: result.odooInvoiceId ?? null,
			message: sent
				? `Factura enviada al ERP (borrador ${result.odooInvoiceId ?? ''})`.trim()
				: [result.error, result.details].filter(Boolean).join('. ') || 'El ERP no recibió la factura',
			blockers: [],
			warnings: plan.warnings,
			event_id: eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoice.id, holdingId),
		};
	}

	private sendNowPreview(invoice: ContractInvoiceRow, plan: SendNowPlan) {
		return {
			invoice: { id: invoice.id, invoice_number: invoice.invoice_number, status: invoice.status, issue_date: invoice.issue_date },
			summary: plan.summary,
			blockers: plan.blockers,
			warnings: plan.warnings,
			can_apply: plan.can_apply,
		};
	}

	// ---------------------------------------------------------------- registrar emisión externa (§3.1, S4-14)

	async previewMarkIssued(idOrNumber: string, invoiceId: string, dto: MarkInvoiceIssuedDto, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoice = await this.loadInvoice(this.dataSource, contract.id, invoiceId, holdingId);
		const lines = await this.loadLines(this.dataSource, invoice.id, holdingId);

		return this.markIssuedPreview(invoice, planMarkIssued(invoice, context, dto, lines));
	}

	/**
	 * Por Emitir → Emitida con folio y fecha reales, `issued_externally` (evento), vencimiento por condición de pago y RSM del período. Solo
	 * REGISTRA: en spot (montos en moneda de factura NULL) valoriza líneas y encabezado con la tasa realizada; si ya estaba valorizada (fija,
	 * neto exacto, OC) no reescribe nada y avisa `fx_mismatch` si la tasa informada difiere. Encabezado = Σ líneas.
	 */
	async markIssued(idOrNumber: string, invoiceId: string, dto: MarkInvoiceIssuedDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoice = await this.loadInvoice(runner, contract.id, invoiceId, holdingId, true);
			const lines = await this.loadLines(runner, invoice.id, holdingId);
			const plan = planMarkIssued(invoice, context, dto, lines);

			if (!plan.can_apply) throw this.blocked(plan.blockers, this.markIssuedPreview(invoice, plan));
			if (plan.valuate) await this.writeLineAmounts(runner, holdingId, plan.lines, plan.fx, invoice.fx_rate_source ?? 'manual', dto.issue_date);
			const header = plan.header;

			await runner.query(
				`UPDATE invoices SET status = $3, invoice_number = $4, issue_date = $5::date, due_date = $6::date,
					fx_contract_to_invoice = COALESCE($7, fx_contract_to_invoice),
					amount_contract_currency = $8, vat = $9, amount_invoice_currency = $10, total_invoice_currency = $11,
					notes = CASE WHEN $12::text IS NULL THEN notes ELSE COALESCE(notes || E'\\n', '') || $12::text END
				WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[
					invoice.id,
					holdingId,
					plan.after.status,
					plan.after.invoice_number,
					plan.after.issue_date,
					plan.after.due_date,
					plan.fx,
					header.amount_contract_currency,
					header.vat,
					header.amount_invoice_currency,
					header.total_invoice_currency,
					dto.notes?.trim() ? `Emisión registrada externamente: ${dto.notes.trim()}` : null,
				]
			);
			// Montos en moneda del sistema a la fecha real de emisión (antes `auto_populate_invoice_fx_to_system`).
			await refreshInvoiceSystemAmounts(runner, holdingId, [invoice.id]);
			await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, plan.rsm_from_month]);
			const eventId = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.mark_issued,
				title: `Factura ${plan.after.invoice_number} emitida fuera del ERP`,
				description: `Emisión registrada externamente el ${plan.after.issue_date} (folio ${plan.after.invoice_number}); vence el ${plan.after.due_date}`,
				effective_date: plan.after.issue_date,
				invoice_id: invoice.id,
				metadata: {
					before: plan.before,
					after: plan.after,
					fx: plan.fx,
					fx_rate_reported: dto.fx_rate ?? null,
					valuated: plan.valuate,
					header: plan.header,
					rsm_from_month: plan.rsm_from_month,
					warnings: plan.warnings.map((warning) => warning.code),
					reason: dto.reason ?? null,
					notes: dto.notes ?? null,
				},
			});

			return { preview: this.markIssuedPreview(invoice, plan), eventId };
		}).then(async ({ preview, eventId }) => ({
			...preview,
			applied: true,
			event_id: eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		}));
	}

	private markIssuedPreview(invoice: ContractInvoiceRow, plan: MarkIssuedPlan) {
		return {
			invoice: { id: invoice.id, invoice_number: invoice.invoice_number, status: invoice.status, issue_date: invoice.issue_date },
			before: plan.before,
			after: plan.after,
			valuate: plan.valuate,
			header: plan.header,
			lines: plan.lines,
			rsm_from_month: plan.rsm_from_month,
			blockers: plan.blockers,
			warnings: plan.warnings,
			can_apply: plan.can_apply,
		};
	}

	// ---------------------------------------------------------------- reprogramar (§3.3)

	async previewReschedule(idOrNumber: string, invoiceId: string, dto: RescheduleInvoiceDto, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoice = await this.loadInvoice(this.dataSource, contract.id, invoiceId, holdingId);
		const following = dto.apply_to === 'this_and_following' ? await this.loadPendingInvoices(this.dataSource, contract.id, holdingId) : [];

		return this.reschedulePreview(planReschedule(invoice, following, context, dto.issue_date, dto.apply_to));
	}

	/**
	 * Conserva `original_issue_date`, escribe `scheduled_at = issue_date`, vencimiento por condición de pago; período y líneas intactos. El
	 * devengo solo se reconstruye si la factura lleva descuento puntual (`nc_revenue_treatment`: su ajuste se ancla al mes de emisión), desde
	 * el menor mes de emisión (antes/después).
	 */
	async reschedule(idOrNumber: string, invoiceId: string, dto: RescheduleInvoiceDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoice = await this.loadInvoice(runner, contract.id, invoiceId, holdingId, true);
			const following = dto.apply_to === 'this_and_following' ? await this.loadPendingInvoices(runner, contract.id, holdingId, true) : [];
			const plans = planReschedule(invoice, following, context, dto.issue_date, dto.apply_to);
			const preview = this.reschedulePreview(plans);

			if (plans[0].blockers.length) throw this.blocked(plans[0].blockers, preview);
			const eventIds = await this.applyReschedules(runner, contract.id, holdingId, userId, plans, dto, plans.length > 1 ? randomUUID() : null);

			return { ...preview, applied: true, event_ids: eventIds };
		}).then(async (result) => ({ ...result, invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId) }));
	}

	async previewRescheduleBulk(idOrNumber: string, dto: RescheduleInvoicesBulkDto, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoices = await this.loadInvoicesByIds(this.dataSource, contract.id, holdingId, dto.invoice_ids);

		return this.reschedulePreview(planRescheduleBulk(invoices, context, dto));
	}

	/** Masivo dentro del contrato ("mover al mes siguiente"): aplica a las que pasan, informa las bloqueadas; un evento por factura con `bulk_id`. */
	async rescheduleBulk(idOrNumber: string, dto: RescheduleInvoicesBulkDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoices = await this.loadInvoicesByIds(runner, contract.id, holdingId, dto.invoice_ids, true);
			const plans = planRescheduleBulk(invoices, context, dto);
			const preview = this.reschedulePreview(plans);

			if (!preview.can_apply)
				throw this.blocked(
					plans.flatMap((plan) => plan.blockers),
					preview
				);
			const eventIds = await this.applyReschedules(runner, contract.id, holdingId, userId, plans, dto, randomUUID());

			return { ...preview, applied: true, event_ids: eventIds };
		});
	}

	private reschedulePreview(plans: ReschedulePlanItem[]) {
		const applicable = plans.filter((plan) => plan.blockers.length === 0);

		return {
			invoices: plans,
			updated: applicable.map((plan) => plan.id),
			skipped: plans
				.filter((plan) => plan.blockers.length)
				.map((plan) => ({ id: plan.id, invoice_number: plan.invoice_number, blockers: plan.blockers })),
			warnings: plans.flatMap((plan) => plan.warnings.map((warning) => ({ ...warning, invoice_id: plan.id }))),
			can_apply: applicable.length > 0,
		};
	}

	private async applyReschedules(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		plans: ReschedulePlanItem[],
		dto: RescheduleInvoiceDto | RescheduleInvoicesBulkDto,
		bulkId: string | null
	): Promise<string[]> {
		const eventIds: string[] = [];
		let rsmFrom: string | null = null;

		for (const plan of plans) {
			if (plan.blockers.length) continue;
			await runner.query(
				`UPDATE invoices SET scheduled_at = $3::date, issue_date = $3::date, due_date = $4::date, original_issue_date = COALESCE(original_issue_date, $5::date)
				WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[plan.id, holdingId, plan.after.issue_date, plan.after.due_date, plan.after.original_issue_date]
			);
			// La fecha de emisión cambia la tasa a la moneda del sistema (antes `auto_populate_invoice_fx_to_system`).
			await refreshInvoiceSystemAmounts(runner, holdingId, [plan.id]);
			if (plan.rsm_from_month && (!rsmFrom || plan.rsm_from_month < rsmFrom)) rsmFrom = plan.rsm_from_month;
			eventIds.push(
				await this.insertEvent(runner, contractId, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.reschedule,
					title: `Factura ${plan.invoice_number ?? plan.before.issue_date ?? ''} reprogramada al ${plan.after.issue_date}`.replace(
						/\s+/g,
						' '
					),
					description: `Emisión ${plan.before.issue_date ?? 'sin fecha'} → ${plan.after.issue_date}; vencimiento ${plan.before.due_date ?? 'sin fecha'} → ${
						plan.after.due_date
					} (original ${plan.after.original_issue_date})`,
					effective_date: plan.after.issue_date,
					invoice_id: plan.id,
					metadata: {
						invoice_number: plan.invoice_number,
						before: plan.before,
						after: plan.after,
						bulk_id: bulkId,
						rsm_from_month: plan.rsm_from_month,
						warnings: plan.warnings.map((warning) => warning.code),
						reason: dto.reason ?? null,
						notes: dto.notes ?? null,
					},
				})
			);
		}
		if (rsmFrom) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contractId, rsmFrom]);

		return eventIds;
	}

	// ---------------------------------------------------------------- tipo de cambio por factura (§3.2)

	async previewFx(idOrNumber: string, invoiceId: string, dto: InvoiceFxDto, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoice = await this.loadInvoice(this.dataSource, contract.id, invoiceId, holdingId);
		const lines = await this.loadLines(this.dataSource, invoice.id, holdingId);

		return this.fxPreview([planFx(invoice, lines, context, dto)]);
	}

	/**
	 * Política y tasa de ESTA factura sobre el almacenamiento existente (regla de Domi 29-09, nada duplicado): la tasa vive en
	 * `invoices.fx_contract_to_invoice` (NULL = spot pendiente, valor = fija), el origen en `invoice_items.fx_rate_source`/`fx_rate_date` de
	 * las líneas recalculadas y la confirmación (cuándo, quién, política) en el evento `INVOICE_FX_CHANGED`. Recalcula líneas + encabezado en
	 * moneda de factura: fijo → × tasa; neto exacto → tasa derivada con ajuste de redondeo; spot → NULL hasta emitir. No cambia la política
	 * del contrato.
	 */
	async fx(idOrNumber: string, invoiceId: string, dto: InvoiceFxDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoice = await this.loadInvoice(runner, contract.id, invoiceId, holdingId, true);
			const lines = await this.loadLines(runner, invoice.id, holdingId);
			const plan = planFx(invoice, lines, context, dto);
			const preview = this.fxPreview([plan]);

			if (plan.blockers.length) throw this.blocked(plan.blockers, preview);
			const eventIds = await this.applyFx(runner, contract.id, holdingId, userId, [plan], dto, isoDate(today), null);

			return { ...preview, applied: true, event_ids: eventIds };
		}).then(async (result) => ({ ...result, invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId) }));
	}

	async previewFxBulk(idOrNumber: string, dto: InvoiceFxBulkDto, holdingId: string, today = new Date()) {
		this.validateFxBulk(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const context = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today));
		const invoices = await this.loadInvoicesByIds(this.dataSource, contract.id, holdingId, dto.invoice_ids);
		const plans: FxPlanItem[] = [];

		for (const invoice of invoices) plans.push(planFx(invoice, await this.loadLines(this.dataSource, invoice.id, holdingId), context, dto));

		return this.fxPreview(plans);
	}

	async fxBulk(idOrNumber: string, dto: InvoiceFxBulkDto, holdingId: string, authId: string, today = new Date()) {
		this.validateFxBulk(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoices = await this.loadInvoicesByIds(runner, contract.id, holdingId, dto.invoice_ids, true);
			const plans: FxPlanItem[] = [];

			for (const invoice of invoices) plans.push(planFx(invoice, await this.loadLines(runner, invoice.id, holdingId), context, dto));
			const preview = this.fxPreview(plans);

			if (!preview.can_apply)
				throw this.blocked(
					plans.flatMap((plan) => plan.blockers),
					preview
				);
			const eventIds = await this.applyFx(runner, contract.id, holdingId, userId, plans, dto, isoDate(today), randomUUID());

			return { ...preview, applied: true, event_ids: eventIds };
		});
	}

	private validateFxBulk(dto: InvoiceFxBulkDto) {
		if (dto.policy === 'net_exact' && dto.invoice_ids.length !== 1) {
			throw validationException([{ field: 'policy', message: 'El neto exacto se aplica a una factura a la vez' }]);
		}
	}

	private fxPreview(plans: FxPlanItem[]) {
		const applicable = plans.filter((plan) => plan.blockers.length === 0);

		return {
			invoices: plans.map((plan) => ({
				id: plan.id,
				invoice_number: plan.invoice_number,
				blockers: plan.blockers,
				warnings: plan.warnings,
				before: plan.before,
				after: plan.after,
				lines: plan.lines,
			})),
			updated: applicable.map((plan) => plan.id),
			skipped: plans
				.filter((plan) => plan.blockers.length)
				.map((plan) => ({ id: plan.id, invoice_number: plan.invoice_number, blockers: plan.blockers })),
			warnings: plans.flatMap((plan) => plan.warnings.map((warning) => ({ ...warning, invoice_id: plan.id }))),
			can_apply: applicable.length > 0,
		};
	}

	private async applyFx(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		plans: FxPlanItem[],
		dto: InvoiceFxDto | InvoiceFxBulkDto,
		today: string,
		bulkId: string | null
	): Promise<string[]> {
		const eventIds: string[] = [];

		for (const plan of plans) {
			if (plan.blockers.length || !plan.write) continue;
			const { fx, fx_rate_source: source, header } = plan.write;

			await this.writeLineAmounts(runner, holdingId, plan.lines, fx, source, today);
			await runner.query(
				`UPDATE invoices SET fx_contract_to_invoice = $3, amount_contract_currency = $4, vat = $5, amount_invoice_currency = $6, total_invoice_currency = $7
				WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[plan.id, holdingId, fx, header.amount_contract_currency, header.vat, header.amount_invoice_currency, header.total_invoice_currency]
			);
			await refreshInvoiceSystemAmounts(runner, holdingId, [plan.id]);
			eventIds.push(
				await this.insertEvent(runner, contractId, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.fx,
					title: `Tipo de cambio de la factura ${plan.invoice_number ?? ''}: ${this.fxLabel(plan.before.fx_policy, plan.before.fx_rate)} → ${this.fxLabel(
						plan.after.fx_policy,
						plan.after.fx_rate,
						source
					)}`.replace(/\s+/g, ' '),
					description:
						plan.after.fx_policy === 'spot'
							? 'Pasa a spot: los montos en moneda de factura se valorizan al emitir con la tasa oficial'
							: `Tasa fija ${plan.after.fx_rate} (${source === 'net_exact' ? `derivada del neto exacto ${plan.after.amount_invoice_currency}` : 'manual'}); total ${
									plan.before.total_invoice_currency ?? 'sin valorizar'
								} → ${plan.after.total_invoice_currency}`,
					effective_date: today,
					invoice_id: plan.id,
					metadata: {
						invoice_number: plan.invoice_number,
						before: plan.before,
						after: plan.after,
						policy_requested: dto.policy,
						target_net_amount: dto.target_net_amount ?? null,
						lines_updated: plan.lines.length,
						bulk_id: bulkId,
						warnings: plan.warnings.map((warning) => warning.code),
						reason: dto.reason ?? null,
						notes: dto.notes ?? null,
					},
				})
			);
		}

		return eventIds;
	}

	private fxLabel(policy: StoredFxPolicy | null, rate: number | null, source?: FxRateSource | null) {
		if (policy === 'spot') return 'spot';
		if (policy === 'fixed') return `fijo ${rate ?? 'sin tasa'}${source === 'net_exact' ? ' (neto exacto)' : ''}`;

		return rate === null ? 'según contrato' : `según contrato (${rate})`;
	}

	/** Montos en moneda de factura de cada línea (NULL en spot) y su tasa; `fx_rate_source`/`fx_rate_date` de la línea siguen a la factura. */
	private async writeLineAmounts(
		runner: QueryRunner,
		holdingId: string,
		lines: FxPlanItem['lines'],
		fx: number | null,
		source: FxRateSource | null,
		date: string
	) {
		for (const line of lines) {
			// Multimoneda: cada línea con la tasa de su par (`line.fx`); sin ella, la del encabezado (como siempre).
			const lineFx = line.fx !== undefined ? line.fx : fx;

			await runner.query(
				`UPDATE invoice_items SET unit_price_invoice_currency = $3, subtotal_invoice_currency = $4, tax_amount_invoice_currency = $5,
					total_invoice_currency = $6, fx_contract_to_invoice = $7, fx_rate_source = $8, fx_rate_date = $9::date, updated_at = now()
				WHERE id = $1 AND holding_id = $2`,
				[
					line.id,
					holdingId,
					line.after.unit_price_invoice_currency,
					line.after.subtotal_invoice_currency,
					line.after.tax_amount_invoice_currency,
					line.after.total_invoice_currency,
					lineFx,
					lineFx === null ? null : source,
					lineFx === null ? null : date,
				]
			);
		}
	}

	// ---------------------------------------------------------------- restablecer el borrador del ERP (§3.1)

	/**
	 * Desvincula una Por Emitir de su borrador en el ERP (misma acción que `reset_invoice_odoo_draft`: `odoo_invoice_id`, `sent_to_odoo_at` y
	 * `sent_at` en NULL, nada más), con la trazabilidad que la función vieja no tenía: evento `INVOICE_ERP_DRAFT_RESET` con el antes, motivo y
	 * usuario. El borrador en Odoo NO se elimina por API (pendiente con Leon): aviso `erp_draft_remains`.
	 */
	async erpReset(idOrNumber: string, invoiceId: string, dto: ErpResetInvoiceDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoice = await this.loadInvoice(runner, contract.id, invoiceId, holdingId, true);
			const plan = planErpReset(invoice, context, await this.loadLines(runner, invoice.id, holdingId));

			if (plan.blockers.length) throw this.blocked(plan.blockers, this.erpResetPreview([plan]));
			const [eventId] = await this.applyErpResets(runner, contract.id, holdingId, userId, [plan], dto, isoDate(today), null);

			return {
				invoice_id: invoice.id,
				reset: true as const,
				previous_odoo_invoice_id: plan.before.odoo_invoice_id,
				before: plan.before,
				after: plan.after,
				spot_reset: plan.spot_reset,
				warnings: plan.warnings,
				event_id: eventId,
			};
		}).then(async (result) => ({ ...result, invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId) }));
	}

	/** Masivo: restablece las que pasan, informa las bloqueadas en `skipped`; un evento por factura con `bulk_id`. */
	async erpResetBulk(idOrNumber: string, dto: ErpResetInvoicesBulkDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const context = await this.loadContext(runner, contract.id, holdingId, isoDate(today));
			const invoices = await this.loadInvoicesByIds(runner, contract.id, holdingId, dto.invoice_ids, true);
			const plans: ErpResetPlan[] = [];

			for (const invoice of invoices) plans.push(planErpReset(invoice, context, await this.loadLines(runner, invoice.id, holdingId)));
			const preview = this.erpResetPreview(plans);

			if (!preview.can_apply)
				throw this.blocked(
					plans.flatMap((plan) => plan.blockers),
					preview
				);
			const bulkId = randomUUID();
			const eventIds = await this.applyErpResets(runner, contract.id, holdingId, userId, plans, dto, isoDate(today), bulkId);

			return { ...preview, applied: true, bulk_id: bulkId, event_ids: eventIds };
		});
	}

	private erpResetPreview(plans: ErpResetPlan[]) {
		const applicable = plans.filter((plan) => plan.blockers.length === 0);

		return {
			invoices: plans,
			updated: applicable.map((plan) => plan.id),
			skipped: plans
				.filter((plan) => plan.blockers.length)
				.map((plan) => ({ id: plan.id, invoice_number: plan.invoice_number, blockers: plan.blockers })),
			warnings: applicable.length ? plans[0].warnings : [],
			can_apply: applicable.length > 0,
		};
	}

	private async applyErpResets(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		plans: ErpResetPlan[],
		dto: ErpResetInvoiceDto,
		today: string,
		bulkId: string | null
	): Promise<string[]> {
		const eventIds: string[] = [];

		for (const plan of plans) {
			if (plan.blockers.length) continue;
			await runner.query(
				`UPDATE invoices SET odoo_invoice_id = NULL, sent_to_odoo_at = NULL, sent_at = NULL
				WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
				[plan.id, holdingId]
			);
			// Contrato spot con la tasa escrita por el envío: la factura vuelve a spot (tasa y montos en moneda de factura en NULL).
			if (plan.spot_reset) {
				await runner.query(
					`UPDATE invoice_items SET unit_price_invoice_currency = NULL, subtotal_invoice_currency = NULL, tax_amount_invoice_currency = NULL,
						total_invoice_currency = NULL, fx_contract_to_invoice = NULL, fx_rate_source = NULL, fx_rate_date = NULL, updated_at = now()
					WHERE invoice_id = $1 AND holding_id = $2`,
					[plan.id, holdingId]
				);
				await runner.query(
					`UPDATE invoices SET fx_contract_to_invoice = NULL, amount_invoice_currency = NULL, total_invoice_currency = NULL, vat = $3
					WHERE id = $1 AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
					[plan.id, holdingId, plan.after.vat]
				);
				await refreshInvoiceSystemAmounts(runner, holdingId, [plan.id]);
			}
			eventIds.push(
				await this.insertEvent(runner, contractId, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.erp_reset,
					title: `Borrador del ERP restablecido: factura ${plan.invoice_number ?? ''}`.replace(/\s+/g, ' ').trim(),
					description: `La factura se desvinculó del borrador ${plan.before.odoo_invoice_id ?? 'sin id'} del ERP (enviada ${
						plan.before.sent_to_odoo_at?.slice(0, 10) ?? 'sin fecha'
					}); el borrador sigue en el ERP hasta eliminarlo allí${plan.spot_reset ? '; vuelve a spot (la tasa del envío se descarta)' : ''}`,
					effective_date: today,
					invoice_id: plan.id,
					metadata: {
						invoice_number: plan.invoice_number,
						before: plan.before,
						after: plan.after,
						spot_reset: plan.spot_reset,
						bulk_id: bulkId,
						warnings: plan.warnings.map((warning) => warning.code),
						reason: dto.reason ?? null,
						notes: dto.notes ?? null,
					},
				})
			);
		}

		return eventIds;
	}

	// ---------------------------------------------------------------- infraestructura

	/** Una transacción con la costura `sapira.writer = 'api'` y el contrato bloqueado (`FOR UPDATE`). */
	private async transaction<T>(contractId: string, holdingId: string, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		const runner = this.dataSource.createQueryRunner();
		let active = false;

		await runner.connect();
		await runner.startTransaction();
		active = true;
		try {
			await setApiWriter(runner);
			await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE`, [
				contractId,
				holdingId,
			]);
			const result = await work(runner);

			await runner.commitTransaction();
			active = false;

			return result;
		} catch (error) {
			if (active) await runner.rollbackTransaction();
			if (!(error instanceof HttpException)) {
				this.logger.warn(
					`Operación sobre facturas del contrato ${contractId} no aplicada: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			throw error;
		} finally {
			await runner.release();
		}
	}

	private blocked(blockers: InvoiceBlocker[], preview: unknown): ConflictException {
		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			preview,
		});
	}

	private async insertEvent(
		runner: Queryable,
		contractId: string,
		holdingId: string,
		userId: string,
		event: InvoiceOperationEvent
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb) RETURNING id`,
			[
				contractId,
				holdingId,
				event.type,
				event.title,
				event.description,
				userId,
				event.effective_date,
				JSON.stringify({ source: 'contract_360', invoice_id: event.invoice_id, ...event.metadata }),
			]
		)) as Row[];

		return String(row.id);
	}

	/** El envío al ERP no corre en nuestra transacción (el scheduler escribe por repositorio): el evento se inserta aparte, con la costura. */
	private async insertEventOutsideTransaction(
		contractId: string,
		holdingId: string,
		userId: string,
		event: InvoiceOperationEvent
	): Promise<string> {
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		try {
			await setApiWriter(runner);
			const id = await this.insertEvent(runner, contractId, holdingId, userId, event);

			await runner.commitTransaction();

			return id;
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}
	}

	// ---------------------------------------------------------------- carga

	async loadContext(db: Queryable, contractId: string, holdingId: string, today: string): Promise<ContractInvoiceContext> {
		const [row] = (await db.query(`${CONTRACT_CONTEXT_SELECT} WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL`, [
			contractId,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Contrato no encontrado');

		return contractInvoiceContextOf(row, today);
	}

	/** La factura del contrato (404 si no es de él o del holding); con `lock`, `FOR UPDATE OF i` dentro de la transacción. */
	async loadInvoice(db: Queryable, contractId: string, invoiceId: string, holdingId: string, lock = false): Promise<ContractInvoiceRow> {
		const [row] = (await db.query(
			`${CONTRACT_INVOICE_SELECT} WHERE i.id = $1::uuid AND i.contract_id = $2 AND i.holding_id = $3${lock ? ' FOR UPDATE OF i' : ''}`,
			[invoiceId, contractId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Factura no encontrada');

		return this.invoiceRow(row);
	}

	/** Varias facturas del contrato por id (404 si alguna no es del contrato), en el orden pedido. */
	async loadInvoicesByIds(db: Queryable, contractId: string, holdingId: string, ids: string[], lock = false): Promise<ContractInvoiceRow[]> {
		const unique = [...new Set(ids)];
		const rows = (await db.query(
			`${CONTRACT_INVOICE_SELECT} WHERE i.contract_id = $1 AND i.holding_id = $2 AND i.id = ANY($3::uuid[])${lock ? ' FOR UPDATE OF i' : ''}`,
			[contractId, holdingId, unique]
		)) as Row[];
		const byId = new Map(rows.map((row) => [String(row.id), this.invoiceRow(row)]));
		const missing = unique.filter((id) => !byId.has(id));

		if (missing.length) throw new NotFoundException(`Facturas que no son del contrato: ${missing.join(', ')}`);

		return unique.map((id) => byId.get(id)!);
	}

	/** Por Emitir activas del contrato ordenadas por emisión (para "esta y las siguientes"). */
	async loadPendingInvoices(db: Queryable, contractId: string, holdingId: string, lock = false): Promise<ContractInvoiceRow[]> {
		const rows = (await db.query(
			`${CONTRACT_INVOICE_SELECT} WHERE i.contract_id = $1 AND i.holding_id = $2 AND i.status = '${PENDING_STATUS}' AND i.is_active = true
			ORDER BY i.issue_date NULLS LAST, i.created_at, i.id${lock ? ' FOR UPDATE OF i' : ''}`,
			[contractId, holdingId]
		)) as Row[];

		return rows.map((row) => this.invoiceRow(row));
	}

	async loadLines(db: Queryable, invoiceId: string, holdingId: string): Promise<ContractInvoiceLineRow[]> {
		const rows = (await db.query(
			`SELECT ii.id, ii.quantity, ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency, ii.total_contract_currency,
				ii.unit_price_invoice_currency, ii.subtotal_invoice_currency, ii.tax_amount_invoice_currency, ii.total_invoice_currency, ii.created_at,
				ii.contract_currency, ii.billing_period_start::text AS billing_period_start
			FROM invoice_items ii WHERE ii.invoice_id = $1 AND ii.holding_id = $2
			ORDER BY ii.subtotal_contract_currency DESC NULLS LAST, ii.created_at, ii.id`,
			[invoiceId, holdingId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			quantity: toNumber(row.quantity),
			unit_price_contract_currency: toNumber(row.unit_price_contract_currency),
			subtotal_contract_currency: toNumber(row.subtotal_contract_currency),
			tax_amount_contract_currency: toNumber(row.tax_amount_contract_currency),
			total_contract_currency: toNumber(row.total_contract_currency),
			unit_price_invoice_currency: toNullableNumber(row.unit_price_invoice_currency),
			subtotal_invoice_currency: toNullableNumber(row.subtotal_invoice_currency),
			tax_amount_invoice_currency: toNullableNumber(row.tax_amount_invoice_currency),
			total_invoice_currency: toNullableNumber(row.total_invoice_currency),
			created_at: toIso(row.created_at),
			// Multimoneda: moneda de origen de la línea (la del ítem) y su período, para valorizar por par.
			...(toText(row.contract_currency) ? { currency: toText(row.contract_currency) } : {}),
			...(toText(row.billing_period_start) ? { billing_period_start: toText(row.billing_period_start) } : {}),
		}));
	}

	private invoiceRow(row: Row): ContractInvoiceRow {
		return contractInvoiceRowOf(row);
	}
}
