import { SalesforceSyncRunService } from './salesforce-sync-run.service';

describe('SalesforceSyncRunService', () => {
	const buildService = () => {
		const runUpdateQuery = {
			update: jest.fn().mockReturnThis(),
			set: jest.fn().mockReturnThis(),
			where: jest.fn().mockReturnThis(),
			execute: jest.fn().mockResolvedValue({ affected: 1 }),
		};
		const runRepository = {
			findOne: jest.fn(),
			update: jest.fn(),
			createQueryBuilder: jest.fn(() => runUpdateQuery),
		};
		const itemRepository = {
			update: jest.fn(),
		};
		const dataSource = {};

		return {
			service: new SalesforceSyncRunService(runRepository as any, itemRepository as any, dataSource as any),
			runRepository,
			itemRepository,
			runUpdateQuery,
		};
	};

	it('solicita cancelación y cancela ítems pendientes o reclamados', async () => {
		const { service, runRepository, itemRepository } = buildService();
		const run = {
			id: 'run-1',
			holding_id: 'holding-1',
			status: 'running',
		};
		runRepository.findOne.mockResolvedValueOnce(run).mockResolvedValueOnce({ ...run, status: 'cancellation_requested' });

		const result = await service.requestCancellation('holding-1', 'run-1');

		expect(runRepository.update).toHaveBeenCalledWith('run-1', { status: 'cancellation_requested' });
		expect(itemRepository.update).toHaveBeenCalledWith(
			expect.objectContaining({ run_id: 'run-1' }),
			{ status: 'cancelled' }
		);
		expect(result.status).toBe('cancellation_requested');
	});

	it('actualiza el progreso al completar un ítem', async () => {
		const { service, itemRepository, runUpdateQuery } = buildService();

		await service.completeItem({ id: 'item-1', run_id: 'run-1' } as any);

		expect(itemRepository.update).toHaveBeenCalledWith('item-1', expect.objectContaining({ status: 'completed' }));
		expect(runUpdateQuery.where).toHaveBeenCalledWith('id = :runId', { runId: 'run-1' });
		expect(runUpdateQuery.execute).toHaveBeenCalled();
	});

	it('no modifica una ejecución que ya finalizó', async () => {
		const { service, runRepository, itemRepository } = buildService();
		runRepository.findOne.mockResolvedValue({
			id: 'run-1',
			holding_id: 'holding-1',
			status: 'completed',
		});

		await service.requestCancellation('holding-1', 'run-1');

		expect(runRepository.update).not.toHaveBeenCalled();
		expect(itemRepository.update).not.toHaveBeenCalled();
	});
});
