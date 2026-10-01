import { randomUUID } from 'crypto';

import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { invoiceTermsSql, refreshInvoiceSystemAmounts } from './api-written-fields';
import { type FxPeriodRate, suggestDocumentType } from './billing-engine';
import { isCreditNote } from './contract-360';
import { resolveUserId } from './contract-drafts.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { type ContractInvoiceRow, INVOICE_EVENT_TYPES, type InvoiceBlocker } from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService } from './contracts.service';
import { parseStoredTemplate } from './invoice-description';
import { type LineState, taxRateForDocument } from './invoice-edit';
import {
	type NewInvoiceRules,
	type OtherContractLine,
	planReorganize,
	REORGANIZE_FX_RATE_SOURCE,
	REORGANIZE_SPLIT_REASON,
	type ReorganizeContext,
	type ReorganizeInput,
	type ReorganizePlan,
	scheduleBoard,
} from './invoice-reorganize';
import { loadPairRateContext, revalueMulticurrencyInvoices } from './multicurrency-invoices';
import { type DescriptionLimitRow, resolveDescriptionMaxChars } from './tax-document-types';

import type { ReorganizeInvoicesDto } from './dtos/contract-invoice-reorganize.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
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

/** Lo que el generador usa para el encabezado de una factura nueva (mismas fuentes que la activación), sin mirar otras facturas. */
export const GENERATOR_SQL = `SELECT c.client_entity_id, c.document_type, c.invoice_currency, c.contract_currency, c.fx_invoice_policy,
		co.country AS company_country, co.tax_rate AS company_tax_rate, ce.country AS entity_country, ce.legal_name AS entity_legal_name,
		(SELECT COALESCE(jsonb_agg(jsonb_build_object(
				'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
				'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
			FROM contract_fx_period_rates r
			WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'invoice') AS fx_invoice_rates
	FROM contracts c
	LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
	LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id
	WHERE c.id = $1 AND c.holding_id = $2 AND c.deleted_at IS NULL`;

/** Líneas nombradas en las operaciones que son de facturas del contrato que NO están Por Emitir activas. */
const FOREIGN_LINES_SQL = `SELECT ii.id, ii.invoice_id, i.status
	FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
	WHERE ii.id = ANY($1::uuid[]) AND i.contract_id = $2 AND i.holding_id = $3`;

export type ReorganizePreview = Omit<ReorganizePlan, 'errors' | 'write' | 'adjustments'>;

/**
 * El descuento puntual de una factura que pasa (en parte) a otra lleva su fila de desvío (`invoice_adjustments` de tipo `discount`, la que
 * registró el editor al agregarlo): con toda la parte (`share` = 1) se mueve; con una parte se duplica en el destino por `amount_diff × share`
 * y el origen queda con el resto. La usan Reorganizar y facturar por OC (saldo).
 */
export async function moveOneOffAdjustments(
	runner: Pick<QueryRunner, 'query'>,
	holdingId: string,
	fromInvoiceId: string,
	toInvoiceId: string,
	share: number
): Promise<void> {
	if (!(share > 0) || fromInvoiceId === toInvoiceId) return;
	if (share >= 1) {
		await runner.query(`UPDATE invoice_adjustments SET invoice_id = $3 WHERE invoice_id = $1 AND holding_id = $2 AND type = 'discount'`, [
			fromInvoiceId,
			holdingId,
			toInvoiceId,
		]);

		return;
	}
	await runner.query(
		`INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, notes, adjusted_by)
		SELECT $3, a.holding_id, a.type, ROUND(a.amount_diff * $4::numeric, 2), a.notes, a.adjusted_by
		FROM invoice_adjustments a WHERE a.invoice_id = $1 AND a.holding_id = $2 AND a.type = 'discount'`,
		[fromInvoiceId, holdingId, toInvoiceId, share]
	);
	await runner.query(
		`UPDATE invoice_adjustments SET amount_diff = amount_diff - ROUND(amount_diff * $3::numeric, 2)
		WHERE invoice_id = $1 AND holding_id = $2 AND type = 'discount'`,
		[fromInvoiceId, holdingId, share]
	);
}

