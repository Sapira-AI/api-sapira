import { Repository } from 'typeorm';

import { ClientEntityClient } from '@/databases/postgresql/entities/clientes/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { BigQueryService } from '@/modules/bigquery/bigquery.service';

import { ClientsService } from './clients.service';

describe('ClientsService', () => {
	const buildService = () => {
		const clientRepository = { findAndCount: jest.fn().mockResolvedValue([[], 0]), query: jest.fn() };
		const service = new ClientsService(
			clientRepository as unknown as Repository<Client>,
			{} as Repository<ClientEntity>,
			{} as Repository<ClientEntityClient>,
			{} as BigQueryService
		);
		return { service, clientRepository };
	};

	it('ordena por created_at desc por defecto, con desempate por id', async () => {
		const { service, clientRepository } = buildService();

		await service.findAll({}, 'h-1');

		expect(clientRepository.findAndCount).toHaveBeenCalledWith(
			expect.objectContaining({ order: { created_at: { direction: 'DESC', nulls: 'LAST' }, id: 'ASC' }, where: { holding_id: 'h-1' } })
		);
	});

	it('ordena por la columna y dirección pedidas', async () => {
		const { service, clientRepository } = buildService();

		await service.findAll({ sort_by: 'name_commercial', sort_order: 'asc', page: 2, limit: 25 }, 'h-1');

		expect(clientRepository.findAndCount).toHaveBeenCalledWith(
			expect.objectContaining({ order: { name_commercial: { direction: 'ASC', nulls: 'LAST' }, id: 'ASC' }, skip: 25, take: 25 })
		);
	});

	it('devuelve las opciones de filtro ordenadas y vacías cuando no hay valores', async () => {
		const { service, clientRepository } = buildService();
		clientRepository.query.mockResolvedValue([
			{ segment: ['Small', 'Medium', 'Enterprise'], industry: null, market: ['Latam'], country: ['Perú', 'Chile'], status: ['Activo'] },
		]);

		const options = await service.getFilterOptions('h-1');

		expect(clientRepository.query.mock.calls[0][1]).toEqual(['h-1']);
		expect(options).toEqual({
			segment: ['Enterprise', 'Medium', 'Small'],
			industry: [],
			market: ['Latam'],
			country: ['Chile', 'Perú'],
			status: ['Activo'],
		});
	});

	it('adjunta el estado calculado a cada cliente de la página', async () => {
		const { service, clientRepository } = buildService();

		clientRepository.findAndCount.mockResolvedValue([[{ id: 'c-1' }, { id: 'c-2' }], 2]);
		clientRepository.query.mockResolvedValue([
			{ id: 'c-1', lifecycle: 'active' },
			{ id: 'c-2', lifecycle: 'prospect' },
		]);

		const page = await service.findAll({}, 'h-1');

		expect(page.data.map((client) => client.lifecycle_status)).toEqual(['active', 'prospect']);
		expect(clientRepository.query.mock.calls[0][1]).toEqual([['c-1', 'c-2']]);
	});

	it('filtra por estado calculado dentro del holding', async () => {
		const { service, clientRepository } = buildService();

		await service.findAll({ lifecycle: 'churned' }, 'h-1');
		const where = clientRepository.findAndCount.mock.calls[0][0].where;

		expect(where.holding_id).toBe('h-1');
		expect(where.id.getSql('"Client"."id"')).toContain('cl.holding_id = :lifecycleHolding');
		expect(where.id.objectLiteralParameters).toEqual({ lifecycleHolding: 'h-1', lifecycle: 'churned' });
	});
});
