import {
	type EditContext,
	type EditInvoiceRow,
	type EditItem,
	type EditLineRow,
	planBulkHeader,
	planInvoiceEdit,
	renderLine,
	stateOf,
} from './invoice-edit';
import { planReorganize, type ReorganizeContext } from './invoice-reorganize';
import { type PairRateContext, revalueByPair, type RevalueLine } from './multicurrency';
import { priceLine, type PriceSpec, splitInvoiceLines } from './pricing-engine';

import type { FxPeriodRate } from './billing-engine';
import type { ContractInvoiceContext, ContractInvoiceRow } from './contract-invoices';

/**
 * Multimoneda (spec-multimoneda §4): las operaciones sobre Por Emitir fuera del motor (editor, masivo, descuento puntual, reorganizar)
 * valorizan cada línea con SU par (moneda del ítem → moneda de factura) y dejan el encabezado = Σ líneas. Documento de dos pares: contrato
 * CLP, factura CLP, ítem USD (fija 950 en octubre, 1.000 en noviembre) e ítem UF (fija 38.000); tasas pactadas ítem → contrato USD 900 y UF
 * 37.000.
 */

const USD_ITEM = 'item-usd';
const UF_ITEM = 'item-uf';

const rate = (from: string, to: string, value: number, start = '2026-01-01', end = '2027-12-31'): FxPeriodRate => ({
	from_currency: from,
	to_currency: to,
	rate: value,
	period_start: start,
	period_end: end,
	created_at: '2026-09-01',
});

const pairs = (overrides: Partial<PairRateContext> = {}): PairRateContext => ({
	contract_currency: 'CLP',
	fx_invoice_policy: 'fixed',
	invoice_rates: [
		rate('USD', 'CLP', 950, '2026-10-01', '2026-10-31'),
		rate('USD', 'CLP', 1000, '2026-11-01', '2026-11-30'),
		rate('UF', 'CLP', 38000),
	],
	item_rates: [rate('USD', 'CLP', 900), rate('UF', 'CLP', 37000)],
	item_currencies: { [USD_ITEM]: 'USD', [UF_ITEM]: 'UF' },
	...overrides,
});

const stored = (overrides: Partial<RevalueLine> = {}): RevalueLine => ({
	id: 'l-usd',
	contract_item_id: USD_ITEM,
	currency: 'USD',
	fx: 950,
	fx_rate_source: 'contract',
	unit_price: 100,
	subtotal: 1000,
	tax_amount: 190,
	period_start: '2026-10-01',
	...overrides,
});
const ufStored = (overrides: Partial<RevalueLine> = {}) =>
	stored({ id: 'l-uf', contract_item_id: UF_ITEM, currency: 'UF', fx: 38000, unit_price: 10, subtotal: 10, tax_amount: 1.9, ...overrides });

