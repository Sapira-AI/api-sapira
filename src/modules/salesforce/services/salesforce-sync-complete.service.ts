import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { GenericVatsService } from '@/common/services/generic-vats.service';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { NotificationsService, SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE } from '@/modules/notifications/notifications.service';
import { OdooPartnersService } from '@/modules/odoo/odoo-partners.service';

import { SyncCompleteResponseDto, SyncCompleteStats } from '../dtos/salesforce-sync-complete.dto';
import { SalesforceTaxIdNormalizationResponseDto } from '../dtos/salesforce-tax-id-normalization.dto';
import { QuoteItem } from '../entities/quote-item.entity';
import { Quote } from '../entities/quote.entity';
import { SalesforceAccountsStg } from '../entities/salesforce-accounts-stg.entity';
import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceLineItemsStg } from '../entities/salesforce-line-items-stg.entity';
import { SalesforceOpportunitiesStg } from '../entities/salesforce-opportunities-stg.entity';
import {
	SalesforceAccount,
	SalesforceOpportunityLineItem,
	SalesforceOpportunityWithLineItems,
	SalesforceQuote,
	SalesforceQuoteLineItem,
} from '../interfaces/salesforce.interface';
import * as transformers from '../utils/salesforce-transformers';

import { SalesforceFieldMappingEngineService } from './salesforce-field-mapping-engine.service';
import { SalesforceQueryService } from './salesforce-query.service';
import { SalesforceStagingService } from './salesforce-staging.service';
import { SalesforceTypeOrmService } from './salesforce-typeorm.service';

interface AccountImportFilters {
	letter?: string;
	subRange?: string;
	dateFrom?: string;
	dateTo?: string;
}

interface AccountProcessingOptions {
	salesforceIds?: string[];
	allowedClientFields?: string[];
	processingStatuses?: string[];
}

interface OpportunityProcessingOptions {
	salesforceIds?: string[];
	processingStatuses?: string[];
}

export interface ResolvedSalesforceLineItemPreview {
	product_id: string | null;
	product_name: string;
	quantity: number;
	unit_price: number;
	price: number;
	final_price: number;
	discount_value: number | null;
	discount_type: string | null;
	is_recurring: boolean;
	item_type: string | null;
	unit_of_measure: string | null;
	term_months: number;
	custom_fields: Record<string, unknown> | null;
	salesforce_product_id: string | null;
	salesforce_line_item_id: string;
	quote_item_number: string;
	data_source: 'salesforce';
	currency: string;
	start_date: Date | null;
	end_date: Date | null;
	billing_method: string;
	billing_frequency: string | null;
	transformation: {
		product_mapping: boolean;
		derived_end_date: boolean;
	};
}

