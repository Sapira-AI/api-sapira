import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientQuotesService } from './client-quotes.service';

const build = (impl: (sql: string, params: unknown[]) => unknown[]) => {
	const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));

	return { service: new ClientQuotesService({ query } as unknown as DataSource), query };
};

const stages = [
	{ id: 's-1', name: 'Enviada', color: '#3b82f6', position: 1, count: '8' },
	{ id: 's-2', name: 'Contrato creado', color: '#94a3b8', position: 5, count: '4' },
];

const impl = (sql: string) => {
	if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];
	if (sql.includes('FROM quote_stages qs')) return stages;

	return [
		{
			id: 'q-1',
			quote_number: 'COT-12',
			quote_date: '2026-09-01',
			currency: 'MXN',
			total_amount: '236436',
			stage_id: 's-2',
			stage_name: 'Contrato creado',
			stage_color: '#94a3b8',
			seller_name: 'Salvador Cabrera',
			contact_name: null,
			items_count: '1',
			contract_id: null,
		},
	];
};

describe('ClientQuotesService', () => {
	it('lista con etapas del holding y su conteo; el total es el de la etapa pedida', async () => {
		const { service, query } = build(impl);
		const page = await service.getQuotes('c-1', 'h-1', { stageId: 's-1', search: ' COT ', limit: 5 });
		const [listSql, listParams] = query.mock.calls[1] as [string, unknown[]];
		const [stagesSql, stagesParams] = query.mock.calls[2] as [string, unknown[]];

		expect(listSql).toContain('q.quote_number ILIKE $3');
		expect(listSql).toContain('AND q.quote_stage_id = $4');
		expect(listParams).toEqual(['c-1', 'h-1', '%COT%', 's-1']);
		// El conteo por etapa no filtra por etapa (cada chip muestra su total).
		expect(stagesSql).not.toContain('quote_stage_id = $4');
		expect(stagesParams).toEqual(['c-1', 'h-1', '%COT%']);
		expect(page).toMatchObject({
			items: 8,
			pages: 2,
			all_count: 12,
			stages: [
				{ id: 's-1', count: 8 },
				{ id: 's-2', count: 4 },
			],
		});
		expect(page.data[0]).toMatchObject({ total_amount: 236436, stage: { name: 'Contrato creado' }, contract: null, items_count: 1 });
	});

	it('ordena solo por columnas de la lista blanca', async () => {
		const { service, query } = build(impl);

		await service.getQuotes('c-1', 'h-1', { sortBy: 'stage', sortOrder: 'asc' });
		expect(query.mock.calls[1][0]).toContain('ORDER BY qs.position ASC NULLS LAST, q.id');
	});

	it('404 si el cliente o la cotización no son del holding', async () => {
		const { service } = build(() => []);

		await expect(service.getQuotes('c-1', 'h-9', {})).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.getQuoteItems('c-1', 'q-1', 'h-9')).rejects.toBeInstanceOf(NotFoundException);
	});
});
