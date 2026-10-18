import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { type Month, monthRange, monthsBetween } from '@/modules/metrics/metrics-period';
import { legacyRemovedSql } from '@/modules/metrics/mrr-historico';

import {
	decodeLineKey,
	encodeLineKey,
	firstDay,
	insertOnboardingEvent,
	isoDate,
	type LineKeyParts,
	num,
	omitKey,
	type OnboardingActor,
	type Queryable,
	rawLineKey,
	round2,
	round6,
	type Row,
	str,
} from './onboarding-common';
import { type HistoryLine, LINE_JOINS, lineCtes, lineDto, lineSelect } from './onboarding-lines';

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
	| 'adopted'
	| 'already_registered'
	| 'invoice_without_items'
	| 'invalid_period'
	| 'invalid_amount'
	| 'product_not_found'
	| 'duplicate_product'
	| 'currency_not_enabled'
	| 'no_client'
	| 'sum_mismatch'
	| 'target_not_found'
	| 'target_mismatch';

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
	/** Registro pendiente al que se suma la factura (`target_key` propio o global), ya validado; `null` = nace un registro nuevo. */
	target: LineKeyParts | null;
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

/**
 * Opciones del registro: el arranque rápido (filas ya empalmadas al contrato recién creado), "Editar línea" (`replace` + `batchId` = el
 * registro que se edita conserva su `batch_id`) y `targetKey` (registro pendiente al que se suman todas las facturas que no traen el suyo).
 */
export interface RegisterOptions {
	contractId?: string | null;
	batchId?: string;
	replace?: ReplaceOptions;
	targetKey?: string;
}

/** Resultado de `registerInTx`. */
export interface RegisterResult {
	created_rows: number;
	/** Ids de las filas insertadas (`RETURNING id`; vacío si la base no los devolvió). */
	created_ids: string[];
	/** Claves de los registros donde quedaron las filas. */
	records_touched: string[];
	/** `batch_id` distintos usados (uno por cliente × moneda, o el del `target_key` / `batchId`). */
	batch_ids: string[];
	skipped: Array<{ invoice_id: string; reason: RegisterError }>;
}

/**
 * Registrar histórico desde facturas previas (§3.2b): la usuaria indica por factura el período que cubre, el monto en moneda de
 * contrato y los productos con su parte; esto crea las filas de `mrr_legacy` (una por producto × mes: `subtotal_contract_currency` =
 * parte del producto por todo el período, `term` = meses, `mrr_legacy` = parte ÷ meses, `fx_contract_to_invoice` = monto de factura ÷
 * monto de contrato) y marca la factura `reconciliation_status = 'mrr_legacy'`. `mrr_legacy` no tiene `product_id`: se guarda el nombre
 * del catálogo (`product_name`). Un mes ya cubierto por el mismo cliente × producto × moneda no se repite.
 *
 * **Registro (Domi 18-10)**: las filas nacen con un `batch_id` por cliente × moneda de contrato dentro de una misma aplicación (como el
 * modal del front anterior), salvo `target_key` (por factura o global): un registro pendiente existente del mismo cliente y moneda al que
 * se suman ("continuar un registro"). El arranque rápido y la importación con histórico siguen la misma regla; "Editar línea" conserva el
 * `batch_id` del registro.
 */
@Injectable()
export class OnboardingRegisterService {
	constructor(private readonly dataSource: DataSource) {}

	async preview(holdingId: string, dto: RegisterHistoryDto) {
		const plans = await this.plan(this.dataSource, holdingId, dto.invoices, false, undefined, dto.target_key);
		const records = await this.recordsOf(this.dataSource, holdingId, plans);

		return {
			rows: plans.map((plan, index) => ({
				invoice_id: plan.invoice_id,
				invoice_number: plan.invoice_number,
				invoice_currency: plan.invoice_currency,
				amount_invoice_currency: plan.amount_invoice_currency,
				months: plan.months,
				mrr_per_month: plan.mrr_per_month,
				fx_contract_to_invoice: plan.fx_contract_to_invoice,
				products: plan.products.map((product) => omitKey(product, 'covered')),
				...records.rows[index],
				warnings: plan.warnings,
				errors: plan.errors,
			})),
			summary: {
				invoices: plans.length,
				ready: plans.filter((plan) => !this.blockerOf(plan)).length,
				with_warnings: plans.filter((plan) => plan.warnings.length).length,
				with_errors: plans.filter((plan) => this.blockerOf(plan)).length,
				rows_to_create: plans.filter((plan) => !this.blockerOf(plan)).reduce((sum, plan) => sum + this.rowsOf(plan), 0),
				records_touched: records.touched,
				records_to_create: records.to_create,
			},
		};
	}

