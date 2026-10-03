import {
	type DeviationPlan,
	type EditContext,
	type EditInvoiceRow,
	type EditItem,
	type EditLineRow,
	type InvoiceEditInput,
	manualLineAmounts,
	planBulkHeader,
	planFollowingLineMode,
	planInvoiceEdit,
	recomposeItemRows,
	reconcileDeviation,
	stateOf,
} from './invoice-edit';
import { priceLine, type PriceSpec, splitInvoiceLines } from './pricing-engine';

import type { ContractInvoiceContext } from './contract-invoices';

const ITEM = 'item-1';
const OTHER = 'item-2';
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
	amount_contract_currency: 1000,
	amount_invoice_currency: 1000,
	vat: 190,
	total_invoice_currency: 1190,
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
	requires_references: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-10-01',
	period_end: '2026-10-31',
	lines_count: 1,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1000,
	client_tax_id: '76.000.000-1',
	export_type: 0,
	invoice_terms_and_conditions: null,
	notes: null,
	nc_revenue_treatment: null,
	...overrides,
});

const line = (overrides: Partial<EditLineRow> = {}): EditLineRow => ({
	id: 'line-1',
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma - Periodo 01/10/2026 a 31/10/2026',
	description_locked: false,
	quantity: 10,
	unit_of_measure: 'UND',
	discount_pct: 0,
	unit_price: 100,
	subtotal: 1000,
	tax_amount: 190,
	total: 1190,
	unit_price_invoice: 100,
	subtotal_invoice: 1000,
	tax_amount_invoice: 190,
	total_invoice: 1190,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	quantity_source: 'fixed',
	pricing_breakdown: null,
	...overrides,
});

const item = (overrides: Partial<EditItem> = {}): EditItem => ({
	id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	unit_of_measure: 'UND',
	price: null,
	price_id: null,
	price_owner: null,
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	churn_date: null,
	term_months: 12,
	...overrides,
});

const context = (overrides: Partial<ContractInvoiceContext> = {}): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: null,
	contract_requires_references: false,
	auto_send_to_erp: false,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: null,
	company_country: 'Chile',
	has_erp_integration: false,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: TODAY,
	...overrides,
});

const plan = (expected: Record<string, number> = { [`${ITEM}|2026-10-01`]: 1000 }, others: Record<string, number> = {}): DeviationPlan => ({
	expected: new Map(Object.entries(expected)),
	known_items: new Set([ITEM, OTHER]),
	others: new Map(Object.entries(others)),
	product_names: new Map([
		[ITEM, 'Plataforma'],
		[OTHER, 'Soporte'],
	]),
});

const ctx = (overrides: Partial<EditContext> = {}): EditContext => ({
	invoice: invoice(),
	context: context(),
	company_tax_rate: 19,
	contract_number: 'CTR-2026-001',
	client_name: 'Cliente SpA',
	template: null,
	max_chars: 80,
	lines: [line()],
	items: new Map([
		[ITEM, item()],
		[OTHER, item({ id: OTHER, product_name: 'Soporte' })],
	]),
	issued_periods: [],
	receiver: null,
	references: [],
	plan: plan(),
	...overrides,
});

const body = (lines: InvoiceEditInput['lines'], extra: Partial<InvoiceEditInput> = {}): InvoiceEditInput => ({ lines, ...extra });
const edit = (overrides: Partial<NonNullable<InvoiceEditInput['lines']>[number]> = {}) => ({
	id: 'line-1',
	contract_item_id: ITEM,
	quantity: 10,
	unit_price: 100,
	discount_pct: 0,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	...overrides,
});
const codes = (list: Array<{ code: string }>) => list.map((entry) => entry.code);

