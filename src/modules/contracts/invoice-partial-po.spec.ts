import { partialBillingBlocker, planFx } from './contract-invoices';
import { type EditInvoiceRow, type EditLineRow, planInvoiceEdit } from './invoice-edit';
import { exactSubset, largestWithPartial, type PartialByPoContext, type PartialByPoInput, periodLabel, planPartialByPo } from './invoice-partial-po';
import { type NewInvoiceRules } from './invoice-reorganize';

import type { ContractInvoiceContext } from './contract-invoices';

const TODAY = '2026-09-30';

const invoice = (overrides: Partial<EditInvoiceRow> = {}): EditInvoiceRow => ({
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
	contract_currency: 'USD',
	invoice_currency: 'USD',
	amount_contract_currency: 1750,
	amount_invoice_currency: 1750,
	vat: 332.5,
	total_invoice_currency: 2082.5,
	fx_contract_to_invoice: 1,
	tax_rate: 19,
	fx_rate_source: null,
	fx_confirmed_at: null,
	issued_externally: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	sent_at: null,
	no_charge: false,
	auto_invoice: false,
	requires_references: true,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-09-01',
	period_end: '2026-09-30',
	lines_count: 3,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1750,
	client_tax_id: '76.000.000-1',
	export_type: 0,
	invoice_terms_and_conditions: null,
	notes: null,
	nc_revenue_treatment: null,
	...overrides,
});

const line = (id: string, item: string, quantity: number, unit: number, fx = 1, overrides: Partial<EditLineRow> = {}): EditLineRow => {
	const subtotal = Math.round(quantity * unit * 100) / 100;
	const tax = Math.round(subtotal * 19) / 100;

	return {
		id,
		contract_item_id: item,
		product_id: `prod-${item}`,
		product_name: `Producto ${item}`,
		account: null,
		description: `Producto ${item}`,
		description_locked: false,
		quantity,
		unit_of_measure: 'UND',
		discount_pct: 0,
		unit_price: unit,
		subtotal,
		tax_amount: tax,
		total: Math.round((subtotal + tax) * 100) / 100,
		unit_price_invoice: unit * fx,
		subtotal_invoice: Math.round(subtotal * fx * 100) / 100,
		tax_amount_invoice: Math.round(tax * fx * 100) / 100,
		total_invoice: Math.round((subtotal + tax) * fx * 100) / 100,
		billing_period_start: '2026-09-01',
		billing_period_end: '2026-09-30',
		quantity_source: 'fixed',
		pricing_breakdown: null,
		...overrides,
	};
};

const sameCurrencyLines = () => [line('l-1', 'i-1', 10, 100), line('l-2', 'i-2', 5, 100), line('l-3', 'i-3', 1, 250)];

const context = (overrides: Partial<ContractInvoiceContext> = {}): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: null,
	contract_requires_references: true,
	auto_send_to_erp: false,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: null,
	company_country: 'Chile',
	has_erp_integration: true,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: TODAY,
	...overrides,
});

const rules = (overrides: Partial<NewInvoiceRules> = {}): NewInvoiceRules => ({
	client_entity_id: 'entity-1',
	legal_name: 'Cliente SpA',
	document_type: 'FACTURA',
	export_type: 0,
	tax_rate: 19,
	contract_currency: 'USD',
	invoice_currency: 'USD',
	fx_invoice_policy: null,
	fixed_invoice_rates: [],
	...overrides,
});

const ctx = (overrides: Partial<PartialByPoContext> = {}): PartialByPoContext => ({
	invoice: invoice(),
	lines: sameCurrencyLines(),
	context: context(),
	rules: rules(),
	render: {
		template: null,
		contract_number: 'CTR-2026-001',
		client_name: 'Cliente SpA',
		references: [],
		contract_currency: 'USD',
		invoice_currency: 'USD',
		fx_rate: null,
		max_chars: 80,
	},
	max_chars: 80,
	references: [],
	...overrides,
});

const input = (amount: number, extra: Partial<PartialByPoInput> = {}): PartialByPoInput => ({
	reference: { type: 'OC', code: '4500123', date: '2026-09-20' },
	amount_invoice_currency: amount,
	visible_line_text: 'Servicios según OC 4500123',
	reason: 'OC del cliente por un monto cerrado',
	...extra,
});
const codes = (list: Array<{ code: string }>) => list.map((entry) => entry.code);

