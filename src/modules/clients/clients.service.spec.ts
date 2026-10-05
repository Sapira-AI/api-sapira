// ClientsService → BigQueryService → ConsumptionService arrastra `uuid` (ESM) por la cadena de facturas: se reemplaza como en contratos.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
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

	describe('ronda 3 de Configuración: país ISO y listas del holding', () => {
		const db = () => {
			const { service, clientRepository } = buildService();
			const repo = clientRepository as unknown as Record<string, jest.Mock>;

			repo.query.mockImplementation(async (sql: string) => {
				if (sql.includes('FROM countries WHERE code')) return [{ code: 'CL', name_es: 'Chile' }];
				if (sql.includes('FROM countries'))
					return [
						{ code: 'CL', name_es: 'Chile', name_en: 'Chile' },
						{ code: 'US', name_es: 'Estados Unidos', name_en: 'United States' },
					];
				if (sql.includes('FROM master_data'))
					return [
						{ category: 'markets', value: 'Latam' },
						{ category: 'segments', value: 'SMB' },
					];

				return [];
			});
			repo.create = jest.fn((value: unknown) => value);
			repo.save = jest.fn(async (value: unknown) => value);
			repo.findOne = jest.fn();

			return { service, repo };
		};

		it('alta: country_code manda y escribe el nombre en español; texto con alias → código', async () => {
			const { service } = db();

			await expect(service.create({ name_commercial: 'A', country_code: 'cl' } as never, 'h-1')).resolves.toMatchObject({
				country: 'Chile',
				country_code: 'CL',
				holding_id: 'h-1',
			});
			await expect(service.create({ name_commercial: 'B', country: 'EEUU' } as never, 'h-1')).resolves.toMatchObject({
				country: 'EEUU',
				country_code: 'US',
			});
			await expect(service.create({ name_commercial: 'C', country: 'Atlántida' } as never, 'h-1')).resolves.toMatchObject({
				country: 'Atlántida',
				country_code: null,
			});
		});

		it('mercado/segmento/industria: 400 si no está activo en la lista; el mismo valor viejo se conserva; vacío lo borra', async () => {
			const { service, repo } = db();

			await expect(service.create({ name_commercial: 'A', market: 'Latam', segment: 'SMB' } as never, 'h-1')).resolves.toMatchObject({
				market: 'Latam',
			});
			await expect(service.create({ name_commercial: 'A', industry: 'Minería' } as never, 'h-1')).rejects.toThrow(
				'La industria "Minería" no está en la lista del holding (Configuración › Catálogos)'
			);
			repo.findOne.mockResolvedValue({ id: 'c-1', holding_id: 'h-1', market: 'Viejo', segment: null });
			await expect(service.update('c-1', { market: 'Viejo', segment: '' } as never, 'h-1')).resolves.toMatchObject({
				market: 'Viejo',
				segment: null,
			});
			await expect(service.update('c-1', { market: 'Otro' } as never, 'h-1')).rejects.toThrow('El mercado "Otro" no está en la lista');
		});

		it('país ISO inexistente → 400', async () => {
			const { service, repo } = db();

			repo.query.mockResolvedValueOnce([]);
			await expect(service.create({ name_commercial: 'A', country_code: 'XX' } as never, 'h-1')).rejects.toThrow('País no reconocido: XX');
		});

		it('form-options: mercados, segmentos e industrias activos del holding', async () => {
			const { service } = db();

			// `renewal_notice_days` (ronda 4): ventana del aviso "vence pronto" del Cliente 360 (= auto_renewal_notice_days, default 30).
			await expect(service.getFormOptions('h-1')).resolves.toEqual({
				markets: ['Latam'],
				segments: ['SMB'],
				industries: [],
				renewal_notice_days: 30,
			});
		});
	});
});