	async register(holdingId: string, dto: RegisterHistoryDto, actor: OnboardingActor) {
		return await withApiWriter(this.dataSource, async (runner) =>
			this.registerInTx(runner, holdingId, dto.invoices, actor, { targetKey: dto.target_key })
		);
	}

	/** Registro dentro de una transacción abierta (con la marca ya fijada). Lo usan también el arranque rápido, la importación y Editar línea. */
	async registerInTx(
		runner: Queryable,
		holdingId: string,
		invoices: RegisterHistoryInvoiceDto[],
		actor: OnboardingActor,
		options: RegisterOptions = {}
	): Promise<RegisterResult> {
		const plans = await this.plan(runner, holdingId, invoices, true, options.replace, options.targetKey);
		// Al volver a registrar, la línea de factura puede tener filas de otros registros: los `split_index` nuevos van después de los usados.
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
		const records = new Set<string>();
		const batches = new Map<string, string>();
		const createdIds: string[] = [];
		let created = 0;

		for (const plan of plans) {
			const blocker = this.blockerOf(plan);

			if (blocker) {
				skipped.push({ invoice_id: plan.invoice_id, reason: blocker });
				continue;
			}
			// Un registro (`batch_id`) por cliente × moneda en esta aplicación; el del `target_key` si se continúa uno; el dado al editar.
			const group = `${plan.client_id}|${plan.input.contract_currency}`;
			const batchId = options.batchId ?? plan.target?.batch_id ?? batches.get(group) ?? randomUUID();

			batches.set(group, batchId);
			const inserted = await this.insertRows(
				runner,
				holdingId,
				plan,
				actor,
				batchId,
				options.contractId ?? null,
				splitBase.get(String(plan.invoice?.item_id)) ?? 0
			);

			created += inserted.count;
			createdIds.push(...inserted.ids);
			records.add(
				encodeLineKey({
					batch_id: batchId,
					client_id: plan.client_id!,
					contract_currency: plan.input.contract_currency,
					contract_id: options.contractId ?? null,
				})
			);
			await runner.query(
				`UPDATE invoices_legacy SET reconciliation_status = 'mrr_legacy'${options.contractId ? ', contract_id = COALESCE(contract_id, $3)' : ''}
				WHERE id = $1 AND holding_id = $2`,
				options.contractId ? [plan.invoice_id, holdingId, options.contractId] : [plan.invoice_id, holdingId]
			);
			await insertOnboardingEvent(runner, holdingId, actor.userId, {
				type: 'history_registered',
				lineKey: `${batchId}|${plan.client_id}|${plan.input.contract_currency}`,
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
					rows: inserted.count,
					contract_id: options.contractId ?? null,
					continued: plan.target ? rawLineKey(plan.target) : null,
					warnings: plan.warnings,
				},
			});
		}

