import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { refreshInvoiceSystemAmounts } from './api-written-fields';
import { round2 } from './billing-engine';
import { PENDING_STATUS, voidedSql } from './contract-360';
import { insertMirrorCreditNote } from './contract-changes.service';
import { resolveUserId } from './contract-drafts.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { type ContractInvoiceRow, INVOICE_EVENT_TYPES, type InvoiceBlocker } from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService } from './contracts.service';
import { deviationReasonBlocker, deviationReasonMissing, type EditLineRow, type EditPlan, type LineState } from './invoice-edit';
import {
	type DiscountPlan,
	type IssuedInvoiceRow,
	planDiscountCreditNote,
	planReissue,
	planVoid,
	type PreviousDiscountLine,
	REISSUE_SPLIT_REASON,
	taxPct,
	VOID_REASON_LABELS,
	type VoidPlan,
} from './invoice-void';

import type { DiscountCreditNoteDto, VoidInvoiceDto } from './dtos/contract-invoice-credit-notes.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Referencia de la NC a su factura (como la NC electrónica: tipo y folio del documento original, código SII del motivo: 1 = anula,
 * 3 = corrige montos) y cierre de la original al anular (`Cancelada`, como la función legacy `cancel_invoice_with_credit_note`): sale
 * de vencimientos y cobranza y queda neteada. Decisión de Domi 01-10.
 */
export const NC_REFERENCE_CODES = { cancellation: '1', discount: '3' } as const;
const ORIGINAL_DOCUMENT_CODE_SQL = `SELECT COALESCE(t.code, CASE WHEN i.document_type = 'FACTURA_EXPORTACION' THEN '110' ELSE '33' END) AS code,
		COALESCE(t.name, 'Factura electrónica') AS name
	FROM invoices i LEFT JOIN contracts c ON c.id = i.contract_id LEFT JOIN tax_document_types t ON t.id = c.tax_document_type_id
	WHERE i.id = $1 AND i.holding_id = $2`;

export async function insertCreditNoteReference(
	runner: QueryRunner,
	creditNoteId: string,
	original: { id: string; invoice_number: string | null; issue_date: string | null },
	holdingId: string,
	kind: keyof typeof NC_REFERENCE_CODES,
	reason: string,
	userId: string | null
): Promise<void> {
	const [doc] = (await runner.query(ORIGINAL_DOCUMENT_CODE_SQL, [original.id, holdingId])) as Row[];

	await runner.query(
		`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_code, reason, reference_date, created_by)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9)`,
		[
			creditNoteId,
			holdingId,
			original.invoice_number ?? original.id,
			toText(doc?.code) ?? '33',
			toText(doc?.name) ?? 'Factura electrónica',
			NC_REFERENCE_CODES[kind],
			reason,
			original.issue_date,
			userId,
		]
	);
}

/** `invoice_items.fx_rate_source` de las líneas de una reemisión cuando la original no tenía origen de tasa. */
export const REISSUE_FX_RATE_SOURCE = 'reissue';

/** Lo que miran anular y la NC de descuento además de la fila común: anulada (NC de anulación vinculada) y pagos confirmados. */
const ISSUED_EXTRA_SQL = `SELECT ${voidedSql('i')} AS voided,
		EXISTS (SELECT 1 FROM invoice_payments p WHERE p.invoice_id = i.id AND p.holding_id = i.holding_id AND p.confirmed = true) AS paid
	FROM invoices i WHERE i.id = $1 AND i.holding_id = $2`;

