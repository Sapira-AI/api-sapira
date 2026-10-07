import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { type ChangeInvoiceRow, type ChangePlan, planChange } from './contract-changes';
import { context, contractRow, invoiceRow, itemRow, PRODUCT_NUEVO, request } from './contract-changes.test-fixtures';
import { cycleAlignedEnd, endOffCycleCause, invoicesVsTotalSummary, lastPartialPeriod, withDeviationCauses } from './end-off-cycle';

import type { PreviewLine } from './billing-engine';
import type { DeviationView } from './invoice-edit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const fields = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(BadRequestException);

		return fieldErrorsOf(error)!.map((entry) => entry.field);
	}
	throw new Error('se esperaba un 400');
};

/** Caso S02762 (SimpliRoute, 07-10): ciclo 21 → 20; el upsell parte el 01-08-2026 y termina el 31-07-2027, a mitad de ciclo. */
const UPSELL = '44444444-4444-4444-8444-444444444444';
const BASE = '55555555-5555-4555-8555-555555555555';
const upsell = (overrides: Partial<ReturnType<typeof itemRow>> = {}) =>
	itemRow({
		id: UPSELL,
		product_id: PRODUCT_NUEVO,
		product_name: 'Ruteo',
		categoria: 'NEW',
		quantity: 1,
		unit_price: 2640,
		annual_unit_price: 31680,
		monthly_price: 2640,
		billing_period_price: 2640,
		price: 31680,
		final_price: 31680,
		term_months: 12,
		start_date: '2026-08-01',
		end_date: '2027-07-31',
		booking_date: '2026-08-01',
		...overrides,
	});
/** Factura del ítem con una línea `[start, end]` por `subtotal` (Por Emitir salvo que se diga otra cosa). */
const invoiceOf = (id: string, start: string, end: string, subtotal: number, overrides: Partial<ChangeInvoiceRow> = {}): ChangeInvoiceRow => {
	const base = invoiceRow('10');

	return {
		...base,
		id,
		invoice_number: null,
		status: 'Por Emitir',
		issue_date: start,
		due_date: start,
		subtotal,
		vat: Math.round(subtotal * 19) / 100,
		amount_invoice: subtotal,
		total_invoice: subtotal,
		lines: [
			{
				...base.lines[0],
				id: `line-${id}`,
				invoice_id: id,
				contract_item_id: UPSELL,
				product_id: PRODUCT_NUEVO,
				description: `Ruteo - Periodo ${start} a ${end}`,
				quantity: 1,
				unit_price: subtotal,
				unit_price_invoice: subtotal,
				subtotal,
				subtotal_invoice: subtotal,
				tax_amount: 0,
				tax_amount_invoice: 0,
				total: subtotal,
				total_invoice: subtotal,
				billing_period_start: start,
				billing_period_end: end,
			},
		],
		...overrides,
	};
};
const s02762 = (item = upsell(), invoices: ChangeInvoiceRow[] = []) =>
	context({
		contract: contractRow({ billing_anchor_day: 21, contract_end_date: item.end_date, total_value: Number(item.final_price) }),
		items: [item],
		invoices: [
			invoiceOf('pe-2027-06', '2027-06-21', '2027-07-20', 2640),
			// Heredada del front viejo: cobra el mes completo del último tramo (el motor espera 11 de 31 días).
			invoiceOf('pe-2027-07', '2027-07-21', '2027-07-31', 2640),
			...invoices,
		],
	});
const moveEnd = (ctx: ReturnType<typeof context>, end: string, extra: Record<string, unknown> = {}, itemId = UPSELL) =>
	planChange(
		ctx,
		request({ type: 'item_update', items: [{ item_id: itemId, end_date: end, ...extra }] } as never, { effective_date: '2026-10-07' })
	);
const shape = (item: ReturnType<typeof upsell>) => ({
	start_date: item.start_date!,
	end_date: item.end_date,
	term_months: Number(item.term_months),
	billing_frequency: item.billing_frequency ?? 'Mensual',
	billing_method: item.billing_method ?? 'Anticipado',
	billing_anchor_day: null,
});

