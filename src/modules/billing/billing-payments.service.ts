import { randomUUID } from 'crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { todayFor } from '@/modules/contracts/business-date';
import { voidedSql } from '@/modules/contracts/contract-360';
import { resolveUserId } from '@/modules/contracts/contract-drafts.service';

import {
	type BillingBlocker,
	PAYMENT_EVENT_TYPES,
	type PaymentInput,
	type PaymentInvoiceRow,
	type PaymentPlan,
	planPayments,
	type SettlementReason,
	statusAfterPayments,
} from './billing-states';

import type { RegisterPaymentDto, VoidPaymentDto } from './dtos/billing.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

/**
 * Opciones internas de `register` (no se exponen en el DTO público de `POST /billing/payments`): las usa la conciliación bancaria
 * (spec-conciliacion-v2 §4 "Single path de pagos").
 * - `runner`: transacción ya abierta por el llamador con `withApiWriter` (si no, `register` abre la suya).
 * - `bankMovementId`: movimiento de cartola que origina el pago (`invoice_payments.bank_movement_id`).
 * - `settlementReason`: ajuste no monetario (`method = 'adjustment'`): salda sin contar como Cobrado.
 * - `originalAmounts` (por factura) + `fxRate` + `originalCurrency`: pago en moneda distinta a la del movimiento (monto en la moneda del
 *   movimiento, tipo de cambio = unidades de moneda de la factura por 1 de la del movimiento).
 * - `allowMultipleClients`: `client_mismatch` pasa a aviso `multiple_clients` (solo camino manual).
 * Las columnas nuevas (M1, migración 1790740000000) solo entran al INSERT si vienen, así `POST /billing/payments` sigue igual antes de aplicarla.
 */
export interface RegisterPaymentOptions {
	runner?: QueryRunner;
	bankMovementId?: string;
	settlementReason?: SettlementReason;
	originalAmounts?: Record<string, number>;
	originalCurrency?: string;
	fxRate?: number;
	allowMultipleClients?: boolean;
}

const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : text(value));

/** Factura con lo que necesita un pago: total, pagos confirmados en su moneda, anulada, cierre de período de la compañía. */
const PAYMENT_INVOICE_SELECT = `SELECT i.id, i.invoice_number, i.status, i.document_type, i.is_active, i.contract_id,
		COALESCE(i.client_id, c.client_id) AS client_id, UPPER(COALESCE(i.invoice_currency, i.contract_currency)) AS invoice_currency,
		COALESCE(i.total_invoice_currency, i.amount_invoice_currency) AS total, i.due_date::text AS due_date, i.odoo_invoice_id, i.sent_to_odoo_at,
		${voidedSql('i')} AS voided,
		COALESCE((SELECT SUM(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id AND p.holding_id = i.holding_id AND p.confirmed = true
			AND UPPER(p.currency) = UPPER(COALESCE(i.invoice_currency, i.contract_currency))), 0) AS paid,
		public.get_cutoff_date(i.holding_id, i.company_id)::text AS cutoff_date
	FROM invoices i
	LEFT JOIN contracts c ON c.id = i.contract_id AND c.holding_id = i.holding_id`;

const paymentInvoiceOf = (row: Row): PaymentInvoiceRow => ({
	id: String(row.id),
	invoice_number: text(row.invoice_number),
	status: text(row.status),
	document_type: text(row.document_type),
	is_active: row.is_active !== false,
	voided: row.voided === true,
	client_id: text(row.client_id),
	contract_id: text(row.contract_id),
	invoice_currency: text(row.invoice_currency),
	total: num(row.total),
	paid: Number(row.paid ?? 0) || 0,
	due_date: text(row.due_date),
	odoo_invoice_id: num(row.odoo_invoice_id),
	sent_to_odoo_at: iso(row.sent_to_odoo_at),
	cutoff_date: text(row.cutoff_date),
});

