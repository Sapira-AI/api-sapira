import { headerChanges, itemChanges, type QuoteItemSnapshot } from './quote-edit-diff';

const item = (overrides: Partial<QuoteItemSnapshot> = {}): QuoteItemSnapshot => ({
	product_id: 'p-1',
	product_name: 'Licencia Pro',
	quantity: 3,
	unit_price: 100,
	annual_unit_price: 1200,
	price_entry_mode: 'monthly',
	discount_value: 0,
	final_price: 3600,
	start_date: '2026-10-01',
	end_date: '2027-09-30',
	term_months: 12,
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	is_recurring: true,
	price_id: null,
	...overrides,
});

describe('quote-edit-diff · encabezado', () => {
	it('solo los campos distintos, con números y fechas normalizados y etiqueta legible para ids', () => {
		const changes = headerChanges(
			{ client_id: 'c-1', valid_until: '2026-10-01', total_amount: '2160.00', notes: '', currency: 'USD', requires_multicurrency: false },
			{ client_id: 'c-2', valid_until: '2026-10-01', total_amount: 2160, notes: 'nueva', currency: 'USD', requires_multicurrency: true },
			{ client_id: { before: 'ACME', after: 'Globex' } }
		);

		expect(changes).toEqual([
			{ field: 'client_id', label: 'Cliente', before: 'c-1', after: 'c-2', before_label: 'ACME', after_label: 'Globex' },
			{ field: 'notes', label: 'Notas', before: null, after: 'nueva' },
			{ field: 'requires_multicurrency', label: 'Requiere multimoneda', before: false, after: true },
		]);
	});
});

describe('quote-edit-diff · ítems', () => {
	it('cambiado (cantidad y precio con antes/después), agregado y quitado', () => {
		const before = new Map([
			['i-1', item({ quantity: '3' as unknown as number, unit_price: 100 })],
			['i-2', item({ product_id: 'p-2', product_name: 'Soporte', quantity: 1 })],
		]);
		const changes = itemChanges(before, [
			{ id: 'i-1', snapshot: item({ quantity: 5, unit_price: 120, final_price: 7200 }) },
			{ id: 'i-3', snapshot: item({ product_id: 'p-3', product_name: 'Onboarding', is_recurring: false }) },
		]);

		expect(changes[0]).toEqual({
			action: 'changed',
			item_id: 'i-1',
			product_name: 'Licencia Pro',
			changes: [
				{ field: 'quantity', label: 'Cantidad', before: 3, after: 5 },
				{ field: 'unit_price', label: 'Precio', before: 100, after: 120 },
				{ field: 'final_price', label: 'Total línea', before: 3600, after: 7200 },
			],
		});
		expect(changes[1]).toMatchObject({ action: 'added', item_id: 'i-3', product_name: 'Onboarding' });
		expect(changes[1].changes[0]).toEqual({
			field: 'product_id',
			label: 'Producto',
			before: null,
			after: 'p-3',
			before_label: null,
			after_label: 'Onboarding',
		});
		expect(changes[2]).toMatchObject({ action: 'removed', item_id: 'i-2', product_name: 'Soporte' });
		expect(changes[2].changes.every((change) => change.after === null)).toBe(true);
	});

	it('sin diferencias no hay cambio; en modo anual compara el precio anual y no el mensual derivado; cambio de producto con nombres', () => {
		expect(itemChanges(new Map([['i-1', item()]]), [{ id: 'i-1', snapshot: item() }])).toEqual([]);
		const annual = itemChanges(new Map([['i-1', item({ price_entry_mode: 'annual', unit_price: 100.0001 })]]), [
			{ id: 'i-1', snapshot: item({ price_entry_mode: 'annual', unit_price: 125, annual_unit_price: 1500 }) },
		]);

		expect(annual[0].changes.map((change) => change.field)).toEqual(['annual_unit_price']);
		const product = itemChanges(new Map([['i-1', item()]]), [{ id: 'i-1', snapshot: item({ product_id: 'p-9', product_name: 'Plan Plus' }) }]);

		expect(product[0].changes[0]).toMatchObject({ field: 'product_id', before_label: 'Licencia Pro', after_label: 'Plan Plus' });
	});
});
