import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';

import { SyncCompleteResponseDto, SyncCompleteStats } from '../dtos/salesforce-sync-complete.dto';
import { SalesforceAccountsStg } from '../entities/salesforce-accounts-stg.entity';
import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceLineItemsStg } from '../entities/salesforce-line-items-stg.entity';
import { SalesforceOpportunitiesStg } from '../entities/salesforce-opportunities-stg.entity';
import { QuoteItem } from '../entities/quote-item.entity';
import { Quote } from '../entities/quote.entity';
import { SalesforceAccount, SalesforceOpportunityWithLineItems, SalesforceQuote, SalesforceQuoteLineItem } from '../interfaces/salesforce.interface';
import * as transformers from '../utils/salesforce-transformers';

import { SalesforceFieldMappingEngineService } from './salesforce-field-mapping-engine.service';
import { SalesforceQueryService } from './salesforce-query.service';
import { SalesforceStagingService } from './salesforce-staging.service';
import { SalesforceTypeOrmService } from './salesforce-typeorm.service';

@Injectable()
export class SalesforceSyncCompleteService {
	private readonly logger = new Logger(SalesforceSyncCompleteService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		@InjectRepository(Quote)
		private readonly quoteRepository: Repository<Quote>,
		@InjectRepository(QuoteItem)
		private readonly quoteItemRepository: Repository<QuoteItem>,
		@InjectRepository(SalesforceAccountsStg)
		private readonly accountsStgRepository: Repository<SalesforceAccountsStg>,
		@InjectRepository(SalesforceOpportunitiesStg)
		private readonly opportunitiesStgRepository: Repository<SalesforceOpportunitiesStg>,
		@InjectRepository(SalesforceLineItemsStg)
		private readonly lineItemsStgRepository: Repository<SalesforceLineItemsStg>,
		private readonly queryService: SalesforceQueryService,
		private readonly typeormService: SalesforceTypeOrmService,
		private readonly fieldMappingEngine: SalesforceFieldMappingEngineService,
		private readonly stagingService: SalesforceStagingService
	) {}

	async syncOpportunitiesComplete(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		opportunityIds?: string[]
	): Promise<SyncCompleteResponseDto> {
		const startTime = new Date();
		const stats: SyncCompleteStats = {
			opportunities: 0,
			clientsCreated: 0,
			clientsUpdated: 0,
			quotesCreated: 0,
			quotesUpdated: 0,
			productsSynced: 0,
			quoteItemsCreated: 0,
			sellersCreated: 0,
			errors: [],
		};

		try {
			const connection = await this.connectionRepository.findOne({
				where: { holding_id: holdingId, is_active: true },
			});

			if (!connection) {
				throw new Error('No active Salesforce connection found');
			}

			const from = dateFrom || this.getYesterdayDate();
			const to = dateTo || from;
			let opportunities = await this.fetchOpportunitiesWithLineItems(holdingId, from, to);

			if (opportunityIds?.length) {
				opportunities = opportunities.filter((opp) => opportunityIds.includes(opp.Id));
			}

			stats.opportunities = opportunities.length;

			const quoteLineItemsByOpp = await this.fetchQuoteLineItems(
				holdingId,
				opportunities.map((opp) => opp.Id)
			);
			this.mergeLineItems(opportunities, quoteLineItemsByOpp);
			await this.hydrateAccounts(opportunities, holdingId);

			const { batchId, syncSessionId } = this.stagingService.createRunContext();
			const stagedAccounts = this.collectUniqueAccounts(opportunities);
			const stagedLineItems = opportunities.flatMap((opportunity) =>
				(opportunity.OpportunityLineItems?.records || []).map((lineItem) => ({
					...lineItem,
					OpportunityId: opportunity.Id,
				}))
			);

			await this.stagingService.upsertAccounts(holdingId, stagedAccounts, batchId, syncSessionId);
			await this.stagingService.upsertOpportunities(holdingId, opportunities, batchId, syncSessionId);
			const opportunityStagingIds = await this.stagingService.getOpportunityStagingIds(
				holdingId,
				opportunities.map((opportunity) => opportunity.Id)
			);
			await this.stagingService.upsertLineItems(holdingId, opportunityStagingIds, stagedLineItems, batchId, syncSessionId);

			await this.classifyAccountStaging(holdingId, batchId);
			await this.processAccountStaging(holdingId, batchId, stats);
			await this.classifyOpportunityStaging(holdingId, batchId);
			await this.processOpportunityStaging(holdingId, batchId, stats);

			await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });

