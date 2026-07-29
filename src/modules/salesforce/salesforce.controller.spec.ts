jest.mock('@/logger/app-logger.service', () => ({
	AppLoggerService: class AppLoggerService {},
}));

import { SalesforceController } from './salesforce.controller';

describe('SalesforceController', () => {
	it('normaliza tax_id usando exclusivamente el holding del header', async () => {
		const salesforceService = {
			normalizeTaxIds: jest.fn().mockResolvedValue({
				holdingId: 'holding-1',
				evaluated: 3,
				normalized: 1,
				unchanged: 2,
			}),
		};
		const controller = new SalesforceController(salesforceService as any);

		await expect(controller.normalizeTaxIds('holding-1')).resolves.toEqual({
			holdingId: 'holding-1',
			evaluated: 3,
			normalized: 1,
			unchanged: 2,
		});
		expect(salesforceService.normalizeTaxIds).toHaveBeenCalledWith('holding-1');
	});

	it('consulta duplicados usando exclusivamente el holding del header', async () => {
		const salesforceService = {
			getDuplicateClientEntitiesTaxIds: jest.fn().mockResolvedValue({
				items: [],
				total: 0,
				page: 1,
				limit: 50,
				totalPages: 1,
			}),
		};
		const controller = new SalesforceController(salesforceService as any);
		const query = { page: 1, limit: 50 };

		await expect(controller.getDuplicateClientEntitiesTaxIds('holding-1', query)).resolves.toEqual({
			items: [],
			total: 0,
			page: 1,
			limit: 50,
			totalPages: 1,
		});
		expect(salesforceService.getDuplicateClientEntitiesTaxIds).toHaveBeenCalledWith('holding-1', query);
	});

	it('consulta entidades pendientes usando exclusivamente el holding del header', async () => {
		const result = [
			{
				clientEntityId: 'entity-1',
				legalName: 'pendiente',
				taxId: null,
				salesforceAccountId: '001000000000001',
			},
		];
		const salesforceService = {
			getPendingClientEntitiesSalesforceSource: jest.fn().mockResolvedValue(result),
		};
		const controller = new SalesforceController(salesforceService as any);

		await expect(controller.getPendingClientEntitiesSalesforceSource('holding-1')).resolves.toEqual(result);
		expect(salesforceService.getPendingClientEntitiesSalesforceSource).toHaveBeenCalledWith('holding-1');
	});
});