describe('invoice-edit (spec facturas §3.4, lógica pura)', () => {
	describe('líneas: nunca aplana', () => {
		it('conserva cantidad, unitario y descuento: subtotal = cantidad × unitario × (1 − descuento), línea manual, IVA por línea', () => {
			const result = planInvoiceEdit(
				ctx(),
				body([edit({ quantity: 12, discount_pct: 10 })], { deviation: { type: 'upsell', reason: 'Más usuarios' } })
			);
			const [planned] = result.lines;

			expect(result.errors).toEqual([]);
			expect(planned).toMatchObject({ id: 'line-1', action: 'update', is_visible: true });
			expect(planned.after).toMatchObject({
				quantity: 12,
				unit_price_contract_currency: 100,
				discount_pct: 10,
				subtotal_contract_currency: 1080,
				tax_contract_currency: 205.2,
				total_contract_currency: 1285.2,
				quantity_source: 'manual',
				pricing_breakdown: null,
			});
			expect(result.write.updates).toEqual([expect.objectContaining({ id: 'line-1' })]);
		});

		it('una línea sin cambios queda unchanged y no se escribe; las líneas omitidas del cuerpo quedan igual (nada se borra)', () => {
			const two = ctx({ lines: [line(), line({ id: 'line-2', contract_item_id: OTHER, billing_period_start: '2026-10-01' })] });
			const result = planInvoiceEdit(two, body([edit()]));

			expect(result.lines.map((entry) => [entry.id, entry.action])).toEqual([
				['line-1', 'unchanged'],
				['line-2', 'unchanged'],
			]);
			expect(result.write).toMatchObject({ updates: [], creates: [], removes: [], amounts_changed: false });
			expect(result.rsm_from_month).toBeNull();
		});

		it('exact_total fija el subtotal y deriva el unitario a 6 decimales (con y sin descuento)', () => {
			expect(manualLineAmounts(3, 0, 0, 'exact_total', 1000)).toEqual({ unit_price: 333.333333, subtotal: 1000 });
			expect(manualLineAmounts(3, 0, 10, 'exact_total', 1000)).toEqual({ unit_price: 370.37037, subtotal: 1000 });
			expect(manualLineAmounts(3, 0, 0, 'exact_total', 999.995)).toEqual({ unit_price: 333.333333, subtotal: 1000 });
			expect(manualLineAmounts(0, 0, 0, 'exact_total', 50)).toBeNull();
			const result = planInvoiceEdit(
				ctx(),
				body([edit({ quantity: 3, amount_basis: 'exact_total', exact_total: 1000 })], { deviation: { type: 'correction', reason: 'OC' } })
			);

			expect(result.lines[0].after).toMatchObject({ quantity: 3, unit_price_contract_currency: 333.333333, subtotal_contract_currency: 1000 });
		});

		it('description sola: glosa protegida (description_locked) sin marcar la línea manual; respeta el límite del documento', () => {
			const result = planInvoiceEdit(ctx(), body([edit({ description: 'Servicio — octubre' })]));

			expect(result.lines[0].after).toMatchObject({ description: 'Servicio - octubre', description_locked: true, quantity_source: 'fixed' });
			expect(result.rsm_from_month).toBeNull();
			const long = planInvoiceEdit(ctx(), body([edit({ description: 'x'.repeat(81) })]));

			expect(long.errors).toEqual([{ field: 'lines.0.description', message: expect.stringContaining('81 caracteres') }]);
		});
	});

	describe('moneda de factura (convención FX)', () => {
		it('misma moneda: montos en moneda de factura = contrato; encabezado = Σ líneas', () => {
			const two = ctx({
				lines: [line(), line({ id: 'line-2', contract_item_id: OTHER, subtotal: 500, tax_amount: 95, total: 595, quantity: 5 })],
			});
			const result = planInvoiceEdit(two, body([edit({ quantity: 11 })], { deviation: { type: 'upsell', reason: 'x' } }));

			expect(result.lines[0].after).toMatchObject({ subtotal_invoice_currency: 1100, tax_invoice_currency: 209, total_invoice_currency: 1309 });
			expect(result.header.after).toMatchObject({
				amount_contract_currency: 1600,
				tax_contract_currency: 304,
				total_contract_currency: 1904,
				vat: 304,
				amount_invoice_currency: 1600,
				total_invoice_currency: 1904,
			});
		});

		it('spot sin tasa: montos en moneda de factura NULL (nunca FX 1 como el edit_pending_invoice viejo)', () => {
			const spot = ctx({
				invoice: invoice({
					invoice_currency: 'CLP',
					fx_contract_to_invoice: null,
					amount_invoice_currency: null,
					total_invoice_currency: null,
				}),
				lines: [line({ unit_price_invoice: null, subtotal_invoice: null, tax_amount_invoice: null, total_invoice: null })],
			});
			const result = planInvoiceEdit(spot, body([edit({ quantity: 12 })], { deviation: { type: 'upsell', reason: 'x' } }));

			expect(result.lines[0].after).toMatchObject({
				subtotal_contract_currency: 1200,
				unit_price_invoice_currency: null,
				subtotal_invoice_currency: null,
				tax_invoice_currency: null,
				total_invoice_currency: null,
			});
			expect(result.header.after).toMatchObject({
				amount_contract_currency: 1200,
				vat: 228,
				amount_invoice_currency: null,
				total_invoice_currency: null,
			});
			expect(result.write.fx).toBeNull();
		});

		it('tasa fija: línea × tasa (IVA en moneda de factura) y encabezado con la convención de `headerAmounts`', () => {
			const fixed = ctx({ invoice: invoice({ invoice_currency: 'CLP', fx_contract_to_invoice: 950 }) });
			const result = planInvoiceEdit(fixed, body([edit({ quantity: 12, discount_pct: 10 })], { deviation: { type: 'upsell', reason: 'x' } }));

			expect(result.lines[0].after).toMatchObject({
				unit_price_invoice_currency: 95000,
				subtotal_invoice_currency: 1026000,
				tax_invoice_currency: 194940,
				total_invoice_currency: 1220940,
			});
			expect(result.header.after).toMatchObject({
				amount_contract_currency: 1080,
				vat: 194940,
				amount_invoice_currency: 1026000,
				total_invoice_currency: 1220940,
				tax_invoice_currency: 194940,
			});
		});
	});

	describe('cantidad 0 y sin cobro', () => {
		it('una línea en 0 dentro de una factura con otras queda oculta (hide), no se borra, y la factura sigue Por Emitir', () => {
			const two = ctx({ lines: [line(), line({ id: 'line-2', contract_item_id: OTHER })] });
			const result = planInvoiceEdit(two, body([edit({ quantity: 0 })], { deviation: { type: 'downsell', reason: 'Sin uso' } }));

			expect(result.lines[0]).toMatchObject({ action: 'hide', is_visible: false });
			expect(result.lines[0].after).toMatchObject({ quantity: 0, subtotal_contract_currency: 0, tax_contract_currency: 0, is_visible: false });
			expect(result.write.removes).toEqual([]);
			expect(result.header.after.status).toBe('Por Emitir');
			expect(result.no_charge).toBeNull();
		});

		it('todas las líneas en 0: la Por Emitir pasa a Cancelada sin cobro (aviso becomes_no_charge), sin bloqueo empty_invoice', () => {
			const result = planInvoiceEdit(ctx(), body([edit({ quantity: 0 })], { deviation: { type: 'downsell', reason: 'Sin servicio' } }));

			expect(codes(result.blockers)).toEqual([]);
			expect(codes(result.warnings)).toContain('becomes_no_charge');
			expect(result.no_charge).toBe('becomes');
			expect(result.header.after).toMatchObject({ status: 'Cancelada', amount_contract_currency: 0 });
			expect(result.lines[0].after).toMatchObject({ quantity: 0, is_visible: false });
		});

		it('una sin cobro que recupera cantidad vuelve a Por Emitir (no_charge_reverted); otra cancelada no se edita', () => {
			const noCharge = ctx({
				invoice: invoice({ status: 'Cancelada', no_charge: true, amount_contract_currency: 0, vat: 0 }),
				lines: [line({ quantity: 0, subtotal: 0, tax_amount: 0, total: 0, subtotal_invoice: 0, tax_amount_invoice: 0, total_invoice: 0 })],
			});
			const restored = planInvoiceEdit(noCharge, body([edit({ quantity: 10 })]));

			expect(codes(restored.blockers)).toEqual([]);
			expect(restored.no_charge).toBe('reverted');
			expect(codes(restored.warnings)).toContain('no_charge_reverted');
			expect(restored.header.after).toMatchObject({ status: 'Por Emitir', amount_contract_currency: 1000 });
			const other = planInvoiceEdit(ctx({ invoice: invoice({ status: 'Cancelada' }) }), body([edit({ quantity: 10 })]));

			expect(codes(other.blockers)).toContain('not_pending');
		});
	});

	describe('bloqueos', () => {
		it('cantidad negativa, ítem que no es del contrato, período emitido, vencimiento antes de emisión', () => {
			const result = planInvoiceEdit(
				ctx({
					issued_periods: [
						{
							contract_item_id: OTHER,
							billing_period_start: '2026-09-01',
							billing_period_end: '2026-10-15',
							invoice_id: 'inv-0',
							invoice_number: 'F-9',
						},
					],
				}),
				body(
					[
						edit({ quantity: -1 }),
						{
							contract_item_id: 'no-existe',
							quantity: 1,
							unit_price: 1,
							billing_period_start: '2026-10-01',
							billing_period_end: '2026-10-31',
						},
						{
							contract_item_id: OTHER,
							quantity: 1,
							unit_price: 10,
							billing_period_start: '2026-10-01',
							billing_period_end: '2026-10-31',
						},
					],
					{ due_date: '2026-09-15' }
				)
			);

			expect(codes(result.blockers).sort()).toEqual(['due_before_issue', 'item_not_in_contract', 'overlaps_issued', 'quantity_negative']);
			expect(result.can_apply).toBe(false);
		});

		it('línea medida: cambiar la cantidad deriva a Consumos (también una línea nueva de un ítem medido)', () => {
			const metered: PriceSpec = { model: 'standard', quantity_type: 'metered', unit_amount: 2 };
			const result = planInvoiceEdit(
				ctx({ items: new Map([[ITEM, item({ price: metered })]]), lines: [line({ quantity_source: 'consumption' })] }),
				body([
					edit({ quantity: 20 }),
					{ contract_item_id: ITEM, quantity: 1, unit_price: 2, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31' },
				])
			);

			expect(codes(result.blockers)).toEqual(['metered_line_use_consumption', 'metered_line_use_consumption']);
		});

		it('borrador en el ERP: sent_to_erp_draft con la acción erp_reset para ofrecer "Restablecer borrador y editar"', () => {
			const result = planInvoiceEdit(
				ctx({ invoice: invoice({ odoo_invoice_id: 77, sent_to_odoo_at: '2026-09-29T10:00:00Z' }) }),
				body([edit({ quantity: 9 })])
			);

			expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' }));
		});

		it('errores de forma (400): línea de otra factura, repetida, cambio de ítem, período invertido', () => {
			const result = planInvoiceEdit(
				ctx(),
				body([
					edit({ id: 'otra' }),
					edit(),
					edit(),
					edit({ contract_item_id: OTHER }),
					edit({ billing_period_start: '2026-11-01', billing_period_end: '2026-10-01' }),
				])
			);

			expect(result.errors.map((error) => error.field)).toEqual(
				expect.arrayContaining(['lines.0.id', 'lines.2.id', 'lines.3.contract_item_id', 'lines.4.billing_period_end'])
			);
		});
	});

	describe('fechas y receptor', () => {
		it('cambiar la emisión conserva original_issue_date, recalcula el vencimiento por la condición de pago y avisa si ya pasó', () => {
			const result = planInvoiceEdit(ctx({ invoice: invoice({ original_issue_date: '2026-09-01' }) }), body([], { issue_date: '2026-09-15' }));

			expect(result.header.after).toMatchObject({
				issue_date: '2026-09-15',
				scheduled_at: '2026-09-15',
				original_issue_date: '2026-09-01',
				due_date: '2026-10-15',
			});
			expect(codes(result.warnings)).toContain('past_issue_date');
		});

		it('receptor: re-deriva RUT, IVA (normalizado) y exportación por el tipo de documento; aviso document_type_review si es de otro país', () => {
			const result = planInvoiceEdit(
				ctx({
					invoice: invoice({ tax_rate: 0.19 }),
					receiver: { id: 'entity-2', legal_name: 'Cliente Perú SAC', tax_id: '20100', country: 'Perú', belongs_to_client: true },
				}),
				body([], { client_entity_id: 'entity-2' })
			);

			expect(result.header.after).toMatchObject({
				client_entity_id: 'entity-2',
				client_tax_id: '20100',
				legal_name: 'Cliente Perú SAC',
				tax_rate: 19,
				export_type: 0,
				document_type: 'FACTURA',
			});
			// La tasa guardada venía en la escala 0,19: se normaliza a 19 % (aviso) y el IVA de las líneas se recalcula con ella.
			expect(codes(result.warnings)).toEqual(['document_type_review', 'tax_rate_normalized']);
			expect(result.lines[0].after).toMatchObject({ tax_contract_currency: 190 });
			const other = planInvoiceEdit(
				ctx({ receiver: { id: 'entity-3', legal_name: 'Otro', tax_id: '1', country: 'Chile', belongs_to_client: false } }),
				body([], { client_entity_id: 'entity-3' })
			);

			expect(other.errors).toEqual([{ field: 'client_entity_id', message: 'La razón social no pertenece al cliente comercial del contrato' }]);
		});

		it('receptor con documento de exportación: IVA 0 y el IVA de todas las líneas se recalcula (sin tocar subtotales)', () => {
			const result = planInvoiceEdit(
				ctx({
					invoice: invoice({ document_type: 'FACTURA_EXPORTACION' }),
					receiver: { id: 'entity-2', legal_name: 'US Inc', tax_id: 'X', country: 'Estados Unidos', belongs_to_client: true },
				}),
				body([], { client_entity_id: 'entity-2' })
			);

			expect(result.lines[0]).toMatchObject({ action: 'update' });
			expect(result.lines[0].after).toMatchObject({
				subtotal_contract_currency: 1000,
				tax_contract_currency: 0,
				total_contract_currency: 1000,
			});
			expect(result.header.after).toMatchObject({ tax_rate: 0, export_type: 1, vat: 0, amount_contract_currency: 1000 });
		});
	});

	describe('conciliador de desvíos (por líneas, nunca bloquea)', () => {
		it('detecta el desvío por ítem y período y pide motivo solo si la edición lo introduce', () => {
			const result = planInvoiceEdit(ctx(), body([edit({ quantity: 8 })]));

			expect(result.deviation).toMatchObject({
				has_deviation: true,
				total_diff: -200,
				inherited: false,
				changed: true,
				reason_required: true,
				by_item: [
					{ contract_item_id: ITEM, product_name: 'Plataforma', period_start: '2026-10-01', expected: 1000, actual: 800, diff: -200 },
				],
			});
			expect(codes(result.blockers)).toEqual([]);
			expect(codes(result.warnings)).toContain('deviation_reason_required');
		});

		it('heredado: si la factura ya se desviaba y la edición no lo cambia, no pide motivo', () => {
			const inherited = ctx({ lines: [line({ subtotal: 900, discount_pct: 10 })] });
			const result = planInvoiceEdit(inherited, body([edit({ discount_pct: 10, description: 'Otro texto' })]));

			expect(result.deviation).toMatchObject({
				has_deviation: true,
				inherited: true,
				changed: false,
				reason_required: false,
				total_diff: -100,
			});
		});

		it('descuenta lo que ya llevan otras facturas del mismo ítem y período (complementaria, reemisión)', () => {
			const deviation = reconcileDeviation(
				plan({ [`${ITEM}|2026-10-01`]: 1000 }, { [`${ITEM}|2026-10-01`]: 400 }),
				[],
				[stateOf(line({ subtotal: 600 }))]
			);

			expect(deviation).toMatchObject({ has_deviation: false, total_diff: 0 });
		});
	});

	describe('descuento puntual (en la línea, sin líneas negativas)', () => {
		const discount = { type: 'discount' as const, reason: 'Promo aniversario', revenue_treatment: 'service_period' as const };

		it('% sobre el subtotal: la línea conserva cantidad × unitario, el % efectivo combinado y la sublínea one_off en el desglose', () => {
			const result = planInvoiceEdit(ctx(), body([edit({ one_off_discount: { type: 'pct', value: 10 } })], { deviation: discount }));

			expect(result.errors).toEqual([]);
			expect(result.lines[0].after).toMatchObject({
				quantity: 10,
				unit_price_contract_currency: 100,
				discount_pct: 10,
				subtotal_contract_currency: 900,
				quantity_source: 'manual',
				pricing_breakdown: [
					expect.objectContaining({ kind: 'discount', one_off: true, amount: -100, label: 'Descuento puntual: Promo aniversario' }),
				],
				one_off_discount: { type: 'pct', value: 10, amount: 100, label: 'Descuento puntual: Promo aniversario' },
			});
			expect(result.header.after).toMatchObject({ nc_revenue_treatment: 'service_period', amount_contract_currency: 900 });
			expect(result.deviation).toMatchObject({ has_deviation: true, total_diff: -100 });
			expect(result.revenue_effect).toEqual({ treatment: 'service_period', total: -100, by_month: [{ month: '2026-10-01', amount: -100 }] });
			expect(result.one_off_changed).toBe(true);
			expect(result.rsm_from_month).toBe('2026-10-01');
		});

		it('monto sobre una línea con descuento contractual: % combinado respecto de cantidad × unitario', () => {
			const withDiscount = ctx({ lines: [line({ discount_pct: 10, subtotal: 900, tax_amount: 171, total: 1071 })] });
			const result = planInvoiceEdit(
				withDiscount,
				body([edit({ discount_pct: 10, one_off_discount: { type: 'amount', value: 150 } })], { deviation: discount })
			);

			expect(result.lines[0].after).toMatchObject({ subtotal_contract_currency: 750, discount_pct: 25 });
			expect(result.lines[0].after!.pricing_breakdown).toEqual([expect.objectContaining({ amount: -150, base_discount_pct: 10 })]);
		});

		it('re-editar reemplaza el puntual (no apila) y null lo quita (vuelve al descuento base y limpia el tratamiento)', () => {
			const discounted = planInvoiceEdit(ctx(), body([edit({ one_off_discount: { type: 'pct', value: 10 } })], { deviation: discount }));
			const stored = ctx({
				invoice: invoice({ nc_revenue_treatment: 'service_period', amount_contract_currency: 900 }),
				lines: [
					line({
						discount_pct: 10,
						subtotal: 900,
						tax_amount: 171,
						total: 1071,
						quantity_source: 'manual',
						pricing_breakdown: discounted.lines[0].after!.pricing_breakdown,
					}),
				],
			});
			const replaced = planInvoiceEdit(
				stored,
				body([edit({ discount_pct: 10, one_off_discount: { type: 'amount', value: 50 } })], { deviation: discount })
			);

			expect(replaced.lines[0].after).toMatchObject({ subtotal_contract_currency: 950, discount_pct: 5 });
			expect(replaced.lines[0].after!.pricing_breakdown!.filter((subline) => subline.one_off)).toHaveLength(1);
			const removed = planInvoiceEdit(
				stored,
				body([edit({ discount_pct: 10, one_off_discount: null })], { deviation: { type: 'correction', reason: 'Se retira la promo' } })
			);

			expect(removed.lines[0].after).toMatchObject({
				subtotal_contract_currency: 1000,
				discount_pct: 0,
				pricing_breakdown: null,
				one_off_discount: null,
			});
			expect(removed.header.after.nc_revenue_treatment).toBeNull();
			expect(removed.one_off_changed).toBe(true);
			// El cuerpo sin one_off_discount conserva el puntual guardado.
			const kept = planInvoiceEdit(stored, body([edit({ discount_pct: 10, description: 'Texto nuevo' })]));

			expect(kept.lines[0].after).toMatchObject({ subtotal_contract_currency: 900, description_locked: true });
		});

		it('sin motivo tipado con devengo → 400; el puntual no puede superar el subtotal', () => {
			const missing = planInvoiceEdit(ctx(), body([edit({ one_off_discount: { type: 'pct', value: 10 } })]));

			expect(missing.errors.map((error) => error.field)).toEqual(['deviation', 'deviation.revenue_treatment']);
			const wrongType = planInvoiceEdit(
				ctx(),
				body([edit({ one_off_discount: { type: 'pct', value: 10 } })], {
					deviation: { type: 'upsell', reason: 'x', revenue_treatment: 'impact_month' },
				})
			);

			expect(wrongType.errors.map((error) => error.field)).toEqual(['deviation.type']);
			const tooMuch = planInvoiceEdit(ctx(), body([edit({ one_off_discount: { type: 'amount', value: 1500 } })], { deviation: discount }));

			expect(tooMuch.errors).toEqual([{ field: 'lines.0.one_off_discount.value', message: expect.stringContaining('supera el subtotal') }]);
		});
	});

	describe('presentación por tramo ↔ una fila (sin cambiar el total)', () => {
		const tiers: PriceSpec = {
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [
				{ from: 1, to: 5, per_unit_amount: 13, flat_amount: 0 },
				{ from: 6, to: 10, per_unit_amount: 7, flat_amount: 0 },
				{ from: 11, to: null, per_unit_amount: 5.5, flat_amount: 0 },
			],
			invoice_line_mode: 'per_tier',
		};
		const priced = priceLine(tiers, 12, 0);
		const perTierRows = splitInvoiceLines(priced).map((part, index) =>
			line({
				id: `tier-${index}`,
				quantity: part.quantity,
				unit_price: part.unit_price,
				subtotal: part.subtotal,
				tax_amount: Math.round(part.subtotal * 19) / 100,
				total: part.subtotal + Math.round(part.subtotal * 19) / 100,
				unit_price_invoice: part.unit_price,
				subtotal_invoice: part.subtotal,
				tax_amount_invoice: Math.round(part.subtotal * 19) / 100,
				total_invoice: part.subtotal + Math.round(part.subtotal * 19) / 100,
				pricing_breakdown: part.breakdown,
				description: `Plataforma - ${part.label}`,
				description_locked: index === 0,
			})
		);
		const pricedItem = item({ price: tiers, price_id: 'price-1', price_owner: 'contract' });
		const render = {
			template: null,
			contract_number: 'CTR-2026-001',
			client_name: 'Cliente SpA',
			references: [],
			contract_currency: 'USD',
			invoice_currency: 'USD',
			fx_rate: null,
		};

		it('por tramo → una fila: recompone desde period_quantity + desglose, mismo subtotal e IVA, conserva la glosa protegida', () => {
			const result = recomposeItemRows(perTierRows, 'single', { tax_rate: 19, fx: 1, render });
			const [update] = result.updates;

			expect(priced.subtotal).toBe(111);
			expect(result.removes).toEqual(['tier-1', 'tier-2']);
			expect(update.after).toMatchObject({
				quantity: 12,
				subtotal_contract_currency: 111,
				tax_contract_currency: 21.09,
				description_locked: true,
			});
			expect(update.after.pricing_breakdown!.every((subline) => subline.line_index === undefined)).toBe(true);
		});

		it('una fila → por tramo: una fila por tramo, Σ subtotales = total, IVA repartido', () => {
			const single = recomposeItemRows(perTierRows, 'single', { tax_rate: 19, fx: 1, render }).updates[0].after;
			const row = line({
				id: 'single',
				quantity: single.quantity,
				unit_price: single.unit_price_contract_currency,
				subtotal: single.subtotal_contract_currency,
				tax_amount: single.tax_contract_currency,
				total: single.total_contract_currency,
				pricing_breakdown: single.pricing_breakdown,
			});
			const result = recomposeItemRows([row], 'per_tier', { tax_rate: 19, fx: 1, render });
			const all = [result.updates[0].after, ...result.creates];

			expect(all).toHaveLength(3);
			expect(Math.round(all.reduce((sum, state) => sum + state.subtotal_contract_currency, 0) * 100) / 100).toBe(111);
			expect(Math.round(all.reduce((sum, state) => sum + state.tax_contract_currency, 0) * 100) / 100).toBe(21.09);
		});

		it('scope invoice: solo esta factura; scope invoice_and_following: también el precio del contrato; filas manuales se saltan', () => {
			const base = ctx({
				items: new Map([[ITEM, pricedItem]]),
				lines: perTierRows,
				invoice: invoice({ amount_contract_currency: 111 }),
				plan: plan({ [`${ITEM}|2026-10-01`]: 111 }),
			});
			const onlyThis = planInvoiceEdit(base, body([], { line_mode: [{ contract_item_id: ITEM, mode: 'single' }] }));

			expect(onlyThis.lines.map((entry) => entry.action)).toEqual(['update', 'remove', 'remove']);
			expect(onlyThis.header.after.amount_contract_currency).toBe(111);
			expect(onlyThis.write.amounts_changed).toBe(false);
			expect(onlyThis.price_line_modes).toEqual([]);
			expect(onlyThis.deviation.has_deviation).toBe(false);
			const following = planInvoiceEdit(
				base,
				body([], { line_mode: [{ contract_item_id: ITEM, mode: 'single', scope: 'invoice_and_following' }] })
			);

			expect(following.price_line_modes).toEqual([{ contract_item_id: ITEM, price_id: 'price-1', mode: 'single' }]);
			const next = planFollowingLineMode(invoice({ id: 'inv-2', issue_date: '2026-11-01' }), perTierRows, ITEM, 'single', {
				tax_rate: 19,
				render,
			});

			expect(next.result!.updates).toHaveLength(1);
			const blocked = planFollowingLineMode(invoice({ id: 'inv-3', odoo_invoice_id: 5 }), perTierRows, ITEM, 'single', {
				tax_rate: 19,
				render,
			});

			expect(codes(blocked.blockers)).toEqual(['sent_to_erp_draft']);
			expect(blocked.result).toBeNull();
			const manual = planInvoiceEdit(
				ctx({ ...base, lines: perTierRows.map((row) => ({ ...row, quantity_source: 'manual' })) }),
				body([], { line_mode: [{ contract_item_id: ITEM, mode: 'single' }] })
			);

			expect(codes(manual.warnings)).toContain('manual_edit_kept');
			expect(manual.write.updates).toEqual([]);
		});
	});

	describe('masivo de encabezado', () => {
		it('aplica términos, receptor y emisión automática por factura; bloquea no Por Emitir y sin cambios', () => {
			const ok = planBulkHeader(ctx(), { invoice_terms_and_conditions: 'Pago a 30 días', auto_invoice: true });
			const issued = planBulkHeader(ctx({ invoice: invoice({ status: 'Emitida' }) }), { invoice_terms_and_conditions: 'x' });
			const same = planBulkHeader(ctx({ invoice: invoice({ auto_invoice: true }) }), { auto_invoice: true });

			expect(ok.blockers).toEqual([]);
			expect(ok.after).toMatchObject({ invoice_terms_and_conditions: 'Pago a 30 días', auto_invoice: true, amount_contract_currency: 1000 });
			expect(codes(issued.blockers)).toEqual(['not_pending']);
			expect(codes(same.blockers)).toEqual(['no_change']);
		});
	});

	describe('auditoría 01-10: período anterior, OC en masivo y encabezado = Σ líneas', () => {
		it('mover una línea de período: el devengo mira también el período ANTERIOR; un mes cerrado no bloquea (Domi 03-10)', () => {
			const moved = body([edit({ billing_period_start: '2026-11-01', billing_period_end: '2026-11-30' })], {
				deviation: { type: 'correction', reason: 'Período' },
			});
			const open = planInvoiceEdit(ctx({ issued_periods: [] }), moved);
			const closed = planInvoiceEdit(
				ctx({ context: context({ cutoff_date: '2026-10-15' }), invoice: invoice({ issue_date: '2026-10-20' }) }),
				moved
			);

			expect(open.rsm_from_month).toBe('2026-10-01');
			expect(closed.rsm_from_month).toBe('2026-10-01');
			expect(codes(closed.blockers)).not.toContain('period_closed');
		});

		it('masivo: una factura por OC no cambia de receptor ni de IVA (partial_billing_invoice); términos sí', () => {
			const poLines = [
				line({ id: 'v', quantity: 1, subtotal: 0, tax_amount: 0, total: 0, subtotal_invoice: 0, tax_amount_invoice: 0, total_invoice: 0 }),
				line({ id: 'a', visible_line_id: 'v' }),
			];
			const receiver = { id: 'entity-2', legal_name: 'Otra SpA', tax_id: '77.000.000-2', country: 'Chile', belongs_to_client: true };
			const blocked = planBulkHeader(ctx({ lines: poLines, receiver }), { client_entity_id: 'entity-2' });
			const terms = planBulkHeader(ctx({ lines: poLines }), { invoice_terms_and_conditions: 'Pago a 45 días' });

			expect(codes(blocked.blockers)).toContain('partial_billing_invoice');
			expect(terms.blockers).toEqual([]);
		});

		it('tasa fija: el encabezado es Σ de los montos redondeados de las líneas en moneda de factura', () => {
			const fixed = ctx({
				invoice: invoice({
					invoice_currency: 'CLP',
					fx_contract_to_invoice: 950.5,
					amount_invoice_currency: 950500,
					total_invoice_currency: 1131095,
				}),
				lines: [
					line({ unit_price_invoice: 95050, subtotal_invoice: 950500, tax_amount_invoice: 180595, total_invoice: 1131095 }),
					line({
						id: 'line-2',
						contract_item_id: OTHER,
						quantity: 3,
						unit_price: 33.33,
						subtotal: 99.99,
						tax_amount: 19,
						total: 118.99,
						unit_price_invoice: 31680.165,
						subtotal_invoice: 95040.5,
						tax_amount_invoice: 18059.5,
						total_invoice: 113100,
					}),
				],
			});
			const result = planInvoiceEdit(fixed, body([edit({ quantity: 11 })], { deviation: { type: 'upsell', reason: 'x' } }));
			const after = result.lines.map((entry) => entry.after!);
			const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

			expect(result.header.after.amount_invoice_currency).toBe(sum(after.map((state) => state.subtotal_invoice_currency!)));
			expect(result.header.after.vat).toBe(sum(after.map((state) => state.tax_invoice_currency!)));
			expect(result.header.after.total_invoice_currency).toBe(sum([result.header.after.amount_invoice_currency!, result.header.after.vat!]));
		});
	});
});