/**
 * Pagos de Facturación v2 (spec §4.5, §5.2, §6.7): registrar (una o varias facturas emitidas del mismo cliente y moneda, todo o nada) y anular
 * el registro (nunca DELETE: `confirmed = false`). Cada escritura es una transacción con `setApiWriter` como primera sentencia, facturas con
 * `FOR UPDATE`, estado recalculado en la API (`statusAfterPayments`: Pagada solo con Σ ≥ total en la moneda de la factura; al anular vuelve
 * a Emitida/Enviada/Vencida) y evento por factura con contrato. El trigger legacy `after_invoice_payment_change` → `recalc_invoice_status`
 * queda no-op para `sapira.writer = 'api'` con su asset; mientras no se aplique, la API reescribe el estado después del INSERT/UPDATE.
 */
@Injectable()
export class BillingPaymentsService {
	constructor(private readonly dataSource: DataSource) {}

	async preview(holdingId: string, dto: RegisterPaymentDto, now = new Date()) {
		const invoices = await this.loadInvoices(
			this.dataSource,
			holdingId,
			dto.allocations.map((allocation) => allocation.invoice_id)
		);

		return planPayments(invoices, dto, todayFor(null, now));
	}

	/**
	 * Carga las facturas (con `FOR UPDATE` si `lock`) y arma el plan sin escribir. Lo usa la conciliación para su vista previa y validación
	 * (mismo plan y mismos bloqueos que `register`, sin duplicar el SQL de la factura).
	 */
	async plan(
		db: Queryable,
		holdingId: string,
		input: PaymentInput,
		today: string,
		options: { allowMultipleClients?: boolean; lock?: boolean } = {}
	): Promise<{ invoices: PaymentInvoiceRow[]; plan: PaymentPlan }> {
		const invoices = await this.loadInvoices(
			db,
			holdingId,
			input.allocations.map((allocation) => allocation.invoice_id),
			options.lock === true
		);

		return { invoices, plan: planPayments(invoices, input, today, { allowMultipleClients: options.allowMultipleClients }) };
	}

	async register(holdingId: string, dto: RegisterPaymentDto, authId: string, now = new Date(), options: RegisterPaymentOptions = {}) {
		const userId = await resolveUserId(this.dataSource, authId);
		const today = todayFor(null, now);

		return await this.within(options.runner, async (runner) => {
			const { plan } = await this.plan(runner, holdingId, dto, today, { allowMultipleClients: options.allowMultipleClients, lock: true });

			if (!plan.can_apply) throw this.blocked([...plan.blockers, ...plan.allocations.flatMap((allocation) => allocation.blockers)], plan);
			const paymentIds: string[] = [];
			const eventIds: string[] = [];
			const groupId = randomUUID();
			const hasFx = options.fxRate !== undefined && options.fxRate !== null && !!options.originalAmounts;

			for (const allocation of plan.allocations) {
				const columns = [
					'invoice_id',
					'holding_id',
					'amount',
					'currency',
					'payment_date',
					'method',
					'reference',
					'notes',
					'confirmed',
					'created_by',
				];
				const values = ['$1', '$2', '$3', '$4', '$5::date', '$6', '$7', '$8', 'true', '$9'];
				const params: unknown[] = [
					allocation.invoice_id,
					holdingId,
					allocation.amount,
					plan.currency,
					dto.payment_date,
					dto.method ?? null,
					dto.reference ?? null,
					dto.notes ?? null,
					userId,
				];
				const extra = (column: string, value: unknown) => {
					params.push(value);
					columns.push(column);
					values.push(`$${params.length}`);
				};
				const original = hasFx ? options.originalAmounts?.[allocation.invoice_id] : undefined;

				if (options.bankMovementId) extra('bank_movement_id', options.bankMovementId);
				if (original !== undefined && original !== null) {
					extra('original_amount', original);
					extra('fx_rate', options.fxRate);
				}
				if (options.settlementReason) extra('settlement_reason', options.settlementReason);
				const [payment] = (await runner.query(
					`INSERT INTO invoice_payments (${columns.join(', ')})
					VALUES (${values.join(', ')}) RETURNING id`,
					params
				)) as Row[];

				paymentIds.push(String(payment.id));
			}
			// Estado final por factura (una factura puede venir en varias asignaciones: manda la última foto del plan).
			const finals = new Map(plan.allocations.map((allocation) => [allocation.invoice_id, allocation]));

			for (const allocation of finals.values()) {
				await this.writeStatus(runner, holdingId, allocation.invoice_id, allocation.after.status);
				if (!allocation.contract_id) continue;
				eventIds.push(
					await this.insertEvent(runner, allocation.contract_id, holdingId, userId, {
						type: PAYMENT_EVENT_TYPES.registered,
						title: `Pago registrado: factura ${allocation.invoice_number ?? ''}`.trim(),
						description: `Pago de ${allocation.amount} ${plan.currency} el ${dto.payment_date}; estado ${allocation.before.status ?? ''} → ${allocation.after.status ?? ''}`,
						effective_date: dto.payment_date,
						metadata: {
							invoice_id: allocation.invoice_id,
							invoice_number: allocation.invoice_number,
							payment_ids: paymentIds.filter((_, index) => plan.allocations[index].invoice_id === allocation.invoice_id),
							payment_group_id: groupId,
							amount: plan.allocations
								.filter((entry) => entry.invoice_id === allocation.invoice_id)
								.reduce((sum, entry) => sum + entry.amount, 0),
							currency: plan.currency,
							payment_date: dto.payment_date,
							method: dto.method ?? null,
							reference: dto.reference ?? null,
							before: allocation.before,
							after: allocation.after,
							...this.reconciliationMetadata(allocation.invoice_id, options, hasFx),
						},
					})
				);
			}

			return { ...plan, applied: true, payment_group_id: groupId, payment_ids: paymentIds, event_ids: eventIds };
		});
	}

