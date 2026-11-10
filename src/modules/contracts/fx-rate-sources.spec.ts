import {
	CONTRACT_FX_SOURCES,
	inheritedFxSource,
	isPerInvoiceFxSource,
	keepsRateAtIssue,
	PER_INVOICE_FX_SOURCES,
	perInvoiceFxSourceOf,
	SPOT_FX_SOURCE,
} from './fx-rate-sources';

describe('fx-rate-sources (Domi 23-10, caso Carelis CTR-2026-110)', () => {
	it('listas: por factura = manual y net_exact; del contrato = contract y contract-change; marca spot aparte', () => {
		expect([...PER_INVOICE_FX_SOURCES]).toEqual(['manual', 'net_exact']);
		expect([...CONTRACT_FX_SOURCES]).toEqual(['contract', 'contract-change']);
		expect(SPOT_FX_SOURCE).toBe('spot');
		expect(isPerInvoiceFxSource('manual')).toBe(true);
		expect(isPerInvoiceFxSource('contract-change')).toBe(false);
		expect(isPerInvoiceFxSource(null)).toBe(false);
	});

	it('contrato fijo: toda línea con tasa la conserva, sea cual sea el origen (también NULL heredado); sin tasa o marca spot, no', () => {
		for (const source of [
			'scheduled-generation',
			'contract-change',
			'contract',
			'reorganize',
			'invoice-edit',
			'reissue',
			'amendment',
			null,
			undefined,
		]) {
			expect(keepsRateAtIssue(source, 40991.75, true)).toBe(true);
		}
		expect(keepsRateAtIssue('contract-change', null, true)).toBe(false);
		expect(keepsRateAtIssue('contract-change', 0, true)).toBe(false);
		expect(keepsRateAtIssue('spot', 41199.85, true)).toBe(false);
		expect(keepsRateAtIssue('manual', '950.5', true)).toBe(true);
	});

	it('contrato spot: solo las fijadas por factura y las del contrato; el resto se valoriza al día', () => {
		for (const source of ['manual', 'net_exact', 'manual_unify', 'contract', 'contract-change'])
			expect(keepsRateAtIssue(source, 900, false)).toBe(true);
		for (const source of ['scheduled-generation', 'reorganize', 'reissue', 'invoice-edit', 'spot', 'amendment', null]) {
			expect(keepsRateAtIssue(source, 900, false)).toBe(false);
		}
	});

	it('inheritedFxSource (Brightcell 10-11): una línea que se reescribe o nace hereda la tasa fijada por factura si la hay; si no, el origen del camino', () => {
		expect(inheritedFxSource(['consumption', 'manual'], 'consumption')).toBe('manual');
		expect(inheritedFxSource(['net_exact'], 'reorganize')).toBe('net_exact');
		expect(inheritedFxSource(['contract', 'spot', null, undefined], 'consumption')).toBe('consumption');
		expect(inheritedFxSource([], 'invoice-edit')).toBe('invoice-edit');
	});

	it('perInvoiceFxSourceOf: pregunta por las líneas con origen manual o net_exact de la factura y devuelve el primero (o null)', async () => {
		const query = jest
			.fn()
			.mockResolvedValueOnce([{ fx_rate_source: 'net_exact' }])
			.mockResolvedValueOnce([]);

		expect(await perInvoiceFxSourceOf({ query }, 'inv-1', 'h-1')).toBe('net_exact');
		expect(query).toHaveBeenCalledWith(expect.stringContaining('fx_rate_source = ANY($3::text[])'), ['inv-1', 'h-1', ['manual', 'net_exact']]);
		expect(await perInvoiceFxSourceOf({ query }, 'inv-1', 'h-1')).toBeNull();
	});
});
