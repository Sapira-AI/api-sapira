jest.mock('@/logger/app-logger.service', () => ({
	AppLoggerService: class AppLoggerService {},
}));

import { SalesforceService } from './salesforce.service';
describe('SalesforceService', () => {
	it('consulta directamente los Accounts pendientes en Salesforce usando OR', async () => {
		const typeormService = {
			getPendingClientEntitiesSalesforceLinks: jest.fn(),
		};
		const queryService = {
			executeQuery: jest.fn().mockResolvedValue({
				data: {
					records: [
						{
							Id: '001000000000001',
							BusinessName__c: 'Razón Social Salesforce',
							RUT__c: '76.517.784-7',
							LastModifiedDate: '2026-07-29T12:00:00.000+0000',
						},
					],
				},
			}),
		};
		const service = new SalesforceService(
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			queryService as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			typeormService as any,
			{} as any
		);

		await expect(service.getPendingClientEntitiesSalesforceSource('holding-1')).resolves.toEqual([
			{
				salesforceAccountId: '001000000000001',
				salesforceBusinessName: 'Razón Social Salesforce',
				salesforceRut: '76.517.784-7',
				salesforceLastModifiedDate: '2026-07-29T12:00:00.000+0000',
			},
		]);
		expect(queryService.executeQuery).toHaveBeenCalledWith(
			expect.stringContaining("WHERE RUT__c = 'pendiente'"),
			'holding-1'
		);
		expect(queryService.executeQuery.mock.calls[0][0]).toContain("OR BusinessName__c = 'pendiente'");
	});
});
