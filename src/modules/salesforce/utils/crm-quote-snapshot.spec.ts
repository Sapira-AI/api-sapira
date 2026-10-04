import {
	buildCrmQuoteSnapshot,
	classifyExistingCrmQuote,
	CRM_QUOTE_NOTES,
	crmQuoteProtection,
	crmSnapshotChanged,
	crmSnapshotChanges,
	readCrmQuoteSnapshot,
	snapshotValue,
} from './crm-quote-snapshot';

const item = (overrides: Record<string, unknown> = {}) => ({
	salesforce_line_item_id: '00k1',
	product_id: 'p-1',
	product_name: 'Plan Pro',
	quantity: 1,
	unit_price: 100,
	discount_value: null,
	final_price: 1200,
	start_date: new Date(2026, 0, 1),
	end_date: new Date(2026, 11, 31),
	term_months: 12,
	billing_frequency: 'Mensual',
	billing_method: 'anticipado',
	is_recurring: true,
	currency: 'USD',
	holding_id: 'h-1',
	...overrides,
});
const snapshot = (header: Record<string, unknown> = {}, items = [item()]) =>
	buildCrmQuoteSnapshot({
		header: { currency: 'USD', total_amount: 1200, notes: 'nota', salesforce_opportunity_id: '006', ...header },
		owner: 'ana@acme.com',
		accountId: '001',
		items,
	});

describe('crm-quote-snapshot', () => {
	it('snapshot: fechas YYYY-MM-DD locales, sin notas ni vínculo técnico, con dueño y cuenta; ítems ordenados', () => {
		const result = snapshot({}, [item({ salesforce_line_item_id: '00k2' }), item()]);

		expect(result.header).toEqual({ currency: 'USD', total_amount: 1200, crm_owner: 'ana@acme.com', crm_account_id: '001' });
		expect(result.items.map((entry) => entry.salesforce_line_item_id)).toEqual(['00k1', '00k2']);
		expect(result.items[0]).toEqual(expect.objectContaining({ start_date: '2026-01-01', end_date: '2026-12-31', quantity: 1 }));
		expect(result.items[0]).not.toHaveProperty('holding_id');
		expect(snapshotValue('')).toBeNull();
		expect(snapshotValue(0.1 + 0.2)).toBe(0.3);
	});

	it('cambio real = el CRM cambió desde la última importación (las notas no cuentan; "100" = 100)', () => {
		const base = snapshot();

		expect(crmSnapshotChanged(base, snapshot({ notes: 'otra' }))).toBe(false);
		expect(crmSnapshotChanged(base, { ...snapshot(), header: { ...snapshot().header, total_amount: '1200' } })).toBe(false);
		expect(crmSnapshotChanges(base, snapshot({ total_amount: 1500 }))).toEqual([
			expect.objectContaining({ scope: 'quote', field: 'quote.total_amount', label: 'Total', before: 1200, after: 1500 }),
		]);
	});

	it('ítems: cambiado, nuevo y quitado en el CRM', () => {
		const base = snapshot({}, [item(), item({ salesforce_line_item_id: '00k9', product_name: 'Soporte' })]);
		const next = snapshot({}, [item({ quantity: 3 }), item({ salesforce_line_item_id: '00k5', product_name: 'Extra' })]);
		const changes = crmSnapshotChanges(base, next);

		expect(changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'quote_item.00k1.quantity', item_action: 'changed', before: 1, after: 3, item_label: 'Plan Pro' }),
				expect.objectContaining({ field: 'quote_item.00k5.product_id', item_action: 'added', before: null, after: 'p-1' }),
				expect.objectContaining({ field: 'quote_item.00k9.product_id', item_action: 'removed', before: 'p-1', after: null }),
			])
		);
	});

	it('protección: contrato (directo o por ítems) o etapa contract_created', () => {
		expect(crmQuoteProtection({ has_contract: true, stage_kind: 'sent' })).toBe('contract');
		expect(crmQuoteProtection({ has_contract: false, stage_kind: 'contract_created' })).toBe('contract_created');
		expect(crmQuoteProtection({ has_contract: false, stage_kind: 'sent' })).toBeNull();
		expect(crmQuoteProtection(null)).toBeNull();
	});

	it('clasificación: protegida > sin snapshot (base) > cambió > sin cambios', () => {
		const base = snapshot();
		const changed = snapshot({ total_amount: 1 });

		expect(classifyExistingCrmQuote({ protection: 'contract', stored: base, incoming: changed })).toEqual({
			processing_status: 'processed',
			integration_notes: 'La cotización ya tiene contrato: no se actualiza',
			baseline: null,
		});
		expect(classifyExistingCrmQuote({ protection: null, stored: null, incoming: changed })).toEqual({
			processing_status: 'processed',
			integration_notes: CRM_QUOTE_NOTES.baseline,
			baseline: { ...changed, baseline: true },
		});
		expect(classifyExistingCrmQuote({ protection: null, stored: base, incoming: changed }).processing_status).toBe('update');
		expect(classifyExistingCrmQuote({ protection: null, stored: base, incoming: snapshot() }).processing_status).toBe('processed');
	});

	it('lee un snapshot guardado y descarta formas inválidas', () => {
		expect(readCrmQuoteSnapshot(JSON.parse(JSON.stringify(snapshot())))).toEqual(snapshot());
		expect(readCrmQuoteSnapshot(null)).toBeNull();
		expect(readCrmQuoteSnapshot({ header: {} })).toBeNull();
	});
});
