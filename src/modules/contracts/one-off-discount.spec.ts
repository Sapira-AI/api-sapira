import {
	isOneOffSubline,
	itemActiveWindow,
	oneOffAmount,
	oneOffOf,
	oneOffRevenueEffect,
	oneOffSubline,
	telescopicInstallment,
	withoutOneOff,
} from './one-off-discount';
import { type PricedSubline, pricingGlosa, splitInvoiceLines } from './pricing-engine';

/**
 * Réplica en TS de `nc_discount_revenue_adjustment` para la vista previa del descuento puntual (spec facturas §3.4): cada caso mira la
 * misma regla que el SQL (partes iguales con redondeo telescópico, meses del período de servicio, diferir desde el mes de emisión hasta el
 * fin activo del ítem, degenerar a impact_month).
 */
describe('descuento puntual: sublínea y devengo', () => {
	const items = new Map([
		['item-1', { start_date: '2026-01-15', end_date: '2026-12-31', term_months: 12 }],
		['item-2', { start_date: '2026-01-01', end_date: null, term_months: null }],
	]);

	it('la sublínea one_off se agrega al desglose, se reconoce, se quita y no entra en la glosa ni genera fila por tramo', () => {
		const subline = oneOffSubline(100, 'Promo', { type: 'pct', value: 10 }, 5);
		const tier: PricedSubline = { kind: 'tier', tier_index: 0, from: 1, to: null, quantity: 10, unit_amount: 10, amount: 100, label: 'Tramo 1' };

		expect(subline).toEqual({
			kind: 'discount',
			one_off: true,
			quantity: 1,
			amount: -100,
			label: 'Descuento puntual: Promo',
			one_off_type: 'pct',
			one_off_value: 10,
			base_discount_pct: 5,
		});
		expect(isOneOffSubline(subline)).toBe(true);
		expect(isOneOffSubline({ kind: 'discount', amount: -5 })).toBe(false);
		expect(oneOffOf([tier, subline])).toMatchObject({ total: -100, one_off_type: 'pct' });
		expect(withoutOneOff([tier, subline])).toEqual([tier]);
		expect(withoutOneOff([subline])).toBeNull();
		expect(pricingGlosa({ breakdown: [tier, subline] })).not.toContain('descuento');
		expect(
			splitInvoiceLines({
				quantity: 10,
				quantity_source: 'fixed',
				billable_quantity: 10,
				subtotal: 100,
				effective_unit_price: 10,
				breakdown: [tier, subline],
				warnings: [],
			})
		).toHaveLength(1);
		expect(oneOffAmount({ type: 'pct', value: 12.5 }, 999.99)).toBe(125);
		expect(oneOffAmount({ type: 'amount', value: 33.333 }, 999.99)).toBe(33.33);
	});

	it('cuotas telescópicas: suman exacto el monto (como ROUND(a·k/n,2) − ROUND(a·(k−1)/n,2))', () => {
		const parts = [1, 2, 3].map((k) => telescopicInstallment(-100, k, 3));

		expect(parts).toEqual([-33.33, -33.34, -33.33]);
		expect(parts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(-100, 10);
	});

	it('ventana activa del ítem: fin por plazo o por fecha (el menor); sin fin → null', () => {
		expect(itemActiveWindow({ start_date: '2026-01-15', end_date: '2026-12-31', term_months: 12 })).toEqual({
			start_month: '2026-01-01',
			active_end_month: '2026-12-01',
		});
		expect(itemActiveWindow({ start_date: '2026-01-15', end_date: '2027-06-30', term_months: 6 })).toEqual({
			start_month: '2026-01-01',
			active_end_month: '2026-06-01',
		});
		expect(itemActiveWindow({ start_date: '2026-01-01', end_date: null, term_months: null }).active_end_month).toBeNull();
	});

	it('service_period: partes iguales en los meses calendario del período de servicio de la línea; sin período → impact_month', () => {
		const quarter = oneOffRevenueEffect(
			[{ contract_item_id: 'item-1', amount: -100, billing_period_start: '2026-10-01', billing_period_end: '2026-12-31' }],
			'service_period',
			'2026-10-05',
			items
		);

		expect(quarter).toEqual({
			treatment: 'service_period',
			total: -100,
			by_month: [
				{ month: '2026-10-01', amount: -33.33 },
				{ month: '2026-11-01', amount: -33.34 },
				{ month: '2026-12-01', amount: -33.33 },
			],
		});
		const noPeriod = oneOffRevenueEffect(
			[{ contract_item_id: 'item-1', amount: -50, billing_period_start: null, billing_period_end: null }],
			'service_period',
			'2026-10-05',
			items
		);

		expect(noPeriod.by_month).toEqual([{ month: '2026-10-01', amount: -50 }]);
	});

	it('impact_month: todo al mes de emisión de la factura', () => {
		const effect = oneOffRevenueEffect(
			[
				{ contract_item_id: 'item-1', amount: -60, billing_period_start: '2026-10-01', billing_period_end: '2026-12-31' },
				{ contract_item_id: 'item-2', amount: -40, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31' },
			],
			'impact_month',
			'2026-11-20',
			items
		);

		expect(effect).toEqual({ treatment: 'impact_month', total: -100, by_month: [{ month: '2026-11-01', amount: -100 }] });
	});

	it('defer_forward: desde el mes de emisión hasta el fin activo del ítem (nunca antes); sin fin o fuera de la ventana → impact_month', () => {
		const deferred = oneOffRevenueEffect(
			[{ contract_item_id: 'item-1', amount: -90, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31' }],
			'defer_forward',
			'2026-10-10',
			items
		);

		expect(deferred.by_month).toEqual([
			{ month: '2026-10-01', amount: -30 },
			{ month: '2026-11-01', amount: -30 },
			{ month: '2026-12-01', amount: -30 },
		]);
		const indefinite = oneOffRevenueEffect(
			[{ contract_item_id: 'item-2', amount: -90, billing_period_start: '2026-10-01', billing_period_end: '2026-10-31' }],
			'defer_forward',
			'2026-10-10',
			items
		);

		expect(indefinite.by_month).toEqual([{ month: '2026-10-01', amount: -90 }]);
		const late = oneOffRevenueEffect(
			[{ contract_item_id: 'item-1', amount: -90, billing_period_start: '2027-01-01', billing_period_end: '2027-01-31' }],
			'defer_forward',
			'2027-02-01',
			items
		);

		expect(late.by_month).toEqual([{ month: '2027-02-01', amount: -90 }]);
		expect(oneOffRevenueEffect([], null, '2026-10-01', items)).toEqual({ treatment: null, total: 0, by_month: [] });
	});
});