describe('revalueByPair (spec-multimoneda §4)', () => {
	it('dos pares: cada línea con su tasa, IVA en moneda de factura, encabezado = Σ líneas y FX del encabezado NULL', () => {
		const result = revalueByPair([stored(), ufStored()], pairs(), { invoice_currency: 'CLP', tax_rate: 19, fallback_date: '2026-10-01' });

		expect(result.lines).toEqual([
			{ id: 'l-usd', currency: 'USD', fx: 950, unit_price: 95000, subtotal: 950000, tax: 180500, total: 1130500, fx_rate_source: 'contract' },
			{ id: 'l-uf', currency: 'UF', fx: 38000, unit_price: 380000, subtotal: 380000, tax: 72200, total: 452200, fx_rate_source: 'contract' },
		]);
		expect(result.pairs).toEqual(['USD>CLP', 'UF>CLP']);
		expect(result.header).toEqual({
			amount_contract_currency: 1270000,
			vat: 252700,
			amount_invoice_currency: 1330000,
			total_invoice_currency: 1582700,
			fx: null,
		});
	});

	it('línea nueva sin tasa: la fijada por factura del par manda sobre la pactada; si no hay, la fija del período', () => {
		const manual = revalueByPair(
			[stored({ fx: 970, fx_rate_source: 'manual' }), stored({ id: 'l-new', currency: null, fx: null, fx_rate_source: null }), ufStored()],
			pairs(),
			{ invoice_currency: 'CLP', tax_rate: 19, fallback_date: '2026-10-01' }
		);

		expect(manual.lines.map((line) => [line.id, line.fx, line.fx_rate_source])).toEqual([
			['l-usd', 970, 'manual'],
			['l-new', 970, 'manual'],
			['l-uf', 38000, 'contract'],
		]);
		const fixed = revalueByPair([stored({ id: 'l-new', currency: null, fx: null, period_start: '2026-11-01' })], pairs(), {
			invoice_currency: 'CLP',
			tax_rate: 19,
			fallback_date: '2026-11-01',
		});

		expect(fixed.lines[0]).toMatchObject({ currency: 'USD', fx: 1000, subtotal: 1000000 });
		expect(fixed.header.fx).toBe(1000);
	});

	it('spot: las líneas que convierten quedan NULL y el encabezado en moneda de factura NULL (nunca medio valorizado)', () => {
		const result = revalueByPair(
			[
				stored({ fx: null }),
				ufStored({ fx: null }),
				stored({ id: 'l-clp', contract_item_id: null, currency: 'CLP', fx: 1, subtotal: 5000, tax_amount: 950 }),
			],
			pairs({ fx_invoice_policy: 'spot' }),
			{ invoice_currency: 'CLP', tax_rate: 19, fallback_date: '2026-10-01' }
		);

		expect(result.lines.map((line) => [line.id, line.fx, line.subtotal])).toEqual([
			['l-usd', null, null],
			['l-uf', null, null],
			['l-clp', 1, 5000],
		]);
		expect(result.header).toMatchObject({ amount_invoice_currency: null, total_invoice_currency: null, fx: null });
	});

	it('la moneda de la línea sale del ítem (una línea guardada con la moneda del encabezado se corrige y no conserva esa tasa)', () => {
		const result = revalueByPair([ufStored({ currency: 'CLP', fx: 950 })], pairs(), {
			invoice_currency: 'CLP',
			tax_rate: 19,
			fallback_date: '2026-10-01',
		});

		expect(result.lines[0]).toMatchObject({ currency: 'UF', fx: 38000, subtotal: 380000 });
	});
});

// ------------------------------------------------------------------ editor

const editInvoice = (overrides: Partial<EditInvoiceRow> = {}): EditInvoiceRow => ({
	id: 'inv-1',
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-10-01',
	original_issue_date: '2026-10-01',
	scheduled_at: '2026-10-01',
	due_date: '2026-10-31',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	amount_contract_currency: 1270000,
	amount_invoice_currency: 1330000,
	vat: 252700,
	total_invoice_currency: 1582700,
	fx_contract_to_invoice: null,
	tax_rate: 19,
	fx_rate_source: null,
	fx_confirmed_at: null,
	issued_externally: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	sent_at: null,
	no_charge: false,
	auto_invoice: false,
	requires_references: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-10-01',
	period_end: '2026-10-31',
	lines_count: 2,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1010,
	client_tax_id: '76.000.000-1',
	export_type: 0,
	invoice_terms_and_conditions: null,
	notes: null,
	nc_revenue_treatment: null,
	...overrides,
});

const usdRow = (overrides: Partial<EditLineRow> = {}): EditLineRow => ({
	id: 'l-usd',
	contract_item_id: USD_ITEM,
	product_id: 'prod-usd',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma - TC 950',
	description_locked: false,
	quantity: 10,
	unit_of_measure: 'UND',
	discount_pct: 0,
	unit_price: 100,
	subtotal: 1000,
	tax_amount: 190,
	total: 1190,
	unit_price_invoice: 95000,
	subtotal_invoice: 950000,
	tax_amount_invoice: 180500,
	total_invoice: 1130500,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	quantity_source: 'fixed',
	pricing_breakdown: null,
	currency: 'USD',
	fx: 950,
	fx_rate_source: 'contract',
	...overrides,
});
const ufRow = (overrides: Partial<EditLineRow> = {}) =>
	usdRow({
		id: 'l-uf',
		contract_item_id: UF_ITEM,
		product_id: 'prod-uf',
		product_name: 'Soporte',
		description: 'Soporte - TC 38000',
		quantity: 1,
		unit_price: 10,
		subtotal: 10,
		tax_amount: 1.9,
		total: 11.9,
		unit_price_invoice: 380000,
		subtotal_invoice: 380000,
		tax_amount_invoice: 72200,
		total_invoice: 452200,
		currency: 'UF',
		fx: 38000,
		...overrides,
	});

