import { generateInvoices, lineDescription } from './billing-engine';
import {
	cutAtWord,
	DEFAULT_TEMPLATE,
	type DescriptionContext,
	type DescriptionLineInput,
	type DescriptionTemplate,
	fitDescription,
	formatPeriod,
	isPerTierBreakdown,
	maxCharsFor,
	parseStoredTemplate,
	planDescriptions,
	referenceKind,
	renderDescription,
	TEMPLATE_MAX_BLOCKS,
	tierLabelFromBreakdown,
	validateTemplate,
} from './invoice-description';
import { asciiGlosa, describeSingleLine, priceLine, type PriceSpec, splitInvoiceLines } from './pricing-engine';

const TIERED: PriceSpec = {
	model: 'graduated',
	quantity_type: 'metered',
	free_units: 100,
	tiers: [
		{ from: 0, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
		{ from: 500, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
	],
};

const base = (overrides: Partial<DescriptionContext> = {}): DescriptionContext => ({
	line_kind: 'standard',
	product_name: 'Licencia Sapira',
	account: 'Casa Matriz',
	period_start: '2026-09-01',
	period_end: '2026-09-30',
	...overrides,
});

describe('invoice-description (constructor de descripción, spec facturas §3.6)', () => {
	describe('DEFAULT_TEMPLATE = la glosa de hoy (paridad exacta)', () => {
		const cases: Array<[string, string | null, string, string]> = [
			['Licencia Sapira', 'Casa Matriz', '2026-09-01', '2026-09-30'],
			['Licencia Sapira', null, '2026-09-01', '2026-09-30'],
			['Licencia Sapira', '   ', '2026-12-15', '2027-01-14'],
			['  Soporte  —  Premium ', ' Filial   Norte ', '2026-01-01', '2026-12-31'],
			['Servicio – Anual', 'Cta. 12−A', '2026-02-01', '2026-02-28'],
		];

		it.each(cases)('estándar: "%s" / cuenta %p', (product, account, start, end) => {
			expect(renderDescription(null, base({ product_name: product, account, period_start: start, period_end: end })).text).toBe(
				lineDescription(product, account, start, end)
			);
			expect(renderDescription(DEFAULT_TEMPLATE, base({ product_name: product, account, period_start: start, period_end: end })).text).toBe(
				lineDescription(product, account, start, end)
			);
		});

		it.each(cases)('línea única con modelo de precio: "%s" / cuenta %p (base + detalle "Tramos: …")', (product, account, start, end) => {
			const priced = priceLine(TIERED, 1250, 10);
			const context = base({
				line_kind: 'single',
				product_name: product,
				account,
				period_start: start,
				period_end: end,
				breakdown: priced.breakdown,
			});

			expect(renderDescription(null, context).text).toBe(describeSingleLine(lineDescription(product, account, start, end), priced));
		});

		it('línea única sin desglose (o vacío): solo la base, como describeSingleLine', () => {
			expect(renderDescription(null, base({ line_kind: 'single', breakdown: [] })).text).toBe(
				describeSingleLine(lineDescription('Licencia Sapira', 'Casa Matriz', '2026-09-01', '2026-09-30'), { breakdown: [] })
			);
		});

		it.each(cases)('fila por tramo: "%s" / cuenta %p → asciiGlosa(base - etiqueta)', (product, account, start, end) => {
			for (const part of splitInvoiceLines(priceLine(TIERED, 1250, 10))) {
				const context = base({
					line_kind: 'per_tier',
					product_name: product,
					account,
					period_start: start,
					period_end: end,
					tier_label: part.label,
				});

				expect(renderDescription(null, context).text).toBe(asciiGlosa(`${lineDescription(product, account, start, end)} - ${part.label}`));
			}
		});

		it('el generador con plantilla null produce las mismas glosas que antes (estándar, única y por tramo)', () => {
			const contract = {
				contract_currency: 'CLP',
				payment_terms: { kind: 'net' as const, days: 30 },
				company: { country: 'Chile', tax_rate: 19 },
			};
			const items = [
				{
					key: 'a',
					product_name: 'Licencia',
					account: 'Norte',
					quantity: 1,
					unit_price: 100,
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					start_date: '2026-10-01',
					term_months: 1,
					is_recurring: true,
				},
				{
					key: 'b',
					product_name: 'Rutas',
					quantity: 1000,
					unit_price: 0,
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					start_date: '2026-10-01',
					term_months: 1,
					is_recurring: true,
					price: TIERED,
				},
				{
					key: 'c',
					product_name: 'Rutas por tramo',
					quantity: 1000,
					unit_price: 0,
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					start_date: '2026-10-01',
					term_months: 1,
					is_recurring: true,
					price: { ...TIERED, invoice_line_mode: 'per_tier' as const },
				},
			];
			const lines = generateInvoices({ contract, items }).invoices.flatMap((invoice) => invoice.lines);
			const expected = [
				lineDescription('Licencia', 'Norte', '2026-10-01', '2026-10-31'),
				describeSingleLine(lineDescription('Rutas', null, '2026-10-01', '2026-10-31'), priceLine(TIERED, 1000, 0)),
				...splitInvoiceLines(priceLine(TIERED, 1000, 0)).map((part) =>
					asciiGlosa(`${lineDescription('Rutas por tramo', null, '2026-10-01', '2026-10-31')} - ${part.label}`)
				),
			];

			expect(lines.map((line) => line.description)).toEqual(expected);
		});
	});

	describe('bloques y formatos', () => {
		const context = base({
			line_kind: 'standard',
			quantity: 1250,
			unit: 'rutas',
			unit_price: 0.08,
			amount: 100,
			contract_currency: 'usd',
			invoice_currency: 'CLP',
			fx_rate: 950.5,
			contract_number: 'CTR-2026-184',
			references: [
				{ kind: 'OC', code: '4500123' },
				{ kind: 'HES', code: '998' },
			],
			client_name: 'Acme SpA',
		});
		const one = (block: DescriptionTemplate['blocks'][number], ctx = context) => renderDescription({ blocks: [block] }, ctx).text;

		it('período en los cuatro formatos (un mes y varios meses)', () => {
			expect(formatPeriod('2026-09-01', '2026-09-30', 'range_slash')).toBe('01/09/2026 a 30/09/2026');
			expect(formatPeriod('2026-09-01', '2026-09-30', 'month_year')).toBe('septiembre 2026');
			expect(formatPeriod('2026-09-01', '2026-11-30', 'month_year')).toBe('septiembre a noviembre 2026');
			expect(formatPeriod('2026-12-01', '2027-02-28', 'month_year')).toBe('diciembre 2026 a febrero 2027');
			expect(formatPeriod('2026-09-01', '2026-09-30', 'mmm_yy')).toBe('sep-26');
			expect(formatPeriod('2026-09-01', '2026-11-30', 'mmm_yy')).toBe('sep-26 a nov-26');
			expect(formatPeriod('2026-09-01', '2026-09-30', 'range_dash')).toBe('01-09-26 al 30-09-26');
			expect(formatPeriod(null, null, 'range_slash')).toBe('');
		});

		it('cada bloque de datos con su etiqueta opcional', () => {
			expect(one({ type: 'product' })).toBe('Licencia Sapira');
			expect(one({ type: 'account' })).toBe('Casa Matriz');
			expect(one({ type: 'account', text: 'Cuenta' })).toBe('Cuenta Casa Matriz');
			expect(one({ type: 'period', format: 'month_year', text: 'Periodo' })).toBe('Periodo septiembre 2026');
			expect(one({ type: 'quantity' })).toBe('1.250 rutas');
			expect(one({ type: 'unit_price' })).toBe('0,08 USD');
			expect(one({ type: 'amount' })).toBe('100,00 USD');
			expect(one({ type: 'fx_rate', text: 'TC' })).toBe('TC 950,5');
			expect(one({ type: 'invoice_currency' })).toBe('CLP');
			expect(one({ type: 'contract_number' })).toBe('CTR-2026-184');
			expect(one({ type: 'references' })).toBe('OC 4500123, HES 998');
			expect(one({ type: 'client' })).toBe('Acme SpA');
			expect(one({ type: 'text', text: 'Servicio —  mensual' })).toBe('Servicio - mensual');
		});

		it('tier: etiqueta de la fila por tramo; vacío en línea estándar; `detail` agrega el detalle de precio a la línea única', () => {
			expect(one({ type: 'tier' }, base({ line_kind: 'per_tier', tier_label: 'Tramo 1 (1-500)' }))).toBe('Tramo 1 (1-500)');
			expect(one({ type: 'tier' }, base())).toBe('');
			const single = base({ line_kind: 'single', breakdown: priceLine(TIERED, 1250, 0).breakdown });

			expect(one({ type: 'tier', format: 'label' }, single)).toBe('');
			expect(one({ type: 'tier', format: 'detail' }, single)).toMatch(/^Tramos: gratis 100; /);
		});

		it('omite bloques vacíos sin separadores colgando; account inline se pega al anterior o queda solo', () => {
			const template: DescriptionTemplate = {
				separator: ' | ',
				blocks: [
					{ type: 'references' },
					{ type: 'product' },
					{ type: 'account', format: 'inline', text: 'Cta' },
					{ type: 'fx_rate' },
					{ type: 'text', text: 'fin' },
				],
			};

			expect(renderDescription(template, base({ references: [], account: null })).text).toBe('Licencia Sapira | fin');
			expect(renderDescription(template, base({ references: [] })).text).toBe('Licencia Sapira Cta Casa Matriz | fin');
			expect(renderDescription({ blocks: [{ type: 'account', format: 'inline' }] }, base()).text).toBe('Casa Matriz');
		});

		it('misma moneda: fx_rate e invoice_currency no dependen de una tasa (fx vacío, moneda del contrato)', () => {
			const same = base({ contract_currency: 'CLP', invoice_currency: 'CLP', fx_rate: null });

			expect(renderDescription({ blocks: [{ type: 'product' }, { type: 'fx_rate' }] }, same)).toEqual({
				text: 'Licencia Sapira',
				length: 15,
				pending_fields: [],
			});
			expect(one({ type: 'invoice_currency' }, base({ contract_currency: 'uf', invoice_currency: null }))).toBe('UF');
		});
	});

	describe('pending_fields: datos que se completan al emitir', () => {
		it('cantidad medida sin consumo cerrado, TC spot sin tasa y referencias faltantes; el bloque va con el valor actual u omitido', () => {
			const rendered = renderDescription(
				{ blocks: [{ type: 'product' }, { type: 'quantity' }, { type: 'amount' }, { type: 'fx_rate' }, { type: 'references', text: 'OC' }] },
				base({
					quantity: 1000,
					quantity_final: false,
					amount: 64.8,
					contract_currency: 'USD',
					invoice_currency: 'CLP',
					fx_rate: null,
					references: [],
				})
			);

			expect(rendered.text).toBe('Licencia Sapira - 1.000 - 64,80 USD');
			expect(rendered.pending_fields).toEqual(['quantity', 'amount', 'fx_rate', 'references']);
			expect(rendered.length).toBe(rendered.text.length);
		});

		it('sin bloques dinámicos no hay pendientes', () => {
			expect(
				renderDescription(null, base({ quantity_final: false, fx_rate: null, contract_currency: 'USD', invoice_currency: 'CLP' }))
					.pending_fields
			).toEqual([]);
		});
	});

	describe('validateTemplate, parseStoredTemplate y maxCharsFor', () => {
		it('acepta la default y rechaza tipos/formatos desconocidos, sin bloques, más de 12, texto largo o texto libre vacío', () => {
			expect(validateTemplate(DEFAULT_TEMPLATE)).toEqual([]);
			expect(validateTemplate(null)).toEqual([{ field: 'template', message: 'La plantilla debe ser un objeto con bloques' }]);
			expect(validateTemplate({ blocks: [] })).toEqual([{ field: 'template.blocks', message: 'La plantilla necesita al menos un bloque' }]);
			expect(validateTemplate({ blocks: Array.from({ length: TEMPLATE_MAX_BLOCKS + 1 }, () => ({ type: 'product' })) })[0].field).toBe(
				'template.blocks'
			);
			expect(
				validateTemplate({
					separator: '-----------',
					blocks: [
						{ type: 'nope' },
						{ type: 'period', format: 'yyyy' },
						{ type: 'product', format: 'x' },
						{ type: 'text', text: '  ' },
						{ type: 'client', text: 'x'.repeat(121) },
					],
				}).map((error) => error.field)
			).toEqual([
				'template.separator',
				'template.blocks.0.type',
				'template.blocks.1.format',
				'template.blocks.2.format',
				'template.blocks.3.text',
				'template.blocks.4.text',
			]);
		});

		it('parseStoredTemplate: jsonb (objeto o texto) válido → normalizado; inválido o vacío → null', () => {
			expect(parseStoredTemplate(null)).toBeNull();
			expect(parseStoredTemplate('{mal')).toBeNull();
			expect(parseStoredTemplate({ blocks: [{ type: 'nope' }] })).toBeNull();
			expect(parseStoredTemplate(JSON.stringify({ blocks: [{ type: 'product', text: '  ', format: '' }] }))).toEqual({
				blocks: [{ type: 'product' }],
			});
		});

		it('maxCharsFor: el entero positivo del documento; null sin documento o sin límite', () => {
			expect(maxCharsFor({ description_max_chars: 80 })).toBe(80);
			expect(maxCharsFor({ description_max_chars: '80' })).toBe(80);
			expect(maxCharsFor({ description_max_chars: null })).toBeNull();
			expect(maxCharsFor(null)).toBeNull();
		});
	});

	describe('filas guardadas y referencias', () => {
		it('isPerTierBreakdown / tierLabelFromBreakdown reconstruyen la etiqueta de la fila como splitInvoiceLines', () => {
			const parts = splitInvoiceLines(priceLine({ ...TIERED, invoice_line_mode: 'per_tier' }, 1250, 10));

			for (const part of parts) {
				expect(isPerTierBreakdown(part.breakdown)).toBe(true);
				expect(tierLabelFromBreakdown(part.breakdown)).toBe(part.label);
			}
			const empty = splitInvoiceLines(priceLine({ ...TIERED, invoice_line_mode: 'per_tier' }, 50, 0));

			expect(tierLabelFromBreakdown(empty[0].breakdown)).toBe(empty[0].label);
			expect(isPerTierBreakdown(priceLine(TIERED, 1250, 0).breakdown)).toBe(false);
			expect(tierLabelFromBreakdown(null)).toBeNull();
		});

		it('referenceKind: 801 = OC, HES, si no el nombre o el código', () => {
			expect(referenceKind('801')).toBe('OC');
			expect(referenceKind('oc')).toBe('OC');
			expect(referenceKind('HES')).toBe('HES');
			expect(referenceKind('803', 'Contrato')).toBe('Contrato');
			expect(referenceKind('803')).toBe('803');
		});
	});

	describe('planDescriptions (PATCH …/invoices/descriptions)', () => {
		const line = (overrides: Partial<DescriptionLineInput> = {}): DescriptionLineInput => ({
			line_id: 'l-1',
			invoice_id: 'i-1',
			description: 'Texto viejo',
			locked: false,
			context: base(),
			...overrides,
		});
		const standard = lineDescription('Licencia Sapira', 'Casa Matriz', '2026-09-01', '2026-09-30');

		it('set: texto manual ASCII, protege la línea y marca exceeds contra el límite', () => {
			const [plan] = planDescriptions([line()], { mode: 'set', contract_template: null, text: 'Servicio — septiembre', max_chars: 10 });

			expect(plan).toMatchObject({ before: 'Texto viejo', after: 'Servicio - septiembre', locked: true, exceeds: true, length: 21 });
			expect(plan.skipped_reason).toBeUndefined();
		});

		it('apply_template salta protegidas salvo include_locked (y entonces las libera)', () => {
			const locked = line({ locked: true });

			expect(planDescriptions([locked], { mode: 'apply_template', contract_template: null, max_chars: null })[0].skipped_reason).toBe('locked');
			expect(
				planDescriptions([locked], { mode: 'apply_template', contract_template: null, include_locked: true, max_chars: null })[0]
			).toMatchObject({
				after: standard,
				locked: false,
			});
		});

		it('una línea editada a mano (quantity_source = manual, spec §3.4) no se regenera con plantilla salvo include_locked', () => {
			const manual = line({ manual: true });

			expect(planDescriptions([manual], { mode: 'apply_template', contract_template: null, max_chars: null })[0].skipped_reason).toBe(
				'manual_edit_kept'
			);
			expect(
				planDescriptions([manual], {
					mode: 'apply_blocks',
					template: { blocks: [{ type: 'product' }] },
					contract_template: null,
					max_chars: null,
				})[0].skipped_reason
			).toBe('manual_edit_kept');
			expect(
				planDescriptions([manual], { mode: 'apply_template', contract_template: null, include_locked: true, max_chars: null })[0].after
			).toBe(standard);
			expect(planDescriptions([manual], { mode: 'set', contract_template: null, text: 'A mano', max_chars: null })[0].after).toBe('A mano');
		});

		it('la etiqueta del tramo y el detalle de la glosa ignoran la sublínea del descuento puntual (one_off)', () => {
			const oneOff = { kind: 'discount' as const, one_off: true, quantity: 1, amount: -10, label: 'Descuento puntual: promo' };

			expect(tierLabelFromBreakdown([{ kind: 'tier', quantity: 5, amount: 50, label: 'Tramo 1 (1-5)', line_index: 0 }, oneOff])).toBe(
				'Tramo 1 (1-5)'
			);
		});

		it('apply_blocks usa la plantilla del cuerpo; unlock libera y regenera con la del contrato', () => {
			const adHoc: DescriptionTemplate = { blocks: [{ type: 'product' }, { type: 'period', format: 'mmm_yy' }] };

			expect(planDescriptions([line()], { mode: 'apply_blocks', template: adHoc, contract_template: null, max_chars: null })[0].after).toBe(
				'Licencia Sapira - sep-26'
			);
			expect(planDescriptions([line({ locked: true })], { mode: 'unlock', contract_template: adHoc, max_chars: 80 })[0]).toMatchObject({
				after: 'Licencia Sapira - sep-26',
				locked: false,
				exceeds: false,
			});
		});

		it('informa sin tocar: factura bloqueada (su código) y líneas sin cambios', () => {
			const plans = planDescriptions([line({ blocked_reason: 'sent_to_erp_draft' }), line({ line_id: 'l-2', description: standard })], {
				mode: 'apply_template',
				contract_template: null,
				max_chars: null,
			});

			expect(plans.map((plan) => [plan.line_id, plan.skipped_reason, plan.after])).toEqual([
				['l-1', 'sent_to_erp_draft', 'Texto viejo'],
				['l-2', 'unchanged', standard],
			]);
		});

		it('la visible de una factura por OC nunca se regenera, ni con include_locked ni con unlock (partial_billing); set sí la escribe', () => {
			const visible = line({ description: 'Servicios según OC 4500', locked: true, po_visible: true });
			const reasons = (['apply_template', 'unlock'] as const).map(
				(mode) => planDescriptions([visible], { mode, contract_template: null, include_locked: true, max_chars: null })[0]
			);

			expect(reasons.map((plan) => [plan.skipped_reason, plan.after])).toEqual([
				['partial_billing', 'Servicios según OC 4500'],
				['partial_billing', 'Servicios según OC 4500'],
			]);
			expect(planDescriptions([visible], { mode: 'apply_template', contract_template: null, max_chars: null })[0].skipped_reason).toBe(
				'locked'
			);
			expect(planDescriptions([visible], { mode: 'set', contract_template: null, text: 'OC 4500 corregida', max_chars: null })[0].after).toBe(
				'OC 4500 corregida'
			);
		});
	});

	describe('fitDescription: ajuste automático al límite del documento (decisión 30-09)', () => {
		const STANDARD = 'Licencia Cuenta Casa Matriz - Periodo 01/09/2026 a 30/09/2026';
		const ctx = (overrides: Partial<DescriptionContext> = {}) => base({ product_name: 'Licencia', ...overrides });

		it('sin límite o bajo el límite no cambia nada (fitted false, sin pasos)', () => {
			expect(renderDescription(null, ctx()).text).toBe(STANDARD);
			for (const max of [null, STANDARD.length, 200]) {
				expect(fitDescription(null, ctx(), max)).toEqual({
					text: STANDARD,
					length: STANDARD.length,
					pending_fields: [],
					fitted: false,
					steps: [],
					step_codes: [],
				});
			}
		});

		it.each<[number, string, string[]]>([
			[58, 'Licencia Cuenta Casa Matriz - Periodo 01-09-26 al 30-09-26', ['período corto']],
			[54, 'Licencia Cuenta Casa Matriz - Periodo septiembre 2026', ['período corto']],
			[50, 'Licencia Cuenta Casa Matriz - Periodo sep-26', ['período corto']],
			[40, 'Licencia Cuenta Casa Matriz - sep-26', ['período corto', 'sin etiquetas']],
			[30, 'Licencia Casa Matriz - sep-26', ['período corto', 'sin etiquetas']],
			[20, 'Licencia - sep-26', ['período corto', 'sin etiquetas', 'sin cuenta']],
		])('paso a paso con límite %i → "%s"', (max, text, steps) => {
			const fitted = fitDescription(null, ctx(), max);

			expect(fitted).toMatchObject({ text, length: text.length, fitted: true, steps });
			expect(fitted.length).toBeLessThanOrEqual(max);
		});

		it('un período que no son meses completos nunca pasa a "sep-26": se queda en range_dash', () => {
			const fitted = fitDescription(null, ctx({ period_start: '2026-09-15', period_end: '2026-10-14' }), 55);

			expect(fitted).toMatchObject({ text: 'Licencia Cuenta Casa Matriz - 15-09-26 al 14-10-26', step_codes: ['short_period', 'no_labels'] });
		});

		it('varios meses completos: "sep-26 a nov-26"', () => {
			const fitted = fitDescription(
				{ blocks: [{ type: 'product' }, { type: 'period' }] },
				ctx({ period_start: '2026-09-01', period_end: '2026-11-30' }),
				27
			);

			expect(fitted.text).toBe('Licencia - sep-26 a nov-26');
		});

		it('tramo resumido: una línea única deja el detalle "Tramos: …" antes de recortar texto', () => {
			const priced = priceLine(TIERED, 1250, 10);
			const context = base({ line_kind: 'single', account: null, breakdown: priced.breakdown });
			const template: DescriptionTemplate = { blocks: [{ type: 'product' }, { type: 'tier', format: 'detail' }] };

			expect(renderDescription(template, context).text).toMatch(/^Licencia Sapira - Tramos: /);
			expect(fitDescription(template, context, 20)).toMatchObject({ text: 'Licencia Sapira', fitted: true, steps: ['tramo resumido'] });
		});

		it('texto libre recortado sin partir palabras', () => {
			const template: DescriptionTemplate = {
				blocks: [{ type: 'product' }, { type: 'text', text: 'Servicio prestado segun contrato marco vigente' }],
			};
			const fitted = fitDescription(template, base({ product_name: 'Licencia' }), 30);

			expect(fitted).toMatchObject({ text: 'Licencia - Servicio prestado', fitted: true, steps: ['texto libre recortado'] });
		});

		it('último recurso: recorta el bloque de datos más largo y conserva el período y el tramo al final', () => {
			const context = base({
				line_kind: 'per_tier',
				product_name: 'Plataforma de optimizacion de rutas de ultima milla para flota refrigerada',
				account: 'Santiago Centro',
				tier_label: 'Tramo 2 (501-2.000)',
			});
			const fitted = fitDescription(null, context, 80);

			expect(renderDescription(null, context).length).toBeGreaterThan(80);
			expect(fitted.text).toBe('Plataforma de optimizacion de rutas de ultima - sep-26 - Tramo 2 (501-2.000)');
			expect(fitted.step_codes).toEqual(['short_period', 'no_labels', 'no_account', 'hard_cut']);
			expect(fitted.steps).toEqual(['período corto', 'sin etiquetas', 'sin cuenta', 'texto recortado']);
		});

		it('nunca supera el límite, aun con límites absurdos', () => {
			for (const max of [1, 5, 12, 25]) expect(fitDescription(null, ctx(), max).length).toBeLessThanOrEqual(max);
		});

		it('determinista e idempotente: mismo resultado, y ajustar lo ajustado no cambia nada', () => {
			const first = fitDescription(null, ctx(), 30);

			expect(fitDescription(null, ctx(), 30)).toEqual(first);
			expect(fitDescription({ blocks: [{ type: 'text', text: first.text }] }, ctx(), 30)).toMatchObject({ text: first.text, fitted: false });
		});

		it('cutAtWord: corta en un espacio de los últimos 8 caracteres; si no hay, corta la palabra', () => {
			expect(cutAtWord('abcdefghijkl mnopqrstuvwxyz', 20)).toBe('abcdefghijkl');
			expect(cutAtWord('abcdefghijklmnopqrstuvwxyz', 10)).toBe('abcdefghij');
			expect(cutAtWord('abc defghijklmnopqrstuvwxyz', 20)).toBe('abc defghijklmnopqrs');
			expect(cutAtWord('Licencia - Soporte', 11)).toBe('Licencia');
			expect(cutAtWord('corto', 10)).toBe('corto');
		});

		it('planDescriptions: las regeneradas se ajustan (fitted por línea); el texto manual (set) no se ajusta', () => {
			const line: DescriptionLineInput = { line_id: 'l-1', invoice_id: 'i-1', description: 'viejo', locked: false, context: ctx() };
			const [regenerated] = planDescriptions([line], { mode: 'apply_template', contract_template: null, max_chars: 40 });
			const [manual] = planDescriptions([line], { mode: 'set', contract_template: null, text: STANDARD, max_chars: 40 });

			expect(regenerated).toMatchObject({
				after: 'Licencia Cuenta Casa Matriz - sep-26',
				exceeds: false,
				fitted: true,
				fit_steps: ['período corto', 'sin etiquetas'],
			});
			expect(manual).toMatchObject({ after: STANDARD, exceeds: true, fitted: false, fit_steps: [] });
		});
	});

	describe('generador con plantilla del contrato', () => {
		it('usa la plantilla y los datos del contrato; el TC fijo de la factura entra al bloque fx_rate', () => {
			const result = generateInvoices({
				contract: {
					contract_currency: 'USD',
					invoice_currency: 'CLP',
					fx_invoice_policy: 'fixed',
					fixed_invoice_rates: [
						{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2026-12-31' },
					],
					payment_terms: { kind: 'net', days: 30 },
					company: { country: 'Chile', tax_rate: 19 },
					description_template: {
						blocks: [
							{ type: 'contract_number' },
							{ type: 'product' },
							{ type: 'period', format: 'month_year' },
							{ type: 'fx_rate', text: 'TC' },
							{ type: 'client' },
						],
					},
					description_context: { contract_number: 'CTR-2026-1', client_name: 'Acme SpA' },
				},
				items: [
					{
						key: 'a',
						product_name: 'Licencia',
						quantity: 1,
						unit_price: 100,
						billing_frequency: 'Mensual',
						billing_method: 'Anticipado',
						start_date: '2026-10-01',
						term_months: 1,
						is_recurring: true,
					},
				],
			});

			expect(result.invoices[0].lines[0].description).toBe('CTR-2026-1 - Licencia - octubre 2026 - TC 950 - Acme SpA');
		});
	});
});
