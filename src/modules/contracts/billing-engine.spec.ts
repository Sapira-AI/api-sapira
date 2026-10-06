import {
	addMonths,
	type BillingEngineContract,
	type BillingEngineItem,
	computeDueDate,
	effectiveTermMonths,
	generateInvoices,
	INDEFINITE_HORIZON_CODE,
	isIndefiniteItem,
	itemEndDate,
	lineDescription,
	monthsBetween,
	normalizeCountry,
	normalizeTaxRate,
	PRORATED_PERIOD_CODE,
	resolveTaxRate,
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
			// Países escritos en inglés o sin alias hasta el 05-10 (contratos de SimpliRoute en producción).
			expect(normalizeCountry('Dominican Republic')).toBe('DO');
			expect(normalizeCountry('República Dominicana')).toBe('DO');
			expect(normalizeCountry('BOLIVIA')).toBe('BO');
			expect(normalizeCountry('Venezuela')).toBe('VE');
			expect(normalizeCountry('AUSTRALIA')).toBe('AU');
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
			expect(result.totals).toEqual({ contract_value: 2400, invoiced_total: 2400, difference: 0, mrr: 200 });
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

		describe('tasa por documento tributario (Configuración v2 ronda 3)', () => {
			it('documento con tasa propia (34 exenta = 0) manda sobre la de la compañía', () => {
				const result = generateInvoices({
					contract: contract({ document_type: 'FACTURA', tax_document: { kind: 'invoice', tax_rate: 0 } }),
					items: [item({ term_months: 1 })],
				});

				expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA', tax_rate: 0, tax: 0, total: 100 });
				expect(result.warnings.some((warning) => warning.includes('IVA'))).toBe(false);
			});

			it('documento sin tasa (null) usa la de la compañía, aunque venga como fracción', () => {
				const result = generateInvoices({
					contract: contract({ company: { country: 'Chile', tax_rate: 0.19 }, tax_document: { kind: 'invoice', tax_rate: null } }),
					items: [item({ term_months: 1 })],
				});

				expect(result.invoices[0]).toMatchObject({ tax_rate: 19, tax: 19 });
			});

			it('exportación sigue en 0 aunque el documento tenga tasa', () => {
				const result = generateInvoices({
					contract: contract({ document_type: 'FACTURA_EXPORTACION', tax_document: { kind: 'export_invoice', tax_rate: 19 } }),
					items: [item({ term_months: 1 })],
				});

				expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA_EXPORTACION', export_type: 1, tax_rate: 0, tax: 0 });
			});

			it('Colombia sigue en 0 (lo aplica el ERP) aunque FE tenga 19', () => {
				const result = generateInvoices({
					contract: contract({
						company: { country: 'Colombia', tax_rate: 19 },
						entity_country: 'Colombia',
						tax_document: { kind: 'invoice', tax_rate: 19 },
					}),
					items: [item({ term_months: 1 })],
				});

				expect(result.invoices[0]).toMatchObject({ tax_rate: 0, tax: 0 });
				expect(result.warnings).toContain('Compañía de Colombia: el IVA no se calcula en Por Emitir; lo aplica el ERP al emitir');
			});

			it('resolveTaxRate: la tasa de un documento de exportación no se aplica a una factura nacional; 1 % no se lee como fracción', () => {
				expect(
					resolveTaxRate({
						documentType: 'FACTURA',
						companyCountry: 'CL',
						companyTaxRate: 19,
						document: { kind: 'export_invoice', tax_rate: 0 },
					})
				).toEqual({
					rate: 19,
					rule: 'company',
				});
				expect(
					resolveTaxRate({ documentType: 'FACTURA', companyCountry: 'CL', companyTaxRate: 19, document: { kind: 'invoice', tax_rate: 1 } })
				).toEqual({
					rate: 1,
					rule: 'document',
				});
				expect(resolveTaxRate({ documentType: 'FACTURA', companyCountry: 'PE', companyTaxRate: null })).toEqual({
					rate: null,
					rule: 'company',
				});
			});
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
			expect(result.warning_codes).toEqual([]);
			expect(result.indefinite_until).toBeNull();
		});

		it('sin término (S1-12): horizonte de 12 períodos de la frecuencia, valor sobre el horizonte y advertencia con código', () => {
			expect(isIndefiniteItem(item({ term_months: null }))).toBe(true);
			expect(isIndefiniteItem(item({ term_months: null, end_date: '2026-12-31' }))).toBe(false);
			expect(isIndefiniteItem(item({ term_months: null, is_recurring: false }))).toBe(false);
			expect(effectiveTermMonths(item({ term_months: null, billing_frequency: 'Trimestral' }))).toBe(36);

			const monthly = generateInvoices({ contract: contract(), items: [item({ term_months: null })] });

			expect(monthly.invoices).toHaveLength(12);
			expect(monthly.invoices.at(-1)).toMatchObject({ billing_period_start: '2026-12-01', billing_period_end: '2026-12-31' });
			expect(monthly.totals).toEqual({ contract_value: 1200, invoiced_total: 1200, difference: 0, mrr: 100 });
			expect(monthly.warning_codes).toEqual([INDEFINITE_HORIZON_CODE]);
			expect(monthly.indefinite_until).toBe('2026-12-31');
			expect(monthly.warnings).toContain(
				'"Licencia" no tiene término: se generan facturas hasta el 31/12/2026 (12 períodos); las siguientes se generan después'
			);

			const quarterly = generateInvoices({ contract: contract(), items: [item({ term_months: null, billing_frequency: 'Trimestral' })] });

			expect(quarterly.invoices).toHaveLength(12);
			expect(quarterly.indefinite_until).toBe('2028-12-31');
			expect(quarterly.totals.invoiced_total).toBe(3600);

			// Con fin explícito o plazo, nada cambia: ni código ni horizonte.
			const finite = generateInvoices({ contract: contract(), items: [item({ term_months: null, end_date: '2026-03-31' })] });

			expect(finite.invoices).toHaveLength(3);
			expect(finite.warning_codes).toEqual([]);
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

describe('generateInvoices · Pricing v2 (ítems con modelo de precio)', () => {
	const tiers = [
		{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
		{ from: 501, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
		{ from: 2001, to: null, per_unit_amount: 0.045, flat_amount: 0 },
	];
	const metered = (overrides: Partial<BillingEngineItem> = {}): BillingEngineItem =>
		item({
			key: 'rutas',
			product_name: 'Rutas optimizadas',
			quantity: 1000,
			unit_price: 0,
			discount_value: 10,
			billing_method: 'Vencido',
			start_date: '2026-10-01',
			term_months: 3,
			price: {
				model: 'graduated',
				quantity_type: 'metered',
				billable_metric_id: 'm-1',
				tiers,
				free_units: 100,
				minimum_amount: 50,
				cap_amount: 80,
			},
			...overrides,
		});

	it('las líneas de hoy salen con quantity_source fixed y sin desglose', () => {
		const { invoices } = generateInvoices({ contract: contract(), items: [item({ start_date: '2026-10-01', term_months: 1 })] });

		expect(invoices[0].lines[0]).toMatchObject({ quantity_source: 'fixed' });
		expect(invoices[0].lines[0].pricing).toBeUndefined();
	});

	it('standard fijo con price se calcula como hoy (unitario mensual × cantidad × meses)', () => {
		const withPrice = generateInvoices({
			contract: contract(),
			items: [item({ start_date: '2026-10-01', term_months: 2, price: { model: 'standard', quantity_type: 'fixed', unit_amount: 999 } })],
		});
		const without = generateInvoices({ contract: contract(), items: [item({ start_date: '2026-10-01', term_months: 2 })] });

		expect(withPrice.invoices.map((invoice) => invoice.subtotal)).toEqual(without.invoices.map((invoice) => invoice.subtotal));
		expect(withPrice.totals).toEqual(without.totals);
	});

	it('medido sin consumo: cada cuota usa la cantidad base con quantity_source pending y advierte; el valor contratado suma el mínimo por período', () => {
		const result = generateInvoices({ contract: contract(), items: [metered()] });

		expect(result.invoices).toHaveLength(3);
		// Vencido: la cuota de octubre se emite el 1 de noviembre; 1.000 rutas → gratis 100, 400 × 0,08 + 10 = 42, 500 × 0,06 = 30 → 72 − 10 % = 64,80.
		expect(result.invoices[0]).toMatchObject({
			issue_date: '2026-11-01',
			billing_period_start: '2026-10-01',
			billing_period_end: '2026-10-31',
			subtotal: 64.8,
		});
		const line = result.invoices[0].lines[0];

		expect(line).toMatchObject({
			quantity: 1000,
			quantity_source: 'pending',
			unit_price: 0.0648,
			subtotal: 64.8,
			discount_pct: 10,
			tax_amount: 12.31,
			total: 77.11,
		});
		expect(line.pricing?.breakdown.map((subline) => [subline.kind, subline.amount])).toEqual([
			['free', 0],
			['tier', 42],
			['tier', 30],
			['discount', -7.2],
		]);
		// §3.8 `single`: la glosa base más el detalle compacto por tramo (solo ASCII).
		expect(line.description).toBe(
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.000 x 0,06; descuento -7,20'
		);
		expect(result.totals).toEqual({ contract_value: 150, invoiced_total: 194.4, difference: 44.4, mrr: 64.8 });
		expect(result.warnings).toContain(
			'Consumo por informar en "Rutas optimizadas": la línea usa la cantidad base del ítem y se recalcula al registrar'
		);
	});

	it('medido con consumo registrado: la cuota del período toma la cantidad (real o estimada) y su desglose; las demás quedan pendientes', () => {
		const result = generateInvoices({
			contract: contract(),
			items: [
				metered({
					consumption: [
						{ period_start: '2026-10-01', quantity: 1250 },
						{ period_start: '2026-11-01', quantity: 300, is_estimated: true },
					],
				}),
			],
		});
		const [october, november, december] = result.invoices.map((invoice) => invoice.lines[0]);

		expect(october).toMatchObject({ quantity: 1250, quantity_source: 'consumption', subtotal: 78.3 });
		expect(november).toMatchObject({ quantity: 300, quantity_source: 'estimated', subtotal: 50 });
		expect(november.pricing?.breakdown.at(-1)).toMatchObject({ kind: 'minimum', amount: 26.6 });
		expect(december).toMatchObject({ quantity: 1000, quantity_source: 'pending' });
		expect(result.invoices.map((invoice) => invoice.subtotal)).toEqual([78.3, 50, 64.8]);
	});

	it('invoice_line_mode per_tier: la cuota produce una fila por tramo más una por ajuste, del mismo ítem y período, con el IVA repartido y Σ = subtotal (§3.8)', () => {
		const result = generateInvoices({
			contract: contract(),
			items: [metered({ term_months: 1, price: { ...metered().price!, invoice_line_mode: 'per_tier' } })],
		});
		const [invoice] = result.invoices;

		expect(invoice.lines.map((line) => [line.quantity, line.unit_price, line.subtotal, line.tax_amount, line.line_part?.part])).toEqual([
			[400, 0.105, 42, 7.98, 'charge'],
			[500, 0.06, 30, 5.7, 'charge'],
			[1, -7.2, -7.2, -1.37, 'adjustment'],
		]);
		expect(invoice.lines.map((line) => line.description)).toEqual([
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramo 1 (1-500)',
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramo 2 (501-2.000)',
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Descuento del ítem 10 %',
		]);
		expect(new Set(invoice.lines.map((line) => line.line_group))).toEqual(new Set(['rutas|2026-10-01']));
		expect(invoice.lines.every((line) => line.item_key === 'rutas' && line.quantity_source === 'pending')).toBe(true);
		expect(invoice.lines[0].pricing?.breakdown.map((subline) => subline.kind)).toEqual(['free', 'tier']);
		expect(invoice.lines[0].pricing?.breakdown[1]).toMatchObject({ period_quantity: 1000, line_index: 0, line_count: 3 });
		// Encabezado y totales iguales que en single.
		expect(invoice).toMatchObject({ subtotal: 64.8, tax: 12.31, total: 77.11 });
		expect(result.totals).toEqual({ contract_value: 50, invoiced_total: 64.8, difference: 14.8, mrr: 64.8 });
	});

	it('per_tier con nombre de producto largo y límite SII (80): cada fila se ajusta en el origen y la salida avisa description_fitted', () => {
		const product = 'Plataforma de optimización de rutas de última milla para flota refrigerada';
		const priced = { ...metered().price!, invoice_line_mode: 'per_tier' as const };
		const plain = generateInvoices({
			contract: contract(),
			items: [metered({ term_months: 1, product_name: product, account: 'Santiago Centro', price: priced })],
		});
		const result = generateInvoices({
			contract: contract({ description_max_chars: 80 }),
			items: [metered({ term_months: 1, product_name: product, account: 'Santiago Centro', price: priced })],
		});
		const descriptions = result.invoices[0].lines.map((line) => line.description);

		// Sin límite la glosa de hoy supera 80 (y no se ajusta ni avisa).
		expect(plain.invoices[0].lines.every((line) => line.description.length > 80)).toBe(true);
		expect(plain.warning_codes).not.toContain('description_fitted');
		expect(descriptions.every((text) => text.length <= 80)).toBe(true);
		// Período corto primero; el tramo (lo que distingue cada fila) queda intacto al final.
		expect(descriptions[0]).toMatch(/oct-26 - Tramo 1 \(1-500\)$/);
		expect(descriptions[1]).toMatch(/Tramo 2 \(501-2\.000\)$/);
		expect(new Set(descriptions).size).toBe(descriptions.length);
		expect(result.warning_codes).toContain('description_fitted');
		expect(result.description_fitted_lines).toBe(descriptions.length);
		expect(result.warnings).toContain(
			`${descriptions.length} descripciones se ajustaron automáticamente al límite de 80 caracteres del documento`
		);
		// Montos intactos: el ajuste solo toca la glosa.
		expect(result.invoices[0].subtotal).toBe(plain.invoices[0].subtotal);
	});

	it('precio por tramos con cantidad fija: quantity_source fixed, valor contratado = Σ cuotas; el descuento en monto fijo se omite con aviso', () => {
		const result = generateInvoices({
			contract: contract(),
			items: [
				item({
					key: 'lic',
					quantity: 12,
					unit_price: 0,
					start_date: '2026-10-01',
					term_months: 2,
					discount_value: 5,
					discount_type: 'Monto fijo',
					price: {
						model: 'graduated',
						quantity_type: 'fixed',
						tiers: [
							{ from: 1, to: 5, per_unit_amount: 13, flat_amount: 0 },
							{ from: 6, to: 10, per_unit_amount: 7, flat_amount: 0 },
							{ from: 11, to: null, per_unit_amount: 5.5, flat_amount: 0 },
						],
					},
				}),
			],
		});

		expect(result.invoices.map((invoice) => invoice.lines[0])).toMatchObject([
			{ quantity: 12, quantity_source: 'fixed', subtotal: 111, unit_price: 9.25 },
			{ quantity: 12, quantity_source: 'fixed', subtotal: 111 },
		]);
		expect(result.totals).toEqual({ contract_value: 222, invoiced_total: 222, difference: 0, mrr: 111 });
		expect(result.warnings).toContain('El descuento en monto fijo de "Licencia" no aplica a un modelo de precio por consumo o tramos: se omite');
	});

	it('período parcial con cantidad fija (inicio distinto del día de ciclo): se prorratea por días como el estándar', () => {
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 1 }),
			items: [
				item({
					key: 's',
					quantity: 3,
					start_date: '2026-10-15',
					term_months: 2,
					price: { model: 'seat', quantity_type: 'fixed', unit_amount: 10 },
				}),
			],
		});

		const lines = result.invoices.flatMap((invoice) => invoice.lines);

		// 3 asientos × 10 = 30 por período mensual. Tramo 15-10 → 31-10: 17/31 × 30; último 01-12 → 14-12: 14/31 × 30.
		expect(lines[0]).toMatchObject({
			billing_period_start: '2026-10-15',
			billing_period_end: '2026-10-31',
			subtotal: 16.45,
			prorated: true,
			prorated_days: 17,
		});
		expect(lines[0].pricing?.subtotal).toBe(16.45);
		expect(sum(lines[0].pricing?.breakdown.map((subline) => subline.amount) ?? [])).toBe(16.45);
		expect(lines[1]).toMatchObject({ billing_period_start: '2026-11-01', subtotal: 30 });
		expect(lines[1].prorated).toBeUndefined();
		expect(lines[2]).toMatchObject({
			billing_period_start: '2026-12-01',
			billing_period_end: '2026-12-14',
			subtotal: 13.55,
			prorated: true,
			prorated_days: 14,
		});
		expect(result.totals).toMatchObject({ contract_value: 60, invoiced_total: 60, mrr: 30 });
		expect(result.warnings).toContain('Primer período prorrateado: 17 días ("Licencia", 15/10/2026 a 31/10/2026)');
		expect(result.warnings).toContain('Último período prorrateado: 14 días ("Licencia", 01/12/2026 a 14/12/2026)');
	});

	it('medido en un período parcial: el consumo no se prorratea (avisa)', () => {
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 1 }),
			items: [
				item({
					quantity: 100,
					billing_method: 'Vencido',
					start_date: '2026-10-15',
					term_months: 1,
					price: { model: 'standard', quantity_type: 'metered', unit_amount: 1, billable_metric_id: 'm' },
				}),
			],
		});
		const [first] = result.invoices.flatMap((invoice) => invoice.lines);

		expect(first).toMatchObject({ billing_period_start: '2026-10-15', subtotal: 100 });
		expect(first.prorated).toBeUndefined();
		expect(result.warnings.some((warning) => warning.includes('el consumo se tarifa sin prorratear'))).toBe(true);
	});

	it('MRR del motor: un ítem por tramos con 2.000 unidades aporta el mismo mensual que su primera línea (y ÷ meses si es trimestral)', () => {
		const graduated = {
			model: 'graduated' as const,
			quantity_type: 'fixed' as const,
			tiers: [
				{ from: 1, to: 1000, per_unit_amount: 0.05, flat_amount: 20 },
				{ from: 1001, to: null, per_unit_amount: 0.03, flat_amount: 0 },
			],
		};
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 1 }),
			items: [
				item({ key: 'g', quantity: 2000, unit_price: 0, start_date: '2026-10-01', term_months: 12, discount_value: 10, price: graduated }),
				item({
					key: 'q',
					quantity: 2000,
					unit_price: 0,
					start_date: '2026-10-01',
					term_months: 12,
					billing_frequency: 'Trimestral',
					price: graduated,
				}),
				item({ key: 'std', quantity: 2, unit_price: 50, start_date: '2026-10-01', term_months: 12 }),
				item({ key: 'setup', quantity: 1, unit_price: 300, start_date: '2026-10-01', term_months: 1, is_recurring: false }),
			],
		});
		const firstLine = (key: string) => result.invoices.flatMap((invoice) => invoice.lines).find((line) => line.item_key === key)!;

		// 1.000 × 0,05 + 20 + 1.000 × 0,03 = 100 por período; con 10 % = 90.
		expect(firstLine('g').subtotal).toBe(90);
		expect(result.items).toEqual([
			{ item_key: 'g', product_name: 'Licencia', is_recurring: true, monthly_equivalent: 90, value: 1080 },
			{ item_key: 'q', product_name: 'Licencia', is_recurring: true, monthly_equivalent: round2(firstLine('q').subtotal / 3), value: 400 },
			{ item_key: 'std', product_name: 'Licencia', is_recurring: true, monthly_equivalent: 100, value: 1200 },
			{ item_key: 'setup', product_name: 'Licencia', is_recurring: false, monthly_equivalent: 0, value: 300 },
		]);
		expect(result.totals.mrr).toBe(round2(90 + 100 / 3 + 100));
		expect(result.totals.contract_value).toBe(1080 + 400 + 1200 + 300);
	});
});