/**
 * Facturas en el Contrato 360, etapa 5 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.5): **Reorganizar el cronograma** (reemplaza
 * Reestructurar / `invoice_reschedule_items`, consolidar y desconsolidar de un contrato). Preview y aplicar comparten el plan puro
 * (`invoice-reorganize.ts`); aplicar va en **una transacción** con `setApiWriter` como primera sentencia, el contrato y sus Por Emitir
 * bloqueados (`FOR UPDATE`), facturas nuevas desde las reglas del generador (`split_reason = 'reorganize'`, `split_from_invoice_id` = la de
 * origen), líneas movidas por UPDATE (conservan su id), divididas por UPDATE + INSERT, absorbidas por DELETE, facturas vacías → `Cancelada`
 * (nunca DELETE), encabezado = Σ líneas en ambas monedas, `refreshInvoiceSystemAmounts`, devengo solo si cambió el período de alguna línea
 * y un evento `INVOICES_REORGANIZED`. Nunca escribe `invoices.updated_at`. También sirve el tablero de lectura (`schedule-lines`).
 */
@Injectable()
export class ContractInvoiceReorganizeService {
	private readonly logger = new Logger(ContractInvoiceReorganizeService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService,
		private readonly edit: ContractInvoiceEditService
	) {}

	// ---------------------------------------------------------------- tablero (lectura)

	/**
	 * `GET /contracts/:id/invoices/schedule-lines`: las Por Emitir activas con sus líneas (ítem, período, montos, grupo por tramo, marcas
	 * manual/protegida/consumo), ordenadas por período, y los períodos ya emitidos por ítem (anclas). Sin motor: 4 consultas.
	 */
	async scheduleLines(idOrNumber: string, holdingId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const [context, pending, data] = await Promise.all([
			this.invoices.loadContext(this.dataSource, contract.id, holdingId, isoDate(today)),
			this.invoices.loadPendingInvoices(this.dataSource, contract.id, holdingId),
			this.edit.loadPlanData(this.dataSource, contract.id, holdingId),
		]);
		const lines = pending.length
			? await this.edit.loadLines(
					this.dataSource,
					pending.map((invoice) => invoice.id),
					holdingId
				)
			: new Map();
		const items = new Map(data.items.map((row) => [String(row.id), this.edit.itemOf(row)]));
		const invoices = scheduleBoard(pending, lines, items, context);

		return {
			contract_id: contract.id,
			cutoff_date: context.cutoff_date,
			invoices,
			issued_periods: this.edit.issuedPeriods(data.contract_lines),
			items: [...items.values()].map((item) => ({
				id: item.id,
				product_name: item.product_name,
				account: item.account,
				start_date: item.start_date,
				end_date: item.end_date,
				churn_date: item.churn_date,
			})),
			total: invoices.length,
		};
	}

	// ---------------------------------------------------------------- preview y aplicar

	async preview(idOrNumber: string, dto: ReorganizeInvoicesDto, holdingId: string, today = new Date()): Promise<ReorganizePreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const ctx = await this.loadContext(this.dataSource, contract.id, holdingId, isoDate(today), dto, false);
		const plan = planReorganize(ctx, dto as ReorganizeInput);

		if (plan.errors.length) throw validationException(plan.errors);

