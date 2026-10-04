import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { MetricsDataService } from './metrics-data.service';
import { MrrMetricsService } from './mrr-metrics.service';
import { RevenueMetricsService } from './revenue-metrics.service';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';

function build(rows: (sql: string) => unknown[] = () => []) {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) =>
		sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : rows(sql)
	);
	const data = new MetricsDataService({ query } as unknown as DataSource);

	return { query, data, mrr: new MrrMetricsService(data), revenue: new RevenueMetricsService(data) };
}

const sqlOf = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql));

describe('MetricsDataService', () => {
	it('moneda de compañía exige una compañía y la de contrato un contrato (400 con errors[])', async () => {
		const { data } = build();

		await expect(data.resolveCurrency(HOLDING, { currency: 'company' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(data.resolveCurrency(HOLDING, { currency: 'contract' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(data.resolveCurrency(HOLDING, {})).resolves.toEqual({ mode: 'system', code: 'USD' });
	});

	it('las líneas de MRR leen solo columnas convertidas del RSM, sin pendientes ni monthly_price, y el legacy con el corte U14', async () => {
		const { query, data } = build();

		await data.loadMrrLines(HOLDING, {}, { mode: 'system', code: 'USD' }, 'mrr', '2026-01', '2026-03');
		const [rsm, legacy] = sqlOf(query);

		expect(rsm).toContain('r.mrr_period_contracted_system_ccy');
		expect(rsm).toContain("r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'");
		expect(rsm).toContain("LIKE 'missing_fx_rate%'");
		expect(rsm).not.toContain('monthly_price');
		expect(legacy).toContain('FROM mrr_legacy m');
		expect(legacy).toContain('NOT (f.first_month IS NOT NULL AND m.period_month >= f.first_month)');
		expect(query.mock.calls[0][1]?.[0]).toBe(HOLDING);
	});

	it('Métricas va solo en moneda de sistema: currency=company|contract → 400 con errors[currency]', async () => {
		const { mrr, query } = build();

		for (const currency of ['company', 'contract'] as const) {
			const error = await mrr.movements(HOLDING, { from: '2026-01', to: '2026-02', currency }).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(BadRequestException);
			expect((error as BadRequestException).getResponse()).toMatchObject({ errors: [{ field: 'currency' }] });
		}
		expect(sqlOf(query).some((sql) => sql.includes('revenue_schedule_monthly'))).toBe(false);
	});

	it('Métricas sin currency o con currency=system lee columnas *_system_ccy', async () => {
		const { mrr, query } = build();
		const result = await mrr.movements(HOLDING, { from: '2026-01', to: '2026-02', currency: 'system' });

		expect(result.currency).toBe('USD');
		expect(sqlOf(query).find((sql) => sql.includes('FROM revenue_schedule_monthly r'))).toContain('r.mrr_period_contracted_system_ccy');
		await mrr.renewals(HOLDING, {});
		expect(sqlOf(query).at(-1)).toContain('mrr_period_contracted_system_ccy');
	});

	it('Ingresos en moneda de compañía no lee las filas pending_month_close (sin dato, no "sin convertir"); en sistema no filtra', async () => {
		const companyId = 'bb0caa69-162e-4b9e-8e54-9aff347abf1f';
		const { data, query } = build();

		await data.loadRevenueRows(HOLDING, { companyId }, { mode: 'company', code: 'CLP' }, null, '2026-10');
		expect(sqlOf(query).at(-1)).toContain("COALESCE(r.fx_to_company_source, '') <> 'pending_month_close'");
		await data.loadRevenueRows(HOLDING, {}, { mode: 'system', code: 'USD' }, null, '2026-10');
		expect(sqlOf(query).at(-1)).not.toContain('pending_month_close');
	});

	it('Ingresos › detalle y reconocimiento futuro en moneda de compañía tampoco leen los meses sin cerrar', async () => {
		const companyId = 'bb0caa69-162e-4b9e-8e54-9aff347abf1f';
		const { revenue, query } = build((sql) => (sql.includes('SELECT currency FROM companies') ? [{ currency: 'CLP' }] : []));
		const filter = "COALESCE(r.fx_to_company_source, '') <> 'pending_month_close'";

		await revenue.schedule(HOLDING, { from: '2026-01', to: '2026-12', companyId, currency: 'company' });
		const schedule = sqlOf(query).filter((sql) => sql.includes('FROM revenue_schedule_monthly r'));

		expect(schedule.length).toBeGreaterThanOrEqual(2);
		schedule.forEach((sql) => expect(sql).toContain(filter));
		query.mockClear();
		await revenue.forward(HOLDING, { asOf: '2026-10', companyId, currency: 'company' });
		expect(sqlOf(query).find((sql) => sql.includes('r.period_month >'))).toContain(filter);
	});

	it('filas sin convertir quedan fuera de las líneas y se informan por contrato', async () => {
		const row = (period: string, value: number | null, unconverted: boolean) => ({
			key: 'i:1',
			source: 'contract',
			contract_id: 'c-1',
			contract_number: 'CTR-1',
			item_id: '1',
			client_id: 'cl',
			client_name: 'Cliente',
			period,
			value,
			unconverted,
			item_fx_missing: unconverted,
			value_contract: 10,
			pending: 0,
			momentum: null,
		});
		const { mrr } = build((sql) =>
			sql.includes('FROM revenue_schedule_monthly r') && sql.includes('GROUP BY 1, 2')
				? [row('2026-01', 10, false), row('2026-02', null, true)]
				: []
		);
		const result = await mrr.movements(HOLDING, { from: '2026-01', to: '2026-02' });

		expect(result.months.map((m) => m.closing)).toEqual([0, 0]);
		expect(result.unconverted).toMatchObject({
			items: 1,
			contracts: [{ contract_number: 'CTR-1', reason: 'item_fx_rate', months: ['2026-02'] }],
		});
	});

	it('Revenue toma un acumulado por ítem-mes (no la fila CHURN de la cola) y los asientos exigen una compañía', async () => {
		const { query, revenue } = build();

		await revenue.rollforward(HOLDING, { from: '2026-01', to: '2026-02' });
		expect(sqlOf(query).find((sql) => sql.includes('recognized_cum'))).toContain("ORDER BY (r.momentum = 'CHURN')");
		await expect(revenue.journal(HOLDING, {})).rejects.toBeInstanceOf(BadRequestException);
	});
});