			return {
				holding_id: holdingId,
				success: true,
				stats,
				started_at: startTime,
				completed_at: new Date(),
				duration_seconds: (Date.now() - startTime.getTime()) / 1000,
			};
		} catch (error: any) {
			this.logger.error(`❌ Complete sync failed for holding ${holdingId}:`, error.message);
			return {
				holding_id: holdingId,
				success: false,
				stats,
				error: error.message,
				started_at: startTime,
				completed_at: new Date(),
				duration_seconds: (Date.now() - startTime.getTime()) / 1000,
			};
		}
	}

	async syncAllActiveConnectionsComplete(): Promise<SyncCompleteResponseDto[]> {
		const connections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		const results: SyncCompleteResponseDto[] = [];
		for (const connection of connections) {
			results.push(await this.syncOpportunitiesComplete(connection.holding_id));
		}

		return results;
	}

	async reclassifyStaging(holdingId: string): Promise<void> {
		await this.classifyAccountStaging(holdingId);
		await this.classifyOpportunityStaging(holdingId);
	}

	async processStaging(holdingId: string): Promise<SyncCompleteStats> {
		const stats: SyncCompleteStats = {
			opportunities: 0,
			clientsCreated: 0,
			clientsUpdated: 0,
			quotesCreated: 0,
			quotesUpdated: 0,
			productsSynced: 0,
			quoteItemsCreated: 0,
			sellersCreated: 0,
			errors: [],
		};

		await this.processAccountStaging(holdingId, undefined, stats);
		await this.processOpportunityStaging(holdingId, undefined, stats);
		return stats;
	}

	private async fetchOpportunitiesWithLineItems(
		holdingId: string,
		dateFrom: string,
		dateTo: string
	): Promise<SalesforceOpportunityWithLineItems[]> {
		const soql = `
			SELECT 
				Id, Name, AccountId, Type, CloseDate, StageName, IsWon, IsClosed,
				Amount, CurrencyIsoCode, CreatedDate, Description,
				Modalidad_de_pago__c, Forma_de_pago__c, Contrato__c, 
				Orden_de_compra__c, QuoteProjectManager__c, QuoteBillingEmail__c,
				id_largo_oportunidad__c,
				OwnerId, Owner.Id, Owner.Name, Owner.Email,
				Account.Id, Account.Name, Account.BillingCountry,
				Account.Plazos_de_pago__c, Account.Lista_de_Precio__r.Tipo__c,
				Account.Per_odo_de_facturaci_n__c,
				Account.Industry, Account.Segmento__c, Account.DemoCountry__c,
				Account.Email_de_contacto_principal__c,
				(SELECT Id, Product2Id, Product2.Id, Product2.Name, Product2.ProductCode, Product2.Description, Product2.Family,
				        Quantity, UnitPrice, ListPrice, TotalPrice,
				        Recurrencia__c, Description
				 FROM OpportunityLineItems)
			FROM Opportunity
			WHERE CloseDate >= ${dateFrom} AND CloseDate <= ${dateTo}
				AND (StageName = 'Ganado' OR StageName = 'Closed Won' OR StageName = 'Cerrada Win')
				AND IsDeleted = false
			ORDER BY CloseDate DESC
			LIMIT 1000
		`.trim();

		const { data } = await this.queryService.executeQuery(soql, holdingId);
		return data.records || [];
	}

	private async fetchQuoteLineItems(holdingId: string, opportunityIds: string[]): Promise<Map<string, SalesforceQuoteLineItem[]>> {
		if (opportunityIds.length === 0) {
			return new Map();
		}

		const quotesSOQL = `
			SELECT Id, OpportunityId, Name, QuoteNumber, Status
			FROM Quote
			WHERE OpportunityId IN ('${opportunityIds.join("','")}')
		`.trim();
		const { data: quotesData } = await this.queryService.executeQuery(quotesSOQL, holdingId);
		const quotes: SalesforceQuote[] = quotesData.records || [];
		if (!quotes.length) {
			return new Map();
		}

		const quoteIds = quotes.map((quote) => quote.Id);
		const qliSOQL = `
			SELECT 
				Id, QuoteId, OpportunityLineItemId,
				Product2Id, Quantity, UnitPrice, ListPrice, TotalPrice,
				Discount, ServiceDate, Description, SortOrder,
				Recurrencia__c,
				Fecha_de_inicio__c,
				Fecha_de_Fin__c,
				Calculo_para_facturaci_n__c,
				Unidad_facturada__c,
				Fuente_de_unidad__c,
				Tipo_de_agregaci_n__c,
				Fuente_Optimizaciones__c
			FROM QuoteLineItem
			WHERE QuoteId IN ('${quoteIds.join("','")}')
		`.trim();

		const { data: qliData } = await this.queryService.executeQuery(qliSOQL, holdingId);
		const quoteLineItems: SalesforceQuoteLineItem[] = qliData.records || [];
		const qliByOppId = new Map<string, SalesforceQuoteLineItem[]>();

		quoteLineItems.forEach((qli) => {
			const quote = quotes.find((currentQuote) => currentQuote.Id === qli.QuoteId);
			if (!quote) {
				return;
			}

			const current = qliByOppId.get(quote.OpportunityId) || [];
			current.push(qli);
			qliByOppId.set(quote.OpportunityId, current);
		});

		return qliByOppId;
	}

	private mergeLineItems(opportunities: SalesforceOpportunityWithLineItems[], quoteLineItemsByOpp: Map<string, SalesforceQuoteLineItem[]>) {
		opportunities.forEach((opportunity) => {
			const quoteLineItems = quoteLineItemsByOpp.get(opportunity.Id) || [];
			if (!quoteLineItems.length || !opportunity.OpportunityLineItems?.records?.length) {
				return;
			}

			const oliById = new Map(opportunity.OpportunityLineItems.records.map((lineItem) => [lineItem.Id, lineItem]));
			quoteLineItems.forEach((qli) => {
				if (!qli.OpportunityLineItemId) {
					return;
				}

				const oli = oliById.get(qli.OpportunityLineItemId);
				if (!oli) {
					return;
				}

				Object.assign(oli, {
					Recurrencia__c: qli.Recurrencia__c,
					Fecha_de_inicio__c: qli.Fecha_de_inicio__c,
					Fecha_de_Fin__c: qli.Fecha_de_Fin__c,
					Calculo_para_facturaci_n__c: qli.Calculo_para_facturaci_n__c,
					Unidad_facturada__c: qli.Unidad_facturada__c,
					Fuente_de_unidad__c: qli.Fuente_de_unidad__c,
					Tipo_de_agregaci_n__c: qli.Tipo_de_agregaci_n__c,
					Fuente_Optimizaciones__c: qli.Fuente_Optimizaciones__c,
					Discount: qli.Discount,
					ServiceDate: qli.ServiceDate,
					SortOrder: qli.SortOrder,
				});
			});
		});
	}

	private async hydrateAccounts(opportunities: SalesforceOpportunityWithLineItems[], holdingId: string): Promise<void> {
		const uniqueAccountIds = [...new Set(opportunities.map((opportunity) => opportunity.AccountId).filter(Boolean))];
		const accountMap = new Map<string, SalesforceAccount>();

		for (const accountId of uniqueAccountIds) {
			const account = await this.fetchAccount(accountId, holdingId);
			if (account) {
				accountMap.set(accountId, account);
			}
		}

		opportunities.forEach((opportunity) => {
			const hydrated = accountMap.get(opportunity.AccountId);
			if (hydrated) {
				opportunity.Account = hydrated as any;
			}
		});
	}

	private collectUniqueAccounts(opportunities: SalesforceOpportunityWithLineItems[]): SalesforceAccount[] {
		const accountMap = new Map<string, SalesforceAccount>();
		for (const opportunity of opportunities) {
			if (opportunity.AccountId && opportunity.Account) {
				accountMap.set(opportunity.AccountId, {
					Id: opportunity.AccountId,
					...opportunity.Account,
				} as SalesforceAccount);
			}
		}

		return [...accountMap.values()];
	}

	private async classifyAccountStaging(holdingId: string, batchId?: string): Promise<void> {
		const records = await this.accountsStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			const account = record.raw_data as SalesforceAccount;
			const clientPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client', account);
			const clientEntityPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', account);
			const existingClientId =
				(await this.typeormService.getObjectMapping(holdingId, 'Account', account.Id)) ||
				(clientPayload.client_number ? await this.typeormService.getClientByNumber(holdingId, clientPayload.client_number) : null);

			if (!existingClientId) {
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'create',
					integration_notes: 'No existe cliente Sapira asociado al Account',
				});
				continue;
			}

			const existingClient = await this.clientRepository.findOne({
				where: { id: existingClientId, holding_id: holdingId },
			});
			const existingEntity = clientEntityPayload.tax_id
				? await this.clientEntityRepository.findOne({
						where: { holding_id: holdingId, tax_id: clientEntityPayload.tax_id },
				  })
				: await this.clientEntityRepository.findOne({
						where: { holding_id: holdingId, client_id: existingClientId },
				  });

			const hasChanges = this.hasRecordChanges(clientPayload, existingClient) || this.hasRecordChanges(clientEntityPayload, existingEntity);
			await this.accountsStgRepository.update(record.id, {
				processing_status: hasChanges ? 'update' : 'processed',
				integration_notes: hasChanges ? 'Cliente existente con cambios pendientes' : 'Cliente staging sincronizado',
			});
		}
	}

	private async processAccountStaging(holdingId: string, batchId: string | undefined, stats: SyncCompleteStats): Promise<void> {
		const records = await this.accountsStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			if (!['create', 'update', 'error'].includes(record.processing_status || '')) {
				continue;
			}

			try {
				await this.syncAccountFromData(record.raw_data as SalesforceAccount, holdingId, stats);
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'processed',
					error_message: null,
					last_integrated_at: new Date(),
					processed_at: new Date(),
				});
			} catch (error: any) {
				stats.errors.push(`Account ${record.salesforce_id}: ${error.message}`);
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'error',
					error_message: error.message,
				});
			}
		}
	}

	private async classifyOpportunityStaging(holdingId: string, batchId?: string): Promise<void> {
		const records = await this.opportunitiesStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
			const existingQuote = await this.quoteRepository.findOne({
				where: {
					holding_id: holdingId,
					salesforce_opportunity_id: opportunity.Id,
				},
			});

			if (!existingQuote) {
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'create',
					integration_notes: 'No existe cotización Sapira para esta oportunidad',
				});
				continue;
			}

			const hasChanges = await this.hasOpportunityChanges(holdingId, opportunity, existingQuote);
			await this.opportunitiesStgRepository.update(record.id, {
				processing_status: hasChanges ? 'update' : 'processed',
				integration_notes: hasChanges ? 'Cotización existente con cambios pendientes' : 'Cotización staging sincronizada',
			});
		}
	}

	private async processOpportunityStaging(holdingId: string, batchId: string | undefined, stats: SyncCompleteStats): Promise<void> {
		const records = await this.opportunitiesStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			if (!['create', 'update', 'error'].includes(record.processing_status || '')) {
				continue;
			}

			try {
				await this.processOpportunity(record.raw_data as SalesforceOpportunityWithLineItems, holdingId, stats);
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'processed',
					error_message: null,
					last_integrated_at: new Date(),
					processed_at: new Date(),
				});

				await this.lineItemsStgRepository.update(
					batchId
						? { holding_id: holdingId, batch_id: batchId, salesforce_opportunity_id: record.salesforce_id }
						: { holding_id: holdingId, salesforce_opportunity_id: record.salesforce_id },
					{
						processing_status: 'processed',
						error_message: null,
						last_integrated_at: new Date(),
						processed_at: new Date(),
					}
				);
			} catch (error: any) {
				stats.errors.push(`Opportunity ${record.salesforce_id}: ${error.message}`);
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'error',
					error_message: error.message,
				});
			}
		}
	}

	private async processOpportunity(opportunity: SalesforceOpportunityWithLineItems, holdingId: string, stats: SyncCompleteStats): Promise<void> {
		const clientId = await this.syncAccountFromData(
			(opportunity.Account
				? ({
						Id: opportunity.AccountId,
						...opportunity.Account,
				  } as SalesforceAccount)
				: await this.fetchAccount(opportunity.AccountId, holdingId)) as SalesforceAccount,
			holdingId,
			stats
		);

		const lineItems = opportunity.OpportunityLineItems?.records || [];
		for (const lineItem of lineItems) {
			if (lineItem.Product2Id) {
				await this.syncProduct(lineItem.Product2Id, lineItem.Product2 || {}, holdingId, stats);
			}
		}

		await this.syncQuote(opportunity, clientId, holdingId, stats);
	}

	private async syncAccountFromData(accountData: SalesforceAccount, holdingId: string, stats: SyncCompleteStats): Promise<string> {
		if (!accountData?.Id) {
			throw new Error('Salesforce Account inválido para sincronización');
		}

		const clientPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client', accountData);
		const entityPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', accountData);
		const clientNumber = clientPayload.client_number;
		const existingClientId =
			(await this.typeormService.getObjectMapping(holdingId, 'Account', accountData.Id)) ||
			(clientNumber ? await this.typeormService.getClientByNumber(holdingId, clientNumber) : null);

		if (clientPayload.industry) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'industries', clientPayload.industry);
		}
		if (clientPayload.segment) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'segments', clientPayload.segment);
		}

		if (existingClientId) {
			await this.clientRepository.update(
				{ id: existingClientId, holding_id: holdingId },
				{
					...clientPayload,
					holding_id: holdingId,
				}
			);

			const existingMapping = await this.typeormService.getObjectMapping(holdingId, 'Account', accountData.Id);
			if (!existingMapping) {
				await this.typeormService.createObjectMapping(holdingId, 'Account', accountData.Id, 'clients', existingClientId);
			}

			await this.ensurePrincipalContact(existingClientId, accountData, holdingId);
			await this.createOrLinkClientEntity(existingClientId, entityPayload, accountData, holdingId);
			stats.clientsUpdated++;
			return existingClientId;
		}

		const client = this.clientRepository.create({
			holding_id: holdingId,
			...clientPayload,
		});
		const savedClient = await this.clientRepository.save(client);
		await this.typeormService.createObjectMapping(holdingId, 'Account', accountData.Id, 'clients', savedClient.id);
		await this.ensurePrincipalContact(savedClient.id, accountData, holdingId);
		await this.createOrLinkClientEntity(savedClient.id, entityPayload, accountData, holdingId);
		stats.clientsCreated++;

		return savedClient.id;
	}

	private async fetchAccount(accountId: string, holdingId: string): Promise<SalesforceAccount | null> {
		const soql = `
			SELECT
				Id, Name, Salesforce_API_ID__c, Industry, Segmento__c,
				BillingCountry, BillingStreet, BillingCity, BillingState, BillingPostalCode,
				DemoCountry__c, BusinessName__c, RUT__c,
				Email_de_contacto_principal__c, Industria_sector__c,
				Plazos_de_pago__c, Lista_de_Precio__r.Tipo__c,
				M_nimo_facturable_licencias__c, Per_odo_de_facturaci_n__c,
				Phone
			FROM Account
			WHERE Id = '${accountId}'
			LIMIT 1
		`.trim();

		try {
			const { data } = await this.queryService.executeQuery(soql, holdingId);
			return data.records?.[0] || null;
		} catch (error: any) {
			this.logger.error(`Error fetching account ${accountId}: ${error.message}`);
			return null;
		}
	}

	private async ensurePrincipalContact(clientId: string, accountData: SalesforceAccount, holdingId: string): Promise<void> {
		if (!accountData.Email_de_contacto_principal__c) {
			return;
		}

		const hasContact = await this.typeormService.hasClientContact(clientId, 'Principal');
		if (hasContact) {
			return;
		}

		await this.typeormService.createClientContact({
			client_id: clientId,
			holding_id: holdingId,
			contact_type: 'Principal',
			email: accountData.Email_de_contacto_principal__c,
			phone: (accountData as any).Phone || null,
		});
	}

	private async createOrLinkClientEntity(
		clientId: string,
		entityPayload: Record<string, any>,
		accountData: SalesforceAccount,
		holdingId: string
	): Promise<void> {
		const legalName = entityPayload.legal_name || accountData.Name;
		const taxId = entityPayload.tax_id || null;
		const hasLegalInfo = legalName || taxId;
		if (!hasLegalInfo) {
			return;
		}

		const basePayload = {
			client_id: clientId,
			holding_id: holdingId,
			legal_name: legalName,
			tax_id: taxId,
			country: entityPayload.country || null,
			legal_address: entityPayload.legal_address || null,
			economic_activity: entityPayload.economic_activity || accountData.Industry || null,
			client_number: entityPayload.client_number || null,
		};

		if (taxId) {
			const existingEntity = await this.typeormService.getClientEntityByTaxId(holdingId, taxId);
			if (existingEntity) {
				await this.clientEntityRepository.update(existingEntity.id, basePayload);
				await this.typeormService.updateClientEntityClient(existingEntity.id, clientId);
				await this.typeormService.createClientEntityClient(existingEntity.id, clientId, holdingId);
				return;
			}
		}

		const existingByClient = await this.clientEntityRepository.findOne({
			where: { holding_id: holdingId, client_id: clientId },
		});
		if (existingByClient) {
			await this.clientEntityRepository.update(existingByClient.id, basePayload);
			await this.typeormService.createClientEntityClient(existingByClient.id, clientId, holdingId);
			return;
		}

		const savedEntity = await this.clientEntityRepository.save(this.clientEntityRepository.create(basePayload));
		await this.typeormService.createClientEntityClient(savedEntity.id, clientId, holdingId);
	}

	private async syncProduct(productId: string, productData: any, holdingId: string, stats: SyncCompleteStats): Promise<string> {
		const existingProductId = await this.typeormService.getObjectMapping(holdingId, 'Product2', productId);
		if (existingProductId) {
			return existingProductId;
		}

		const productPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'product', {
			Id: productId,
			...productData,
		});
		const sapiraProductId = await this.typeormService.upsertProduct({
			holding_id: holdingId,
			is_active: true,
			...productPayload,
		});
		await this.typeormService.createObjectMapping(holdingId, 'Product2', productId, 'products', sapiraProductId);
		stats.productsSynced++;
		return sapiraProductId;
	}

	private async syncQuote(opportunity: SalesforceOpportunityWithLineItems, clientId: string, holdingId: string, stats: SyncCompleteStats): Promise<void> {
		let stageId = await this.typeormService.getQuoteStageByName(holdingId, 'enviada');
		if (!stageId) {
			stageId = await this.typeormService.getFirstQuoteStage(holdingId);
		}
		if (!stageId) {
			throw new Error('No se encontró una etapa de cotización configurada');
		}

		let sellerId: string | null = null;
		const ownerEmail = opportunity.Owner?.Email;
		const ownerName = opportunity.Owner?.Name;
		const ownerId = opportunity.OwnerId;

		if (ownerEmail) {
			sellerId = await this.typeormService.getSellerByEmail(holdingId, ownerEmail);
		}
		if (!sellerId && ownerName) {
			sellerId = await this.typeormService.getSellerByName(holdingId, ownerName);
		}
		if (!sellerId && (ownerEmail || ownerName || ownerId)) {
			sellerId = await this.typeormService.createSeller({
				name: ownerName || ownerEmail || `SF Owner ${ownerId}`,
				email: ownerEmail || `sf_${(ownerId || 'unknown').toLowerCase()}@salesforce.local`,
				holding_id: holdingId,
				is_active: true,
			});
			if (sellerId) {
				stats.sellersCreated++;
			}
		}

		const mappedQuoteData = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'opportunity', opportunity, {
			opportunity,
		});
		if (mappedQuoteData.payment_terms) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'payment_terms', mappedQuoteData.payment_terms);
		}

		const clientContactId = await this.typeormService.getPrincipalContact(clientId);
		const autoNote = `Importado desde Salesforce - ${opportunity.Name} (Stage SF: ${opportunity.StageName} → Enviada)`;
		const quoteData = {
			holding_id: holdingId,
			client_id: clientId,
			client_contact_id: clientContactId,
			seller_id: sellerId,
			quote_stage_id: stageId,
			notes: mappedQuoteData.notes ? `${autoNote}\n\n${mappedQuoteData.notes}` : autoNote,
			...mappedQuoteData,
		};

		const existingQuoteId =
			(await this.typeormService.getObjectMapping(holdingId, 'Opportunity', opportunity.Id)) ||
			(await this.quoteRepository.findOne({
				where: { holding_id: holdingId, salesforce_opportunity_id: opportunity.Id },
				select: ['id'],
			}).then((quote) => quote?.id || null));

		let quoteId: string;
		if (existingQuoteId) {
			quoteId = await this.typeormService.upsertQuote({ ...quoteData, id: existingQuoteId });
			await this.typeormService.deleteQuoteItems(quoteId);
			stats.quotesUpdated++;
		} else {
			quoteId = await this.typeormService.upsertQuote(quoteData);
			await this.typeormService.createObjectMapping(holdingId, 'Opportunity', opportunity.Id, 'quotes', quoteId);
			stats.quotesCreated++;
		}

		const quoteItems: Record<string, any>[] = [];
		for (const lineItem of opportunity.OpportunityLineItems?.records || []) {
			const linePayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'line_item', lineItem, {
				opportunity,
				lineItem,
			});
			const productMapping = lineItem.Product2Id
				? await this.typeormService.getSalesforceProductMapping(holdingId, lineItem.Product2Id)
				: null;
			const isRecurring = linePayload.is_recurring ?? transformers.isRecurring(lineItem.Recurrencia__c);
			const startDate = lineItem.Fecha_de_inicio__c || lineItem.ServiceDate || null;
			const termMonths = transformers.calculateTermMonths(startDate || undefined, lineItem.Fecha_de_Fin__c || undefined, isRecurring);
			const endDate =
				lineItem.Fecha_de_Fin__c ||
				(startDate
					? (() => {
							const start = new Date(startDate);
							start.setMonth(start.getMonth() + termMonths);
							return start.toISOString().split('T')[0];
					  })()
					: null);
			const discountPercentage = transformers.calculateDiscountPercentage(lineItem.ListPrice, lineItem.UnitPrice);
			const discountType = transformers.getDiscountType(lineItem.ListPrice, lineItem.UnitPrice);
			const baseCustomFields = linePayload.custom_fields ? { ...linePayload.custom_fields } : {};

			if (!productMapping && lineItem.Product2Id) {
				baseCustomFields.salesforce_unmapped_product = true;
				baseCustomFields.salesforce_product_id_original = lineItem.Product2Id;
			}

			const calculatedPrice = termMonths * (lineItem.UnitPrice || 0) * (lineItem.Quantity || 1);
			const finalPrice =
				discountPercentage && discountPercentage > 0 ? calculatedPrice * (1 - discountPercentage / 100) : calculatedPrice;

			quoteItems.push({
				quote_id: quoteId,
				holding_id: holdingId,
				product_id: productMapping?.sapira_product_id || null,
				product_name: productMapping?.sapira_product_name || linePayload.product_name || lineItem.Product2?.Name || `Producto ${lineItem.Id}`,
				quantity: linePayload.quantity || lineItem.Quantity || 1,
				unit_price: linePayload.unit_price || lineItem.UnitPrice || 0,
				price: calculatedPrice,
				final_price: finalPrice,
				discount_value: discountPercentage,
				discount_type: discountType,
				is_recurring: isRecurring,
				item_type: linePayload.item_type || null,
				unit_of_measure: linePayload.unit_of_measure || null,
				term_months: termMonths,
				custom_fields: Object.keys(baseCustomFields).length ? baseCustomFields : null,
				salesforce_product_id: linePayload.salesforce_product_id || lineItem.Product2Id || null,
				salesforce_line_item_id: linePayload.salesforce_line_item_id || lineItem.Id,
				quote_item_number: linePayload.quote_item_number || lineItem.Id,
				data_source: 'salesforce',
				currency: mappedQuoteData.currency || opportunity.CurrencyIsoCode || 'USD',
				start_date: transformers.parseSalesforceDate(startDate),
				end_date: transformers.parseSalesforceDate(endDate),
				billing_method: linePayload.billing_method || transformers.transformBillingMethod(opportunity.Forma_de_pago__c),
				billing_frequency:
					linePayload.billing_frequency || opportunity.Account?.Per_odo_de_facturaci_n__c || opportunity.Modalidad_de_pago__c || null,
			});
		}

		if (quoteItems.length) {
			await this.typeormService.createQuoteItems(quoteItems);
			stats.quoteItemsCreated += quoteItems.length;
		}
	}

	private async hasOpportunityChanges(holdingId: string, opportunity: SalesforceOpportunityWithLineItems, existingQuote: Quote): Promise<boolean> {
		const mappedQuote = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'opportunity', opportunity, { opportunity });
		if (this.hasRecordChanges(mappedQuote, existingQuote, ['notes'])) {
			return true;
		}

		const existingItems = await this.quoteItemRepository.find({
			where: {
				quote_id: existingQuote.id,
				holding_id: holdingId,
			},
		});
		const stagedLineItems = opportunity.OpportunityLineItems?.records || [];
		if (existingItems.length !== stagedLineItems.length) {
			return true;
		}

		for (const stagedLineItem of stagedLineItems) {
			const existingItem = existingItems.find((item) => item.salesforce_line_item_id === stagedLineItem.Id);
			if (!existingItem) {
				return true;
			}

			const mappedLine = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'line_item', stagedLineItem, {
				opportunity,
				lineItem: stagedLineItem,
			});
			if (
				this.hasRecordChanges(
					{
						product_name: mappedLine.product_name || stagedLineItem.Product2?.Name || null,
						unit_price: mappedLine.unit_price || stagedLineItem.UnitPrice || null,
						quantity: mappedLine.quantity || stagedLineItem.Quantity || null,
						item_type: mappedLine.item_type || null,
						unit_of_measure: mappedLine.unit_of_measure || null,
						salesforce_product_id: mappedLine.salesforce_product_id || stagedLineItem.Product2Id || null,
						salesforce_line_item_id: mappedLine.salesforce_line_item_id || stagedLineItem.Id,
					},
					existingItem
				)
			) {
				return true;
			}
		}

		return false;
	}

	private hasRecordChanges(candidate: Record<string, any>, existing?: Record<string, any> | null, ignoredKeys: string[] = []): boolean {
		if (!existing) {
			return true;
		}

		for (const [key, value] of Object.entries(candidate)) {
			if (ignoredKeys.includes(key)) {
				continue;
			}

			const current = (existing as any)[key];
			if (value instanceof Date && current instanceof Date) {
				if (value.getTime() !== current.getTime()) {
					return true;
				}
				continue;
			}

			if (JSON.stringify(value) !== JSON.stringify(current)) {
				return true;
			}
		}

		return false;
	}

	private getYesterdayDate(): string {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		return yesterday.toISOString().split('T')[0];
	}
}