const editItem = (id: string, name: string): EditItem => ({
	id,
	product_id: `prod-${id}`,
	product_name: name,
	account: null,
	unit_of_measure: 'UND',
	price: null,
	price_id: null,
	price_owner: null,
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	churn_date: null,
	term_months: 12,
});

const invoiceContext = (): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: 'fixed',
	contract_requires_references: false,
	auto_send_to_erp: false,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: null,
	company_country: 'Chile',
	has_erp_integration: false,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: '2026-09-30',
});

const editCtx = (overrides: Partial<EditContext> = {}): EditContext => ({
	invoice: editInvoice(),
	context: invoiceContext(),
	company_tax_rate: 19,
	contract_number: 'CTR-2026-001',
	client_name: 'Cliente SpA',
	template: { blocks: [{ type: 'product' }, { type: 'fx_rate', text: 'TC' }] },
	max_chars: null,
	lines: [usdRow(), ufRow()],
	items: new Map([
		[USD_ITEM, editItem(USD_ITEM, 'Plataforma')],
		[UF_ITEM, editItem(UF_ITEM, 'Soporte')],
	]),
	issued_periods: [],
	receiver: null,
	references: [],
	plan: {
		expected: new Map([
			[`${USD_ITEM}|2026-10-01`, 1000],
			[`${UF_ITEM}|2026-10-01`, 10],
		]),
		known_items: new Set([USD_ITEM, UF_ITEM]),
		others: new Map(),
		product_names: new Map([
			[USD_ITEM, 'Plataforma'],
			[UF_ITEM, 'Soporte'],
		]),
	},
	multicurrency: pairs(),
	...overrides,
});
const usdEdit = (overrides: Record<string, unknown> = {}) => ({
	id: 'l-usd',
	contract_item_id: USD_ITEM,
	quantity: 10,
	unit_price: 100,
	discount_pct: 0,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	...overrides,
});

