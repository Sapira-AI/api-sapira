import { contractTargetsOf, type TargetContract, type TargetContractItem, type TargetQuoteItem } from './quote-contract-targets';

/** `GET /quotes/:id/contract-targets` (spec modificaciones §9.2): dónde y cómo aplicar una cotización a un contrato del cliente. */
describe('contractTargetsOf (cotización → contrato)', () => {
	const contract = (overrides: Partial<TargetContract> = {}): TargetContract => ({
		id: 'c-1',
		contract_number: 'CTR-2026-001',
		derived_status: 'active',
		contract_currency: 'CLP',
		requires_multicurrency_billing: false,
		next_item_end_date: '2026-12-31',
		mrr: 1200,
		...overrides,
	});
	const quoteItem = (overrides: Partial<TargetQuoteItem> = {}): TargetQuoteItem => ({
		id: 'qi-1',
		product_id: 'p-lic',
		product_name: 'Licencia',
		account: null,
		quantity: 12,
		unit_price: 100,
		currency: 'CLP',
		is_recurring: true,
		...overrides,
	});
	const item: TargetContractItem = {
		contract_id: 'c-1',
		id: 'item-lic',
		product_id: 'p-lic',
		product_name: 'Licencia',
		account: null,
		quantity: 10,
		unit_price: 100,
		monthly_price: 1000,
		currency: 'CLP',
	};
	const signed = { id: 'q-1', status: 'signed' as const, quote_type: 'Upselling', currency: 'CLP' };

	it('producto vivo en el contrato → item_change sobre el ítem madre (upsell de cantidad/precio); producto nuevo → item_add', () => {
		const [target] = contractTargetsOf(
			signed,
			[quoteItem(), quoteItem({ id: 'qi-2', product_id: 'p-new', product_name: 'Analítica' })],
			[contract()],
			[item]
		);

		expect(target.can_apply).toBe(true);
		expect(target.suggestions).toEqual([
			expect.objectContaining({
				quote_item_id: 'qi-1',
				change_type: 'item_change',
				item_id: 'item-lic',
				current: { quantity: 10, unit_price: 100, monthly_price: 1000 },
				proposed: { quantity: 12, unit_price: 100, currency: 'CLP' },
			}),
			expect.objectContaining({ quote_item_id: 'qi-2', change_type: 'item_add', item_id: null, current: null }),
		]);
	});

	it('bloqueos: no firmada, ya aplicada, nuevo negocio (S3-3)', () => {
		expect(contractTargetsOf({ ...signed, status: 'sent' }, [quoteItem()], [contract()], [item])[0].blockers.map((entry) => entry.code)).toEqual([
			'quote_not_signed',
		]);
		expect(
			contractTargetsOf({ ...signed, status: 'contract_created' }, [quoteItem()], [contract()], [item])[0].blockers.map((entry) => entry.code)
		).toEqual(['quote_already_applied']);
		expect(
			contractTargetsOf({ ...signed, quote_type: 'New Business' }, [quoteItem()], [contract()], [item])[0].blockers.map((entry) => entry.code)
		).toEqual(['new_business_quote_on_existing_contract']);
	});

	it('avisos: Por renovar no admite productos nuevos; moneda distinta sin multimoneda pedirá activarla', () => {
		const [target] = contractTargetsOf(
			{ ...signed, currency: 'USD' },
			[quoteItem({ id: 'qi-2', product_id: 'p-new', currency: 'USD' })],
			[contract({ derived_status: 'pending_renewal' })],
			[item]
		);

		expect(target.warnings.map((entry) => entry.code)).toEqual(['pending_renewal_item_add', 'multicurrency_not_enabled']);
		expect(target.suggestions[0].proposed.currency).toBe('USD');
	});
});
