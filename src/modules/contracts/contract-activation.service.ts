import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import {
	type BillingEngineItem,
	type BillingEngineOutput,
	fixedFxAmounts,
	type FxPeriodRate,
	generateInvoices,
	normalizeTaxRate,
	type PreviewInvoice,
	round2,
} from './billing-engine';
import { cleanPaymentTerms, DRAFT_STATUS, resolveUserId } from './contract-drafts.service';
import { UF_CURRENCY } from './dtos/create-contract.dto';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

/** Estado al que pasa un contrato activado. */
export const ACTIVE_STATUS = 'Activo';
/** Origen de las líneas creadas por la activación (mismo valor que el generador viejo). */
export const ACTIVATION_FX_RATE_SOURCE = 'scheduled-generation';

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const upper = (value: unknown) => (toText(value) ?? '').trim().toUpperCase();
export interface ActivationBlocker {
	code: string;
	message: string;
}

export interface ActivationCheck {
	id: string;
	contract_number: string | null;
	can_activate: boolean;
	blockers: ActivationBlocker[];
	warnings: string[];
	invoices_count: number;
	first_issue_date: string | null;
	/** Σ neto de las facturas a crear (sin IVA), en `currency`. */
	total_to_invoice: number;
	/** Moneda de `total_to_invoice`: la del contrato (el generador calcula en moneda de contrato; con conversión, cada factura trae `currency` y `fx`). */
	currency: string | null;
	document_type: string | null;
	/** Primeras 3 facturas del generador (mismo cálculo que se persiste). */
	sample: PreviewInvoice[];
}

/** Resultado de evaluar un contrato: lo que ve la usuaria y lo que se persistiría. */
export interface ActivationPlan {
	check: ActivationCheck;
	contract: Row | null;
	items: Row[];
	engine: BillingEngineOutput | null;
	/**
	 * Tipo de cambio fijo contrato → factura por factura (alineado con `engine.invoices`) cuando la política de facturación
	 * es `fixed` y las monedas difieren; `null` en las demás.
	 */
	fixedRates: Array<number | null>;
}

/**
 * Contratos v2 — activación C2 (`docs/v2-rediseno/mapa-v2-contratos.md` §2b y §3), con vista previa.
 *
 * Por contrato y en su propia transacción: valida, crea las facturas Por Emitir con el generador v2 **antes** de pasar a
 * Activo (los triggers viejos de generación ven facturas y se saltan), deja el contrato Activo (booking la fija
 * `set_booking_date_on_activate` solo si es null, S2-7), reconstruye el RSM y registra el evento `ACTIVATION`.
 * No escribe `contract_invoices` (decisión 2 del mapa).
 */
@Injectable()
export class ContractActivationService {
	private readonly logger = new Logger(ContractActivationService.name);

	constructor(private readonly dataSource: DataSource) {}

	// ---------------------------------------------------------------- lectura

	/** Contratos del holding (no borrados) con compañía, razón social y conteos que usan las validaciones. */
	private async loadContracts(db: Queryable, ids: string[], holdingId: string, lock = false): Promise<Map<string, Row>> {
		const rows = (await db.query(
			`SELECT c.id, c.contract_number, c.status, c.client_id, c.client_entity_id, c.company_id,
				c.contract_currency, c.invoice_currency, c.system_currency, c.company_currency AS contract_company_currency,
				c.fx_invoice_policy, c.fx_company_policy, c.group_invoices_by_period, c.auto_invoice, c.requires_references_for_billing,
				(to_jsonb(c)->>'billing_anchor_day') AS billing_anchor_day,
				(to_jsonb(c)->'payment_terms') AS payment_terms,
				(to_jsonb(c)->>'document_type') AS document_type,
				co.id AS company_found, co.legal_name AS company_legal_name, co.tax_id AS company_tax_id, co.legal_address AS company_address,
				co.country AS company_country, co.currency AS company_currency, co.tax_rate AS company_tax_rate,
				ce.id AS entity_found, ce.tax_id AS entity_tax_id, ce.country AS entity_country, ce.payment_terms AS entity_payment_terms,
				(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false
					AND i.status IS DISTINCT FROM 'Cancelada') AS invoices_count,
				(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND i.is_legacy = true
					AND i.status IS DISTINCT FROM 'Cancelada') AS legacy_invoices_count,
				(SELECT COALESCE(jsonb_agg(jsonb_build_object(
						'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
						'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
					FROM contract_fx_period_rates r
					WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'invoice') AS fx_invoice_rates,
				EXISTS (SELECT 1 FROM contract_items ci WHERE ci.contract_id = c.id AND ci.currency IS DISTINCT FROM c.contract_currency) AS currency_mismatch
			FROM contracts c
			LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
			LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id
			WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND (to_jsonb(c)->>'deleted_at') IS NULL
			${lock ? 'FOR UPDATE OF c' : ''}`,
			[ids, holdingId]
		)) as Row[];

		return new Map(rows.map((row) => [String(row.id), row]));
	}