describe('editor de una Por Emitir multimoneda (spec-multimoneda §4)', () => {
	it('editar la línea USD la valoriza con USD → CLP; la UF queda igual; encabezado = Σ líneas y FX NULL (dos pares)', () => {
		const result = planInvoiceEdit(editCtx(), { lines: [usdEdit({ quantity: 12 })], deviation: { type: 'upsell', reason: 'Más usuarios' } });

		expect(result.errors).toEqual([]);
		expect(result.lines.find((line) => line.id === 'l-usd')!.after).toMatchObject({
			currency: 'USD',
			fx: 950,
			subtotal_contract_currency: 1200,
			subtotal_invoice_currency: 1140000,
			tax_invoice_currency: 216600,
			total_invoice_currency: 1356600,
		});
		expect(result.lines.find((line) => line.id === 'l-uf')!.action).toBe('unchanged');
		expect(result.header.after).toMatchObject({
			fx_contract_to_invoice: null,
			amount_contract_currency: 1450000,
			amount_invoice_currency: 1520000,
			vat: 288800,
			total_invoice_currency: 1808800,
		});
	});

	it('línea nueva del ítem UF: nace en UF con la tasa fija de su par y la glosa con la tasa de la línea', () => {
		const result = planInvoiceEdit(editCtx(), {
			lines: [
				{
					contract_item_id: UF_ITEM,
					quantity: 2,
					unit_price: 10,
					discount_pct: 0,
					billing_period_start: '2026-10-01',
					billing_period_end: '2026-10-31',
				},
			],
			deviation: { type: 'upsell', reason: 'Horas extra' },
		});
		const created = result.write.creates[0];

		expect(created).toMatchObject({ currency: 'UF', fx: 38000, fx_rate_source: 'contract', subtotal_invoice_currency: 760000 });
		expect(created.description).toBe('Soporte - TC 38.000');
		expect(result.header.after.amount_invoice_currency).toBe(2090000);
	});

	it('descuento puntual en la línea UF: el subtotal con descuento se valoriza con UF → CLP', () => {
		const result = planInvoiceEdit(editCtx(), {
			lines: [
				{
					id: 'l-uf',
					contract_item_id: UF_ITEM,
					quantity: 1,
					unit_price: 10,
					discount_pct: 0,
					billing_period_start: '2026-10-01',
					billing_period_end: '2026-10-31',
					one_off_discount: { type: 'amount', value: 2 },
				},
			],
			deviation: { type: 'discount', reason: 'Promo', revenue_treatment: 'service_period' },
		});

		expect(result.errors).toEqual([]);
		expect(result.lines.find((line) => line.id === 'l-uf')!.after).toMatchObject({
			subtotal_contract_currency: 8,
			fx: 38000,
			subtotal_invoice_currency: 304000,
		});
		expect(result.header.after.amount_invoice_currency).toBe(1254000);
	});

	it('presentación por tramo → una fila en el ítem UF: la fila recompuesta se valoriza con UF → CLP (mismo total en UF)', () => {
		const tiers: PriceSpec = {
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [
				{ from: 1, to: 5, per_unit_amount: 13, flat_amount: 0 },
				{ from: 6, to: null, per_unit_amount: 7, flat_amount: 0 },
			],
			invoice_line_mode: 'per_tier',
		};
		const rows = splitInvoiceLines(priceLine(tiers, 10, 0)).map((part, index) =>
			ufRow({
				id: `uf-tier-${index}`,
				quantity: part.quantity,
				unit_price: part.unit_price,
				subtotal: part.subtotal,
				tax_amount: Math.round(part.subtotal * 19) / 100,
				total: part.subtotal + Math.round(part.subtotal * 19) / 100,
				unit_price_invoice: part.unit_price * 38000,
				subtotal_invoice: part.subtotal * 38000,
				tax_amount_invoice: Math.round(part.subtotal * 38000 * 19) / 100,
				total_invoice: part.subtotal * 38000 * 1.19,
				pricing_breakdown: part.breakdown,
			})
		);
		const items = new Map([
			[USD_ITEM, editItem(USD_ITEM, 'Plataforma')],
			[UF_ITEM, { ...editItem(UF_ITEM, 'Soporte'), price: tiers, price_id: 'price-uf', price_owner: 'contract' }],
		]);
		const result = planInvoiceEdit(editCtx({ items, lines: [usdRow(), ...rows] }), {
			line_mode: [{ contract_item_id: UF_ITEM, mode: 'single' }],
		});
		const recomposed = result.lines.find((line) => line.id === 'uf-tier-0')!.after!;

		expect(recomposed).toMatchObject({ currency: 'UF', fx: 38000, subtotal_contract_currency: 100, subtotal_invoice_currency: 3800000 });
		expect(result.header.after).toMatchObject({ fx_contract_to_invoice: null, amount_invoice_currency: 4750000 });
	});

	it('sin contexto multimoneda la edición queda como siempre (una tasa por factura, sin moneda por línea)', () => {
		const plain = planInvoiceEdit(
			editCtx({
				multicurrency: null,
				lines: [usdRow({ currency: undefined, fx: undefined, fx_rate_source: undefined })],
			}),
			{ lines: [usdEdit({ quantity: 12 })], deviation: { type: 'upsell', reason: 'x' } }
		);

		expect(plain.lines[0].after).not.toHaveProperty('currency');
		expect(plain.lines[0].after!.subtotal_invoice_currency).toBe(1200);
	});

	it('masivo con IVA re-normalizado (0,19 → 19): cada línea se revaloriza con su par y el encabezado = Σ líneas, FX NULL', () => {
		const result = planBulkHeader(editCtx({ invoice: editInvoice({ tax_rate: 0.19 }) }), { auto_invoice: true });

		expect(result.blockers).toEqual([]);
		expect(result.lines.map((line) => [line.id, line.after.fx, line.after.subtotal_invoice_currency, line.after.tax_invoice_currency])).toEqual([
			['l-usd', 950, 950000, 180500],
			['l-uf', 38000, 380000, 72200],
		]);
		expect(result.after).toMatchObject({
			fx_contract_to_invoice: null,
			amount_contract_currency: 1270000,
			amount_invoice_currency: 1330000,
			vat: 252700,
			total_invoice_currency: 1582700,
		});
	});

	it('la glosa toma la moneda y la tasa de la línea (bloque de tipo de cambio de la plantilla)', () => {
		const render = {
			template: { blocks: [{ type: 'product' as const }, { type: 'fx_rate' as const, text: 'TC' }] },
			contract_number: null,
			client_name: null,
			references: [],
			contract_currency: 'CLP',
			invoice_currency: 'CLP',
			fx_rate: null,
			max_chars: null,
		};

		expect(renderLine(stateOf(usdRow()), render)).toBe('Plataforma - TC 950');
		expect(renderLine(stateOf(usdRow({ currency: undefined, fx: undefined })), render)).toBe('Plataforma');
	});
});

