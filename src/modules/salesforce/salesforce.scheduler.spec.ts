jest.mock('uuid', () => ({
	v4: () => 'job-1',
}));

import { SalesforceScheduler } from './salesforce.scheduler';

describe('SalesforceScheduler', () => {
	const createScheduler = (syncEnabled = true) => {
		const syncCompleteService = {
			syncAllActiveConnectionsDaily: jest.fn().mockResolvedValue([]),
		};
		const save = jest.fn().mockResolvedValue(undefined);
		const updateOne = jest.fn().mockResolvedValue(undefined);
		const schedulerJobModel = Object.assign(
			jest.fn().mockImplementation(() => ({ save })),
			{ updateOne }
		);
		const configService = {
			get: jest.fn((key: string) => {
				if (key === 'SALESFORCE_SYNC_ENABLED') return syncEnabled ? 'true' : 'false';
				if (key === 'NODE_ENV') return 'qa';
				return undefined;
			}),
		};

		return {
			scheduler: new SalesforceScheduler(syncCompleteService as any, schedulerJobModel as any, configService as any),
			syncCompleteService,
			save,
			updateOne,
			schedulerJobModel,
		};
	};

	it('ejecuta el flujo diario de staging para las conexiones activas', async () => {
		const { scheduler, syncCompleteService, save, updateOne, schedulerJobModel } = createScheduler();

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
		expect(schedulerJobModel).toHaveBeenCalledWith(expect.objectContaining({ executionEnvironment: 'qa' }));
		expect(updateOne).toHaveBeenCalledWith({ jobId: 'job-1' }, expect.objectContaining({ status: 'completed' }));
	});

	it('no crea jobs ni sincroniza cuando SALESFORCE_SYNC_ENABLED es false', async () => {
		const { scheduler, syncCompleteService, save, updateOne } = createScheduler(false);

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
		expect(updateOne).not.toHaveBeenCalled();
	});
});