	private async loadItems(db: Queryable, ids: string[], holdingId: string): Promise<Map<string, Row[]>> {
		const rows = (await db.query(
			`SELECT ci.contract_id, ci.id, ci.product_id, ci.product_name, ci.account, ci.unit_of_measure,
				ci.quantity, ci.unit_price, ci.annual_unit_price, ci.discount_type, ci.discount_value, ci.final_price,
				ci.billing_frequency, ci.billing_method, ci.start_date::text AS start_date, ci.end_date::text AS end_date,
				ci.term_months, ci.is_recurring
			FROM contract_items ci
			JOIN contracts c ON c.id = ci.contract_id
			WHERE ci.contract_id = ANY($1::uuid[]) AND c.holding_id = $2
			ORDER BY ci.contract_id, ci.start_date NULLS LAST, ci.product_name, ci.id`,
			[ids, holdingId]
		)) as Row[];
		const byContract = new Map<string, Row[]>();

		for (const row of rows) {
			const key = String(row.contract_id);

			byContract.set(key, [...(byContract.get(key) ?? []), row]);
		}

		return byContract;
	}

	// ---------------------------------------------------------------- evaluación (pura)

	/** Ítem de la base al formato del generador. El unitario es mensual (el anual se divide en 12). */
	static engineItem(item: Row): BillingEngineItem {
		const unit =
			item.unit_price !== null && item.unit_price !== undefined
				? toNumber(item.unit_price)
				: item.annual_unit_price !== null && item.annual_unit_price !== undefined
					? toNumber(item.annual_unit_price) / 12
					: 0;

		return {
			key: String(item.id),
			product_id: toText(item.product_id),
			product_name: toText(item.product_name)?.trim() || 'Producto',
			account: toText(item.account),
			quantity: toNumber(item.quantity),
			unit_price: unit,
			discount_value: item.discount_value === null || item.discount_value === undefined ? 0 : toNumber(item.discount_value),
			discount_type: toText(item.discount_type),
			billing_frequency: toText(item.billing_frequency) ?? 'Mensual',
			billing_method: toText(item.billing_method) ?? 'Anticipado',
			start_date: toText(item.start_date)?.slice(0, 10) ?? '',
			term_months: toNumber(item.term_months),
			end_date: toText(item.end_date)?.slice(0, 10) ?? null,
			is_recurring: item.is_recurring !== false,
			final_price: item.final_price === null || item.final_price === undefined ? null : toNumber(item.final_price),
		};
	}

