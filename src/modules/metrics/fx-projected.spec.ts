import { loadFxProjected, projectedSourceSql } from './fx-projected';

import type { DataSource } from 'typeorm';

describe('loadFxProjected (tasa proyectada, 04-10)', () => {
	it('agrupa por moneda las filas *_projected del rango y devuelve la tasa que se extiende tal como está guardada', async () => {
		const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>();

		query.mockResolvedValueOnce([{ ok: true }]).mockResolvedValueOnce([
			{
				currency: 'CLF',
				system_currency: 'USD',
				from_month: '2027-01',
				to_month: '2029-03',
				contracts: '8',
				rate: '0.0231',
				is_inverse: false,
				period_start: '2026-01-01',
				period_end: new Date('2026-12-31T00:00:00Z'),
			},
			{
				currency: 'EUR',
				system_currency: 'USD',
				from_month: '2027-01',
				to_month: '2027-02',
				contracts: 1,
				rate: '1.08',
				is_inverse: true,
				period_start: '2026-01-01',
				period_end: '2026-12-31',
			},
			{
				currency: 'MXN',
				system_currency: 'USD',
				from_month: '2027-01',
				to_month: '2027-01',
				contracts: 1,
				rate: null,
				is_inverse: null,
				period_start: null,
				period_end: null,
			},
		]);
		const result = await loadFxProjected({ query } as unknown as DataSource, 'h-1', '2027-01-01', null);
		const [sql, params] = query.mock.calls[1];

		expect(params).toEqual(['h-1', '2027-01-01', null]);
		expect(sql).toContain(projectedSourceSql('r'));
		expect(sql).toContain('($3::date IS NULL OR r.period_month <= $3::date)');
		expect(sql).toContain(`public.holding_fixed_fx_rate($1::uuid, p.currency, COALESCE(hs.system_currency, 'USD'), p.first_month::date)`);
		expect(result).toEqual([
			{
				currency: 'CLF',
				system_currency: 'USD',
				from_month: '2027-01',
				to_month: '2029-03',
				contracts: 8,
				basis: { from_currency: 'CLF', to_currency: 'USD', rate: 0.0231, period_start: '2026-01-01', period_end: '2026-12-31' },
			},
			{
				currency: 'EUR',
				system_currency: 'USD',
				from_month: '2027-01',
				to_month: '2027-02',
				contracts: 1,
				basis: { from_currency: 'USD', to_currency: 'EUR', rate: 1.08, period_start: '2026-01-01', period_end: '2026-12-31' },
			},
			{ currency: 'MXN', system_currency: 'USD', from_month: '2027-01', to_month: '2027-01', contracts: 1, basis: null },
		]);
	});

	it('sin la función holding_fixed_fx_rate en la base (asset sin aplicar) no consulta el devengo y devuelve vacío', async () => {
		const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>().mockResolvedValueOnce([{ ok: false }]);

		await expect(loadFxProjected({ query } as unknown as DataSource, 'h-1', '2027-01-01', null)).resolves.toEqual([]);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('la fuente proyectada se reconoce por el sufijo literal _projected', () => {
		expect(projectedSourceSql('x')).toBe(`COALESCE(x.fx_to_system_source, '') LIKE '%\\_projected'`);
	});
});
