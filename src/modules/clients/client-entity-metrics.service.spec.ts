import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientEntityMetricsService } from './client-entity-metrics.service';

describe('ClientEntityMetricsService', () => {
	const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

		return { service: new ClientEntityMetricsService({ query } as unknown as DataSource), query };
	};
	const asOf = new Date('2026-09-22T12:00:00.000Z');
	const entityRow = { id: 'e-1', legal_name: 'Andes SpA', tax_id: '76.123.456-7', odoo_partner_id: '4471' };

	it('responde 404 si la razón social no es del holding', async () => {
		const { service, query } = build(() => []);

		await expect(service.getDetail('e-1', 'h-1', asOf)).rejects.toBeInstanceOf(NotFoundException);
		expect(query.mock.calls[0][1]).toEqual(['e-1', 'h-1']);
	});

	it('devuelve la razón social con sus clientes comerciales y su aporte a la cartera', async () => {
		const { service } = build((sql) =>
			sql.includes('FROM client_entities')
				? [entityRow]
				: [
						{
							id: 'c-1',
							name_commercial: 'Andes',
							is_primary: true,
							active_contracts: '2',
							receivable: '100.5',
							overdue: '40',
							invoiced_12m: '900',
						},
					]
		);

		const detail = await service.getDetail('e-1', 'h-1', asOf);

		expect(detail.odoo_partner_id).toBe(4471);
		expect(detail.clients).toEqual([
			{
				id: 'c-1',
				name_commercial: 'Andes',
				client_number: null,
				status: null,
				is_primary: true,
				active_contracts: 2,
				receivable: 100.5,
				overdue: 40,
				invoiced_12m: 900,
			},
		]);
	});

	it('pagina facturas y filtra por cliente comercial y vencidas', async () => {
		const { service, query } = build((sql) => {
			if (sql.includes('FROM client_entities')) return [entityRow];
			if (sql.includes('COUNT(*) AS total')) return [{ total: '45' }];

			return [{ id: 'i-1', invoice_number: 'F-1', status: 'Vencida', amount: '10', days_overdue: '12', client_name: 'Andes' }];
		});

		const page = await service.getInvoices('e-1', 'h-1', { page: 2, limit: 20, clientId: 'c-1', status: 'overdue' }, asOf);

		expect(page).toMatchObject({ items: 45, pages: 3, currentPage: 2, limit: 20 });
		expect(page.data[0]).toMatchObject({ invoice_number: 'F-1', days_overdue: 12, amount: 10 });
		const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('LIMIT'))!;

		expect(sql).toContain('OFFSET 20');
		expect(sql).toContain('i.due_date < $3::date');
		expect(sql).toContain('i.client_id = $5');
		expect(params).toEqual(['e-1', 'h-1', '2026-09-22', ['Emitida', 'Enviada', 'Vencida'], 'c-1']);
	});
});