describe('fin fuera de ciclo (caso S02762, decisión 07-10: el prorrateo solo va en el primer mes)', () => {
	it('cycleAlignedEnd: ciclo 21, ítem 01-08-2026 → 31-07-2027 → sugiere el 20-07-2027; un fin que ya calza no sugiere nada', () => {
		expect(cycleAlignedEnd(shape(upsell()), 21)).toBe('2027-07-20');
		expect(lastPartialPeriod(shape(upsell()), 21)).toEqual({ period_start: '2027-07-21', period_end: '2027-07-31', months: 11 / 31, days: 11 });
		expect(cycleAlignedEnd(shape(upsell({ end_date: '2027-07-20' })), 21)).toBeNull();
		// Ciclo 1 (calendario): el 31-07 ya es fin de ciclo.
		expect(cycleAlignedEnd(shape(upsell()), 1)).toBeNull();
		// Sin fin, o con un solo período (el tramo inicial), no hay nada que alinear.
		expect(cycleAlignedEnd(shape(upsell({ end_date: null })), 21)).toBeNull();
		expect(cycleAlignedEnd(shape(upsell({ end_date: '2026-08-10' })), 21)).toBeNull();
	});

	it('endOffCycleCause: el último período parcial cobrado de más explica el desvío; otros períodos o cobros de menos, no', () => {
		const row = { contract_item_id: UPSELL, product_name: 'Ruteo', period_start: '2027-07-21', expected: 936.77, actual: 2640, diff: 1703.23 };

		expect(endOffCycleCause(row, shape(upsell()), 21)).toEqual({
			code: 'end_off_cycle',
			item_id: UPSELL,
			product_name: 'Ruteo',
			item_end: '2027-07-31',
			cycle_day: 21,
			suggested_end: '2027-07-20',
			period_start: '2027-07-21',
			period_end: '2027-07-31',
			plan_amount: 936.77,
			invoice_amount: 2640,
			days: 11,
			line: null,
		});
		expect(endOffCycleCause({ ...row, period_start: '2027-06-21' }, shape(upsell()), 21)).toBeNull();
		expect(endOffCycleCause({ ...row, actual: 500, diff: -436.77 }, shape(upsell()), 21)).toBeNull();
		expect(endOffCycleCause(row, shape(upsell()), 21, { churned: true })).toBeNull();
	});

	it('withDeviationCauses: causa por ítem y de la factura con la línea a reescribir; un desvío sin causa conocida deja la causa en null', () => {
		const deviation: DeviationView = {
			has_deviation: true,
			total_diff: 1703.23,
			by_item: [
				{
					contract_item_id: UPSELL,
					product_name: 'Ruteo',
					period_start: '2027-07-21',
					period_end: '2027-07-31',
					expected: 936.77,
					actual: 2640,
					diff: 1703.23,
				},
			],
			inherited: true,
			changed: false,
			currency: 'MXN',
		};
		const line = {
			id: 'line-1',
			contract_item_id: UPSELL,
			quantity: 1,
			unit_price: 2640,
			discount_pct: 0,
			billing_period_start: '2027-07-21',
			billing_period_end: '2027-07-31',
		};
		const ctx = { items: new Map([[UPSELL, { item: { ...shape(upsell()), is_recurring: true }, churned: false }]]), anchor: 21 } as never;
		const result = withDeviationCauses(deviation, [line], ctx);

		expect(result.cause).toMatchObject({
			code: 'end_off_cycle',
			suggested_end: '2027-07-20',
			line: { id: 'line-1', quantity: 1, unit_price: 2640, billing_period_start: '2027-07-21', billing_period_end: '2027-07-31' },
		});
		expect(result.deviation.by_item[0].cause?.code).toBe('end_off_cycle');
		const unknown = withDeviationCauses({ ...deviation, by_item: [{ ...deviation.by_item[0], period_start: '2027-06-21' }] }, [line], ctx);

		expect(unknown.cause).toBeNull();
		expect(unknown.deviation.by_item[0].cause).toBeNull();
	});

	it('invoicesVsTotalSummary: la diferencia de "las facturas suman" la explican los desvíos si es la misma suma', () => {
		const rows = [{ deviation: { total_diff: 1703.23 } }, { deviation: { total_diff: 1703.23 } }];

		expect(invoicesVsTotalSummary({ invoices_count: 12, invoiced_total: 33086.46, total_value: 29680 }, rows)).toEqual({
			difference: 3406.46,
			deviations_total: 3406.46,
			explained_by_deviations: true,
		});
		expect(invoicesVsTotalSummary({ invoices_count: 12, invoiced_total: 35000, total_value: 29680 }, rows).explained_by_deviations).toBe(false);
		expect(invoicesVsTotalSummary({ invoices_count: 12, invoiced_total: 29680, total_value: 29680 }, []).explained_by_deviations).toBe(false);
	});
});

