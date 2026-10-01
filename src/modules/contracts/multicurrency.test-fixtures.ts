/**
 * Fixtures de base simulada para los tests de servicio multimoneda (spec-multimoneda §4): contrato CLP con multimoneda, factura CLP, ítem USD
 * (fija 950) e ítem UF (fija 38.000); tasas pactadas ítem → contrato USD 900 y UF 37.000. `multicurrencyRoute` responde las consultas de
 * `multicurrency-invoices.ts` (contexto por par y revalorización); devuelve `undefined` para que el resto lo responda la ruta del spec.
 */

type Row = Record<string, unknown>;

export const MC_USD_ITEM = '99999999-9999-4999-8999-999999999999';
export const MC_UF_ITEM = '88888888-8888-4888-8888-888888888888';

export const MC_RATE_ROWS = (contractId: string): Row[] => [
	{
		contract_id: contractId,
		purpose: 'invoice',
		from_currency: 'USD',
		to_currency: 'CLP',
		rate: '950',
		period_start: '2026-01-01',
		period_end: '2027-12-31',
		created_at: '2026-09-01',
	},
	{
		contract_id: contractId,
		purpose: 'invoice',
		from_currency: 'UF',
		to_currency: 'CLP',
		rate: '38000',
		period_start: '2026-01-01',
		period_end: '2027-12-31',
		created_at: '2026-09-01',
	},
	{
		contract_id: contractId,
		purpose: 'item',
		from_currency: 'USD',
		to_currency: 'CLP',
		rate: '900',
		period_start: '2026-01-01',
		period_end: '2027-12-31',
		created_at: '2026-09-01',
	},
	{
		contract_id: contractId,
		purpose: 'item',
		from_currency: 'UF',
		to_currency: 'CLP',
		rate: '37000',
		period_start: '2026-01-01',
		period_end: '2027-12-31',
		created_at: '2026-09-01',
	},
];

export interface MulticurrencyFixture {
	contract_id: string;
	/** Facturas que la revalorización encuentra (Por Emitir de un contrato con el flag), por id. */
	invoices: Record<string, Row>;
	/** Líneas guardadas por factura que lee la revalorización. */
	lines: Record<string, Row[]>;
	fx_invoice_policy?: string;
}

/** Línea guardada de un documento de dos pares (montos en la moneda del ítem). */
export const mcStoredLine = (id: string, currency: 'USD' | 'UF', overrides: Row = {}): Row => ({
	id,
	contract_item_id: currency === 'USD' ? MC_USD_ITEM : MC_UF_ITEM,
	contract_currency: currency,
	fx_contract_to_invoice: currency === 'USD' ? '950' : '38000',
	fx_rate_source: 'contract',
	unit_price_contract_currency: currency === 'USD' ? '100' : '10',
	subtotal_contract_currency: currency === 'USD' ? '1000' : '10',
	tax_amount_contract_currency: currency === 'USD' ? '190' : '1.9',
	billing_period_start: '2026-10-01',
	...overrides,
});

export const mcInvoiceRow = (id: string, contractId: string, overrides: Row = {}): Row => ({
	id,
	contract_id: contractId,
	invoice_currency: 'CLP',
	tax_rate: '19',
	fallback_date: '2026-10-01',
	contract_currency: 'CLP',
	fx_invoice_policy: 'fixed',
	...overrides,
});

export function multicurrencyRoute(fixture: MulticurrencyFixture) {
	return (sql: string, params: unknown[] = []): Row[] | undefined => {
		if (sql.includes('multimoneda: contexto por par'))
			return [{ contract_currency: 'CLP', fx_invoice_policy: fixture.fx_invoice_policy ?? 'fixed' }];
		if (sql.includes('FROM contract_fx_period_rates WHERE contract_id = ANY')) return MC_RATE_ROWS(fixture.contract_id);
		if (sql.includes('ci.currency FROM contract_items ci'))
			return [
				{ id: MC_USD_ITEM, contract_id: fixture.contract_id, currency: 'USD' },
				{ id: MC_UF_ITEM, contract_id: fixture.contract_id, currency: 'UF' },
			];
		if (sql.includes('multimoneda: revalorizar por par'))
			return (params[0] as string[]).map((id) => fixture.invoices[id]).filter((row): row is Row => Boolean(row));
		if (sql.includes('ORDER BY ii.invoice_id, ii.created_at, ii.id'))
			return (params[0] as string[]).flatMap((id) => (fixture.lines[id] ?? []).map((row) => ({ invoice_id: id, ...row })));

		return undefined;
	};
}

/** Parámetros de la escritura por par de las líneas (`UPDATE invoice_items ii SET contract_currency = v.currency …`). */
export const revaluedLines = (calls: unknown[][]): Row[] =>
	calls
		.filter(([sql]) => String(sql).includes('FROM jsonb_to_recordset($2::jsonb)'))
		.flatMap(([, params]) => JSON.parse(String((params as unknown[])[1])) as Row[]);

/** Encabezados escritos por la revalorización (id, montos y FX). */
export const revaluedHeaders = (calls: unknown[][]) =>
	calls
		.filter(([sql]) => String(sql).includes('multimoneda: encabezado por par'))
		.map(([, params]) => {
			const values = params as unknown[];

			return {
				id: values[0],
				amount_contract_currency: values[2],
				vat: values[3],
				amount_invoice_currency: values[4],
				total_invoice_currency: values[5],
				fx: values[6],
			};
		});
