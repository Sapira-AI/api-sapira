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
/** Monedas distintas con tipo de cambio implícito entre 0,98 y 1,02: casi seguro el monto de contrato se copió del de factura. */
export const FX_ONE_TOLERANCE = 0.02;

export type FxWarning = 'fx_outlier' | 'fx_one_with_different_currencies';
export type RegisterWarning = 'sum_mismatch' | 'month_already_covered' | 'no_client' | FxWarning;

/** Mediana del tipo de cambio contrato → factura del MRR histórico del holding, por par `contrato|factura` (referencia de `fx_outlier`). */
export async function loadFxReferences(db: Queryable, holdingId: string): Promise<Map<string, number>> {
	const rows = (await db.query(
		`SELECT contract_currency, invoice_currency, percentile_cont(0.5) WITHIN GROUP (ORDER BY fx_contract_to_invoice) AS fx
		FROM mrr_legacy WHERE holding_id = $1 AND fx_contract_to_invoice > 0 GROUP BY contract_currency, invoice_currency`,
		[holdingId]
	)) as Row[];

	return new Map(rows.map((row) => [`${row.contract_currency}|${row.invoice_currency}`, num(row.fx)]));
}

/**
 * Avisos del tipo de cambio implícito contrato → factura (una sola regla para Registrar histórico, el arranque rápido, la importación con
 * histórico y Editar línea): `fx_outlier` = misma moneda con fx ≠ 1 (±1 %) o ±20 % de la mediana del holding para el par;
 * `fx_one_with_different_currencies` = monedas distintas con fx entre 0,98 y 1,02.
 */
export function fxWarningsOf(
	invoiceCurrency: string | null | undefined,
	contractCurrency: string,
	fx: number | null,
	references: Map<string, number>
): FxWarning[] {
	if (fx === null || !invoiceCurrency || fx <= 0) return [];
	const warnings: FxWarning[] = [];
	const same = String(invoiceCurrency).toUpperCase() === contractCurrency.toUpperCase();
	const reference = references.get(`${contractCurrency}|${invoiceCurrency}`);

	if ((same && Math.abs(fx - 1) > SUM_TOLERANCE) || (!same && reference && Math.abs(fx / reference - 1) > FX_OUTLIER_TOLERANCE)) {
		warnings.push('fx_outlier');
	}
	if (!same && Math.abs(fx - 1) <= FX_ONE_TOLERANCE) warnings.push('fx_one_with_different_currencies');

	return warnings;
}
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
	invoice_currency: string | null;
	amount_invoice_currency: number | null;
	months: Month[];
	mrr_per_month: number;
	fx_contract_to_invoice: number | null;
	products: Array<{ product_id: string; product_name: string | null; amount: number; mrr_per_month: number; covered: Month[] }>;
	warnings: RegisterWarning[];
	errors: RegisterError[];
	input: RegisterHistoryInvoiceDto;
	invoice: Row | null;
}

/**
 * Volver a registrar facturas que ya tienen MRR histórico ("Editar línea", Domi 14-10): no rige `already_registered`, el cliente es el de
 * la línea, los meses de las filas que se reemplazan no cuentan como cubiertos y el tipo de cambio parte del monto en moneda de factura
 * que la línea tenía asignado (no del neto completo de la factura, que puede repartirse en otras líneas).
 */
export interface ReplaceOptions {
	clientId: string;
	/** Filas que se reemplazan (en la vista previa siguen en la base). */
	excludeRowIds: string[];
	/** Monto en moneda de factura de la parte de la línea, por factura. */
	invoiceAmounts: Map<string, number>;
}

/** Opciones del registro: el arranque rápido (filas ya empalmadas al contrato recién creado) y "Editar línea" (`replace`). */
export interface RegisterOptions {
	contractId?: string | null;
	batchId?: string;
	replace?: ReplaceOptions;
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
		const lines = await this.linesOf(this.dataSource, holdingId, plans);

