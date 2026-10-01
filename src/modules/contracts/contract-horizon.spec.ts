import { HORIZON_EXTENDED, horizonEndOf, planHorizonExtension } from './contract-changes';
import { context, invoiceRow, itemRow, LICENCIA, soporteRow } from './contract-changes.test-fixtures';

import type { ChangeInvoiceRow } from './contract-changes';

/** Licencia sin término (sin plazo ni fin) desde el 01-01-2026; Soporte termina el 31-12-2026. Hoy = 28-09-2026. */
const openEnded = () => itemRow({ term_months: null, end_date: null });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ops = (plan: ReturnType<typeof planHorizonExtension>, kind: string): any[] => (plan?.ops ?? []).filter((op) => op.kind === kind);

describe('contracts-extend-horizon: ítems sin término con 12 períodos por delante (decisión 01-10)', () => {
	it('el horizonte es el fin del período 12 contado desde el que contiene hoy (sep-2026 → ago-2027)', () => {
		expect(horizonEndOf(openEnded(), 1, '2026-09-28')).toBe('2027-08-31');
		expect(horizonEndOf(openEnded(), 1, '2026-09-01')).toBe('2027-08-31');
		expect(horizonEndOf(itemRow({ term_months: null, end_date: null, billing_frequency: 'Trimestral' }), 1, '2026-09-28')).toBe('2029-06-30');
	});

	it('genera solo hacia adelante desde el último día facturado (ene–ago 2027), sin tocar ítems ni devengo; evento HORIZON_EXTENDED', () => {
		const plan = planHorizonExtension(context({ items: [openEnded(), soporteRow()] }))!;
		const [create] = ops(plan, 'create_invoices');

		expect(create.invoices.map((invoice: { billing_period_start: string }) => invoice.billing_period_start)).toEqual([
			'2027-01-01',
			'2027-02-01',
			'2027-03-01',
			'2027-04-01',
			'2027-05-01',
			'2027-06-01',
			'2027-07-01',
			'2027-08-01',
		]);
		expect(create.invoices[0].lines).toEqual([expect.objectContaining({ item_key: LICENCIA, quantity: 10, subtotal: 1000 })]);
		expect(create.merge_into.every((target: string | null) => target === null)).toBe(true);
		expect(ops(plan, 'insert_item')).toEqual([]);
		expect(ops(plan, 'update_item')).toEqual([]);
		expect(ops(plan, 'update_contract')).toEqual([]);
		expect(plan.event).toMatchObject({
			type: HORIZON_EXTENDED,
			rsm_from_month: null,
			items_affected: [LICENCIA],
			metadata: expect.objectContaining({
				job: 'contracts-extend-horizon',
				horizon_until: '2027-08-31',
				items: [{ item_id: LICENCIA, product_name: 'Licencia', from: '2027-01-01', until: '2027-08-31' }],
			}),
		});
		expect(plan.preview.invoices.created).toHaveLength(8);
	});

	it('idempotente: con el horizonte cubierto no hace nada; nunca rellena huecos ni períodos cancelados', () => {
		const covered = [
			...context().invoices,
			invoiceRow('12', {
				id: 'inv-h',
				lines: [{ ...invoiceRow('12').lines[0], id: 'line-h', billing_period_start: '2027-08-01', billing_period_end: '2027-08-31' }],
			}),
		];

		expect(planHorizonExtension(context({ items: [openEnded(), soporteRow()], invoices: covered }))).toBeNull();
		// Octubre cancelado a propósito: no vuelve (solo se extiende desde el último día facturado).
		const withHole = context().invoices.map(
			(invoice): ChangeInvoiceRow => (invoice.id === 'inv-10' ? { ...invoice, status: 'Cancelada' } : invoice)
		);
		const plan = planHorizonExtension(context({ items: [openEnded(), soporteRow()], invoices: withHole }))!;

		expect(ops(plan, 'create_invoices')[0].invoices[0].billing_period_start).toBe('2027-01-01');
	});

	it('se suma a la Por Emitir del mes (mergeTarget) y omite ítems con churn, renovados, espejos o con pausa abierta', () => {
		const january = invoiceRow('01', {
			id: 'inv-2027-01',
			invoice_number: null,
			status: 'Por Emitir',
			issue_date: '2027-01-01',
			lines: [{ ...invoiceRow('01').lines[1], id: 'line-x', billing_period_start: '2027-01-01', billing_period_end: '2027-01-31' }],
		});
		const merged = planHorizonExtension(context({ items: [openEnded(), soporteRow()], invoices: [...context().invoices, january] }))!;

		expect(ops(merged, 'create_invoices')[0].merge_into[0]).toBe('inv-2027-01');
		expect(
			planHorizonExtension(context({ items: [itemRow({ term_months: null, end_date: null, churn_date: '2026-10-01' }), soporteRow()] }))
		).toBeNull();
		expect(
			planHorizonExtension(context({ items: [itemRow({ term_months: null, end_date: null, renewed_by_item_id: 'x' }), soporteRow()] }))
		).toBeNull();
		expect(
			planHorizonExtension(
				context({
					items: [openEnded(), soporteRow()],
					pauses: [
						{
							id: 'p-1',
							contract_item_id: LICENCIA,
							pause_start: '2026-10-01',
							pause_end: null,
							status: 'active',
							extend_term: false,
							reason: null,
						},
					],
				})
			)
		).toBeNull();
		// Con plazo o fin no es "sin término".
		expect(planHorizonExtension(context())).toBeNull();
	});
});