		return this.previewOf(plan);
	}

	/**
	 * Aplica la reorganización. 409 `blocked` con los bloqueos y el preview; 409 `deviation_reason_required` si cambia el total de un ítem y
	 * no llegó `deviation { type, reason }`. Devuelve el preview más `applied`, `event_id`, `created_invoice_ids`, `cancelled_invoice_ids`.
	 */
	async apply(idOrNumber: string, dto: ReorganizeInvoicesDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);

		return await this.transaction(contract.id, holdingId, async (runner) => {
			const ctx = await this.loadContext(runner, contract.id, holdingId, isoDate(today), dto, true);
			const plan = planReorganize(ctx, dto as ReorganizeInput);

			if (plan.errors.length) throw validationException(plan.errors);
			const preview = this.previewOf(plan);

			if (plan.blockers.length) throw this.blocked(plan.blockers, preview);
			if (plan.continuity.reason_required) {
				throw this.blocked(
					[
						{
							code: 'deviation_reason_required',
							message:
								`La reorganización cambia el total facturado de un ítem (diferencia ${plan.continuity.total_diff} ${plan.continuity.currency ?? ''}): indica el tipo y el motivo del desvío`.replace(
									/\s+\)/,
									')'
								),
							next_step: 'Envía deviation { type: discount | upsell | downsell | correction, reason }',
						},
					],
					preview
				);
			}
			if (
				!plan.write.creates.length &&
				!plan.write.line_updates.length &&
				!plan.write.line_creates.length &&
				!plan.write.line_removes.length &&
				!plan.write.header_updates.length &&
				!plan.write.cancelled.length
			)
				throw this.blocked([{ code: 'no_change', message: 'Las operaciones no cambian nada del cronograma', next_step: null }], preview);
			const ids = await this.write(runner, contract.id, holdingId, plan, userId || null, !!ctx.multicurrency);
			const resolve = (key: string) => ids.get(key) ?? key;

			if (plan.rsm_from_month) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, plan.rsm_from_month]);
			const adjustmentIds: string[] = [];

			if (dto.deviation && plan.continuity.changed) {
				for (const adjustment of plan.adjustments) {
					const [row] = (await runner.query(
						`INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, notes, adjusted_by)
						VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
						[resolve(adjustment.invoice_key), holdingId, dto.deviation.type, adjustment.amount_diff, dto.deviation.reason.trim(), userId]
					)) as Row[];

					adjustmentIds.push(String(row.id));
				}
			}
			const createdIds = plan.write.creates.map((create) => resolve(create.key));
			const cancelledIds = plan.write.cancelled.map((cancelled) => cancelled.id);
			const touchedIds = [...new Set([...plan.invoices.filter((view) => view.action !== 'unchanged').map((view) => resolve(view.key))])];
			const reorganizeId = randomUUID();
			const [event] = (await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
				) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb) RETURNING id`,
				[
					contract.id,
					holdingId,
					INVOICE_EVENT_TYPES.reorganize,
					'Cronograma de facturas reorganizado',
					this.summaryText(plan),
					userId,
					isoDate(today),
					JSON.stringify({
						source: 'contract_360',
						reorganize_id: reorganizeId,
						operations: dto.operations,
						operation_results: plan.operations.map(({ index, op, warnings }) => ({
							index,
							op,
							warnings: warnings.map((warning) => warning.code),
						})),
						reason: dto.reason?.trim() || null,
						deviation_type: dto.deviation?.type ?? null,
						deviation_reason: dto.deviation?.reason?.trim() ?? null,
						adjustment_ids: adjustmentIds,
						// Claves que lee el historial de cada factura (`contracts.service.ts` › invoiceDetail).
						invoice_ids: touchedIds,
						created_invoices: createdIds,
						invoices_cancelled: cancelledIds,
						invoices: plan.invoices
							.filter((view) => view.action !== 'unchanged')
							.map((view) => ({
								id: resolve(view.key),
								invoice_number: view.invoice_number,
								action: view.action,
								split_from_invoice_id: view.split_from_invoice_id,
								before: view.before,
								after: view.after,
							})),
						lines: plan.invoices
							.flatMap((view) => view.lines.filter((line) => line.action !== 'unchanged' && !(line.action === 'moved' && !line.after)))
							.map((line) => ({
								id: line.id,
								key: line.key,
								action: line.action,
								from_invoice_id: line.from_invoice_id,
								origin_line_id: line.origin_line_id,
								to_invoice_id: line.to_invoice_key ? resolve(line.to_invoice_key) : null,
								before: line.before,
								after: line.after,
							})),
						summary: plan.summary,
						continuity: {
							changed: plan.continuity.changed,
							total_diff: plan.continuity.total_diff,
							by_item: plan.continuity.by_item.map((item) => ({
								contract_item_id: item.contract_item_id,
								product_name: item.product_name,
								expected_total: item.expected_total,
								before: item.before.actual_total,
								after: item.after.actual_total,
								diff: item.diff,
								inherited: item.inherited,
								changed: item.changed,
							})),
						},
						rsm_from_month: plan.rsm_from_month,
						warnings: plan.warnings.map((warning) => warning.code),
					}),
				]
			)) as Row[];

			return {
				...preview,
				applied: true,
				event_id: String(event.id),
				created_invoice_ids: createdIds,
				cancelled_invoice_ids: cancelledIds,
				adjustment_ids: adjustmentIds,
			};
		});
	}

	private previewOf(plan: ReorganizePlan): ReorganizePreview {
		return {
			operations: plan.operations,
			invoices: plan.invoices,
			continuity: plan.continuity,
			warnings: plan.warnings,
			blockers: plan.blockers,
			can_apply: plan.can_apply,
			rsm_from_month: plan.rsm_from_month,
			summary: plan.summary,
		};
	}

	private summaryText(plan: ReorganizePlan): string {
		const { summary } = plan;
		const parts = [
			summary.invoices_created ? `${summary.invoices_created} ${summary.invoices_created === 1 ? 'factura nueva' : 'facturas nuevas'}` : '',
			summary.invoices_cancelled
				? `${summary.invoices_cancelled} ${summary.invoices_cancelled === 1 ? 'cancelada (sin líneas)' : 'canceladas (sin líneas)'}`
				: '',
			summary.lines_moved ? `${summary.lines_moved} ${summary.lines_moved === 1 ? 'línea movida' : 'líneas movidas'}` : '',
			summary.lines_split ? `${summary.lines_split} ${summary.lines_split === 1 ? 'línea dividida' : 'líneas divididas'}` : '',
			summary.lines_created ? `${summary.lines_created} ${summary.lines_created === 1 ? 'línea nueva' : 'líneas nuevas'}` : '',
			summary.lines_removed ? `${summary.lines_removed} ${summary.lines_removed === 1 ? 'línea juntada' : 'líneas juntadas'}` : '',
			summary.lines_updated
				? `${summary.lines_updated} ${summary.lines_updated === 1 ? 'línea con monto repartido' : 'líneas con montos repartidos'}`
				: '',
		].filter(Boolean);
		const deviation = plan.continuity.changed ? `; total por ítem cambia ${plan.continuity.total_diff}` : '';

		return `${parts.join(', ') || 'Encabezados cuadrados con sus líneas'}${deviation}`;
	}

	// ---------------------------------------------------------------- escritura

	/** Escribe el plan; devuelve `new:N` → id de las facturas creadas. */
	private async write(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		plan: ReorganizePlan,
		userId: string | null = null,
		multicurrency = false
	): Promise<Map<string, string>> {
		const ids = new Map<string, string>();
		const resolve = (key: string) => ids.get(key) ?? key;

		// 1. Facturas nuevas: encabezado desde las reglas del generador (receptor, documento, IVA, moneda, FX del período, vencimiento por
		// condición de pago) y datos fiscales del contrato/compañía/razón social; de la factura de origen solo forma de pago, régimen fiscal y
		// serie (`payment_method`, `fiscal_regime`, `invoice_series`; serie 'FAC' si no hay origen).
		for (const create of plan.write.creates) {
			const [row] = (await runner.query(
				`INSERT INTO invoices (
					id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
					scheduled_at, original_issue_date, issue_date, due_date,
					vat, tax_rate, amount_contract_currency, amount_invoice_currency, total_invoice_currency,
					contract_currency, invoice_currency, fx_contract_to_invoice,
					status, invoice_type, document_type, export_type, invoice_series,
					holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id, payment_method, fiscal_regime,
					requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, is_active,
					split_from_invoice_id, split_reason
				) SELECT
					g.id, g.id, c.company_id, c.client_id, $3::uuid, c.id,
					$4::date, $4::date, $4::date, $5::date,
					$6, $7, $8, $9, $10,
					$11, $12, $13,
					'Por Emitir', 'Automatica', $14, $15, COALESCE(o.invoice_series, 'FAC'),
					c.holding_id, co.legal_name, co.tax_id, co.legal_address, ce.tax_id, o.payment_method, o.fiscal_regime,
					COALESCE(c.requires_references_for_billing, false), COALESCE(c.auto_invoice, false), ${invoiceTermsSql(1)}, true,
					$16::uuid, '${REORGANIZE_SPLIT_REASON}'
				FROM contracts c
				CROSS JOIN (SELECT gen_random_uuid() AS id) g
				LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
				LEFT JOIN client_entities ce ON ce.id = $3::uuid AND ce.holding_id = c.holding_id
				LEFT JOIN invoices o ON o.id = $16::uuid AND o.holding_id = c.holding_id
				WHERE c.id = $1::uuid AND c.holding_id = $2
				RETURNING id`,
				[
					contractId,
					holdingId,
					create.client_entity_id,
					create.issue_date,
					create.due_date,
					create.header.vat,
					create.tax_rate,
					create.header.amount_contract_currency,
					create.header.amount_invoice_currency,
					create.header.total_invoice_currency,
					create.contract_currency,
					create.invoice_currency,
					create.fx,
					create.document_type,
					create.export_type,
					create.split_from_invoice_id,
				]
			)) as Row[];

			ids.set(create.key, String(row.id));
		}
		const fxOf = new Map<string, { fx: number | null; currency: string | null }>();

		for (const create of plan.write.creates) fxOf.set(resolve(create.key), { fx: create.fx, currency: create.invoice_currency });
		for (const view of plan.invoices)
			if (view.id && view.after) fxOf.set(view.id, { fx: view.after.fx_contract_to_invoice, currency: view.after.invoice_currency });

		// 2a. Consumos del período de las líneas movidas (ítem medido): pasan con su línea a la factura de destino.
		for (const update of plan.write.line_updates) {
			if (!update.moved || !update.from_invoice_id || !update.state.contract_item_id || !update.from_period_start) continue;
			await runner.query(
				`UPDATE consumption_entries SET invoice_id = $3, updated_at = now(), updated_by = COALESCE($6::uuid, updated_by)
				WHERE invoice_id = $1 AND holding_id = $2 AND contract_item_id = $4 AND period_start = $5::date`,
				[update.from_invoice_id, holdingId, resolve(update.invoice_key), update.state.contract_item_id, update.from_period_start, userId]
			);
		}

		// 2. Líneas: movidas/divididas por UPDATE (conservan id; estado, emisión y tasa de la factura donde quedan), nuevas por INSERT,
		// absorbidas por DELETE (las juntó una operación con otra línea del mismo ítem y mes).
		if (plan.write.line_removes.length) {
			await runner.query(`DELETE FROM invoice_items WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [plan.write.line_removes, holdingId]);
		}
		// Multimoneda (spec-multimoneda §4): una línea nunca toma la tasa del encabezado de destino sino la de SU par en el documento donde queda
		// (el plan ya la resolvió: la suya si no se mueve; si se mueve o nace, la fijada por factura, la fija pactada del período o spot);
		// `revalueMulticurrencyInvoices` (abajo) deja moneda de la línea y encabezado = Σ líneas.
		for (const update of plan.write.line_updates) {
			const invoiceId = resolve(update.invoice_key);
			const fx = fxOf.get(invoiceId) ?? { fx: null, currency: null };
			const lineFx = multicurrency ? (update.state.fx ?? null) : fx.fx;

			await this.updateLine(runner, update.id, invoiceId, update.state, lineFx, fx.currency, holdingId);
		}
		for (const create of plan.write.line_creates) {
			const invoiceId = resolve(create.invoice_key);
			const fx = fxOf.get(invoiceId) ?? { fx: null, currency: null };

			await this.insertLine(runner, invoiceId, create.state, multicurrency ? (create.state.fx ?? null) : fx.fx, fx.currency, holdingId);
		}

		// 3. Encabezados = Σ líneas; las que quedan sin líneas → Cancelada (se conservan, con evento).
		for (const update of plan.write.header_updates) await this.writeHeader(runner, update.id, holdingId, update.header, 'Por Emitir');
		for (const cancelled of plan.write.cancelled) await this.writeHeader(runner, cancelled.id, holdingId, cancelled.header, 'Cancelada');

		// 4. Descuento puntual que cambió de factura: devengo (`nc_revenue_treatment`) y su fila de `invoice_adjustments` siguen a la línea.
		for (const update of plan.write.treatment_updates)
			await runner.query(`UPDATE invoices SET nc_revenue_treatment = $3 WHERE id = $1 AND holding_id = $2`, [
				resolve(update.invoice_key),
				holdingId,
				update.nc_revenue_treatment,
			]);
		for (const move of plan.write.one_off_moves)
			await moveOneOffAdjustments(runner, holdingId, move.from_invoice_id, resolve(move.to_invoice_key), move.share);
		await refreshInvoiceSystemAmounts(runner, holdingId, [
			...plan.write.creates.map((create) => resolve(create.key)),
			...plan.write.header_updates.map((update) => update.id),
			...plan.write.cancelled.map((cancelled) => cancelled.id),
		]);
		if (multicurrency)
			await revalueMulticurrencyInvoices(runner, holdingId, [
				...plan.write.creates.map((create) => resolve(create.key)),
				...plan.write.header_updates.map((update) => update.id),
			]);

		return ids;
	}

	/** Encabezado de una Por Emitir existente: montos = Σ líneas y estado (Por Emitir o Cancelada si quedó vacía). Nunca `updated_at`. */
	private async writeHeader(
		runner: QueryRunner,
		invoiceId: string,
		holdingId: string,
		header: ReorganizePlan['write']['header_updates'][number]['header'],
		status: string
	) {
		await runner.query(
			`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6, status = $7
			WHERE id = $1 AND holding_id = $2 AND status = 'Por Emitir'`,
			[invoiceId, holdingId, header.amount_contract_currency, header.vat, header.amount_invoice_currency, header.total_invoice_currency, status]
		);
	}

	private async updateLine(
		runner: QueryRunner,
		lineId: string,
		invoiceId: string,
		state: LineState,
		fx: number | null,
		currency: string | null,
		holdingId: string
	) {
		await runner.query(
			`UPDATE invoice_items SET invoice_id = $3, description = $4, quantity = $5, discount_pct = $6,
				unit_price_contract_currency = $7, subtotal_contract_currency = $8, tax_amount_contract_currency = $9, total_contract_currency = $10,
				unit_price_invoice_currency = $11, subtotal_invoice_currency = $12, tax_amount_invoice_currency = $13, total_invoice_currency = $14,
				billing_period_start = $15::date, billing_period_end = $16::date, pricing_breakdown = $17::jsonb,
				fx_rate_source = CASE WHEN $18::numeric IS NULL THEN NULL WHEN fx_contract_to_invoice IS NOT DISTINCT FROM $18::numeric THEN fx_rate_source ELSE '${REORGANIZE_FX_RATE_SOURCE}' END,
				fx_rate_date = CASE WHEN $18::numeric IS NULL THEN NULL WHEN fx_contract_to_invoice IS NOT DISTINCT FROM $18::numeric THEN fx_rate_date ELSE CURRENT_DATE END,
				fx_contract_to_invoice = $18, invoice_currency = $19,
				status = (SELECT h.status FROM invoices h WHERE h.id = $3), issue_date = (SELECT h.issue_date FROM invoices h WHERE h.id = $3),
				updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[
				lineId,
				holdingId,
				invoiceId,
				state.description,
				state.quantity,
				state.discount_pct,
				state.unit_price_contract_currency,
				state.subtotal_contract_currency,
				state.tax_contract_currency,
				state.total_contract_currency,
				state.unit_price_invoice_currency,
				state.subtotal_invoice_currency,
				state.tax_invoice_currency,
				state.total_invoice_currency,
				state.billing_period_start,
				state.billing_period_end,
				state.pricing_breakdown ? JSON.stringify(state.pricing_breakdown) : null,
				fx,
				currency,
			]
		);
	}

	private async insertLine(
		runner: QueryRunner,
		invoiceId: string,
		state: LineState,
		fx: number | null,
		currency: string | null,
		holdingId: string
	) {
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
				(SELECT h.contract_currency FROM invoices h WHERE h.id = $1), $18, $19::numeric,
				CASE WHEN $19::numeric IS NULL THEN NULL ELSE '${REORGANIZE_FX_RATE_SOURCE}' END, CASE WHEN $19::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
				(SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1),
				$20::date, $21::date, $22, $23::jsonb
			)`,
			[
				invoiceId,
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
				currency,
				fx,
				state.billing_period_start,
				state.billing_period_end,
				state.quantity_source ?? 'fixed',
				state.pricing_breakdown ? JSON.stringify(state.pricing_breakdown) : null,
			]
		);
	}

	// ---------------------------------------------------------------- carga

	/** Por Emitir (con `FOR UPDATE OF i` si `lock`), sus líneas, plan del motor, anclas emitidas y reglas del generador. */
	async loadContext(
		db: Queryable,
		contractId: string,
		holdingId: string,
		today: string,
		dto: Pick<ReorganizeInvoicesDto, 'operations'>,
		lock: boolean
	): Promise<ReorganizeContext> {
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const pending = await this.invoices.loadPendingInvoices(db, contractId, holdingId, lock);
		const pendingIds = new Set(pending.map((invoice) => invoice.id));
		const [plainLines, data, [generator]] = await Promise.all([
			pending.length ? this.edit.loadLines(db, [...pendingIds], holdingId) : Promise.resolve(new Map()),
			this.edit.loadPlanData(db, contractId, holdingId),
			db.query(GENERATOR_SQL, [contractId, holdingId]) as Promise<Row[]>,
		]);
		// Multimoneda: con el flag, las líneas traen su moneda y su tasa (cada una se valoriza con su par al escribir).
		const multicurrency = data.contract.requires_multicurrency_billing === true ? await loadPairRateContext(db, contractId, holdingId) : null;
		const lines = multicurrency && pending.length ? await this.edit.loadLines(db, [...pendingIds], holdingId, true) : plainLines;
		const pendingLineIds = new Set([...lines.values()].flat().map((line: { id: string }) => line.id));
		const namedInvoices = [
			...new Set(dto.operations.flatMap((op) => [...(op.invoice_ids ?? []), op.to_invoice_id ?? '', op.invoice_id ?? ''])),
		].filter((id) => id && !pendingIds.has(id));
		const namedLines = [...new Set(dto.operations.map((op) => op.line_id ?? ''))].filter((id) => id && !pendingLineIds.has(id));
		const [foreignInvoices, foreignLines] = await Promise.all([
			namedInvoices.length
				? this.invoices.loadInvoicesByIds(db, contractId, holdingId, namedInvoices)
				: Promise.resolve([] as ContractInvoiceRow[]),
			namedLines.length ? (db.query(FOREIGN_LINES_SQL, [namedLines, contractId, holdingId]) as Promise<Row[]>) : Promise.resolve([] as Row[]),
		]);
		const contract = data.contract;
		const plan = this.edit.deviationPlan(data, '');
		const otherLines: OtherContractLine[] = data.contract_lines
			.filter((row) => !pendingIds.has(String(row.invoice_id)) && row.contract_item_id)
			.map((row) => ({
				invoice_id: String(row.invoice_id),
				contract_item_id: String(row.contract_item_id),
				billing_period_start: toText(row.billing_period_start)?.slice(0, 10) ?? null,
				billing_period_end: toText(row.billing_period_end)?.slice(0, 10) ?? null,
				subtotal: toNumber(row.subtotal_contract_currency),
				credit_note: isCreditNote(toText(row.document_type)) || toText(row.document_type) === 'ND',
			}));

		return {
			context,
			invoices: pending,
			lines,
			foreign_invoices: new Map(foreignInvoices.map((invoice) => [invoice.id, invoice])),
			foreign_lines: new Map(foreignLines.map((row) => [String(row.id), { invoice_id: String(row.invoice_id), status: toText(row.status) }])),
			items: new Map(data.items.map((row) => [String(row.id), this.edit.itemOf(row)])),
			issued_periods: this.edit.issuedPeriods(data.contract_lines),
			other_lines: otherLines,
			expected: plan.expected,
			known_items: plan.known_items,
			product_names: plan.product_names,
			rules: this.rulesOf(generator ?? {}),
			multicurrency,
			render: {
				template: parseStoredTemplate(contract.invoice_description_template),
				contract_number: toText(contract.contract_number),
				client_name: toText(contract.entity_legal_name),
				max_chars: resolveDescriptionMaxChars({
					tax_document_type_id: toText(contract.tax_document_type_id),
					own_max_chars: contract.own_description_max_chars as number | null,
					company_country: toText(contract.company_country),
					document_type: toText(contract.document_type),
					limits: parseJson<DescriptionLimitRow[]>(contract.description_limits),
				}),
			},
		};
	}

	/** Reglas del generador (`billing-engine.generateInvoices` + activación) para el encabezado de una factura nueva. */
	rulesOf(row: Row): NewInvoiceRules {
		const stored = toText(row.document_type);
		const documentType =
			stored === 'FACTURA' || stored === 'FACTURA_EXPORTACION'
				? stored
				: suggestDocumentType(toText(row.company_country), toText(row.entity_country));
		const contractCurrency = (toText(row.contract_currency) ?? '').toUpperCase();

		return {
			client_entity_id: toText(row.client_entity_id),
			legal_name: toText(row.entity_legal_name),
			document_type: documentType,
			export_type: documentType === 'FACTURA_EXPORTACION' ? 1 : 0,
			tax_rate: taxRateForDocument(documentType, toText(row.company_country), row.company_tax_rate as number | string | null),
			contract_currency: contractCurrency,
			invoice_currency: (toText(row.invoice_currency) || contractCurrency).toUpperCase(),
			fx_invoice_policy: toText(row.fx_invoice_policy),
			fixed_invoice_rates: parseJson<FxPeriodRate[]>(row.fx_invoice_rates) ?? [],
		};
	}

	// ---------------------------------------------------------------- transacción y errores

	/** Una transacción con la costura `sapira.writer = 'api'` como primera sentencia y el contrato bloqueado (`FOR UPDATE`). */
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
			if (!(error instanceof HttpException))
				this.logger.warn(
					`Reorganización de facturas del contrato ${contractId} no aplicada: ${error instanceof Error ? error.message : String(error)}`
				);
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
}
