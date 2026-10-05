import { type BillingEngineContract, type BillingEngineItem, type FxPeriodRate, generateInvoices } from './billing-engine';

/**
 * Multimoneda en el generador (`docs/v2-rediseno/spec-multimoneda-contrato.md` §4–§5, MM2): contrato CLP con ítems UF + USD + CLP facturado en
 * CLP. Valorización por línea y par, encabezado = Σ líneas (NULL en moneda de factura con una spot), residuo por par y MRR/TCV con la tasa ítem.
 */
const rate = (from: string, to: string, value: number, start = '2026-01-01', end = '2026-12-31'): FxPeriodRate => ({
	from_currency: from,
	to_currency: to,
	rate: value,
	period_start: start,
	period_end: end,
});

const contract = (overrides: Partial<BillingEngineContract> = {}): BillingEngineContract => ({
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	fx_invoice_policy: 'fixed',
	payment_terms: { kind: 'net', days: 30 },
	company: { country: 'Chile', tax_rate: 19 },
	entity_country: 'Chile',
	fixed_invoice_rates: [rate('CLF', 'CLP', 39000.5), rate('USD', 'CLP', 950.555)],
	fixed_item_rates: [rate('CLF', 'CLP', 39000), rate('USD', 'CLP', 950)],
	...overrides,
});

const item = (key: string, currency: string, unit: number): BillingEngineItem => ({
	key,
	product_name: `Producto ${key}`,
	quantity: 1,
	unit_price: unit,
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	start_date: '2026-01-01',
	term_months: 2,
	is_recurring: true,
	currency,
});

const items = [item('uf', 'CLF', 2.5), item('usd-a', 'USD', 10.01), item('usd-b', 'USD', 20.03), item('clp', 'CLP', 50000)];

