import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryRunner } from 'typeorm';

import { setApiWriter } from './api-writer';
import { invoiceTermsSql, refreshContractSystemFx, refreshInvoiceSystemAmounts } from './api-written-fields';
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
import { REOPEN_PERIOD_STEP } from './contract-changes';
import { cleanPaymentTerms, DRAFT_STATUS, METERED_ADVANCE_MESSAGE, resolveUserId } from './contract-drafts.service';
import { UF_CURRENCY } from './dtos/create-contract.dto';
import { parseStoredTemplate } from './invoice-description';
import { PRICE_COLUMNS, priceSpecFromRow } from './price-rows';
import { type ConsumptionInput, isMetered } from './pricing-engine';
import { DESCRIPTION_LIMITS_SQL, descriptionMaxCharsOfRow, documentTypeLabel } from './tax-document-types';

type Row = Record<string, unknown>;
type Queryable = Pick<DataSource, 'query'> | QueryRunner;

/** Estado al que pasa un contrato activado. */
export const ACTIVE_STATUS = 'Activo';
/** Origen de las líneas creadas por la activación (mismo valor que el generador viejo). */
export const ACTIVATION_FX_RATE_SOURCE = 'scheduled-generation';

/** Una factura del generador valorizada por línea (contrato multimoneda): sus líneas traen `currency` y su propio par. */
export const isPerLineInvoice = (invoice: Pick<PreviewInvoice, 'lines'>) => invoice.lines.some((line) => line.currency !== undefined);

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const upper = (value: unknown) => (toText(value) ?? '').trim().toUpperCase();
export interface ActivationBlocker {
	code: string;
	message: string;
	/** Qué hacer para destrabar (hoy: `period_closed` → reabrir el período). */
	next_step?: string | null;
}

