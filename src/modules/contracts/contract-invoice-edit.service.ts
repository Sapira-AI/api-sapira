import { randomUUID } from 'crypto';

import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { refreshInvoiceSystemAmounts } from './api-written-fields';
import { addDays, defaultAnchorDay, generateInvoices, round2, type TaxDocumentRate } from './billing-engine';
import { isCreditNote, PENDING_STATUS } from './contract-360';
import { ContractActivationService } from './contract-activation.service';
import { cleanPaymentTerms, resolveUserId } from './contract-drafts.service';
import { type ContractInvoiceRow, INVOICE_EVENT_TYPES, type InvoiceBlocker, type InvoiceWarning } from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService, ISSUED_INVOICE_STATUSES } from './contracts.service';
import { invoicesVsTotalSummary, withDeviationCauses } from './end-off-cycle';
import { type DescriptionReference, parseStoredTemplate, referenceKind } from './invoice-description';
import {
	type BulkHeaderPlanItem,
	deviationKey,
	type DeviationPlan,
	deviationReasonBlocker,
	deviationReasonMissing,
	type DeviationView,
	EDIT_FX_RATE_SOURCE,
	type EditContext,
	type EditInvoiceRow,
	type EditItem,
	type EditLineRow,
	type EditPlan,
	invoiceFx,
	type IssuedPeriod,
	type LineModePlan,
	type LineState,
	planBulkHeader,
	planFollowingLineMode,
	planInvoiceEdit,
	type ReceiverRow,
	reconcileDeviation,
	type RenderInput,
	stateOf,
} from './invoice-edit';
import { loadPairRateContext, revalueMulticurrencyInvoices } from './multicurrency-invoices';
import { PRICE_COLUMNS, priceSpecFromRow } from './price-rows';
import { DESCRIPTION_LIMITS_SQL, type DescriptionLimitRow, resolveDescriptionMaxChars } from './tax-document-types';

import type { BulkEditInvoicesDto, EditInvoiceDto, ExplainInvoiceDeviationDto } from './dtos/contract-invoice-edit.dto';
import type { PricedSubline } from './pricing-engine';

type Row = Record<string, unknown>;

/** Plan de `apply_to_pending` (términos del contrato a sus Por Emitir): aplicables + omitidas con motivo. */
export interface PendingTermsPlan {
	text: string | null;
	plans: BulkHeaderPlanItem[];
	updated: string[];
	skipped: Array<{ invoice_id: string; invoice_number: string | null; reason: string; message: string }>;
}
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const parseJson = <T>(value: unknown): T | null => {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') return value as T;
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
};

/** Documento tributario del contrato (familia y tasa) para la regla del IVA (`resolveTaxRate`, ronda 3 de Configuración). */
const taxDocumentOf = (row: Record<string, unknown> | null | undefined): TaxDocumentRate | null =>
	row?.tax_document_type_id
		? { kind: toText(row.tax_document_type_kind), tax_rate: (row.tax_document_tax_rate as number | string | null) ?? null }
		: null;

const CONTRACT_SQL = `SELECT c.id, c.contract_number, c.client_id, c.document_type, c.billing_anchor_day, c.group_invoices_by_period, c.invoice_currency,
		c.contract_currency, c.fx_invoice_policy, c.payment_terms, c.invoice_description_template, c.tax_document_type_id,
		c.requires_multicurrency_billing,
		tdt.description_max_chars AS own_description_max_chars, co.country AS company_country, co.tax_rate AS company_tax_rate,
		tdt.kind AS tax_document_type_kind, tdt.tax_rate AS tax_document_tax_rate,
		ce.country AS entity_country, ce.payment_terms AS entity_payment_terms, ce.legal_name AS entity_legal_name,
		${DESCRIPTION_LIMITS_SQL} AS description_limits
	FROM contracts c
	LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
	LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id
	LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
	WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL`;

/** Ítems con su modelo de precio (copia del contrato) y consumos registrados: lo que el plan espera (mismo formato que la activación). */
const ITEMS_SQL = `SELECT ci.id, ci.product_id, ci.product_name, ci.account, ci.unit_of_measure, ci.quantity, ci.unit_price, ci.annual_unit_price,
		ci.discount_type, ci.discount_value, ci.final_price, ci.billing_frequency, ci.billing_method,
		ci.start_date::text AS start_date, ci.end_date::text AS end_date, ci.churn_date::text AS churn_date, ci.term_months, ci.is_recurring,
		p.owner AS price_owner, ${PRICE_COLUMNS},
		(SELECT COALESCE(jsonb_agg(jsonb_build_object(
				'period_start', e.period_start, 'quantity', e.quantity, 'amount_override', e.amount_override,
				'apply_item_discount', e.apply_item_discount, 'is_estimated', e.is_estimated)), '[]'::jsonb)
			FROM consumption_entries e WHERE e.contract_item_id = ci.id AND e.holding_id = ci.holding_id) AS consumption
	FROM contract_items ci
	LEFT JOIN prices p ON p.id = ci.price_id
	WHERE ci.contract_id = $1 AND ci.holding_id = $2
	ORDER BY ci.start_date NULLS LAST, ci.product_name, ci.id`;

/** Líneas de una o varias facturas, en el orden del detalle (filas de un ítem juntas, tramos en su orden). */
const LINES_SQL = `SELECT ii.id, ii.invoice_id, ii.contract_item_id, ii.product_id, ci.product_name, ci.account, ii.description, ii.description_locked,
		ii.quantity, ii.unit_of_measure, ii.discount_pct, ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency,
		ii.total_contract_currency, ii.unit_price_invoice_currency, ii.subtotal_invoice_currency, ii.tax_amount_invoice_currency, ii.total_invoice_currency,
		ii.billing_period_start::text AS billing_period_start, ii.billing_period_end::text AS billing_period_end, ii.quantity_source, ii.pricing_breakdown,
		ii.visible_line_id, ii.contract_currency AS line_currency, ii.fx_contract_to_invoice AS line_fx, ii.fx_rate_source AS line_fx_rate_source
	FROM invoice_items ii
	LEFT JOIN contract_items ci ON ci.id = ii.contract_item_id
	WHERE ii.invoice_id = ANY($1::uuid[]) AND ii.holding_id = $2
	ORDER BY ii.invoice_id, ii.billing_period_start NULLS LAST, ci.product_name NULLS LAST, ci.account NULLS FIRST, ii.contract_item_id,
		CASE WHEN jsonb_typeof(ii.pricing_breakdown) = 'array' THEN (ii.pricing_breakdown->0->>'line_index')::int END NULLS FIRST,
		ii.created_at, ii.id`;

/** Líneas de todas las facturas vigentes del contrato (para el conciliador y los períodos ya emitidos). */
const CONTRACT_LINES_SQL = `SELECT ii.invoice_id, ii.contract_item_id, ii.billing_period_start::text AS billing_period_start,
		ii.billing_period_end::text AS billing_period_end, ii.subtotal_contract_currency, i.status, i.invoice_number, i.document_type,
		EXISTS (SELECT 1 FROM invoices n WHERE n.related_invoice_id = i.id AND n.holding_id = i.holding_id AND n.credit_type = 'cancellation'
			AND n.is_active = true AND n.status IS DISTINCT FROM 'Cancelada') AS cancelled_by_credit_note
	FROM invoice_items ii
	JOIN invoices i ON i.id = ii.invoice_id
	WHERE i.contract_id = $1 AND i.holding_id = $2 AND i.is_active = true AND COALESCE(i.is_legacy, false) = false
		AND i.status NOT IN ('Cancelada', 'Anulada') AND ii.contract_item_id IS NOT NULL`;

