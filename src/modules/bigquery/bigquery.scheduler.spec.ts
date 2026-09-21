import { BigQueryScheduler } from './bigquery.scheduler';

describe('BigQueryScheduler', () => {
	const buildScheduler = () => {
		const bigQueryService = {
			syncStripeCustomers: jest.fn().mockResolvedValue({ totalProcessed: 3, inserted: 2, updated: 1 }),
			syncSapiraQuantities: jest.fn().mockResolvedValue({
				holdingId: 'holding-1',
				range: { from: '2026-09-01', to: '2026-09-30' },
				ingest: {
					holdingId: 'holding-1',
					totalFromDwh: 4,
					discarded: 0,
					inserted: 3,
					updated: 1,
					unchanged: 0,
					changedInSource: 0,
					noQuantityData: 0,
				},
				integration: {
					holdingId: 'holding-1',
					totalProcessed: 4,
					integrated: 2,
					unmapped: 1,
					notVariable: 0,
					currencyMismatch: 0,
					blocked: 1,
					ambiguous: 0,
					conflict: 0,
				},
			}),
		};
		const holdingRepository = {
			findByIds: jest.fn().mockResolvedValue([{ id: 'holding-1', name: 'ACME' }]),
		};
		const bigQueryConnectionRepository = {
			find: jest.fn().mockResolvedValue([{ holding_id: 'holding-1', is_active: true }]),
		};
		const configService = { get: jest.fn().mockReturnValue(undefined) };

		const scheduler = new BigQueryScheduler(
			bigQueryService as any,
			holdingRepository as any,
			bigQueryConnectionRepository as any,
			configService as any
		);

		return { scheduler, bigQueryService, holdingRepository, bigQueryConnectionRepository };
	};

	it('sincroniza clientes Stripe e integra cantidades por cada holding activo', async () => {
		const { scheduler, bigQueryService } = buildScheduler();

		await (scheduler as any).executeFullSync();

		expect(bigQueryService.syncStripeCustomers).toHaveBeenCalledWith('holding-1');
		// Sin rango: el scheduler diario procesa el mes en curso, que es el default del servicio.
		expect(bigQueryService.syncSapiraQuantities).toHaveBeenCalledWith('holding-1');
		expect(bigQueryService.syncSapiraQuantities.mock.calls[0]).toHaveLength(1);
	});

	it('consulta el DWH una sola vez por holding para el canal de cantidades', async () => {
		const { scheduler, bigQueryService } = buildScheduler();

		await (scheduler as any).executeFullSync();

		// La detección de cambios y la cola de integración comparten la misma consulta:
		// no debe existir un segundo sync sobre finance.sapira_base.
		expect(bigQueryService.syncSapiraQuantities).toHaveBeenCalledTimes(1);
		expect((bigQueryService as Record<string, unknown>).syncSapiraBaseMonthly).toBeUndefined();
	});

	it('un error de cantidades en un holding no impide procesar el siguiente', async () => {
		const { scheduler, bigQueryService, holdingRepository, bigQueryConnectionRepository } = buildScheduler();
		bigQueryConnectionRepository.find.mockResolvedValue([
			{ holding_id: 'holding-1', is_active: true },
			{ holding_id: 'holding-2', is_active: true },
		]);
		holdingRepository.findByIds.mockResolvedValue([
			{ id: 'holding-1', name: 'ACME' },
			{ id: 'holding-2', name: 'GLOBEX' },
		]);
		bigQueryService.syncSapiraQuantities.mockRejectedValueOnce(new Error('BigQuery caído'));

		await expect((scheduler as any).executeFullSync()).resolves.toBeUndefined();

		expect(bigQueryService.syncSapiraQuantities).toHaveBeenCalledTimes(2);
		expect(bigQueryService.syncSapiraQuantities).toHaveBeenLastCalledWith('holding-2');
	});
});
