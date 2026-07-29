import { SalesforceFieldMappingEngineService } from './salesforce-field-mapping-engine.service';

jest.mock('@/logger/app-logger.service', () => ({
	AppLoggerService: jest.fn().mockImplementation(() => ({
		setContext: jest.fn(),
		log: jest.fn(),
		error: jest.fn(),
		warn: jest.fn(),
		debug: jest.fn(),
	})),
}));

describe('SalesforceFieldMappingEngineService', () => {
	let service: SalesforceFieldMappingEngineService;
	let fieldMappingRepository: { find: jest.Mock };
	let quoteTypeMappingRepository: { findOne: jest.Mock };
	let salesforceMappingService: { ensureDefaultFieldMappings: jest.Mock };

	beforeEach(() => {
		fieldMappingRepository = {
			find: jest.fn(),
		};
		quoteTypeMappingRepository = {
			findOne: jest.fn(),
		};
		salesforceMappingService = {
			ensureDefaultFieldMappings: jest.fn().mockResolvedValue(undefined),
		};

		service = new SalesforceFieldMappingEngineService(
			fieldMappingRepository as any,
			quoteTypeMappingRepository as any,
			salesforceMappingService as any
		);
	});

	it('extracts array items using bracket syntax', () => {
		const result = (service as any).extractSourceValue(
			{
				country_id: ['CL', 'Chile'],
				parent: {
					aliases: ['Matriz', 'Filial'],
				},
			},
			'parent.aliases[1]'
		);

		expect(result).toBe('Filial');
	});

	it('maps bracket syntax values through buildMappedRecord', async () => {
		fieldMappingRepository.find.mockResolvedValue([
			{
				sapira_field: 'name_commercial',
				salesforce_field: 'aliases[0]',
				default_value: null,
				transformation_key: 'direct',
				object_type: 'client',
				is_active: true,
			},
		]);

		const result = await service.buildMappedRecord('holding-id', 'client', {
			Id: '001xx000003DHP0AAO',
			aliases: ['Cliente Holding', 'Cliente Secundario'],
		});

		expect(salesforceMappingService.ensureDefaultFieldMappings).toHaveBeenCalledWith('holding-id', 'client');
		expect(result).toEqual({
			name_commercial: 'Cliente Holding',
		});
	});

	it('applies explicit quote type transformation from mapping config', async () => {
		fieldMappingRepository.find.mockResolvedValue([
			{
				sapira_field: 'quote_type',
				salesforce_field: 'Type',
				default_value: 'NewBusiness',
				transformation_key: 'quote_type_mapping',
				object_type: 'opportunity',
				is_active: true,
			},
		]);
		quoteTypeMappingRepository.findOne.mockResolvedValue({
			sapira_quote_type: 'Upselling',
		});

		const result = await service.buildMappedRecord('holding-id', 'opportunity', {
			Id: '006xx000001234',
			Type: 'Cross Sell',
		});

		expect(result).toEqual({
			quote_type: 'Upselling',
		});
	});

	it('keeps backward compatibility when transformation key is missing', async () => {
		fieldMappingRepository.find.mockResolvedValue([
			{
				sapira_field: 'requires_contract_document',
				salesforce_field: 'Contrato__c',
				default_value: null,
				object_type: 'opportunity',
				is_active: true,
			},
		]);

		const result = await service.buildMappedRecord('holding-id', 'opportunity', {
			Id: '006xx000001234',
			Contrato__c: 'Sí',
		});

		expect(result).toEqual({
			requires_contract_document: true,
		});
	});

	it('normalizes tax_id while preserving significant separators', async () => {
		fieldMappingRepository.find.mockResolvedValue([
			{
				sapira_field: 'tax_id',
				salesforce_field: 'RUT__c',
				default_value: null,
				transformation_key: 'tax_id_normalized',
				object_type: 'client_entity',
				is_active: true,
			},
		]);

		const chileanResult = await service.buildMappedRecord('holding-id', 'client_entity', {
			RUT__c: '76.\u00a0517.784-7',
		});
		const brazilianResult = await service.buildMappedRecord('holding-id', 'client_entity', {
			RUT__c: '12.345.678/0001-95',
		});

		expect(chileanResult.tax_id).toBe('76517784-7');
		expect(brazilianResult.tax_id).toBe('12345678/0001-95');
	});

	it('omits an empty tax_id after normalization', async () => {
		fieldMappingRepository.find.mockResolvedValue([
			{
				sapira_field: 'tax_id',
				salesforce_field: 'RUT__c',
				default_value: null,
				transformation_key: 'tax_id_normalized',
				object_type: 'client_entity',
				is_active: true,
			},
		]);

		const result = await service.buildMappedRecord('holding-id', 'client_entity', {
			RUT__c: ' . \u00a0 ',
		});

		expect(result).toEqual({});
	});
});
