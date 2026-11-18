/**
 * Corregir el modelo de precio mal cargado (`item_update` con `price`). Caso real: SimpliRoute CTR-2026-425Bolivia (13-11): un único
 * ítem PATHFINDER+ 8 × 19 USD, Expansión (UPSELL) sin ítem base, mensual vencido de 01-03-2026 a 28-02-2027, cargado con cantidad fija
 * cuando era por consumo. Sus 12 facturas están Por Emitir. `price_model_change` dejaba marzo con cantidad fija (corta en el 2º
 * período): la corrección reescribe el ítem en su lugar desde su inicio.
 */
import { type ChangeContext, type ChangeInvoiceRow, type ChangePlan, planChange } from './contract-changes';
import { context, contractRow, invoiceRow, itemRow, request } from './contract-changes.test-fixtures';

const ITEM = '261cef33-17d7-4ec0-8bbf-fde06a1a3169';
const METRIC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const metered = { model: 'standard', quantity_type: 'metered', unit_amount: 19, billable_metric_id: METRIC };
const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const nextMonth = (ym: string) => {
	const date = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1));

	return date.toISOString().slice(0, 10);
};

/** Factura vencida del período `ym` (se emite el 1 del mes siguiente) con la línea fija 8 × 19. */
const pendingInvoice = (ym: string, overrides: Partial<ChangeInvoiceRow> = {}): ChangeInvoiceRow => {
	const base = invoiceRow('10');

	return {
		...base,
		id: `inv-${ym}`,
		invoice_number: null,
		status: 'Por Emitir',
		issue_date: nextMonth(ym),
		due_date: nextMonth(ym),
		contract_currency: 'USD',
		invoice_currency: 'USD',
		tax_rate: 0,
		subtotal: 152,
		vat: 0,
		amount_invoice: 152,
		total_invoice: 152,
		lines: [
			{
				...base.lines[0],
				id: `line-${ym}`,
				invoice_id: `inv-${ym}`,
				contract_item_id: ITEM,
				description: `PATHFINDER+ ${ym}`,
				quantity: 8,
				unit_price: 19,
				unit_price_invoice: 19,
				subtotal: 152,
				subtotal_invoice: 152,
				tax_amount: 0,
				tax_amount_invoice: 0,
				total: 152,
				total_invoice: 152,
				billing_period_start: `${ym}-01`,
				billing_period_end: `${ym}-${String(lastDay(ym)).padStart(2, '0')}`,
				unit_of_measure: 'Vehículo',
			},
		],
		...overrides,
	};
};
const bolivia = (overrides: Partial<ChangeContext> = {}): ChangeContext =>
	context({
		contract: contractRow({
			contract_number: 'CTR-2026-425Bolivia',
			contract_currency: 'USD',
			invoice_currency: 'USD',
			system_currency: 'USD',
			company_currency: 'USD',
			billing_anchor_day: null,
			contract_end_date: '2027-02-28',
			total_value: 1824,
			company: { ...contractRow().company, country: 'Bolivia', tax_rate: '0', currency: 'USD' },
		}),
		items: [
			itemRow({
				id: ITEM,
				product_name: 'PATHFINDER+',
				categoria: 'UPSELL',
				related_item_id: null,
				item_type: 'Variable',
				unit_of_measure: 'Vehículo',
				quantity: 8,
				unit_price: 19,
				annual_unit_price: 228,
				monthly_price: 152,
				billing_period_price: 152,
				price: 1824,
				final_price: 1824,
				billing_method: 'Vencido',
				start_date: '2026-03-01',
				end_date: '2027-02-28',
				booking_date: '2026-03-01',
				currency: 'USD',
			}),
		],
		invoices: months.map((ym) => pendingInvoice(ym)),
		billable_metrics: new Map([[METRIC, 'active']]),
		today: '2026-11-13',
		...overrides,
	});
const correction = (item: Record<string, unknown> = {}) =>
	request({ type: 'item_update', items: [{ item_id: ITEM, price: metered, ...item }] } as never, {
		effective_date: '2026-11-13',
		reason: 'Era por consumo',
	});