const HEADER_EXTRA_SQL = `SELECT i.id, i.client_tax_id, i.export_type, i.invoice_terms_and_conditions, i.notes, i.nc_revenue_treatment
	FROM invoices i WHERE i.id = ANY($1::uuid[]) AND i.holding_id = $2`;

const REFERENCES_SQL = `SELECT r.document_type_code AS type, r.document_type_name AS name, r.document_number AS code FROM invoice_references r
	WHERE r.invoice_id = $1 AND r.holding_id = $2
	UNION ALL
	SELECT br.reference_type::text, NULL, br.reference_code FROM invoice_reference_links rl JOIN billing_references br ON br.id = rl.reference_id
	WHERE rl.invoice_id = $1`;

/** Misma regla de junction que `change_entity` (`contract-changes.service.ts`): la razón social es del cliente del contrato. */
const RECEIVER_SQL = `SELECT ce.id, ce.legal_name, ce.tax_id, ce.country,
		(ce.client_id = c.client_id OR EXISTS (
			SELECT 1 FROM client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = c.client_id AND x.holding_id = c.holding_id)) AS belongs
	FROM client_entities ce CROSS JOIN contracts c
	WHERE ce.id = $1 AND ce.holding_id = $2 AND c.id = $3`;

/** Último ajuste registrado por factura (motivo del desvío). */
const LATEST_ADJUSTMENTS_SQL = `SELECT DISTINCT ON (a.invoice_id) a.invoice_id, a.id, a.type, a.amount_diff, a.notes, a.adjusted_at
	FROM invoice_adjustments a WHERE a.invoice_id = ANY($1::uuid[]) AND a.holding_id = $2
	ORDER BY a.invoice_id, a.adjusted_at DESC, a.created_at DESC`;

export interface ContractPlanData {
	contract: Row;
	items: Row[];
	contract_lines: Row[];
}

export interface FollowingResult {
	invoice_id: string;
	invoice_number: string | null;
	issue_date: string | null;
	status: 'updated' | 'unchanged' | 'skipped';
	reason: string | null;
	periods: string[];
	skipped: Array<{ period_start: string; reason: string }>;
	/** Solo para escribir. */
	write?: { updates: Array<{ id: string; after: LineState }>; creates: LineState[]; removes: string[]; invoice: ContractInvoiceRow };
}

export interface InvoiceEditPreview {
	invoice: {
		id: string;
		invoice_number: string | null;
		status: string | null;
		before: EditPlan['header']['before'];
		after: EditPlan['header']['after'];
	};
	lines: Array<{
		id: string | null;
		action: EditPlan['lines'][number]['action'];
		before: LineState | null;
		after: LineState | null;
		is_visible: boolean;
	}>;
	line_mode: Array<LineModePlan & { following: Array<Omit<FollowingResult, 'write'>> }>;
	deviation: DeviationView;
	/** Dónde cae en el devengo el descuento puntual (null si la factura no tiene ni tenía uno). */
	revenue_effect: EditPlan['revenue_effect'];
	warnings: InvoiceWarning[];
	blockers: InvoiceBlocker[];
	can_apply: boolean;
}

/**
 * Facturas en el Contrato 360, etapa 4 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.4): editar una Por Emitir como un todo,
 * explicar un desvío heredado, listar las Por Emitir que se desvían del plan sin motivo y el masivo de encabezado. Cada escritura va en
 * **una transacción** con `setApiWriter` (`sapira.writer = 'api'`) como primera sentencia, el contrato y la factura bloqueados (`FOR UPDATE`),
 * encabezado = Σ líneas con la convención FX de la factura, montos en moneda del sistema (`refreshInvoiceSystemAmounts`), devengo
 * (`revenue_schedule_rebuild`) solo si cambió un monto, y evento en `contract_lifecycle_events`. Nunca escribe `invoices.updated_at`.
 */
/** Ítems del contrato al formato del generador (con su baja) y día de ciclo, para detectar la causa de un desvío (`end-off-cycle.ts`). */
export function deviationCauseContext(data: Pick<ContractPlanData, 'contract' | 'items'>) {
	const items = new Map(
		data.items.map((row) => [String(row.id), { item: ContractActivationService.engineItem(row), churned: Boolean(toText(row.churn_date)) }])
	);
	const saved = Number(data.contract.billing_anchor_day);
	const anchor =
		Number.isInteger(saved) && saved >= 1 && saved <= 31 ? saved : (defaultAnchorDay([...items.values()].map((entry) => entry.item)) ?? 1);

	return { items, anchor };
}

@Injectable()
export class ContractInvoiceEditService {
	private readonly logger = new Logger(ContractInvoiceEditService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService
	) {}

	// ---------------------------------------------------------------- editar una Por Emitir (§3.4)

