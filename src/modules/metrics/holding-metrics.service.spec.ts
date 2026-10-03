import { DataSource } from 'typeorm';

import { HoldingMetricsService } from './holding-metrics.service';

describe('HoldingMetricsService', () => {
	const build = (row: Record<string, unknown>, currency?: string) => {
		const query = jest.fn(async (sql: string) => (sql.includes('holding_settings') ? (currency ? [{ system_currency: currency }] : []) : [row]));

		return { service: new HoldingMetricsService({ query } as unknown as DataSource), query };
	};

	it('MRR del devengo + legacy y clientes activos con MRR neto > 0, con su variación', async () => {
		const { service, query } = build({ mrr_cur: '1200', mrr_prev: '1000', clients_cur: '8', clients_prev: '10' }, 'CLP');
		const metrics = await service.monthMetrics('h-1', '2026-09-24');
		const sql = query.mock.calls.find(([text]) => (text as string).includes('by_client'))![0] as string;

		expect(sql).toContain('FROM revenue_schedule_monthly r');
		expect(sql).toContain('FROM mrr_legacy m');
		expect(sql).toContain('cur > 0');
		expect(metrics).toEqual({
			currency: 'CLP',
			mrr: { value: 1200, previous: 1000, trend: 20 },
			activeClients: { value: 8, previous: 10, trend: -20 },
		});
	});

	it('sin configuración del holding la moneda es USD', async () => {
		const { service } = build({ mrr_cur: '0', mrr_prev: '0', clients_cur: '0', clients_prev: '0' });

		expect((await service.monthMetrics('h-1', '2026-09-24')).currency).toBe('USD');
	});

	it('con legacyCut aplica el corte U14: solo legacy recurrente y nada desde el primer mes con MRR del contrato migrado', async () => {
		const { service, query } = build({ mrr_cur: '0', mrr_prev: '0', clients_cur: '0', clients_prev: '0' });

		await service.monthMetrics('h-1', '2026-10-03', { legacyCut: true });
		const cut = query.mock.calls.find(([text]) => (text as string).includes('by_client'))![0] as string;

		expect(cut).toContain('m.migrated_to_contract_id');
		expect(cut).toContain('mrr_period_contracted_contract_ccy > 0');
		expect(cut).toContain('NOT (f.first_month IS NOT NULL AND m.period_month >= f.first_month)');
		expect(cut).toContain('COALESCE(m.is_recurring, false) = true');

		query.mockClear();
		await service.monthMetrics('h-1', '2026-10-03');
		const byDefault = query.mock.calls.find(([text]) => (text as string).includes('by_client'))![0] as string;

		// Por defecto (Dashboard, Clientes y Contratos, OK de Domi 03-10) se aplica el corte.
		expect(byDefault).toContain('first_month');

		query.mockClear();
		await service.monthMetrics('h-1', '2026-10-03', { legacyCut: false });
		const legacy = query.mock.calls.find(([text]) => (text as string).includes('by_client'))![0] as string;

		// Solo pidiéndolo explícitamente se mantiene la suma sin corte.
		expect(legacy).not.toContain('first_month');
	});
});
