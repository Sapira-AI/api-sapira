import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientMetricsService, OPEN_INVOICE_STATUSES } from './client-metrics.service';

describe('ClientMetricsService', () => {
	const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

		return { service: new ClientMetricsService({ query } as unknown as DataSource), query };
	};
	const asOf = new Date('2026-09-22T12:00:00.000Z');

	it('responde 404 si el cliente no es del holding (y no consulta métricas)', async () => {
		const { service, query } = build((sql) => (sql.includes('FROM clients WHERE id') ? [] : [{}]));

		await expect(service.getSummary('c-1', 'h-1', asOf)).rejects.toBeInstanceOf(NotFoundException);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it('arma el resumen con contratos, cartera (criterio de Facturación) y MRR', async () => {
		const { service, query } = build((sql) => {
			if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];
			if (sql.includes('FROM contracts'))
				return [
					{ active_contracts: '2', next_renewal: { contract_id: 'k-1', contract_number: 'CTR-73', end_date: '2026-12-31', days: 100 } },
				];
			if (sql.includes('FROM invoices'))
				return [
					{
						currency: 'USD',
						receivable_amount: '34800.46',
						receivable_count: '40',
						overdue_amount: '20000',
						overdue_count: '31',
						oldest_days: '86',
						invoiced_12m: '120000',
					},
				];
			if (sql.includes('mrr_legacy')) return [{ current: '9783.06', previous: '9000' }];

			return [{}];
		});

		const summary = await service.getSummary('c-1', 'h-1', asOf);

		expect(summary).toMatchObject({
			as_of: '2026-09-22',
			currency: 'USD',
			active_contracts: 2,
			next_renewal: { contract_number: 'CTR-73', days: 100 },
			receivable: { amount: 34800.46, count: 40 },
			overdue: { amount: 20000, count: 31, oldest_days: 86 },
			invoiced_last_12m: 120000,
		});
		expect(summary.mrr.value).toBe(9783.06);
		expect(summary.mrr.trend).toBeCloseTo(8.7, 1);
		const invoiceCall = query.mock.calls.find(([sql]) => (sql as string).includes('FROM invoices'))!;

		expect(invoiceCall[1]).toEqual(['c-1', 'h-1', '2026-09-22', OPEN_INVOICE_STATUSES]);
	});

	it('agrupa la cartera por antigüedad de vencimiento', async () => {
		const { service } = build((sql) => {
			if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];

			return [
				{ id: 'i-1', due_date: '2026-10-01', days_overdue: '0', amount: '100', system_currency: 'USD', status: 'Emitida' },
				{ id: 'i-2', due_date: '2026-09-01', days_overdue: '21', amount: '200', system_currency: 'USD', status: 'Vencida' },
				{ id: 'i-3', due_date: '2026-05-01', days_overdue: '144', amount: '300', system_currency: 'USD', status: 'Vencida' },
				{ id: 'i-4', due_date: null, days_overdue: '0', amount: '50', system_currency: 'USD', status: 'Enviada' },
			];
		});

		const result = await service.getReceivables('c-1', 'h-1', asOf);
		const byKey = Object.fromEntries(result.buckets.map((bucket) => [bucket.key, [bucket.amount, bucket.count]]));

		expect(byKey).toEqual({ current: [150, 2], d1_30: [200, 1], d31_60: [0, 0], d61_90: [0, 0], d90_plus: [300, 1] });
		expect(result.invoices).toHaveLength(4);
	});

	describe('getInvoices', () => {
		const invoicesImpl = (sql: string) => {
			if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];
			if (sql.includes('all_count')) return [{ all_count: '40', open_count: '12', overdue_count: '5', paid_count: '28' }];

			return [
				{
					id: 'i-1',
					invoice_number: 'FE3472',
					issue_date: '2026-09-08',
					due_date: '2026-08-08',
					status: 'Vencida',
					amount: '1883.70',
					invoice_currency: 'COP',
					amount_invoice_currency: '5821937.18',
					client_entity_id: 'e-1',
					legal_name: 'DREAM TEC SA',
					contract_number: 'CTR-73',
					days_overdue: 45,
				},
			];
		};

		it('filtra por estado, razón social y número; el total es el del estado pedido', async () => {
			const { service, query } = build(invoicesImpl);
			const page = await service.getInvoices('c-1', 'h-1', { status: 'overdue', entityId: 'e-1', search: ' FE34 ', limit: 2 }, asOf);
			const [listSql, listParams] = query.mock.calls[1] as [string, unknown[]];

			expect(listSql).toContain('i.due_date < $3::date');
			expect(listSql).toContain('i.client_entity_id = $5');
			expect(listSql).toContain('i.invoice_number ILIKE $6');
			expect(listParams).toEqual(['c-1', 'h-1', '2026-09-22', OPEN_INVOICE_STATUSES, 'e-1', '%FE34%']);
			expect(page).toMatchObject({ items: 5, pages: 3, currentPage: 1, limit: 2, counts: { all: 40, open: 12, overdue: 5, paid: 28 } });
			expect(page.data[0]).toMatchObject({ amount: 1883.7, legal_name: 'DREAM TEC SA', days_overdue: 45 });
		});

		it('ordena solo por columnas de la lista blanca', async () => {
			const { service, query } = build(invoicesImpl);

			await service.getInvoices('c-1', 'h-1', { sortBy: 'amount', sortOrder: 'asc' }, asOf);
			expect(query.mock.calls[1][0]).toContain('ORDER BY i.total_system_currency ASC NULLS LAST, i.id');
		});

		it('404 si el cliente no es del holding', async () => {
			const { service } = build((sql) => (sql.includes('FROM clients WHERE id') ? [] : [{}]));

			await expect(service.getInvoices('c-1', 'h-9', {}, asOf)).rejects.toBeInstanceOf(NotFoundException);
		});
	});
});