		return {
			created_rows: created,
			created_ids: createdIds,
			records_touched: [...records],
			batch_ids: [...new Set(batches.values())],
			skipped,
		};
	}

	/** Registros **pendientes** (sin contrato, con filas sin marcar) de esos clientes, por clave cruda. Solo lectura. */
	async pendingRecords(db: Queryable, holdingId: string, clientIds: string[]): Promise<Map<string, HistoryLine>> {
		if (!clientIds.length) return new Map();
		const rows = (await db.query(
			`${lineCtes({ holding: '$1', rowWhere: ['m.client_id = ANY($2::uuid[])', 'm.migrated_to_contract_id IS NULL'] })}
			SELECT ${lineSelect()} FROM st ${LINE_JOINS}
			WHERE st.status = 'pending'
			ORDER BY st.registered_at DESC`,
			[holdingId, clientIds]
		)) as Row[];

		return new Map(
			rows
				.map(lineDto)
				.map((record) => [
					rawLineKey({ batch_id: record.batch_id, client_id: record.client.id, contract_currency: record.currency, contract_id: null }),
					record,
				])
		);
	}

	/**
	 * Registro de destino de cada factura (Domi 18-10): `record_key` = el registro pendiente al que se suma (su `target_key`, validado) o
	 * `null` si nace un registro nuevo al aplicar (su `batch_id` no existe aún); `record_exists` = se suma a uno existente;
	 * `existing_records[]` = registros pendientes del mismo cliente y moneda que podrían continuarse (con sus productos y meses). `touched` =
	 * claves distintas de los registros existentes que recibirían filas (sin las facturas bloqueadas); `to_create` = registros nuevos (cliente
	 * × moneda sin destino). Solo lectura.
	 */
	async recordsOf(db: Queryable, holdingId: string, plans: RegisterPlan[]) {
		const pending = await this.pendingRecords(db, holdingId, [...new Set(plans.map((plan) => plan.client_id).filter(Boolean))] as string[]);
		const summaryOf = (record: HistoryLine) => ({
			key: record.key,
			batch_id: record.batch_id,
			products: record.products.map((product) => product.product_name),
			first_month: record.first_month,
			last_month: record.last_month,
			months_count: record.months_count,
			mrr_last: record.mrr_last,
			registered_at: record.registered_at,
		});
		const rows = plans.map((plan) => ({
			record_key: plan.target ? encodeLineKey(plan.target) : null,
			record_exists: plan.target !== null,
			existing_records: [...pending.values()]
				.filter((record) => record.client.id === plan.client_id && record.currency === plan.input.contract_currency)
				.map(summaryOf),
		}));
		const applicable = plans.filter((plan) => !this.blockerOf(plan));
		const touched = [...new Set(applicable.filter((plan) => plan.target).map((plan) => encodeLineKey(plan.target!)))];
		const toCreate = new Set(applicable.filter((plan) => !plan.target).map((plan) => `${plan.client_id}|${plan.input.contract_currency}`)).size;

		return { rows, touched, to_create: toCreate };
	}

	/** Lo que bloquea aplicar (el primero); los avisos no bloquean salvo la suma que no cuadra. */
	blockerOf(plan: RegisterPlan): RegisterError | null {
		return plan.errors[0] ?? (plan.warnings.includes('sum_mismatch') ? 'sum_mismatch' : null);
	}

	private rowsOf(plan: RegisterPlan): number {
		return plan.products.reduce((sum, product) => sum + plan.months.filter((month) => !product.covered.includes(month)).length, 0);
	}

	/**
	 * Registros de destino (`target_key` por factura o global): clave → partes si es un registro **pendiente** del holding (sin contrato y
	 * con filas sin marcar); una clave que no decodifica es 400 con su campo. Solo lectura.
	 */
	private async resolveTargets(
		db: Queryable,
		holdingId: string,
		inputs: RegisterHistoryInvoiceDto[],
		globalKey?: string
	): Promise<Map<string, LineKeyParts | null>> {
		const wanted = new Map<string, LineKeyParts>();

		if (globalKey) wanted.set(globalKey, decodeLineKey(globalKey, 'target_key'));
		inputs.forEach((input, index) => {
			if (input.target_key && !wanted.has(input.target_key))
				wanted.set(input.target_key, decodeLineKey(input.target_key, `invoices.${index}.target_key`));
		});
		const parts = [...wanted.values()].filter((target) => !target.contract_id);
		const pending = parts.length
			? new Set(
					(
						(await db.query(
							`SELECT m.batch_id, m.client_id, m.contract_currency FROM mrr_legacy m
							WHERE m.holding_id = $1 AND m.batch_id = ANY($2::uuid[]) AND m.migrated_to_contract_id IS NULL
							GROUP BY m.batch_id, m.client_id, m.contract_currency HAVING BOOL_OR(NOT m.skip_activation)`,
							[holdingId, [...new Set(parts.map((target) => target.batch_id))]]
						)) as Row[]
					).map((row) =>
						rawLineKey({
							batch_id: String(row.batch_id),
							client_id: String(row.client_id),
							contract_currency: String(row.contract_currency),
							contract_id: null,
						})
					)
				)
			: new Set<string>();

		return new Map([...wanted].map(([key, target]) => [key, !target.contract_id && pending.has(rawLineKey(target)) ? target : null]));
	}

	/** Valida y arma el plan de cada factura. `targetKey` = registro pendiente global al que se suman las facturas sin `target_key` propio. */
	async plan(
		db: Queryable,
		holdingId: string,
		inputs: RegisterHistoryInvoiceDto[],
		lock = false,
		replace?: ReplaceOptions,
		targetKey?: string
	): Promise<RegisterPlan[]> {
		const invoiceIds = [...new Set(inputs.map((input) => input.invoice_id))];
		const productIds = [...new Set(inputs.flatMap((input) => input.products.map((product) => product.product_id)))];
		const targets = await this.resolveTargets(db, holdingId, inputs, targetKey);
		const [invoices, products, currencies, fxRef] = await Promise.all([
			db.query(
				`SELECT il.id, il.invoice_number, il.issue_date, il.company_id, il.client_tax_id, il.legal_client_name, il.invoice_currency,
					il.amount_invoice_currency, il.total_invoice_currency, il.vat, il.status, ce.tax_id AS entity_tax_id,
					COALESCE(il.client_id, ce.client_id) AS client_id, it.id AS item_id, it.subtotal AS item_subtotal, it.description AS item_description,
					it.currency AS item_currency, EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id) AS has_history,
					il.reconciled_invoice_id
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
			// Adoptada como factura del contrato (§4.5): su MRR vive en el devengo del contrato, no en el histórico.
			else if (invoice.reconciled_invoice_id) errors.push('adopted');
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
			// Continuar un registro (Domi 18-10): debe ser un registro pendiente del mismo cliente y moneda.
			const wantedKey = input.target_key ?? targetKey ?? null;
			const target = wantedKey ? (targets.get(wantedKey) ?? null) : null;

			if (wantedKey && !target) errors.push('target_not_found');
			else if (target && clientId && (target.client_id !== clientId || target.contract_currency !== input.contract_currency)) {
				errors.push('target_mismatch');
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
				target: errors.length ? null : target,
				input,
				invoice,
			};
		});
	}

	/**
	 * Una fila por producto × mes no cubierto (`split_index` = `splitBase` + posición del producto). Un solo INSERT por factura. `count` =
	 * filas enviadas; `ids` = las que la base devolvió (`RETURNING id`; menos si `ON CONFLICT` saltó alguna).
	 */
	private async insertRows(
		db: Queryable,
		holdingId: string,
		plan: RegisterPlan,
		actor: OnboardingActor,
		batchId: string,
		contractId: string | null,
		splitBase = 0
	): Promise<{ count: number; ids: string[] }> {
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
		if (!tuples.length) return { count: 0, ids: [] };
		const inserted = (await db.query(
			`INSERT INTO mrr_legacy (holding_id, invoice_legacy_id, invoice_item_legacy_id, split_index, company_id, client_tax_id,
				legal_client_name, invoice_number, issue_date, invoice_currency, amount_invoice_currency, total_invoice_currency, vat, status,
				description, currency, subtotal, allocated_invoice_currency, client_id, contract_currency, subtotal_contract_currency,
				product_name, term, period_month, is_recurring, fx_contract_to_invoice, mrr_legacy, momentum, created_by, batch_id,
				migrated_to_contract_id, migrated_by, migrated_at)
			VALUES ${tuples.join(',\n')}
			ON CONFLICT (invoice_item_legacy_id, split_index, period_month) DO NOTHING
			RETURNING id`,
			values
		)) as Row[] | undefined;

		return { count: tuples.length, ids: Array.isArray(inserted) ? inserted.map((row) => String(row.id)) : [] };
	}
}
