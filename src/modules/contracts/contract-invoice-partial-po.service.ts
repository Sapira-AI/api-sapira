import { ConflictException, HttpException, Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { setApiWriter } from './api-writer';
import { invoiceTermsSql, refreshInvoiceSystemAmounts } from './api-written-fields';
import { resolveUserId } from './contract-drafts.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoiceReorganizeService, GENERATOR_SQL, moveOneOffAdjustments } from './contract-invoice-reorganize.service';
import { insertLineState } from './contract-invoice-void.service';
import { INVOICE_EVENT_TYPES, type InvoiceBlocker, isMultiCurrency, REFERENCE_DOCUMENT_TYPES } from './contract-invoices';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsService } from './contracts.service';
import { invoiceFx, type LineState } from './invoice-edit';
import { PARTIAL_BY_PO_SPLIT_REASON, type PartialByPoPlan, planPartialByPo } from './invoice-partial-po';

import type { PartialByPoDto } from './dtos/contract-invoice-partial-po.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** `invoice_items.fx_rate_source` de las líneas que escribe facturar por OC cuando no hay neto exacto (misma moneda o saldo). */
export const PARTIAL_BY_PO_LINE_FX_SOURCE = 'partial_by_po';

export type PartialByPoPreview = Omit<PartialByPoPlan, 'errors' | 'write'>;

/**
 * Facturas en el Contrato 360, etapa 6 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.7b): **facturar un monto cerrado por OC** sobre
 * una Por Emitir. Preview y aplicar comparten el plan puro (`invoice-partial-po.ts`); aplicar va en **una transacción** con `setApiWriter`
 * como primera sentencia, el contrato y la factura bloqueados: línea visible nueva (INSERT), cubiertas → internas (`visible_line_id`),
 * encabezado = neto de la OC (neto exacto con conversión), referencia OC/HES en `invoice_references`, saldo a una Por Emitir nueva desde las
 * reglas del generador (`split_reason = 'partial_by_po'`, `split_from_invoice_id`), montos en moneda del sistema, devengo del período y un
 * evento `INVOICE_PARTIAL_BILLING` (sin fila en `invoice_adjustments`: no es un desvío). Nunca escribe `invoices.updated_at`.
 */
@Injectable()
export class ContractInvoicePartialPoService {
	private readonly logger = new Logger(ContractInvoicePartialPoService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly contracts: ContractsService,
		private readonly invoices: ContractInvoicesService,
		private readonly edit: ContractInvoiceEditService,
		private readonly reorganize: ContractInvoiceReorganizeService
	) {}

	async preview(idOrNumber: string, invoiceId: string, dto: PartialByPoDto, holdingId: string, today = new Date()): Promise<PartialByPoPreview> {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const plan = await this.plan(this.dataSource, contract.id, invoiceId, holdingId, isoDate(today), dto, false);

		return this.previewOf(plan);
	}