	async previewEdit(
		idOrNumber: string,
		invoiceId: string,
		dto: EditInvoiceDto,
		holdingId: string,
		today = new Date()
	): Promise<InvoiceEditPreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const ctx = await this.loadEditContext(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today), dto.client_entity_id ?? null);
		const plan = planInvoiceEdit(ctx, dto);

		if (plan.errors.length) throw validationException(plan.errors);
		const following = await this.planFollowing(this.dataSource, contract.id, holdingId, ctx, plan, dto, false);

		return this.editPreview(ctx, plan, following);
	}

	/**
	 * Aplica la edición en una transacción. 409 `blocked` con los bloqueos (y el preview); 409 `deviation_reason_required` si la edición deja
	 * la factura distinta al plan (desvío nuevo o cambiado) y no llegó `deviation { type, reason }`. Con motivo y desvío, una fila en
	 * `invoice_adjustments` (type, amount_diff = diferencia total en moneda de contrato, notes = motivo, adjusted_by).
	 */
	async edit(idOrNumber: string, invoiceId: string, dto: EditInvoiceDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const ctx = await this.loadEditContext(runner, contract.id, invoiceId, holdingId, isoDate(today), dto.client_entity_id ?? null, true);
			const plan = planInvoiceEdit(ctx, dto);

			if (plan.errors.length) throw validationException(plan.errors);
			const following = await this.planFollowing(runner, contract.id, holdingId, ctx, plan, dto, true);
			const preview = this.editPreview(ctx, plan, following);

			if (plan.blockers.length) throw this.blocked(plan.blockers, preview);
			if (deviationReasonMissing(plan, dto)) throw this.blocked([deviationReasonBlocker(plan.deviation)], preview);
			await this.writeEdit(runner, ctx, plan, holdingId);
			const followingUpdated = following.filter((entry) => entry.status === 'updated' && entry.write);

			for (const entry of followingUpdated) await this.writeRows(runner, entry.write!.invoice, entry.write!, holdingId);
			// Multimoneda: cada línea con la tasa de su par y encabezado = Σ líneas (también en las siguientes recompuestas por tramo).
			if (ctx.multicurrency)
				await revalueMulticurrencyInvoices(runner, holdingId, [ctx.invoice.id, ...followingUpdated.map((entry) => entry.write!.invoice.id)]);
			for (const price of plan.price_line_modes) {
				await runner.query(
					`UPDATE prices SET invoice_line_mode = $3, updated_at = now(), updated_by = $4
					WHERE id = $1 AND holding_id = $2 AND owner = 'contract' AND contract_id = $5`,
					[price.price_id, holdingId, price.mode, userId, contract.id]
				);
			}
			if (plan.rsm_from_month) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, plan.rsm_from_month]);
			const adjustmentId =
				dto.deviation && plan.deviation.has_deviation
					? await this.insertAdjustment(
							runner,
							ctx.invoice.id,
							holdingId,
							userId,
							dto.deviation.type,
							plan.deviation.total_diff,
							dto.deviation.reason
						)
					: null;
			const editId = randomUUID();
			const eventId = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.edit,
				title: `Factura ${ctx.invoice.invoice_number ?? ctx.invoice.period_start ?? ''} editada`.replace(/\s+/g, ' ').trim(),
				description: this.editSummary(plan),
				effective_date: plan.header.after.issue_date,
				invoice_id: ctx.invoice.id,
				metadata: {
					edit_id: editId,
					invoice_number: ctx.invoice.invoice_number,
					header: { before: plan.header.before, after: plan.header.after },
					lines: plan.lines
						.filter((line) => line.action !== 'unchanged')
						.map((line) => ({ id: line.id, action: line.action, before: line.before, after: line.after })),
					line_mode: preview.line_mode,
					deviation: plan.deviation,
					deviation_type: dto.deviation?.type ?? null,
					reason: dto.deviation?.reason ?? null,
					adjustment_id: adjustmentId,
					rsm_from_month: plan.rsm_from_month,
					confirm_manual_overwrite: dto.confirm_manual_overwrite === true,
					warnings: plan.warnings.map((warning) => warning.code),
				},
			});

			if (plan.no_charge) {
				await this.insertEvent(runner, contract.id, holdingId, userId, {
					type: plan.no_charge === 'becomes' ? INVOICE_EVENT_TYPES.no_charge : INVOICE_EVENT_TYPES.no_charge_reverted,
					title:
						plan.no_charge === 'becomes'
							? `Factura ${ctx.invoice.invoice_number ?? ctx.invoice.period_start ?? ''} sin cobro`.replace(/\s+/g, ' ').trim()
							: `Factura ${ctx.invoice.invoice_number ?? ctx.invoice.period_start ?? ''} vuelve a Por Emitir`
									.replace(/\s+/g, ' ')
									.trim(),
					description:
						plan.no_charge === 'becomes'
							? 'Todas las líneas quedaron en 0 al editar la factura: pasa a Cancelada sin cobro (las líneas se conservan)'
							: 'La factura sin cobro recuperó cantidad al editarla: vuelve a Por Emitir',
					effective_date: plan.header.after.issue_date,
					invoice_id: ctx.invoice.id,
					metadata: {
						reason: plan.no_charge === 'becomes' ? 'zero_edit' : 'edit',
						edit_id: editId,
						before: { status: plan.header.before.status, amount_contract_currency: plan.header.before.amount_contract_currency },
						after: { status: plan.header.after.status, amount_contract_currency: plan.header.after.amount_contract_currency },
						period: { start: ctx.invoice.period_start, end: ctx.invoice.period_end },
					},
				});
			}
			for (const entry of followingUpdated) {
				await this.insertEvent(runner, contract.id, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.edit,
					title: `Factura ${entry.invoice_number ?? entry.issue_date ?? ''}: presentación por tramo actualizada`
						.replace(/\s+/g, ' ')
						.trim(),
					description: `Presentación del ítem cambiada desde la factura ${ctx.invoice.invoice_number ?? ctx.invoice.id} (esta y las siguientes); total sin cambios`,
					effective_date: entry.issue_date,
					invoice_id: entry.invoice_id,
					metadata: {
						edit_id: editId,
						origin_invoice_id: ctx.invoice.id,
						line_mode: plan.line_mode.map(({ contract_item_id, mode, scope }) => ({ contract_item_id, mode, scope })),
						periods: entry.periods,
						skipped: entry.skipped,
					},
				});
			}

			return { preview, eventId, adjustmentId };
		});

		return {
			...result.preview,
			applied: true,
			event_id: result.eventId,
			adjustment_id: result.adjustmentId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		};
	}

	private editSummary(plan: EditPlan): string {
		const count = (action: string) => plan.lines.filter((line) => line.action === action).length;
		const parts = [
			count('update') ? `${count('update')} ${count('update') === 1 ? 'línea actualizada' : 'líneas actualizadas'}` : '',
			count('create') ? `${count('create')} ${count('create') === 1 ? 'nueva' : 'nuevas'}` : '',
			count('hide') ? `${count('hide')} ${count('hide') === 1 ? 'oculta (cantidad 0)' : 'ocultas (cantidad 0)'}` : '',
			count('remove') ? `${count('remove')} ${count('remove') === 1 ? 'fila recompuesta' : 'filas recompuestas'}` : '',
		].filter(Boolean);
		const before = plan.header.before;
		const after = plan.header.after;
		const total =
			before.amount_contract_currency !== after.amount_contract_currency
				? `neto ${before.amount_contract_currency} → ${after.amount_contract_currency} ${after.contract_currency ?? ''}`.trim()
				: '';
		const deviation = plan.deviation.has_deviation ? `desvío contra el plan ${plan.deviation.total_diff}` : '';

		return [parts.join(', ') || 'Encabezado actualizado', total, deviation].filter(Boolean).join('; ');
	}

	private editPreview(ctx: EditContext, plan: EditPlan, following: FollowingResult[]): InvoiceEditPreview {
		return {
			invoice: {
				id: ctx.invoice.id,
				invoice_number: ctx.invoice.invoice_number,
				status: ctx.invoice.status,
				before: plan.header.before,
				after: plan.header.after,
			},
			lines: plan.lines.map((line) => ({
				id: line.id,
				action: line.action,
				before: line.before,
				after: line.after,
				is_visible: line.is_visible,
			})),
			line_mode: plan.line_mode.map((mode) => ({
				...mode,
				following:
					mode.scope === 'invoice_and_following'
						? following
								.filter((entry) => (entry as FollowingResult & { item: string }).item === mode.contract_item_id)
								// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- lo que se escribe no va en la respuesta
								.map(({ write: _write, ...entry }) => {
									// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- clave interna
									const { item: _item, ...rest } = entry as typeof entry & { item: string };

									return rest;
								})
						: [],
			})),
			deviation: plan.deviation,
			revenue_effect: plan.revenue_effect,
			warnings: plan.warnings,
			blockers: plan.blockers,
			can_apply: plan.can_apply,
		};
	}

	/** `invoice_and_following`: recompone el ítem en las Por Emitir posteriores (salta bloqueadas y líneas manuales, e informa). */
	private async planFollowing(
		db: Queryable,
		contractId: string,
		holdingId: string,
		ctx: EditContext,
		plan: EditPlan,
		dto: EditInvoiceDto,
		lock: boolean
	): Promise<Array<FollowingResult & { item: string }>> {
		const requests = plan.line_mode.filter((mode) => mode.scope === 'invoice_and_following');

		if (!requests.length) return [];
		const target = ctx.invoice;
		const pending = (await this.invoices.loadPendingInvoices(db, contractId, holdingId, lock)).filter(
			(invoice) => invoice.id !== target.id && (invoice.issue_date ?? '9999-12-31') > (target.issue_date ?? '')
		);

		if (!pending.length) return [];
		const lines = await this.loadLines(
			db,
			pending.map((invoice) => invoice.id),
			holdingId,
			!!ctx.multicurrency
		);
		const results: Array<FollowingResult & { item: string }> = [];

		for (const request of requests) {
			for (const invoice of pending) {
				const rows = lines.get(invoice.id) ?? [];

				if (!rows.some((row) => row.contract_item_id === request.contract_item_id)) continue;
				const render: RenderInput = {
					template: ctx.template,
					contract_number: ctx.contract_number,
					client_name: invoice.legal_name ?? ctx.client_name,
					references: [],
					contract_currency: invoice.contract_currency,
					invoice_currency: invoice.invoice_currency,
					fx_rate: invoiceFx(invoice) === 1 ? null : invoice.fx_contract_to_invoice,
					max_chars: ctx.max_chars,
				};
				const taxRate = rows[0] ? this.taxRateOf(invoice) : 0;
				const { blockers, result } = planFollowingLineMode(invoice, rows, request.contract_item_id, request.mode, {
					tax_rate: taxRate,
					render,
					confirm_manual_overwrite: dto.confirm_manual_overwrite === true,
				});
				const base = {
					item: request.contract_item_id,
					invoice_id: invoice.id,
					invoice_number: invoice.invoice_number,
					issue_date: invoice.issue_date,
				};

				if (!result) {
					results.push({ ...base, status: 'skipped', reason: blockers[0]?.code ?? 'blocked', periods: [], skipped: [] });
					continue;
				}
				const changed = result.updates.length > 0 || result.creates.length > 0 || result.removes.length > 0;

				results.push({
					...base,
					status: changed ? 'updated' : result.skipped.length ? 'skipped' : 'unchanged',
					reason: changed ? null : (result.skipped[0]?.reason ?? null),
					periods: result.periods,
					skipped: result.skipped,
					write: changed ? { updates: result.updates, creates: result.creates, removes: result.removes, invoice } : undefined,
				});
			}
		}

		return results;
	}

	taxRateOf(invoice: ContractInvoiceRow): number {
		const raw = invoice.tax_rate;

		if (raw === null) return 0;

		return raw > 0 && raw <= 1 ? round2(raw * 100) : raw;
	}

	// ---------------------------------------------------------------- explicar un desvío heredado

	/** Registra el motivo de un desvío que la factura ya tiene (editada en el ERP, cuadres manuales): fila en `invoice_adjustments` + evento. */
	async explainDeviation(
		idOrNumber: string,
		invoiceId: string,
		dto: ExplainInvoiceDeviationDto,
		holdingId: string,
		authId: string,
		today = new Date()
	) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const ctx = await this.loadEditContext(runner, contract.id, invoiceId, holdingId, isoDate(today), null, true);
			const invoice = ctx.invoice;
			const blockers: InvoiceBlocker[] = [];

			if (isCreditNote(invoice.document_type) || invoice.document_type === 'ND')
				blockers.push({ code: 'credit_note', message: 'Las notas de crédito y débito no se concilian contra el plan', next_step: null });
			if (invoice.is_legacy)
				blockers.push({
					code: 'legacy_invoice',
					message: 'Es una factura importada (legacy): no se opera desde el contrato',
					next_step: null,
				});
			if (!invoice.is_active || invoice.status === 'Cancelada' || invoice.status === 'Anulada')
				blockers.push({ code: 'not_editable', message: 'La factura está cancelada o inactiva', next_step: null });
			const current = ctx.lines.map((row) => stateOf(row));
			const deviation = reconcileDeviation(ctx.plan, current, current, invoice.contract_currency);

			if (!blockers.length && !deviation.has_deviation)
				blockers.push({ code: 'no_deviation', message: 'La factura no se desvía del plan: no hay desvío que explicar', next_step: null });
			if (blockers.length) throw this.blocked(blockers, { invoice_id: invoice.id, deviation });
			const adjustmentId = await this.insertAdjustment(runner, invoice.id, holdingId, userId, dto.type, deviation.total_diff, dto.reason);
			const eventId = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.deviation,
				title: `Desvío de la factura ${invoice.invoice_number ?? invoice.period_start ?? ''} explicado`.replace(/\s+/g, ' ').trim(),
				description: `${dto.type}: ${dto.reason} (diferencia ${deviation.total_diff} ${invoice.contract_currency ?? ''})`.trim(),
				effective_date: invoice.issue_date,
				invoice_id: invoice.id,
				metadata: { deviation, deviation_type: dto.type, reason: dto.reason, adjustment_id: adjustmentId, inherited: true },
			});

			return { deviation: { ...deviation, inherited: true, changed: false }, adjustmentId, eventId };
		});

		return {
			invoice_id: invoiceId,
			deviation: result.deviation,
			adjustment_id: result.adjustmentId,
			event_id: result.eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		};
	}

	// ---------------------------------------------------------------- Por Emitir que se desvían del plan sin motivo

	/**
	 * `GET /contracts/:id/invoices/deviations`: Por Emitir activas del contrato cuyas líneas difieren del plan (conciliador) y que no tienen
	 * motivo registrado en `invoice_adjustments`. Corre el motor una vez por contrato (no es barato para la lista de alertas del 360).
	 */
	async deviations(idOrNumber: string, holdingId: string) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const invoices = await this.invoices.loadPendingInvoices(this.dataSource, contract.id, holdingId);

		if (!invoices.length) return { data: [], total: 0, invoices_vs_total: null };
		const ids = invoices.map((invoice) => invoice.id);
		const [data, lines, adjustments, invoiced] = await Promise.all([
			this.loadPlanData(this.dataSource, contract.id, holdingId),
			this.loadLines(this.dataSource, ids, holdingId),
			this.dataSource.query(LATEST_ADJUSTMENTS_SQL, [ids, holdingId]) as Promise<Row[]>,
			this.contracts.invoicedVsTotal(contract.id, holdingId),
		]);
		const explained = new Set(adjustments.filter((row) => toText(row.notes)?.trim()).map((row) => String(row.invoice_id)));
		const causes = deviationCauseContext(data);
		const result = [];

		for (const invoice of invoices) {
			if (explained.has(invoice.id)) continue;
			const invoiceLines = lines.get(invoice.id) ?? [];
			const current = invoiceLines.map((row) => stateOf(row));
			const deviation = reconcileDeviation(this.deviationPlan(data, invoice.id), current, current, invoice.contract_currency);

			if (!deviation.has_deviation) continue;
			const withCauses = withDeviationCauses(deviation, invoiceLines, causes);

			result.push({
				invoice_id: invoice.id,
				invoice_number: invoice.invoice_number,
				issue_date: invoice.issue_date,
				billing_period_start: invoice.period_start,
				billing_period_end: invoice.period_end,
				deviation: { ...withCauses.deviation, inherited: true, changed: false },
				cause: withCauses.cause,
			});
		}

		return { data: result, total: result.length, invoices_vs_total: invoicesVsTotalSummary(invoiced, result) };
	}

	// ---------------------------------------------------------------- masivo de encabezado

	async previewBulkEdit(idOrNumber: string, dto: BulkEditInvoicesDto, holdingId: string, today = new Date()) {
		this.validateBulk(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const plans = await this.planBulk(this.dataSource, contract.id, holdingId, dto, isoDate(today), false);

		return this.bulkPreview(plans);
	}

	/** Aplica los cambios de encabezado a las Por Emitir que pasan; las bloqueadas se informan en `skipped`. Un INVOICE_EDITED por factura con `bulk_id`. */
	async bulkEdit(idOrNumber: string, dto: BulkEditInvoicesDto, holdingId: string, authId: string, today = new Date()) {
		this.validateBulk(dto);
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const plans = await this.planBulk(runner, contract.id, holdingId, dto, isoDate(today), true);
			const preview = this.bulkPreview(plans);

			if (!preview.can_apply)
				throw this.blocked(
					plans.flatMap((plan) => plan.blockers),
					preview
				);
			const bulkId = randomUUID();
			const eventIds: string[] = [];

			for (const plan of plans) {
				if (plan.blockers.length) continue;
				await this.writeHeader(runner, plan.id, holdingId, plan.after, PENDING_STATUS);
				for (const line of plan.lines) await this.updateLine(runner, plan.id, line.id, line.after, holdingId);
				await refreshInvoiceSystemAmounts(runner, holdingId, [plan.id]);
				// Multimoneda: IVA nuevo revalorizado por par (el plan ya lo trae; esto deja también el FX del encabezado).
				if (plan.lines.some((line) => line.after.currency !== undefined)) await revalueMulticurrencyInvoices(runner, holdingId, [plan.id]);
				eventIds.push(
					await this.insertEvent(runner, contract.id, holdingId, userId, {
						type: INVOICE_EVENT_TYPES.edit,
						title: `Factura ${plan.invoice_number ?? plan.before.issue_date ?? ''} editada (masivo)`.replace(/\s+/g, ' ').trim(),
						description: this.bulkSummary(plan),
						effective_date: plan.after.issue_date,
						invoice_id: plan.id,
						metadata: {
							bulk_id: bulkId,
							invoice_number: plan.invoice_number,
							header: { before: plan.before, after: plan.after },
							lines: plan.lines.map((line) => ({ id: line.id, action: 'update', before: line.before, after: line.after })),
							warnings: plan.warnings.map((warning) => warning.code),
						},
					})
				);
			}

			return { ...preview, applied: true, bulk_id: bulkId, event_ids: eventIds };
		});
	}

	private validateBulk(dto: BulkEditInvoicesDto) {
		if (
			dto.invoice_terms_and_conditions === undefined &&
			!dto.client_entity_id &&
			(dto.auto_invoice === undefined || dto.auto_invoice === null)
		) {
			throw validationException([
				{ field: 'invoice_ids', message: 'Indica qué cambiar: términos y condiciones, receptor o emisión automática' },
			]);
		}
	}

	private bulkSummary(plan: BulkHeaderPlanItem): string {
		const changes = [
			plan.before.invoice_terms_and_conditions !== plan.after.invoice_terms_and_conditions ? 'términos y condiciones' : '',
			plan.before.client_entity_id !== plan.after.client_entity_id
				? `receptor ${plan.after.legal_name ?? plan.after.client_entity_id ?? ''}`.trim()
				: '',
			plan.before.auto_invoice !== plan.after.auto_invoice ? `emisión automática ${plan.after.auto_invoice ? 'activada' : 'desactivada'}` : '',
		].filter(Boolean);

		return `Cambio masivo de ${changes.join(', ') || 'encabezado'}`;
	}

	private async planBulk(
		db: Queryable,
		contractId: string,
		holdingId: string,
		dto: BulkEditInvoicesDto,
		today: string,
		lock: boolean
	): Promise<BulkHeaderPlanItem[]> {
		const invoices = await this.invoices.loadInvoicesByIds(db, contractId, holdingId, dto.invoice_ids, lock);

		return await this.planBulkFor(db, contractId, holdingId, invoices, dto, today);
	}

	private async planBulkFor(
		db: Queryable,
		contractId: string,
		holdingId: string,
		invoices: ContractInvoiceRow[],
		dto: Omit<BulkEditInvoicesDto, 'invoice_ids'>,
		today: string
	): Promise<BulkHeaderPlanItem[]> {
		if (!invoices.length) return [];
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const ids = invoices.map((invoice) => invoice.id);
		const [[contractRow], extras, lines, receiverRows] = await Promise.all([
			db.query(CONTRACT_SQL, [contractId, holdingId]) as Promise<Row[]>,
			db.query(HEADER_EXTRA_SQL, [ids, holdingId]) as Promise<Row[]>,
			this.loadLines(db, ids, holdingId),
			dto.client_entity_id
				? (db.query(RECEIVER_SQL, [dto.client_entity_id, holdingId, contractId]) as Promise<Row[]>)
				: Promise.resolve([] as Row[]),
		]);
		const extraById = new Map(extras.map((row) => [String(row.id), row]));
		const receiver = this.receiverOf(receiverRows[0]);
		// Multimoneda: con el flag, las líneas traen su moneda y tasa y el IVA nuevo se revaloriza por par.
		const multicurrency = contractRow?.requires_multicurrency_billing === true ? await loadPairRateContext(db, contractId, holdingId) : null;
		const pairLines = multicurrency ? await this.loadLines(db, ids, holdingId, true) : lines;
		const plans = invoices.map((invoice) =>
			planBulkHeader(
				{
					invoice: this.editInvoice(invoice, extraById.get(invoice.id)),
					context,
					company_tax_rate: (contractRow?.company_tax_rate as number | string | null) ?? null,
					tax_document: taxDocumentOf(contractRow),
					receiver,
					lines: pairLines.get(invoice.id) ?? [],
					multicurrency,
				},
				dto
			)
		);
		const errors = plans.flatMap((plan) => plan.errors);

		if (errors.length) throw validationException([errors[0]]);

		return plans;
	}

	// ---------------------------------------------------------------- términos desde la modificación del contrato

	/**
	 * `billing_conditions` con `apply_to_pending` (`contract-changes.service.ts`): Por Emitir activas del contrato con emisión ≥ `fromDate`,
	 * con las mismas reglas y bloqueos que el masivo de encabezado (ERP borrador, unificada, legacy, NC/ND, período cerrado). Las que ya
	 * tienen ese texto no se listan (no hay nada que cambiar). `lock` = `FOR UPDATE` dentro de la transacción del cambio.
	 */
	async planPendingTerms(
		db: Queryable,
		contractId: string,
		holdingId: string,
		text: string | null,
		fromDate: string,
		today: string,
		lock: boolean
	): Promise<PendingTermsPlan> {
		const pending = (await this.invoices.loadPendingInvoices(db, contractId, holdingId, lock)).filter(
			(invoice) => (invoice.issue_date ?? '') >= fromDate
		);
		const plans = (await this.planBulkFor(db, contractId, holdingId, pending, { invoice_terms_and_conditions: text }, today)).filter(
			(plan) => !(plan.blockers.length === 1 && plan.blockers[0].code === 'no_change')
		);
		const applicable = plans.filter((plan) => plan.blockers.length === 0);

		return {
			text,
			plans: applicable,
			updated: applicable.map((plan) => plan.id),
			skipped: plans
				.filter((plan) => plan.blockers.length)
				.map((plan) => {
					const blocker = plan.blockers.find((item) => item.code !== 'no_change') ?? plan.blockers[0];

					return { invoice_id: plan.id, invoice_number: plan.invoice_number, reason: blocker.code, message: blocker.message };
				}),
		};
	}

	/**
	 * Escribe solo `invoice_terms_and_conditions` en las Por Emitir aplicables (el resto del encabezado puede haberlo cambiado la misma
	 * modificación) y un `INVOICE_EDITED` por factura con el `bulk_id` común. Corre dentro de la transacción del cambio (con `setApiWriter`).
	 */
	async applyPendingTerms(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		plan: PendingTermsPlan,
		bulkId: string,
		effectiveDate: string
	): Promise<string[]> {
		if (!plan.plans.length) return [];
		await runner.query(
			`UPDATE invoices SET invoice_terms_and_conditions = $3 WHERE id = ANY($1::uuid[]) AND holding_id = $2 AND status = '${PENDING_STATUS}'`,
			[plan.updated, holdingId, plan.text]
		);
		const eventIds: string[] = [];

		for (const item of plan.plans) {
			eventIds.push(
				await this.insertEvent(runner, contractId, holdingId, userId, {
					type: INVOICE_EVENT_TYPES.edit,
					title: `Factura ${item.invoice_number ?? item.before.issue_date ?? ''} editada (masivo)`.replace(/\s+/g, ' ').trim(),
					description: 'Cambio masivo de términos y condiciones (modificación del contrato)',
					effective_date: item.before.issue_date ?? effectiveDate,
					invoice_id: item.id,
					metadata: {
						source: 'contract_change',
						bulk_id: bulkId,
						invoice_number: item.invoice_number,
						header: {
							before: { invoice_terms_and_conditions: item.before.invoice_terms_and_conditions },
							after: { invoice_terms_and_conditions: plan.text },
						},
						lines: [],
						warnings: item.warnings.map((warning) => warning.code),
					},
				})
			);
		}

		return eventIds;
	}

	private bulkPreview(plans: BulkHeaderPlanItem[]) {
		const applicable = plans.filter((plan) => plan.blockers.length === 0);

		return {
			invoices: plans.map((plan) => ({
				id: plan.id,
				invoice_number: plan.invoice_number,
				blockers: plan.blockers,
				warnings: plan.warnings,
				before: plan.before,
				after: plan.after,
				lines_retaxed: plan.lines.length,
			})),
			updated: applicable.map((plan) => plan.id),
			skipped: plans
				.filter((plan) => plan.blockers.length)
				.map((plan) => ({ id: plan.id, invoice_number: plan.invoice_number, blockers: plan.blockers })),
			warnings: plans.flatMap((plan) => plan.warnings.map((warning) => ({ ...warning, invoice_id: plan.id }))),
			can_apply: applicable.length > 0,
		};
	}

	// ---------------------------------------------------------------- escritura

	private async writeEdit(runner: QueryRunner, ctx: EditContext, plan: EditPlan, holdingId: string) {
		// Encabezado primero: las líneas nuevas toman estado y fecha de emisión del encabezado ya actualizado.
		await this.writeHeader(runner, ctx.invoice.id, holdingId, plan.header.after, ctx.invoice.status ?? PENDING_STATUS);
		await this.writeRows(runner, ctx.invoice, plan.write, holdingId);
		await refreshInvoiceSystemAmounts(runner, holdingId, [ctx.invoice.id]);
	}

	/**
	 * Encabezado completo (los valores sin cambio se reescriben iguales). `status` solo cambia por sin cobro (Por Emitir ↔ Cancelada); la
	 * condición `status = expected` evita pisar una factura que otro proceso cambió. `sync_invoice_items_on_invoice_update` lleva estado y
	 * fecha a las líneas. Nunca escribe `invoices.updated_at` (no existe).
	 */
	private async writeHeader(runner: QueryRunner, invoiceId: string, holdingId: string, after: EditPlan['header']['after'], expectedStatus: string) {
		await runner.query(
			`UPDATE invoices SET issue_date = $3::date, scheduled_at = $4::date, original_issue_date = $5::date, due_date = $6::date,
				client_entity_id = $7, client_tax_id = $8, export_type = $9, tax_rate = $10, invoice_terms_and_conditions = $11, notes = $12,
				auto_invoice = $13, amount_contract_currency = $14, vat = $15, amount_invoice_currency = $16, total_invoice_currency = $17,
				status = $18, nc_revenue_treatment = $19
			WHERE id = $1 AND holding_id = $2 AND status = $20`,
			[
				invoiceId,
				holdingId,
				after.issue_date,
				after.scheduled_at,
				after.original_issue_date,
				after.due_date,
				after.client_entity_id,
				after.client_tax_id,
				after.export_type,
				after.tax_rate,
				after.invoice_terms_and_conditions,
				after.notes,
				after.auto_invoice,
				after.amount_contract_currency,
				after.vat,
				after.amount_invoice_currency,
				after.total_invoice_currency,
				after.status ?? expectedStatus,
				after.nc_revenue_treatment,
				expectedStatus,
			]
		);
	}

	private async writeRows(
		runner: QueryRunner,
		invoice: Pick<ContractInvoiceRow, 'id' | 'contract_currency' | 'invoice_currency' | 'fx_contract_to_invoice' | 'fx_rate_source'>,
		rows: { updates: Array<{ id: string; after: LineState }>; creates: LineState[]; removes: string[] },
		holdingId: string
	) {
		if (rows.removes.length) {
			// Solo la recomposición por tramo quita filas (las del mismo ítem y período, reemplazadas por una sola con el mismo total).
			await runner.query(`DELETE FROM invoice_items WHERE id = ANY($1::uuid[]) AND invoice_id = $2 AND holding_id = $3`, [
				rows.removes,
				invoice.id,
				holdingId,
			]);
		}
		for (const update of rows.updates) await this.updateLine(runner, invoice.id, update.id, update.after, holdingId);
		const fx = invoiceFx(invoice as ContractInvoiceRow);

		for (const state of rows.creates) {
			await runner.query(
				`INSERT INTO invoice_items (
					invoice_id, contract_item_id, holding_id, contract_id, product_id, description, description_locked, quantity, unit_of_measure, discount_pct,
					unit_price_contract_currency, unit_price_invoice_currency, subtotal_contract_currency, subtotal_invoice_currency,
					tax_amount_contract_currency, tax_amount_invoice_currency, total_contract_currency, total_invoice_currency,
					contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date, status, issue_date,
					billing_period_start, billing_period_end, quantity_source, pricing_breakdown
				) VALUES (
					$1, $2::uuid, $3, (SELECT h.contract_id FROM invoices h WHERE h.id = $1),
					COALESCE((SELECT ci.product_id FROM contract_items ci WHERE ci.id = $2::uuid), $4), $5, $6, $7, $8, $9,
					$10, $11, $12, $13,
					$14, $15, $16, $17,
					$18, $19, $20, $21, CASE WHEN $20::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
					(SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1),
					$22::date, $23::date, $24, $25::jsonb
				)`,
				[
					invoice.id,
					state.contract_item_id,
					holdingId,
					state.product_id,
					state.description,
					state.description_locked,
					state.quantity,
					state.unit_of_measure?.trim() || 'UND',
					state.discount_pct,
					state.unit_price_contract_currency,
					state.unit_price_invoice_currency,
					state.subtotal_contract_currency,
					state.subtotal_invoice_currency,
					state.tax_contract_currency,
					state.tax_invoice_currency,
					state.total_contract_currency,
					state.total_invoice_currency,
					// Multimoneda: la línea nace con la moneda de su ítem y la tasa de su par (el plan ya la valorizó); si no, la del encabezado.
					state.currency === undefined ? invoice.contract_currency : (state.currency ?? invoice.contract_currency),
					invoice.invoice_currency,
					state.currency === undefined ? fx : (state.fx ?? null),
					state.currency === undefined
						? fx === null
							? null
							: (invoice.fx_rate_source ?? EDIT_FX_RATE_SOURCE)
						: state.fx === null || state.fx === undefined
							? null
							: (state.fx_rate_source ?? EDIT_FX_RATE_SOURCE),
					state.billing_period_start,
					state.billing_period_end,
					state.quantity_source,
					state.pricing_breakdown ? JSON.stringify(state.pricing_breakdown) : null,
				]
			);
		}
	}

	private async updateLine(runner: QueryRunner, invoiceId: string, lineId: string, after: LineState, holdingId: string) {
		if (after.currency !== undefined) {
			// Multimoneda: además de los montos, la moneda de la línea (= del ítem) y la tasa y origen de su par.
			await runner.query(
				`UPDATE invoice_items SET contract_currency = COALESCE($4, contract_currency), fx_contract_to_invoice = $5::numeric,
					fx_rate_source = CASE WHEN $5::numeric IS NULL THEN NULL ELSE $6 END,
					fx_rate_date = CASE WHEN $5::numeric IS NULL THEN NULL WHEN fx_contract_to_invoice IS NOT DISTINCT FROM $5::numeric THEN fx_rate_date ELSE CURRENT_DATE END
				WHERE id = $1 AND invoice_id = $2 AND holding_id = $3`,
				[lineId, invoiceId, holdingId, after.currency, after.fx ?? null, after.fx_rate_source ?? EDIT_FX_RATE_SOURCE]
			);
		}
		await runner.query(
			`UPDATE invoice_items SET description = $4, description_locked = $5, quantity = $6, discount_pct = $7,
				unit_price_contract_currency = $8, subtotal_contract_currency = $9, tax_amount_contract_currency = $10, total_contract_currency = $11,
				unit_price_invoice_currency = $12, subtotal_invoice_currency = $13, tax_amount_invoice_currency = $14, total_invoice_currency = $15,
				billing_period_start = $16::date, billing_period_end = $17::date, quantity_source = $18, pricing_breakdown = $19::jsonb, updated_at = now()
			WHERE id = $1 AND invoice_id = $2 AND holding_id = $3`,
			[
				lineId,
				invoiceId,
				holdingId,
				after.description,
				after.description_locked,
				after.quantity,
				after.discount_pct,
				after.unit_price_contract_currency,
				after.subtotal_contract_currency,
				after.tax_contract_currency,
				after.total_contract_currency,
				after.unit_price_invoice_currency,
				after.subtotal_invoice_currency,
				after.tax_invoice_currency,
				after.total_invoice_currency,
				after.billing_period_start,
				after.billing_period_end,
				after.quantity_source,
				after.pricing_breakdown ? JSON.stringify(after.pricing_breakdown) : null,
			]
		);
	}

	private async insertAdjustment(
		runner: QueryRunner,
		invoiceId: string,
		holdingId: string,
		userId: string,
		type: string,
		amountDiff: number,
		reason: string
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, notes, adjusted_by)
			VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
			[invoiceId, holdingId, type, round2(amountDiff), reason.trim(), userId]
		)) as Row[];

		return String(row.id);
	}

	private async insertEvent(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		event: {
			type: string;
			title: string;
			description: string;
			effective_date: string | null;
			invoice_id: string;
			metadata: Record<string, unknown>;
		}
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
					`Edición de facturas del contrato ${contractId} no aplicada: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			throw error;
		} finally {
			await runner.release();
		}
	}

	private blocked(blockers: InvoiceBlocker[], preview: unknown): ConflictException {
		const reason = blockers.length === 1 && blockers[0].code === 'deviation_reason_required';

		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: reason ? 'deviation_reason_required' : 'blocked',
			blockers,
			preview,
		});
	}

	// ---------------------------------------------------------------- carga

	/** Todo lo que necesita el plan de edición: factura (con `FOR UPDATE OF i` si `lock`), líneas, ítems, plan del motor y otras facturas. */
	async loadEditContext(
		db: Queryable,
		contractId: string,
		invoiceId: string,
		holdingId: string,
		today: string,
		receiverId: string | null,
		lock = false
	): Promise<EditContext> {
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const invoice = await this.invoices.loadInvoice(db, contractId, invoiceId, holdingId, lock);
		const [[extra], data, lines, referenceRows, receiverRows] = await Promise.all([
			db.query(HEADER_EXTRA_SQL, [[invoice.id], holdingId]) as Promise<Row[]>,
			this.loadPlanData(db, contractId, holdingId),
			this.loadLines(db, [invoice.id], holdingId),
			db.query(REFERENCES_SQL, [invoice.id, holdingId]) as Promise<Row[]>,
			receiverId ? (db.query(RECEIVER_SQL, [receiverId, holdingId, contractId]) as Promise<Row[]>) : Promise.resolve([] as Row[]),
		]);
		const contract = data.contract;
		// Multimoneda (spec-multimoneda §4): con el flag, contexto por par y líneas con su moneda, tasa y origen.
		const multicurrency = contract.requires_multicurrency_billing === true ? await loadPairRateContext(db, contractId, holdingId) : null;
		const pairLines = multicurrency ? await this.loadLines(db, [invoice.id], holdingId, true) : lines;
		const references: DescriptionReference[] = referenceRows
			.map((ref) => ({ kind: referenceKind(toText(ref.type), toText(ref.name)), code: toText(ref.code) ?? '' }))
			.filter((ref) => ref.code.trim());

		return {
			invoice: this.editInvoice(invoice, extra),
			context,
			company_tax_rate: (contract.company_tax_rate as number | string | null) ?? null,
			tax_document: taxDocumentOf(contract),
			contract_number: toText(contract.contract_number),
			client_name: invoice.legal_name ?? toText(contract.entity_legal_name),
			template: parseStoredTemplate(contract.invoice_description_template),
			max_chars: resolveDescriptionMaxChars({
				tax_document_type_id: toText(contract.tax_document_type_id),
				own_max_chars: contract.own_description_max_chars as number | null,
				company_country: toText(contract.company_country),
				document_type: toText(contract.document_type),
				limits: parseJson<DescriptionLimitRow[]>(contract.description_limits),
			}),
			lines: pairLines.get(invoice.id) ?? [],
			items: new Map(data.items.map((row) => [String(row.id), this.itemOf(row)])),
			issued_periods: this.issuedPeriods(data.contract_lines),
			receiver: this.receiverOf(receiverRows[0]),
			references,
			plan: this.deviationPlan(data, invoice.id),
			multicurrency,
		};
	}

	async loadPlanData(db: Queryable, contractId: string, holdingId: string): Promise<ContractPlanData> {
		const [[contract], items, contractLines] = await Promise.all([
			db.query(CONTRACT_SQL, [contractId, holdingId]) as Promise<Row[]>,
			db.query(ITEMS_SQL, [contractId, holdingId]) as Promise<Row[]>,
			db.query(CONTRACT_LINES_SQL, [contractId, holdingId]) as Promise<Row[]>,
		]);

		return { contract: contract ?? {}, items, contract_lines: contractLines };
	}

	/**
	 * Lo que el plan espera por ítem y período: el motor de facturación v2 con los ítems vigentes del contrato (fin recortado a la baja si
	 * tiene `churn_date`) y sus consumos, más lo que ya llevan las demás facturas vigentes del contrato para el mismo ítem y período.
	 */
	deviationPlan(data: ContractPlanData, invoiceId: string): DeviationPlan {
		const contract = data.contract;
		const expected = new Map<string, number>();
		const others = new Map<string, number>();
		const knownItems = new Set<string>();
		const productNames = new Map<string, string | null>(data.items.map((row) => [String(row.id), toText(row.product_name)]));

		if (data.items.length) {
			const anchor = Number(contract.billing_anchor_day);
			const engine = generateInvoices({
				contract: {
					billing_anchor_day: Number.isInteger(anchor) && anchor >= 1 && anchor <= 31 ? anchor : null,
					group_invoices_by_period: contract.group_invoices_by_period !== false,
					invoice_currency: toText(contract.invoice_currency),
					contract_currency: toText(contract.contract_currency) ?? '',
					fx_invoice_policy: toText(contract.fx_invoice_policy),
					payment_terms:
						cleanPaymentTerms(parseJson(contract.payment_terms)) ?? cleanPaymentTerms(parseJson(contract.entity_payment_terms)),
					fixed_invoice_rates: [],
					document_type: toText(contract.document_type),
					company: { country: toText(contract.company_country), tax_rate: contract.company_tax_rate as number | string | null },
					tax_document: taxDocumentOf(contract),
					entity_country: toText(contract.entity_country),
				},
				items: data.items.map((row) => {
					const churn = toText(row.churn_date);
					const end = toText(row.end_date);
					const cut = churn ? addDays(churn.slice(0, 10), -1) : null;

					return ContractActivationService.engineItem(cut && (!end || cut < end) ? { ...row, end_date: cut } : row);
				}),
			});

			for (const item of engine.items) knownItems.add(item.item_key);
			for (const invoice of engine.invoices) {
				for (const line of invoice.lines) {
					const key = deviationKey(line.item_key, line.billing_period_start);

					expected.set(key, round2((expected.get(key) ?? 0) + line.subtotal));
				}
			}
		}
		for (const row of data.contract_lines) {
			if (String(row.invoice_id) === invoiceId) continue;
			const start = toText(row.billing_period_start);

			if (!start || !row.contract_item_id) continue;
			const key = deviationKey(String(row.contract_item_id), start.slice(0, 10));

			others.set(key, round2((others.get(key) ?? 0) + toNumber(row.subtotal_contract_currency)));
		}

		return { expected, known_items: knownItems, others, product_names: productNames };
	}

	issuedPeriods(rows: Row[]): IssuedPeriod[] {
		return rows
			.filter(
				(row) =>
					ISSUED_INVOICE_STATUSES.includes(toText(row.status) ?? '') &&
					!isCreditNote(toText(row.document_type)) &&
					toText(row.document_type) !== 'ND' &&
					row.cancelled_by_credit_note !== true &&
					row.billing_period_start &&
					row.contract_item_id
			)
			.map((row) => ({
				contract_item_id: String(row.contract_item_id),
				billing_period_start: String(row.billing_period_start).slice(0, 10),
				billing_period_end: String(row.billing_period_end ?? row.billing_period_start).slice(0, 10),
				invoice_id: String(row.invoice_id),
				invoice_number: toText(row.invoice_number),
			}));
	}

	/** Líneas por factura. `pairs` (solo contratos multimoneda): cada línea trae además su moneda, su tasa y el origen de la tasa. */
	async loadLines(db: Queryable, invoiceIds: string[], holdingId: string, pairs = false): Promise<Map<string, EditLineRow[]>> {
		const rows = (await db.query(LINES_SQL, [invoiceIds, holdingId])) as Row[];
		const byInvoice = new Map<string, EditLineRow[]>();

		for (const row of rows) {
			const invoiceId = String(row.invoice_id);
			const line = this.lineOf(row);

			byInvoice.set(invoiceId, [
				...(byInvoice.get(invoiceId) ?? []),
				pairs
					? {
							...line,
							currency: toText(row.line_currency),
							fx: toNullableNumber(row.line_fx),
							fx_rate_source: toText(row.line_fx_rate_source),
						}
					: line,
			]);
		}

		return byInvoice;
	}

	private lineOf(row: Row): EditLineRow {
		return {
			id: String(row.id),
			contract_item_id: toText(row.contract_item_id),
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			account: toText(row.account),
			description: toText(row.description),
			description_locked: row.description_locked === true,
			quantity: toNumber(row.quantity),
			unit_of_measure: toText(row.unit_of_measure),
			discount_pct: toNumber(row.discount_pct),
			unit_price: toNumber(row.unit_price_contract_currency),
			subtotal: toNumber(row.subtotal_contract_currency),
			tax_amount: toNumber(row.tax_amount_contract_currency),
			total: toNumber(row.total_contract_currency),
			unit_price_invoice: toNullableNumber(row.unit_price_invoice_currency),
			subtotal_invoice: toNullableNumber(row.subtotal_invoice_currency),
			tax_amount_invoice: toNullableNumber(row.tax_amount_invoice_currency),
			total_invoice: toNullableNumber(row.total_invoice_currency),
			billing_period_start: toText(row.billing_period_start)?.slice(0, 10) ?? null,
			billing_period_end: toText(row.billing_period_end)?.slice(0, 10) ?? null,
			quantity_source: toText(row.quantity_source),
			pricing_breakdown: parseJson<PricedSubline[]>(row.pricing_breakdown),
			visible_line_id: toText(row.visible_line_id),
		};
	}

	itemOf(row: Row): EditItem {
		return {
			id: String(row.id),
			product_id: toText(row.product_id),
			product_name: toText(row.product_name),
			account: toText(row.account),
			unit_of_measure: toText(row.unit_of_measure),
			price: priceSpecFromRow(row),
			price_id: toText(row.price_id),
			price_owner: toText(row.price_owner),
			start_date: toText(row.start_date)?.slice(0, 10) ?? null,
			end_date: toText(row.end_date)?.slice(0, 10) ?? null,
			churn_date: toText(row.churn_date)?.slice(0, 10) ?? null,
			term_months: toNullableNumber(row.term_months),
		};
	}

	private receiverOf(row: Row | undefined): ReceiverRow | null {
		if (!row) return null;

		return {
			id: String(row.id),
			legal_name: toText(row.legal_name),
			tax_id: toText(row.tax_id),
			country: toText(row.country),
			belongs_to_client: row.belongs === true,
		};
	}

	private editInvoice(invoice: ContractInvoiceRow, extra: Row | undefined): EditInvoiceRow {
		return {
			...invoice,
			client_tax_id: toText(extra?.client_tax_id),
			export_type: toNullableNumber(extra?.export_type),
			invoice_terms_and_conditions: toText(extra?.invoice_terms_and_conditions),
			notes: toText(extra?.notes),
			nc_revenue_treatment: toText(extra?.nc_revenue_treatment),
		};
	}
}
