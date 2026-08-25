jest.mock('@/logger/app-logger.service', () => ({
	AppLoggerService: class AppLoggerService {},
}));

import { SalesforceSyncCompleteService } from './salesforce-sync-complete.service';

describe('SalesforceSyncCompleteService', () => {
	const buildService = () => {
		const connectionRepository = {
			findOne: jest.fn(),
			update: jest.fn(),
		};
		const clientRepository = {
			update: jest.fn(),
			create: jest.fn(),
			save: jest.fn(),
			findOne: jest.fn(),
		};
		const clientEntityRepository = {
			find: jest.fn(),
			findOne: jest.fn(),
			update: jest.fn(),
			create: jest.fn(),
			save: jest.fn(),
		};
		const quoteRepository = {
			findOne: jest.fn(),
		};
		const quoteItemRepository = {};
		const accountsStgRepository = {
			find: jest.fn(),
			findOne: jest.fn(),
			update: jest.fn(),
		};
		const opportunitiesStgRepository = {
			find: jest.fn(),
			update: jest.fn(),
		};
		const lineItemsStgRepository = {
			find: jest.fn(),
			update: jest.fn(),
		};
		const queryService = {
			executeQuery: jest.fn(),
		};
		const typeormService = {
			getObjectMapping: jest.fn(),
			getClientByNumber: jest.fn(),
			ensureMasterDataValue: jest.fn(),
			createObjectMapping: jest.fn(),
			createQuoteIfAbsent: jest.fn(),
			createQuoteItems: jest.fn(),
			hasClientContact: jest.fn(),
			getClientContact: jest.fn(),
			updateClientContact: jest.fn(),
			createClientContact: jest.fn(),
			resolveClientEntitiesByTaxId: jest.fn().mockResolvedValue({ entities: [] }),
			updateClientEntityClient: jest.fn(),
			createClientEntityClient: jest.fn(),
			getSalesforceProductMapping: jest.fn().mockResolvedValue(null),
		};
		const fieldMappingEngine = {
			buildMappedRecord: jest.fn(),
		};
		const stagingService = {
			createRunContext: jest.fn(() => ({
				batchId: 'batch-1',
				syncSessionId: 'session-1',
			})),
			upsertAccounts: jest.fn(),
			upsertOpportunities: jest.fn(),
			getOpportunityStagingIds: jest.fn(),
			upsertLineItems: jest.fn(),
			getSourceHash: jest.fn((payload: Record<string, unknown>) => JSON.stringify(payload)),
		};
		const genericVatsService = {
			isGenericExportVat: jest.fn().mockResolvedValue(false),
		};
		const odooPartnersService = {
			resolveAndLinkPartnerForEntityId: jest.fn().mockResolvedValue({ status: 'not_found' }),
		};
		const notificationsService = {
			createOrUpdate: jest.fn(),
			resolveByDeduplicationKey: jest.fn(),
		};

		const service = new SalesforceSyncCompleteService(
			connectionRepository as any,
			clientRepository as any,
			clientEntityRepository as any,
			quoteRepository as any,
			quoteItemRepository as any,
			accountsStgRepository as any,
			opportunitiesStgRepository as any,
			lineItemsStgRepository as any,
			queryService as any,
			typeormService as any,
			fieldMappingEngine as any,
			stagingService as any,
			genericVatsService as any,
			odooPartnersService as any,
			notificationsService as any
		);

		return {
			service,
			connectionRepository,
			clientRepository,
			clientEntityRepository,
			quoteRepository,
			accountsStgRepository,
			opportunitiesStgRepository,
			lineItemsStgRepository,
			queryService,
			typeormService,
			fieldMappingEngine,
			stagingService,
			genericVatsService,
			notificationsService,
			odooPartnersService,
		};
	};

	it('en la sincronización diaria consulta siete días y procesa solo staging create', async () => {
		const { service } = buildService();
		jest.spyOn(service as any, 'getSantiagoCalendarDayRange').mockReturnValue({
			start: '2026-01-19T03:00:00.000Z',
			end: '2026-01-26T03:00:00.000Z',
		});
		jest.spyOn(service as any, 'fetchDailyChangedOpportunityIds').mockResolvedValue(['opp-1']);
		jest.spyOn(service, 'syncOpportunitiesToStaging').mockResolvedValue({
			success: true,
			importedAccounts: 1,
			importedOpportunities: 1,
			importedLineItems: 1,
			batchId: 'batch-1',
			syncSessionId: 'session-1',
			summary: {},
			unmappedProducts: [],
		});
		const processAccounts = jest.spyOn(service as any, 'processAccountStaging').mockResolvedValue(undefined);
		const classifyOpportunities = jest.spyOn(service as any, 'classifyOpportunityStaging').mockResolvedValue(undefined);
		const processOpportunities = jest.spyOn(service as any, 'processOpportunityStaging').mockResolvedValue(undefined);

		const result = await service.syncDailyModifiedOpportunities('holding-1');

		expect(result).toMatchObject({ success: true, stats: { opportunities: 1 } });
		expect((service as any).fetchDailyChangedOpportunityIds).toHaveBeenCalledWith(
			'holding-1',
			'2026-01-19T03:00:00.000Z',
			'2026-01-26T03:00:00.000Z'
		);
		expect(processAccounts).toHaveBeenCalledWith(
			'holding-1',
			'batch-1',
			expect.any(Object),
			{ processingStatuses: ['create'] }
		);
		expect(classifyOpportunities).toHaveBeenCalledWith('holding-1', 'batch-1', { insertOnly: true });
		expect(processOpportunities).toHaveBeenCalledWith(
			'holding-1',
			'batch-1',
			expect.any(Object),
			{ processingStatuses: ['create'], insertOnly: true }
		);
	});

	it('calcula un rango de siete días de Santiago que incluye el día actual', () => {
		const { service } = buildService();

		const range = (service as any).getSantiagoCalendarDayRange(7, new Date('2026-01-25T15:00:00.000Z'));

		expect(range).toEqual({
			start: '2026-01-19T03:00:00.000Z',
			end: '2026-01-26T03:00:00.000Z',
		});
	});

	it('omite una cotización existente antes de procesar cliente o ítems', async () => {
		const { service, opportunitiesStgRepository, lineItemsStgRepository, quoteRepository, typeormService, clientRepository } = buildService();
		opportunitiesStgRepository.find.mockResolvedValue([
			{
				id: 'opp-stg-1',
				salesforce_id: 'opp-1',
				raw_data: { Id: 'opp-1', AccountId: 'account-1' },
			},
		]);
		typeormService.getObjectMapping.mockResolvedValue('quote-1');
		quoteRepository.findOne.mockResolvedValue({ id: 'quote-1' });

		await (service as any).classifyOpportunityStaging('holding-1', 'batch-1', { insertOnly: true });

		expect(opportunitiesStgRepository.update).toHaveBeenCalledWith(
			'opp-stg-1',
			expect.objectContaining({ processing_status: 'processed', integration_notes: expect.stringContaining('omitida') })
		);
		expect(lineItemsStgRepository.update).toHaveBeenCalledWith(
			expect.objectContaining({ holding_id: 'holding-1', salesforce_opportunity_id: 'opp-1' }),
			expect.objectContaining({ processing_status: 'processed' })
		);
		expect(clientRepository.update).not.toHaveBeenCalled();
		expect(typeormService.createQuoteIfAbsent).not.toHaveBeenCalled();
		expect(typeormService.createQuoteItems).not.toHaveBeenCalled();
	});

	it('importa accounts a staging usando el filtro por fechas y clasifica el batch', async () => {
		const { service, connectionRepository, queryService, stagingService } = buildService();
		connectionRepository.findOne.mockResolvedValue({ holding_id: 'holding-1', is_active: true });
		queryService.executeQuery.mockResolvedValue({
			data: {
				records: [{ Id: '001', Name: 'Acme SPA' }],
			},
		});

		const classifySpy = jest.spyOn(service as any, 'classifyAccountStaging').mockResolvedValue(undefined);

		const result = await service.syncAccountsToStaging('holding-1', {
			dateFrom: '2026-01-01',
			dateTo: '2026-01-31',
		});

		expect(queryService.executeQuery).toHaveBeenCalledWith(expect.stringContaining('FROM Opportunity'), 'holding-1');
		expect(stagingService.upsertAccounts).toHaveBeenCalledWith('holding-1', [{ Id: '001', Name: 'Acme SPA' }], 'batch-1', 'session-1');
		expect(classifySpy).toHaveBeenCalledWith('holding-1', 'batch-1');
		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				imported: 1,
				batchId: 'batch-1',
				syncSessionId: 'session-1',
			})
		);
	});

	it('clasifica un tax_id no genérico repetido sin marcar el staging como error', async () => {
		const { service, accountsStgRepository, clientRepository, fieldMappingEngine, typeormService } = buildService();
		accountsStgRepository.find.mockResolvedValue([
			{
				id: 'staging-1',
				raw_data: { Id: 'account-1', Name: 'Cliente duplicado' },
			},
		]);
		fieldMappingEngine.buildMappedRecord
			.mockResolvedValueOnce({ client_number: 'C-1' })
			.mockResolvedValueOnce({ tax_id: '76517784-7', legal_name: 'Cliente duplicado' });
		typeormService.getObjectMapping.mockResolvedValue('client-1');
		typeormService.resolveClientEntitiesByTaxId.mockResolvedValue({
			entities: [
				{ id: 'entity-1', legal_name: 'Cliente duplicado' },
				{ id: 'entity-2', legal_name: 'Cliente duplicado' },
			],
		});
		clientRepository.findOne.mockResolvedValue({ id: 'client-1', client_number: 'C-1' });

		await (service as any).classifyAccountStaging('holding-1', 'batch-1');

		expect(accountsStgRepository.update).toHaveBeenCalledWith(
			'staging-1',
			expect.objectContaining({
				processing_status: expect.not.stringMatching(/^error$/),
			})
		);
	});

	it('no marca actualización cuando los campos vacíos de Salesforce ya tienen valor en la entidad final', async () => {
		const { service, accountsStgRepository, clientRepository, clientEntityRepository, fieldMappingEngine, typeormService } = buildService();
		accountsStgRepository.find.mockResolvedValue([
			{
				id: 'staging-1',
				raw_data: { Id: 'account-1', Name: 'Cliente existente' },
			},
		]);
		fieldMappingEngine.buildMappedRecord.mockResolvedValueOnce({ client_number: 'C-1' }).mockResolvedValueOnce({});
		typeormService.getObjectMapping.mockResolvedValue('client-1');
		clientRepository.findOne.mockResolvedValue({ id: 'client-1', client_number: 'C-1' });
		clientEntityRepository.findOne.mockResolvedValue({
			id: 'entity-1',
			legal_name: 'Razón social Sapira',
			legal_address: 'Dirección Sapira',
			country: 'Chile',
		});

		await (service as any).classifyAccountStaging('holding-1', 'batch-1');

		expect(accountsStgRepository.update).toHaveBeenCalledWith(
			'staging-1',
			expect.objectContaining({
				processing_status: 'processed',
				integration_notes: 'Cliente staging sincronizado',
			})
		);
	});

	it('bloquea la oportunidad y sus ítems staging cuando falta un mapping de producto', async () => {
		const { service, opportunitiesStgRepository, accountsStgRepository, lineItemsStgRepository, notificationsService } = buildService();
		opportunitiesStgRepository.find.mockResolvedValue([
			{
				id: 'opp-stg-1',
				salesforce_id: 'opp-1',
				raw_data: {
					Id: 'opp-1',
					AccountId: 'acc-1',
					OpportunityLineItems: {
						records: [{ Id: 'oli-1', Product2Id: 'product-sf-1', Product2: { Name: 'Producto sin mapping' } }],
					},
				},
			},
		]);
		accountsStgRepository.findOne.mockResolvedValue({ id: 'acc-stg-1', processing_status: 'processed' });

		await (service as any).classifyOpportunityStaging('holding-1', 'batch-1');

		expect(opportunitiesStgRepository.update).toHaveBeenCalledWith(
			'opp-stg-1',
			expect.objectContaining({
				processing_status: 'error',
				error_message: expect.stringContaining('Producto sin mapping'),
			})
		);
		expect(lineItemsStgRepository.update).toHaveBeenCalledWith(
			{
				holding_id: 'holding-1',
				batch_id: 'batch-1',
				salesforce_opportunity_id: 'opp-1',
				salesforce_product_id: 'product-sf-1',
			},
			expect.objectContaining({
				processing_status: 'error',
				error_message: expect.stringContaining('Producto sin mapping activo'),
			})
		);
		expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
			'holding-1',
			expect.objectContaining({
				type: 'salesforce_staging_blocked',
				deduplication_key: 'salesforce:opp-1:unmapped_products',
				action_payload: expect.objectContaining({ retry_mode: 'retry_full' }),
			})
		);
	});

	it('permite procesar accounts seleccionadas con campos acotados', async () => {
		const { service } = buildService();
		const processSpy = jest.spyOn(service as any, 'processAccountStaging').mockResolvedValue(undefined);

		const stats = await service.processAccountsStaging('holding-1', ['001', '002'], ['country', 'industry']);

		expect(processSpy).toHaveBeenCalledWith(
			'holding-1',
			undefined,
			expect.objectContaining({
				opportunities: 0,
				clientsCreated: 0,
				clientsUpdated: 0,
			}),
			{
				salesforceIds: ['001', '002'],
				allowedClientFields: ['country', 'industry'],
			}
		);
		expect(stats.errors).toEqual([]);
	});

	it('sincroniza cotizaciones stageando accounts antes de opportunities e items', async () => {
		const { service, connectionRepository, stagingService } = buildService();
		connectionRepository.findOne.mockResolvedValue({ holding_id: 'holding-1', is_active: true });
		stagingService.getOpportunityStagingIds.mockResolvedValue(new Map([['opp-1', 'opp-stg-1']]));

		jest.spyOn(service as any, 'fetchOpportunitiesWithLineItems').mockResolvedValue([
			{
				Id: 'opp-1',
				AccountId: 'acc-1',
				Account: { Id: 'acc-1', Name: 'Acme SPA' },
				OpportunityLineItems: { records: [{ Id: 'oli-1', Product2Id: 'prod-1', Product2: { Name: 'Licencia' } }] },
			},
		]);
		jest.spyOn(service as any, 'fetchQuoteLineItems').mockResolvedValue(new Map());
		jest.spyOn(service as any, 'mergeLineItems').mockImplementation(() => undefined);
		jest.spyOn(service as any, 'hydrateAccounts').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'collectUniqueAccounts').mockReturnValue([{ Id: 'acc-1', Name: 'Acme SPA' }]);
		jest.spyOn(service as any, 'classifyAccountStaging').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'processAccountStaging').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'classifyOpportunityStaging').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'processOpportunityStaging').mockResolvedValue(undefined);

		await service.syncOpportunitiesComplete('holding-1', '2026-01-01', '2026-01-31', ['opp-1']);

		expect(stagingService.upsertAccounts).toHaveBeenCalledWith('holding-1', [{ Id: 'acc-1', Name: 'Acme SPA' }], 'batch-1', 'session-1');
		expect(stagingService.upsertOpportunities).toHaveBeenCalledWith(
			'holding-1',
			[
				expect.objectContaining({
					Id: 'opp-1',
					AccountId: 'acc-1',
				}),
			],
			'batch-1',
			'session-1'
		);
		expect((stagingService.upsertAccounts as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
			(stagingService.upsertOpportunities as jest.Mock).mock.invocationCallOrder[0]
		);
	});

	it('no envía oportunidades sin ítems a staging', async () => {
		const { service, stagingService } = buildService();
		jest.spyOn(service as any, 'fetchTargetOpportunities').mockResolvedValue([
			{
				Id: 'opp-sin-items',
				AccountId: 'acc-1',
				OpportunityLineItems: { records: [] },
			},
		]);
		jest.spyOn(service as any, 'fetchQuoteLineItems').mockResolvedValue(new Map());
		jest.spyOn(service as any, 'mergeLineItems').mockImplementation(() => undefined);
		jest.spyOn(service as any, 'hydrateAccounts').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'classifyAccountStaging').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'classifyOpportunityStaging').mockResolvedValue(undefined);
		jest.spyOn(service as any, 'buildOpportunityBatchSummary').mockResolvedValue({});
		stagingService.getOpportunityStagingIds.mockResolvedValue(new Map());

		const result = await service.syncOpportunitiesToStaging('holding-1', '2026-01-01', '2026-01-31', ['opp-sin-items']);

		expect(result.importedOpportunities).toBe(0);
		expect(stagingService.upsertOpportunities).toHaveBeenCalledWith('holding-1', [], 'batch-1', 'session-1');
		expect(stagingService.upsertLineItems).toHaveBeenCalledWith('holding-1', new Map(), [], 'batch-1', 'session-1');
	});

	it('revisa Salesforce contra staging sin ejecutar escrituras', async () => {
		const { service, opportunitiesStgRepository, accountsStgRepository, lineItemsStgRepository, stagingService, typeormService } = buildService();
		const opportunity = {
			Id: 'opp-1',
			AccountId: 'acc-1',
			Name: 'Cotización ACME',
			Account: { Id: 'acc-1', Name: 'ACME' },
			OpportunityLineItems: { records: [{ Id: 'oli-1', Product2Id: 'prod-1', Product2: { Name: 'Licencia' } }] },
		};
		jest.spyOn(service as any, 'fetchTargetOpportunities').mockResolvedValue([opportunity]);
		jest.spyOn(service as any, 'fetchQuoteLineItems').mockResolvedValue(new Map());
		jest.spyOn(service as any, 'mergeLineItems').mockImplementation(() => undefined);
		jest.spyOn(service as any, 'hydrateAccounts').mockResolvedValue(undefined);
		opportunitiesStgRepository.find.mockResolvedValue([{ salesforce_id: 'opp-1', raw_data: opportunity, source_hash: JSON.stringify(opportunity) }]);
		accountsStgRepository.find.mockResolvedValue([
			{ salesforce_id: 'acc-1', raw_data: { Id: 'acc-1', Name: 'ACME' }, source_hash: JSON.stringify({ Id: 'acc-1', Name: 'ACME' }) },
		]);
		lineItemsStgRepository.find.mockResolvedValue([
			{
				salesforce_id: 'oli-1',
				raw_data: { Id: 'oli-1', Product2Id: 'prod-1', Product2: { Name: 'Licencia' }, OpportunityId: 'opp-1' },
				source_hash: JSON.stringify({ Id: 'oli-1', Product2Id: 'prod-1', Product2: { Name: 'Licencia' }, OpportunityId: 'opp-1' }),
			},
		]);
		typeormService.getSalesforceProductMapping.mockResolvedValue({ id: 'mapping-1' });

		const result = await service.previewOpportunitiesAgainstStaging('holding-1', '2026-01-01', '2026-01-31');

		expect(result.items[0]).toEqual(expect.objectContaining({ status: 'synchronized', reasons: [] }));
		expect(stagingService.upsertAccounts).not.toHaveBeenCalled();
		expect(stagingService.upsertOpportunities).not.toHaveBeenCalled();
		expect(stagingService.upsertLineItems).not.toHaveBeenCalled();
		expect(opportunitiesStgRepository.find).toHaveBeenCalledWith({
			where: [{ holding_id: 'holding-1', salesforce_id: 'opp-1' }],
		});
	});

	it('normaliza tax_id sólo para el holding solicitado y es idempotente', async () => {
		const { service, clientEntityRepository } = buildService();
		clientEntityRepository.find.mockResolvedValue([
			{ id: 'entity-1', tax_id: '76.517.784-7' },
			{ id: 'entity-2', tax_id: '76517784-7' },
			{ id: 'entity-3', tax_id: null },
		]);

		const result = await service.normalizeTaxIdsForHolding('holding-1');

		expect(clientEntityRepository.find).toHaveBeenCalledWith({
			where: { holding_id: 'holding-1' },
			select: ['id', 'tax_id'],
		});
		expect(clientEntityRepository.update).toHaveBeenCalledTimes(1);
		expect(clientEntityRepository.update).toHaveBeenCalledWith({ id: 'entity-1', holding_id: 'holding-1' }, { tax_id: '76517784-7' });
		expect(result).toEqual({
			holdingId: 'holding-1',
			evaluated: 3,
			normalized: 1,
			unchanged: 2,
		});
	});

	it('prepara el account en staging antes de resolver el cliente de una oportunidad', async () => {
		const { service, accountsStgRepository, stagingService, fieldMappingEngine, typeormService } = buildService();
		accountsStgRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
			id: 'acc-stg-1',
			processing_status: 'processed',
			error_message: null,
		});
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({ client_number: 'CLI-001' });
		typeormService.getObjectMapping.mockResolvedValue('client-1');

		const classifySpy = jest.spyOn(service as any, 'classifyAccountStaging').mockResolvedValue(undefined);
		const processSpy = jest.spyOn(service as any, 'processAccountStaging').mockResolvedValue(undefined);

		const clientId = await (service as any).ensureOpportunityClientReady(
			{ batch_id: 'batch-opp-1', sync_session_id: 'session-opp-1' },
			{ Id: 'opp-1', AccountId: 'acc-1', Account: { Id: 'acc-1', Name: 'Acme SPA' } },
			'holding-1',
			{
				clientsCreated: 0,
				clientsUpdated: 0,
				opportunities: 0,
				quotesCreated: 0,
				quotesUpdated: 0,
				productsSynced: 0,
				quoteItemsCreated: 0,
				sellersCreated: 0,
				errors: [],
			}
		);

		expect(stagingService.upsertAccounts).toHaveBeenCalledWith(
			'holding-1',
			[expect.objectContaining({ Id: 'acc-1', Name: 'Acme SPA' })],
			'batch-opp-1',
			'session-opp-1'
		);
		expect(classifySpy).toHaveBeenCalledWith('holding-1', 'batch-opp-1');
		expect(processSpy).toHaveBeenCalledWith('holding-1', 'batch-opp-1', expect.any(Object), { salesforceIds: ['acc-1'] });
		expect(clientId).toBe('client-1');
	});

	it('no sincroniza la quote si el cliente de la oportunidad no puede resolverse', async () => {
		const { service } = buildService();
		jest.spyOn(service as any, 'ensureOpportunityClientReady').mockRejectedValue(new Error('Cliente no resoluble'));
		const syncQuoteSpy = jest.spyOn(service as any, 'syncQuote').mockResolvedValue(undefined);

		await expect(
			(service as any).processOpportunity(
				{
					raw_data: {
						Id: 'opp-1',
						AccountId: 'acc-1',
						OpportunityLineItems: { records: [{ Product2Id: 'prod-1', Product2: {} }] },
					},
				},
				'holding-1',
				{
					clientsCreated: 0,
					clientsUpdated: 0,
					opportunities: 0,
					quotesCreated: 0,
					quotesUpdated: 0,
					productsSynced: 0,
					quoteItemsCreated: 0,
					sellersCreated: 0,
					errors: [],
				}
			)
		).rejects.toThrow('Cliente no resoluble');

		expect(syncQuoteSpy).not.toHaveBeenCalled();
	});

	it('resuelve el nombre Sapira cuando el producto tiene un mapping activo', async () => {
		const { service, fieldMappingEngine, typeormService } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({
			product_name: 'Licencia',
			is_recurring: true,
		});
		typeormService.getSalesforceProductMapping.mockResolvedValue({
			sapira_product_id: 'product-sapira-1',
			sapira_product_name: 'PATHFINDER+',
		});

		const result = await service.resolveLineItemPreview(
			'holding-1',
			{ Id: 'opp-1', CurrencyIsoCode: 'USD' } as any,
			{
				Id: 'oli-1',
				OpportunityId: 'opp-1',
				Product2Id: 'product-sf-1',
				Product2: { Id: 'product-sf-1', Name: 'Licencia' },
				Quantity: 1,
				UnitPrice: 100,
				TotalPrice: 100,
				Recurrencia__c: 'Recurrente',
			} as any
		);

		expect(result.product_name).toBe('PATHFINDER+');
		expect(result.product_id).toBe('product-sapira-1');
		expect(result.transformation.product_mapping).toBe(true);
	});

	it('conserva el nombre resuelto por field mapping si no hay mapping de producto', async () => {
		const { service, fieldMappingEngine } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({
			product_name: 'Licencia configurada',
			is_recurring: false,
		});

		const result = await service.resolveLineItemPreview(
			'holding-1',
			{ Id: 'opp-1', CurrencyIsoCode: 'USD' } as any,
			{
				Id: 'oli-1',
				OpportunityId: 'opp-1',
				Product2Id: 'product-sf-1',
				Product2: { Id: 'product-sf-1', Name: 'Licencia' },
				Quantity: 1,
				UnitPrice: 100,
				TotalPrice: 100,
			} as any
		);

		expect(result.product_name).toBe('Licencia configurada');
		expect(result.transformation.product_mapping).toBe(false);
	});

	it('mantiene la fecha de término explícita enviada por Salesforce', async () => {
		const { service, fieldMappingEngine } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({ is_recurring: true });

		const result = await service.resolveLineItemPreview(
			'holding-1',
			{ Id: 'opp-1' } as any,
			{
				Id: 'oli-1',
				OpportunityId: 'opp-1',
				Product2Id: 'product-sf-1',
				Product2: { Id: 'product-sf-1', Name: 'Licencia' },
				Quantity: 1,
				UnitPrice: 100,
				TotalPrice: 100,
				Fecha_de_inicio__c: '2026-07-27',
				Fecha_de_Fin__c: '2026-10-27',
			} as any
		);

		expect(result.end_date?.toISOString().split('T')[0]).toBe('2026-10-27');
		expect(result.transformation.derived_end_date).toBe(false);
	});

	it('deriva doce meses de vigencia cuando un item recurrente no tiene fecha final', async () => {
		const { service, fieldMappingEngine } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({ is_recurring: true });

		const result = await service.resolveLineItemPreview(
			'holding-1',
			{ Id: 'opp-1' } as any,
			{
				Id: 'oli-1',
				OpportunityId: 'opp-1',
				Product2Id: 'product-sf-1',
				Product2: { Id: 'product-sf-1', Name: 'Licencia' },
				Quantity: 1,
				UnitPrice: 100,
				TotalPrice: 100,
				Fecha_de_inicio__c: '2026-07-27',
			} as any
		);

		expect(result.end_date?.toISOString().split('T')[0]).toBe('2027-07-27');
		expect(result.transformation.derived_end_date).toBe(true);
	});

	it('deriva un mes de vigencia cuando un item one-shot no tiene fecha final', async () => {
		const { service, fieldMappingEngine } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({ is_recurring: false });

		const result = await service.resolveLineItemPreview(
			'holding-1',
			{ Id: 'opp-1' } as any,
			{
				Id: 'oli-1',
				OpportunityId: 'opp-1',
				Product2Id: 'product-sf-1',
				Product2: { Id: 'product-sf-1', Name: 'Licencia' },
				Quantity: 1,
				UnitPrice: 100,
				TotalPrice: 100,
				ServiceDate: '2026-07-27',
			} as any
		);

		expect(result.end_date?.toISOString().split('T')[0]).toBe('2026-08-27');
		expect(result.transformation.derived_end_date).toBe(true);
	});

	it('actualiza todas las entidades con un tax_id no genérico repetido', async () => {
		const { service, typeormService, clientEntityRepository, genericVatsService, odooPartnersService } = buildService();
		typeormService.resolveClientEntitiesByTaxId.mockResolvedValue({
			entities: [{ id: 'entity-1' }, { id: 'entity-2' }],
		});

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{
				legal_name: 'Acme SpA',
				tax_id: '76517784-7',
				country: 'Chile',
			},
			{ Id: 'account-1', Name: 'Acme SpA' },
			'holding-1'
		);

		expect(genericVatsService.isGenericExportVat).toHaveBeenCalledWith('76517784-7');
		expect(typeormService.resolveClientEntitiesByTaxId).toHaveBeenCalledWith('holding-1', '76517784-7');
		expect(clientEntityRepository.update).toHaveBeenCalledWith(
			'entity-1',
			expect.objectContaining({
				tax_id: '76517784-7',
			})
		);
		expect(clientEntityRepository.update).toHaveBeenCalledWith('entity-2', expect.objectContaining({ tax_id: '76517784-7' }));
		expect(typeormService.createClientEntityClient).not.toHaveBeenCalled();
		expect(odooPartnersService.resolveAndLinkPartnerForEntityId).toHaveBeenCalledTimes(2);
	});

	it('conserva el RUT existente cuando Salesforce no entrega RUT__c', async () => {
		const { service, clientEntityRepository, typeormService } = buildService();
		clientEntityRepository.findOne.mockResolvedValue({
			id: 'entity-existing',
			tax_id: '76517784-7',
		});

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{ legal_name: 'Acme SpA' },
			{ Id: 'account-1', Name: 'Acme SpA' },
			'holding-1'
		);

		expect(clientEntityRepository.update).toHaveBeenCalledWith(
			'entity-existing',
			expect.objectContaining({ tax_id: '76517784-7' })
		);
		expect(typeormService.resolveClientEntitiesByTaxId).not.toHaveBeenCalled();
	});

	it('conserva el RUT existente cuando Salesforce entrega una variante de pendiente', async () => {
		const { service, clientEntityRepository, typeormService } = buildService();
		clientEntityRepository.findOne.mockResolvedValue({
			id: 'entity-existing',
			tax_id: '76517784-7',
		});

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{ legal_name: 'Acme SpA', tax_id: ' PeN.dIeNtE ' },
			{ Id: 'account-1', Name: 'Acme SpA' },
			'holding-1'
		);

		expect(clientEntityRepository.update).toHaveBeenCalledWith(
			'entity-existing',
			expect.objectContaining({ tax_id: '76517784-7' })
		);
		expect(typeormService.resolveClientEntitiesByTaxId).not.toHaveBeenCalled();
	});

	it('crea una entidad nueva con tax_id nulo cuando Salesforce entrega pendiente', async () => {
		const { service, clientEntityRepository, typeormService } = buildService();
		clientEntityRepository.findOne.mockResolvedValue(null);
		clientEntityRepository.create.mockImplementation((payload: Record<string, unknown>) => payload);
		clientEntityRepository.save.mockResolvedValue({ id: 'entity-new' });

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{ legal_name: 'Acme SpA', tax_id: 'PENDIENTE' },
			{ Id: 'account-1', Name: 'Acme SpA' },
			'holding-1'
		);

		expect(clientEntityRepository.save).toHaveBeenCalledWith(expect.objectContaining({ tax_id: null }));
		expect(typeormService.resolveClientEntitiesByTaxId).not.toHaveBeenCalled();
	});

	it('previsualiza los campos transformados que se actualizarán en una entidad legal', async () => {
		const { service, fieldMappingEngine, typeormService } = buildService();
		fieldMappingEngine.buildMappedRecord.mockResolvedValue({
			legal_name: 'Acme SpA',
			tax_id: '76517784-7',
			country: 'Chile',
			legal_address: 'Nueva dirección',
			economic_activity: 'Tecnología',
			client_number: 'C-1',
		});
		typeormService.resolveClientEntitiesByTaxId.mockResolvedValue({
			entities: [
				{
					id: 'entity-1',
					client_id: 'client-1',
					legal_name: 'Acme SpA',
					tax_id: '76517784-7',
					country: 'Chile',
					legal_address: 'Dirección anterior',
					economic_activity: 'Tecnología',
					client_number: 'C-1',
				},
			],
		});

		const result = await service.resolveClientEntityPreview('holding-1', { Id: 'account-1', Name: 'Acme SpA' } as any);

		expect(result.entities[0].changes).toEqual([
			{
				field: 'legal_address',
				current_value: 'Dirección anterior',
				transformed_value: 'Nueva dirección',
			},
		]);
	});

	it('crea una entidad cuando no existe la combinación de VAT genérico y razón social', async () => {
		const { service, typeormService, clientEntityRepository, genericVatsService } = buildService();
		genericVatsService.isGenericExportVat.mockResolvedValue(true);
		clientEntityRepository.create.mockImplementation((payload: Record<string, unknown>) => payload);
		clientEntityRepository.save.mockResolvedValue({ id: 'entity-new' });

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{ legal_name: 'Cliente exportación', tax_id: '5555555-5' },
			{ Id: 'account-1', Name: 'Cliente exportación' },
			'holding-1'
		);

		expect(typeormService.resolveClientEntitiesByTaxId).toHaveBeenCalledWith('holding-1', '5555555-5');
		expect(clientEntityRepository.findOne).not.toHaveBeenCalled();
		expect(clientEntityRepository.save).toHaveBeenCalled();
		expect(typeormService.createClientEntityClient).toHaveBeenCalledWith('entity-new', 'client-1', 'holding-1');
	});

	it('actualiza VAT genérico sólo cuando la razón social coincide', async () => {
		const { service, typeormService, clientEntityRepository } = buildService();
		typeormService.resolveClientEntitiesByTaxId.mockResolvedValue({
			entities: [
				{ id: 'entity-match', legal_name: 'Cliente Exportación' },
				{ id: 'entity-other', legal_name: 'Otra razón social' },
			],
		});
		(service as any).genericVatsService.isGenericExportVat.mockResolvedValue(true);

		await (service as any).createOrLinkClientEntity(
			'client-1',
			{ legal_name: 'cliente  exportación', tax_id: '5555555-5' },
			{ Id: 'account-1', Name: 'cliente  exportación' },
			'holding-1'
		);

		expect(clientEntityRepository.update).toHaveBeenCalledWith('entity-match', expect.objectContaining({ tax_id: '5555555-5' }));
		expect(clientEntityRepository.update).not.toHaveBeenCalledWith('entity-other', expect.anything());
	});

	it('conserva razón social, dirección y país finales cuando ya tienen valor', () => {
		const { service } = buildService();

		const payload = (service as any).fillClientEntityFieldsWhenEmpty(
			{
				legal_name: 'Razón social Sapira',
				legal_address: 'Dirección Sapira',
				country: 'Chile',
			},
			{
				legal_name: 'Razón social Salesforce',
				legal_address: 'Dirección Salesforce',
				country: 'Perú',
				economic_activity: 'Tecnología',
			}
		);

		expect(payload).toEqual({
			legal_name: 'Razón social Sapira',
			legal_address: 'Dirección Sapira',
			country: 'Chile',
			economic_activity: 'Tecnología',
		});
	});

	it('completa email y teléfono del contacto principal solo si están vacíos', async () => {
		const { service, typeormService } = buildService();
		typeormService.getClientContact.mockResolvedValue({
			id: 'contact-1',
			email: 'existente@sapira.com',
			phone: null,
		});

		await (service as any).ensurePrincipalContact(
			'client-1',
			{
				Email_de_contacto_principal__c: 'salesforce@cliente.com',
				Phone: '+56 9 1234 5678',
			},
			'holding-1'
		);

		expect(typeormService.updateClientContact).toHaveBeenCalledWith('contact-1', {
			phone: '+56 9 1234 5678',
		});
	});
});