/** Líneas de las NC de descuento vigentes de la factura (para lo que queda por descontar de cada línea). */
export const PREVIOUS_DISCOUNTS_SQL = `SELECT nc.id AS credit_note_id, nc.invoice_number AS credit_note_number, nii.contract_item_id, nii.billing_period_start::text AS billing_period_start, nii.billing_period_end::text AS billing_period_end,
		nii.subtotal_contract_currency, nii.subtotal_invoice_currency
	FROM invoices nc JOIN invoice_items nii ON nii.invoice_id = nc.id
	WHERE nc.related_invoice_id = $1 AND nc.holding_id = $2 AND nc.document_type = 'NC' AND nc.credit_type = 'discount'
		AND nc.is_active = true AND nc.status IS DISTINCT FROM 'Cancelada'
	ORDER BY nc.created_at, nc.id, nii.created_at, nii.id`;

/**
 * Inserta una línea (estado del editor) en una factura: moneda de contrato/factura, estado y emisión del encabezado; tasa y origen de la tasa
 * dados; `visible_line_id` para una interna de facturar por OC. Devuelve el id.
 */
export async function insertLineState(
	runner: Pick<QueryRunner, 'query'>,
	holdingId: string,
	invoiceId: string,
	state: LineState,
	options: { fx: number | null; fx_rate_source: string | null; visible_line_id?: string | null; source_line_id?: string | null }
): Promise<string> {
	const [row] = (await runner.query(
		`INSERT INTO invoice_items (
			invoice_id, contract_item_id, holding_id, contract_id, product_id, description, description_locked, quantity, unit_of_measure, discount_pct,
			unit_price_contract_currency, unit_price_invoice_currency, subtotal_contract_currency, subtotal_invoice_currency,
			tax_amount_contract_currency, tax_amount_invoice_currency, total_contract_currency, total_invoice_currency,
			contract_currency, invoice_currency, fx_contract_to_invoice, fx_rate_source, fx_rate_date, status, issue_date,
			billing_period_start, billing_period_end, quantity_source, pricing_breakdown, visible_line_id
		) VALUES (
			$1, $2::uuid, $3, (SELECT h.contract_id FROM invoices h WHERE h.id = $1),
			COALESCE($4::uuid, (SELECT ci.product_id FROM contract_items ci WHERE ci.id = $2::uuid)), $5, $6, $7, $8, $9,
			$10, $11, $12, $13,
			$14, $15, $16, $17,
			(SELECT h.contract_currency FROM invoices h WHERE h.id = $1), (SELECT h.invoice_currency FROM invoices h WHERE h.id = $1), $18::numeric,
			CASE WHEN $18::numeric IS NULL THEN NULL ELSE COALESCE((SELECT o.fx_rate_source FROM invoice_items o WHERE o.id = $24::uuid), $19) END,
			CASE WHEN $18::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
			(SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1),
			$20::date, $21::date, $22, $23::jsonb, $25::uuid
		) RETURNING id`,
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
			options.fx,
			options.fx_rate_source,
			state.billing_period_start,
			state.billing_period_end,
			state.quantity_source ?? 'fixed',
			state.pricing_breakdown ? JSON.stringify(state.pricing_breakdown) : null,
			options.source_line_id ?? null,
			options.visible_line_id ?? null,
		]
	)) as Row[];

	return String(row?.id ?? '');
}

export interface VoidPreview {
	invoice: { id: string; invoice_number: string | null; status: string | null; voided: boolean; paid: boolean };
	credit_note: VoidPlan['credit_note'];
	reissue: {
		issue_date: string | null;
		due_date: string | null;
		notes: string | null;
		related_invoice_id: string;
		split_reason: typeof REISSUE_SPLIT_REASON;
		header: EditPlan['header']['after'];
		lines: Array<{ source_line_id: string | null; action: string; is_visible: boolean; after: LineState | null }>;
		deviation: EditPlan['deviation'];
		revenue_effect: EditPlan['revenue_effect'];
	} | null;
	consumption_entries: Array<{ id: string; contract_item_id: string; period_start: string }>;
	warnings: VoidPlan['warnings'];
	blockers: InvoiceBlocker[];
	can_apply: boolean;
}

export type CreditNotePreview = Omit<DiscountPlan, 'errors' | 'mirror'>;