describe('billing-engine · multimoneda', () => {
	it('fija: cada línea con su par y tasa; residuo del par USD en su línea mayor; IVA por línea; encabezado = Σ líneas', () => {
		const output = generateInvoices({ contract: contract(), items });
		const [first] = output.invoices;
		const byKey = Object.fromEntries(first.lines.map((line) => [line.item_key, line]));

		expect(output.invoices).toHaveLength(2);
		expect(first.currency).toBe('CLP');
		expect(byKey.uf).toMatchObject({ currency: 'CLF', fx: 39000.5, fx_rate_source: 'contract', subtotal: 2.5 });
		expect(byKey.uf.amounts_invoice_currency).toEqual({ unit_price: 97501.25, subtotal: 97501.25, tax: 18525.24, total: 116026.49 });
		// USD: 10,01 × 950,555 = 9.515,06 y 20,03 × 950,555 = 19.039,62; Σ exacta 28.554,67 → −0,01 a la línea mayor.
		expect(byKey['usd-a'].amounts_invoice_currency).toMatchObject({ subtotal: 9515.06, tax: 1807.86 });
		expect(byKey['usd-b'].amounts_invoice_currency).toMatchObject({ subtotal: 19039.61, tax: 3617.53 });
		expect(byKey['usd-a'].fx).toBe(950.555);
		// Misma moneda que la factura: FX 1 y los mismos montos.
		expect(byKey.clp).toMatchObject({ currency: 'CLP', fx: 1, fx_rate_source: 'contract' });
		expect(byKey.clp.amounts_invoice_currency).toEqual({ unit_price: 50000, subtotal: 50000, tax: 9500, total: 59500 });
		// Encabezado en moneda de factura = Σ líneas; FX del documento NULL (dos pares convertidores).
		expect(first.amounts_invoice_currency).toEqual({ subtotal: 176055.92, tax: 33450.63, total: 209506.55 });
		expect(first.fx).toBeNull();
		// Encabezado en moneda de contrato = Σ líneas × tasa ítem → contrato (redondeo por línea).
		expect(first.subtotal).toBe(176038);
		expect(first.tax).toBe(33644.5);
		expect(output.fx_missing).toEqual([]);
	});

	it('MRR, valor del contrato y totales por ítem en moneda de contrato con la tasa ítem (y el valor en la moneda del ítem)', () => {
		const output = generateInvoices({ contract: contract(), items });

		expect(output.totals.mrr).toBe(176038);
		expect(output.totals.contract_value).toBe(352076);
		expect(output.totals.invoiced_total).toBe(352076);
		expect(output.items.find((row) => row.item_key === 'uf')).toMatchObject({
			currency: 'CLF',
			item_fx_rate: 39000,
			monthly_equivalent: 97500,
			monthly_equivalent_item_currency: 2.5,
			value: 195000,
			value_item_currency: 5,
		});
	});

	it('spot: las líneas que convierten quedan sin valorizar y el encabezado en moneda de factura NULL; la línea CLP sí', () => {
		const output = generateInvoices({ contract: contract({ fx_invoice_policy: 'spot' }), items });
		const [first] = output.invoices;
		const byKey = Object.fromEntries(first.lines.map((line) => [line.item_key, line]));

		expect(byKey.uf.fx).toBeNull();
		expect(byKey.uf.fx_rate_source).toBeNull();
		expect(byKey.uf.amounts_invoice_currency).toBeUndefined();
		expect(byKey.clp.fx).toBe(1);
		expect(byKey.clp.amounts_invoice_currency?.subtotal).toBe(50000);
		expect(first.fx).toBeNull();
		expect(first.amounts_invoice_currency).toBeUndefined();
		// La moneda de contrato no depende de la política de facturación.
		expect(first.subtotal).toBe(176038);
		expect(output.warnings.some((warning) => warning.includes('se valorizan al emitir'))).toBe(true);
	});

	it('sin vueltas (01-10): ítem MXN en contrato USD facturado en MXN → FX 1 y el monto del ítem tal cual, aunque falte la tasa ítem', () => {
		const mxn = { ...item('mxn', 'MXN', 17333.33), term_months: 1 };
		const usdContract = (fixed_item_rates: FxPeriodRate[]) =>
			contract({
				contract_currency: 'USD',
				invoice_currency: 'MXN',
				fixed_invoice_rates: [],
				fixed_item_rates,
				company: { country: 'México', tax_rate: 16 },
			});
		const withRate = generateInvoices({ contract: usdContract([rate('MXN', 'USD', 0.0571)]), items: [mxn] });
		const [line] = withRate.invoices[0].lines;

		// Nunca MXN → USD (tasa ítem) → MXN: la línea queda en su moneda con FX 1 y sin pedir tasa de factura.
		expect(line).toMatchObject({ currency: 'MXN', fx: 1, fx_rate_source: 'contract' });
		expect(line.amounts_invoice_currency).toMatchObject({ unit_price: 17333.33, subtotal: 17333.33 });
		expect(withRate.invoices[0].amounts_invoice_currency?.subtotal).toBe(17333.33);
		// La moneda de contrato (MRR/TCV) sí usa la tasa ítem: 17.333,33 × 0,0571 = 989,73.
		expect(withRate.invoices[0].subtotal).toBe(989.73);
		expect(withRate.fx_missing).toEqual([]);

		const withoutRate = generateInvoices({ contract: usdContract([]), items: [mxn] });

		expect(withoutRate.invoices[0].lines[0].amounts_invoice_currency?.subtotal).toBe(17333.33);
		expect(withoutRate.fx_missing.map((row) => row.purpose)).toEqual(['item']);
	});

	it('un solo par convertidor: el FX del documento es esa tasa', () => {
		const output = generateInvoices({ contract: contract(), items: [item('usd-a', 'USD', 10.01), item('clp', 'CLP', 50000)] });

		expect(output.invoices[0].fx).toBe(950.555);
	});

	it('sin tasa de factura o sin tasa ítem: fx_missing por par (con el primer período), la línea sin valorizar y el ítem fuera del MRR', () => {
		const output = generateInvoices({
			contract: contract({ fixed_invoice_rates: [rate('CLF', 'CLP', 39000.5)], fixed_item_rates: [rate('CLF', 'CLP', 39000)] }),
			items,
		});

		expect(output.fx_missing).toEqual([
			{ purpose: 'invoice', from_currency: 'USD', to_currency: 'CLP', period_start: '2026-01-01' },
			{ purpose: 'item', from_currency: 'USD', to_currency: 'CLP', period_start: '2026-01-01' },
		]);
		expect(output.invoices[0].amounts_invoice_currency).toBeUndefined();
		expect(output.totals.mrr).toBe(147500);
		expect(output.warnings).toContain('Tipo de cambio fijo: no hay tasa USD → CLP para el período que empieza el 01/01/2026');
	});

	it('sin ítems en otra moneda todo queda como antes: líneas sin campos por par y sin fx_missing', () => {
		const output = generateInvoices({ contract: contract(), items: [item('clp', 'CLP', 50000)] });

		expect(output.invoices[0].lines[0].currency).toBeUndefined();
		expect(output.invoices[0].fx).toBe(1);
		expect(output.fx_missing).toBeUndefined();
	});
});
