jest.mock('uuid', () => ({
	v4: () => 'job-1',
}));

import { RUN_LEASE_MS, SalesforceScheduler } from './salesforce.scheduler';

describe('SalesforceScheduler', () => {
	// 2026-09-08T12:00:00Z = 2026-09-08 08:00 en America/Santiago.
	const NOW = new Date('2026-09-08T12:00:00.000Z');
	const DAILY_JOB_ID = 'salesforce-daily-sync:qa:2026-09-08';

	beforeEach(() => {
		jest.useFakeTimers({ now: NOW });
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	const createScheduler = (syncEnabled = true) => {
		const syncCompleteService = {
			syncAllActiveConnectionsDaily: jest.fn().mockResolvedValue([]),
		};
		const save = jest.fn().mockResolvedValue(undefined);
		const updateOne = jest.fn().mockResolvedValue(undefined);
		const findOneAndUpdate = jest.fn().mockResolvedValue(null);
		const schedulerJobModel = Object.assign(
			jest.fn().mockImplementation(() => ({ save })),
			{ updateOne, findOneAndUpdate }
		);
		const configService = {
			get: jest.fn((key: string) => {
				if (key === 'SALESFORCE_SYNC_ENABLED') return syncEnabled ? 'true' : 'false';
				if (key === 'NODE_ENV') return 'qa';
				return undefined;
			}),
		};
		const syncLogService = {
			record: jest.fn(),
			recordMany: jest.fn(),
			recordError: jest.fn(),
		};

		return {
			scheduler: new SalesforceScheduler(syncCompleteService as any, schedulerJobModel as any, configService as any, syncLogService as any),
			syncCompleteService,
			save,
			updateOne,
			findOneAndUpdate,
			schedulerJobModel,
			syncLogService,
		};
	};

	const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

	it('ejecuta el flujo diario de staging para las conexiones activas', async () => {
		const { scheduler, syncCompleteService, save, updateOne, schedulerJobModel } = createScheduler();

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
		expect(schedulerJobModel).toHaveBeenCalledWith(expect.objectContaining({ executionEnvironment: 'qa' }));
		expect(updateOne).toHaveBeenCalledWith({ jobId: DAILY_JOB_ID }, expect.objectContaining({ status: 'completed' }));
	});

	it('usa un jobId determinista por entorno y día calendario de Santiago', async () => {
		const { scheduler, schedulerJobModel } = createScheduler();

		await scheduler.handleDailySync();

		expect(schedulerJobModel).toHaveBeenCalledWith(expect.objectContaining({ jobId: DAILY_JOB_ID, status: 'running' }));
	});

	it('propaga el contexto de bitácora (job y entorno) a la sincronización', async () => {
		const { scheduler, syncCompleteService, syncLogService } = createScheduler();

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledWith({
			jobId: DAILY_JOB_ID,
			executionEnvironment: 'qa',
		});
		expect(syncLogService.record).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: DAILY_JOB_ID, executionEnvironment: 'qa', stage: 'run' })
		);
	});

	it('no ejecuta la sincronización cuando otra réplica ya tomó la corrida del día', async () => {
		const { scheduler, syncCompleteService, save, findOneAndUpdate, syncLogService } = createScheduler();
		save.mockRejectedValue(duplicateKeyError());

		await scheduler.handleDailySync();

		// El lease sigue vigente, así que no hay nada que retomar.
		expect(findOneAndUpdate).toHaveBeenCalledWith(
			{ jobId: DAILY_JOB_ID, status: 'running', startedAt: { $lt: new Date(NOW.getTime() - RUN_LEASE_MS) } },
			expect.objectContaining({ $set: expect.objectContaining({ startedAt: NOW }) }),
			{ new: true }
		);
		expect(syncCompleteService.syncAllActiveConnectionsDaily).not.toHaveBeenCalled();
		expect(syncLogService.record).not.toHaveBeenCalled();
	});

	it('retoma la corrida cuando el lease de la réplica anterior venció', async () => {
		const { scheduler, syncCompleteService, save, findOneAndUpdate, updateOne } = createScheduler();
		save.mockRejectedValue(duplicateKeyError());
		findOneAndUpdate.mockResolvedValue({ jobId: DAILY_JOB_ID, status: 'running' });

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledTimes(1);
		expect(updateOne).toHaveBeenCalledWith({ jobId: DAILY_JOB_ID }, expect.objectContaining({ status: 'completed' }));
	});

	it('propaga los errores de Mongo que no sean de clave duplicada', async () => {
		const { scheduler, syncCompleteService, save } = createScheduler();
		save.mockRejectedValue(new Error('Mongo no disponible'));

		await expect(scheduler.handleDailySync()).rejects.toThrow('Mongo no disponible');
		expect(syncCompleteService.syncAllActiveConnectionsDaily).not.toHaveBeenCalled();
	});

	it('la corrida forzada usa un jobId propio para no competir con la del día', async () => {
		const { scheduler, syncCompleteService, schedulerJobModel } = createScheduler();

		await scheduler.runManualSync();

		expect(schedulerJobModel).toHaveBeenCalledWith(expect.objectContaining({ jobId: `${DAILY_JOB_ID}:manual:job-1` }));
		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledTimes(1);
	});

	it('registra en la bitácora el error crítico de la corrida', async () => {
		const { scheduler, syncCompleteService, syncLogService, updateOne } = createScheduler();
		syncCompleteService.syncAllActiveConnectionsDaily.mockRejectedValue(new Error('Fallo crítico'));

		await scheduler.handleDailySync();

		expect(updateOne).toHaveBeenCalledWith({ jobId: DAILY_JOB_ID }, expect.objectContaining({ status: 'failed' }));
		expect(syncLogService.recordError).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: DAILY_JOB_ID, executionEnvironment: 'qa', stage: 'run' }),
			expect.any(Error)
		);
	});

	it('no crea jobs ni sincroniza cuando SALESFORCE_SYNC_ENABLED es false', async () => {
		const { scheduler, syncCompleteService, save, updateOne, syncLogService } = createScheduler(false);

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(updateOne).not.toHaveBeenCalled();
		expect(syncLogService.record).not.toHaveBeenCalled();
	});
});
