import {
	allocate,
	continuitySide,
	monthPieces,
	type NewInvoiceRules,
	planReorganize,
	type ReorganizeContext,
	type ReorganizeInput,
	scaleBreakdown,
	scaleRows,
	scheduleBoard,
	telescopic,
} from './invoice-reorganize';

import type { ContractInvoiceContext, ContractInvoiceRow } from './contract-invoices';
import type { EditItem, EditLineRow } from './invoice-edit';

const ITEM = 'item-1';
const ITEM_B = 'item-2';

const context = (overrides: Partial<ContractInvoiceContext> = {}): ContractInvoiceContext => ({
	contract_id: 'contract-1',
	contract_number: 'CTR-2026-001',
	contract_status: 'Activo',
	contract_fx_invoice_policy: null,
	contract_requires_references: false,
	auto_send_to_erp: true,
	payment_terms: { kind: 'net', days: 30 },
	entity_payment_terms: null,
	company_country: 'Chile',
	has_erp_integration: true,
	has_erp_partner: true,
	has_entity: true,
	cutoff_date: null,
	today: '2026-09-30',
	...overrides,
});

const invoice = (id: string, issueDate: string, overrides: Partial<ContractInvoiceRow> = {}): ContractInvoiceRow => ({
	id,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: issueDate,
	original_issue_date: issueDate,
	scheduled_at: issueDate,
	due_date: null,
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
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
	period_start: null,
	period_end: null,
	lines_count: 1,
	lines_without_product: 0,
	references_count: 0,
	priced_base: 1000,
	...overrides,
});

const line = (id: string, start: string, end: string, subtotal: number, overrides: Partial<EditLineRow> = {}): EditLineRow => ({
	id,
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: `Plataforma - ${start} a ${end}`,
	description_locked: false,
	quantity: 10,
	unit_of_measure: 'UND',
	discount_pct: 0,
	unit_price: subtotal / 10,
	subtotal,
	tax_amount: Math.round(subtotal * 19) / 100,
	total: subtotal + Math.round(subtotal * 19) / 100,
	unit_price_invoice: subtotal / 10,
	subtotal_invoice: subtotal,
	tax_amount_invoice: Math.round(subtotal * 19) / 100,
	total_invoice: subtotal + Math.round(subtotal * 19) / 100,
	billing_period_start: start,
	billing_period_end: end,
	quantity_source: 'fixed',
	pricing_breakdown: null,
	...overrides,
});

const item = (id: string, overrides: Partial<EditItem> = {}): EditItem => ({
	id,
	product_id: 'prod-1',
	product_name: id === ITEM ? 'Plataforma' : 'Soporte',
	account: null,
	unit_of_measure: 'UND',
	price: null,
	price_id: null,
	price_owner: null,
	start_date: '2026-10-01',
	end_date: '2027-09-30',
	churn_date: null,
	term_months: 12,
	...overrides,
});

const rules = (overrides: Partial<NewInvoiceRules> = {}): NewInvoiceRules => ({
	client_entity_id: 'entity-1',
	legal_name: 'Cliente SpA',
	document_type: 'FACTURA',
	export_type: 0,
	tax_rate: 19,
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	fx_invoice_policy: null,
	fixed_invoice_rates: [],
	...overrides,
});

interface Fixture {
	invoices: Array<[ContractInvoiceRow, EditLineRow[]]>;
	items?: EditItem[];
	expected?: Array<[string, number]>;
	foreign_invoices?: ContractInvoiceRow[];
	foreign_lines?: Array<[string, string, string]>;
	issued?: ReorganizeContext['issued_periods'];
	other_lines?: ReorganizeContext['other_lines'];
	rules?: Partial<NewInvoiceRules>;
	context?: Partial<ContractInvoiceContext>;
}

const ctxOf = (fixture: Fixture): ReorganizeContext => ({
	context: context(fixture.context),
	invoices: fixture.invoices.map(([row]) => row),
	lines: new Map(fixture.invoices.map(([row, rows]) => [row.id, rows])),
	foreign_invoices: new Map((fixture.foreign_invoices ?? []).map((row) => [row.id, row])),
	foreign_lines: new Map((fixture.foreign_lines ?? []).map(([id, invoiceId, status]) => [id, { invoice_id: invoiceId, status }])),
	items: new Map((fixture.items ?? [item(ITEM), item(ITEM_B)]).map((row) => [row.id, row])),
	issued_periods: fixture.issued ?? [],
	other_lines: fixture.other_lines ?? [],
	expected: new Map(fixture.expected ?? []),
	known_items: new Set((fixture.expected ?? []).map(([key]) => key.split('|')[0])),
	product_names: new Map([
		[ITEM, 'Plataforma'],
		[ITEM_B, 'Soporte'],
	]),
	rules: rules(fixture.rules),
	render: { template: null, contract_number: 'CTR-2026-001', client_name: 'Cliente SpA', max_chars: null },
});

