import { refreshInvoiceSystemAmounts } from './api-written-fields';
import { type PairRateContext, revalueByPair, type RevalueResult } from './multicurrency';

import type { FxPeriodRate } from './billing-engine';
import type { DataSource, QueryRunner } from 'typeorm';

/**
 * Persistencia de la valorización por par (spec-multimoneda §4) para las operaciones sobre Por Emitir que reescriben líneas fuera del motor:
 * editor (una y masivo), presentación por tramo, descuento puntual, reorganizar, facturar por OC, reemisión y facturas complementarias de
 * consumos. Cada servicio escribe sus líneas como siempre (con la moneda y tasa de la línea en contratos multimoneda) y al final llama a
 * `revalueMulticurrencyInvoices` con las facturas tocadas: solo actúa sobre las de contratos con `requires_multicurrency_billing` (en los
 * demás la consulta no devuelve filas y no escribe nada), revaloriza cada línea con su par y deja el encabezado = Σ líneas.
 */

type Db = Pick<DataSource, 'query'> | Pick<QueryRunner, 'query'>;
type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const toNullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value));
/** IVA del encabezado en porcentaje (0,19 → 19), misma regla que el generador. */
const taxPct = (value: unknown) => {
	const rate = toNumber(value);

	return rate > 0 && rate <= 1 ? rate * 100 : rate;
};

const rateRow = (row: Row): FxPeriodRate => ({
	from_currency: String(row.from_currency),
	to_currency: String(row.to_currency),
	rate: toNumber(row.rate),
	period_start: String(row.period_start ?? '').slice(0, 10),
	period_end: String(row.period_end ?? '').slice(0, 10),
	created_at: toText(row.created_at),
});

/** Contexto multimoneda de un contrato (política, tasas por par y propósito, moneda de cada ítem); null si el contrato no es multimoneda. */
export async function loadPairRateContext(db: Db, contractId: string, holdingId: string): Promise<PairRateContext | null> {
	const [contract] = ((await db.query(
		`SELECT c.contract_currency, c.fx_invoice_policy FROM contracts c
		WHERE c.id = $1 AND c.holding_id = $2 AND c.requires_multicurrency_billing IS TRUE /* multimoneda: contexto por par */`,
		[contractId, holdingId]
	)) ?? []) as Row[];

	if (!contract) return null;

	return (await pairContexts(db, [{ id: contractId, ...contract }], holdingId)).get(contractId) ?? null;
}

async function pairContexts(db: Db, contracts: Row[], holdingId: string): Promise<Map<string, PairRateContext>> {
	const ids = [...new Set(contracts.map((row) => String(row.id)))];
	const rates = ((await db.query(
		`SELECT contract_id, purpose, from_currency, to_currency, rate, period_start::text AS period_start, period_end::text AS period_end, created_at
		FROM contract_fx_period_rates WHERE contract_id = ANY($1::uuid[]) AND holding_id = $2 AND purpose IN ('invoice', 'item')`,
		[ids, holdingId]
	)) ?? []) as Row[];
	const items = ((await db.query(
		`SELECT ci.id, ci.contract_id, ci.currency FROM contract_items ci WHERE ci.contract_id = ANY($1::uuid[]) AND ci.holding_id = $2`,
		[ids, holdingId]
	)) ?? []) as Row[];
	const result = new Map<string, PairRateContext>();

	for (const contract of contracts) {
		const id = String(contract.id);
		const ofContract = rates.filter((row) => String(row.contract_id) === id);

		result.set(id, {
			contract_currency: String(contract.contract_currency ?? ''),
			fx_invoice_policy: toText(contract.fx_invoice_policy),
			invoice_rates: ofContract.filter((row) => row.purpose === 'invoice').map(rateRow),
			item_rates: ofContract.filter((row) => row.purpose === 'item').map(rateRow),
			item_currencies: Object.fromEntries(
				items.filter((row) => String(row.contract_id) === id && toText(row.currency)).map((row) => [String(row.id), String(row.currency)])
			),
		});
	}

	return result;
}

/**
 * Revaloriza por par las Por Emitir indicadas que sean de contratos multimoneda y escribe líneas (moneda de la línea = la del ítem, tasa y
 * origen de su par, montos en moneda de factura) y encabezado (= Σ líneas, FX del único par o NULL). Devuelve lo revalorizado por factura
 * (vacío si ninguna es multimoneda: en ese caso solo se hizo la consulta de selección).
 */
