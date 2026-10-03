import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { QueryContractSubscriptionsDto } from './dtos/query-contract-subscriptions.dto';

/** Filtro por razón social de `GET /contracts/subscriptions` (pestaña Suscripciones del Razón social 360). */
describe('ContractSubscriptionsService · filtro por razón social', () => {
	const build = () => {
		const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) =>
			sql.includes('GROUP BY s.status') ? [{ status: 'active', count: '1' }] : []
		);
		const metrics = { systemCurrency: jest.fn().mockResolvedValue('USD') } as unknown as HoldingMetricsService;

		return { service: new ContractSubscriptionsService({ query } as unknown as DataSource, metrics), query };
	};

	it('acota lista y conteo a esa razón social, además del holding', async () => {
		const { service, query } = build();

		await service.list('h-1', { entityId: 'e-1', limit: 5 }, new Date('2026-10-02T12:00:00.000Z'));
		const [listSql, params] = query.mock.calls.find(([sql]) => sql.includes('LIMIT '))!;
		const [countSql] = query.mock.calls.find(([sql]) => sql.includes('GROUP BY s.status'))!;

		expect(params).toEqual(['h-1', '2026-10-02', 'e-1']);
		expect(listSql).toContain('s.client_entity_id = $3');
		expect(countSql).toContain('s.client_entity_id = $3');
	});

	it('el DTO acepta solo un UUID', async () => {
		expect(await validate(plainToInstance(QueryContractSubscriptionsDto, { entityId: 'no-es-uuid' }))).toHaveLength(1);
		expect(await validate(plainToInstance(QueryContractSubscriptionsDto, { entityId: '123e4567-e89b-12d3-a456-426614174000' }))).toHaveLength(0);
	});
});
