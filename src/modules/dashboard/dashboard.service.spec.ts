import { DataSource } from 'typeorm';

import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
	const buildService = (queryImpl: (sql: string, params: unknown[]) => Promise<unknown[]>) => {
		const dataSource = { query: jest.fn(queryImpl) } as unknown as DataSource;
		return { service: new DashboardService(dataSource), query: (dataSource as unknown as { query: jest.Mock }).query };
	};

	it('consulta solo el holding recibido (validado por HoldingScopeGuard) y no resuelve holdings por su cuenta', async () => {
		const { service, query } = buildService(async () => [{}]);

		const home = (await service.getHome('holding-1')) as { holding_id: string };

		expect(home.holding_id).toBe('holding-1');
		for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
			expect(sql).not.toContain('FROM user_holdings');
			expect(params[0]).toBe('holding-1');
		}
	});

	it('con holding resuelto arma los KPIs y tareas desde las consultas', async () => {
		const { service } = buildService(async (sql) => {
			if (sql.includes('monthly_mrr')) return [{ current: '1200', previous: '1000' }];
			if (sql.includes('active_clients')) return [{ current: '8', previous: '10' }];
			if (sql.includes('recognized_period_system_ccy')) return [{ value: '5400' }];
			if (sql.includes('to_issue_count')) return [{ to_issue_count: '3', to_issue_amount: '900', overdue_count: '2' }];
			if (sql.includes('renew_30')) return [{ renew_30: '1', renew_90: '4', expired_contracts: '2', starts_this_month: '5' }];
			return [{}];
		});

		const home = (await service.getHome('holding-1', new Date('2026-09-22T00:00:00.000Z'))) as {
			holding_id: string;
			as_of: string;
			kpis: {
				mrr: { value: number; trend: number };
				active_clients: { value: number };
				recognized_revenue: { value: number };
				pending_invoices: { count: number; amount: number };
			};
			tasks: {
				overdue_invoices: number;
				expired_contracts: number;
				contracts_to_renew_30: number;
				contracts_to_renew_90: number;
				invoices_to_emit: number;
				items_starting_this_month: number;
			};
		};

		expect(home.holding_id).toBe('holding-1');
		expect(home.as_of).toBe('2026-09-22');
		expect(home.kpis.mrr).toMatchObject({ value: 1200, trend: 20 });
		expect(home.kpis.active_clients.value).toBe(8);
		expect(home.kpis.recognized_revenue.value).toBe(5400);
		expect(home.kpis.pending_invoices).toMatchObject({ count: 3, amount: 900 });
		expect(home.tasks).toEqual({
			overdue_invoices: 2,
			expired_contracts: 2,
			contracts_to_renew_30: 1,
			contracts_to_renew_90: 4,
			invoices_to_emit: 3,
			items_starting_this_month: 5,
		});
	});
});