	async void(holdingId: string, paymentId: string, dto: VoidPaymentDto, authId: string, now = new Date(), options: { runner?: QueryRunner } = {}) {
		const userId = await resolveUserId(this.dataSource, authId);
		const today = todayFor(null, now);

		return await this.within(options.runner, async (runner) => {
			const [payment] = (await runner.query(
				`SELECT p.id, p.invoice_id, p.amount, p.currency, p.payment_date::text AS payment_date, p.confirmed
				FROM invoice_payments p WHERE p.id = $1 AND p.holding_id = $2`,
				[paymentId, holdingId]
			)) as Row[];

			if (!payment) throw new NotFoundException('Pago no encontrado');
			const [invoice] = await this.loadInvoices(runner, holdingId, [String(payment.invoice_id)], true);
			const blockers: BillingBlocker[] = [];

			if (payment.confirmed !== true) blockers.push({ code: 'already_voided', message: 'El pago ya está anulado', next_step: null });
			if (invoice.cutoff_date && text(payment.payment_date)! <= invoice.cutoff_date) {
				blockers.push({
					code: 'period_closed',
					message: `El pago es del ${text(payment.payment_date)}, en un período cerrado (cierre al ${invoice.cutoff_date})`,
					next_step: 'Reabre el período en Configuración para anularlo',
				});
			}
			const countsForInvoice = text(payment.currency)?.toUpperCase() === invoice.invoice_currency;
			const paidAfter = Math.max(invoice.paid - (countsForInvoice ? Number(payment.amount) || 0 : 0), 0);
			const before = { status: invoice.status, paid: invoice.paid };
			const after = { status: statusAfterPayments({ ...invoice, paid: paidAfter }, today), paid: paidAfter };

			if (blockers.length) throw this.blocked(blockers, { payment_id: paymentId, invoice_id: invoice.id, before, after: before });
			await runner.query(`UPDATE invoice_payments SET confirmed = false WHERE id = $1 AND holding_id = $2`, [paymentId, holdingId]);
			await this.writeStatus(runner, holdingId, invoice.id, after.status);
			const eventId = invoice.contract_id
				? await this.insertEvent(runner, invoice.contract_id, holdingId, userId, {
						type: PAYMENT_EVENT_TYPES.voided,
						title: `Pago anulado: factura ${invoice.invoice_number ?? ''}`.trim(),
						description: `Se anuló el registro del pago de ${Number(payment.amount)} ${text(payment.currency) ?? ''} del ${text(payment.payment_date)}: ${dto.reason}`,
						effective_date: today,
						metadata: {
							invoice_id: invoice.id,
							invoice_number: invoice.invoice_number,
							payment_id: paymentId,
							amount: Number(payment.amount),
							currency: text(payment.currency),
							payment_date: text(payment.payment_date),
							reason: dto.reason,
							before,
							after,
						},
					})
				: null;

			return { payment_id: paymentId, invoice_id: invoice.id, voided: true as const, before, after, event_id: eventId };
		});
	}