	/**
	 * Valida el contrato y corre el generador con su configuración guardada (`billing_anchor_day`, `payment_terms` y
	 * `document_type` se leen con `to_jsonb` para que funcione antes de la migración; si faltan, los defaults del
	 * generador y la condición de pago de la razón social).
	 */
	static evaluate(id: string, contract: Row | undefined, items: Row[]): ActivationPlan {
		const blockers: ActivationBlocker[] = [];
		const block = (code: string, message: string) => blockers.push({ code, message });
		const empty = (extra: Partial<ActivationCheck> = {}): ActivationCheck => ({
			id,
			contract_number: null,
			can_activate: false,
			blockers,
			warnings: [],
			invoices_count: 0,
			first_issue_date: null,
			total_to_invoice: 0,
			currency: null,
			document_type: null,
			sample: [],
			...extra,
		});

		if (!contract) {
			block('not_found', 'El contrato no existe en el holding');

			return { check: empty(), contract: null, items: [], engine: null, fixedRates: [] };
		}

		const number = toText(contract.contract_number);
		const contractCurrency = upper(contract.contract_currency);
		const invoiceCurrency = upper(contract.invoice_currency) || contractCurrency;
		const companyCurrency = upper(contract.contract_company_currency) || upper(contract.company_currency);

		if (contract.status !== DRAFT_STATUS)
			block('not_draft', `El contrato está ${toText(contract.status) ?? 'sin estado'}: solo se activan borradores`);
		if (toNumber(contract.invoices_count) > 0) {
			block('has_invoices', 'Este borrador ya tiene facturas; no debería pasar (dato inconsistente). Revísalas antes de activar.');
		} else if (toNumber(contract.legacy_invoices_count) > 0) {
			block('has_legacy_invoices', 'Tiene facturas legacy reconciliadas: se resuelve en el flujo de onboarding/legacy.');
		}
		if (!contract.client_entity_id || !contract.entity_found) block('no_client_entity', 'El contrato no tiene razón social asignada');
		if (!contract.company_id || !contract.company_found) block('no_company', 'El contrato no tiene compañía emisora');
		else if (normalizeTaxRate(contract.company_tax_rate as number | string | null) === null) {
			block('no_tax_rate', 'La compañía no tiene tasa de IVA configurada: configúrala antes de activar');
		}
		if (!items.length) block('no_items', 'El contrato no tiene ítems');

		const withoutProduct = items.filter((item) => !item.product_id).length;

		if (withoutProduct > 0) {
			block('items_without_product', `${withoutProduct} ${withoutProduct === 1 ? 'ítem no tiene' : 'ítems no tienen'} producto del catálogo`);
		}
		const incomplete = items.filter((item) => !item.start_date || !(toNumber(item.term_months) > 0) || !(toNumber(item.quantity) > 0)).length;

		if (incomplete > 0) {
			block('incomplete_items', `${incomplete} ${incomplete === 1 ? 'ítem no tiene' : 'ítems no tienen'} inicio, plazo o cantidad válidos`);
		}
		if (contract.currency_mismatch === true) block('currency_mismatch', 'Hay ítems en una moneda distinta a la del contrato');
		// La UF no se factura: borradores viejos con moneda de facturación CLF (o en UF sin moneda de facturación).
		if (invoiceCurrency === UF_CURRENCY) {
			block('uf_invoice_currency', 'La UF no se factura: define la moneda en que se emite (por ejemplo, CLP) antes de activar');
		}
		// S1-17: con moneda de contrato ≠ moneda de la compañía, la política de tipo de cambio de compañía debe estar definida.
		if (companyCurrency && contractCurrency && companyCurrency !== contractCurrency && !toText(contract.fx_company_policy)) {
			block(
				'fx_company_policy_missing',
				`El contrato está en ${contractCurrency} y la compañía en ${companyCurrency}: define la política de tipo de cambio de la compañía`
			);
		}

		const anchor = Number(contract.billing_anchor_day);
		const hasAnchor =
			contract.billing_anchor_day !== null &&
			contract.billing_anchor_day !== undefined &&
			Number.isInteger(anchor) &&
			anchor >= 1 &&
			anchor <= 31;
		const engine = items.length
			? generateInvoices({
					contract: {
						billing_anchor_day: hasAnchor ? anchor : null,
						group_invoices_by_period: contract.group_invoices_by_period !== false,
						invoice_currency: invoiceCurrency,
						contract_currency: contractCurrency,
						fx_invoice_policy: toText(contract.fx_invoice_policy),
						payment_terms: cleanPaymentTerms(contract.payment_terms) ?? cleanPaymentTerms(contract.entity_payment_terms),
						fixed_invoice_rates: Array.isArray(contract.fx_invoice_rates) ? (contract.fx_invoice_rates as FxPeriodRate[]) : [],
						document_type: toText(contract.document_type),
						company: { country: toText(contract.company_country), tax_rate: contract.company_tax_rate as number | string | null },
						entity_country: toText(contract.entity_country),
					},
					items: items.map((item) => ContractActivationService.engineItem(item)),
				})
			: null;
		const warnings = [...(engine?.warnings ?? [])];

		if (engine && !hasAnchor) warnings.push('El contrato no tiene día de ciclo guardado: se usa el del primer ítem recurrente');
		if (items.length && engine && engine.invoices.length === 0) block('no_invoices', 'El generador no produjo facturas para este contrato');

		// Tipo de cambio fijo de facturación: el generador toma, por factura, la tasa `purpose = 'invoice'` que cubre el inicio
		// de su período. Si alguna queda sin tasa, nacería sin FX y no se podría enviar (S6-2): se bloquea.
		const usesFixedFx = toText(contract.fx_invoice_policy) === 'fixed' && invoiceCurrency !== contractCurrency;
		const invoices = engine?.invoices ?? [];
		const fixedRates = invoices.map((invoice) => (usesFixedFx && invoice.fx !== null ? invoice.fx : null));

		if (usesFixedFx) {
			const missing = invoices.filter((invoice) => invoice.fx === null);

			if (missing.length) {
				block(
					'fixed_fx_without_rate',
					`Se factura en ${invoiceCurrency} con tipo de cambio fijo y ${missing.length === 1 ? '1 factura no tiene' : `${missing.length} facturas no tienen`} tasa ${contractCurrency} → ${invoiceCurrency} para su período (desde el ${missing[0].billing_period_start}): carga la tasa del período o usa tipo de cambio del día`
				);
			}
		}

		return {
			check: empty({
				contract_number: number,
				can_activate: blockers.length === 0,
				warnings,
				invoices_count: invoices.length,
				first_issue_date: invoices[0]?.issue_date ?? null,
				total_to_invoice: engine?.totals.invoiced_total ?? 0,
				currency: contractCurrency || null,
				document_type: invoices[0]?.document_type ?? toText(contract.document_type),
				sample: invoices.slice(0, 3),
			}),
			contract,
			items,
			engine,
			fixedRates,
		};
	}