describe('generateInvoices · prorrateo del primer y último período (día de ciclo ≠ inicio)', () => {
	const allLines = (result: ReturnType<typeof generateInvoices>) => result.invoices.flatMap((invoice) => invoice.lines);

	it('día de ciclo = día de inicio: sin prorrateo', () => {
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 15 }),
			items: [item({ start_date: '2026-01-15', unit_price: 31 })],
		});

		expect(allLines(result)).toHaveLength(12);
		expect(allLines(result).every((line) => line.prorated === undefined && line.subtotal === 31)).toBe(true);
		expect(result.warning_codes).not.toContain(PRORATED_PERIOD_CODE);
		expect(result.warnings.some((warning) => warning.includes('prorrateado'))).toBe(false);
	});

	it('mensual, día de ciclo 1 e inicio 15: primer período 15 → 31 a 17/31 y último 01 → 14 a 14/31', () => {
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 1 }),
			items: [item({ start_date: '2026-01-15', unit_price: 31 })],
		});
		const lines = allLines(result);

		expect(lines[0]).toMatchObject({
			billing_period_start: '2026-01-15',
			billing_period_end: '2026-01-31',
			subtotal: 17,
			prorated: true,
			prorated_days: 17,
		});
		// El tramo va en la factura del primer ciclo, junto al período de febrero.
		expect(result.invoices[0]).toMatchObject({ issue_date: '2026-02-01' });
		expect(result.invoices[0].lines.map((line) => line.billing_period_start)).toEqual(['2026-01-15', '2026-02-01']);
		expect(lines.slice(1, -1).every((line) => line.subtotal === 31 && !line.prorated)).toBe(true);
		expect(lines.at(-1)).toMatchObject({
			billing_period_start: '2027-01-01',
			billing_period_end: '2027-01-14',
			subtotal: 14,
			prorated: true,
			prorated_days: 14,
		});
		expect(result.totals).toMatchObject({ contract_value: 372, invoiced_total: 372, difference: 0, mrr: 31 });
		expect(result.warning_codes).toContain(PRORATED_PERIOD_CODE);
		expect(result.warnings).toContain('Primer período prorrateado: 17 días ("Licencia", 15/01/2026 a 31/01/2026)');
		expect(result.warnings).toContain('Último período prorrateado: 14 días ("Licencia", 01/01/2027 a 14/01/2027)');
	});

	it('anual, día de ciclo 1 e inicio 15: tramo de 17 días a 17/31 de un mes y último período de 11 meses + 14/31', () => {
		const result = generateInvoices({
			contract: contract({ billing_anchor_day: 1 }),
			items: [item({ start_date: '2026-01-15', unit_price: 100, billing_frequency: 'Anual', term_months: 24 })],
		});
		const lines = allLines(result);

		expect(lines.map((line) => [line.billing_period_start, line.billing_period_end, line.subtotal, line.prorated ?? false])).toEqual([
			['2026-01-15', '2026-01-31', 54.84, true],
			['2026-02-01', '2027-01-31', 1200, false],
			['2027-02-01', '2028-01-14', 1145.16, true],
		]);
		expect(lines[2].prorated_days).toBe(348);
		expect(result.totals).toMatchObject({ contract_value: 2400, invoiced_total: 2400, mrr: 100 });
	});
});