/**
 * Facturas en el Contrato 360, etapa 6 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.8 y §8): **anular una emitida con NC espejo
 * y reemitir** (o no) y **NC de descuento parcial sobre una emitida** con tratamiento de devengo. Ambas con preview (mismo cálculo, sin
 * escribir) y aplicación en **una transacción** con `setApiWriter` como primera sentencia, el contrato y la factura bloqueados, la NC por
 * `insertMirrorCreditNote` (Por Emitir, sin vencimiento, `related_invoice_id` = la original), devengo reconstruido desde el mes del período y
 * evento en `contract_lifecycle_events`. La emitida no se toca (queda `voided` por derivación). Nunca escribe `invoices.updated_at`.
 */
@Injectable()
export class ContractInvoiceVoidService {
	private readonly logger = new Logger(ContractInvoiceVoidService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService,
		private readonly edit: ContractInvoiceEditService
	) {}

	// ---------------------------------------------------------------- anular con NC espejo y reemitir (§3.8)

	async previewVoid(idOrNumber: string, invoiceId: string, dto: VoidInvoiceDto, holdingId: string, today = new Date()): Promise<VoidPreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const work = await this.planVoidWork(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today), dto, false);

		return work.preview;
	}

	/**
	 * Aplica la anulación. 409 `blocked` con los bloqueos y el preview; 409 `deviation_reason_required` si los cambios de la reemisión la
	 * dejan distinta al plan sin `reissue_changes.deviation`. Devuelve el preview más `applied`, `credit_note_id`, `reissue_invoice_id`,
	 * `event_ids` y el detalle de la original.
	 */
	async voidInvoice(idOrNumber: string, invoiceId: string, dto: VoidInvoiceDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const todayIso = isoDate(today);

		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const work = await this.planVoidWork(runner, contract.id, invoiceId, holdingId, todayIso, dto, true);
			const { preview, plan, invoice, rows, reissue } = work;

			if (preview.blockers.length) throw this.blocked(preview.blockers, preview);
			if (reissue && deviationReasonMissing(reissue, { deviation: dto.reissue_changes?.deviation ?? null }))
				throw this.blocked([deviationReasonBlocker(reissue.deviation)], preview);
			const folio = invoice.invoice_number ?? invoice.id;
			const label = VOID_REASON_LABELS[dto.reason];
			const creditNoteId = await insertMirrorCreditNote(
				runner,
				{ id: invoice.id, tax_rate: taxPct(invoice.tax_rate) },
				plan.mirror,
				`NC de anulación de ${folio} (${label})${dto.notes?.trim() ? ` — ${dto.notes.trim()}` : ''}`,
				holdingId,
				todayIso,
				{
					credit_type: 'cancellation',
					credit_reason: plan.credit_note.credit_reason,
					exact: true,
					// Las líneas ya descontadas por NC previas se acreditan por lo que queda (cantidad 1 × −monto).
					partial_line_shape: 'amount',
					invoice_type: 'Manual',
					line_suffix: () => ` (NC anulación de ${folio})`,
				}
			);
			await insertCreditNoteReference(
				runner,
				creditNoteId,
				{ id: invoice.id, invoice_number: invoice.invoice_number, issue_date: invoice.issue_date },
				holdingId,
				'cancellation',
				`Anula ${folio}: ${label}`,
				userId
			);
			// La original queda cerrada (Cancelada): neteada en KPIs y fuera de vencimientos y cobranza. Antes/después en el evento.
			await runner.query(`UPDATE invoices SET status = 'Cancelada' WHERE id = $1 AND holding_id = $2`, [invoice.id, holdingId]);
			const reissueId = reissue ? await this.writeReissue(runner, holdingId, invoice, rows, reissue) : null;
			const adjustmentId =
				reissue && dto.reissue_changes?.deviation && reissue.deviation.has_deviation && reissueId
					? await this.insertAdjustment(
							runner,
							reissueId,
							holdingId,
							userId,
							dto.reissue_changes.deviation.type,
							reissue.deviation.total_diff,
							dto.reissue_changes.deviation.reason
						)
					: null;
			// Consumos del período (S7-8): los que llevaba la anulada pasan a la reemisión o quedan libres para registrarse de nuevo.
			const released = (await runner.query(
				`UPDATE consumption_entries SET invoice_id = $4, updated_at = now(), updated_by = $5
				WHERE invoice_id = $1 AND holding_id = $2 AND contract_id = $3 RETURNING id`,
				[invoice.id, holdingId, contract.id, reissueId, userId]
			)) as Row[];
			const releasedIds = (Array.isArray(released) ? released : []).map((row) => String(row.id));
			const rsmFrom = [plan.rsm_from_month, reissue?.rsm_from_month ?? null].filter((value): value is string => !!value).sort()[0] ?? null;

			if (rsmFrom) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, rsmFrom]);
			const invoiceIds = [invoice.id, creditNoteId, ...(reissueId ? [reissueId] : [])];
			const voidedEvent = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.voided,
				title: `Factura ${folio} anulada con NC${reissueId ? ' y reemitida' : ''}`,
				description:
					`Motivo: ${label}${dto.notes?.trim() ? ` — ${dto.notes.trim()}` : ''}; NC por ${plan.credit_note.totals.total_invoice_currency ?? plan.credit_note.totals.amount_contract_currency} ${
						invoice.invoice_currency ?? ''
					}`.trim(),
				effective_date: todayIso,
				invoice_id: invoice.id,
				metadata: {
					invoice_number: invoice.invoice_number,
					invoice_ids: invoiceIds,
					created_invoices: [creditNoteId, ...(reissueId ? [reissueId] : [])],
					credit_note_id: creditNoteId,
					reissue_invoice_id: reissueId,
					reason: dto.reason,
					credit_reason: plan.credit_note.credit_reason,
					notes: dto.notes?.trim() || null,
					paid: invoice.paid,
					credit_note: { totals: plan.credit_note.totals, lines: plan.credit_note.lines.length },
					before: { status: invoice.status },
					after: { status: 'Cancelada' },
					consumption_entries_released: releasedIds,
					rsm_from_month: rsmFrom,
					warnings: preview.warnings.map((warning) => warning.code),
				},
			});
			const eventIds = [voidedEvent];

			if (reissue && reissueId) {
				eventIds.push(
					await this.insertEvent(runner, contract.id, holdingId, userId, {
						type: INVOICE_EVENT_TYPES.reissued,
						title: `Factura ${folio} reemitida`,
						description: `Nueva Por Emitir que reemplaza a ${folio}${dto.reissue_changes ? ' (con cambios)' : ' (copia de sus líneas)'}`,
						effective_date: reissue.header.after.issue_date,
						invoice_id: reissueId,
						metadata: {
							related_invoice_id: invoice.id,
							replaces_invoice_number: invoice.invoice_number,
							credit_note_id: creditNoteId,
							invoice_ids: [reissueId, invoice.id],
							split_reason: REISSUE_SPLIT_REASON,
							with_changes: !!dto.reissue_changes,
							header: reissue.header.after,
							lines: reissue.lines
								.filter((line) => line.action !== 'unchanged')
								.map((line) => ({ id: line.id, action: line.action, before: line.before, after: line.after })),
							deviation: reissue.deviation,
							deviation_type: dto.reissue_changes?.deviation?.type ?? null,
							deviation_reason: dto.reissue_changes?.deviation?.reason ?? null,
							adjustment_id: adjustmentId,
							consumption_entries: releasedIds,
						},
					})
				);
			}

			return { preview, creditNoteId, reissueId, eventIds, adjustmentId };
		});

		return {
			...result.preview,
			applied: true,
			credit_note_id: result.creditNoteId,
			reissue_invoice_id: result.reissueId,
			adjustment_id: result.adjustmentId,
			event_ids: result.eventIds,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		};
	}

	private async planVoidWork(
		db: Queryable,
		contractId: string,
		invoiceId: string,
		holdingId: string,
		today: string,
		dto: VoidInvoiceDto,
		lock: boolean
	): Promise<{ preview: VoidPreview; plan: VoidPlan; invoice: IssuedInvoiceRow; rows: EditLineRow[]; reissue: EditPlan | null }> {
		if (!dto.reissue && dto.reissue_changes)
			throw validationException([{ field: 'reissue_changes', message: 'Los cambios de la reemisión solo aplican con reissue: true' }]);
		const { invoice, rows, context } = await this.loadIssued(db, contractId, invoiceId, holdingId, today, lock);
		// La NC de anulación acredita lo que queda de cada línea tras las NC de descuento vigentes (spec §3.8).
		const previous = await this.previousDiscounts(db, invoice.id, holdingId);
		const plan = planVoid(invoice, rows, context, { reason: dto.reason, notes: dto.notes, reissue: dto.reissue }, previous);
		let reissue: EditPlan | null = null;

		if (dto.reissue) {
			const editCtx = await this.edit.loadEditContext(
				db,
				contractId,
				invoice.id,
				holdingId,
				today,
				dto.reissue_changes?.client_entity_id ?? null
			);

			reissue = planReissue(editCtx, dto.reissue_changes ?? null);
			if (reissue.errors.length)
				throw validationException(reissue.errors.map((error: FieldError) => ({ ...error, field: `reissue_changes.${error.field}` })));
		}
		const entries = (await db.query(
			`SELECT e.id, e.contract_item_id, e.period_start::text AS period_start FROM consumption_entries e
			WHERE e.invoice_id = $1 AND e.holding_id = $2 AND e.contract_id = $3 ORDER BY e.period_start, e.id`,
			[invoice.id, holdingId, contractId]
		)) as Row[];
		const blockers = [...plan.blockers];

		// La reemisión hereda los bloqueos del editor que no vienen de la emitida (fecha en período cerrado, ítem fuera de vigencia…).
		for (const blocker of reissue?.blockers ?? [])
			if (!blockers.some((entry) => entry.code === blocker.code && entry.message === blocker.message)) blockers.push(blocker);
		const preview: VoidPreview = {
			invoice: { id: invoice.id, invoice_number: invoice.invoice_number, status: invoice.status, voided: invoice.voided, paid: invoice.paid },
			credit_note: plan.credit_note,
			reissue: reissue
				? {
						issue_date: reissue.header.after.issue_date,
						due_date: reissue.header.after.due_date,
						notes: reissue.header.after.notes,
						related_invoice_id: invoice.id,
						split_reason: REISSUE_SPLIT_REASON,
						header: reissue.header.after,
						lines: reissue.lines.map((line) => ({
							source_line_id: line.id,
							action: line.action,
							is_visible: line.is_visible,
							after: line.after,
						})),
						deviation: reissue.deviation,
						revenue_effect: reissue.revenue_effect,
					}
				: null,
			consumption_entries: entries.map((row) => ({
				id: String(row.id),
				contract_item_id: String(row.contract_item_id),
				period_start: String(row.period_start).slice(0, 10),
			})),
			warnings: [...plan.warnings, ...(reissue?.warnings ?? [])],
			blockers,
			can_apply: blockers.length === 0,
		};

		return { preview, plan, invoice, rows, reissue };
	}

	/**
	 * Reemisión: Por Emitir nueva del mismo período con el encabezado de la original (emisor, moneda, tasa, serie, condiciones) salvo lo que
	 * cambió el editor (receptor, fechas, IVA, notas "Reemplaza a …"), `related_invoice_id` = la original, `split_reason = 'reissue'`, grupo
	 * propio, y las líneas del plan (copiadas o editadas; las internas de facturar por OC conservan el vínculo con su visible). Copia las
	 * referencias OC/HES propias de la original y sus vínculos a referencias del contrato (`invoice_reference_links`): el documento que la
	 * reemplaza las necesita igual.
	 */
	private async writeReissue(
		runner: QueryRunner,
		holdingId: string,
		original: IssuedInvoiceRow,
		rows: EditLineRow[],
		plan: EditPlan
	): Promise<string> {
		const after = plan.header.after;
		const [header] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
				scheduled_at, original_issue_date, issue_date, due_date,
				amount_contract_currency, vat, amount_invoice_currency, total_invoice_currency, tax_rate,
				contract_currency, invoice_currency, system_currency, fx_contract_to_invoice, fx_contract_to_system,
				status, invoice_type, document_type, export_type, invoice_series,
				holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id, payment_method, fiscal_regime,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, notes, nc_revenue_treatment, is_active,
				related_invoice_id, split_reason
			) SELECT
				g.id, g.id, o.company_id, o.client_id, $3::uuid, o.contract_id,
				$4::date, $4::date, $4::date, $5::date,
				$6, $7, $8, $9, $10,
				o.contract_currency, o.invoice_currency, o.system_currency, o.fx_contract_to_invoice, o.fx_contract_to_system,
				'${PENDING_STATUS}', COALESCE(o.invoice_type, 'Manual'), o.document_type, $11, o.invoice_series,
				o.holding_id, o.issuer_legal_name, o.issuer_tax_id, o.issuer_address, $12, o.payment_method, o.fiscal_regime,
				COALESCE(o.requires_references_for_billing, false), $13, $14, $15, $16, true,
				o.id, '${REISSUE_SPLIT_REASON}'
			FROM invoices o CROSS JOIN (SELECT gen_random_uuid() AS id) g
			WHERE o.id = $1 AND o.holding_id = $2
			RETURNING id`,
			[
				original.id,
				holdingId,
				after.client_entity_id,
				after.issue_date,
				after.due_date,
				after.amount_contract_currency,
				after.vat,
				after.amount_invoice_currency,
				after.total_invoice_currency,
				after.tax_rate,
				after.export_type,
				after.client_tax_id,
				after.auto_invoice,
				after.invoice_terms_and_conditions,
				after.notes,
				after.nc_revenue_treatment,
			]
		)) as Row[];
		const reissueId = String(header.id);
		const fx = after.fx_contract_to_invoice;
		const sourceOf = new Map(rows.map((row) => [row.id, row]));
		const newIds = new Map<string, string>();
		const lines = plan.lines.filter((line) => line.action !== 'remove' && line.after);
		// Visibles primero, así las internas encuentran el id nuevo de su visible.
		const ordered = [...lines].sort(
			(a, b) => Number(!!(a.id && sourceOf.get(a.id)?.visible_line_id)) - Number(!!(b.id && sourceOf.get(b.id)?.visible_line_id))
		);

		for (const line of ordered) {
			const source = line.id ? sourceOf.get(line.id) : undefined;
			const visibleSource = source?.visible_line_id ?? null;
			const id = await insertLineState(runner, holdingId, reissueId, line.after!, {
				fx,
				fx_rate_source: REISSUE_FX_RATE_SOURCE,
				source_line_id: source?.id ?? null,
				visible_line_id: visibleSource ? (newIds.get(visibleSource) ?? null) : null,
			});

			if (source) newIds.set(source.id, id);
		}
		await runner.query(
			`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_code, reason, reference_date, created_by)
			SELECT $3, r.holding_id, r.document_number, r.document_type_code, r.document_type_name, r.reference_code, r.reason, r.reference_date, r.created_by
			FROM invoice_references r WHERE r.invoice_id = $1 AND r.holding_id = $2`,
			[original.id, holdingId, reissueId]
		);
		// También los vínculos a referencias del contrato (`billing_references` vía `invoice_reference_links`): la reemisión las lleva igual.
		await runner.query(
			`INSERT INTO invoice_reference_links (invoice_id, reference_id, holding_id, linked_by)
			SELECT $3, rl.reference_id, rl.holding_id, rl.linked_by
			FROM invoice_reference_links rl WHERE rl.invoice_id = $1 AND rl.holding_id = $2
			ON CONFLICT (invoice_id, reference_id) DO NOTHING`,
			[original.id, holdingId, reissueId]
		);
		await refreshInvoiceSystemAmounts(runner, holdingId, [reissueId]);

		return reissueId;
	}

	// ---------------------------------------------------------------- NC de descuento parcial sobre una emitida (§8)

	async previewCreditNote(
		idOrNumber: string,
		invoiceId: string,
		dto: DiscountCreditNoteDto,
		holdingId: string,
		today = new Date()
	): Promise<CreditNotePreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const { plan } = await this.planCreditNoteWork(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today), dto, false);

		return this.creditNotePreview(plan);
	}

	/** Crea la NC de descuento (Por Emitir, sin vencimiento, `nc_revenue_treatment`), reconstruye el devengo y registra el evento. */
	async createCreditNote(idOrNumber: string, invoiceId: string, dto: DiscountCreditNoteDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const todayIso = isoDate(today);

		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const { plan, invoice } = await this.planCreditNoteWork(runner, contract.id, invoiceId, holdingId, todayIso, dto, true);
			const preview = this.creditNotePreview(plan);

			if (plan.blockers.length) throw this.blocked(plan.blockers, preview);
			const folio = invoice.invoice_number ?? invoice.id;
			const creditNoteId = await insertMirrorCreditNote(
				runner,
				{ id: invoice.id, tax_rate: taxPct(invoice.tax_rate) },
				plan.mirror,
				`NC de descuento sobre ${folio} (${dto.reason})${dto.notes?.trim() ? ` — ${dto.notes.trim()}` : ''}`,
				holdingId,
				todayIso,
				{
					credit_type: 'discount',
					credit_reason: dto.reason,
					nc_revenue_treatment: dto.revenue_treatment,
					invoice_type: 'Manual',
					line_shape: 'amount',
					line_suffix: () => ` (NC descuento de ${folio})`,
				}
			);
			await insertCreditNoteReference(
				runner,
				creditNoteId,
				{ id: invoice.id, invoice_number: invoice.invoice_number, issue_date: invoice.issue_date },
				holdingId,
				'discount',
				`Descuento sobre ${folio}: ${dto.reason}`,
				userId
			);

			if (plan.rsm_from_month) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, plan.rsm_from_month]);
			const eventId = await this.insertEvent(runner, contract.id, holdingId, userId, {
				type: INVOICE_EVENT_TYPES.credit_note,
				title: `NC de descuento sobre la factura ${folio}`,
				description: `${dto.reason}: ${plan.credit_note.totals.amount_invoice_currency ?? plan.credit_note.totals.amount_contract_currency} ${
					invoice.invoice_currency ?? ''
				} neto; devengo ${dto.revenue_treatment}${dto.notes?.trim() ? ` — ${dto.notes.trim()}` : ''}`,
				effective_date: todayIso,
				invoice_id: invoice.id,
				metadata: {
					invoice_number: invoice.invoice_number,
					invoice_ids: [invoice.id, creditNoteId],
					created_invoices: [creditNoteId],
					credit_note_id: creditNoteId,
					credit_type: 'discount',
					credit_reason: dto.reason,
					nc_revenue_treatment: dto.revenue_treatment,
					notes: dto.notes?.trim() || null,
					lines: plan.lines,
					totals: plan.credit_note.totals,
					revenue_effect: plan.revenue_effect,
					rsm_from_month: plan.rsm_from_month,
					warnings: plan.warnings.map((warning) => warning.code),
				},
			});

			return { preview, creditNoteId, eventId };
		});

		return {
			...result.preview,
			applied: true,
			credit_note_id: result.creditNoteId,
			event_id: result.eventId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		};
	}

	private creditNotePreview(plan: DiscountPlan): CreditNotePreview {
		return {
			blockers: plan.blockers,
			warnings: plan.warnings,
			credit_note: plan.credit_note,
			lines: plan.lines,
			revenue_effect: plan.revenue_effect,
			rsm_from_month: plan.rsm_from_month,
			can_apply: plan.can_apply,
		};
	}

	private async planCreditNoteWork(
		db: Queryable,
		contractId: string,
		invoiceId: string,
		holdingId: string,
		today: string,
		dto: DiscountCreditNoteDto,
		lock: boolean
	): Promise<{ plan: DiscountPlan; invoice: IssuedInvoiceRow }> {
		const { invoice, rows, context } = await this.loadIssued(db, contractId, invoiceId, holdingId, today, lock);
		const [previous, data] = await Promise.all([
			this.previousDiscounts(db, invoice.id, holdingId),
			this.edit.loadPlanData(db, contractId, holdingId),
		]);
		const items = new Map(data.items.map((row) => [String(row.id), this.edit.itemOf(row)]));
		const plan = planDiscountCreditNote(invoice, rows, previous, context, items, {
			lines: dto.lines,
			pct: dto.pct,
			reason: dto.reason,
			revenue_treatment: dto.revenue_treatment,
			notes: dto.notes,
		});

		if (plan.errors.length) throw validationException(plan.errors);

		return { plan, invoice };
	}

	// ---------------------------------------------------------------- carga, escritura común, transacción

	/** Líneas de las NC de descuento vigentes de la factura (`PREVIOUS_DISCOUNTS_SQL`), con la NC a la que pertenecen. */
	private async previousDiscounts(db: Queryable, invoiceId: string, holdingId: string): Promise<PreviousDiscountLine[]> {
		const rows = (await db.query(PREVIOUS_DISCOUNTS_SQL, [invoiceId, holdingId])) as Row[];

		return (Array.isArray(rows) ? rows : []).map((row) => ({
			credit_note_id: toText(row.credit_note_id),
			credit_note_number: toText(row.credit_note_number),
			contract_item_id: toText(row.contract_item_id),
			billing_period_start: toText(row.billing_period_start)?.slice(0, 10) ?? null,
			billing_period_end: toText(row.billing_period_end)?.slice(0, 10) ?? null,
			subtotal: toNumber(row.subtotal_contract_currency),
			subtotal_invoice:
				row.subtotal_invoice_currency === null || row.subtotal_invoice_currency === undefined
					? null
					: toNumber(row.subtotal_invoice_currency),
		}));
	}

	private async loadIssued(db: Queryable, contractId: string, invoiceId: string, holdingId: string, today: string, lock: boolean) {
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const row: ContractInvoiceRow = await this.invoices.loadInvoice(db, contractId, invoiceId, holdingId, lock);
		const [[extra], lines] = await Promise.all([
			db.query(ISSUED_EXTRA_SQL, [row.id, holdingId]) as Promise<Row[]>,
			this.edit.loadLines(db, [row.id], holdingId),
		]);
		const invoice: IssuedInvoiceRow = { ...row, voided: extra?.voided === true, paid: extra?.paid === true };

		return { invoice, rows: lines.get(row.id) ?? [], context };
	}

	private async insertAdjustment(
		runner: QueryRunner,
		invoiceId: string,
		holdingId: string,
		userId: string,
		type: string,
		amountDiff: number,
		reason: string
	) {
		const [row] = (await runner.query(
			`INSERT INTO invoice_adjustments (invoice_id, holding_id, type, amount_diff, notes, adjusted_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
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
					`NC sobre factura del contrato ${contractId} no aplicada: ${error instanceof Error ? error.message : String(error)}`
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