	// ---------------------------------------------------------------- infraestructura

	/** Metadatos de conciliación del evento (solo los presentes): movimiento, motivo del ajuste y moneda/monto/tipo de cambio originales. */
	private reconciliationMetadata(invoiceId: string, options: RegisterPaymentOptions, hasFx: boolean): Record<string, unknown> {
		const metadata: Record<string, unknown> = {};
		const original = hasFx ? options.originalAmounts?.[invoiceId] : undefined;

		if (options.bankMovementId) metadata.bank_movement_id = options.bankMovementId;
		if (options.settlementReason) metadata.settlement_reason = options.settlementReason;
		if (original !== undefined && original !== null) {
			metadata.original_amount = original;
			metadata.original_currency = options.originalCurrency?.toUpperCase() ?? null;
			metadata.fx_rate = options.fxRate;
		}

		return metadata;
	}

	/** Corre en la transacción del llamador (ya abierta con `withApiWriter`) o abre la propia. */
	private async within<T>(runner: QueryRunner | undefined, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		return runner ? await work(runner) : await this.transaction(work);
	}

	private async loadInvoices(db: Queryable, holdingId: string, ids: string[], lock = false): Promise<PaymentInvoiceRow[]> {
		const unique = [...new Set(ids)];
		const rows = (await db.query(
			`${PAYMENT_INVOICE_SELECT} WHERE i.holding_id = $1 AND i.id = ANY($2::uuid[]) ORDER BY i.id${lock ? ' FOR UPDATE OF i' : ''}`,
			[holdingId, unique]
		)) as Row[];
		const missing = unique.filter((id) => !rows.some((row) => String(row.id) === id));

		if (missing.length) throw new NotFoundException(`Facturas no encontradas en el holding: ${missing.join(', ')}`);

		return rows.map(paymentInvoiceOf);
	}

	/** Escribe el estado calculado siempre después del INSERT/UPDATE del pago (pisa lo que haya hecho el trigger legacy si aún corre). */
	private async writeStatus(runner: QueryRunner, holdingId: string, invoiceId: string, status: string | null) {
		if (!status) return;
		await runner.query(`UPDATE invoices SET status = $3 WHERE id = $1 AND holding_id = $2 AND status IS DISTINCT FROM $3`, [
			invoiceId,
			holdingId,
			status,
		]);
	}

	private async insertEvent(
		runner: QueryRunner,
		contractId: string,
		holdingId: string,
		userId: string,
		event: { type: string; title: string; description: string; effective_date: string | null; metadata: Record<string, unknown> }
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
				JSON.stringify({ source: 'billing', ...event.metadata }),
			]
		)) as Row[];

		return String(row.id);
	}

	private async transaction<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
		return await withApiWriter(this.dataSource, work);
	}

	private blocked(blockers: BillingBlocker[], preview: PaymentPlan | Record<string, unknown>): ConflictException {
		return new ConflictException({
			message: `No se puede aplicar: ${blockers.map((blocker) => blocker.message).join('; ')}`,
			code: 'blocked',
			blockers,
			preview,
		});
	}
}
