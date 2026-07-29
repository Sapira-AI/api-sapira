jest.mock('uuid', () => ({
	v4: () => 'job-1',
}));

import { SalesforceScheduler } from './salesforce.scheduler';

describe('SalesforceScheduler', () => {
	it('ejecuta el flujo diario de staging para las conexiones activas', async () => {
		const syncCompleteService = {
			syncAllActiveConnectionsDaily: jest.fn().mockResolvedValue([]),
		};
		const save = jest.fn().mockResolvedValue(undefined);
		const updateOne = jest.fn().mockResolvedValue(undefined);
		const schedulerJobModel = Object.assign(jest.fn().mockImplementation(() => ({ save })), { updateOne });
		const scheduler = new SalesforceScheduler(syncCompleteService as any, schedulerJobModel as any);

		await scheduler.handleDailySync();

		expect(syncCompleteService.syncAllActiveConnectionsDaily).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledTimes(1);
		expect(updateOne).toHaveBeenCalledWith(
			{ jobId: 'job-1' },
			expect.objectContaining({ status: 'completed' })
		);
	});
});