	// ---------------------------------------------------------------- vista previa

	/** `POST /contracts/activate/preview`: qué pasaría con cada contrato. No escribe nada. */
	async preview(ids: string[], holdingId: string): Promise<{ data: ActivationCheck[] }> {
		const uniqueIds = [...new Set(ids)];
		const [contracts, items] = await Promise.all([
			this.loadContracts(this.dataSource, uniqueIds, holdingId),
			this.loadItems(this.dataSource, uniqueIds, holdingId),
		]);

		return { data: uniqueIds.map((id) => ContractActivationService.evaluate(id, contracts.get(id), items.get(id) ?? []).check) };
	}

	// ---------------------------------------------------------------- activar (C2)

	/**
	 * `POST /contracts/activate`: activa solo los que no tienen bloqueos, **cada uno en su propia transacción** (un fallo
	 * no frena al resto). Revalida dentro de la transacción, con el contrato bloqueado.
	 */
	async activate(ids: string[], holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const activated: Array<{ id: string; contract_number: string | null; invoices_created: number }> = [];
		const skipped: Array<{ id: string; contract_number: string | null; blockers: ActivationBlocker[] }> = [];
		const failed: Array<{ id: string; contract_number: string | null; message: string }> = [];

		for (const id of [...new Set(ids)]) {
			const runner = this.dataSource.createQueryRunner();
			let contractNumber: string | null = null;

			await runner.connect();
			await runner.startTransaction();
			try {
				// En serie: una sola conexión, y el contrato queda bloqueado antes de leer sus ítems.
				const contracts = await this.loadContracts(runner, [id], holdingId, true);
				const items = await this.loadItems(runner, [id], holdingId);
				const plan = ContractActivationService.evaluate(id, contracts.get(id), items.get(id) ?? []);

				contractNumber = plan.check.contract_number;
				if (!plan.check.can_activate || !plan.contract || !plan.engine) {
					await runner.rollbackTransaction();
					skipped.push({ id, contract_number: contractNumber, blockers: plan.check.blockers });
					continue;
				}

				const invoicesCreated = await this.persist(runner, plan, holdingId, userId);

				await runner.commitTransaction();
				activated.push({ id, contract_number: contractNumber, invoices_created: invoicesCreated });
			} catch (error) {
				await runner.rollbackTransaction();
				const message = error instanceof Error ? error.message : String(error);

				this.logger.warn(`No se pudo activar el contrato ${id}: ${message}`);
				failed.push({ id, contract_number: contractNumber, message: `No se pudo activar: ${message}` });
			} finally {
				await runner.release();
			}
		}

		return { activated, skipped, failed };
	}