export async function revalueMulticurrencyInvoices(
	db: Pick<QueryRunner, 'query'>,
	holdingId: string,
	invoiceIds: string[]
): Promise<Map<string, RevalueResult>> {
	const ids = [...new Set(invoiceIds.filter(Boolean))];
	const result = new Map<string, RevalueResult>();

	if (!ids.length) return result;
	const invoices = ((await db.query(
		`SELECT i.id, i.contract_id, i.invoice_currency, i.tax_rate, COALESCE(i.issue_date, i.scheduled_at, CURRENT_DATE)::text AS fallback_date,
			c.contract_currency, c.fx_invoice_policy
		FROM invoices i JOIN contracts c ON c.id = i.contract_id
		WHERE i.id = ANY($1::uuid[]) AND i.holding_id = $2 AND i.status = 'Por Emitir' AND c.requires_multicurrency_billing IS TRUE
			AND COALESCE(i.invoice_type, '') NOT IN ('Unificada', 'Consolidada')
			-- Facturada por OC (línea visible + internas): su neto exacto lo fija esa operación; no se revaloriza ni se suman las internas.
			AND NOT EXISTS (SELECT 1 FROM invoice_items v WHERE v.invoice_id = i.id AND v.visible_line_id IS NOT NULL) /* multimoneda: revalorizar por par */`,
		[ids, holdingId]
	)) ?? []) as Row[];

	if (!Array.isArray(invoices) || !invoices.length) return result;
	const contexts = await pairContexts(
		db,
		invoices.map((row) => ({ id: row.contract_id, contract_currency: row.contract_currency, fx_invoice_policy: row.fx_invoice_policy })),
		holdingId
	);
	const lines = ((await db.query(
		`SELECT ii.id, ii.invoice_id, ii.contract_item_id, ii.contract_currency, ii.fx_contract_to_invoice, ii.fx_rate_source,
			ii.unit_price_contract_currency, ii.subtotal_contract_currency, ii.tax_amount_contract_currency, ii.billing_period_start::text AS billing_period_start
		FROM invoice_items ii WHERE ii.invoice_id = ANY($1::uuid[]) AND ii.holding_id = $2 ORDER BY ii.invoice_id, ii.created_at, ii.id`,
		[invoices.map((row) => row.id), holdingId]
	)) ?? []) as Row[];

	for (const invoice of invoices) {
		const id = String(invoice.id);
		const context = contexts.get(String(invoice.contract_id));
		const rows = lines.filter((row) => String(row.invoice_id) === id);

		if (!context || !rows.length) continue;
		const revalued = revalueByPair(
			rows.map((row) => ({
				id: String(row.id),
				contract_item_id: toText(row.contract_item_id),
				currency: toText(row.contract_currency),
				fx: toNullableNumber(row.fx_contract_to_invoice),
				fx_rate_source: toText(row.fx_rate_source),
				unit_price: toNumber(row.unit_price_contract_currency),
				subtotal: toNumber(row.subtotal_contract_currency),
				tax_amount: toNumber(row.tax_amount_contract_currency),
				period_start: toText(row.billing_period_start),
			})),
			context,
			{
				invoice_currency: toText(invoice.invoice_currency),
				tax_rate: taxPct(invoice.tax_rate),
				fallback_date: String(invoice.fallback_date).slice(0, 10),
			}
		);

		await db.query(
			`UPDATE invoice_items ii SET contract_currency = v.currency, fx_contract_to_invoice = v.fx,
				fx_rate_source = CASE WHEN v.fx IS NULL THEN NULL ELSE v.source END,
				fx_rate_date = CASE WHEN v.fx IS NULL THEN NULL WHEN ii.fx_contract_to_invoice IS NOT DISTINCT FROM v.fx THEN COALESCE(ii.fx_rate_date, CURRENT_DATE)
					ELSE CURRENT_DATE END,
				unit_price_invoice_currency = v.unit_price, subtotal_invoice_currency = v.subtotal, tax_amount_invoice_currency = v.tax,
				total_invoice_currency = v.total, updated_at = now()
			FROM jsonb_to_recordset($2::jsonb) AS v(id uuid, currency text, fx numeric, source text, unit_price numeric, subtotal numeric, tax numeric, total numeric)
			WHERE ii.id = v.id AND ii.holding_id = $1`,
			[
				holdingId,
				JSON.stringify(
					revalued.lines.map((line) => ({
						id: line.id,
						currency: line.currency,
						fx: line.fx,
						source: line.fx_rate_source,
						unit_price: line.unit_price,
						subtotal: line.subtotal,
						tax: line.tax,
						total: line.total,
					}))
				),
			]
		);
		await db.query(
			`UPDATE invoices SET amount_contract_currency = $3, vat = $4, amount_invoice_currency = $5, total_invoice_currency = $6, fx_contract_to_invoice = $7
			WHERE id = $1 AND holding_id = $2 AND status = 'Por Emitir' /* multimoneda: encabezado por par */`,
			[
				id,
				holdingId,
				revalued.header.amount_contract_currency,
				revalued.header.vat,
				revalued.header.amount_invoice_currency,
				revalued.header.total_invoice_currency,
				revalued.header.fx,
			]
		);
		result.set(id, revalued);
	}
	await refreshInvoiceSystemAmounts(db, holdingId, [...result.keys()]);

	return result;
}
