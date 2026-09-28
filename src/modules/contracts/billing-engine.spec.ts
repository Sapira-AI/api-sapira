import {
	addMonths,
	type BillingEngineContract,
	type BillingEngineItem,
	computeDueDate,
	generateInvoices,
	itemEndDate,
	lineDescription,
	monthsBetween,
	normalizeCountry,
	normalizeTaxRate,
	round2,
	suggestDocumentType,
} from './billing-engine';

const contract = (overrides: Partial<BillingEngineContract> = {}): BillingEngineContract => ({
	contract_currency: 'CLP',
	payment_terms: { kind: 'net', days: 30 },
	company: { country: 'Chile', tax_rate: 19 },
	entity_country: 'Chile',
	...overrides,
});

const item = (overrides: Partial<BillingEngineItem> = {}): BillingEngineItem => ({
	key: 'a',
	product_name: 'Licencia',
	quantity: 1,
	unit_price: 100,
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	start_date: '2026-01-01',
	term_months: 12,
	is_recurring: true,
	...overrides,
});

const sum = (values: number[]) => round2(values.reduce((total, value) => total + value, 0));

describe('billing-engine', () => {
	describe('fechas y fiscal', () => {
		it('suma meses como Postgres (último día si no existe) y calcula el fin del ítem', () => {
			expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
			expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
			expect(itemEndDate('2026-01-01', 12)).toBe('2026-12-31');
			expect(itemEndDate('2026-01-31', 1)).toBe('2026-02-27');
		});

		it('normaliza países escritos a mano y sugiere el tipo de documento', () => {
			expect(normalizeCountry('México')).toBe('MX');
			expect(normalizeCountry(' mexico ')).toBe('MX');
			expect(normalizeCountry('Perú')).toBe('PE');
			expect(normalizeCountry('CR')).toBe('CR');
			expect(normalizeCountry('')).toBeNull();
			expect(suggestDocumentType('Chile', 'Perú')).toBe('FACTURA_EXPORTACION');
			expect(suggestDocumentType('Perú', 'Peru')).toBe('FACTURA');
			expect(suggestDocumentType('Chile', null)).toBe('FACTURA');
		});

		it('interpreta la tasa de IVA en sus dos escalas (19 y 0,19)', () => {
			expect(normalizeTaxRate(19)).toBe(19);
			expect(normalizeTaxRate('0.19000000000000000000')).toBe(19);
			expect(normalizeTaxRate(0)).toBe(0);
			expect(normalizeTaxRate(null)).toBeNull();
		});

		it('mide tramos en meses de ciclo', () => {
			expect(monthsBetween('2026-01-01', '2026-03-31', 1)).toBe(3);
			expect(monthsBetween('2026-01-27', '2026-01-31', 1)).toBeCloseTo(5 / 31, 10);
			expect(monthsBetween('2026-01-15', '2026-03-10', 1)).toBeCloseTo(17 / 31 + 1 + 10 / 31, 10);
		});

		it('arma la glosa con cuenta y solo guion ASCII', () => {
			expect(lineDescription('Plan – Pro', 'ACME-1', '2026-01-01', '2026-01-31')).toBe(
				'Plan - Pro Cuenta ACME-1 - Periodo 01/01/2026 a 31/01/2026'
			);
			expect(lineDescription('Plan', null, '2026-01-01', '2026-01-31')).toBe('Plan - Periodo 01/01/2026 a 31/01/2026');
		});
	});

	describe('vencimiento', () => {
		it('aplica cada forma de condición de pago', () => {
			expect(computeDueDate('2026-01-15', { kind: 'net', days: 45 })).toBe('2026-03-01');
			expect(computeDueDate('2026-01-15', { kind: 'net', days: 0 })).toBe('2026-01-15');
			expect(computeDueDate('2026-01-15', { kind: 'end_of_month', days: 30 })).toBe('2026-03-02');
			expect(computeDueDate('2026-01-15', { kind: 'day_of_next_month', day: 17 })).toBe('2026-02-17');
			expect(computeDueDate('2026-01-15', { kind: 'day_of_next_month', day: 31 })).toBe('2026-02-28');
		});

		it('sin condición: México emisión + 1 mes; resto + 30 días', () => {
			expect(computeDueDate('2026-01-31', null, 'México')).toBe('2026-02-28');
			expect(computeDueDate('2026-01-31', null, 'Chile')).toBe('2026-03-02');
		});
	});

	describe('generateInvoices', () => {
		it('mensual anticipado 12 meses: 12 facturas al inicio de cada período, IVA de la compañía', () => {
			const result = generateInvoices({ contract: contract(), items: [item({ quantity: 2 })] });

			expect(result.invoices).toHaveLength(12);
			expect(result.invoices.map((invoice) => invoice.issue_date)).toEqual([
				'2026-01-01',
				'2026-02-01',
				'2026-03-01',
				'2026-04-01',
				'2026-05-01',
				'2026-06-01',
				'2026-07-01',
				'2026-08-01',
				'2026-09-01',
				'2026-10-01',
				'2026-11-01',
				'2026-12-01',
			]);
			expect(result.invoices[1]).toMatchObject({
				due_date: '2026-03-03',
				billing_period_start: '2026-02-01',
				billing_period_end: '2026-02-28',
				document_type: 'FACTURA',
				export_type: 0,
				currency: 'CLP',
				fx: 1,
				tax_rate: 19,
				subtotal: 200,
				tax: 38,
				total: 238,
			});
			expect(result.invoices[0].lines[0]).toMatchObject({
				item_key: 'a',
				quantity: 2,
				unit_price: 100,
				discount_pct: 0,
				subtotal: 200,
				tax_amount: 38,
				total: 238,
				description: 'Licencia - Periodo 01/01/2026 a 31/01/2026',
			});
			expect(result.totals).toEqual({ contract_value: 2400, invoiced_total: 2400, difference: 0 });
			expect(result.warnings).toEqual([]);
		});

		it('vencido emite al inicio del período siguiente', () => {
			const result = generateInvoices({ contract: contract(), items: [item({ billing_method: 'Vencido' })] });

			expect(result.invoices[0]).toMatchObject({
				issue_date: '2026-02-01',
				billing_period_start: '2026-01-01',
				billing_period_end: '2026-01-31',
			});
			expect(result.invoices.at(-1)).toMatchObject({ issue_date: '2027-01-01', billing_period_end: '2026-12-31' });
		});

		it('trimestral: cuota redondeada a 2 decimales y la diferencia en la última', () => {
			const result = generateInvoices({
				contract: contract(),
				items: [item({ quantity: 3, unit_price: 10.01, discount_value: 3, billing_frequency: 'Trimestral' })],
			});
			const subtotals = result.invoices.map((invoice) => invoice.subtotal);

			expect(result.invoices.map((invoice) => invoice.issue_date)).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
			expect(subtotals).toEqual([87.39, 87.39, 87.39, 87.38]);
			expect(sum(subtotals)).toBe(349.55);
			expect(result.invoices[0].lines[0]).toMatchObject({ quantity: 3, unit_price: 30.03, discount_pct: 3 });
			expect(result.totals.difference).toBe(0);
		});

		it('bianual = 24 meses', () => {
			const result = generateInvoices({
				contract: contract(),
				items: [item({ unit_price: 50, billing_frequency: 'Bianual', start_date: '2026-03-01', term_months: 48 })],
			});

			expect(result.invoices.map((invoice) => [invoice.issue_date, invoice.billing_period_end, invoice.subtotal])).toEqual([
				['2026-03-01', '2028-02-29', 1200],
				['2028-03-01', '2030-02-28', 1200],
			]);
			expect(result.invoices[0].lines[0].unit_price).toBe(1200);
		});

		it('no recurrente: una sola vez, al inicio y por el valor completo', () => {
			const result = generateInvoices({
				contract: contract(),
				items: [item({ is_recurring: false, quantity: 2, unit_price: 500, term_months: 3, billing_frequency: 'Mensual' })],
			});

			expect(result.invoices).toHaveLength(1);
			expect(result.invoices[0]).toMatchObject({
				issue_date: '2026-01-01',
				billing_period_start: '2026-01-01',
				billing_period_end: '2026-03-31',
				subtotal: 3000,
			});
			expect(result.invoices[0].lines[0]).toMatchObject({ quantity: 2, unit_price: 1500 });
		});

		it('descuento explícito en la línea (nunca 1 × total)', () => {
			const result = generateInvoices({ contract: contract(), items: [item({ quantity: 5, discount_value: 10, term_months: 1 })] });

			expect(result.invoices[0].lines[0]).toMatchObject({ quantity: 5, unit_price: 100, discount_pct: 10, subtotal: 450 });
		});

		it('descuento en monto fijo se expresa como porcentaje sobre el valor del ítem', () => {
			const result = generateInvoices({
				contract: contract(),
				items: [item({ quantity: 1, unit_price: 100, term_months: 4, discount_type: 'Monto fijo', discount_value: 40 })],
			});

			expect(result.invoices[0].lines[0]).toMatchObject({ discount_pct: 10, subtotal: 90 });
			expect(result.totals.contract_value).toBe(360);
		});

		it('exportación (país emisor ≠ receptor): FACTURA_EXPORTACION, export_type 1 y sin IVA', () => {
			const result = generateInvoices({ contract: contract({ entity_country: 'Perú' }), items: [item({ term_months: 1 })] });

			expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA_EXPORTACION', export_type: 1, tax_rate: 0, tax: 0, total: 100 });
		});

		it('el tipo de documento del contrato manda sobre la sugerencia', () => {
			const result = generateInvoices({
				contract: contract({ entity_country: 'Perú', document_type: 'FACTURA' }),
				items: [item({ term_months: 1 })],
			});

			expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA', export_type: 0, tax_rate: 19, tax: 19 });
		});

		it('Colombia: IVA 0 en Por Emitir (lo aplica Odoo)', () => {
			const result = generateInvoices({
				contract: contract({ company: { country: 'Colombia', tax_rate: 0.19 }, entity_country: 'Colombia' }),
				items: [item({ term_months: 1 })],
			});

			expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA', export_type: 0, tax_rate: 0, tax: 0 });
			expect(result.warnings).toContain('Compañía de Colombia: el IVA no se calcula en Por Emitir; lo aplica el ERP al emitir');
		});

		it('tasa guardada como fracción (0,19) se usa como 19 %', () => {
			const result = generateInvoices({
				contract: contract({ company: { country: 'Chile', tax_rate: 0.19 } }),
				items: [item({ term_months: 1 })],
			});

			expect(result.invoices[0]).toMatchObject({ tax_rate: 19, tax: 19 });
		});

		it('ítems mezclados: juntas agrupa por fecha de emisión, por ítem separa', () => {
			const items = [
				item({ key: 'm', product_name: 'Mensual', term_months: 3 }),
				item({ key: 't', product_name: 'Trimestral', billing_frequency: 'Trimestral', term_months: 3 }),
			];
			const together = generateInvoices({ contract: contract(), items });
			const separate = generateInvoices({ contract: contract({ group_invoices_by_period: false }), items });

			expect(together.invoices.map((invoice) => [invoice.issue_date, invoice.lines.map((line) => line.item_key)])).toEqual([
				['2026-01-01', ['m', 't']],
				['2026-02-01', ['m']],
				['2026-03-01', ['m']],
			]);
			expect(together.invoices[0]).toMatchObject({ subtotal: 400, billing_period_start: '2026-01-01', billing_period_end: '2026-03-31' });
			expect(separate.invoices.map((invoice) => [invoice.issue_date, invoice.lines.map((line) => line.item_key)])).toEqual([
				['2026-01-01', ['m']],
				['2026-01-01', ['t']],
				['2026-02-01', ['m']],
				['2026-03-01', ['m']],
			]);
			expect(together.totals).toEqual(separate.totals);
		});

		it('condiciones de pago en el vencimiento de cada factura', () => {
			const result = generateInvoices({
				contract: contract({ payment_terms: { kind: 'day_of_next_month', day: 17 } }),
				items: [item({ term_months: 2 })],
			});

			expect(result.invoices.map((invoice) => invoice.due_date)).toEqual(['2026-02-17', '2026-03-17']);
		});

		it('México sin condiciones: emisión + 1 mes, con advertencia', () => {
			const result = generateInvoices({
				contract: contract({ payment_terms: null, company: { country: 'México', tax_rate: 16 }, entity_country: 'Mexico' }),
				items: [item({ start_date: '2026-01-31', term_months: 1 })],
			});

			expect(result.invoices[0]).toMatchObject({ issue_date: '2026-01-31', due_date: '2026-02-28', document_type: 'FACTURA', tax_rate: 16 });
			expect(result.warnings).toContain('Sin condiciones de pago: vencimiento al mes siguiente de la emisión (México)');
		});

		it('sin condiciones de pago: + 30 días y advertencia', () => {
			const result = generateInvoices({ contract: contract({ payment_terms: null }), items: [item({ term_months: 1 })] });

			expect(result.invoices[0].due_date).toBe('2026-01-31');
			expect(result.warnings).toContain('Sin condiciones de pago: vencimiento a 30 días');
		});

		it('primer tramo proporcional por días en la factura del primer ciclo (manual §11: 100 × 5/31 = 16,13)', () => {
			const result = generateInvoices({
				contract: contract({ billing_anchor_day: 1 }),
				items: [item({ start_date: '2026-01-27', term_months: 12 })],
			});
			const lines = result.invoices.flatMap((invoice) => invoice.lines);

			expect(result.invoices[0].issue_date).toBe('2026-02-01');
			expect(result.invoices[0].lines.map((line) => [line.billing_period_start, line.billing_period_end, line.subtotal])).toEqual([
				['2026-01-27', '2026-01-31', 16.13],
				['2026-02-01', '2026-02-28', 100],
			]);
			// Último período corto: 1 al 26 de enero de 2027 = 26/31 (y la suma cuadra con el valor del ítem).
			expect(lines.at(-1)).toMatchObject({ billing_period_start: '2027-01-01', billing_period_end: '2027-01-26', subtotal: 83.87 });
			expect(sum(lines.map((line) => line.subtotal))).toBe(1200);
			expect(result.totals.difference).toBe(0);
		});

		it('primer tramo del caso Bosch (47,91 desde el 08-09: 23/30 = 36,73)', () => {
			const result = generateInvoices({
				contract: contract({ billing_anchor_day: 1 }),
				items: [item({ unit_price: 47.91, start_date: '2026-09-08', term_months: 4 })],
			});

			expect(result.invoices[0].lines[0]).toMatchObject({
				billing_period_start: '2026-09-08',
				billing_period_end: '2026-09-30',
				subtotal: 36.73,
			});
		});

		it('día de ciclo por defecto = día del primer inicio de los recurrentes; otro ítem con otro día prorratea', () => {
			const result = generateInvoices({
				contract: contract(),
				items: [item({ key: 'a', start_date: '2026-01-15', term_months: 2 }), item({ key: 'b', start_date: '2026-02-10', term_months: 1 })],
			});
			const stub = result.invoices.flatMap((invoice) => invoice.lines).find((line) => line.item_key === 'b')!;

			expect(result.invoices[0]).toMatchObject({ issue_date: '2026-01-15', billing_period_end: '2026-02-14' });
			expect(stub).toMatchObject({ billing_period_start: '2026-02-10', billing_period_end: '2026-02-14', subtotal: 16.13 });
		});

		it('día de ciclo 31 se ajusta al último día de los meses cortos', () => {
			const result = generateInvoices({
				contract: contract({ billing_anchor_day: 31 }),
				items: [item({ start_date: '2026-01-31', term_months: 3 })],
			});

			expect(result.invoices.map((invoice) => [invoice.issue_date, invoice.billing_period_end, invoice.subtotal])).toEqual([
				['2026-01-31', '2026-02-27', 100],
				['2026-02-28', '2026-03-30', 100],
				['2026-03-31', '2026-04-29', 100],
			]);
		});

		it('moneda de facturación distinta: FX null, montos en moneda de contrato y advertencia', () => {
			const result = generateInvoices({
				contract: contract({ contract_currency: 'USD', invoice_currency: 'CLP' }),
				items: [item({ term_months: 1 })],
			});

			expect(result.invoices[0]).toMatchObject({ currency: 'CLP', fx: null, subtotal: 100 });
			expect(result.warnings).toContain('Se factura en CLP y el contrato está en USD: los montos están en USD y se valorizan al emitir');
		});

		it('omite con advertencia los ítems incompletos', () => {
			const result = generateInvoices({ contract: contract(), items: [item({ term_months: 0 })] });

			expect(result.invoices).toEqual([]);
			expect(result.warnings[0]).toContain('no tiene inicio, plazo o cantidad válidos');
		});
	});
});