export interface ResolvedSalesforceClientEntityPreview {
	salesforce_account_id: string;
	is_generic_export_vat: boolean;
	will_create: boolean;
	entities: Array<{
		id: string;
		client_id: string;
		changes: Array<{ field: string; current_value: unknown; transformed_value: unknown }>;
	}>;
}

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
		private readonly stagingService: SalesforceStagingService,
		private readonly genericVatsService: GenericVatsService,
		private readonly odooPartnersService: OdooPartnersService,
		private readonly notificationsService: NotificationsService
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
			const from = dateFrom || this.getYesterdayDate();
			const to = dateTo || from;
			const opportunities = (await this.fetchTargetOpportunities(holdingId, from, to, opportunityIds)).filter(
				(opportunity) => (opportunity.OpportunityLineItems?.records || []).length > 0
			);

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

	async normalizeTaxIdsForHolding(holdingId: string): Promise<SalesforceTaxIdNormalizationResponseDto> {
		const entities = await this.clientEntityRepository.find({
			where: { holding_id: holdingId },
			select: ['id', 'tax_id'],
		});
		let normalized = 0;

		for (const entity of entities) {
			const taxId = transformers.normalizeTaxId(entity.tax_id);
			if (entity.tax_id === taxId) {
				continue;
			}

			await this.clientEntityRepository.update({ id: entity.id, holding_id: holdingId }, { tax_id: taxId });
			normalized++;
		}

		return {
			holdingId,
			evaluated: entities.length,
			normalized,
			unchanged: entities.length - normalized,
		};
	}

	async syncOpportunitiesToStaging(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		opportunityIds?: string[]
	): Promise<{
		success: boolean;
		importedAccounts: number;
		importedOpportunities: number;
		importedLineItems: number;
		batchId: string;
		syncSessionId: string;
		summary: Record<string, number>;
		unmappedProducts: Array<{ opportunityId: string; opportunityName: string; productId: string; productName: string }>;
	}> {
		const from = dateFrom || this.getYesterdayDate();
		const to = dateTo || from;
		const opportunities = (await this.fetchTargetOpportunities(holdingId, from, to, opportunityIds)).filter(
			(opportunity) => (opportunity.OpportunityLineItems?.records || []).length > 0
		);
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
		await this.classifyOpportunityStaging(holdingId, batchId);
		const unmappedProducts = (
			await Promise.all(
				opportunities.map(async (opportunity) =>
					(await this.getUnmappedSalesforceProducts(holdingId, opportunity)).map((product) => ({
						opportunityId: opportunity.Id,
						opportunityName: opportunity.Name || opportunity.Id,
						productId: product.id,
						productName: product.name,
					}))
				)
			)
		).flat();
		await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });

		return {
			success: true,
			importedAccounts: stagedAccounts.length,
			importedOpportunities: opportunities.length,
			importedLineItems: stagedLineItems.length,
			batchId,
			syncSessionId,
			summary: await this.buildOpportunityBatchSummary(holdingId, batchId),
			unmappedProducts,
		};
	}

	async previewOpportunitiesAgainstStaging(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		targetOpportunityIds?: string[],
		stages?: string[]
	) {
		const opportunities = await this.fetchTargetOpportunities(holdingId, dateFrom, dateTo, targetOpportunityIds, stages);
		const quoteLineItemsByOpp = await this.fetchQuoteLineItems(
			holdingId,
			opportunities.map((opportunity) => opportunity.Id)
		);

		this.mergeLineItems(opportunities, quoteLineItemsByOpp);
		await this.hydrateAccounts(opportunities, holdingId);

		const opportunityIds = opportunities.map((opportunity) => opportunity.Id);
		const accountIds = [...new Set(opportunities.map((opportunity) => opportunity.AccountId).filter(Boolean))];
		const lineItemIds = opportunities.flatMap((opportunity) => (opportunity.OpportunityLineItems?.records || []).map((lineItem) => lineItem.Id));

		const [stagedOpportunities, stagedAccounts, stagedLineItems] = await Promise.all([
			opportunityIds.length
				? this.opportunitiesStgRepository.find({
						where: opportunityIds.map((salesforceId) => ({ holding_id: holdingId, salesforce_id: salesforceId })),
					})
				: [],
			accountIds.length
				? this.accountsStgRepository.find({
						where: accountIds.map((salesforceId) => ({ holding_id: holdingId, salesforce_id: salesforceId })),
					})
				: [],
			lineItemIds.length
				? this.lineItemsStgRepository.find({
						where: lineItemIds.map((salesforceId) => ({ holding_id: holdingId, salesforce_id: salesforceId })),
					})
				: [],
		]);

		const stagedOpportunityById = new Map<string, SalesforceOpportunitiesStg>(
			stagedOpportunities.map((record) => [record.salesforce_id, record] as [string, SalesforceOpportunitiesStg])
		);
		const stagedAccountById = new Map<string, SalesforceAccountsStg>(
			stagedAccounts.map((record) => [record.salesforce_id, record] as [string, SalesforceAccountsStg])
		);
		const stagedLineItemById = new Map<string, SalesforceLineItemsStg>(
			stagedLineItems.map((record) => [record.salesforce_id, record] as [string, SalesforceLineItemsStg])
		);

		return {
			items: await Promise.all(
				opportunities.map(async (opportunity) => {
					const stagedOpportunity = stagedOpportunityById.get(opportunity.Id);
					const stagedAccount = stagedAccountById.get(opportunity.AccountId);
					const unmappedProducts = await this.getUnmappedSalesforceProducts(holdingId, opportunity);
					const sourceLineItems = (opportunity.OpportunityLineItems?.records || []).map((lineItem) => ({
						...lineItem,
						OpportunityId: opportunity.Id,
					}));
					const lineItemComparisons = sourceLineItems.map((lineItem) => {
						const stagedLineItem = stagedLineItemById.get(lineItem.Id);
						return {
							salesforceId: lineItem.Id,
							status: !stagedLineItem
								? 'new'
								: this.stagingService.getSourceHash(stagedLineItem.raw_data) === this.stagingService.getSourceHash(lineItem)
									? 'synchronized'
									: 'updatable',
							staging: stagedLineItem || null,
						};
					});
					const reasons: string[] = [];
					const differences: Array<{
						scope: 'quote' | 'line_item';
						targetField: string;
						label: string;
						salesforceValue: unknown;
						sapiraValue: unknown;
					}> = [];

					if (!stagedOpportunity) {
						reasons.push('La oportunidad no existe en staging');
					} else if (this.stagingService.getSourceHash(stagedOpportunity.raw_data) !== this.stagingService.getSourceHash(opportunity as unknown as Record<string, unknown>)) {
						reasons.push('La oportunidad cambió en Salesforce');
						differences.push(
							...this.getStagingFieldDifferences(
								'Oportunidad',
								opportunity as unknown as Record<string, unknown>,
								stagedOpportunity.raw_data,
								['Account', 'OpportunityLineItems']
							)
						);
					}

					const accountPayload =
						opportunity.AccountId && opportunity.Account ? { Id: opportunity.AccountId, ...opportunity.Account } : null;
					if (!stagedAccount) {
						reasons.push('El cliente no existe en staging');
					} else if (accountPayload && this.stagingService.getSourceHash(stagedAccount.raw_data) !== this.stagingService.getSourceHash(accountPayload)) {
						reasons.push('El cliente cambió en Salesforce');
						differences.push(...this.getStagingFieldDifferences('Cliente', accountPayload, stagedAccount.raw_data));
					}

					if (lineItemComparisons.some((lineItem) => lineItem.status !== 'synchronized')) {
						reasons.push('Hay ítems nuevos o modificados en Salesforce');
					}
					if (unmappedProducts.length > 0) {
						reasons.push(`Productos sin mapping activo: ${unmappedProducts.map((product) => product.name).join(', ')}`);
					}

					return {
						opportunity,
						status: reasons.length === 0 ? 'synchronized' : stagedOpportunity ? 'updatable' : 'new',
						reasons,
						differences,
						unmappedProducts,
						staging: {
							opportunity: stagedOpportunity || null,
							account: stagedAccount || null,
							lineItems: lineItemComparisons,
						},
					};
				})
			),
		};
	}

	private getStagingFieldDifferences(
		scope: string,
		salesforceData: Record<string, unknown>,
		stagingData: Record<string, unknown>,
		excludedFields: string[] = []
	): Array<{ scope: 'quote'; targetField: string; label: string; salesforceValue: unknown; sapiraValue: unknown }> {
		const labels: Record<string, string> = {
			Name: 'Nombre',
			StageName: 'Etapa',
			Amount: 'Monto',
			CurrencyIsoCode: 'Moneda',
			CloseDate: 'Fecha de cierre',
			Type: 'Tipo',
			Description: 'Descripción',
			BusinessName__c: 'Razón social',
			DemoCountry__c: 'País',
			BillingCountry: 'País de facturación',
			RUT__c: 'RUT / Identificación fiscal',
			Industry: 'Industria',
			Segmento__c: 'Segmento',
			Email_de_contacto_principal__c: 'Email de contacto',
			Phone: 'Teléfono',
		};

		return Object.entries(salesforceData)
			.filter(([field, value]) => field !== 'attributes' && !excludedFields.includes(field) && typeof value !== 'object')
			.filter(([field, value]) => JSON.stringify(value ?? null) !== JSON.stringify(stagingData[field] ?? null))
			.map(([field, value]) => ({
				scope: 'quote' as const,
				targetField: `${scope}.${field}`,
				label: `${scope}: ${labels[field] || field}`,
				salesforceValue: value,
				sapiraValue: stagingData[field] ?? null,
			}));
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

	async syncAllActiveConnectionsDaily(): Promise<SyncCompleteResponseDto[]> {
		const connections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		const results: SyncCompleteResponseDto[] = [];
		for (const connection of connections) {
			results.push(await this.syncDailyModifiedOpportunities(connection.holding_id));
		}

		return results;
	}

	async syncDailyModifiedOpportunities(holdingId: string): Promise<SyncCompleteResponseDto> {
		const startTime = new Date();
		const stats = this.createEmptyStats();

		try {
			const { start, end } = this.getPreviousSantiagoDayRange();
			const opportunityIds = await this.fetchDailyChangedOpportunityIds(holdingId, start, end);
			if (!opportunityIds.length) {
				return {
					holding_id: holdingId,
					success: true,
					stats,
					started_at: startTime,
					completed_at: new Date(),
					duration_seconds: (Date.now() - startTime.getTime()) / 1000,
				};
			}

			for (const opportunityIdsChunk of this.chunk(opportunityIds, 500)) {
				const staging = await this.syncOpportunitiesToStaging(holdingId, undefined, undefined, opportunityIdsChunk);
				stats.opportunities += staging.importedOpportunities;

				await this.processAccountStaging(holdingId, staging.batchId, stats, {
					processingStatuses: ['create', 'update'],
				});
				await this.classifyOpportunityStaging(holdingId, staging.batchId);
				await this.processOpportunityStaging(holdingId, staging.batchId, stats, {
					processingStatuses: ['create', 'update'],
				});
			}

			return {
				holding_id: holdingId,
				success: true,
				stats,
				started_at: startTime,
				completed_at: new Date(),
				duration_seconds: (Date.now() - startTime.getTime()) / 1000,
			};
		} catch (error: any) {
			this.logger.error(`❌ Daily staging sync failed for holding ${holdingId}:`, error.message);
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

	async reclassifyStaging(holdingId: string): Promise<void> {
		await this.classifyAccountStaging(holdingId);
		await this.classifyOpportunityStaging(holdingId);
	}

	async processStaging(holdingId: string): Promise<SyncCompleteStats> {
		const stats = this.createEmptyStats();

		await this.processAccountStaging(holdingId, undefined, stats);
		await this.processOpportunityStaging(holdingId, undefined, stats);
		return stats;
	}

	async syncAccountsToStaging(
		holdingId: string,
		filters: AccountImportFilters = {}
	): Promise<{ success: boolean; imported: number; batchId: string; syncSessionId: string; soql: string }> {
		const soql = this.buildAccountsImportQuery(filters);
		const { data } = await this.queryService.executeQuery(soql, holdingId);
		const accounts: SalesforceAccount[] = data.records || [];
		const { batchId, syncSessionId } = this.stagingService.createRunContext();

		await this.stagingService.upsertAccounts(holdingId, accounts, batchId, syncSessionId);
		await this.classifyAccountStaging(holdingId, batchId);
		await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });

		return {
			success: true,
			imported: accounts.length,
			batchId,
			syncSessionId,
			soql,
		};
	}

	async reclassifyAccountsStaging(holdingId: string): Promise<void> {
		await this.classifyAccountStaging(holdingId);
	}

	async processAccountsStaging(holdingId: string, salesforceIds?: string[], clientFields?: string[]): Promise<SyncCompleteStats> {
		const stats = this.createEmptyStats();

		await this.processAccountStaging(holdingId, undefined, stats, {
			salesforceIds,
			allowedClientFields: clientFields,
		});

		return stats;
	}

	async processOpportunitiesStaging(holdingId: string, opportunityIds?: string[]): Promise<SyncCompleteStats> {
		const stats = this.createEmptyStats();
		await this.processOpportunityStaging(holdingId, undefined, stats, {
			salesforceIds: opportunityIds,
		});
		return stats;
	}

	async getOpportunityStagingStatus(holdingId: string, opportunityId: string): Promise<{ status: string | null; errorMessage: string | null } | null> {
		const opportunity = await this.opportunitiesStgRepository.findOne({
			where: { holding_id: holdingId, salesforce_id: opportunityId },
			select: ['processing_status', 'error_message'],
		});
		if (!opportunity) {
			return null;
		}

		return {
			status: opportunity.processing_status || null,
			errorMessage: opportunity.error_message || null,
		};
	}

	private async fetchOpportunitiesWithLineItems(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		stages?: string[],
		opportunityIds?: string[]
	): Promise<SalesforceOpportunityWithLineItems[]> {
		const allowedStages = stages?.length ? stages : ['Ganado', 'Closed Won', 'Cerrada Win'];
		const stageConditions = allowedStages.map((stage) => `StageName = '${stage.replace(/'/g, "\\'")}'`).join(' OR ');
		const dateConditions = opportunityIds?.length
			? `Id IN ('${opportunityIds.join("','")}')`
			: [dateFrom ? `CloseDate >= ${dateFrom}` : null, dateTo ? `CloseDate <= ${dateTo}` : null].filter(Boolean).join(' AND ');
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
			WHERE ${dateConditions ? `${dateConditions} AND ` : ''}(${stageConditions})
				AND IsDeleted = false
			ORDER BY CloseDate DESC
			LIMIT 1000
		`.trim();

		const { data } = await this.queryService.executeQuery(soql, holdingId);
		return data.records || [];
	}

	private async fetchTargetOpportunities(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		opportunityIds?: string[],
		stages?: string[]
	): Promise<SalesforceOpportunityWithLineItems[]> {
		return this.fetchOpportunitiesWithLineItems(holdingId, dateFrom, dateTo, stages, opportunityIds);
	}

	private async fetchDailyChangedOpportunityIds(holdingId: string, start: string, end: string): Promise<string[]> {
		const allowedStages = ['Ganado', 'Closed Won', 'Cerrada Win'];
		const stageConditions = allowedStages.map((stage) => `StageName = '${stage.replace(/'/g, "\\'")}'`).join(' OR ');
		const changedSince = `LastModifiedDate >= ${start} AND LastModifiedDate < ${end}`;
		const soql = `
			SELECT Id
			FROM Opportunity
			WHERE IsDeleted = false
				AND (${stageConditions})
				AND (
					${changedSince}
					OR (Account.LastModifiedDate >= ${start} AND Account.LastModifiedDate < ${end})
					OR Id IN (
						SELECT OpportunityId
						FROM Quote
						WHERE ${changedSince}
					)
					OR Id IN (
						SELECT OpportunityId
						FROM OpportunityLineItem
						WHERE ${changedSince}
					)
				)
			ORDER BY LastModifiedDate ASC
		`.trim();
		const { data } = await this.queryService.executeQuery(soql, holdingId);
		if (!data.done) {
			this.logger.warn(`La consulta diaria Salesforce del holding ${holdingId} excedió la primera página; se procesarán ${data.records.length} oportunidades`);
		}
		return [...new Set((data.records || []).map((record) => record.Id).filter(Boolean))];
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
			const clientEntityPayload = this.normalizeClientEntityPayload(
				await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', account)
			);
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
			const entityResolution = clientEntityPayload.tax_id
				? await this.resolveClientEntityByTaxId(holdingId, clientEntityPayload.tax_id, clientEntityPayload.legal_name || account.Name)
				: null;

			const existingEntity =
				entityResolution?.entities[0] ||
				(!entityResolution?.isGenericExportVat
					? await this.clientEntityRepository.findOne({
							where: { holding_id: holdingId, client_id: existingClientId },
						})
					: null);

			const comparableClientEntityPayload = this.removeBlankFields(clientEntityPayload);
			const hasChanges =
				this.hasRecordChanges(clientPayload, existingClient) ||
				this.hasRecordChanges(comparableClientEntityPayload, existingEntity);
			await this.accountsStgRepository.update(record.id, {
				processing_status: hasChanges ? 'update' : 'processed',
				integration_notes: hasChanges ? 'Cliente existente con cambios pendientes' : 'Cliente staging sincronizado',
			});
		}
	}

	private async processAccountStaging(
		holdingId: string,
		batchId: string | undefined,
		stats: SyncCompleteStats,
		options: AccountProcessingOptions = {}
	): Promise<void> {
		const records = await this.accountsStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		const filteredRecords = options.salesforceIds?.length
			? records.filter((record) => options.salesforceIds?.includes(record.salesforce_id))
			: records;

		for (const record of filteredRecords) {
			const processingStatuses = options.processingStatuses || ['create', 'update', 'error'];
			if (!processingStatuses.includes(record.processing_status || '')) {
				continue;
			}

			try {
				await this.syncAccountFromData(record.raw_data as SalesforceAccount, holdingId, stats, options);
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'processed',
					error_message: null,
					last_integrated_at: new Date(),
					processed_at: new Date(),
				});
				const relatedOpportunities = await this.opportunitiesStgRepository.find({
					where: { holding_id: holdingId, salesforce_account_id: record.salesforce_id },
				});
				await Promise.all(
					relatedOpportunities.map((opportunity) => this.resolveOpportunityBlock(holdingId, opportunity.salesforce_id, 'account_final_processing'))
				);
			} catch (error: any) {
				stats.errors.push(`Account ${record.salesforce_id}: ${error.message}`);
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'error',
					error_message: error.message,
				});
				const relatedOpportunities = await this.opportunitiesStgRepository.find({
					where: { holding_id: holdingId, salesforce_account_id: record.salesforce_id },
				});
				await Promise.all(
					relatedOpportunities.map((opportunity) =>
						this.notifyOpportunityBlocked(
							holdingId,
							opportunity,
							'account_final_processing',
							error.message,
							'Corrige el mapping o los datos requeridos del Account, cliente, entidad legal o contacto y vuelve a integrar la cotización.',
							{ account_staging_id: record.id, account_name: record.salesforce_name }
						)
					)
				);
			}
		}
	}

	private async notifyOpportunityBlocked(
		holdingId: string,
		record: SalesforceOpportunitiesStg,
		reason:
			| 'unmapped_products'
			| 'missing_account_id'
			| 'missing_staged_account'
			| 'errored_staged_account'
			| 'account_final_processing'
			| 'opportunity_final_processing',
		errorMessage: string,
		recommendation: string,
		metadata: Record<string, unknown> = {}
	): Promise<void> {
		const isFinalProcessing = reason === 'account_final_processing' || reason === 'opportunity_final_processing';
		await this.notificationsService.createOrUpdate(holdingId, {
			source: 'salesforce',
			type: SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
			severity: 'error',
			title: `Cotización bloqueada: ${record.salesforce_name || record.salesforce_id}`,
			message: errorMessage,
			recommendation,
			action_type: 'retry_salesforce_opportunity',
			action_payload: {
				salesforce_opportunity_id: record.salesforce_id,
				retry_mode: isFinalProcessing ? 'process_final' : 'retry_full',
			},
			metadata: {
				block_reason: reason,
				opportunity_staging_id: record.id,
				salesforce_opportunity_id: record.salesforce_id,
				opportunity_name: record.salesforce_name,
				salesforce_account_id: record.salesforce_account_id,
				error_message: errorMessage,
				...metadata,
			},
			deduplication_key: `salesforce:${record.salesforce_id}:${reason}`,
		});
	}

	private async resolveOpportunityBlock(holdingId: string, opportunityId: string, reason: string): Promise<void> {
		await this.notificationsService.resolveByDeduplicationKey(holdingId, `salesforce:${opportunityId}:${reason}`);
	}

	private async classifyOpportunityStaging(holdingId: string, batchId?: string): Promise<void> {
		const records = await this.opportunitiesStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
			if (!opportunity.AccountId) {
				const errorMessage = 'La oportunidad no tiene un Account asociado en Salesforce';
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'error',
					integration_notes: errorMessage,
					error_message: errorMessage,
				});
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'missing_account_id',
					errorMessage,
					'Asocia un Account a la oportunidad en Salesforce y vuelve a integrar la cotización.'
				);
				continue;
			}

			const stagedAccount = await this.accountsStgRepository.findOne({
				where: { holding_id: holdingId, salesforce_id: opportunity.AccountId },
			});

			if (!stagedAccount) {
				const errorMessage = 'Falta el Account relacionado en salesforce_accounts_stg';
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'error',
					integration_notes: errorMessage,
					error_message: errorMessage,
				});
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'missing_staged_account',
					errorMessage,
					'Vuelve a integrar la cotización para recuperar y validar su Account relacionado.'
				);
				continue;
			}

			if (stagedAccount.processing_status === 'error') {
				const errorMessage = stagedAccount.error_message || 'El Account relacionado tiene errores en staging';
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'error',
					integration_notes: 'El Account relacionado tiene errores en staging y debe resolverse antes de la cotización',
					error_message: errorMessage,
				});
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'errored_staged_account',
					errorMessage,
					'Corrige el error de datos o mapping del Account y vuelve a integrar la cotización.',
					{ account_staging_id: stagedAccount.id, account_name: stagedAccount.salesforce_name }
				);
				continue;
			}

			const unmappedProducts = await this.getUnmappedSalesforceProducts(holdingId, opportunity);
			if (unmappedProducts.length > 0) {
				const errorMessage = this.getUnmappedProductsMessage(unmappedProducts);
				await this.markUnmappedLineItemsAsError(holdingId, batchId, opportunity.Id, unmappedProducts);
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'error',
					integration_notes: 'La oportunidad contiene productos Salesforce sin mapping activo',
					error_message: errorMessage,
				});
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'unmapped_products',
					errorMessage,
					'Configura o activa el mapeo de los productos indicados y presiona “Volver a integrar”.',
					{ unmapped_products: unmappedProducts }
				);
				continue;
			}

			await Promise.all([
				this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'missing_account_id'),
				this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'missing_staged_account'),
				this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'errored_staged_account'),
				this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'unmapped_products'),
			]);

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
				await this.updateLineItemsStagingStatus(holdingId, batchId, opportunity.Id, 'create', 'Ítem listo para crear junto a la cotización');
				continue;
			}

			const hasChanges = await this.hasOpportunityChanges(holdingId, opportunity, existingQuote);
			const processingStatus = hasChanges ? 'update' : 'processed';
			await this.opportunitiesStgRepository.update(record.id, {
				processing_status: processingStatus,
				integration_notes: hasChanges ? 'Cotización existente con cambios pendientes' : 'Cotización staging sincronizada',
			});
			await this.updateLineItemsStagingStatus(
				holdingId,
				batchId,
				opportunity.Id,
				processingStatus,
				hasChanges ? 'Ítem con cambios pendientes en la cotización' : 'Ítem staging sincronizado'
			);
		}
	}

	private async processOpportunityStaging(
		holdingId: string,
		batchId: string | undefined,
		stats: SyncCompleteStats,
		options: OpportunityProcessingOptions = {}
	): Promise<void> {
		const records = await this.opportunitiesStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		const filteredRecords = options.salesforceIds?.length
			? records.filter((record) => options.salesforceIds?.includes(record.salesforce_id))
			: records;

		for (const record of filteredRecords) {
			const processingStatuses = options.processingStatuses || ['create', 'update', 'error'];
			if (!processingStatuses.includes(record.processing_status || '')) {
				continue;
			}

			try {
				await this.processOpportunity(record, holdingId, stats);
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'processed',
					error_message: null,
					last_integrated_at: new Date(),
					processed_at: new Date(),
				});
				await this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'opportunity_final_processing');

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
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'opportunity_final_processing',
					error.message,
					'Corrige el mapping o la validación indicada y vuelve a integrar la cotización.'
				);
			}
		}
	}

	private async processOpportunity(record: SalesforceOpportunitiesStg, holdingId: string, stats: SyncCompleteStats): Promise<void> {
		const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
		const clientId = await this.ensureOpportunityClientReady(record, opportunity, holdingId, stats);
		const unmappedProducts = await this.getUnmappedSalesforceProducts(holdingId, opportunity);
		if (unmappedProducts.length > 0) {
			await this.markUnmappedLineItemsAsError(holdingId, undefined, opportunity.Id, unmappedProducts);
			throw new Error(this.getUnmappedProductsMessage(unmappedProducts));
		}

		await this.syncQuote(opportunity, clientId, holdingId, stats);
	}

	private async markUnmappedLineItemsAsError(
		holdingId: string,
		batchId: string | undefined,
		opportunityId: string,
		unmappedProducts: Array<{ id: string; name: string }>
	): Promise<void> {
		await Promise.all(
			unmappedProducts.map((product) =>
				this.lineItemsStgRepository.update(
					{
						holding_id: holdingId,
						salesforce_opportunity_id: opportunityId,
						salesforce_product_id: product.id,
						...(batchId ? { batch_id: batchId } : {}),
					},
					{
						processing_status: 'error',
						integration_notes: 'El ítem tiene un producto Salesforce sin mapping activo',
						error_message: `Producto sin mapping activo: ${product.name} (${product.id})`,
					}
				)
			)
		);
	}

	private async updateLineItemsStagingStatus(
		holdingId: string,
		batchId: string | undefined,
		opportunityId: string,
		processingStatus: 'create' | 'update' | 'processed',
		integrationNotes: string
	): Promise<void> {
		await this.lineItemsStgRepository.update(
			batchId
				? { holding_id: holdingId, batch_id: batchId, salesforce_opportunity_id: opportunityId }
				: { holding_id: holdingId, salesforce_opportunity_id: opportunityId },
			{
				processing_status: processingStatus,
				integration_notes: integrationNotes,
				error_message: null,
			}
		);
	}

	private async getUnmappedSalesforceProducts(holdingId: string, opportunity: SalesforceOpportunityWithLineItems) {
		const products = new Map<string, string>();
		for (const lineItem of opportunity.OpportunityLineItems?.records || []) {
			if (!lineItem.Product2Id || products.has(lineItem.Product2Id)) continue;
			const mapping = await this.typeormService.getSalesforceProductMapping(holdingId, lineItem.Product2Id);
			if (!mapping) products.set(lineItem.Product2Id, lineItem.Product2?.Name || lineItem.Product2Id);
		}
		return [...products.entries()].map(([id, name]) => ({ id, name }));
	}

	private getUnmappedProductsMessage(products: Array<{ id: string; name: string }>): string {
		return `Productos Salesforce sin mapping activo: ${products.map((product) => `${product.name} (${product.id})`).join(', ')}. Cree el mapping manual antes de integrar la cotización.`;
	}

	private async ensureOpportunityClientReady(
		record: SalesforceOpportunitiesStg,
		opportunity: SalesforceOpportunityWithLineItems,
		holdingId: string,
		stats: SyncCompleteStats
	): Promise<string> {
		if (!opportunity.AccountId) {
			throw new Error('La oportunidad no tiene AccountId asociado');
		}

		const accountData = await this.getOpportunityAccountData(opportunity, holdingId);
		if (!accountData?.Id) {
			throw new Error(`No se pudo hidratar el Account ${opportunity.AccountId} asociado a la oportunidad ${opportunity.Id}`);
		}

		const existingStagedAccount = await this.accountsStgRepository.findOne({
			where: { holding_id: holdingId, salesforce_id: accountData.Id },
		});

		const fallbackRunContext = this.stagingService.createRunContext();
		const batchId = record.batch_id || existingStagedAccount?.batch_id || fallbackRunContext.batchId;
		const syncSessionId = record.sync_session_id || existingStagedAccount?.sync_session_id || fallbackRunContext.syncSessionId;

		await this.stagingService.upsertAccounts(holdingId, [accountData], batchId, syncSessionId);
		await this.classifyAccountStaging(holdingId, batchId);
		await this.processAccountStaging(holdingId, batchId, stats, {
			salesforceIds: [accountData.Id],
		});

		const stagedAccount = await this.accountsStgRepository.findOne({
			where: { holding_id: holdingId, salesforce_id: accountData.Id },
		});

		if (stagedAccount?.processing_status === 'error') {
			throw new Error(stagedAccount.error_message || `El Account ${accountData.Id} quedó con error en staging`);
		}

		const clientPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client', accountData);
		const clientId =
			(await this.typeormService.getObjectMapping(holdingId, 'Account', accountData.Id)) ||
			(clientPayload.client_number ? await this.typeormService.getClientByNumber(holdingId, clientPayload.client_number) : null);

		if (!clientId) {
			throw new Error(`No se pudo resolver el cliente Sapira para el Account ${accountData.Id}`);
		}

		return clientId;
	}

	private async getOpportunityAccountData(opportunity: SalesforceOpportunityWithLineItems, holdingId: string): Promise<SalesforceAccount | null> {
		if (opportunity.Account) {
			return {
				Id: opportunity.AccountId,
				...opportunity.Account,
			} as SalesforceAccount;
		}

		return this.fetchAccount(opportunity.AccountId, holdingId);
	}

	private async syncAccountFromData(
		accountData: SalesforceAccount,
		holdingId: string,
		stats: SyncCompleteStats,
		options: AccountProcessingOptions = {}
	): Promise<string> {
		if (!accountData?.Id) {
			throw new Error('Salesforce Account inválido para sincronización');
		}

		const clientPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client', accountData);
		const entityPayload = this.normalizeClientEntityPayload(
			await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', accountData)
		);
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
			const clientUpdatePayload = options.allowedClientFields?.length
				? this.pickFields(clientPayload, options.allowedClientFields)
				: clientPayload;

			await this.clientRepository.update(
				{ id: existingClientId, holding_id: holdingId },
				{
					...clientUpdatePayload,
					holding_id: holdingId,
				}
			);

			const existingMapping = await this.typeormService.getObjectMapping(holdingId, 'Account', accountData.Id);
			if (!existingMapping) {
				await this.typeormService.createObjectMapping(holdingId, 'Account', accountData.Id, 'clients', existingClientId);
			}

			if (!options.allowedClientFields?.length) {
				await this.ensurePrincipalContact(existingClientId, accountData, holdingId);
				await this.createOrLinkClientEntity(existingClientId, entityPayload, accountData, holdingId);
			}
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

	private buildAccountsImportQuery(filters: AccountImportFilters): string {
		const baseFields = `
			Id, Name, Salesforce_API_ID__c, Industry, Segmento__c,
			BillingCountry, BillingStreet, BillingCity, BillingState, BillingPostalCode,
			DemoCountry__c, BusinessName__c, RUT__c,
			Email_de_contacto_principal__c, Industria_sector__c,
			Plazos_de_pago__c, Lista_de_Precio__r.Tipo__c,
			M_nimo_facturable_licencias__c, Per_odo_de_facturaci_n__c,
			Phone
		`
			.replace(/\s+/g, ' ')
			.trim();

		if (filters.dateFrom && filters.dateTo) {
			return `
				SELECT ${baseFields}
				FROM Account
				WHERE IsDeleted = false
					AND Id IN (
						SELECT AccountId
						FROM Opportunity
						WHERE CloseDate >= ${filters.dateFrom}
							AND CloseDate <= ${filters.dateTo}
							AND IsDeleted = false
					)
				ORDER BY Name
				LIMIT 500
			`
				.replace(/\s+/g, ' ')
				.trim();
		}

		let letterCondition = '';
		if (filters.subRange) {
			const [start, end] = filters.subRange.split('-');
			if (end.endsWith('z')) {
				const mainLetter = end.charAt(0);
				const nextMainLetter = String.fromCharCode(mainLetter.charCodeAt(0) + 1);
				letterCondition = `AND Name >= '${start}' AND Name < '${nextMainLetter}'`;
			} else {
				const lastChar = end.charAt(end.length - 1);
				const nextChar = String.fromCharCode(lastChar.charCodeAt(0) + 1);
				const upperLimit = end.slice(0, -1) + nextChar;
				letterCondition = `AND Name >= '${start}' AND Name < '${upperLimit}'`;
			}
		} else if (filters.letter === '#') {
			letterCondition = `AND (Name LIKE '0%' OR Name LIKE '1%' OR Name LIKE '2%' OR Name LIKE '3%' OR Name LIKE '4%' OR Name LIKE '5%' OR Name LIKE '6%' OR Name LIKE '7%' OR Name LIKE '8%' OR Name LIKE '9%')`;
		} else if (filters.letter === '@') {
			letterCondition = `AND (Name LIKE '+%' OR Name LIKE '-%' OR Name LIKE '.%' OR Name LIKE '_%')`;
		} else if (filters.letter) {
			letterCondition = `AND Name LIKE '${filters.letter}%'`;
		}

		return `
			SELECT ${baseFields}
			FROM Account
			WHERE IsDeleted = false ${letterCondition}
			ORDER BY Name
			LIMIT 500
		`
			.replace(/\s+/g, ' ')
			.trim();
	}

	private pickFields(payload: Record<string, any>, allowedFields: string[]): Record<string, any> {
		return Object.fromEntries(Object.entries(payload).filter(([key, value]) => allowedFields.includes(key) && value !== undefined));
	}

	private normalizeClientEntityPayload(payload: Record<string, any>): Record<string, any> {
		return {
			...payload,
			tax_id: transformers.normalizeTaxId(payload.tax_id),
		};
	}

	private async ensurePrincipalContact(clientId: string, accountData: SalesforceAccount, holdingId: string): Promise<void> {
		const email = accountData.Email_de_contacto_principal__c;
		const phone = accountData.Phone || null;
		if (!email && !phone) {
			return;
		}

		const existingContact = await this.typeormService.getClientContact(clientId, 'Principal');
		if (existingContact) {
			const contactUpdate = {
				...(this.isBlankValue(existingContact.email) && email ? { email } : {}),
				...(this.isBlankValue(existingContact.phone) && phone ? { phone } : {}),
			};
			if (Object.keys(contactUpdate).length > 0) {
				await this.typeormService.updateClientContact(existingContact.id, contactUpdate);
			}
			return;
		}

		await this.typeormService.createClientContact({
			client_id: clientId,
			holding_id: holdingId,
			contact_type: 'Principal',
			email: email || null,
			phone,
		});
	}

	private async createOrLinkClientEntity(
		clientId: string,
		entityPayload: Record<string, any>,
		accountData: SalesforceAccount,
		holdingId: string
	): Promise<void> {
		const normalizedEntityPayload = this.normalizeClientEntityPayload(entityPayload);
		const legalName = normalizedEntityPayload.legal_name || accountData.Name;
		const taxId = normalizedEntityPayload.tax_id || null;
		const hasLegalInfo = legalName || taxId;
		if (!hasLegalInfo) {
			return;
		}

		const basePayload = {
			client_id: clientId,
			holding_id: holdingId,
			legal_name: legalName,
			tax_id: taxId,
			country: normalizedEntityPayload.country || null,
			legal_address: normalizedEntityPayload.legal_address || null,
			economic_activity: normalizedEntityPayload.economic_activity || accountData.Industry || null,
			client_number: normalizedEntityPayload.client_number || null,
		};
		const entityUpdatePayload = {
			holding_id: holdingId,
			legal_name: legalName,
			tax_id: taxId,
			country: normalizedEntityPayload.country || null,
			legal_address: normalizedEntityPayload.legal_address || null,
			economic_activity: normalizedEntityPayload.economic_activity || accountData.Industry || null,
			client_number: normalizedEntityPayload.client_number || null,
		};

		if (taxId) {
			const entityResolution = await this.resolveClientEntityByTaxId(holdingId, taxId, legalName);
			if (entityResolution.entities.length > 0) {
				for (const entity of entityResolution.entities) {
					await this.clientEntityRepository.update(entity.id, this.fillClientEntityFieldsWhenEmpty(entity, entityUpdatePayload));
					await this.resolveOdooPartnerForEntity(holdingId, entity.id);
				}
				return;
			}

			if (entityResolution.isGenericExportVat) {
				const savedEntity = await this.clientEntityRepository.save(this.clientEntityRepository.create(basePayload));
				await this.typeormService.createClientEntityClient(savedEntity.id, clientId, holdingId);
				await this.resolveOdooPartnerForEntity(holdingId, savedEntity.id);
				return;
			}
		}

		const existingByClient = await this.clientEntityRepository.findOne({
			where: { holding_id: holdingId, client_id: clientId },
		});
		if (existingByClient) {
			await this.clientEntityRepository.update(existingByClient.id, {
				...this.fillClientEntityFieldsWhenEmpty(existingByClient, basePayload),
				// La ausencia de RUT en Salesforce no autoriza eliminar un identificador fiscal ya validado en Sapira.
				tax_id: taxId || existingByClient.tax_id || null,
			});
			await this.typeormService.createClientEntityClient(existingByClient.id, clientId, holdingId);
			await this.resolveOdooPartnerForEntity(holdingId, existingByClient.id);
			return;
		}

		const savedEntity = await this.clientEntityRepository.save(this.clientEntityRepository.create(basePayload));
		await this.typeormService.createClientEntityClient(savedEntity.id, clientId, holdingId);
		await this.resolveOdooPartnerForEntity(holdingId, savedEntity.id);
	}

	private fillClientEntityFieldsWhenEmpty(existing: Record<string, any>, candidate: Record<string, any>): Record<string, any> {
		const protectedFields = ['legal_name', 'legal_address', 'country'];
		return {
			...candidate,
			...Object.fromEntries(
				protectedFields
					.filter((field) => !this.isBlankValue(existing[field]))
					.map((field) => [field, existing[field]])
			),
		};
	}

	private isBlankValue(value: unknown): boolean {
		return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
	}

	private removeBlankFields(payload: Record<string, any>): Record<string, any> {
		return Object.fromEntries(Object.entries(payload).filter(([, value]) => !this.isBlankValue(value)));
	}

	private async resolveClientEntityByTaxId(holdingId: string, taxId: string, legalName?: string) {
		const isGenericExportVat = await this.genericVatsService.isGenericExportVat(taxId);
		const resolution = await this.typeormService.resolveClientEntitiesByTaxId(holdingId, taxId);
		const normalizedLegalName = this.normalizeLegalName(legalName);
		const entities =
			isGenericExportVat && normalizedLegalName
				? resolution.entities.filter((entity) => this.normalizeLegalName(entity.legal_name) === normalizedLegalName)
				: isGenericExportVat
					? []
					: resolution.entities;

		return { entities, isGenericExportVat };
	}

	private normalizeLegalName(value?: string | null): string {
		return (value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
	}

	private async resolveOdooPartnerForEntity(holdingId: string, clientEntityId: string): Promise<void> {
		try {
			const result = await this.odooPartnersService.resolveAndLinkPartnerForEntityId(holdingId, clientEntityId);
			if (result.status !== 'found' && result.status !== 'already_linked') {
				this.logger.warn(`No se vinculó partner Odoo para entidad ${clientEntityId}: ${result.status}`);
			}
		} catch (error: any) {
			this.logger.warn(`Error resolviendo partner Odoo para entidad ${clientEntityId}: ${error.message}`);
		}
	}

	private async syncQuote(
		opportunity: SalesforceOpportunityWithLineItems,
		clientId: string,
		holdingId: string,
		stats: SyncCompleteStats
	): Promise<void> {
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
			(await this.quoteRepository
				.findOne({
					where: { holding_id: holdingId, salesforce_opportunity_id: opportunity.Id },
					select: ['id'],
				})
				.then((quote) => quote?.id || null));

		let quoteId: string;
		if (existingQuoteId) {
			quoteId = await this.typeormService.upsertQuote({ ...quoteData, id: existingQuoteId });
			stats.quotesUpdated++;
		} else {
			quoteId = await this.typeormService.upsertQuote(quoteData);
			await this.typeormService.createObjectMapping(holdingId, 'Opportunity', opportunity.Id, 'quotes', quoteId);
			stats.quotesCreated++;
		}

		const quoteItems: Record<string, any>[] = [];
		for (const lineItem of opportunity.OpportunityLineItems?.records || []) {
			const { transformation, ...resolvedLineItem } = await this.resolveLineItemPreview(
				holdingId,
				opportunity,
				lineItem,
				mappedQuoteData.currency || opportunity.CurrencyIsoCode || 'USD'
			);

			quoteItems.push({
				quote_id: quoteId,
				holding_id: holdingId,
				...resolvedLineItem,
			});
		}

		if (quoteItems.length) {
			await this.typeormService.createQuoteItems(quoteItems);
			stats.quoteItemsCreated += quoteItems.length;
		}
	}

	async resolveLineItemPreview(
		holdingId: string,
		opportunity: SalesforceOpportunityWithLineItems,
		lineItem: SalesforceOpportunityLineItem,
		currency: string = opportunity.CurrencyIsoCode || 'USD'
	): Promise<ResolvedSalesforceLineItemPreview> {
		const linePayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'line_item', lineItem, {
			opportunity,
			lineItem,
		});
		const productMapping = lineItem.Product2Id ? await this.typeormService.getSalesforceProductMapping(holdingId, lineItem.Product2Id) : null;
		const isRecurring = linePayload.is_recurring ?? transformers.isRecurring(lineItem.Recurrencia__c);
		const startDate = lineItem.Fecha_de_inicio__c || lineItem.ServiceDate || null;
		const termMonths = transformers.calculateTermMonths(startDate || undefined, lineItem.Fecha_de_Fin__c || undefined, isRecurring);
		const hasExplicitEndDate = !!lineItem.Fecha_de_Fin__c;
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
		const finalPrice = discountPercentage && discountPercentage > 0 ? calculatedPrice * (1 - discountPercentage / 100) : calculatedPrice;

		return {
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
			currency,
			start_date: transformers.parseSalesforceDate(startDate),
			end_date: transformers.parseSalesforceDate(endDate),
			billing_method: linePayload.billing_method || transformers.transformBillingMethod(opportunity.Forma_de_pago__c),
			billing_frequency:
				linePayload.billing_frequency || opportunity.Account?.Per_odo_de_facturaci_n__c || opportunity.Modalidad_de_pago__c || null,
			transformation: {
				product_mapping: !!productMapping,
				derived_end_date: !hasExplicitEndDate && !!endDate,
			},
		};
	}

	async resolveClientEntityPreview(holdingId: string, account: SalesforceAccount): Promise<ResolvedSalesforceClientEntityPreview> {
		const payload = this.normalizeClientEntityPayload(
			await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', account)
		);
		const legalName = payload.legal_name || account.Name || null;
		const taxId = payload.tax_id || null;

		if (!taxId) {
			return {
				salesforce_account_id: account.Id,
				is_generic_export_vat: false,
				will_create: false,
				entities: [],
			};
		}

		const resolution = await this.resolveClientEntityByTaxId(holdingId, taxId, legalName);
		const fields = ['legal_name', 'tax_id', 'country', 'legal_address', 'economic_activity', 'client_number'] as const;

		return {
			salesforce_account_id: account.Id,
			is_generic_export_vat: resolution.isGenericExportVat,
			will_create: resolution.isGenericExportVat && resolution.entities.length === 0,
			entities: resolution.entities.map((entity) => ({
				id: entity.id,
				client_id: entity.client_id,
				changes: fields
					.filter((field) => JSON.stringify(entity[field]) !== JSON.stringify(payload[field]))
					.map((field) => ({
						field,
						current_value: entity[field] ?? null,
						transformed_value: payload[field] ?? null,
					})),
			})),
		};
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

	private getPreviousSantiagoDayRange(reference = new Date()): { start: string; end: string } {
		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'America/Santiago',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		const parts = Object.fromEntries(formatter.formatToParts(reference).map((part) => [part.type, part.value]));
		const endDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
		const startDate = new Date(endDate);
		startDate.setUTCDate(startDate.getUTCDate() - 1);
		const toSantiagoMidnightUtc = (date: Date) => {
			const offsetFormatter = new Intl.DateTimeFormat('en-US', {
				timeZone: 'America/Santiago',
				timeZoneName: 'longOffset',
			});
			const offset = offsetFormatter.formatToParts(date).find((part) => part.type === 'timeZoneName')?.value || 'GMT-00:00';
			const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
			const offsetMinutes = match
				? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
				: 0;
			return new Date(date.getTime() - offsetMinutes * 60 * 1000).toISOString();
		};

		return {
			start: toSantiagoMidnightUtc(startDate),
			end: toSantiagoMidnightUtc(endDate),
		};
	}

	private chunk<T>(items: T[], size: number): T[][] {
		return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
	}

	private createEmptyStats(): SyncCompleteStats {
		return {
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
	}

	private async buildOpportunityBatchSummary(holdingId: string, batchId: string): Promise<Record<string, number>> {
		const records = await this.opportunitiesStgRepository.find({
			where: { holding_id: holdingId, batch_id: batchId },
			select: ['processing_status'],
		});

		return records.reduce<Record<string, number>>((summary, record) => {
			const key = record.processing_status || 'unknown';
			summary[key] = (summary[key] || 0) + 1;
			return summary;
		}, {});
	}
}
