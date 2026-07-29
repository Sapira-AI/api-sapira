import { SalesforceSyncRunWorker } from './salesforce-sync-run.worker';

describe('SalesforceSyncRunWorker', () => {
	it('no procesa ítems cuando la ejecución ya solicitó cancelación', async () => {
		const syncRunService = {
			recoverExpiredClaims: jest.fn(),
			acquireRunLock: jest.fn().mockResolvedValue(true),
			releaseRunLock: jest.fn(),
			getRunnableRuns: jest.fn().mockResolvedValue([
				{ id: 'run-1', holding_id: 'holding-1', status: 'cancellation_requested', type: 'process_final' },
			]),
			finishRunIfDone: jest.fn(),
			claimPendingItems: jest.fn(),
		};
		const syncCompleteService = {
			processOpportunitiesStaging: jest.fn(),
			syncOpportunitiesToStaging: jest.fn(),
		};
		const worker = new SalesforceSyncRunWorker(syncRunService as any, syncCompleteService as any);

		await worker.processPendingRuns();

		expect(syncRunService.claimPendingItems).not.toHaveBeenCalled();
		expect(syncRunService.finishRunIfDone).toHaveBeenCalledWith('run-1');
		expect(syncCompleteService.processOpportunitiesStaging).not.toHaveBeenCalled();
	});

	it('procesa a tablas finales solo después de una actualización de staging válida en retry_full', async () => {
		const item = { id: 'item-1', run_id: 'run-1', salesforce_opportunity_id: 'opp-1' };
		const syncRunService = {
			recoverExpiredClaims: jest.fn(),
			acquireRunLock: jest.fn().mockResolvedValue(true),
			releaseRunLock: jest.fn(),
			getRunnableRuns: jest.fn().mockResolvedValue([{ id: 'run-1', holding_id: 'holding-1', status: 'queued', type: 'retry_full' }]),
			getRun: jest.fn().mockResolvedValue({ id: 'run-1', holding_id: 'holding-1', status: 'running' }),
			finishRunIfDone: jest.fn(),
			claimPendingItems: jest.fn().mockResolvedValue([item]),
			completeItem: jest.fn(),
			failItem: jest.fn(),
		};
		const syncCompleteService = {
			syncOpportunitiesToStaging: jest.fn().mockResolvedValue({ success: true }),
			getOpportunityStagingStatus: jest.fn().mockResolvedValue({ status: 'update', errorMessage: null }),
			processOpportunitiesStaging: jest.fn().mockResolvedValue({ errors: [] }),
		};
		const worker = new SalesforceSyncRunWorker(syncRunService as any, syncCompleteService as any);

		await worker.processPendingRuns();

		expect(syncCompleteService.syncOpportunitiesToStaging).toHaveBeenCalledWith('holding-1', undefined, undefined, ['opp-1']);
		expect(syncCompleteService.processOpportunitiesStaging).toHaveBeenCalledWith('holding-1', ['opp-1']);
		expect(syncRunService.completeItem).toHaveBeenCalledWith(item);
		expect(syncRunService.failItem).not.toHaveBeenCalled();
	});
});