describe('invoice-partial-po (spec facturas §3.7b, lógica pura)', () => {
	describe('búsqueda de líneas', () => {
		it('subconjunto exacto al centavo; entre varios, el de líneas más tempranas; > 12 líneas no busca', () => {
			expect(exactSubset([1000, 500, 250], 750)).toEqual([1, 2]);
			expect(exactSubset([500, 250, 250, 750], 750)).toEqual([0, 1]);
			expect(exactSubset([0.1, 0.2], 0.3)).toEqual([0, 1]);
			expect(exactSubset([1000, 500, 250], 1200)).toBeNull();
			expect(
				exactSubset(
					Array.from({ length: 13 }, () => 1),
					2
				)
			).toBeNull();
		});

		it('sin exacta: las más grandes completas y la siguiente parcial por el resto; null si el monto supera la suma', () => {
			expect(largestWithPartial([1000, 500, 250], 1200)).toEqual([
				{ index: 0, amount: 1000, partial: false },
				{ index: 1, amount: 200, partial: true },
			]);
			expect(largestWithPartial([1000, 500, 250], 2000)).toBeNull();
		});

		it('etiqueta del período del saldo', () => {
			expect(periodLabel('2026-09-01', '2026-09-30')).toBe('09/2026');
			expect(periodLabel('2026-09-01', '2026-11-30')).toBe('01/09/2026 a 30/11/2026');
		});
	});

	describe('planPartialByPo', () => {
		it('exacta (misma moneda): una línea visible (cantidad 1, unitario = OC, montos 0) + internas; el saldo se va completo a una Por Emitir nueva del período', () => {
			const plan = planPartialByPo(ctx(), input(750));

			expect(plan.errors).toEqual([]);
			expect(plan.blockers).toEqual([]);
			expect(plan.can_apply).toBe(true);
			expect(plan.proposal).toEqual({
				mode: 'exact',
				allocation: [
					{ line_id: 'l-2', amount: 500, partial: false },
					{ line_id: 'l-3', amount: 250, partial: false },
				],
			});
			expect(plan.covered_lines.map((entry) => [entry.line_id, entry.subtotal_contract_currency, entry.partial])).toEqual([
				['l-2', 500, false],
				['l-3', 250, false],
			]);
			expect(plan.visible_line).toEqual({
				description: 'Servicios según OC 4500123',
				quantity: 1,
				unit_price_contract_currency: 750,
				unit_price_invoice_currency: 750,
				contract_item_id: 'i-2',
				billing_period_start: '2026-09-01',
				billing_period_end: '2026-09-30',
			});
			expect(plan.write.visible).toMatchObject({
				subtotal_contract_currency: 0,
				total_invoice_currency: 0,
				is_visible: true,
				description_locked: true,
			});
			expect(plan.write.covered.every((entry) => entry.state.is_visible === false)).toBe(true);
			expect(plan.covered_invoice.after).toEqual({
				amount_contract_currency: 750,
				vat: 142.5,
				amount_invoice_currency: 750,
				total_invoice_currency: 892.5,
			});
			expect(plan.balance_lines).toEqual([
				expect.objectContaining({
					line_id: 'l-1',
					from_line_id: 'l-1',
					action: 'moved',
					subtotal_contract_currency: 1000,
					billing_period_start: '2026-09-01',
				}),
			]);
			expect(plan.remainder_invoice).toMatchObject({
				issue_date: '2026-11-01',
				due_date: '2026-12-01',
				split_reason: 'partial_by_po',
				split_from_invoice_id: 'inv-1',
				notes: 'Saldo de OC 4500123 del período 09/2026',
				fx_contract_to_invoice: 1,
				totals: { amount_contract_currency: 1000, vat: 190, amount_invoice_currency: 1000, total_invoice_currency: 1190 },
			});
			expect(plan.fx).toMatchObject({ policy_before: 'same_currency', net_exact: false, fx_difference: 0, covered_invoice_total: 750 });
			expect(plan.reference).toEqual({ type: 'OC', code: '4500123', date: '2026-09-20', document_type_code: '801', already_present: false });
		});

		it('sin exacta: la más grande completa y una parcial a precio de lista (cantidad = resto ÷ unitario); el resto de la parcial va al saldo', () => {
			const plan = planPartialByPo(ctx(), input(1200));

			expect(plan.proposal.mode).toBe('partial');
			expect(plan.partial_line).toEqual({
				line_id: 'l-2',
				quantity_before: 5,
				quantity_covered: 2,
				quantity_remaining: 3,
				unit_price_invoice_currency: 100,
				amount_covered: 200,
				amount_remaining: 300,
			});
			expect(plan.write.covered.map((entry) => [entry.id, entry.state.quantity, entry.state.subtotal_contract_currency])).toEqual([
				['l-1', 10, 1000],
				['l-2', 2, 200],
			]);
			expect(plan.balance_lines.map((entry) => [entry.action, entry.from_line_id, entry.quantity, entry.subtotal_contract_currency])).toEqual([
				['moved', 'l-3', 1, 250],
				['split', 'l-2', 3, 300],
			]);
			expect(plan.remainder_invoice?.totals.amount_contract_currency).toBe(550);
			expect(plan.covered_invoice.after.amount_contract_currency).toBe(1200);
		});

		it('allocation manual reemplaza la propuesta y debe sumar la OC', () => {
			const plan = planPartialByPo(ctx(), input(600, { allocation: [{ line_id: 'l-1', amount: 600 }] }));

			expect(plan.proposal).toEqual({ mode: 'allocation', allocation: [{ line_id: 'l-1', amount: 600, partial: true }] });
			expect(plan.partial_line).toMatchObject({ quantity_covered: 6, quantity_remaining: 4 });
			const mismatch = planPartialByPo(
				ctx(),
				input(700, {
					allocation: [
						{ line_id: 'l-1', amount: 600 },
						{ line_id: 'x', amount: 1 },
					],
				})
			);

			expect(mismatch.errors.map((error) => error.field)).toEqual(['allocation.1.line_id']);
			expect(planPartialByPo(ctx(), input(700, { allocation: [{ line_id: 'l-1', amount: 600 }] })).errors).toEqual([
				{ field: 'allocation', message: 'La asignación suma 600 y la OC 700: deben coincidir' },
			]);
		});

		it('con conversión (tasa fija): neto exacto de la OC sobre las internas, tasa derivada y fx_difference; el saldo toma la política del contrato', () => {
			const fixed = invoice({
				invoice_currency: 'CLP',
				fx_contract_to_invoice: 950,
				amount_contract_currency: 333.33,
				amount_invoice_currency: 316663.5,
			});
			const plan = planPartialByPo(
				ctx({
					invoice: fixed,
					lines: [line('l-1', 'i-1', 1, 333.33, 950)],
					rules: rules({
						invoice_currency: 'CLP',
						fx_invoice_policy: 'fixed',
						fixed_invoice_rates: [
							{ from_currency: 'USD', to_currency: 'CLP', rate: 960, period_start: '2026-01-01', period_end: '2026-12-31' },
						],
					}),
				}),
				input(100000)
			);

			expect(plan.proposal.mode).toBe('partial');
			expect(plan.covered_lines[0]).toMatchObject({ subtotal_contract_currency: 105.26, subtotal_invoice_currency: 100000, partial: true });
			expect(plan.fx).toEqual({
				policy_before: 'fixed',
				fx_before: 950,
				fx_after: 950.028501,
				net_exact: true,
				covered_contract_total: 105.26,
				covered_invoice_total: 100000,
				fx_difference: 3,
				remainder_fx: 960,
			});
			expect(plan.covered_invoice.after).toEqual({
				amount_contract_currency: 105.26,
				vat: 19000,
				amount_invoice_currency: 100000,
				total_invoice_currency: 119000,
			});
			expect(plan.write.covered_fx_source).toBe('net_exact');
			expect(plan.visible_line.unit_price_invoice_currency).toBe(100000);
			expect(plan.balance_lines[0]).toMatchObject({ action: 'split', subtotal_contract_currency: 228.07, subtotal_invoice_currency: 218947.2 });
			expect(plan.remainder_invoice).toMatchObject({ invoice_currency: 'CLP', fx_contract_to_invoice: 960 });
		});

		it('bloqueos: spot sin tasa, monto mayor que la factura, ya facturada por OC, borrador en el ERP; avisos: consumo sin cerrar, sin saldo, referencia ya presente', () => {
			expect(
				codes(planPartialByPo(ctx({ invoice: invoice({ invoice_currency: 'CLP', fx_contract_to_invoice: null }) }), input(100)).blockers)
			).toContain('spot_without_rate');
			expect(codes(planPartialByPo(ctx(), input(5000)).blockers)).toEqual(['exceeds_invoice']);
			expect(codes(planPartialByPo(ctx({ invoice: invoice({ internal_lines: 2, odoo_invoice_id: 9 }) }), input(750)).blockers)).toEqual([
				'sent_to_erp_draft',
				'partial_billing_invoice',
			]);
			const full = planPartialByPo(
				ctx({
					lines: [line('l-1', 'i-1', 10, 100, 1, { quantity_source: 'pending' })],
					references: [{ document_type_code: '801', document_number: '4500123' }],
				}),
				input(1000)
			);

			expect(full.remainder_invoice).toBeNull();
			expect(codes(full.warnings)).toEqual(['no_balance', 'open_consumption', 'reference_exists']);
			expect(full.reference.already_present).toBe(true);
		});

		it('la línea visible respeta el límite de caracteres del documento', () => {
			expect(planPartialByPo(ctx({ max_chars: 10 }), input(750)).errors.map((error) => error.field)).toEqual(['visible_line_text']);
		});
	});

	describe('auditoría 01-10: el saldo y el descuento puntual', () => {
		it('una línea con puntual que pasa al saldo lleva su devengo; la cubierta lo pierde; encabezados = Σ líneas', () => {
			const breakdown = [
				{ kind: 'unit', quantity: 5, amount: 600, label: 'Producto i-2' },
				{
					kind: 'discount',
					one_off: true,
					quantity: 1,
					amount: -100,
					label: 'Descuento puntual: OC',
					one_off_type: 'amount',
					one_off_value: 100,
				},
			];
			const lines = [
				line('l-1', 'i-1', 10, 100),
				line('l-2', 'i-2', 5, 100, 1, { pricing_breakdown: breakdown as never }),
				line('l-3', 'i-3', 1, 250),
			];
			const plan = planPartialByPo(ctx({ invoice: invoice({ nc_revenue_treatment: 'impact_month' }), lines }), input(1250));

			expect(plan.can_apply).toBe(true);
			expect(plan.write.remainder?.nc_revenue_treatment).toBe('impact_month');
			expect(plan.write.covered_treatment_cleared).toBe(true);
			expect(plan.write.one_off_share).toBe(1);
			expect(plan.write.covered_header).toEqual({
				amount_contract_currency: 1250,
				vat: 237.5,
				amount_invoice_currency: 1250,
				total_invoice_currency: 1487.5,
			});
			expect(plan.write.remainder?.header).toEqual({
				amount_contract_currency: 500,
				vat: 95,
				amount_invoice_currency: 500,
				total_invoice_currency: 595,
			});
		});

		it('sin puntual en el saldo: el saldo no toma devengo y la cubierta lo conserva', () => {
			const plan = planPartialByPo(ctx(), input(1250));

			expect(plan.write.remainder?.nc_revenue_treatment).toBeNull();
			expect(plan.write.covered_treatment_cleared).toBe(false);
			expect(plan.write.one_off_share).toBe(0);
		});
	});

	describe('una factura por OC queda fija para editar líneas, reorganizar y cambiar FX', () => {
		it('partialBillingBlocker, planFx y el editor (solo si toca líneas)', () => {
			expect(partialBillingBlocker({ id: 'inv-1', invoice_number: null, internal_lines: 0 })).toBeNull();
			expect(partialBillingBlocker({ id: 'inv-1', invoice_number: null, internal_lines: 2 })?.code).toBe('partial_billing_invoice');
			const withInternal = invoice({ internal_lines: 2, invoice_currency: 'CLP', fx_contract_to_invoice: 950 });

			expect(codes(planFx(withInternal, [], context(), { policy: 'fixed', rate: 900 }).blockers)).toContain('partial_billing_invoice');
			const editCtx = {
				invoice: invoice(),
				context: context(),
				company_tax_rate: 19,
				contract_number: 'CTR-2026-001',
				client_name: 'Cliente SpA',
				template: null,
				max_chars: 80,
				lines: [line('v', 'i-1', 1, 750), line('l-2', 'i-2', 5, 100, 1, { visible_line_id: 'v' })],
				items: new Map(),
				issued_periods: [],
				receiver: null,
				references: [],
				plan: { expected: new Map(), known_items: new Set<string>(), others: new Map(), product_names: new Map() },
			};

			expect(codes(planInvoiceEdit(editCtx, { notes: 'Solo notas' }).blockers)).toEqual([]);
			expect(
				codes(
					planInvoiceEdit(editCtx, {
						lines: [
							{
								id: 'l-2',
								contract_item_id: 'i-2',
								quantity: 4,
								unit_price: 100,
								billing_period_start: '2026-09-01',
								billing_period_end: '2026-09-30',
							},
						],
					}).blockers
				)
			).toContain('partial_billing_invoice');
		});
	});
});