export interface ActivationCheck {
	id: string;
	contract_number: string | null;
	can_activate: boolean;
	blockers: ActivationBlocker[];
	warnings: string[];
	/** Códigos estables de las advertencias del generador (`indefinite_horizon`, `prorated_period`, `description_fitted`). */
	warning_codes: string[];
	invoices_count: number;
	first_issue_date: string | null;
	/** Con ítems sin término (S1-12): última fecha cubierta por las facturas generadas (horizonte de 12 períodos); null si no hay. */
	indefinite_until: string | null;
	/** Σ neto de las facturas a crear (sin IVA), en `currency`. */
	total_to_invoice: number;
	/** Moneda de `total_to_invoice`: la del contrato (el generador calcula en moneda de contrato; con conversión, cada factura trae `currency` y `fx`). */
	currency: string | null;
	document_type: string | null;
	/** Nombre del documento tributario del catálogo (`tax_document_types`) o, si el contrato no lo tiene, el de la familia. */
	document_type_label: string | null;
	/** Documento tributario del catálogo elegido en el contrato, si lo tiene. */
	tax_document_type: { id: string; code: string; name: string } | null;
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

/** Encabezado común de las facturas que la API crea para un contrato (activación y modificaciones). */
export interface InvoiceIssuer {
	contract_id: string;
	holding_id: string;
	company_id: string | null;
	client_id: string | null;
	client_entity_id: string | null;
	contract_currency: string;
	system_currency: string;
	company_legal_name: string | null;
	company_tax_id: string | null;
	company_address: string | null;
	entity_tax_id: string | null;
	requires_references_for_billing: boolean;
	auto_invoice: boolean;
}

/** Datos del ítem que necesita cada línea (unidad y producto), por `item_key` del generador. */
export type InvoiceLineUnits = Map<string, { unit_of_measure: string | null; product_id: string | null }>;

/**
 * Inserta facturas Por Emitir del generador v2: encabezado (= Σ líneas) y líneas **con** `contract_item_id` (con la costura
 * `sapira.writer = 'api'`, `standardize_invoice_items` no toca la línea: el patrón B dejó de hacer falta). La API escribe lo
 * que antes rellenaban triggers: `invoice_group_id = id` (`assign_invoice_group_id`; el id se genera en el mismo INSERT), las condiciones del contrato
 * (`invoices_fill_terms_from_contract`) y, al final, los montos en moneda del sistema (`refreshInvoiceSystemAmounts`, réplica
 * de `auto_populate_invoice_fx_to_system`). Cada línea lleva `quantity_source` y, si tiene modelo de precio,
 * `pricing_breakdown` (Pricing v2 §4.2). `fixedRates[i]` es la tasa fija contrato → factura de `invoices[i]` (null = misma
 * moneda o spot). Devuelve los ids creados. La usan la activación (C2) y las modificaciones (renovación, alta de ítem, tramo
 * inicial suelto). Requiere la marca `sapira.writer` fijada en la transacción.
 */
export async function insertEngineInvoices(
	runner: QueryRunner,
	issuer: InvoiceIssuer,
	invoices: PreviewInvoice[],
	fixedRates: Array<number | null>,
	units: InvoiceLineUnits
): Promise<string[]> {
	const contractCurrency = upper(issuer.contract_currency);
	const created: string[] = [];

	for (const [index, invoice] of invoices.entries()) {
		const perLine = isPerLineInvoice(invoice);
		const sameCurrency = !perLine && upper(invoice.currency) === contractCurrency;
		const fixedFx = perLine ? null : (fixedRates[index] ?? null);
		// Tipo de cambio fijo: montos en moneda de factura como `apply_fixed_fx_to_contract`; spot con conversión: NULL.
		const fixed = fixedFx !== null ? fixedFxAmounts(invoice, fixedFx) : null;
		const fx = perLine ? invoice.fx : sameCurrency ? 1 : fixedFx;
		// Multimoneda (spec §3): encabezado en moneda de contrato = Σ líneas × tasa ítem → contrato (del generador); en moneda de factura =
		// Σ líneas si todas están valorizadas (si no NULL, IVA en moneda de contrato como spot); FX = la del único par convertidor o NULL.
		const perLineInvoice = perLine ? (invoice.amounts_invoice_currency ?? null) : null;
		const [header] = (await runner.query(
			`INSERT INTO invoices (
				id, invoice_group_id, company_id, client_id, client_entity_id, contract_id,
				scheduled_at, original_issue_date, issue_date, due_date,
				vat, tax_rate, amount_contract_currency, amount_invoice_currency,
				total_invoice_currency,
				contract_currency, invoice_currency, fx_contract_to_invoice,
				status, invoice_type, document_type, export_type, invoice_series,
				holding_id, issuer_legal_name, issuer_tax_id, issuer_address, client_tax_id,
				requires_references_for_billing, auto_invoice, invoice_terms_and_conditions, is_active
			) SELECT
				g.id, g.id, $1, $2, $3, $4,
				$5, $5, $5, $6,
				$7, $8, $9, $10,
				$11,
				$12, $13, $14,
				'Por Emitir', 'Automatica', $15, $16, 'FAC',
				$17, $18, $19, $20, $21,
				$22, $23, ${invoiceTermsSql(4)}, true
			FROM (SELECT gen_random_uuid() AS id) g
			RETURNING id`,
			[
				issuer.company_id,
				issuer.client_id,
				issuer.client_entity_id,
				issuer.contract_id,
				invoice.issue_date,
				invoice.due_date,
				perLine ? (perLineInvoice?.tax ?? invoice.tax) : fixed ? fixed.vat : invoice.tax,
				invoice.tax_rate,
				invoice.subtotal,
				perLine ? (perLineInvoice?.subtotal ?? null) : sameCurrency ? invoice.subtotal : (fixed?.amount ?? null),
				perLine ? (perLineInvoice?.total ?? null) : sameCurrency ? invoice.total : (fixed?.total ?? null),
				contractCurrency,
				invoice.currency,
				fx,
				invoice.document_type,
				invoice.export_type,
				issuer.holding_id,
				issuer.company_legal_name,
				issuer.company_tax_id,
				issuer.company_address,
				issuer.entity_tax_id,
				issuer.requires_references_for_billing,
				issuer.auto_invoice,
			]
		)) as Row[];
		const invoiceId = String(header.id);

		await insertEngineLines(runner, issuer, invoiceId, invoice, fx, fixed?.lines ?? null, units);
		created.push(invoiceId);
	}
	// Montos en moneda del sistema (antes `auto_populate_invoice_fx_to_system`), con el encabezado ya completo.
	await refreshInvoiceSystemAmounts(runner, issuer.holding_id, created);

	return created;
}

/**
 * Líneas de una factura del generador dentro de una factura existente o recién creada, con `contract_item_id` en el INSERT
 * (costura: `standardize_invoice_items` y `auto_populate_invoice_item_fields` no corren para la API). `status` e
 * `issue_date` se copian del encabezado (lo que hacía `auto_populate_invoice_item_fields`); producto y monedas los pone la
 * API. `fx` es el tipo de cambio contrato → factura de esa factura (1 misma moneda, tasa fija o null en spot); con
 * `fixedLines` los montos en moneda de factura vienen ya convertidos, si no se derivan de `fx` (null → NULL, "se valoriza al
 * emitir").
 */
export async function insertEngineLines(
	runner: QueryRunner,
	issuer: Pick<InvoiceIssuer, 'holding_id' | 'contract_id' | 'contract_currency'>,
	invoiceId: string,
	invoice: Pick<PreviewInvoice, 'lines' | 'currency' | 'issue_date'>,
	fx: number | null,
	fixedLines: ReturnType<typeof fixedFxAmounts>['lines'] | null,
	units: InvoiceLineUnits
): Promise<string[]> {
	const contractCurrency = upper(issuer.contract_currency);
	const sameCurrency = upper(invoice.currency) === contractCurrency;
	const lineIds: string[] = [];
	const convert = (value: number) => (sameCurrency ? value : fx !== null ? round2(value * fx) : null);

	for (const [lineIndex, line] of invoice.lines.entries()) {
		const item = units.get(line.item_key);
		// Multimoneda (spec §3): la línea lleva la moneda del ítem (`contract_currency` = moneda de origen) y su propia tasa ítem → factura.
		const perLine = line.currency !== undefined;
		const lineAmounts = perLine ? (line.amounts_invoice_currency ?? null) : null;
		const fixedLine = perLine
			? lineAmounts
				? { unit_price: lineAmounts.unit_price, subtotal: lineAmounts.subtotal, tax_amount: lineAmounts.tax, total: lineAmounts.total }
				: null
			: (fixedLines?.[lineIndex] ?? null);
		const lineFx = perLine ? (line.fx ?? null) : fx;
		const lineConvert = (value: number) => (perLine ? null : convert(value));
		const [inserted] = (await runner.query(
			`INSERT INTO invoice_items (
				invoice_id, contract_item_id, description, quantity, unit_of_measure,
				unit_price_contract_currency, unit_price_invoice_currency, discount_pct,
				subtotal_contract_currency, subtotal_invoice_currency,
				tax_amount_contract_currency, tax_amount_invoice_currency,
				total_contract_currency, total_invoice_currency,
				holding_id, contract_id, product_id,
				contract_currency, invoice_currency, fx_contract_to_invoice,
				fx_rate_source, fx_rate_date, status, issue_date,
				billing_period_start, billing_period_end,
				quantity_source, pricing_breakdown
			) VALUES (
				$1, $26::uuid, $2, $3, $4,
				$5, $6, $7,
				$8, $9,
				$10, $11,
				$12, $13,
				$14, $15, $16,
				$17, $18, $19,
				$20, $21, (SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1),
				$22, $23,
				$24, $25::jsonb
			) RETURNING id`,
			[
				invoiceId,
				line.description,
				line.quantity,
				item?.unit_of_measure?.trim() || 'UND',
				line.unit_price,
				fixedLine
					? fixedLine.unit_price
					: perLine
						? null
						: sameCurrency
							? line.unit_price
							: fx !== null
								? Math.round(line.unit_price * fx * 1e6) / 1e6
								: null,
				round2(line.discount_pct),
				line.subtotal,
				fixedLine ? fixedLine.subtotal : lineConvert(line.subtotal),
				line.tax_amount,
				fixedLine ? fixedLine.tax_amount : lineConvert(line.tax_amount),
				line.total,
				fixedLine ? fixedLine.total : lineConvert(line.total),
				issuer.holding_id,
				issuer.contract_id,
				item?.product_id ?? null,
				perLine ? upper(line.currency) : contractCurrency,
				invoice.currency,
				lineFx,
				perLine ? (lineFx === null ? null : (line.fx_rate_source ?? 'contract')) : ACTIVATION_FX_RATE_SOURCE,
				perLine && lineFx === null ? null : invoice.issue_date,
				line.billing_period_start,
				line.billing_period_end,
				// Pricing v2: origen de la cantidad y desglose por tramo tal como los produjo el motor (NULL en líneas de hoy).
				line.quantity_source ?? 'fixed',
				line.pricing ? JSON.stringify(line.pricing.breakdown) : null,
				line.item_key,
			]
		)) as Row[];

		lineIds.push(String(inserted.id));
	}

	return lineIds;
}

/**
 * Contratos v2 — activación C2 (`docs/v2-rediseno/mapa-v2-contratos.md` §2b y §3), con vista previa.
 *
 * Por contrato y en su propia transacción con la costura `sapira.writer = 'api'` (los triggers legacy no corren): valida,
 * crea las facturas Por Emitir con el generador v2, fija booking (hoy si es null, S2-7), `company_currency` y el FX a la
 * moneda del sistema, deja el contrato Activo, reconstruye el RSM y registra el evento `ACTIVATION` (el historial v2; la
 * auditoría legacy `contract_change_log` no se escribe para la API). No escribe `contract_invoices` (decisión 2 del mapa).
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
				c.billing_anchor_day, c.booking_date::text AS booking_date, c.fx_rate_to_system,
				public.get_cutoff_date(c.holding_id, c.company_id)::text AS cutoff_date,
				c.payment_terms,
				c.document_type,
				c.invoice_description_template,
				c.tax_document_type_id, tdt.code AS tax_document_type_code, tdt.name AS tax_document_type_name,
				tdt.description_max_chars AS own_description_max_chars, ${DESCRIPTION_LIMITS_SQL} AS description_limits,
				co.id AS company_found, co.legal_name AS company_legal_name, co.tax_id AS company_tax_id, co.legal_address AS company_address,
				co.country AS company_country, co.currency AS company_currency, co.tax_rate AS company_tax_rate,
				ce.id AS entity_found, ce.legal_name AS entity_legal_name, ce.tax_id AS entity_tax_id, ce.country AS entity_country, ce.payment_terms AS entity_payment_terms,
				(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND COALESCE(i.is_legacy, false) = false
					AND i.status IS DISTINCT FROM 'Cancelada') AS invoices_count,
				(SELECT COUNT(*) FROM invoices i WHERE i.contract_id = c.id AND i.is_legacy = true
					AND i.status IS DISTINCT FROM 'Cancelada') AS legacy_invoices_count,
				(SELECT COALESCE(jsonb_agg(jsonb_build_object(
						'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
						'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
					FROM contract_fx_period_rates r
					WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'invoice') AS fx_invoice_rates,
				(SELECT COALESCE(jsonb_agg(jsonb_build_object(
						'from_currency', r.from_currency, 'to_currency', r.to_currency, 'rate', r.rate,
						'period_start', r.period_start, 'period_end', r.period_end, 'created_at', r.created_at)), '[]'::jsonb)
					FROM contract_fx_period_rates r
					WHERE r.contract_id = c.id AND r.holding_id = c.holding_id AND r.purpose = 'item') AS fx_item_rates,
				COALESCE(c.requires_multicurrency_billing, false) AS requires_multicurrency_billing,
				EXISTS (SELECT 1 FROM contract_items ci WHERE ci.contract_id = c.id AND ci.currency IS DISTINCT FROM c.contract_currency) AS currency_mismatch
			FROM contracts c
			LEFT JOIN companies co ON co.id = c.company_id AND co.holding_id = c.holding_id
			LEFT JOIN client_entities ce ON ce.id = c.client_entity_id AND ce.holding_id = c.holding_id
			LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id
			WHERE c.id = ANY($1::uuid[]) AND c.holding_id = $2 AND c.deleted_at IS NULL
			${lock ? 'FOR UPDATE OF c' : ''}`,
			[ids, holdingId]
		)) as Row[];

		return new Map(rows.map((row) => [String(row.id), row]));
	}

	/**
	 * Ítems con su modelo de precio (Pricing v2, `prices` vía `price_id`) y, para los medidos, los consumos ya registrados
	 * (`consumption_entries`) como `consumption` (jsonb agregado): un borrador normalmente no tiene, pero si los hay la
	 * activación los respeta.
	 */
	private async loadItems(db: Queryable, ids: string[], holdingId: string): Promise<Map<string, Row[]>> {
		const rows = (await db.query(
			`SELECT ci.contract_id, ci.id, ci.product_id, ci.product_name, ci.account, ci.unit_of_measure,
				ci.quantity, ci.unit_price, ci.annual_unit_price, ci.discount_type, ci.discount_value, ci.final_price,
				ci.billing_frequency, ci.billing_method, ci.start_date::text AS start_date, ci.end_date::text AS end_date,
				ci.term_months, ci.is_recurring, ci.currency, ${PRICE_COLUMNS},
				(SELECT COALESCE(jsonb_agg(jsonb_build_object(
						'period_start', e.period_start, 'quantity', e.quantity, 'amount_override', e.amount_override,
						'apply_item_discount', e.apply_item_discount, 'is_estimated', e.is_estimated)), '[]'::jsonb)
					FROM consumption_entries e WHERE e.contract_item_id = ci.id AND e.holding_id = c.holding_id) AS consumption
			FROM contract_items ci
			JOIN contracts c ON c.id = ci.contract_id
			LEFT JOIN prices p ON p.id = ci.price_id
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
			term_months: item.term_months === null || item.term_months === undefined ? null : toNumber(item.term_months),
			end_date: toText(item.end_date)?.slice(0, 10) ?? null,
			is_recurring: item.is_recurring !== false,
			final_price: item.final_price === null || item.final_price === undefined ? null : toNumber(item.final_price),
			price: priceSpecFromRow(item),
			consumption: ContractActivationService.consumptionOf(item),
			// Multimoneda: moneda del ítem (default la del contrato en el generador).
			...(toText(item.currency) ? { currency: upper(item.currency) } : {}),
		};
	}

	/** Consumos agregados en `loadItems` (jsonb) al formato del motor. */
	static consumptionOf(item: Row): ConsumptionInput[] {
		const raw = typeof item.consumption === 'string' ? (JSON.parse(item.consumption) as unknown) : item.consumption;

		if (!Array.isArray(raw)) return [];

		return raw.map((entry: Row) => ({
			period_start: toText(entry.period_start)?.slice(0, 10) ?? '',
			quantity: toNumber(entry.quantity),
			amount_override: entry.amount_override === null || entry.amount_override === undefined ? null : toNumber(entry.amount_override),
			apply_item_discount: entry.apply_item_discount !== false,
			is_estimated: entry.is_estimated === true,
		}));
	}

	/**
	 * Valida el contrato y corre el generador con su configuración guardada (`billing_anchor_day`, `payment_terms` y
	 * `document_type` vienen del contrato (migración 1790358766159 aplicada); si faltan, los defaults del
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
			warning_codes: [],
			invoices_count: 0,
			first_issue_date: null,
			indefinite_until: null,
			total_to_invoice: 0,
			currency: null,
			document_type: null,
			document_type_label: null,
			tax_document_type: null,
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
		// Moneda funcional = la de la compañía emisora (fuente de verdad); la copia del contrato solo si la compañía no la tiene.
		const companyCurrency = upper(contract.company_currency) || upper(contract.contract_company_currency);

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
		// Sin término (S1-12): un recurrente con plazo y fin NULL es válido (horizonte de 12 períodos).
		const indefinite = (item: Row) =>
			item.is_recurring !== false && (item.term_months === null || item.term_months === undefined) && !item.end_date;
		const incomplete = items.filter(
			(item) => !item.start_date || !(indefinite(item) || toNumber(item.term_months) > 0) || !(toNumber(item.quantity) > 0)
		).length;

		if (incomplete > 0) {
			block('incomplete_items', `${incomplete} ${incomplete === 1 ? 'ítem no tiene' : 'ítems no tienen'} inicio, plazo o cantidad válidos`);
		}
		// Multimoneda (spec §2): un ítem en otra moneda solo con `requires_multicurrency_billing`.
		const multicurrency = contract.requires_multicurrency_billing === true;

		if (contract.currency_mismatch === true && !multicurrency) block('currency_mismatch', 'Hay ítems en una moneda distinta a la del contrato');
		// Pricing v2 §3.7: un ítem por consumo se factura Vencido (salvo seat). El alta ya lo rechaza; acá cubre borradores tocados por fuera.
		const meteredAdvance = items.filter((item) => {
			const price = priceSpecFromRow(item);

			return isMetered(price) && price?.model !== 'seat' && toText(item.billing_method) === 'Anticipado';
		}).length;

		if (meteredAdvance > 0)
			block(
				'metered_advance',
				`${meteredAdvance} ${meteredAdvance === 1 ? 'ítem por consumo está' : 'ítems por consumo están'} Anticipado. ${METERED_ADVANCE_MESSAGE}`
			);
		const archivedPrices = items.filter((item) => item.price_id && toText(item.price_status) === 'archived').length;

		if (archivedPrices > 0)
			block('archived_price', `${archivedPrices} ${archivedPrices === 1 ? 'ítem apunta' : 'ítems apuntan'} a un modelo de precio archivado`);
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
						fixed_item_rates: Array.isArray(contract.fx_item_rates) ? (contract.fx_item_rates as FxPeriodRate[]) : [],
						multicurrency,
						document_type: toText(contract.document_type),
						company: { country: toText(contract.company_country), tax_rate: contract.company_tax_rate as number | string | null },
						entity_country: toText(contract.entity_country),
						// Glosa con la plantilla del contrato (spec facturas §3.6); sin plantilla, la de hoy.
						description_template: parseStoredTemplate(contract.invoice_description_template),
						description_context: { contract_number: toText(contract.contract_number), client_name: toText(contract.entity_legal_name) },
						// Las glosas generadas nunca superan el límite del documento (SII = 80): se ajustan en el origen.
						description_max_chars: descriptionMaxCharsOfRow(contract),
					},
					items: items.map((item) => ContractActivationService.engineItem(item)),
				})
			: null;
		// Sin día de ciclo guardado = automático (decisión de Domi 01-10): el generador usa el del primer ítem recurrente, sin aviso.
		const warnings = [...(engine?.warnings ?? [])];

		if (items.length && engine && engine.invoices.length === 0) block('no_invoices', 'El generador no produjo facturas para este contrato');
		// Período cerrado: ninguna factura generada puede emitirse en un mes ya cerrado (misma regla que modificaciones y facturas).
		const cutoff = toText(contract.cutoff_date)?.slice(0, 10) ?? null;
		const closedInvoices = cutoff ? (engine?.invoices ?? []).filter((invoice) => invoice.issue_date <= cutoff) : [];

		if (closedInvoices.length)
			blockers.push({
				code: 'period_closed',
				message: `${closedInvoices.length === 1 ? 'La factura del' : `${closedInvoices.length} facturas desde el`} ${
					closedInvoices[0].issue_date
				} ${closedInvoices.length === 1 ? 'cae' : 'caen'} en un período cerrado (cierre al ${cutoff})`,
				next_step: `${REOPEN_PERIOD_STEP}, o mueve el inicio de los ítems a un período abierto`,
			});

		// Tipo de cambio fijo de facturación: el generador toma, por factura, la tasa `purpose = 'invoice'` que cubre el inicio
		// de su período. La tasa es opcional al crear: una factura sin tasa nace sin FX y el scheduler no la emite (S6-2), así
		// que se avisa (no bloquea) y la tasa se define por factura desde el 360 › Facturas antes de emitir.
		const usesFixedFx = toText(contract.fx_invoice_policy) === 'fixed' && invoiceCurrency !== contractCurrency;
		const invoices = engine?.invoices ?? [];
		const fixedRates = invoices.map((invoice) => (usesFixedFx && invoice.fx !== null ? invoice.fx : null));
		const foreignItems = multicurrency ? items.filter((item) => (upper(item.currency) || contractCurrency) !== contractCurrency) : [];

		if (foreignItems.length && engine) {
			// Multimoneda (spec §5, §6, §11 MM4): bloqueos por par. Fija = cada línea valorizada al activar; spot se valoriza por par al emitir (MM4).
			for (const missing of ContractActivationService.multicurrencyBlockers(engine)) blockers.push(missing);
		} else if (usesFixedFx) {
			const missing = invoices.filter((invoice) => invoice.fx === null);

			if (missing.length) {
				warnings.push(
					`Tipo de cambio fijo sin tasa: define la tasa por factura antes de emitir (${missing.length === 1 ? '1 factura sin tasa' : `${missing.length} facturas sin tasa`} ${contractCurrency} → ${invoiceCurrency}, desde el ${missing[0].billing_period_start})`
				);
			}
		}

		const documentType = invoices[0]?.document_type ?? toText(contract.document_type);
		const taxDocumentType = contract.tax_document_type_id
			? {
					id: String(contract.tax_document_type_id),
					code: toText(contract.tax_document_type_code) ?? '',
					name: toText(contract.tax_document_type_name) ?? '',
				}
			: null;

		return {
			check: empty({
				contract_number: number,
				can_activate: blockers.length === 0,
				warnings,
				warning_codes: [...(engine?.warning_codes ?? [])],
				invoices_count: invoices.length,
				first_issue_date: invoices[0]?.issue_date ?? null,
				indefinite_until: engine?.indefinite_until ?? null,
				total_to_invoice: engine?.totals.invoiced_total ?? 0,
				currency: contractCurrency || null,
				document_type: documentType,
				// La usuaria ve el documento del catálogo ("Factura electrónica", "Factura de exportación electrónica"), no la familia.
				document_type_label: taxDocumentType?.name || documentTypeLabel(documentType),
				tax_document_type: taxDocumentType,
				sample: invoices.slice(0, 3),
			}),
			contract,
			items,
			engine,
			fixedRates,
		};
	}

	/**
	 * Bloqueos de activación de un contrato multimoneda (spec-multimoneda §5, §6 y §11 MM4), por par:
	 * - `item_fx_rate_missing`: un ítem en otra moneda sin tasa pactada ítem → contrato (MRR, TCV y devengo nunca a 1);
	 * - `fixed_fx_without_rate`: política fija y un par ítem → factura sin tasa para algún período (el documento saldría medio valorizado).
	 * Con política spot no hay bloqueo: el envío al ERP valoriza cada par con la tasa del día de emisión (MM4, `calculateInvoiceAmountsAtIssue`).
	 */
	static multicurrencyBlockers(engine: BillingEngineOutput): ActivationBlocker[] {
		const blockers: ActivationBlocker[] = [];
		const date = (iso: string) => iso.split('-').reverse().join('/');

		for (const missing of engine.fx_missing ?? []) {
			if (missing.purpose === 'item') {
				blockers.push({
					code: 'item_fx_rate_missing',
					message: `Falta la tasa pactada ${missing.from_currency} → ${missing.to_currency} para métricas desde el ${date(missing.period_start)}`,
					next_step: 'Agrega la tasa ítem → contrato del par en el borrador (tipos de cambio por par)',
				});
			} else {
				blockers.push({
					code: 'fixed_fx_without_rate',
					message: `Falta la tasa fija ${missing.from_currency} → ${missing.to_currency} para facturar desde el ${date(missing.period_start)}`,
					next_step: 'Agrega la tasa de facturación del par en el borrador o usa tipo de cambio del día',
				});
			}
		}

		return blockers;
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
		const activated: Array<{ id: string; contract_number: string | null; invoices_created: number; warning_codes: string[] }> = [];
		const skipped: Array<{ id: string; contract_number: string | null; blockers: ActivationBlocker[] }> = [];
		const failed: Array<{ id: string; contract_number: string | null; message: string }> = [];

		for (const id of [...new Set(ids)]) {
			const runner = this.dataSource.createQueryRunner();
			let contractNumber: string | null = null;

			await runner.connect();
			await runner.startTransaction();
			try {
				// Costura: primera sentencia de la transacción; los triggers legacy no corren y la API escribe cada campo.
				await setApiWriter(runner);
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
				activated.push({ id, contract_number: contractNumber, invoices_created: invoicesCreated, warning_codes: plan.check.warning_codes });
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
	 * Escribe la activación dentro de la transacción del contrato (con la marca `sapira.writer` ya fijada), en este orden:
	 * 1. facturas Por Emitir (encabezado = Σ líneas, `invoice_group_id`, condiciones del contrato, montos en moneda del sistema)
	 *    y sus líneas **con** `contract_item_id` en el INSERT. Cada línea lleva `quantity_source` y, si tiene modelo de precio,
	 *    `pricing_breakdown` (Pricing v2 §4.2);
	 * 2. con el contrato todavía en Borrador (el guard de período no mira borradores): `booking_date` = hoy si es null (S2-7,
	 *    antes `set_booking_date_on_activate`), `company_currency` = la de la compañía emisora (antes `set_contract_company_currency`,
	 *    que solo rellenaba NULL) y el FX a la moneda del sistema (antes `auto_calculate_contract_fx`);
	 * 3. `status = 'Activo'`;
	 * 4. `revenue_schedule_rebuild(contrato)` explícito (el rebuild del trigger de activación no corre);
	 * 5. evento `ACTIVATION`.
	 */
	private async persist(runner: QueryRunner, plan: ActivationPlan, holdingId: string, userId: string): Promise<number> {
		const contract = plan.contract!;
		const engine = plan.engine!;
		const contractId = String(contract.id);
		const contractCurrency = upper(contract.contract_currency);
		const systemCurrency = upper(contract.system_currency);
		const units = new Map(plan.items.map((item) => [String(item.id), item]));

		const invoiceIds = await insertEngineInvoices(
			runner,
			{
				contract_id: contractId,
				holding_id: holdingId,
				company_id: toText(contract.company_id),
				client_id: toText(contract.client_id),
				client_entity_id: toText(contract.client_entity_id),
				contract_currency: contractCurrency,
				system_currency: systemCurrency,
				company_legal_name: toText(contract.company_legal_name),
				company_tax_id: toText(contract.company_tax_id),
				company_address: toText(contract.company_address),
				entity_tax_id: toText(contract.entity_tax_id),
				requires_references_for_billing: contract.requires_references_for_billing === true,
				auto_invoice: contract.auto_invoice === true,
			},
			engine.invoices,
			plan.fixedRates,
			new Map([...units].map(([key, item]) => [key, { unit_of_measure: toText(item.unit_of_measure), product_id: toText(item.product_id) }]))
		);

		// Booking: se respeta si existe (S2-7). Moneda de la compañía: la de la compañía emisora (regla v2; el trigger
		// `set_contract_company_currency` solo la copiaba si venía NULL y dejaba contratos desalineados, auditoría S5b).
		await runner.query(
			`UPDATE contracts SET booking_date = COALESCE(booking_date, CURRENT_DATE),
				company_currency = COALESCE((SELECT co.currency FROM companies co WHERE co.id = contracts.company_id), company_currency)
			WHERE id = $1 AND holding_id = $2 AND status = $3`,
			[contractId, holdingId, DRAFT_STATUS]
		);
		await refreshContractSystemFx(runner, contractId, holdingId);

		const updated = (await runner.query(`UPDATE contracts SET status = $3 WHERE id = $1 AND holding_id = $2 AND status = $4 RETURNING id`, [
			contractId,
			holdingId,
			ACTIVE_STATUS,
			DRAFT_STATUS,
		])) as Row[];

		if (!updated.length) throw new Error('el contrato cambió de estado durante la activación');

		await runner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);
		const [after] = (await runner.query(
			`SELECT status, booking_date::text AS booking_date, company_currency, fx_rate_to_system FROM contracts WHERE id = $1 AND holding_id = $2`,
			[contractId, holdingId]
		)) as Row[];
		const itemsAffected = plan.items.map((item) => String(item.id));

		const total = engine.totals.invoiced_total;
		// El total del generador está en moneda de contrato (con conversión, cada factura se valoriza aparte).
		const currency = contractCurrency;
		const number = toText(contract.contract_number) ?? '';

		await runner.query(
			`INSERT INTO contract_lifecycle_events (
				contract_id, holding_id, event_type, event_status, title, description, created_by, completed_at, effective_date, metadata
				, items_affected
			) VALUES ($1, $2, 'ACTIVATION', 'Completed', 'Contrato activado', $3, $4, now(), CURRENT_DATE, $5::jsonb, $6::jsonb)`,
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
					// Trazabilidad (auditoría 01-10): antes/después de lo que escribe la activación, avisos, horizonte y lo creado.
					before: {
						status: toText(contract.status),
						booking_date: toText(contract.booking_date)?.slice(0, 10) ?? null,
						company_currency: toText(contract.contract_company_currency),
						fx_rate_to_system:
							contract.fx_rate_to_system === null || contract.fx_rate_to_system === undefined
								? null
								: toNumber(contract.fx_rate_to_system),
					},
					after: {
						status: toText(after?.status) ?? ACTIVE_STATUS,
						booking_date: toText(after?.booking_date)?.slice(0, 10) ?? null,
						company_currency: toText(after?.company_currency),
						fx_rate_to_system:
							after?.fx_rate_to_system === null || after?.fx_rate_to_system === undefined ? null : toNumber(after.fx_rate_to_system),
					},
					warning_codes: plan.check.warning_codes,
					indefinite_until: engine.indefinite_until ?? null,
					created_invoice_ids: invoiceIds,
					items_affected: itemsAffected,
				}),
				JSON.stringify(itemsAffected),
			]
		);

		return engine.invoices.length;
	}
}
