import { buildItemGroups, type ContractItem, deriveItemStatus, type PricedItemFields } from './contract-items';

const today = '2026-09-25';

const item = (overrides: Partial<ContractItem> & { id: string }): ContractItem => ({
	product_id: 'p-1',
	product_name: 'LICENCIA',
	account: null,
	item_type: 'Licencia',
	categoria: 'NEW',
	unit_of_measure: 'Usuario',
	quantity: 1,
	unit_price: 10,
	price_entry_mode: 'monthly',
	annual_unit_price: null,
	discount_type: null,
	discount_value: null,
	monthly_price: 10,
	billing_period_price: 10,
	final_price: 120,
	term_months: 12,
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	is_recurring: true,
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	booking_date: null,
	churn_date: null,
	related_item_id: null,
	renews_item_id: null,
	renewed_by_item_id: null,
	auto_renew: false,
	currency: 'USD',
	status: 'active',
	...overrides,
});

describe('deriveItemStatus', () => {
	it('marca churned por churn_date o por categoría CHURN', () => {
		expect(deriveItemStatus(item({ id: 'a', churn_date: '2026-10-01' }), today)).toBe('churned');
		expect(deriveItemStatus(item({ id: 'b', categoria: 'CHURN' }), today)).toBe('churned');
	});

	it('marca renewed si otro ítem lo renovó y ya terminó', () => {
		expect(deriveItemStatus(item({ id: 'a', renewed_by_item_id: 'x', end_date: '2026-06-30' }), today)).toBe('renewed');
		// Renovado pero aún vigente: sigue activo hasta su fin.
		expect(deriveItemStatus(item({ id: 'b', renewed_by_item_id: 'x' }), today)).toBe('active');
	});

	it('distingue futuro, terminado y activo', () => {
		expect(deriveItemStatus(item({ id: 'a', start_date: '2026-10-01' }), today)).toBe('future');
		expect(deriveItemStatus(item({ id: 'b', end_date: '2026-09-24' }), today)).toBe('ended');
		expect(deriveItemStatus(item({ id: 'c', end_date: today }), today)).toBe('active');
		expect(deriveItemStatus(item({ id: 'd', end_date: null }), today)).toBe('active');
	});
});

