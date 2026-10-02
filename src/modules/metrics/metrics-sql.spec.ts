import { DataSource } from 'typeorm';

import { inactiveEmptyRowSql, MetricsDataService, SqlParams } from './metrics-data.service';
import { MrrMetricsService, renewalWindowSql } from './mrr-metrics.service';
import { RevenueMetricsService } from './revenue-metrics.service';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';

function build(rows: (sql: string) => unknown[] = () => []) {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) =>
		sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : rows(sql)
	);
	const data = new MetricsDataService({ query } as unknown as DataSource);

	return { query, data, mrr: new MrrMetricsService(data), revenue: new RevenueMetricsService(data) };
}

/** Postgres rechaza un `$n` que el SQL no referencia ("could not determine data type of parameter $n" → 500). */
function unreferencedParams(query: jest.Mock): string[] {
	return query.mock.calls.flatMap(([sql, params]: [string, unknown[] | undefined]) =>
		(params ?? []).map((_, index) => `$${index + 1}`).filter((placeholder) => !new RegExp(`\\${placeholder}(?!\\d)`).test(sql))
	);
}

describe('Renovaciones (500 en ventanas 30/90/180/365)', () => {
	it.each(['30', '90', '180', '365', 'overdue'] as const)('ventana %s: todo parámetro agregado está referenciado en el SQL', async (window) => {
		const { query, mrr } = build();

		await mrr.renewals(HOLDING, { window, segment: 'Enterprise' });

		expect(unreferencedParams(query)).toEqual([]);
	});

	it('solo "vencidos" usa el mes actual; las ventanas en días usan solo el número de días', () => {
		const days = new SqlParams();
		const overdue = new SqlParams();

		expect(renewalWindowSql('90', days, '2026-10')).toBe('ci.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int');
		expect(days.values).toEqual([90]);
		expect(renewalWindowSql('overdue', overdue, '2026-10')).toContain("p.momentum = 'PENDING_RENEWAL' AND p.period_month = $1::date");
		expect(overdue.values).toEqual(['2026-10-01']);
	});

	it('ningún endpoint de Métricas o Revenue deja parámetros sin referenciar', async () => {
		const { query, mrr, revenue } = build();
		const range = { from: '2026-01', to: '2026-03' };

		await mrr.overview(HOLDING, { asOf: '2026-03', clientId: 'bb0caa69-162e-4b9e-8e54-9aff347abf1f' });
		await mrr.movements(HOLDING, range);
		await mrr.byDimension(HOLDING, { ...range, dimension: 'segment' });
		await mrr.clientActivity(HOLDING, range);
		await mrr.cohorts(HOLDING, range);
		await mrr.bookings(HOLDING, range);
		await revenue.summary(HOLDING, range);
		await revenue.schedule(HOLDING, { ...range, search: 'ACME' });
		await revenue.exceptions(HOLDING, {});

		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('Pendiente de renovar = "Por renovar" de Contratos', () => {
	it('suma las filas PENDING_RENEWAL del mes (mrr_period, como Contratos), sin depender de las líneas convertidas del rango', async () => {
		const { query, mrr } = build((sql) =>
			sql.includes(`r.momentum = 'PENDING_RENEWAL'`) && sql.includes('COUNT(DISTINCT r.contract_id)')
				? [
						{ period: '2026-10', mrr: '974.00', cmrr: '974.00', items: '3', clients: '2', contracts: '2' },
						{ period: '2026-09', mrr: '500', cmrr: '500', items: '1', clients: '1', contracts: '1' },
					]
				: []
		);
		const result = await mrr.overview(HOLDING, { asOf: '2026-10' });
		const pendingSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('COUNT(DISTINCT r.contract_id)'));

		expect(result.kpis.pending_renewal).toMatchObject({ mrr: 974, cmrr: 974, items: 3, clients: 2, contracts: 2, previous: 500 });
		expect(pendingSql).toContain('SUM(r.mrr_period_system_ccy)');
		expect(pendingSql).toContain('r.period_month = ANY(');
	});
});

describe('Meses inactivos sin montos no son huecos de tipo de cambio (regla del rebuild v0.0.69)', () => {
	it('la condición mira montos del período en moneda de contrato y la vigencia del ítem', () => {
		const sql = inactiveEmptyRowSql();

		expect(sql).toContain('COALESCE(r.recognized_period_contract_ccy, 0) = 0');
		expect(sql).toContain('COALESCE(r.billed_period_contract_ccy, 0) = 0');
		expect(sql).toContain(
			"NOT (ci.start_date < (r.period_month + interval '1 month') AND (ci.end_date IS NULL OR ci.end_date >= r.period_month))"
		);
		expect(sql.startsWith('COALESCE(')).toBe(true);
	});

	it('Excepciones, líneas de MRR, devengo y detalle ignoran esas filas al marcar "sin tipo de cambio"', async () => {
		const { query, data, revenue } = build();

		await revenue.exceptions(HOLDING, {});
		await data.loadMrrLines(HOLDING, {}, { mode: 'system', code: 'USD' }, 'mrr', '2026-01', '2026-03');
		await revenue.schedule(HOLDING, { from: '2026-01', to: '2026-03' });
		const sqls = query.mock.calls.map(([sql]) => String(sql));
		const exceptions = sqls.find((sql) => sql.includes('AS item_fx'));
		const lines = sqls.find((sql) => sql.includes('AS item_fx_missing') && sql.includes('mrr_period_contracted_system_ccy'));
		const detail = sqls.find((sql) => sql.includes('AS unconverted') && sql.includes('LIMIT'));

		expect(exceptions).toContain('LEFT JOIN contract_items ci ON ci.id = r.contract_item_id');
		expect(exceptions).toContain(`AND NOT ${inactiveEmptyRowSql()}`);
		expect(lines).toContain(`NOT ${inactiveEmptyRowSql()}`);
		expect(detail).toContain(`NOT ${inactiveEmptyRowSql()}`);
	});
});
