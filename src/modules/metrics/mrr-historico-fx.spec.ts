import * as fs from 'fs';
import * as path from 'path';

import { legacyFxKey, legacySystemAmount, loadLegacySystemFx } from './mrr-historico-fx';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const squash = (sql: string) => sql.replace(/\s+/g, ' ');

describe('MRR histórico · moneda de sistema (réplica del trigger calculate_mrr_legacy_system_currency)', () => {
	const trigger = squash(
		fs.readFileSync(path.join(__dirname, '../../databases/postgresql/functions/calculate_mrr_legacy_system_currency.sql'), 'utf8')
	);

	it('el trigger sigue con la regla que replica el helper (si cambia, el helper cambia en el mismo commit)', () => {
		expect(trigger).toContain("COALESCE(fx_system_policy, 'monthly_avg')");
		expect(trigger).toContain('NEW.fx_contract_to_system := 1.0');
		expect(trigger).toContain('FROM exchange_rates_monthly_avg');
		expect(trigger).toContain('FROM holding_fx_period_rates');
		expect(trigger).toContain('NEW.fx_contract_to_system := COALESCE(v_fx_rate, 1.0)');
		expect(trigger).toContain('NEW.mrr_legacy_system_currency := NEW.mrr_legacy / NULLIF(NEW.fx_contract_to_system, 0)');
		// La búsqueda inversa toma la tasa tal cual (no la invierte).
		expect(trigger).not.toContain('1.0 /');
	});

	it('una consulta: misma moneda → 1; monthly_avg y fixed_period con par directo o inverso sin invertir; sin tasa → 1', async () => {
		const query = jest.fn(async () => [
			{ currency: 'CLF', month: '2026-07', system_currency: 'USD', rate: '0.024' },
			{ currency: 'USD', month: '2026-07', system_currency: 'USD', rate: '1.0' },
		]);
		const fx = await loadLegacySystemFx({ query }, HOLDING, [
			{ currency: 'clf', month: '2026-07' },
			{ currency: 'CLF', month: '2026-07' },
			{ currency: 'USD', month: '2026-07' },
		]);
		const [[sql, params]] = query.mock.calls as unknown as Array<[string, unknown[]]>;
		const text = squash(sql);

		expect(params).toEqual([HOLDING, ['CLF', 'USD'], ['2026-07', '2026-07']]);
		expect(text).toContain("COALESCE(fx_system_policy, 'monthly_avg')");
		expect(text).toContain('WHEN p.currency = (SELECT system_currency FROM hs) THEN 1.0');
		expect(text).toContain(
			"WHEN 'monthly_avg' THEN COALESCE( (SELECT e.avg_rate FROM exchange_rates_monthly_avg e WHERE e.from_currency = p.currency"
		);
		expect(text).toContain(
			'(SELECT e.avg_rate FROM exchange_rates_monthly_avg e WHERE e.from_currency = (SELECT system_currency FROM hs) AND e.to_currency = p.currency'
		);
		expect(text).toContain('p.period_month >= r.period_start AND p.period_month <= r.period_end');
		expect(text).toContain('END, 1.0) END AS rate');
		expect(fx.system_currency).toBe('USD');
		expect(fx.rates.get(legacyFxKey('CLF', '2026-07'))).toBe(0.024);
	});

	it('monto en sistema = round(mrr ÷ tasa, 2), como la columna; sin MRR → null', () => {
		expect(legacySystemAmount(116.7, 0.024)).toBe(4862.5);
		expect(legacySystemAmount(7440, 18.29)).toBe(406.78);
		expect(legacySystemAmount(null, 1)).toBeNull();
	});

	it('sin pares: igual devuelve la moneda de sistema del holding (USD por defecto)', async () => {
		const query = jest.fn(async (sql: string) => (sql.includes('WITH hs AS') ? [] : [{ system_currency: 'CLP' }]));

		expect((await loadLegacySystemFx({ query }, HOLDING, [])).system_currency).toBe('CLP');
		expect((await loadLegacySystemFx({ query: jest.fn(async () => []) }, HOLDING, [])).system_currency).toBe('USD');
	});
});