describe('corregir el modelo de precio mal cargado (Bolivia 13-11)', () => {
	it('de fijo a por unidad (consumo de Vehículos, 19): el ítem se reescribe en su lugar y de marzo a febrero queda por consumo; sin RENEWAL y con MRR 152', () => {
		const plan = planChange(bolivia(), correction());

		expect(plan.preview.blockers).toEqual([]);
		// Sin ítem nuevo ni corte: misma categoría, mismo ítem.
		expect(ops(plan, 'insert_item')).toEqual([]);
		expect(ops(plan, 'update_item')).toEqual([
			{
				kind: 'update_item',
				item_id: ITEM,
				set: expect.objectContaining({ quantity: 8, unit_price: 19, monthly_price: 152, final_price: 1824, billing_method: 'Vencido' }),
			},
		]);
		expect(ops(plan, 'update_item')[0].set).not.toHaveProperty('end_date');
		// Su precio propio del contrato, versión 1 (no tenía).
		expect(ops(plan, 'set_item_price')).toEqual([
			expect.objectContaining({
				item_id: ITEM,
				name: 'PATHFINDER+',
				currency: 'USD',
				version: 1,
				supersedes_price_id: null,
				spec: expect.objectContaining(metered),
			}),
		]);
		// Las 12 Por Emitir pierden su línea fija y reciben la del modelo nuevo, en la misma factura (ninguna se cancela ni se crea otra).
		expect(ops(plan, 'delete_line').map((op) => op.line_id)).toEqual(months.map((ym) => `line-${ym}`));
		const [created] = ops(plan, 'create_invoices');

		expect(created.merge_into).toEqual(months.map((ym) => `inv-${ym}`));
		expect(created.invoices.map((invoice: { billing_period_start: string }) => invoice.billing_period_start)).toEqual(
			months.map((ym) => `${ym}-01`)
		);
		expect(
			created.invoices.every((invoice: { lines: Array<{ item_key: string }> }) => invoice.lines.every((line) => line.item_key === ITEM))
		).toBe(true);
		expect(ops(plan, 'cancel_invoice')).toEqual([]);
		expect(plan.preview.invoices.created).toEqual([]);
		// MRR = base del modelo nuevo (8 × 19): no cambia; devengo desde el inicio.
		expect(plan.preview.rsm?.mrr_delta).toBe(0);
		expect(plan.event).toMatchObject({ type: 'ITEM_CORRECTED', subtype: 'price_model', amount_delta: 0, items_affected: [ITEM] });
		// El historial nombra los modelos con su nombre único: de fijo (cantidad acordada) a por unidad (consumo).
		expect(plan.event.description).toContain('fijo → por unidad');
		expect(plan.event.description).not.toMatch(/estándar/i);
		expect(plan.event.rsm_from_month).toBe('2026-03-01');
		expect(plan.event.metadata.price_model).toMatchObject({
			correction: true,
			from: '2026-03-01',
			quantity_type_before: 'fixed',
			quantity_type_after: 'metered',
			monthly_after: 152,
		});
	});

	it('pasar a consumo exige cobro vencido: un ítem anticipado pide el modo de cobro y con Vencido pasa', () => {
		const advance = bolivia();

		advance.items = advance.items.map((item) => ({ ...item, billing_method: 'Anticipado' }));
		expect(() => planChange(advance, correction())).toThrow();
		const plan = planChange(advance, correction({ billing_method: 'Vencido' }));

		expect(plan.preview.blockers).toEqual([]);
		expect(ops(plan, 'update_item')[0].set.billing_method).toBe('Vencido');
	});

	it('con algo ya emitido se bloquea: lo emitido no se corrige así (va "Cambiar el modelo de precio" desde el período siguiente)', () => {
		const ctx = bolivia();

		ctx.invoices = ctx.invoices.map((invoice) =>
			invoice.id === 'inv-2026-03' ? { ...invoice, status: 'Emitida', invoice_number: 'F-1' } : invoice
		);
		const plan = planChange(ctx, correction());

		expect(plan.preview.blockers.map((blocker) => blocker.code)).toEqual(['issued_invoices_for_item']);
		expect(plan.preview.blockers[0].message).toContain('F-1');
		expect(ops(plan, 'update_item')).toEqual([]);
		expect(ops(plan, 'set_item_price')).toEqual([]);
	});

	it('bloquea con ajustes colgados, período cerrado o ítem ya renovado; el mismo modelo no es una corrección', () => {
		const codes = (ctx: ChangeContext) => planChange(ctx, correction()).preview.blockers.map((blocker) => blocker.code);
		const adjusted = bolivia();
		const closed = bolivia();
		const renewed = bolivia();
		const same = bolivia();

		adjusted.items = [
			...adjusted.items,
			itemRow({ id: 'adj-1', categoria: 'UPSELL', related_item_id: ITEM, start_date: '2026-06-01', end_date: '2027-02-28' }),
		];
		closed.contract = { ...closed.contract, cutoff_date: '2026-03-31' };
		renewed.items = renewed.items.map((item) => ({ ...item, renewed_by_item_id: 'ren-1' }));
		same.items = same.items.map((item) => ({
			...item,
			raw: { price_model: 'standard', price_quantity_type: 'metered', price_unit_amount: 19, price_billable_metric_id: METRIC },
		}));
		expect(codes(adjusted)).toEqual(['item_with_adjustments']);
		expect(codes(closed)).toEqual(['period_closed']);
		expect(codes(renewed)).toEqual(['item_already_renewed']);
		expect(() => planChange(same, correction())).toThrow();
	});

	it('la corrección de valor de siempre (sin price) sigue por su camino', () => {
		const plan = planChange(
			bolivia(),
			request({ type: 'item_update', items: [{ item_id: ITEM, quantity: 9 }] } as never, { effective_date: '2026-11-13' })
		);

		expect(plan.event.subtype).not.toBe('price_model');
		expect(ops(plan, 'set_item_price')).toEqual([]);
	});
});