// ------------------------------------------------------------------ reorganizar

const reorgInvoice = (id: string, issueDate: string, overrides: Partial<ContractInvoiceRow> = {}): ContractInvoiceRow => ({
	...editInvoice({ id, issue_date: issueDate, original_issue_date: issueDate, scheduled_at: issueDate, due_date: null }),
	period_start: null,
	period_end: null,
	...overrides,
});

const reorgCtx = (): ReorganizeContext => ({
	context: invoiceContext(),
	invoices: [reorgInvoice('inv-oct', '2026-10-01'), reorgInvoice('inv-nov', '2026-11-01')],
	lines: new Map([
		['inv-oct', [usdRow({ id: 'oct-usd' }), ufRow({ id: 'oct-uf' })]],
		[
			'inv-nov',
			[
				usdRow({
					id: 'nov-usd',
					billing_period_start: '2026-11-01',
					billing_period_end: '2026-11-30',
					fx: 1000,
					unit_price_invoice: 100000,
					subtotal_invoice: 1000000,
					tax_amount_invoice: 190000,
					total_invoice: 1190000,
				}),
				ufRow({ id: 'nov-uf', billing_period_start: '2026-11-01', billing_period_end: '2026-11-30' }),
			],
		],
	]),
	foreign_invoices: new Map(),
	foreign_lines: new Map(),
	items: new Map([
		[USD_ITEM, editItem(USD_ITEM, 'Plataforma')],
		[UF_ITEM, editItem(UF_ITEM, 'Soporte')],
	]),
	issued_periods: [],
	other_lines: [],
	expected: new Map(),
	known_items: new Set(),
	product_names: new Map(),
	rules: {
		client_entity_id: 'entity-1',
		legal_name: 'Cliente SpA',
		document_type: 'FACTURA',
		export_type: 0,
		tax_rate: 19,
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_invoice_policy: 'fixed',
		fixed_invoice_rates: pairs().invoice_rates,
	},
	render: { template: null, contract_number: 'CTR-2026-001', client_name: 'Cliente SpA', max_chars: null },
	multicurrency: pairs(),
});

describe('reorganizar Por Emitir multimoneda (spec-multimoneda §4)', () => {
	it('merge: cada línea movida toma la tasa de SU par y período en el destino; encabezado = Σ líneas con FX NULL', () => {
		const result = planReorganize(reorgCtx(), { operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-nov'] }] });
		const oct = result.invoices.find((entry) => entry.key === 'inv-oct')!;

		expect(result.can_apply).toBe(true);
		expect(
			result.write.line_updates.map((update) => [update.id, update.state.currency, update.state.fx, update.state.subtotal_invoice_currency])
		).toEqual(
			expect.arrayContaining([
				['nov-usd', 'USD', 1000, 1000000],
				['nov-uf', 'UF', 38000, 380000],
			])
		);
		expect(oct.after).toMatchObject({
			fx_contract_to_invoice: null,
			amount_invoice_currency: 2710000,
			amount_contract_currency: 2540000,
			lines_count: 4,
		});
	});
});