	/**
	 * Escribe la activación dentro de la transacción del contrato, en este orden:
	 * 1. facturas Por Emitir (encabezado = Σ líneas) y sus líneas **sin** `contract_item_id`, luego un UPDATE que lo fija
	 *    (patrón B: `standardize_invoice_items` solo actúa en INSERT con ítem y pisaría cantidad, unitario y subtotal);
	 * 2. `status = 'Activo'` (los triggers de generación vieja ven facturas y se saltan);
	 * 3. `revenue_schedule_rebuild(contrato)` explícito;
	 * 4. evento `ACTIVATION`.
	 */
	private async persist(runner: QueryRunner, plan: ActivationPlan, holdingId: string, userId: string): Promise<number> {
		const contract = plan.contract!;
		const engine = plan.engine!;
		const contractId = String(contract.id);
		const contractCurrency = upper(contract.contract_currency);
		const systemCurrency = upper(contract.system_currency);
		const units = new Map(plan.items.map((item) => [String(item.id), item]));

		for (const [index, invoice] of engine.invoices.entries()) {
			const sameCurrency = upper(invoice.currency) === contractCurrency;
			const fixedFx = plan.fixedRates[index] ?? null;
			// Tipo de cambio fijo: montos en moneda de factura como `apply_fixed_fx_to_contract`; spot con conversión: NULL.
			const fixed = fixedFx !== null ? fixedFxAmounts(invoice, fixedFx) : null;
			const fx = sameCurrency ? 1 : fixedFx;
			const sameSystem = Boolean(systemCurrency) && systemCurrency === contractCurrency;
			const [header] = (await runner.query(
				`INSERT INTO invoices (
					company_id, client_id, client_entity_id, contract_id,
					scheduled_at, original_issue_date, issue_date, due_date,
					vat, tax_rate, amount_contract_currency, amount_invoice_currency, amount_system_currency,
					total_invoice_currency, total_system_currency,
					contract_currency, invoice_currency, fx_contract_to_invoice,
					status, invoice_type, document_type, export_type, invoice_series,
					holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
					requires_references_for_billing, auto_invoice, is_active
				) VALUES (
					$1, $2, $3, $4,
					$5, $5, $5, $6,
					$7, $8, $9, $10, $11,
					$12, $13,
					$14, $15, $16,
					'Por Emitir', 'Automatica', $17, $18, 'FAC',
					$19, $20, $21, $22, $23,
					$24, $25, true
				) RETURNING id`,
				[
					contract.company_id,
					contract.client_id,
					contract.client_entity_id,
					contractId,
					invoice.issue_date,
					invoice.due_date,
					fixed ? fixed.vat : invoice.tax,
					invoice.tax_rate,
					invoice.subtotal,
					sameCurrency ? invoice.subtotal : (fixed?.amount ?? null),
					// `auto_populate_invoice_fx_to_system` recalcula los montos en moneda del sistema; con conversión nacen NULL.
					sameSystem ? invoice.subtotal : null,
					sameCurrency ? invoice.total : (fixed?.total ?? null),
					sameSystem ? invoice.total : null,
					contractCurrency,
					invoice.currency,
					fx,
					invoice.document_type,
					invoice.export_type,
					holdingId,
					toText(contract.company_legal_name),
					toText(contract.company_tax_id),
					toText(contract.company_address),
					toText(contract.entity_tax_id),
					contract.requires_references_for_billing === true,
					contract.auto_invoice === true,
				]
			)) as Row[];
			const invoiceId = String(header.id);
			const lineIds: string[] = [];
			const itemIds: string[] = [];

			for (const [lineIndex, line] of invoice.lines.entries()) {
				const item = units.get(line.item_key);
				const fixedLine = fixed?.lines[lineIndex] ?? null;
				const [inserted] = (await runner.query(
					`INSERT INTO invoice_items (
						invoice_id, description, quantity, unit_of_measure,
						unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
						subtotal_contract_currency, subtotal_invoice_currency,
						tax_amount_contract_currency, tax_amount_invoice_currency,
						total_contract_currency, total_invoice_currency,
						holding_id, contract_id, product_id,
						contract_currency, invoice_currency, fx_contract_to_invoice,
						fx_rate_source, fx_rate_date, status, issue_date,
						billing_period_start, billing_period_end
					) VALUES (
						$1, $2, $3, $4,
						$5, $6, $7,
						$8, $9,
						$10, $11,
						$12, $13,
						$14, $15, $16,
						$17, $18, $19,
						$20, $21, 'Por Emitir', $21,
						$22, $23
					) RETURNING id`,
					[
						invoiceId,
						line.description,
						line.quantity,
						toText(item?.unit_of_measure)?.trim() || 'UND',
						line.unit_price,
						sameCurrency ? line.unit_price : (fixedLine?.unit_price ?? null),
						round2(line.discount_pct),
						line.subtotal,
						sameCurrency ? line.subtotal : (fixedLine?.subtotal ?? null),
						line.tax_amount,
						sameCurrency ? line.tax_amount : (fixedLine?.tax_amount ?? null),
						line.total,
						sameCurrency ? line.total : (fixedLine?.total ?? null),
						holdingId,
						contractId,
						toText(item?.product_id),
						contractCurrency,
						invoice.currency,
						fx,
						ACTIVATION_FX_RATE_SOURCE,
						invoice.issue_date,
						line.billing_period_start,
						line.billing_period_end,
					]
				)) as Row[];

				lineIds.push(String(inserted.id));
				itemIds.push(line.item_key);
			}

			// Patrón B: el vínculo con el ítem se fija después del INSERT (el trigger de estandarización ya no corre).
			await runner.query(
				`UPDATE invoice_items ii SET contract_item_id = x.contract_item_id
				FROM unnest($1::uuid[], $2::uuid[]) AS x(id, contract_item_id)
				WHERE ii.id = x.id AND ii.invoice_id = $3`,
				[lineIds, itemIds, invoiceId]
			);
		}

		const updated = (await runner.query(`UPDATE contracts SET status = $3 WHERE id = $1 AND holding_id = $2 AND status = $4 RETURNING id`, [
			contractId,
			holdingId,
			ACTIVE_STATUS,
			DRAFT_STATUS,
		])) as Row[];

		if (!updated.length) throw new Error('el contrato cambió de estado durante la activación');

		await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);

		const total = engine.totals.invoiced_total;
		// El total del generador está en moneda de contrato (con conversión, cada factura se valoriza aparte).
		const currency = contractCurrency;
		const number = toText(contract.contract_number) ?? '';

		await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, metadata
			) VALUES ($1, $2, 'ACTIVATION', 'Completed', 'Contrato activado', $3, $4, now(), CURRENT_DATE, $5::jsonb)`,
			[
				contractId,
				holdingId,
				`Se activó ${number} y se generaron ${engine.invoices.length} factura(s) por emitir por ${currency} ${total.toLocaleString('es-CL', {
					minimumFractionDigits: 2,
					maximumFractionDigits: 2,
				})} (neto)`.replace(/\s+/g, ' '),
				userId,
				JSON.stringify({
					source: 'api_v2',
					contract_number: number || null,
					invoices_created: engine.invoices.length,
					total_to_invoice: total,
					currency,
					first_issue_date: engine.invoices[0]?.issue_date ?? null,
					last_issue_date: engine.invoices[engine.invoices.length - 1]?.issue_date ?? null,
				}),
			]
		);

		return engine.invoices.length;
	}
}
