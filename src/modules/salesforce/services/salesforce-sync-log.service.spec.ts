import { SalesforceSyncLogService } from './salesforce-sync-log.service';

describe('SalesforceSyncLogService', () => {
	const buildService = () => {
		const insertMany = jest.fn().mockResolvedValue(undefined);
		const lean = jest.fn();
		const chain = {
			sort: jest.fn().mockReturnThis(),
			skip: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			lean: jest.fn().mockReturnThis(),
			exec: jest.fn().mockResolvedValue([]),
		};
		const syncLogModel = {
			insertMany,
			find: jest.fn(() => chain),
			countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(0) })),
		};
		const schedulerJobModel = {
			find: jest.fn(() => chain),
			countDocuments: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(0) })),
			findOne: jest.fn(() => ({ lean: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(null) })) })),
		};

		return {
			service: new SalesforceSyncLogService(syncLogModel as any, schedulerJobModel as any),
			syncLogModel,
			schedulerJobModel,
			insertMany,
			chain,
			lean,
		};
	};

	it('escribe la entrada con nivel info por defecto y marca de tiempo', async () => {
		const { service, insertMany } = buildService();

		await service.record({
			jobId: 'job-1',
			executionEnvironment: 'production',
			holdingId: 'holding-1',
			stage: 'holding',
			message: 'Inicio',
		});

		expect(insertMany).toHaveBeenCalledWith(
			[expect.objectContaining({ jobId: 'job-1', level: 'info', metadata: {}, occurredAt: expect.any(Date) })],
			{ ordered: false }
		);
	});

	it('conserva mensaje y traza al registrar un error', async () => {
		const { service, insertMany } = buildService();
		const error = new Error('Salesforce request timeout');

		await service.recordError(
			{ jobId: 'job-1', executionEnvironment: 'production', holdingId: 'holding-1', stage: 'staging', message: 'Falló el lote' },
			error
		);

		expect(insertMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					level: 'error',
					errorMessage: 'Salesforce request timeout',
					errorStack: error.stack,
				}),
			],
			{ ordered: false }
		);
	});

	it('no propaga el fallo de escritura de la bitácora', async () => {
		const { service, insertMany } = buildService();
		insertMany.mockRejectedValue(new Error('Mongo caído'));

		await expect(
			service.record({ jobId: 'job-1', executionEnvironment: 'production', stage: 'run', message: 'Inicio' })
		).resolves.toBeUndefined();
	});

	it('ignora la escritura cuando no hay entradas', async () => {
		const { service, insertMany } = buildService();

		await service.recordMany([]);

		expect(insertMany).not.toHaveBeenCalled();
	});

	it('filtra por holding, entorno, nivel y rango de fechas', async () => {
		const { service, syncLogModel } = buildService();

		await service.list({
			holdingId: 'holding-1',
			executionEnvironment: 'production',
			level: 'error',
			dateFrom: '2026-09-01T00:00:00.000Z',
			dateTo: '2026-09-08T00:00:00.000Z',
		});

		expect(syncLogModel.find).toHaveBeenCalledWith({
			holdingId: 'holding-1',
			executionEnvironment: 'production',
			level: 'error',
			occurredAt: { $gte: new Date('2026-09-01T00:00:00.000Z'), $lte: new Date('2026-09-08T00:00:00.000Z') },
		});
	});

	it('acota el tamaño de página al máximo permitido', async () => {
		const { service, chain } = buildService();

		const result = await service.list({ holdingId: 'holding-1', page: 3, limit: 5000 });

		expect(chain.limit).toHaveBeenCalledWith(200);
		expect(chain.skip).toHaveBeenCalledWith(400);
		expect(result).toMatchObject({ page: 3, limit: 200 });
	});

	it('filtra las corridas por holding usando los resultados por holding', async () => {
		const { service, schedulerJobModel } = buildService();

		await service.listJobs({ holdingId: 'holding-1', executionEnvironment: 'production', status: 'failed' });

		expect(schedulerJobModel.find).toHaveBeenCalledWith({
			executionEnvironment: 'production',
			status: 'failed',
			'holdingResults.holding_id': 'holding-1',
		});
	});
});