	/** Aplica la facturación por OC. 409 `blocked` con los bloqueos y el preview. */
	async apply(idOrNumber: string, invoiceId: string, dto: PartialByPoDto, holdingId: string, authId: string, today = new Date()) {
		const contract = await this.contracts.resolveContract(idOrNumber, holdingId);
		const userId = await resolveUserId(this.dataSource, authId);
		const todayIso = isoDate(today);

		const result = await this.transaction(contract.id, holdingId, async (runner) => {
			const plan = await this.plan(runner, contract.id, invoiceId, holdingId, todayIso, dto, true);
			const preview = this.previewOf(plan);

			if (!plan.can_apply)
				throw this.blocked(
					plan.blockers.length ? plan.blockers : [{ code: 'nothing_covered', message: 'La OC no cubre ninguna línea', next_step: null }],
					preview
				);
			const invoiceIdCovered = plan.covered_invoice.id;
			const write = plan.write;
			const coveredSource = write.covered_fx_source ?? PARTIAL_BY_PO_LINE_FX_SOURCE;

			// 1. Línea visible del documento y cubiertas → internas ligadas a ella.
			const visibleId = await insertLineState(runner, holdingId, invoiceIdCovered, write.visible, {
				fx: write.covered_fx,
				fx_rate_source: coveredSource,
			});

			for (const line of write.covered)
				await this.updateLine(runner, holdingId, line.id, invoiceIdCovered, line.state, write.covered_fx, coveredSource, visibleId);
			await runner.query(
				`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6, fx_contract_to_invoice = $7
				WHERE id = $1 AND holding_id = $2 AND status = 'Por Emitir'`,
				[
					invoiceIdCovered,
					holdingId,
					write.covered_header.amount_contract_currency,
					write.covered_header.vat,
					write.covered_header.amount_invoice_currency,
					write.covered_header.total_invoice_currency,
					write.covered_fx,
				]
			);

			// 2. Referencia OC/HES (misma tabla que Facturación); no se duplica.
			if (!plan.reference.already_present) {
				await runner.query(
					`INSERT INTO invoice_references (invoice_id, holding_id, document_number, document_type_code, document_type_name, reference_date, created_by)
					VALUES ($1, $2, $3, $4, $5, $6::date, $7)`,
					[
						invoiceIdCovered,
						holdingId,
						plan.reference.code,
						plan.reference.document_type_code,
						REFERENCE_DOCUMENT_TYPES[plan.reference.type].name,
						plan.reference.date,
						authId || null,
					]
				);
			}

			// 3. Saldo: Por Emitir nueva con las reglas del generador.
			let remainderId: string | null = null;

			if (write.remainder) {
				remainderId = await this.insertRemainder(runner, contract.id, holdingId, invoiceIdCovered, write.remainder);
				// Consumos del período de las líneas que pasan completas al saldo (ítem medido): se van con su línea.
				for (const line of write.moves)
					if (line.state.contract_item_id && line.state.billing_period_start)
						await runner.query(
							`UPDATE consumption_entries SET invoice_id = $3, updated_at = now(), updated_by = COALESCE($6::uuid, updated_by)
							WHERE invoice_id = $1 AND holding_id = $2 AND contract_item_id = $4 AND period_start = $5::date`,
							[invoiceIdCovered, holdingId, remainderId, line.state.contract_item_id, line.state.billing_period_start, userId || null]
						);
				for (const line of write.moves)
					await this.updateLine(
						runner,
						holdingId,
						line.id,
						remainderId,
						line.state,
						write.remainder.fx,
						PARTIAL_BY_PO_LINE_FX_SOURCE,
						null
					);
				for (const line of write.creates)
					await insertLineState(runner, holdingId, remainderId, line.state, {
						fx: write.remainder.fx,
						fx_rate_source: PARTIAL_BY_PO_LINE_FX_SOURCE,
						source_line_id: line.from_line_id,
					});
			}
			// Descuento puntual que pasó al saldo: su fila de desvío lo sigue y la cubierta pierde el devengo si ya no le queda ninguno.
			if (remainderId && write.one_off_share > 0)
				await moveOneOffAdjustments(runner, holdingId, invoiceIdCovered, remainderId, write.one_off_share);
			if (write.covered_treatment_cleared)
				await runner.query(`UPDATE invoices SET nc_revenue_treatment = NULL WHERE id = $1 AND holding_id = $2`, [
					invoiceIdCovered,
					holdingId,
				]);
			await refreshInvoiceSystemAmounts(runner, holdingId, [invoiceIdCovered, ...(remainderId ? [remainderId] : [])]);
			if (plan.rsm_from_month) await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, $2::date)`, [contract.id, plan.rsm_from_month]);
			const [event] = (await runner.query(
				`INSERT INTO contract_lifecycle_events (
					contract_id, holding_id, event_type, event_status, title, description, summary, created_by, completed_at, effective_date, metadata
				) VALUES ($1, $2, $3, 'Completed', $4, $5, $5, $6, now(), $7::date, $8::jsonb) RETURNING id`,
				[
					contract.id,
					holdingId,
					INVOICE_EVENT_TYPES.partial_billing,
					`Factura ${plan.covered_invoice.invoice_number ?? ''} facturada por ${plan.reference.type} ${plan.reference.code}`.replace(
						/\s+/g,
						' '
					),
					`${plan.reference.type} ${plan.reference.code} por ${plan.fx.covered_invoice_total} ${plan.covered_invoice.invoice_currency ?? ''}: ${
						plan.covered_lines.length
					} ${plan.covered_lines.length === 1 ? 'línea cubierta' : 'líneas cubiertas'}${
						plan.remainder_invoice
							? `; saldo ${plan.remainder_invoice.totals.amount_contract_currency} a una Por Emitir nueva`
							: '; sin saldo'
					}`.replace(/\s+:/, ':'),
					userId,
					todayIso,
					JSON.stringify({
						source: 'contract_360',
						invoice_id: invoiceIdCovered,
						invoice_number: plan.covered_invoice.invoice_number,
						invoice_ids: [invoiceIdCovered, ...(remainderId ? [remainderId] : [])],
						created_invoices: remainderId ? [remainderId] : [],
						remainder_invoice_id: remainderId,
						reference: { type: plan.reference.type, code: plan.reference.code, date: plan.reference.date },
						amount_invoice_currency: plan.fx.covered_invoice_total,
						covered_total: plan.fx.covered_invoice_total,
						covered_contract_total: plan.fx.covered_contract_total,
						visible_line_id: visibleId,
						visible_line_text: write.visible.description,
						proposal_mode: plan.proposal.mode,
						covered_lines: plan.covered_lines,
						partial_line: plan.partial_line,
						balance_lines: plan.balance_lines,
						balance_total: plan.remainder_invoice?.totals ?? null,
						fx: plan.fx,
						fx_difference: plan.fx.fx_difference,
						covered_before: plan.covered_invoice.before,
						covered_after: plan.covered_invoice.after,
						reason: dto.reason.trim(),
						warnings: plan.warnings.map((warning) => warning.code),
					}),
				]
			)) as Row[];

			return { preview, remainderId, visibleId, eventId: String(event.id) };
		});

		return {
			...result.preview,
			applied: true,
			event_id: result.eventId,
			visible_line_id: result.visibleId,
			remainder_invoice_id: result.remainderId,
			invoice: await this.contracts.invoiceDetail(contract.id, invoiceId, holdingId),
		};
	}

	private previewOf(plan: PartialByPoPlan): PartialByPoPreview {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars, unused-imports/no-unused-vars -- lo que se escribe no va en la respuesta
		const { errors: _errors, write: _write, ...rest } = plan;

		return rest;
	}

	private async plan(
		db: Queryable,
		contractId: string,
		invoiceId: string,
		holdingId: string,
		today: string,
		dto: PartialByPoDto,
		lock: boolean
	): Promise<PartialByPoPlan> {
		const context = await this.invoices.loadContext(db, contractId, holdingId, today);
		const invoice = await this.invoices.loadInvoice(db, contractId, invoiceId, holdingId, lock);
		const [editCtx, [generator], references] = await Promise.all([
			this.edit.loadEditContext(db, contractId, invoice.id, holdingId, today, null),
			db.query(GENERATOR_SQL, [contractId, holdingId]) as Promise<Row[]>,
			db.query(`SELECT r.document_type_code, r.document_number FROM invoice_references r WHERE r.invoice_id = $1 AND r.holding_id = $2`, [
				invoice.id,
				holdingId,
			]) as Promise<Row[]>,
		]);
		const plan = planPartialByPo(
			{
				invoice,
				lines: editCtx.lines,
				context,
				rules: this.reorganize.rulesOf(generator ?? {}),
				render: {
					template: editCtx.template,
					contract_number: editCtx.contract_number,
					client_name: editCtx.client_name,
					references: editCtx.references,
					contract_currency: invoice.contract_currency,
					invoice_currency: invoice.invoice_currency,
					fx_rate: isMultiCurrency(invoice) ? invoiceFx(invoice) : null,
					max_chars: editCtx.max_chars,
				},
				max_chars: editCtx.max_chars,
				references: references.map((row) => ({
					document_type_code: toText(row.document_type_code) ?? '',
					document_number: toText(row.document_number) ?? '',
				})),
			},
			dto
		);

		if (plan.errors.length) throw validationException(plan.errors);

		return plan;
	}

	/**
	 * Factura de saldo: encabezado desde las reglas del generador (como Reorganizar); de la cubierta solo forma de pago, régimen fiscal y serie
	 * (`payment_method`, `fiscal_regime`, `invoice_series`) y, si recibe un descuento puntual, su devengo (`nc_revenue_treatment`).
	 */
	private async insertRemainder(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		coveredId: string,
		remainder: NonNullable<PartialByPoPlan['write']['remainder']>
	): Promise<string> {
		const [row] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
				scheduled_at, original_issue_date, issue_date, due_date,
				vat, tax_rate, amount_contract_currency, amount_invoice_currency, total_invoice_currency,
				contract_currency, invoice_currency, fx_contract_to_invoice,
				status, invoice_type, document_type, export_type, invoice_series,
				holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id, payment_method, fiscal_regime,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, is_active,
				split_from_invoice_id, split_reason, notes, nc_revenue_treatment
			) SELECT
				g.id, g.id, c.company_id, c.client_id, $3::uuid, c.id,
				$4::date, $4::date, $4::date, $5::date,
				$6, $7, $8, $9, $10,
				$11, $12, $13,
				'Por Emitir', 'Automatica', $14, $15, COALESCE(o.invoice_series, 'FAC'),
				c.holding_id, co.legal_name, co.tax_id, co.legal_address, ce.tax_id, o.payment_method, o.fiscal_regime,
				COALESCE(c.requires_references_for_billing, false), COALESCE(c.auto_invoice, false), ${invoiceTermsSql(1)}, true,
				$16::uuid, '${PARTIAL_BY_PO_SPLIT_REASON}', $17, $18
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
				remainder.client_entity_id,
				remainder.issue_date,
				remainder.due_date,
				remainder.header.vat,
				remainder.tax_rate,
				remainder.header.amount_contract_currency,
				remainder.header.amount_invoice_currency,
				remainder.header.total_invoice_currency,
				remainder.contract_currency,
				remainder.invoice_currency,
				remainder.fx,
				remainder.document_type,
				remainder.export_type,
				coveredId,
				remainder.notes,
				remainder.nc_revenue_treatment,
			]
		)) as Row[];

		return String(row.id);
	}

	/** Reescribe una línea (en su factura o movida a otra): montos, tasa, `visible_line_id`; estado y emisión del encabezado donde queda. */
	private async updateLine(
		runner: QueryRunner,
		holdingId: string,
		lineId: string,
		invoiceId: string,
		state: LineState,
		fx: number | null,
		fxSource: string,
		visibleLineId: string | null
	) {
		await runner.query(
			`UPDATE invoice_items SET invoice_id = $3, description = $4, quantity = $5,
				unit_price_contract_currency = $6, subtotal_contract_currency = $7, tax_amount_contract_currency = $8, total_contract_currency = $9,
				unit_price_invoice_currency = $10, subtotal_invoice_currency = $11, tax_amount_invoice_currency = $12, total_invoice_currency = $13,
				pricing_breakdown = $14::jsonb, fx_contract_to_invoice = $15::numeric,
				fx_rate_source = CASE WHEN $15::numeric IS NULL THEN NULL ELSE $16 END, fx_rate_date = CASE WHEN $15::numeric IS NULL THEN NULL ELSE CURRENT_DATE END,
				invoice_currency = (SELECT h.invoice_currency FROM invoices h WHERE h.id = $3), visible_line_id = $17::uuid,
				status = (SELECT h.status FROM invoices h WHERE h.id = $3), issue_date = (SELECT h.issue_date FROM invoices h WHERE h.id = $3),
				updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[
				lineId,
				holdingId,
				invoiceId,
				state.description,
				state.quantity,
				state.unit_price_contract_currency,
				state.subtotal_contract_currency,
				state.tax_contract_currency,
				state.total_contract_currency,
				state.unit_price_invoice_currency,
				state.subtotal_invoice_currency,
				state.tax_invoice_currency,
				state.total_invoice_currency,
				state.pricing_breakdown ? JSON.stringify(state.pricing_breakdown) : null,
				fx,
				fxSource,
				visibleLineId,
			]
		);
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
					`Facturar por OC en el contrato ${contractId} no aplicado: ${error instanceof Error ? error.message : String(error)}`
				);
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
}