describe('item_update · corregir la fecha de fin (caso S02762, decisión 07-10)', () => {
	it('mover el fin al 20-07-2027 quita la Por Emitir del 21-07 → 31-07 (queda vacía y se cancela); el resto no se toca', () => {
		const plan = moveEnd(s02762(), '2027-07-20');

		expect(plan.preview.can_apply).toBe(true);
		const [update] = ops(plan, 'update_item');

		expect(update).toMatchObject({ item_id: UPSELL, set: { end_date: '2027-07-20', term_months: 12 } });
		// 11 meses + 20/31 de 2.640 (antes 12 meses: 20/31 + 11 + 11/31).
		expect(update.set.final_price).toBeCloseTo(2640 * (11 + 20 / 31), 1);
		expect(ops(plan, 'delete_line')).toEqual([{ kind: 'delete_line', invoice_id: 'pe-2027-07', line_id: 'line-pe-2027-07' }]);
		expect(ops(plan, 'create_invoices')).toEqual([]);
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['pe-2027-07']);
		expect(plan.preview.contract.after.end_date).toBe('2027-07-20');
		expect(plan.event).toMatchObject({
			type: 'ITEM_CORRECTED',
			subtype: 'end',
			description: '"Ruteo": fecha de fin 2027-07-31 → 2027-07-20',
			metadata: expect.objectContaining({
				items: [{ item_id: UPSELL, product_name: 'Ruteo', changes: [{ field: 'end_date', before: '2027-07-31', after: '2027-07-20' }] }],
			}),
		});
		expect(plan.preview.rsm).toMatchObject({ first_month: '2026-08-01', momentum: 'ITEM_CORRECTED' });
	});

	it('acortar a mitad de un período rehace esa Por Emitir hasta el nuevo fin, prorrateada como el motor', () => {
		const item = upsell({ end_date: '2027-08-20', term_months: 13, price: 33383.23, final_price: 33383.23 });
		const ctx = context({
			contract: contractRow({ billing_anchor_day: 21 }),
			items: [item],
			invoices: [invoiceOf('pe-2027-06', '2027-06-21', '2027-07-20', 2640), invoiceOf('pe-2027-07', '2027-07-21', '2027-08-20', 2640)],
		});
		const plan = moveEnd(ctx, '2027-07-31');

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'delete_line')).toEqual([{ kind: 'delete_line', invoice_id: 'pe-2027-07', line_id: 'line-pe-2027-07' }]);
		const lines = ops(plan, 'create_invoices').flatMap((op) => op.invoices.flatMap((invoice: { lines: PreviewLine[] }) => invoice.lines));

		// 21-07 → 31-07: 11 de 31 días de 2.640.
		expect(lines.map((line: PreviewLine) => [line.billing_period_start, line.billing_period_end, line.subtotal])).toEqual([
			['2027-07-21', '2027-07-31', 936.77],
		]);
	});

	it('alargar el fin genera los períodos que faltan con el generador (el tramo nuevo prorrateado como el motor)', () => {
		const item = upsell({ end_date: '2027-07-20', price: 30743.23, final_price: 30743.23 });
		const ctx = context({
			contract: contractRow({ billing_anchor_day: 21 }),
			items: [item],
			invoices: [invoiceOf('pe-2027-06', '2027-06-21', '2027-07-20', 2640)],
		});
		const plan = moveEnd(ctx, '2027-07-31');

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'delete_line')).toEqual([]);
		const lines = ops(plan, 'create_invoices').flatMap((op) => op.invoices.flatMap((invoice: { lines: PreviewLine[] }) => invoice.lines));

		expect(lines.map((line: PreviewLine) => [line.billing_period_start, line.billing_period_end, line.subtotal])).toEqual([
			['2027-07-21', '2027-07-31', 936.77],
		]);
	});

	it('bloquea si queda una emitida vigente del ítem después del nuevo fin: hay que anularla con NC primero', () => {
		const ctx = s02762(upsell(), []);

		ctx.invoices = [
			invoiceOf('pe-2027-06', '2027-06-21', '2027-07-20', 2640),
			invoiceOf('f-2027-07', '2027-07-21', '2027-07-31', 2640, { status: 'Emitida', invoice_number: 'F-0777' }),
		];
		const plan = moveEnd(ctx, '2027-07-20');

		expect(plan.preview.can_apply).toBe(false);
		expect(plan.preview.blockers).toEqual([
			{
				code: 'issued_invoice_after_end',
				message: 'Anula con nota de crédito la factura F-0777 antes de mover el fin: cobra "Ruteo" después del 2027-07-20',
				next_step: 'Anúlala desde su vista rápida con una nota de crédito, sin reemitir, y vuelve a corregir la fecha',
			},
		]);
		// Anulada con NC: ya no cuenta.
		ctx.invoices[1] = { ...ctx.invoices[1], voided: true };
		expect(moveEnd(ctx, '2027-07-20').preview.can_apply).toBe(true);
	});

	it('los ajustes vivos que terminaban con el ítem siguen terminando con él', () => {
		const base = upsell({ id: BASE, product_name: 'Plan base' });
		const child = upsell({ categoria: 'UPSELL', related_item_id: BASE, product_name: 'Ruteo' });
		const ctx = context({
			contract: contractRow({ billing_anchor_day: 21 }),
			items: [base, child],
			invoices: [invoiceOf('pe-2027-07', '2027-07-21', '2027-07-31', 2640)],
		});
		const plan = moveEnd(ctx, '2027-07-20', {}, BASE);

		expect(ops(plan, 'update_item').map((op) => [op.item_id, op.set.end_date])).toEqual([
			[BASE, '2027-07-20'],
			[UPSELL, '2027-07-20'],
		]);
		expect(plan.preview.invoices.cancelled.map((invoice) => invoice.id)).toEqual(['pe-2027-07']);
		expect(plan.event.metadata).toMatchObject({ aligned_adjustments: [{ item_id: UPSELL, product_name: 'Ruteo' }] });
		expect(plan.event.items_affected).toEqual([BASE, UPSELL]);
	});

	it('valida: fecha real, ≥ inicio, sola (sin inicio ni valor en el mismo paso), ítem con fin y un ajuste no termina después que su original', () => {
		expect(fields(() => moveEnd(s02762(), '2027-02-30'))).toEqual(['change.items.0.end_date']);
		expect(fields(() => moveEnd(s02762(), '2026-07-31'))).toEqual(['change.items.0.end_date']);
		expect(fields(() => moveEnd(s02762(), '2027-07-20', { start_date: '2026-08-21' }))).toEqual(['change.items']);
		expect(fields(() => moveEnd(s02762(), '2027-07-20', { quantity: 2 }))).toEqual(['change.items']);
		expect(fields(() => moveEnd(s02762(upsell({ end_date: null })), '2027-07-20'))).toEqual(['change.items.0.end_date']);
		expect(fields(() => moveEnd(s02762(upsell({ churn_date: '2027-03-01' })), '2027-07-20'))).toEqual(['change.items.0.end_date']);
		const base = upsell({ id: BASE, end_date: '2027-07-20' });
		const child = upsell({ categoria: 'UPSELL', related_item_id: BASE, end_date: '2027-07-20' });

		expect(
			fields(() => moveEnd(context({ contract: contractRow({ billing_anchor_day: 21 }), items: [base, child], invoices: [] }), '2027-07-31'))
		).toEqual(['change.items.0.end_date']);
		const closed = moveEnd({ ...s02762(), contract: contractRow({ billing_anchor_day: 21, cutoff_date: '2027-07-31' }) }, '2027-07-20');

		expect(closed.preview.blockers.map((blocker) => blocker.code)).toEqual(['period_closed']);
	});
});
