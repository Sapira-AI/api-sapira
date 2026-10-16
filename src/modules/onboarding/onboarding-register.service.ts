import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { type Month, monthRange, monthsBetween } from '@/modules/metrics/metrics-period';
import { legacyRemovedSql } from '@/modules/metrics/mrr-historico';

import {
	encodeLineKey,
	firstDay,
	insertOnboardingEvent,
	isoDate,
	num,
	omitKey,
	type OnboardingActor,
	type Queryable,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';

import type { RegisterHistoryDto, RegisterHistoryInvoiceDto } from './dtos/onboarding.dto';

/** Tope del período que cubre una factura (meses). */
export const REGISTER_MAX_MONTHS = 36;
/** Tolerancia de la suma por producto contra el monto de la factura en moneda de contrato (§3.2b). */
export const SUM_TOLERANCE = 0.01;
/** Diferencia contra el tipo de cambio de referencia del holding que se marca como rara. */
export const FX_OUTLIER_TOLERANCE = 0.2;

export type RegisterWarning = 'sum_mismatch' | 'month_already_covered' | 'fx_outlier' | 'no_client';
/** Motivos por los que una factura no se registra (vista previa: `errors[]`; aplicar: `skipped[].reason`). */
export type RegisterError =
	| 'not_found'
	| 'already_registered'
	| 'invoice_without_items'
	| 'invalid_period'
	| 'invalid_amount'
	| 'product_not_found'
	| 'duplicate_product'
	| 'currency_not_enabled'
	| 'no_client'
	| 'sum_mismatch';

export interface RegisterPlan {
	invoice_id: string;
	invoice_number: string | null;
	client_id: string | null;
	months: Month[];
	mrr_per_month: number;
	fx_contract_to_invoice: number | null;
	products: Array<{ product_id: string; product_name: string | null; amount: number; mrr_per_month: number; covered: Month[] }>;
	warnings: RegisterWarning[];
	errors: RegisterError[];
	input: RegisterHistoryInvoiceDto;
	invoice: Row | null;
}

/** Opciones del registro cuando lo usa el arranque rápido: filas ya empalmadas al contrato recién creado. */
export interface RegisterOptions {
	contractId?: string | null;
	batchId?: string;
}

/**
 * Registrar histórico desde facturas previas (§3.2b): la usuaria indica por factura el período que cubre, el monto en moneda de
 * contrato y los productos con su parte; esto crea las filas de `mrr_legacy` (una por producto × mes: `subtotal_contract_currency` =
 * parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses, `fx_contract_to_invoice` = monto de factura ÷
 * monto de contrato) y marca la factura `reconciliation_status = 'mrr_legacy'`. `mrr_legacy` no tiene `product_id`: se guarda el nombre
 * del catálogo (`product_name`, grano de la línea). Un mes ya cubierto por la misma línea no se repite.
 */
@Injectable()
export class OnboardingRegisterService {
	constructor(private readonly dataSource: DataSource) {}

	async preview(holdingId: string, dto: RegisterHistoryDto) {
		const plans = await this.plan(this.dataSource, holdingId, dto.invoices);

		return {
			rows: plans.map((plan) => ({
				invoice_id: plan.invoice_id,
				invoice_number: plan.invoice_number,
				months: plan.months,
				mrr_per_month: plan.mrr_per_month,
				fx_contract_to_invoice: plan.fx_contract_to_invoice,
				products: plan.products.map((product) => omitKey(product, 'covered')),
				warnings: plan.warnings,
				errors: plan.errors,
			})),
			summary: {
				invoices: plans.length,
				ready: plans.filter((plan) => !this.blockerOf(plan)).length,
				with_warnings: plans.filter((plan) => plan.warnings.length).length,
				with_errors: plans.filter((plan) => this.blockerOf(plan)).length,
				rows_to_create: plans.filter((plan) => !this.blockerOf(plan)).reduce((sum, plan) => sum + this.rowsOf(plan), 0),
			},
		};
	}

	async register(holdingId: string, dto: RegisterHistoryDto, actor: OnboardingActor) {
		return await withApiWriter(this.dataSource, async (runner) => this.registerInTx(runner, holdingId, dto.invoices, actor));
	}

	/** Registro dentro de una transacción abierta (con la marca ya fijada). Lo usa también el arranque rápido. */
	async registerInTx(
		runner: Queryable,
		holdingId: string,
		invoices: RegisterHistoryInvoiceDto[],
		actor: OnboardingActor,
		options: RegisterOptions = {}
	) {
		const plans = await this.plan(runner, holdingId, invoices, true);
		const batchId = options.batchId ?? randomUUID();
		const skipped: Array<{ invoice_id: string; reason: RegisterError }> = [];
		const lines = new Set<string>();
		let created = 0;

		for (const plan of plans) {
			const blocker = this.blockerOf(plan);

			if (blocker) {
				skipped.push({ invoice_id: plan.invoice_id, reason: blocker });
				continue;
			}
			const inserted = await this.insertRows(runner, holdingId, plan, actor, batchId, options.contractId ?? null);

			created += inserted;
			for (const product of plan.products) {
				lines.add(
					encodeLineKey({
						client_id: plan.client_id!,
						product_name: product.product_name!,
						contract_currency: plan.input.contract_currency,
					})
				);
			}
			await runner.query(
				`UPDATE invoices_legacy SET reconciliation_status = 'mrr_legacy'${options.contractId ? ', contract_id = COALESCE(contract_id, $3)' : ''}
				WHERE id = $1 AND holding_id = $2`,
				options.contractId ? [plan.invoice_id, holdingId, options.contractId] : [plan.invoice_id, holdingId]
			);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_registered',
				entityType: 'invoice_legacy',
				entityId: plan.invoice_id,
				payload: {
					batch_id: batchId,
					period_from: plan.input.period_from,
					period_to: plan.input.period_to,
					contract_currency: plan.input.contract_currency,
					amount_contract_currency: plan.input.amount_contract_currency,
					products: plan.products.map((product) => ({
						product_id: product.product_id,
						product_name: product.product_name,
						amount: product.amount,
					})),
					rows: inserted,
					contract_id: options.contractId ?? null,
					warnings: plan.warnings,
				},
			});
		}

		return { created_rows: created, lines_touched: [...lines], skipped, batch_id: batchId };
	}

	/** Lo que bloquea aplicar (el primero); los avisos no bloquean salvo la suma que no cuadra. */
	blockerOf(plan: RegisterPlan): RegisterError | null {
		return plan.errors[0] ?? (plan.warnings.includes('sum_mismatch') ? 'sum_mismatch' : null);
	}

	private rowsOf(plan: RegisterPlan): number {
		return plan.products.reduce((sum, product) => sum + plan.months.filter((month) => !product.covered.includes(month)).length, 0);
	}

	/** Valida y arma el plan de cada factura. */
	async plan(db: Queryable, holdingId: string, inputs: RegisterHistoryInvoiceDto[], lock = false): Promise<RegisterPlan[]> {
		const invoiceIds = [...new Set(inputs.map((input) => input.invoice_id))];
		const productIds = [...new Set(inputs.flatMap((input) => input.products.map((product) => product.product_id)))];
		const [invoices, products, currencies, fxRefs] = await Promise.all([
			db.query(
				`SELECT il.id, il.invoice_number, il.issue_date, il.company_id, il.client_tax_id, il.legal_client_name, il.invoice_currency,
					il.amount_invoice_currency, il.total_invoice_currency, il.vat, il.status, ce.tax_id AS entity_tax_id,
					COALESCE(il.client_id, ce.client_id) AS client_id, it.id AS item_id, it.subtotal AS item_subtotal, it.description AS item_description,
					it.currency AS item_currency, EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id) AS has_history
				FROM invoices_legacy il
				LEFT JOIN client_entities ce ON ce.id = il.client_entity_id
				LEFT JOIN LATERAL (
					SELECT ii.id, ii.subtotal, ii.description, ii.currency FROM invoice_items_legacy ii
					WHERE ii.invoices_legacy_id = il.id ORDER BY ii.created_at, ii.id LIMIT 1
				) it ON true
				WHERE il.holding_id = $1 AND il.id = ANY($2::uuid[])${lock ? '\n\t\t\t\tFOR UPDATE OF il' : ''}`,
				[holdingId, invoiceIds]
			) as Promise<Row[]>,
			db.query(`SELECT id, name FROM products WHERE holding_id = $1 AND id = ANY($2::uuid[])`, [holdingId, productIds]) as Promise<Row[]>,
			db.query(`SELECT code FROM currencies WHERE is_active = true`) as Promise<Row[]>,
			db.query(
				`SELECT contract_currency, invoice_currency, percentile_cont(0.5) WITHIN GROUP (ORDER BY fx_contract_to_invoice) AS fx
				FROM mrr_legacy WHERE holding_id = $1 AND fx_contract_to_invoice > 0 GROUP BY contract_currency, invoice_currency`,
				[holdingId]
			) as Promise<Row[]>,
		]);
		const invoiceById = new Map(invoices.map((row) => [String(row.id), row]));
		const productById = new Map(products.map((row) => [String(row.id), str(row.name)]));
		const known = new Set(currencies.map((row) => String(row.code)));
		const fxRef = new Map(fxRefs.map((row) => [`${row.contract_currency}|${row.invoice_currency}`, num(row.fx)]));
		const clientIds = [...new Set(invoices.map((row) => str(row.client_id)).filter(Boolean))] as string[];
		const covered = clientIds.length
			? ((await db.query(
					`SELECT DISTINCT m.client_id, m.product_name, m.contract_currency, to_char(m.period_month, 'YYYY-MM') AS period
				FROM mrr_legacy m WHERE m.holding_id = $1 AND m.client_id = ANY($2::uuid[]) AND NOT ${legacyRemovedSql('m')}`,
					[holdingId, clientIds]
				)) as Row[])
			: [];
		const coverage = new Set(covered.map((row) => `${row.client_id}|${row.product_name}|${row.contract_currency}|${row.period}`));

		return inputs.map((input) => {
			const invoice = invoiceById.get(input.invoice_id) ?? null;
			const errors: RegisterError[] = [];
			const warnings: RegisterWarning[] = [];
			const validPeriod =
				monthsBetween(input.period_from, input.period_to) >= 0 && monthsBetween(input.period_from, input.period_to) < REGISTER_MAX_MONTHS;
			const months = validPeriod ? monthRange(input.period_from, input.period_to) : [];
			const clientId = str(invoice?.client_id);
			const invoiceAmount = num(invoice?.amount_invoice_currency);
			const fx = input.amount_contract_currency !== 0 ? invoiceAmount / input.amount_contract_currency : null;

			if (!invoice) errors.push('not_found');
			else if (invoice.has_history === true) errors.push('already_registered');
			else if (!invoice.item_id) errors.push('invoice_without_items');
			if (!validPeriod) errors.push('invalid_period');
			if ((fx === null && invoiceAmount !== 0) || (fx !== null && fx <= 0)) errors.push('invalid_amount');
			if (known.size && !known.has(input.contract_currency)) errors.push('currency_not_enabled');
			if (input.products.some((product) => !productById.has(product.product_id))) errors.push('product_not_found');
			if (new Set(input.products.map((product) => product.product_id)).size !== input.products.length) errors.push('duplicate_product');
			if (invoice && !clientId) {
				warnings.push('no_client');
				errors.push('no_client');
			}
			const sum = input.products.reduce((total, product) => total + product.amount_contract_currency, 0);

			if (Math.abs(sum - input.amount_contract_currency) > Math.abs(input.amount_contract_currency) * SUM_TOLERANCE + 0.005)
				warnings.push('sum_mismatch');
			if (fx !== null && invoice) {
				const sameCurrency = String(invoice.invoice_currency) === input.contract_currency;
				const reference = fxRef.get(`${input.contract_currency}|${invoice.invoice_currency}`);

				if (
					(sameCurrency && Math.abs(fx - 1) > SUM_TOLERANCE) ||
					(!sameCurrency && reference && Math.abs(fx / reference - 1) > FX_OUTLIER_TOLERANCE)
				) {
					warnings.push('fx_outlier');
				}
			}
			const planProducts = input.products.map((product) => {
				const name = productById.get(product.product_id) ?? null;
				const productCovered =
					clientId && name ? months.filter((month) => coverage.has(`${clientId}|${name}|${input.contract_currency}|${month}`)) : [];

				return {
					product_id: product.product_id,
					product_name: name,
					amount: product.amount_contract_currency,
					mrr_per_month: months.length ? round2(product.amount_contract_currency / months.length) : 0,
					covered: productCovered,
				};
			});

			if (planProducts.some((product) => product.covered.length)) warnings.push('month_already_covered');

			return {
				invoice_id: input.invoice_id,
				invoice_number: str(invoice?.invoice_number),
				client_id: clientId,
				months,
				mrr_per_month: months.length ? round2(input.amount_contract_currency / months.length) : 0,
				fx_contract_to_invoice: fx === null ? null : round6(fx),
				products: planProducts,
				warnings: [...new Set(warnings)],
				errors: [...new Set(errors)],
				input,
				invoice,
			};
		});
	}

	/** Una fila por producto × mes no cubierto (`split_index` = posición del producto). Un solo INSERT por factura. */
	private async insertRows(
		db: Queryable,
		holdingId: string,
		plan: RegisterPlan,
		actor: OnboardingActor,
		batchId: string,
		contractId: string | null
	) {
		const invoice = plan.invoice!;
		const term = plan.months.length;
		const recurring = plan.input.is_recurring !== false;
		const fx = plan.fx_contract_to_invoice ?? 1;
		const values: unknown[] = [];
		const tuples: string[] = [];

		plan.products.forEach((product, index) => {
			for (const month of plan.months) {
				if (product.covered.includes(month)) continue;
				const row = [
					holdingId,
					plan.invoice_id,
					invoice.item_id,
					index + 1,
					invoice.company_id,
					str(invoice.client_tax_id) ?? str(invoice.entity_tax_id) ?? '',
					invoice.legal_client_name,
					invoice.invoice_number,
					isoDate(invoice.issue_date),
					invoice.invoice_currency,
					num(invoice.amount_invoice_currency),
					num(invoice.total_invoice_currency),
					invoice.vat ?? null,
					invoice.status,
					str(invoice.item_description) ?? product.product_name,
					str(invoice.item_currency) ?? invoice.invoice_currency,
					num(invoice.item_subtotal),
					round2(product.amount * fx),
					plan.client_id,
					plan.input.contract_currency,
					product.amount,
					product.product_name,
					term,
					firstDay(month),
					recurring,
					Math.max(round6(fx), 0.000001),
					recurring ? round2(product.amount / term) : null,
					recurring ? 'EOP' : null,
					actor.userId || null,
					batchId,
					contractId,
					contractId ? actor.userId || null : null,
				];
				const base = values.length;

				values.push(...row);
				// `period_month` (posición 24) va tipado como fecha; `migrated_at` = now() solo si nace empalmada.
				tuples.push(`(${row.map((_, i) => `$${base + i + 1}${i === 23 ? '::date' : ''}`).join(', ')}, ${contractId ? 'now()' : 'NULL'})`);
			}
		});
		if (!tuples.length) return 0;
		await db.query(
			`INSERT INTO mrr_legacy (holding_id, invoice_legacy_id, invoice_item_legacy_id, split_index, company_id, client_tax_id,
				legal_client_name, invoice_number, issue_date, invoice_currency, amount_invoice_currency, total_invoice_currency, vat, status,
				description, currency, subtotal, allocated_invoice_currency, client_id, contract_currency, subtotal_contract_currency,
				product_name, term, period_month, is_recurring, fx_contract_to_invoice, mrr_legacy, momentum, created_by, batch_id,
				migrated_to_contract_id, migrated_by, migrated_at)
			VALUES ${tuples.join(',\n')}
			ON CONFLICT (invoice_item_legacy_id, split_index, period_month) DO NOTHING`,
			values
		);

		return tuples.length;
	}
}