describe('buildItemGroups (ítem madre)', () => {
	it('base 5 + upsell 1 = 6, MRR y monto por factura suman', () => {
		const [group] = buildItemGroups(
			[
				item({ id: 'base', quantity: 5, monthly_price: 50, billing_period_price: 50 }),
				item({
					id: 'up',
					categoria: 'UPSELL',
					quantity: 1,
					monthly_price: 10,
					billing_period_price: 10,
					related_item_id: 'base',
					start_date: '2026-05-01',
				}),
			],
			today
		);

		expect(group.quantity).toBe(6);
		expect(group.mrr).toBe(60);
		expect(group.amount_per_invoice).toBe(60);
		expect(group.unit_effective).toBe(10);
		expect(group.item_ids).toEqual(['base', 'up']);
		expect(group.start_date).toBe('2026-01-01');
	});

	it('un ajuste de precio (misma cantidad que su relacionado) aporta 0 a la cantidad pero suma MRR', () => {
		const [group] = buildItemGroups(
			[
				item({ id: 'base', quantity: 5, monthly_price: 50 }),
				item({ id: 'price', categoria: 'UPSELL', quantity: 5, monthly_price: 25, related_item_id: 'base', start_date: '2026-06-01' }),
			],
			today
		);

		expect(group.quantity).toBe(5);
		expect(group.mrr).toBe(75);
		expect(group.unit_effective).toBe(15);
	});

	it('un downsell resta cantidad', () => {
		const [group] = buildItemGroups(
			[
				item({ id: 'base', quantity: 10, monthly_price: 100 }),
				item({ id: 'down', categoria: 'DOWNSELL', quantity: 3, monthly_price: -30, related_item_id: 'base', start_date: '2026-07-01' }),
			],
			today
		);

		expect(group.quantity).toBe(7);
		expect(group.mrr).toBe(70);
		expect(group.unit_effective).toBe(10);
	});

	it('un ítem con inicio futuro no cuenta en el estado vigente', () => {
		const [group] = buildItemGroups(
			[
				item({ id: 'base', quantity: 5, monthly_price: 50, billing_period_price: 50 }),
				item({
					id: 'future',
					categoria: 'UPSELL',
					quantity: 2,
					monthly_price: 20,
					billing_period_price: 20,
					related_item_id: 'base',
					start_date: '2026-11-01',
				}),
			],
			today
		);

		expect(group.quantity).toBe(5);
		expect(group.mrr).toBe(50);
		expect(group.amount_per_invoice).toBe(50);
		// Sigue en el desplegable del grupo.
		expect(group.item_ids).toContain('future');
	});

	it('la cuenta separa grupos aunque el producto coincida', () => {
		const groups = buildItemGroups(
			[item({ id: 'a', account: 'Cuenta 1' }), item({ id: 'b', account: ' Cuenta 2 ' }), item({ id: 'c', account: 'Cuenta 1' })],
			today
		);

		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.account)).toEqual(['Cuenta 1', 'Cuenta 2']);
		expect(groups[0].item_ids).toEqual(['a', 'c']);
	});

	it('deja fuera los no recurrentes y los grupos sin ítems vigentes', () => {
		const groups = buildItemGroups(
			[
				item({ id: 'setup', product_name: 'IMPLEMENTACION', is_recurring: false }),
				item({ id: 'old', product_name: 'SOPORTE', end_date: '2026-03-31' }),
				item({ id: 'lic' }),
			],
			today
		);

		expect(groups.map((group) => group.product_name)).toEqual(['LICENCIA']);
	});

	it('usa el fin más próximo del ámbito y cruza con la próxima factura por emitir', () => {
		const [group] = buildItemGroups(
			[
				item({ id: 'base', quantity: 2, monthly_price: 2.5, billing_period_price: 30, end_date: '2027-03-31' }),
				item({
					id: 'up',
					categoria: 'UPSELL',
					quantity: 1,
					monthly_price: 0,
					billing_period_price: 0,
					end_date: '2026-12-31',
					related_item_id: 'x',
				}),
			],
			today,
			[
				{ invoice_id: 'pe-2', issue_date: '2026-11-01', contract_item_id: 'base', subtotal: 99 },
				{ invoice_id: 'pe-1', issue_date: '2026-10-01', contract_item_id: 'base', subtotal: 20 },
				{ invoice_id: 'pe-1', issue_date: '2026-10-01', contract_item_id: 'up', subtotal: 10.03 },
				{ invoice_id: 'pe-1', issue_date: '2026-10-01', contract_item_id: 'other', subtotal: 500 },
			]
		);

		expect(group.end_date).toBe('2026-12-31');
		expect(group.next_invoice).toEqual({ id: 'pe-1', issue_date: '2026-10-01', amount: 30.03, matches: true });
	});

	it('marca que la próxima factura no coincide si difiere más de 0,05', () => {
		const [group] = buildItemGroups([item({ id: 'base', billing_period_price: 30 })], today, [
			{ invoice_id: 'pe-1', issue_date: '2026-10-01', contract_item_id: 'base', subtotal: 30.1 },
		]);

		expect(group.next_invoice?.matches).toBe(false);
	});

	describe('precio del grupo', () => {
		const price = (id: string) => ({
			id,
			name: `Precio ${id}`,
			version: 1,
			status: 'active',
			list_price_id: null,
			model: 'graduated' as const,
			quantity_type: 'fixed' as const,
			billable_metric_id: null,
			unit_amount: null,
			tiers: [],
			package_size: null,
			package_amount: null,
			seat_minimum_quantity: 0,
			free_units: 0,
			minimum_amount: null,
			cap_amount: null,
			invoice_line_mode: 'single' as const,
			charge_flat_when_free: false,
		});
		const fields = (id: string | null): PricedItemFields => ({
			price: id ? price(id) : null,
			metric: null,
			catalog_price: id ? { id: `lp-${id}`, name: 'Lista', version: 2 } : null,
			uses_price_model: Boolean(id),
		});

		it('resume el precio si todos los vigentes lo comparten; si no, null pero uses_price_model', () => {
			const priced = new Map<string, PricedItemFields>([
				['base', fields('p-1')],
				['up', fields('p-1')],
				['ended', fields('p-2')],
				['other', fields('p-1')],
				['plain', fields(null)],
			]);
			const groups = buildItemGroups(
				[
					item({ id: 'base' }),
					item({ id: 'up', categoria: 'UPSELL', related_item_id: 'base', start_date: '2026-05-01' }),
					item({ id: 'ended', end_date: '2026-03-31' }),
					item({ id: 'other', product_name: 'MIXTO' }),
					item({ id: 'plain', product_name: 'MIXTO' }),
				],
				today,
				[],
				(row) => priced.get(row.id)
			);
			const byName = Object.fromEntries(groups.map((group) => [group.product_name, group]));

			expect(byName.LICENCIA).toMatchObject({ uses_price_model: true, price: { id: 'p-1' }, catalog_price: { id: 'lp-p-1', version: 2 } });
			expect(byName.MIXTO).toMatchObject({ uses_price_model: true, price: null, metric: null, catalog_price: null });
		});

		it('sin precios (otros lectores) el grupo no declara modelo', () => {
			const [group] = buildItemGroups([item({ id: 'a' })], today);

			expect(group).toMatchObject({ price: null, metric: null, catalog_price: null, uses_price_model: false });
		});
	});
});
