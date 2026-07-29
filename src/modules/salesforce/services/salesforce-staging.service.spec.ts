import { SalesforceStagingService } from './salesforce-staging.service';

describe('SalesforceStagingService', () => {
	const buildService = () => {
		const accountsStgRepository = {
			createQueryBuilder: jest.fn(),
		};
		const opportunitiesStgRepository = {
			findAndCount: jest.fn(),
		};

		const service = new SalesforceStagingService(accountsStgRepository as any, opportunitiesStgRepository as any, {} as any, {} as any, {} as any);

		return {
			service,
			accountsStgRepository,
			opportunitiesStgRepository,
		};
	};

	it('arma la respuesta paginada de la vista de mapeo de accounts', async () => {
		const { service } = buildService();
		const queryBuilder = {
			clone: jest.fn().mockReturnThis(),
			orderBy: jest.fn().mockReturnThis(),
			skip: jest.fn().mockReturnThis(),
			take: jest.fn().mockReturnThis(),
			getRawMany: jest.fn().mockResolvedValue([{ salesforce_id: '001' }]),
		};

		jest.spyOn(service as any, 'buildAccountsMappingBaseQuery').mockReturnValue(queryBuilder);
		jest.spyOn(service as any, 'applyMappingStateFilter').mockImplementation(() => undefined);
		jest.spyOn(service as any, 'buildAccountsMappingSummary').mockResolvedValue({
			total: 10,
			mapped: 6,
			unmapped: 4,
			outdated: 2,
		});
		jest.spyOn(service as any, 'countDistinctAccounts').mockResolvedValue(10);
		jest.spyOn(service as any, 'getAvailableCountries').mockResolvedValue(['Chile', 'México']);
		jest.spyOn(service as any, 'selectAccountsMappingViewColumns').mockReturnValue(queryBuilder);
		jest.spyOn(service as any, 'buildAccountsMappingViewItem').mockReturnValue({
			salesforce_id: '001',
			is_mapped: false,
			is_outdated: false,
			outdated_fields: [],
		});

		const result = await service.getAccountsMappingView('holding-1', {
			page: 2,
			limit: 25,
			mappingState: 'mapped',
		});

		expect((service as any).applyMappingStateFilter).toHaveBeenCalledWith(queryBuilder, 'mapped');
		expect(queryBuilder.skip).toHaveBeenCalledWith(25);
		expect(queryBuilder.take).toHaveBeenCalledWith(25);
		expect(result).toEqual({
			items: [
				{
					salesforce_id: '001',
					is_mapped: false,
					is_outdated: false,
					outdated_fields: [],
				},
			],
			total: 10,
			page: 2,
			limit: 25,
			totalPages: 1,
			summary: {
				total: 10,
				mapped: 6,
				unmapped: 4,
				outdated: 2,
			},
			availableCountries: ['Chile', 'México'],
		});
	});

	it('lista oportunidades pendientes por los estados create y update en una sola página', async () => {
		const { service, opportunitiesStgRepository } = buildService();
		opportunitiesStgRepository.findAndCount.mockResolvedValue([[{ salesforce_id: '006' }], 51]);

		const result = await service.getRecords('holding-1', 'opportunities', {
			statuses: ['create', 'update'],
			page: 2,
			limit: 50,
		});

		expect(opportunitiesStgRepository.findAndCount).toHaveBeenCalledWith(
			expect.objectContaining({
				skip: 50,
				take: 50,
				where: expect.objectContaining({ holding_id: 'holding-1' }),
			})
		);
		const where = opportunitiesStgRepository.findAndCount.mock.calls[0][0].where;
		expect(where.processing_status).toEqual(expect.objectContaining({ _value: ['create', 'update'] }));
		expect(result).toEqual({
			items: [{ salesforce_id: '006' }],
			total: 51,
			page: 2,
			limit: 50,
			totalPages: 2,
		});
	});
});