describe('billing-engine · tipo de cambio fijo de facturación', () => {
	const rate = (from: string, to: string, value: number, start: string, end: string) => ({
		from_currency: from,
		to_currency: to,
		rate: value,
		period_start: start,
		period_end: end,
	});

	it('regla única "1 [from] = rate [to]": la directa se multiplica y la inversa se divide', () => {
		const direct = generateInvoices({
			contract: contract({
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fixed_invoice_rates: [rate('CLP', 'USD', 0.001, '2026-01-01', '2026-12-31')],
			}),
			items: [item({ term_months: 2 })],
		});

		expect(direct.invoices[0]).toMatchObject({ fx: 0.001, subtotal: 100, amounts_invoice_currency: { subtotal: 0.1, tax: 0.02, total: 0.12 } });

		// Fila vieja inversa (USD → CLP, 1 USD = 1.000 CLP): el multiplicador CLP → USD es 1/1.000.
		const inverse = generateInvoices({
			contract: contract({
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fixed_invoice_rates: [rate('USD', 'CLP', 1000, '2026-01-01', '2026-12-31')],
			}),
			items: [item({ term_months: 2 })],
		});

		expect(inverse.invoices[0].fx).toBe(0.001);
	});

	it('cada factura toma la tasa que cubre el inicio de su período; sin tasa queda con FX null y advertencia', () => {
		const output = generateInvoices({
			contract: contract({
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fixed_invoice_rates: [rate('CLP', 'USD', 0.001, '2026-01-01', '2026-01-31'), rate('CLP', 'USD', 0.002, '2026-02-01', '2026-02-28')],
			}),
			items: [item({ term_months: 3 })],
		});

		expect(output.invoices.map((invoice) => invoice.fx)).toEqual([0.001, 0.002, null]);
		expect(output.invoices[2].amounts_invoice_currency).toBeUndefined();
		expect(output.warnings).toContain('Tipo de cambio fijo: no hay tasa CLP → USD para el período que empieza el 01/03/2026');
		expect(output.warnings.some((warning) => warning.includes('se valorizan al emitir'))).toBe(false);
	});

	it('spot o sin política: las tasas se ignoran', () => {
		const output = generateInvoices({
			contract: contract({
				invoice_currency: 'USD',
				fx_invoice_policy: 'spot',
				fixed_invoice_rates: [rate('CLP', 'USD', 0.001, '2026-01-01', '2026-12-31')],
			}),
			items: [item({ term_months: 1 })],
		});

		expect(output.invoices[0].fx).toBeNull();
		expect(output.warnings.some((warning) => warning.includes('se valorizan al emitir'))).toBe(true);
	});
});
