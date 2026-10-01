import { itemsIncomplete, quoteTotals, resolveQuoteItems } from './quote-items';

import type { CreateQuoteItemDto } from './dtos/create-quote.dto';

const PRODUCT = '44444444-4444-4444-8444-444444444444';
const base = (overrides: Partial<CreateQuoteItemDto> = {}): CreateQuoteItemDto =>
	({
		product_id: PRODUCT,
		item_type: 'Licencias',
		quantity: 2,
		unit_price: 100,
		discount_value: 10,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		start_date: '2026-10-01',
		term_months: 12,
		is_recurring: true,
		...overrides,
	}) as CreateQuoteItemDto;
const products = new Map([[PRODUCT, 'Licencia Pro']]);

describe('resolveQuoteItems', () => {
	it('standard fijo: precio = unitario × cantidad × plazo, final con descuento %, mensual, período y fin = inicio + plazo − 1 día', () => {
		const [item] = resolveQuoteItems([base()], products);

		expect(item).toMatchObject({
			product_name: 'Licencia Pro',
			unit_price: 100,
			annual_unit_price: 1200,
			price_entry_mode: 'monthly',
			price: 2400,
			discount_pct: 10,
			final_price: 2160,
			monthly_price: 180,
			billing_period_price: 180,
			end_date: '2027-09-30',
			price_spec: null,
			priced: null,
		});
	});

	it('modo anual: el unitario mensual es anual / 12; trimestral: el período son 3 meses; una vez: el período es el total', () => {
		const [annual, quarterly, oneTime] = resolveQuoteItems(
			[
				base({ unit_price: undefined, annual_unit_price: 1200, price_entry_mode: 'annual', discount_value: 0 }),
				base({ billing_frequency: 'Trimestral', discount_value: 0 }),
				base({ is_recurring: false, term_months: 1, discount_value: 0, quantity: 1, unit_price: 500 }),
			],
			products
		);

		expect(annual).toMatchObject({ unit_price: 100, annual_unit_price: 1200, price_entry_mode: 'annual', final_price: 2400, monthly_price: 200 });
		expect(quarterly).toMatchObject({ monthly_price: 200, billing_period_price: 600 });
		expect(oneTime).toMatchObject({ is_recurring: false, final_price: 500, monthly_price: 500, billing_period_price: 500 });
	});

	it('con PriceSpec por tramos escribe el mensual equivalente y trae la línea tarifada', () => {
		const [item] = resolveQuoteItems(
			[
				base({
					unit_price: undefined,
					quantity: 1000,
					discount_value: 0,
					price: {
						model: 'graduated',
						quantity_type: 'fixed',
						tiers: [
							{ from: 1, to: 500, per_unit_amount: 1 },
							{ from: 501, to: null, per_unit_amount: 0.5 },
						],
					},
				}),
			],
			products
		);

		// 500 × 1 + 500 × 0,5 = 750 por período mensual → unitario mensual equivalente 0,75.
		expect(item.unit_price).toBe(0.75);
		expect(item.price_spec).toMatchObject({ model: 'graduated', tiers: expect.any(Array) });
		expect(item.priced?.subtotal).toBe(750);
		expect(item.final_price).toBe(9000);
	});
});

describe('quoteTotals', () => {
	it('suma finales, MRR de los recurrentes y agrupa por frecuencia y método', () => {
		const items = resolveQuoteItems(
			[
				base({ discount_value: 0 }),
				base({ billing_frequency: 'Anual', billing_method: 'Vencido', discount_value: 0 }),
				base({ is_recurring: false, term_months: 1, quantity: 1, unit_price: 50, discount_value: 0 }),
			],
			products
		);

		expect(quoteTotals(items)).toEqual({
			total_amount: 4850,
			mrr: 400,
			one_time: 50,
			by_frequency: [
				{ label: 'Mensual Anticipado', amount: 200 },
				{ label: 'Anual Vencido', amount: 2400 },
				{ label: 'Una vez', amount: 50 },
			],
		});
	});
});

describe('itemsIncomplete (para marcar firmada)', () => {
	it('exige producto, precio > 0 (o modelo de precio), inicio, plazo o fin, frecuencia y método, con la ruta del ítem', () => {
		const errors = itemsIncomplete([
			{
				id: 'a',
				product_id: null,
				product_name: 'Sin producto',
				final_price: 0,
				start_date: null,
				end_date: null,
				term_months: null,
				billing_frequency: null,
				billing_method: null,
			},
			{
				id: 'b',
				product_id: PRODUCT,
				product_name: 'Medido',
				final_price: 0,
				start_date: '2026-10-01',
				end_date: null,
				term_months: 12,
				billing_frequency: 'Mensual',
				billing_method: 'Vencido',
				price_id: 'p-1',
			},
			{
				id: 'c',
				product_id: PRODUCT,
				product_name: 'OK',
				final_price: 100,
				start_date: '2026-10-01',
				end_date: '2027-09-30',
				term_months: null,
				billing_frequency: 'Mensual',
				billing_method: 'Anticipado',
			},
		]);

		expect(errors.map((error) => error.field)).toEqual([
			'items.0.product_id',
			'items.0.final_price',
			'items.0.start_date',
			'items.0.term_months',
			'items.0.billing_frequency',
			'items.0.billing_method',
		]);
		expect(errors[0].message).toBe('"Sin producto" no tiene producto del catálogo');
	});
});