		return {
			rows: plans.map((plan, index) => ({
				invoice_id: plan.invoice_id,
				invoice_number: plan.invoice_number,
				invoice_currency: plan.invoice_currency,
				amount_invoice_currency: plan.amount_invoice_currency,
				months: plan.months,
				mrr_per_month: plan.mrr_per_month,
				fx_contract_to_invoice: plan.fx_contract_to_invoice,
				products: plan.products.map((product, position) => ({ ...omitKey(product, 'covered'), ...lines.rows[index].products[position] })),
				line_key: lines.rows[index].line_key,
				line_exists: lines.rows[index].line_exists,
				warnings: plan.warnings,
				errors: plan.errors,
			})),
			summary: {
				invoices: plans.length,
				ready: plans.filter((plan) => !this.blockerOf(plan)).length,
				with_warnings: plans.filter((plan) => plan.warnings.length).length,
				with_errors: plans.filter((plan) => this.blockerOf(plan)).length,
				rows_to_create: plans.filter((plan) => !this.blockerOf(plan)).reduce((sum, plan) => sum + this.rowsOf(plan), 0),
				lines_touched: lines.touched,
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
		const plans = await this.plan(runner, holdingId, invoices, true, options.replace);
		const batchId = options.batchId ?? randomUUID();
		// Al volver a registrar, la línea de factura puede tener filas de otras líneas: los `split_index` nuevos van después de los usados.
		const itemIds = [...new Set(plans.map((plan) => str(plan.invoice?.item_id)).filter(Boolean))] as string[];
		const splitBase = new Map(
			options.replace && itemIds.length
				? (
						(await runner.query(
							`SELECT invoice_item_legacy_id AS item_id, MAX(split_index) AS max_split FROM mrr_legacy
						WHERE invoice_item_legacy_id = ANY($1::uuid[]) GROUP BY invoice_item_legacy_id`,
							[itemIds]
						)) as Row[]
					).map((row) => [String(row.item_id), num(row.max_split)])
				: []
		);
		const skipped: Array<{ invoice_id: string; reason: RegisterError }> = [];
		const lines = new Set<string>();
		let created = 0;

		for (const plan of plans) {
			const blocker = this.blockerOf(plan);

			if (blocker) {
				skipped.push({ invoice_id: plan.invoice_id, reason: blocker });
				continue;
			}
			const inserted = await this.insertRows(
				runner,
				holdingId,
				plan,
				actor,
				batchId,
				options.contractId ?? null,
				splitBase.get(String(plan.invoice?.item_id)) ?? 0
			);

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

	/**
	 * Línea a la que se sumaría cada factura (Domi 18-10), con la misma clave que usa `registerInTx` (`lines_touched`): cliente comercial |
	 * producto del catálogo | moneda de contrato, codificada como la URL. Por producto (`products[].line_key/line_exists`) y por fila la del
	 * primer producto (una factura con varios productos cae en varias líneas). `null` si falta el cliente o el producto. `line_exists` = la
	 * línea ya tiene filas en el holding (cualquier estado). `touched` = claves distintas de las facturas que se aplicarían (sin bloqueo),
	 * igual que el `lines_touched` de aplicar. Solo lectura.
	 */
	async linesOf(db: Queryable, holdingId: string, plans: RegisterPlan[]) {
		const keyOf = (plan: RegisterPlan, productName: string | null) =>
			plan.client_id && productName
				? encodeLineKey({ client_id: plan.client_id, product_name: productName, contract_currency: plan.input.contract_currency })
				: null;
		const clientIds = [...new Set(plans.map((plan) => plan.client_id).filter(Boolean))] as string[];
		const existing = clientIds.length
			? new Set(
					(
						(await db.query(
							`SELECT DISTINCT m.client_id, m.product_name, m.contract_currency FROM mrr_legacy m
							WHERE m.holding_id = $1 AND m.client_id = ANY($2::uuid[])`,
							[holdingId, clientIds]
						)) as Row[]
					).map((row) =>
						encodeLineKey({
							client_id: String(row.client_id),
							product_name: String(row.product_name ?? ''),
							contract_currency: String(row.contract_currency ?? ''),
						})
					)
				)
			: new Set<string>();
		const rows = plans.map((plan) => {
			const products = plan.products.map((product) => {
				const key = keyOf(plan, product.product_name);

				return { line_key: key, line_exists: key ? existing.has(key) : false };
			});

			return { line_key: products[0]?.line_key ?? null, line_exists: products[0]?.line_exists ?? false, products };
		});
		const touched = [
			...new Set(
				plans.flatMap((plan, index) => (this.blockerOf(plan) ? [] : rows[index].products.map((product) => product.line_key))).filter(Boolean)
			),
		] as string[];

		return { rows, touched };
	}

	/** Lo que bloquea aplicar (el primero); los avisos no bloquean salvo la suma que no cuadra. */
	blockerOf(plan: RegisterPlan): RegisterError | null {
		return plan.errors[0] ?? (plan.warnings.includes('sum_mismatch') ? 'sum_mismatch' : null);
	}

	private rowsOf(plan: RegisterPlan): number {
		return plan.products.reduce((sum, product) => sum + plan.months.filter((month) => !product.covered.includes(month)).length, 0);
	}

	/** Valida y arma el plan de cada factura. */
	async plan(
		db: Queryable,
		holdingId: string,
		inputs: RegisterHistoryInvoiceDto[],
		lock = false,
		replace?: ReplaceOptions
	): Promise<RegisterPlan[]> {
		const invoiceIds = [...new Set(inputs.map((input) => input.invoice_id))];
		const productIds = [...new Set(inputs.flatMap((input) => input.products.map((product) => product.product_id)))];
		const [invoices, products, currencies, fxRef] = await Promise.all([
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
			loadFxReferences(db, holdingId),
		]);
		const invoiceById = new Map(invoices.map((row) => [String(row.id), row]));
		const productById = new Map(products.map((row) => [String(row.id), str(row.name)]));
		const known = new Set(currencies.map((row) => String(row.code)));
		const clientIds = replace ? [replace.clientId] : ([...new Set(invoices.map((row) => str(row.client_id)).filter(Boolean))] as string[]);
		const covered = clientIds.length
			? ((await db.query(
					`SELECT DISTINCT m.client_id, m.product_name, m.contract_currency, to_char(m.period_month, 'YYYY-MM') AS period
				FROM mrr_legacy m WHERE m.holding_id = $1 AND m.client_id = ANY($2::uuid[]) AND NOT ${legacyRemovedSql('m')}
					AND m.id <> ALL($3::uuid[])`,
					[holdingId, clientIds, replace?.excludeRowIds ?? []]
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
			const clientId = replace ? replace.clientId : str(invoice?.client_id);
			const invoiceAmount = replace?.invoiceAmounts.get(input.invoice_id) ?? num(invoice?.amount_invoice_currency);
			const fx = input.amount_contract_currency !== 0 ? invoiceAmount / input.amount_contract_currency : null;

			if (!invoice) errors.push('not_found');
			else if (invoice.has_history === true && !replace) errors.push('already_registered');
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
			if (invoice) warnings.push(...fxWarningsOf(str(invoice.invoice_currency), input.contract_currency, fx, fxRef));
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
				invoice_currency: str(invoice?.invoice_currency),
				amount_invoice_currency: invoice ? invoiceAmount : null,
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

	/** Una fila por producto × mes no cubierto (`split_index` = `splitBase` + posición del producto). Un solo INSERT por factura. */
	private async insertRows(
		db: Queryable,
		holdingId: string,
		plan: RegisterPlan,
		actor: OnboardingActor,
		batchId: string,
		contractId: string | null,
		splitBase = 0
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
					splitBase + index + 1,
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