const plan = (fixture: Fixture, input: ReorganizeInput) => planReorganize(ctxOf(fixture), input);
const codes = (list: Array<{ code: string }>) => list.map((entry) => entry.code);
const view = (result: ReturnType<typeof plan>, key: string) => result.invoices.find((entry) => entry.key === key)!;

/** Tres Por Emitir mensuales de 1.000 (octubre, noviembre, diciembre), una línea cada una. */
const monthly = (): Fixture => ({
	invoices: [
		[invoice('inv-oct', '2026-10-01'), [line('l-oct', '2026-10-01', '2026-10-31', 1000)]],
		[invoice('inv-nov', '2026-11-01'), [line('l-nov', '2026-11-01', '2026-11-30', 1000)]],
		[invoice('inv-dec', '2026-12-01'), [line('l-dec', '2026-12-01', '2026-12-31', 1000)]],
	],
	expected: [
		[`${ITEM}|2026-10-01`, 1000],
		[`${ITEM}|2026-11-01`, 1000],
		[`${ITEM}|2026-12-01`, 1000],
	],
});

describe('invoice-reorganize (spec facturas §3.5, lógica pura)', () => {
	describe('utilidades', () => {
		it('reparto telescópico: suma exacta y residuo en la última', () => {
			expect(telescopic(100, [1, 1, 1])).toEqual([33.33, 33.34, 33.33]);
			expect(telescopic(3000, [31, 61])).toEqual([1010.87, 1989.13]);
		});

		it('allocate: cada parte suma exacto y cada fila conserva su total', () => {
			const matrix = allocate([600, 400], [250, 750]);

			expect(matrix.map((part) => part[0] + part[1])).toEqual([250, 750]);
			expect(matrix[0][0] + matrix[1][0]).toBe(600);
			expect(scaleRows([600, 400], 500)).toEqual([300, 200]);
		});

		it('tramos por mes calendario', () => {
			expect(monthPieces('2026-10-15', '2026-12-10')).toEqual([
				{ start: '2026-10-15', end: '2026-10-31', days: 17 },
				{ start: '2026-11-01', end: '2026-11-30', days: 30 },
				{ start: '2026-12-01', end: '2026-12-10', days: 10 },
			]);
		});

		it('continuidad por líneas: cuotas concurrentes no son solape; huecos y cola contra la vigencia del ítem', () => {
			const side = continuitySide(
				[
					{ billing_period_start: '2026-10-01', billing_period_end: '2026-10-31', subtotal: 500 },
					{ billing_period_start: '2026-10-01', billing_period_end: '2026-10-31', subtotal: 500 },
					{ billing_period_start: '2026-12-01', billing_period_end: '2026-12-31', subtotal: 1000 },
				],
				{ start_date: '2026-10-01', end_date: '2027-01-31' }
			);

			expect(side).toMatchObject({ actual_total: 2000, lines: 3, overlaps: [] });
			expect(side.gaps).toEqual([
				{ type: 'period_gap', from: '2026-11-01', to: '2026-11-30' },
				{ type: 'tail_gap', from: '2027-01-01', to: '2027-01-31' },
			]);
		});
	});

	describe('merge', () => {
		it('todas las líneas a la de emisión más temprana; la vacía queda Cancelada; encabezado = Σ líneas; sin motivo (mismo total por ítem)', () => {
			const result = plan(monthly(), { operations: [{ op: 'merge', invoice_ids: ['inv-nov', 'inv-oct'] }] });

			expect(result.can_apply).toBe(true);
			expect(view(result, 'inv-oct')).toMatchObject({ action: 'updated', after: { amount_contract_currency: 2000, vat: 380, lines_count: 2 } });
			expect(view(result, 'inv-oct').lines.find((entry) => entry.id === 'l-nov')).toMatchObject({
				action: 'moved',
				from_invoice_id: 'inv-nov',
			});
			expect(view(result, 'inv-nov')).toMatchObject({ action: 'cancelled', after: { status: 'Cancelada', amount_contract_currency: 0 } });
			expect(result.write.cancelled.map((entry) => entry.id)).toEqual(['inv-nov']);
			expect(result.write.line_updates).toEqual([expect.objectContaining({ id: 'l-nov', invoice_key: 'inv-oct', moved: true })]);
			expect(result.continuity).toMatchObject({ changed: false, reason_required: false });
			expect(result.rsm_from_month).toBeNull();
		});

		it('mixed_currency: distinta moneda, receptor o documento; sent_to_erp_draft bloquea', () => {
			const fixture = monthly();

			fixture.invoices[1][0] = invoice('inv-nov', '2026-11-01', {
				invoice_currency: 'USD',
				fx_contract_to_invoice: null,
				client_entity_id: 'entity-2',
			});
			fixture.invoices[2][0] = invoice('inv-dec', '2026-12-01', { odoo_invoice_id: 55, sent_to_odoo_at: '2026-09-29T00:00:00Z' });
			const mixed = plan(fixture, { operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-nov'] }] });
			const draft = plan(fixture, { operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-dec'] }] });

			expect(codes(mixed.blockers)).toEqual(['mixed_currency']);
			expect(mixed.blockers[0].message).toContain('moneda');
			expect(mixed.blockers[0].message).toContain('receptor');
			expect(mixed.can_apply).toBe(false);
			expect(mixed.write.line_updates).toEqual([]);
			expect(codes(draft.blockers)).toEqual(['sent_to_erp_draft']);
		});

		it('una factura repetida o una sola → 400', () => {
			expect(plan(monthly(), { operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-oct'] }] }).errors).toEqual([
				{ field: 'operations.0.invoice_ids', message: 'Una factura viene repetida' },
			]);
		});
	});

	describe('move_line', () => {
		it('a una factura nueva: nace del generador (FX fijo del contrato para su período, nunca clonado; vencimiento por condición de pago)', () => {
			const fixture: Fixture = {
				invoices: [
					[
						invoice('inv-oct', '2026-10-01', {
							contract_currency: 'USD',
							invoice_currency: 'CLP',
							fx_contract_to_invoice: 900,
							amount_invoice_currency: 900000,
						}),
						[
							line('l-a', '2026-10-01', '2026-10-31', 1000, { subtotal_invoice: 900000, unit_price_invoice: 90000 }),
							line('l-b', '2026-10-01', '2026-10-31', 500, { contract_item_id: ITEM_B, subtotal_invoice: 450000 }),
						],
					],
				],
				rules: {
					contract_currency: 'USD',
					invoice_currency: 'CLP',
					fx_invoice_policy: 'fixed',
					fixed_invoice_rates: [
						{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-10-01', period_end: '2026-12-31' },
					],
				},
			};
			const result = plan(fixture, { operations: [{ op: 'move_line', line_id: 'l-b', new_invoice: { issue_date: '2026-10-15' } }] });
			const created = result.write.creates[0];

			expect(result.can_apply).toBe(true);
			expect(created).toMatchObject({
				key: 'new:1',
				issue_date: '2026-10-15',
				due_date: '2026-11-14',
				split_from_invoice_id: 'inv-oct',
				client_entity_id: 'entity-1',
				document_type: 'FACTURA',
				tax_rate: 19,
				fx: 950,
				header: { amount_contract_currency: 500, amount_invoice_currency: 475000, vat: 90250, total_invoice_currency: 565250 },
			});
			// La línea conserva cantidad, unitario, descuento y período; se valoriza con la tasa de la factura nueva.
			expect(result.write.line_updates[0]).toMatchObject({
				id: 'l-b',
				invoice_key: 'new:1',
				moved: true,
				fx_changed: true,
				state: { quantity: 10, unit_price_contract_currency: 50, billing_period_start: '2026-10-01', subtotal_invoice_currency: 475000 },
			});
			expect(view(result, 'inv-oct')).toMatchObject({ action: 'updated', after: { amount_contract_currency: 1000, lines_count: 1 } });
		});

		it('la factura origen que queda sin líneas se cancela; una emitida no recibe líneas (overlaps_issued)', () => {
			const issued = invoice('inv-sep', '2026-09-01', { status: 'Emitida', invoice_number: 'F-100' });
			const toNew = plan(monthly(), { operations: [{ op: 'move_line', line_id: 'l-nov', to_invoice_id: 'inv-dec' }] });
			const toIssued = plan(
				{ ...monthly(), foreign_invoices: [issued] },
				{ operations: [{ op: 'move_line', line_id: 'l-nov', to_invoice_id: 'inv-sep' }] }
			);

			expect(view(toNew, 'inv-nov').action).toBe('cancelled');
			expect(view(toNew, 'inv-dec').after).toMatchObject({ amount_contract_currency: 2000 });
			expect(codes(toIssued.blockers)).toEqual(['overlaps_issued']);
			expect(toIssued.blockers[0].message).toContain('F-100');
		});

		it('una línea de una emitida no se reorganiza; una ajena al contrato → 400', () => {
			const foreign = plan(
				{ ...monthly(), foreign_lines: [['l-old', 'inv-sep', 'Emitida']] },
				{
					operations: [{ op: 'move_line', line_id: 'l-old', to_invoice_id: 'inv-oct' }],
				}
			);
			const unknown = plan(monthly(), { operations: [{ op: 'move_line', line_id: 'nope', to_invoice_id: 'inv-oct' }] });

			expect(codes(foreign.blockers)).toEqual(['not_pending']);
			expect(unknown.errors).toEqual([{ field: 'operations.0.line_id', message: 'La línea no pertenece a una factura del contrato' }]);
		});

		it('una línea manual se mueve sin re-montarse (aviso manual_edit_kept)', () => {
			const fixture = monthly();

			fixture.invoices[1][1] = [line('l-nov', '2026-11-01', '2026-11-30', 1234, { quantity_source: 'manual' })];
			const result = plan(fixture, { operations: [{ op: 'move_line', line_id: 'l-nov', to_invoice_id: 'inv-oct' }] });

			expect(codes(result.warnings)).toContain('manual_edit_kept');
			expect(result.write.line_updates[0].state).toMatchObject({ subtotal_contract_currency: 1234, quantity_source: 'manual' });
		});
	});

	describe('split_line', () => {
		const quarterly = (): Fixture => ({
			invoices: [[invoice('inv-q', '2026-10-01', { amount_contract_currency: 3000 }), [line('l-q', '2026-10-01', '2026-12-31', 3000)]]],
			expected: [[`${ITEM}|2026-10-01`, 3000]],
		});

		it('por fecha: dos subperíodos, montos por días, cantidad conservada, unitario = subtotal ÷ cantidad; la parte posterior a una factura nueva un mes después', () => {
			const result = plan(quarterly(), { operations: [{ op: 'split_line', line_id: 'l-q', by: 'date', at: '2026-10-31' }] });
			const origin = view(result, 'inv-q').lines[0];
			const created = view(result, 'new:1');

			expect(result.can_apply).toBe(true);
			expect(origin).toMatchObject({
				action: 'split',
				after: { quantity: 10, subtotal_contract_currency: 1010.87, unit_price_contract_currency: 101.087, billing_period_end: '2026-10-31' },
			});
			expect(origin.after!.description).toContain('31/10/2026');
			expect(created).toMatchObject({
				action: 'created',
				after: { issue_date: '2026-11-01', due_date: '2026-12-01', amount_contract_currency: 1989.13 },
			});
			expect(created.lines[0]).toMatchObject({
				action: 'split',
				origin_line_id: 'l-q',
				after: { quantity: 10, billing_period_start: '2026-11-01', billing_period_end: '2026-12-31', subtotal_contract_currency: 1989.13 },
			});
			// Redistribución pura: el total del ítem no cambia → sin motivo; el período cambió → devengo desde octubre.
			expect(result.continuity).toMatchObject({ changed: false, reason_required: false });
			expect(result.rsm_from_month).toBe('2026-10-01');
		});

		it('por cuotas con montos distintos: cada cuota posterior en su factura nueva mensual; mismo período (cuotas concurrentes)', () => {
			const result = plan(quarterly(), {
				operations: [
					{
						op: 'split_line',
						line_id: 'l-q',
						by: 'installments',
						installments: [{ amount: 1000 }, { amount: 1500 }, { amount: 500, issue_date: '2027-01-15' }],
					},
				],
			});

			expect(result.write.creates.map((entry) => [entry.issue_date, entry.header.amount_contract_currency])).toEqual([
				['2026-11-01', 1500],
				['2027-01-15', 500],
			]);
			expect(view(result, 'inv-q').after).toMatchObject({ amount_contract_currency: 1000 });
			expect(result.write.line_creates.every((entry) => entry.state.billing_period_start === '2026-10-01' && entry.state.quantity === 10)).toBe(
				true
			);
			expect(result.continuity.by_item[0].after.overlaps).toEqual([]);
			expect(result.rsm_from_month).toBeNull();
		});

		it('cuotas que no suman la línea → 400; cuotas parejas con residuo en la última', () => {
			expect(
				plan(quarterly(), {
					operations: [{ op: 'split_line', line_id: 'l-q', by: 'installments', installments: [{ amount: 1000 }, { amount: 1000 }] }],
				}).errors[0]
			).toMatchObject({
				field: 'operations.0.installments',
			});
			const even = plan(
				{ invoices: [[invoice('inv-q', '2026-10-01', { amount_contract_currency: 100 }), [line('l-q', '2026-10-01', '2026-12-31', 100)]]] },
				{ operations: [{ op: 'split_line', line_id: 'l-q', by: 'installments', count: 3 }] }
			);

			expect([
				view(even, 'inv-q').after!.amount_contract_currency,
				...even.write.creates.map((entry) => entry.header.amount_contract_currency),
			]).toEqual([33.33, 33.34, 33.33]);
		});

		it('grupo por tramo: las filas del ítem y período se dividen juntas (totales recompuestos por fila)', () => {
			const tier = (index: number, amount: number) => [
				{ kind: 'tier' as const, quantity: 5, amount, label: `Tramo ${index + 1}`, line_index: index, line_count: 2, period_quantity: 10 },
			];
			const fixture: Fixture = {
				invoices: [
					[
						invoice('inv-q', '2026-10-01', { amount_contract_currency: 3000 }),
						[
							line('l-t1', '2026-10-01', '2026-12-31', 2000, { quantity: 5, pricing_breakdown: tier(0, 2000) }),
							line('l-t2', '2026-10-01', '2026-12-31', 1000, { quantity: 5, pricing_breakdown: tier(1, 1000) }),
						],
					],
				],
			};
			const result = plan(fixture, { operations: [{ op: 'split_line', line_id: 'l-t2', by: 'amount', amount: 1200 }] });
			const created = result.write.line_creates;

			expect(codes(result.warnings)).toContain('per_tier_group');
			expect(view(result, 'inv-q').lines.map((entry) => [entry.id, entry.action, entry.after?.subtotal_contract_currency])).toEqual([
				['l-t1', 'split', 800],
				['l-t2', 'split', 400],
			]);
			expect(created.map((entry) => entry.state.subtotal_contract_currency)).toEqual([1200, 600]);
			expect(created[0].state.pricing_breakdown![0]).toMatchObject({ amount: 1200, line_index: 0, period_quantity: 10 });
			expect(
				new Set(
					result.invoices
						.flatMap((entry) => entry.lines)
						.filter((entry) => !entry.id)
						.map((entry) => entry.per_tier_group)
				).size
			).toBe(1);
		});

		it('una línea manual no se re-monta (manual_edit_kept, sin cambios); la glosa protegida se conserva al dividir', () => {
			const manual = plan(
				{ invoices: [[invoice('inv-q', '2026-10-01'), [line('l-q', '2026-10-01', '2026-12-31', 3000, { quantity_source: 'manual' })]]] },
				{ operations: [{ op: 'split_line', line_id: 'l-q', by: 'date', at: '2026-10-31' }] }
			);
			const locked = plan(
				{
					invoices: [
						[
							invoice('inv-q', '2026-10-01'),
							[line('l-q', '2026-10-01', '2026-12-31', 3000, { description: 'SERVICIO OC 123', description_locked: true })],
						],
					],
				},
				{ operations: [{ op: 'split_line', line_id: 'l-q', by: 'date', at: '2026-10-31' }] }
			);

			expect(codes(manual.warnings)).toContain('manual_edit_kept');
			expect(manual.write.line_updates).toEqual([]);
			expect(manual.write.creates).toEqual([]);
			expect(locked.write.line_updates[0].state.description).toBe('SERVICIO OC 123');
			expect(locked.write.line_creates[0].state).toMatchObject({ description: 'SERVICIO OC 123', description_locked: true });
		});

		it('overlaps_issued: una parte no puede cubrir un período ya emitido del mismo ítem', () => {
			const result = plan(
				{
					invoices: [[invoice('inv-q', '2026-10-01'), [line('l-q', '2026-10-01', '2026-12-31', 3000)]]],
					issued: [
						{
							contract_item_id: ITEM,
							billing_period_start: '2026-10-01',
							billing_period_end: '2026-10-31',
							invoice_id: 'inv-old',
							invoice_number: 'F-9',
						},
					],
				},
				{ operations: [{ op: 'split_line', line_id: 'l-q', by: 'date', at: '2026-10-31' }] }
			);

			expect(codes(result.blockers)).toContain('overlaps_issued');
			expect(result.operations[0].ok).toBe(false);
		});
	});

	describe('split_invoice', () => {
		it('las líneas que cruzan el corte se dividen por fecha y las posteriores van a la factura nueva', () => {
			const fixture: Fixture = {
				invoices: [
					[
						invoice('inv-q', '2026-10-01', { amount_contract_currency: 4000 }),
						[
							line('l-q', '2026-10-01', '2026-12-31', 3000),
							line('l-early', '2026-10-01', '2026-10-31', 500, { contract_item_id: ITEM_B }),
							line('l-late', '2026-12-01', '2026-12-31', 500, { contract_item_id: ITEM_B }),
						],
					],
				],
			};
			const result = plan(fixture, { operations: [{ op: 'split_invoice', invoice_id: 'inv-q', cut_date: '2026-11-30' }] });

			expect(result.write.creates[0]).toMatchObject({ issue_date: '2026-12-01', header: { amount_contract_currency: 1510.87 } });
			expect(view(result, 'inv-q').after).toMatchObject({ amount_contract_currency: 2489.13, lines_count: 2 });
			expect(view(result, 'inv-q').lines.find((entry) => entry.id === 'l-late')).toMatchObject({
				action: 'moved',
				after: null,
				to_invoice_key: 'new:1',
			});
		});
	});

	describe('atajos por ítem', () => {
		it('item_monthly: una línea por mes calendario; el tramo de noviembre entra a la Por Emitir de noviembre, diciembre a una nueva', () => {
			const fixture: Fixture = {
				invoices: [
					[invoice('inv-q', '2026-10-01', { amount_contract_currency: 3000 }), [line('l-q', '2026-10-01', '2026-12-31', 3000)]],
					[
						invoice('inv-nov', '2026-11-01', { amount_contract_currency: 200 }),
						[line('l-b', '2026-11-01', '2026-11-30', 200, { contract_item_id: ITEM_B })],
					],
				],
			};
			const result = plan(fixture, { operations: [{ op: 'item_monthly', contract_item_id: ITEM }] });
			const pieces = result.invoices.flatMap((entry) => entry.lines).filter((entry) => entry.after?.contract_item_id === ITEM);

			expect(pieces.map((entry) => [entry.after!.billing_period_start, entry.after!.subtotal_contract_currency, entry.to_invoice_key])).toEqual(
				[
					['2026-10-01', 1010.87, 'inv-q'],
					['2026-11-01', 978.26, 'inv-nov'],
					['2026-12-01', 1010.87, 'new:1'],
				]
			);
			expect(result.write.creates[0].issue_date).toBe('2026-12-01');
			expect(result.continuity.changed).toBe(false);
		});

		it('item_monthly junta tramos contiguos del mismo mes en una sola línea', () => {
			const fixture: Fixture = {
				invoices: [
					[invoice('inv-a', '2026-10-01'), [line('l-a', '2026-10-01', '2026-10-15', 500)]],
					[invoice('inv-b', '2026-10-16'), [line('l-b', '2026-10-16', '2026-10-31', 500)]],
				],
			};
			const result = plan(fixture, { operations: [{ op: 'item_monthly', contract_item_id: ITEM }] });

			expect(view(result, 'inv-a').lines[0]).toMatchObject({
				action: 'updated',
				after: { billing_period_end: '2026-10-31', subtotal_contract_currency: 1000 },
			});
			expect(view(result, 'inv-b')).toMatchObject({ action: 'cancelled' });
			expect(result.write.line_removes).toEqual(['l-b']);
		});

		it('item_unify_pending: todo lo pendiente del ítem en una línea de la primera factura; las demás quedan canceladas', () => {
			const result = plan(monthly(), { operations: [{ op: 'item_unify_pending', contract_item_id: ITEM }] });

			expect(view(result, 'inv-oct').lines[0]).toMatchObject({
				action: 'updated',
				after: {
					billing_period_start: '2026-10-01',
					billing_period_end: '2026-12-31',
					subtotal_contract_currency: 3000,
					quantity: 10,
					unit_price_contract_currency: 300,
				},
			});
			expect(result.write.cancelled.map((entry) => entry.id)).toEqual(['inv-nov', 'inv-dec']);
			expect(result.write.line_removes).toEqual(['l-nov', 'l-dec']);
			expect(result.continuity.changed).toBe(false);
		});

		it('item_unify_pending sobre un período emitido en medio → overlaps_issued', () => {
			const fixture = monthly();

			fixture.invoices.splice(1, 1);
			fixture.issued = [
				{
					contract_item_id: ITEM,
					billing_period_start: '2026-11-01',
					billing_period_end: '2026-11-30',
					invoice_id: 'inv-x',
					invoice_number: 'F-1',
				},
			];
			const result = plan(fixture, { operations: [{ op: 'item_unify_pending', contract_item_id: ITEM }] });

			expect(codes(result.blockers)).toEqual(['overlaps_issued']);
		});

		it('item_even_split sin count: reparte parejo lo pendiente entre sus líneas; con count: cuotas mensuales nuevas', () => {
			const fixture = monthly();

			fixture.invoices[0][1] = [line('l-oct', '2026-10-01', '2026-10-31', 800)];
			fixture.invoices[1][1] = [line('l-nov', '2026-11-01', '2026-11-30', 1300)];
			const even = plan(fixture, { operations: [{ op: 'item_even_split', contract_item_id: ITEM }] });

			expect(even.write.line_updates.map((entry) => [entry.id, entry.state.subtotal_contract_currency])).toEqual([
				['l-oct', 1033.33],
				['l-nov', 1033.34],
				['l-dec', 1033.33],
			]);
			expect(even.continuity.changed).toBe(false);
			const chunks = plan(monthly(), { operations: [{ op: 'item_even_split', contract_item_id: ITEM, count: 2 }] });

			expect(view(chunks, 'inv-oct').lines[0].after).toMatchObject({ billing_period_end: '2026-11-30', subtotal_contract_currency: 1500 });
			expect(view(chunks, 'inv-dec').lines.map((entry) => [entry.action, entry.after?.subtotal_contract_currency ?? null])).toEqual([
				['created', 1500],
				['removed', null],
			]);
			expect(view(chunks, 'inv-nov').action).toBe('cancelled');
			expect(plan(monthly(), { operations: [{ op: 'item_even_split', contract_item_id: ITEM, count: 5 }] }).errors[0].field).toBe(
				'operations.0.count'
			);
		});
	});

	describe('round_fix', () => {
		it('lleva el residuo de centavos del encabezado a la línea mayor: encabezado = Σ líneas, sin motivo', () => {
			const result = plan(
				{
					invoices: [
						[
							invoice('inv-a', '2026-10-01', { amount_contract_currency: 1000.01, amount_invoice_currency: 1000.01 }),
							[line('l-a', '2026-10-01', '2026-10-31', 1000)],
						],
					],
				},
				{ operations: [{ op: 'round_fix', invoice_id: 'inv-a' }] }
			);

			expect(result.write.line_updates[0].state).toMatchObject({ subtotal_contract_currency: 1000.01, unit_price_contract_currency: 100.001 });
			expect(view(result, 'inv-a').after).toMatchObject({ amount_contract_currency: 1000.01 });
			expect(result.continuity.reason_required).toBe(false);
			expect(codes(result.warnings)).not.toContain('rounding_residual_large');
		});

		it('más de una unidad → aviso rounding_residual_large y pide motivo (cambia el total del ítem)', () => {
			const result = plan(
				{ invoices: [[invoice('inv-a', '2026-10-01', { amount_contract_currency: 1005 }), [line('l-a', '2026-10-01', '2026-10-31', 1000)]]] },
				{ operations: [{ op: 'round_fix', invoice_id: 'inv-a' }] }
			);

			expect(codes(result.warnings)).toEqual(expect.arrayContaining(['rounding_residual_large', 'deviation_reason_required']));
			expect(result.continuity).toMatchObject({ changed: true, total_diff: 5, reason_required: true });
			const explained = plan(
				{ invoices: [[invoice('inv-a', '2026-10-01', { amount_contract_currency: 1005 }), [line('l-a', '2026-10-01', '2026-10-31', 1000)]]] },
				{ operations: [{ op: 'round_fix', invoice_id: 'inv-a' }], deviation: { type: 'correction', reason: 'Cuadre con OC' } }
			);

			expect(explained.adjustments).toEqual([{ invoice_key: 'inv-a', amount_diff: 5 }]);
		});

		it('ya cuadra → no_change', () => {
			const result = plan(
				{ invoices: [[invoice('inv-a', '2026-10-01'), [line('l-a', '2026-10-01', '2026-10-31', 1000)]]] },
				{ operations: [{ op: 'round_fix', invoice_id: 'inv-a' }] }
			);

			expect(codes(result.warnings)).toContain('no_change');
			expect(result.write.header_updates).toEqual([]);
		});
	});

	describe('continuidad y desvío', () => {
		it('antes/después por ítem leyendo líneas (emitidas incluidas); heredado si ya se apartaba del plan', () => {
			const fixture = monthly();

			fixture.expected = [[`${ITEM}|2026-09-01`, 1000], ...fixture.expected!];
			fixture.other_lines = [
				{
					invoice_id: 'inv-sep',
					contract_item_id: ITEM,
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					subtotal: 900,
					credit_note: false,
				},
			];
			fixture.items = [item(ITEM, { start_date: '2026-09-01', end_date: '2026-12-31' }), item(ITEM_B)];
			const result = plan(fixture, { operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-nov'] }] });
			const entry = result.continuity.by_item[0];

			expect(entry).toMatchObject({
				contract_item_id: ITEM,
				expected_total: 4000,
				before: { actual_total: 3900, gaps: [] },
				after: { actual_total: 3900 },
				diff: 0,
				inherited: true,
				changed: false,
			});
			expect(entry.by_period.find((period) => period.month === '2026-09')).toEqual({
				month: '2026-09',
				expected: 1000,
				before: 900,
				after: 900,
			});
			expect(codes(result.warnings)).toContain('inherited_gap');
			expect(result.continuity.reason_required).toBe(false);
		});

		it('una operación bloqueada no cambia nada y deja can_apply en false', () => {
			const closed = plan(
				{ ...monthly(), context: { cutoff_date: '2026-10-31' } },
				{ operations: [{ op: 'merge', invoice_ids: ['inv-nov', 'inv-dec'] }] }
			);

			expect(closed.can_apply).toBe(true);
			const blocked = plan(
				{ ...monthly(), context: { cutoff_date: '2026-10-31' } },
				{ operations: [{ op: 'merge', invoice_ids: ['inv-oct', 'inv-nov'] }] }
			);

			expect(codes(blocked.blockers)).toEqual(['period_closed']);
			expect(blocked.write.line_updates).toEqual([]);
		});
	});

	describe('scheduleBoard', () => {
		it('Por Emitir por período con marcas manual / protegida / grupo por tramo / residuo del encabezado', () => {
			const board = scheduleBoard(
				[
					invoice('inv-nov', '2026-11-01', { period_start: '2026-11-01' }),
					invoice('inv-oct', '2026-10-01', { period_start: '2026-10-01', amount_contract_currency: 1000.02 }),
				],
				new Map([
					['inv-oct', [line('l-oct', '2026-10-01', '2026-10-31', 1000, { quantity_source: 'manual', description_locked: true })]],
					[
						'inv-nov',
						[
							line('l-nov', '2026-11-01', '2026-11-30', 1000, {
								pricing_breakdown: [{ kind: 'tier', quantity: 10, amount: 1000, label: 'Tramo 1', line_index: 0, line_count: 1 }],
							}),
						],
					],
				]),
				new Map([[ITEM, item(ITEM)]]),
				context()
			);

			expect(board.map((entry) => entry.id)).toEqual(['inv-oct', 'inv-nov']);
			expect(board[0]).toMatchObject({
				header_residual: 0.02,
				operable: true,
				lines: [expect.objectContaining({ manual: true, locked: true, per_tier_group: null })],
			});
			expect(board[1].lines[0]).toMatchObject({ per_tier_group: `inv-nov|${ITEM}|2026-11-01`, line_index: 0, metered: false });
		});
	});

	describe('auditoría 01-10: el descuento puntual sigue a su línea', () => {
		const oneOff = (amount: number, type: 'amount' | 'pct' = 'amount', value = amount) => [
			{ kind: 'unit', quantity: 10, amount: 1000, label: 'Plataforma' },
			{
				kind: 'discount',
				one_off: true,
				quantity: 1,
				amount: -amount,
				label: 'Descuento puntual: OC',
				one_off_type: type,
				one_off_value: value,
			},
		];
		const fixture = (destinationTreatment: string | null = null): Fixture => ({
			invoices: [
				[
					invoice('inv-oct', '2026-10-05', { nc_revenue_treatment: 'impact_month' }),
					[
						line('l-one', '2026-10-01', '2026-10-31', 900, { pricing_breakdown: oneOff(100) as never }),
						line('l-plain', '2026-10-01', '2026-10-31', 500, { contract_item_id: ITEM_B }),
					],
				],
				[invoice('inv-dec', '2026-12-05', { nc_revenue_treatment: destinationTreatment }), [line('l-dec', '2026-12-01', '2026-12-31', 1000)]],
			],
		});

		it('mover la línea con puntual: el destino toma el devengo, el origen lo pierde, la fila de desvío se mueve y el devengo se rehace desde la emisión más temprana', () => {
			const result = plan(fixture(), { operations: [{ op: 'move_line', line_id: 'l-one', to_invoice_id: 'inv-dec' }] });

			expect(result.blockers).toEqual([]);
			expect(result.write.treatment_updates).toEqual([
				{ invoice_key: 'inv-oct', nc_revenue_treatment: null },
				{ invoice_key: 'inv-dec', nc_revenue_treatment: 'impact_month' },
			]);
			expect(result.write.one_off_moves).toEqual([{ from_invoice_id: 'inv-oct', to_invoice_key: 'inv-dec', share: 1 }]);
			expect(result.rsm_from_month).toBe('2026-10-01');
			expect(result.write.line_updates[0]).toMatchObject({
				id: 'l-one',
				moved: true,
				from_invoice_id: 'inv-oct',
				from_period_start: '2026-10-01',
			});
		});

		it('destino con otro devengo de puntual → revenue_treatment_conflict', () => {
			const result = plan(fixture('defer_forward'), { operations: [{ op: 'move_line', line_id: 'l-one', to_invoice_id: 'inv-dec' }] });

			expect(codes(result.blockers)).toEqual(['revenue_treatment_conflict']);
			expect(result.can_apply).toBe(false);
		});

		it('una parte del puntual: el origen conserva el devengo y la fila de desvío se duplica por la parte', () => {
			const base = fixture();

			base.invoices[0][1][1] = line('l-plain', '2026-10-01', '2026-10-31', 700, {
				contract_item_id: ITEM_B,
				pricing_breakdown: oneOff(300) as never,
			});
			const result = plan(base, { operations: [{ op: 'move_line', line_id: 'l-one', to_invoice_id: 'inv-dec' }] });

			expect(result.write.treatment_updates).toEqual([{ invoice_key: 'inv-dec', nc_revenue_treatment: 'impact_month' }]);
			expect(result.write.one_off_moves).toEqual([{ from_invoice_id: 'inv-oct', to_invoice_key: 'inv-dec', share: 0.25 }]);
		});

		it('dividir una línea escala el valor del puntual en monto (el % se conserva)', () => {
			const amount = scaleBreakdown(oneOff(100) as never, 900, 450)!;
			const pct = scaleBreakdown(oneOff(100, 'pct', 10) as never, 900, 450)!;

			expect(amount[1]).toMatchObject({ amount: -50, one_off_value: 50 });
			expect(pct[1]).toMatchObject({ amount: -50, one_off_value: 10 });
		});
	});
});
