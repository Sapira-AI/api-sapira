import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { GenericVatsService } from '@/common/services/generic-vats.service';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { QuoteItem } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote-item.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';
import { SalesforceAccountsStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-accounts-stg.entity';
import { SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { SalesforceLineItemsStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-line-items-stg.entity';
import { SalesforceOpportunitiesStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunities-stg.entity';
import {
	NotificationsService,
	SALESFORCE_STAGING_BLOCKED_NOTIFICATION_TYPE,
	SALESFORCE_SYNC_FAILURE_NOTIFICATION_TYPE,
} from '@/modules/notifications/notifications.service';
import { OdooPartnersService } from '@/modules/odoo/odoo-partners.service';
import { headerChanges, itemChanges, QuoteItemSnapshot } from '@/modules/quotes/quote-edit-diff';

import { SyncCompleteResponseDto, SyncCompleteStats } from '../dtos/salesforce-sync-complete.dto';
import { SalesforceTaxIdNormalizationResponseDto } from '../dtos/salesforce-tax-id-normalization.dto';
import {
	SalesforceAccount,
	SalesforceOpportunityLineItem,
	SalesforceOpportunityWithLineItems,
	SalesforceQuote,
	SalesforceQuoteLineItem,
} from '../interfaces/salesforce.interface';
import { SalesforceSyncLogStage } from '../schemas/salesforce-sync-log.schema';
import {
	buildCrmQuoteSnapshot,
	classifyExistingCrmQuote,
	CRM_QUOTE_NOTES,
	CRM_QUOTE_PROTECTION_MESSAGES,
	CRM_QUOTE_PROTECTION_SQL,
	CrmQuoteClassification,
	CrmQuoteProtection,
	crmQuoteProtection,
	CrmQuoteSnapshot,
	crmSnapshotChanged,
	crmSnapshotChanges,
	CrmSnapshotFieldChange,
	readCrmQuoteSnapshot,
	snapshotValue,
	storedCrmQuoteSnapshot,
} from '../utils/crm-quote-snapshot';
import * as transformers from '../utils/salesforce-transformers';

import { SalesforceFieldMappingEngineService } from './salesforce-field-mapping-engine.service';
import { SalesforceQueryService } from './salesforce-query.service';
import { SalesforceStagingService } from './salesforce-staging.service';
import { SalesforceSyncLogContext, SalesforceSyncLogEntry, SalesforceSyncLogService } from './salesforce-sync-log.service';
import { SalesforceTypeOrmService } from './salesforce-typeorm.service';

/** Días calendario de `CloseDate` que revisa la sincronización automática, hoy incluido. */
export const DAILY_SYNC_WINDOW_DAYS = 30;

/** Oportunidades por lote de la sincronización automática. */
export const DAILY_SYNC_CHUNK_SIZE = 500;

/** Etapas ganadoras que la integración considera integrables. */
export const SALESFORCE_WON_STAGES = ['Ganado', 'Closed Won', 'Cerrada Win'];

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
	insertOnly?: boolean;
	/**
	 * Usuario (`public.users.id`) que confirmó aplicar los cambios del CRM a cotizaciones existentes. Solo vale con `salesforceIds`
	 * (nunca en la sincronización diaria ni con `all`); sin él, una cotización existente no se toca.
	 */
	confirmedBy?: string | null;
}

/** Resultado de llevar una oportunidad a su cotización (cotizaciones protegidas). */
export type CrmQuoteSyncOutcome = 'created' | 'updated' | 'unchanged' | 'protected' | 'needs_confirmation' | 'skipped';

export interface CrmQuoteSyncResult {
	outcome: CrmQuoteSyncOutcome;
	message: string | null;
}

/** Diferencias de una oportunidad: lo que llegó del CRM en la última importación frente a lo que llega ahora. */
export interface SalesforceOpportunityChangesPreview {
	salesforce_id: string;
	label: string | null;
	processing_status: string | null;
	quote_id: string | null;
	quote_label: string | null;
	protection: CrmQuoteProtection;
	/** Hay una base con qué comparar (snapshot de importación o base tomada al traer). */
	has_snapshot: boolean;
	last_imported_at: Date | null;
	changes: CrmSnapshotFieldChange[];
}

/** Autor del evento `UPDATED` que deja la importación del CRM en el historial de la cotización. */
export const CRM_SYNC_EVENT_AUTHOR = 'Sincronización del CRM';

/** La cotización ya existía al crearla (índice único): la transacción quedó abortada y se revierte. */
class QuoteAlreadyIntegratedError extends Error {}

interface OpportunityClassificationOptions {
	insertOnly?: boolean;
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

/** Texto comparable: sin tildes, espacios repetidos ni mayúsculas ("CHANDRA" = "Chandra", "Mexico" = "México"). */
export const normalizeComparableText = (value: string) =>
	value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase('es');

/** Campos de la razón social que importar una cuenta no pisa si ya tienen valor en Sapira. */
export const CLIENT_ENTITY_PROTECTED_FIELDS = ['legal_name', 'legal_address', 'country'];

export interface SalesforceAccountFieldChange {
	target: 'client' | 'client_entity';
	field: string;
	current: unknown;
	incoming: unknown;
	/** Importar la cuenta aplica este valor (false: se conserva el actual). */
	applies: boolean;
}

export interface SalesforceAccountChangesPreview {
	salesforce_id: string;
	processing_status: string | null;
	client_id: string | null;
	client_name: string | null;
	client_entity_id: string | null;
	changes: SalesforceAccountFieldChange[];
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

/** "Qué pasó" de una cotización del CRM detenida, por motivo (Notificaciones v2: sin códigos ni marcas). */
const OPPORTUNITY_BLOCK_MESSAGES: Record<string, string> = {
	unmapped_products: 'La oportunidad ganada trae productos que no están relacionados con productos de Sapira.',
	missing_account_id: 'La oportunidad ganada no tiene una cuenta (cliente) asociada en el CRM.',
	missing_staged_account: 'No pudimos traer desde el CRM la cuenta (cliente) de la oportunidad ganada.',
	errored_staged_account: 'La cuenta (cliente) de la oportunidad ganada tiene datos incompletos o sin relacionar.',
	account_final_processing: 'No pudimos crear el cliente, la razón social o el contacto de la oportunidad ganada.',
	opportunity_final_processing: 'No pudimos crear la cotización con los datos de la oportunidad ganada.',
};

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
		private readonly notificationsService: NotificationsService,
		private readonly syncLogService: SalesforceSyncLogService
	) {}

	async syncOpportunitiesComplete(
		holdingId: string,
		dateFrom?: string,
		dateTo?: string,
		opportunityIds?: string[],
		options: OpportunityClassificationOptions = {}
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
			await this.classifyOpportunityStaging(holdingId, batchId, options);
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
		opportunityIds?: string[],
		options: OpportunityClassificationOptions = {}
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
		await this.classifyOpportunityStaging(holdingId, batchId, options);
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
					} else if (
						this.stagingService.getSourceHash(stagedOpportunity.raw_data) !==
						this.stagingService.getSourceHash(opportunity as unknown as Record<string, unknown>)
					) {
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
					} else if (
						accountPayload &&
						this.stagingService.getSourceHash(stagedAccount.raw_data) !== this.stagingService.getSourceHash(accountPayload)
					) {
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
			.filter(([field, value]) => JSON.stringify(value ?? null) !== JSON.stringify(stagingData?.[field] ?? null))
			.map(([field, value]) => ({
				scope: 'quote' as const,
				targetField: `${scope}.${field}`,
				label: `${scope}: ${labels[field] || field}`,
				salesforceValue: value,
				sapiraValue: stagingData?.[field] ?? null,
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

	async syncAllActiveConnectionsDaily(context?: SalesforceSyncLogContext): Promise<SyncCompleteResponseDto[]> {
		const connections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		const results: SyncCompleteResponseDto[] = [];
		for (const connection of connections) {
			results.push(await this.syncDailyModifiedOpportunities(connection.holding_id, context));
		}

		return results;
	}

	async syncDailyModifiedOpportunities(holdingId: string, context?: SalesforceSyncLogContext): Promise<SyncCompleteResponseDto> {
		const startTime = new Date();
		const stats = this.createEmptyStats();
		const { start, end } = this.getSantiagoCloseDateRange(DAILY_SYNC_WINDOW_DAYS);
		const log = this.buildLogRecorder(context, holdingId);

		await log({
			stage: 'holding',
			message: `Inicio de sincronización automática del holding con ventana CloseDate ${start} → ${end}`,
			metadata: { closeDateFrom: start, closeDateTo: end, windowDays: DAILY_SYNC_WINDOW_DAYS },
		});

		let opportunityIds: string[];
		try {
			opportunityIds = await this.fetchDailyTargetOpportunityIds(holdingId, start, end);
		} catch (error: any) {
			// La selección es el único paso que sigue siendo fatal: sin IDs no hay nada que procesar.
			return this.buildFailedDailyResult(holdingId, stats, startTime, error, 'selection', { closeDateFrom: start, closeDateTo: end }, context);
		}

		await log({
			stage: 'selection',
			message: `Salesforce devolvió ${opportunityIds.length} oportunidades ganadas en la ventana`,
			metadata: { opportunityCount: opportunityIds.length, closeDateFrom: start, closeDateTo: end },
		});

		if (!opportunityIds.length) {
			await this.resolveDailySyncFailure(holdingId);
			return {
				holding_id: holdingId,
				success: true,
				stats,
				started_at: startTime,
				completed_at: new Date(),
				duration_seconds: (Date.now() - startTime.getTime()) / 1000,
			};
		}

		const chunks = this.chunk(opportunityIds, DAILY_SYNC_CHUNK_SIZE);
		const chunkErrors: string[] = [];

		for (const [chunkIndex, opportunityIdsChunk] of chunks.entries()) {
			// Cada lote se aísla: una falla de red, de API o de datos no puede
			// dejar sin procesar a los lotes restantes del holding.
			try {
				const staging = await this.syncOpportunitiesToStaging(holdingId, undefined, undefined, opportunityIdsChunk, {
					insertOnly: true,
				});
				stats.opportunities += staging.importedOpportunities;

				await log({
					stage: 'staging',
					message: `Lote ${chunkIndex + 1}/${chunks.length} cargado en staging`,
					batchId: staging.batchId,
					metadata: {
						chunkIndex: chunkIndex + 1,
						chunkTotal: chunks.length,
						requestedOpportunities: opportunityIdsChunk.length,
						importedOpportunities: staging.importedOpportunities,
						importedAccounts: staging.importedAccounts,
						importedLineItems: staging.importedLineItems,
						discardedWithoutLineItems: opportunityIdsChunk.length - staging.importedOpportunities,
						summary: staging.summary,
						unmappedProducts: staging.unmappedProducts,
					},
				});

				await this.processAccountStaging(holdingId, staging.batchId, stats, {
					processingStatuses: ['create'],
				});
				await this.classifyOpportunityStaging(holdingId, staging.batchId, { insertOnly: true });
				await this.processOpportunityStaging(holdingId, staging.batchId, stats, {
					processingStatuses: ['create'],
					insertOnly: true,
				});

				await this.recordOpportunityOutcomes(holdingId, staging.batchId, context);
			} catch (error: any) {
				const message = error?.message || 'Error desconocido';
				chunkErrors.push(`Lote ${chunkIndex + 1}/${chunks.length}: ${message}`);
				stats.errors.push(`Chunk ${chunkIndex + 1}: ${message}`);
				this.logger.error(`❌ Falló el lote ${chunkIndex + 1}/${chunks.length} del holding ${holdingId}: ${message}`);

				await this.syncLogService.recordError(
					{
						...this.buildLogBase(context, holdingId),
						stage: 'staging',
						message: `Falló el lote ${chunkIndex + 1}/${chunks.length}; sus oportunidades no llegaron a staging`,
						metadata: {
							chunkIndex: chunkIndex + 1,
							chunkTotal: chunks.length,
							opportunityIds: opportunityIdsChunk,
						},
					},
					error
				);
				await this.notifyDailySyncFailure(holdingId, message, {
					stage: 'staging',
					chunk_index: chunkIndex + 1,
					chunk_total: chunks.length,
					job_id: context?.jobId,
					execution_environment: context?.executionEnvironment,
				});
			}
		}

		const success = chunkErrors.length === 0;
		// Notificaciones v2: la corrida buena del holding cierra el aviso de falla de sincronización.
		if (success) await this.resolveDailySyncFailure(holdingId);
		await log({
			stage: 'holding',
			level: success ? 'info' : 'error',
			message: success
				? 'Sincronización automática del holding finalizada sin errores de lote'
				: `Sincronización automática del holding finalizada con ${chunkErrors.length} de ${chunks.length} lotes fallidos`,
			errorMessage: success ? undefined : chunkErrors.join(' | '),
			durationMs: Date.now() - startTime.getTime(),
			metadata: { stats, chunkTotal: chunks.length, failedChunks: chunkErrors.length },
		});

		return {
			holding_id: holdingId,
			success,
			stats,
			error: success ? undefined : chunkErrors.join(' | '),
			started_at: startTime,
			completed_at: new Date(),
			duration_seconds: (Date.now() - startTime.getTime()) / 1000,
		};
	}

	private async buildFailedDailyResult(
		holdingId: string,
		stats: SyncCompleteStats,
		startTime: Date,
		error: any,
		stage: SalesforceSyncLogStage,
		metadata: Record<string, unknown>,
		context?: SalesforceSyncLogContext
	): Promise<SyncCompleteResponseDto> {
		const message = error?.message || 'Error desconocido';
		this.logger.error(`❌ Daily staging sync failed for holding ${holdingId}:`, message);

		await this.syncLogService.recordError(
			{
				...this.buildLogBase(context, holdingId),
				stage,
				message: 'La sincronización automática del holding no pudo iniciarse',
				metadata,
			},
			error
		);
		await this.notifyDailySyncFailure(holdingId, message, {
			stage,
			job_id: context?.jobId,
			execution_environment: context?.executionEnvironment,
			...metadata,
		});

		return {
			holding_id: holdingId,
			success: false,
			stats,
			error: message,
			started_at: startTime,
			completed_at: new Date(),
			duration_seconds: (Date.now() - startTime.getTime()) / 1000,
		};
	}

	/**
	 * Emite un evento de bitácora por cada oportunidad del lote con el estado y
	 * el motivo exacto con el que quedó en staging, para que un fallo individual
	 * sea auditable sin revisar la base.
	 */
	private async recordOpportunityOutcomes(holdingId: string, batchId: string, context?: SalesforceSyncLogContext): Promise<void> {
		if (!context) {
			return;
		}

		const records = await this.opportunitiesStgRepository.find({
			where: { holding_id: holdingId, batch_id: batchId },
		});

		await this.syncLogService.recordMany(
			records.map((record) => ({
				...this.buildLogBase(context, holdingId),
				stage: 'opportunity' as SalesforceSyncLogStage,
				level: record.processing_status === 'error' ? ('error' as const) : ('info' as const),
				message:
					record.processing_status === 'error'
						? `Oportunidad bloqueada: ${record.integration_notes || 'sin detalle de clasificación'}`
						: `Oportunidad en estado ${record.processing_status || 'sin estado'}`,
				salesforceOpportunityId: record.salesforce_id,
				salesforceOpportunityName: record.salesforce_name || undefined,
				salesforceAccountId: record.salesforce_account_id || undefined,
				processingStatus: record.processing_status || undefined,
				integrationNotes: record.integration_notes || undefined,
				errorMessage: record.error_message || undefined,
				batchId,
			}))
		);
	}

	private async notifyDailySyncFailure(holdingId: string, errorMessage: string, metadata: Record<string, unknown>): Promise<void> {
		try {
			await this.notificationsService.createOrUpdate(holdingId, {
				source: 'salesforce',
				type: SALESFORCE_SYNC_FAILURE_NOTIFICATION_TYPE,
				severity: 'error',
				title: 'Falló la sincronización con el CRM',
				message:
					metadata.stage === 'selection'
						? 'La sincronización automática de hoy no pudo leer las oportunidades del CRM: las ganadas no llegaron a Sapira.'
						: 'Una parte de la sincronización automática de hoy falló: algunas oportunidades ganadas no llegaron a Sapira.',
				recommendation:
					'Revisa la conexión y el historial en Integraciones › CRM › Historial. Si sigue fallando, avísanos: la próxima corrida lo reintenta.',
				action_type: 'review_salesforce_sync_log',
				action_payload: {
					job_id: metadata.job_id,
					execution_environment: metadata.execution_environment,
				},
				metadata: { ...metadata, error_message: errorMessage },
				deduplication_key: `salesforce:daily-sync:${holdingId}:${metadata.stage}`,
			});
		} catch (error: any) {
			this.logger.error(`No se pudo notificar el fallo de sincronización del holding ${holdingId}: ${error.message}`);
		}
	}

	/** Cierra los avisos `salesforce_sync_failure` abiertos del holding (todas las etapas). Un fallo aquí no afecta la corrida. */
	private async resolveDailySyncFailure(holdingId: string): Promise<void> {
		try {
			await this.notificationsService.resolveOpen(holdingId, { type: SALESFORCE_SYNC_FAILURE_NOTIFICATION_TYPE });
		} catch (error: any) {
			this.logger.warn(`No se pudo cerrar el aviso de sincronización del holding ${holdingId}: ${error.message}`);
		}
	}

	private buildLogBase(context: SalesforceSyncLogContext | undefined, holdingId: string) {
		return {
			jobId: context?.jobId || 'manual',
			executionEnvironment: context?.executionEnvironment || 'unknown',
			holdingId,
		};
	}

	/**
	 * Devuelve un registrador que no hace nada cuando la sincronización se
	 * invoca fuera del scheduler (por ejemplo desde un endpoint manual).
	 */
	private buildLogRecorder(context: SalesforceSyncLogContext | undefined, holdingId: string) {
		return async (entry: Omit<SalesforceSyncLogEntry, 'jobId' | 'executionEnvironment' | 'holdingId'>): Promise<void> => {
			if (!context) {
				return;
			}
			await this.syncLogService.record({ ...this.buildLogBase(context, holdingId), ...entry });
		};
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

	/**
	 * Importa oportunidades de la tabla intermedia. `confirmedBy`: quien confirmó aplicar los cambios del CRM a cotizaciones existentes
	 * (solo con `opportunityIds`); sin él, una cotización existente queda "Por revisar" y no se toca.
	 */
	async processOpportunitiesStaging(
		holdingId: string,
		opportunityIds?: string[],
		options: { confirmedBy?: string | null } = {}
	): Promise<SyncCompleteStats> {
		const stats = this.createEmptyStats();
		await this.processOpportunityStaging(holdingId, undefined, stats, {
			salesforceIds: opportunityIds,
			confirmedBy: opportunityIds?.length ? (options.confirmedBy ?? null) : null,
		});
		return stats;
	}

	async getOpportunityStagingStatus(
		holdingId: string,
		opportunityId: string
	): Promise<{ status: string | null; errorMessage: string | null } | null> {
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

	/**
	 * Selecciona las oportunidades ganadas cuya `CloseDate` cae en la ventana.
	 *
	 * Usa el mismo criterio que la integración manual (`CloseDate`) en lugar de
	 * `LastModifiedDate`: al reevaluar toda la ventana en cada corrida, una
	 * oportunidad que quedó bloqueada un día se vuelve a intentar los días
	 * siguientes sin depender de que alguien la modifique en Salesforce.
	 */
	private async fetchDailyTargetOpportunityIds(holdingId: string, start: string, end: string): Promise<string[]> {
		const stageConditions = SALESFORCE_WON_STAGES.map((stage) => `StageName = '${stage.replace(/'/g, "\\'")}'`).join(' OR ');
		const soql = `
			SELECT Id
			FROM Opportunity
			WHERE IsDeleted = false
				AND (${stageConditions})
				AND CloseDate >= ${start}
				AND CloseDate <= ${end}
			ORDER BY CloseDate DESC
		`.trim();
		const { data } = await this.queryService.executeQuery(soql, holdingId);
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

	/**
	 * Lo que llegó del CRM para una cuenta (mapeos de campos activos del holding) frente al cliente y la razón social actuales: la misma
	 * comparación con la que `classifyAccountStaging` marca `create`/`update`.
	 */
	private async compareAccount(holdingId: string, account: SalesforceAccount) {
		const clientPayload = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client', account);
		const clientEntityPayload = this.normalizeClientEntityPayload(
			await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', account)
		);
		const existingClientId =
			(await this.typeormService.getObjectMapping(holdingId, 'Account', account.Id)) ||
			(clientPayload.client_number ? await this.typeormService.getClientByNumber(holdingId, clientPayload.client_number) : null);

		if (!existingClientId) {
			return {
				existingClientId: null,
				existingClient: null,
				existingEntity: null,
				clientPayload,
				comparableClientEntityPayload: null,
				changes: null,
			};
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

		return {
			existingClientId,
			existingClient,
			existingEntity,
			clientPayload,
			comparableClientEntityPayload,
			changes: this.accountFieldChanges(account, clientPayload, existingClient, comparableClientEntityPayload, existingEntity),
		};
	}

	/**
	 * Cambios de una cuenta frente a un cliente existente, con las reglas de la importación (Integraciones v2, OK de Domi 03-10):
	 * - comparación normalizada (mayúsculas, tildes y espacios; identificador tributario con `normalizeTaxId`);
	 * - razón social: `legal_name`, `legal_address` y `country` con valor en Sapira no se pisan → `applies: false` (no cuentan como cambio);
	 * - `client_number` igual al id de la cuenta (respaldo del mapeo) no reemplaza uno existente → no es cambio.
	 * Sin razón social existente, sus campos son cambios (importar la crea o vincula).
	 */
	private accountFieldChanges(
		account: SalesforceAccount,
		clientPayload: Record<string, any>,
		existingClient: Record<string, any> | null,
		entityPayload: Record<string, any>,
		existingEntity: Record<string, any> | null
	): SalesforceAccountFieldChange[] {
		const plain = (value: unknown) => (value instanceof Date ? value.toISOString() : (value ?? null));
		const list = (target: SalesforceAccountFieldChange['target'], payload: Record<string, any>, existing: Record<string, any> | null) =>
			Object.entries(payload).flatMap(([field, incoming]): SalesforceAccountFieldChange[] => {
				const current = existing ? existing[field] : null;

				if (existing && field === 'client_number' && this.isFallbackClientNumber(incoming, account) && !this.isBlankValue(current)) return [];
				if (existing && this.sameAccountValue(field, incoming, current)) return [];
				const applies = !(
					target === 'client_entity' &&
					existing &&
					CLIENT_ENTITY_PROTECTED_FIELDS.includes(field) &&
					!this.isBlankValue(current)
				);

				return [{ target, field, current: plain(current), incoming: plain(incoming), applies }];
			});

		return [...list('client', clientPayload, existingClient), ...list('client_entity', entityPayload, existingEntity)];
	}

	/** El `client_number` mapeado es el respaldo (id de la cuenta del CRM) y no un número real del CRM. */
	private isFallbackClientNumber(value: unknown, account: SalesforceAccount): boolean {
		return Boolean(account?.Id) && value === account.Id;
	}

	/** Igualdad normalizada: textos sin distinguir mayúsculas, tildes ni espacios; identificador tributario canónico. */
	private sameAccountValue(field: string, incoming: unknown, current: unknown): boolean {
		if (incoming instanceof Date && current instanceof Date) return incoming.getTime() === current.getTime();
		if (field === 'tax_id') {
			const key = (value: unknown) => (transformers.normalizeTaxId(value as string) ?? '').toUpperCase();

			return key(incoming) === key(current);
		}
		if (typeof incoming === 'string' && typeof current === 'string')
			return normalizeComparableText(incoming) === normalizeComparableText(current);

		return JSON.stringify(incoming ?? null) === JSON.stringify(current ?? null);
	}

	/**
	 * Diferencias campo a campo de una cuenta del staging (Integraciones v2: "cambios a existentes"). Solo lectura. `applies = false`
	 * cuando importar no pisa el valor actual (razón social: nombre legal, dirección y país se conservan si ya tienen valor).
	 * `null` si la cuenta no está en el staging del holding.
	 */
	async previewAccountChanges(holdingId: string, salesforceId: string): Promise<SalesforceAccountChangesPreview | null> {
		const record = await this.accountsStgRepository.findOne({ where: { holding_id: holdingId, salesforce_id: salesforceId } });

		if (!record) return null;
		const comparison = await this.compareAccount(holdingId, record.raw_data as SalesforceAccount);
		// Lo que importar no aplica solo se muestra junto a un cambio real; si no hay ninguno, la cuenta no tiene cambios.
		const changes = comparison.changes?.some((change) => change.applies) ? comparison.changes : [];

		return {
			salesforce_id: salesforceId,
			processing_status: record.processing_status ?? null,
			client_id: comparison.existingClientId,
			client_name: comparison.existingClient?.name_commercial ?? null,
			client_entity_id: comparison.existingEntity?.id ?? null,
			changes,
		};
	}

	private async classifyAccountStaging(holdingId: string, batchId?: string): Promise<void> {
		const records = await this.accountsStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			const account = record.raw_data as SalesforceAccount;
			const { existingClientId, changes } = await this.compareAccount(holdingId, account);

			if (!existingClientId) {
				await this.accountsStgRepository.update(record.id, {
					processing_status: 'create',
					integration_notes: 'No existe cliente Sapira asociado al Account',
				});
				continue;
			}

			// Solo cuenta lo que importar aplica (los campos protegidos de la razón social con valor no son cambio).
			const hasChanges = (changes ?? []).some((change) => change.applies);
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
					relatedOpportunities.map((opportunity) =>
						this.resolveOpportunityBlock(holdingId, opportunity.salesforce_id, 'account_final_processing')
					)
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
							'Revisa los datos de la cuenta, la razón social o el contacto en el CRM y reintenta la importación.',
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
			title: `Cotización del CRM detenida: ${record.salesforce_name || record.salesforce_id}`,
			// Mensaje de negocio; el detalle técnico queda en `metadata.error_message`.
			message: OPPORTUNITY_BLOCK_MESSAGES[reason],
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

	private async classifyOpportunityStaging(holdingId: string, batchId?: string, options: OpportunityClassificationOptions = {}): Promise<void> {
		const records = await this.opportunitiesStgRepository.find({
			where: batchId ? { holding_id: holdingId, batch_id: batchId } : { holding_id: holdingId },
			order: { updated_at: 'ASC' },
		});

		for (const record of records) {
			const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
			// Cotización ya existente (todas las rutas, también la diaria de solo inserción): se clasifica por la regla de cotizaciones
			// protegidas — protegida, sin cambios o "Por revisar" si el CRM cambió desde la última importación — antes que por los
			// bloqueos de cuenta o productos, que se revalidan al importar con confirmación.
			const integratedQuoteId = await this.findIntegratedQuoteId(holdingId, opportunity.Id);
			if (integratedQuoteId) {
				const classification = await this.classifyExistingQuote(holdingId, record, opportunity, integratedQuoteId);
				// La diaria (solo inserción) lo deja dicho: nunca aplica cambios a una cotización existente.
				if (options.insertOnly && classification.processing_status === 'update') {
					classification.integration_notes = `${classification.integration_notes} (la sincronización automática no actualiza cotizaciones)`;
				}
				await this.applyExistingQuoteClassification(record, batchId, classification);
				continue;
			}

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
					'Asocia una cuenta a la oportunidad en el CRM y reintenta la importación.'
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
					'Reintenta la importación para volver a traer la cuenta de la oportunidad.'
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
					'Corrige los datos de la cuenta en el CRM y reintenta la importación.',
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
					'Relaciona los productos indicados con productos de Sapira y reintenta la importación.',
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

			await this.opportunitiesStgRepository.update(record.id, {
				processing_status: 'create',
				integration_notes: 'No existe cotización Sapira para esta oportunidad',
			});
			await this.updateLineItemsStagingStatus(holdingId, batchId, opportunity.Id, 'create', 'Ítem listo para crear junto a la cotización');
		}
	}

	/**
	 * Cotizaciones protegidas (Domi 03-10): una cotización existente se clasifica por lo que cambió **en el CRM** desde la última
	 * importación (snapshot), no contra la cotización actual. Con contrato o en etapa `contract_created` queda protegida. Sin snapshot
	 * (cotización anterior a la regla) queda "Sin cambios" y lo que llegó ahora pasa a ser la base.
	 */
	private async classifyExistingQuote(
		holdingId: string,
		record: SalesforceOpportunitiesStg,
		opportunity: SalesforceOpportunityWithLineItems,
		quoteId: string
	): Promise<CrmQuoteClassification> {
		const [protection, incoming] = await Promise.all([
			this.getQuoteProtection(holdingId, quoteId),
			this.buildIncomingSnapshot(holdingId, opportunity),
		]);

		return classifyExistingCrmQuote({
			protection: protection.protection,
			stored: readCrmQuoteSnapshot(record.last_imported_snapshot),
			incoming,
		});
	}

	private async applyExistingQuoteClassification(
		record: SalesforceOpportunitiesStg,
		batchId: string | undefined,
		classification: CrmQuoteClassification
	): Promise<void> {
		await this.opportunitiesStgRepository.update(record.id, {
			processing_status: classification.processing_status,
			integration_notes: classification.integration_notes,
			error_message: null,
			// Base sin importación: `last_imported_at` queda NULL (no se importó nada).
			...(classification.baseline ? { last_imported_snapshot: storedCrmQuoteSnapshot(classification.baseline) } : {}),
		});
		await this.updateLineItemsStagingStatus(
			record.holding_id,
			batchId,
			record.salesforce_id,
			classification.processing_status,
			classification.processing_status === 'update' ? 'Ítem con cambios del CRM por revisar' : classification.integration_notes
		);
	}

	/** Protección de una cotización: con contrato vigente (directo o por sus ítems) o en etapa de tipo `contract_created`. */
	private async getQuoteProtection(
		holdingId: string,
		quoteId: string,
		manager?: EntityManager
	): Promise<{ protection: CrmQuoteProtection; stageId: string | null; stageKind: string | null }> {
		const rows = (await (manager ?? this.quoteRepository.manager).query(CRM_QUOTE_PROTECTION_SQL, [quoteId, holdingId])) as Array<
			Record<string, unknown>
		>;
		const row = rows[0] ?? null;

		return {
			protection: crmQuoteProtection(row),
			stageId: (row?.stage_id as string) ?? null,
			stageKind: (row?.stage_kind as string) ?? null,
		};
	}

	/** Lo que llega ahora del CRM, con los mismos mapeos y resolución de ítems que usa la importación. */
	private async buildIncomingSnapshot(holdingId: string, opportunity: SalesforceOpportunityWithLineItems): Promise<CrmQuoteSnapshot> {
		const mapped = await this.fieldMappingEngine.buildMappedRecord(holdingId, 'opportunity', opportunity, { opportunity });
		const currency = mapped.currency || opportunity.CurrencyIsoCode || 'USD';
		const items = await Promise.all(
			(opportunity.OpportunityLineItems?.records || []).map(async (lineItem) => {
				const { transformation, ...resolved } = await this.resolveLineItemPreview(holdingId, opportunity, lineItem, currency);
				void transformation;

				return resolved;
			})
		);

		return this.snapshotFrom(opportunity, mapped, items);
	}

	private snapshotFrom(
		opportunity: SalesforceOpportunityWithLineItems,
		mapped: Record<string, any>,
		items: Array<Record<string, any>>
	): CrmQuoteSnapshot {
		return buildCrmQuoteSnapshot({
			header: mapped,
			owner: opportunity.Owner?.Email || opportunity.Owner?.Name || opportunity.OwnerId || null,
			accountId: opportunity.AccountId || null,
			items,
		});
	}

	/** Cotización de Sapira de una oportunidad: por el vínculo del CRM o por `salesforce_opportunity_id`. */
	private async findIntegratedQuoteId(holdingId: string, opportunityId: string): Promise<string | null> {
		const [mappedQuoteId, quote] = await Promise.all([
			this.typeormService.getObjectMapping(holdingId, 'Opportunity', opportunityId),
			this.quoteRepository.findOne({
				where: { holding_id: holdingId, salesforce_opportunity_id: opportunityId },
				select: ['id'],
			}),
		]);

		return mappedQuoteId || quote?.id || null;
	}

	/**
	 * Diferencias de una oportunidad (`GET /integrations/crm/records/opportunity/:id/changes`): lo que llegó del CRM en la última
	 * importación (antes) frente a lo que llega ahora (después). Sin snapshot no hay diferencias que mostrar.
	 */
	async previewOpportunityChanges(holdingId: string, salesforceId: string): Promise<SalesforceOpportunityChangesPreview | null> {
		const record = await this.opportunitiesStgRepository.findOne({ where: { holding_id: holdingId, salesforce_id: salesforceId } });
		if (!record) {
			return null;
		}

		const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
		const quoteId = await this.findIntegratedQuoteId(holdingId, salesforceId);
		const [quoteRows, protection] = quoteId
			? await Promise.all([
					this.quoteRepository.manager.query(
						`SELECT NULLIF(concat_ws(' · ', q.quote_number, cl.name_commercial), '') AS label FROM quotes q
						LEFT JOIN clients cl ON cl.id = q.client_id WHERE q.id = $1 AND q.holding_id = $2`,
						[quoteId, holdingId]
					) as Promise<Array<Record<string, unknown>>>,
					this.getQuoteProtection(holdingId, quoteId),
				])
			: [[], null];
		const stored = readCrmQuoteSnapshot(record.last_imported_snapshot);
		const changes = stored && quoteId ? crmSnapshotChanges(stored, await this.buildIncomingSnapshot(holdingId, opportunity)) : [];

		return {
			salesforce_id: salesforceId,
			label: record.salesforce_name || opportunity?.Name || null,
			processing_status: record.processing_status ?? null,
			quote_id: quoteId,
			quote_label: (quoteRows[0]?.label as string) ?? null,
			protection: protection?.protection ?? null,
			has_snapshot: Boolean(stored),
			last_imported_at: record.last_imported_at ?? null,
			changes,
		};
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
				const result = await this.processOpportunity(record, holdingId, stats, options);
				await this.resolveOpportunityBlock(holdingId, record.salesforce_id, 'opportunity_final_processing');

				// Cotización existente con cambios del CRM sin confirmar: sigue "Por revisar" y no se marca integrada.
				if (result.outcome === 'needs_confirmation') {
					stats.quotesPendingConfirmation = (stats.quotesPendingConfirmation ?? 0) + 1;
					stats.notices = [...(stats.notices ?? []), `Oportunidad ${record.salesforce_id}: ${CRM_QUOTE_NOTES.needsConfirmation}`];
					await this.opportunitiesStgRepository.update(record.id, {
						processing_status: 'update',
						integration_notes: CRM_QUOTE_NOTES.needsConfirmation,
						error_message: null,
					});
					await this.updateLineItemsStagingStatus(
						holdingId,
						batchId,
						record.salesforce_id,
						'update',
						'Ítem con cambios del CRM por revisar'
					);
					continue;
				}
				if (result.outcome === 'protected') {
					stats.quotesProtected = (stats.quotesProtected ?? 0) + 1;
					stats.notices = [...(stats.notices ?? []), `Oportunidad ${record.salesforce_id}: ${result.message}`];
				}

				// Protegida o sin cambios: queda importada sin tocar la cotización ni su fecha de integración.
				const untouched = result.outcome === 'protected' || result.outcome === 'unchanged';
				await this.opportunitiesStgRepository.update(record.id, {
					processing_status: 'processed',
					error_message: null,
					...(untouched ? { integration_notes: result.message } : { last_integrated_at: new Date() }),
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
				await this.notifyOpportunityBlocked(
					holdingId,
					record,
					'opportunity_final_processing',
					error.message,
					'Revisa los datos que indica el detalle y reintenta la importación.'
				);
			}
		}
	}

	private async processOpportunity(
		record: SalesforceOpportunitiesStg,
		holdingId: string,
		stats: SyncCompleteStats,
		options: OpportunityProcessingOptions = {}
	): Promise<CrmQuoteSyncResult> {
		const opportunity = record.raw_data as SalesforceOpportunityWithLineItems;
		if (options.insertOnly && (await this.isOpportunityAlreadyIntegrated(holdingId, opportunity.Id))) {
			return { outcome: 'skipped', message: null };
		}

		// Cotización existente protegida o sin confirmación: no se toca nada (tampoco el cliente de la oportunidad).
		const confirmedBy = options.salesforceIds?.length && !options.insertOnly ? (options.confirmedBy ?? null) : null;
		const existingQuoteId = await this.findIntegratedQuoteId(holdingId, opportunity.Id);
		if (existingQuoteId) {
			const guard = await this.guardExistingQuote(holdingId, existingQuoteId, confirmedBy);
			if (guard) {
				return guard;
			}
		}

		const clientId = await this.ensureOpportunityClientReady(record, opportunity, holdingId, stats);
		const unmappedProducts = await this.getUnmappedSalesforceProducts(holdingId, opportunity);
		if (unmappedProducts.length > 0) {
			await this.markUnmappedLineItemsAsError(holdingId, undefined, opportunity.Id, unmappedProducts);
			throw new Error(this.getUnmappedProductsMessage(unmappedProducts));
		}

		// La confirmación solo vale para las oportunidades elegidas por id (nunca con `all` ni en la sincronización diaria).
		return this.syncQuote(record, opportunity, clientId, holdingId, stats, { insertOnly: options.insertOnly, confirmedBy });
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
				: { ...clientPayload };

			// El id de la cuenta como número de cliente es solo un respaldo: no reemplaza el número que ya tiene el cliente.
			if (this.isFallbackClientNumber(clientUpdatePayload.client_number, accountData)) {
				const existingClient = await this.clientRepository.findOne({ where: { id: existingClientId, holding_id: holdingId } });

				if (!this.isBlankValue(existingClient?.client_number)) delete clientUpdatePayload.client_number;
			}

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
		// Respaldo (id de la cuenta del CRM) como número de cliente: solo completa una razón social sin número, no reemplaza el existente.
		const keepClientNumber = this.isFallbackClientNumber(normalizedEntityPayload.client_number, accountData) ? ['client_number'] : [];
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
					await this.clientEntityRepository.update(
						entity.id,
						this.fillClientEntityFieldsWhenEmpty(entity, entityUpdatePayload, keepClientNumber)
					);
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
				...this.fillClientEntityFieldsWhenEmpty(existingByClient, basePayload, keepClientNumber),
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

	private fillClientEntityFieldsWhenEmpty(
		existing: Record<string, any>,
		candidate: Record<string, any>,
		extraProtected: string[] = []
	): Record<string, any> {
		return {
			...candidate,
			...Object.fromEntries(
				[...CLIENT_ENTITY_PROTECTED_FIELDS, ...extraProtected]
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

	/**
	 * Lleva una oportunidad a su cotización (único punto que crea o actualiza cotizaciones desde el CRM; lo usan la sincronización diaria,
	 * `process_final`, `retry_full`, `/salesforce/staging/*` y `/salesforce/sync-complete`). Cotizaciones protegidas (Domi 03-10):
	 * - con contrato o en etapa `contract_created` → nunca se actualiza (`protected`);
	 * - sin confirmación (`confirmedBy`) → no se toca (`needs_confirmation`);
	 * - sin cambios en el CRM desde la última importación (o sin snapshot) → no se toca (`unchanged`);
	 * - al actualizar no cambia la etapa ni las notas; encabezado, ítems, evento `UPDATED` (`metadata.source = 'crm_sync'`) y snapshot van
	 *   en una sola transacción. Al crear, la cotización, su vínculo, sus ítems y el snapshot también.
	 */
	private async syncQuote(
		record: SalesforceOpportunitiesStg,
		opportunity: SalesforceOpportunityWithLineItems,
		clientId: string,
		holdingId: string,
		stats: SyncCompleteStats,
		options: { insertOnly?: boolean; confirmedBy?: string | null } = {}
	): Promise<CrmQuoteSyncResult> {
		const insertOnly = options.insertOnly === true;
		if (insertOnly && (await this.isOpportunityAlreadyIntegrated(holdingId, opportunity.Id))) {
			return { outcome: 'skipped', message: null };
		}

		const existingQuoteId = await this.findIntegratedQuoteId(holdingId, opportunity.Id);
		if (existingQuoteId) {
			if (insertOnly) {
				return { outcome: 'skipped', message: null };
			}
			const guard = await this.guardExistingQuote(holdingId, existingQuoteId, options.confirmedBy ?? null);
			if (guard) {
				return guard;
			}
		}

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

		const resolvedItems: Array<Record<string, any>> = [];
		for (const lineItem of opportunity.OpportunityLineItems?.records || []) {
			const { transformation, ...resolvedLineItem } = await this.resolveLineItemPreview(
				holdingId,
				opportunity,
				lineItem,
				mappedQuoteData.currency || opportunity.CurrencyIsoCode || 'USD'
			);
			void transformation;
			resolvedItems.push({ holding_id: holdingId, ...resolvedLineItem });
		}
		const snapshot = this.snapshotFrom(opportunity, mappedQuoteData, resolvedItems);

		if (existingQuoteId) {
			const stored = readCrmQuoteSnapshot(record.last_imported_snapshot);
			// Sin base (cotización anterior a la regla) o sin cambios del CRM: no hay nada que aplicar. La base queda guardada.
			if (!stored || !crmSnapshotChanged(stored, snapshot)) {
				if (!stored) {
					await this.opportunitiesStgRepository.update(record.id, {
						last_imported_snapshot: storedCrmQuoteSnapshot({ ...snapshot, baseline: true }),
					});
				}
				return { outcome: 'unchanged', message: stored ? CRM_QUOTE_NOTES.unchanged : CRM_QUOTE_NOTES.baseline };
			}

			// Al actualizar no cambia la etapa ni las notas (ni el holding).
			const headerUpdate = Object.fromEntries(
				Object.entries(quoteData).filter(([field]) => !['quote_stage_id', 'notes', 'holding_id'].includes(field))
			);
			const outcome = await this.quoteRepository.manager.transaction(async (manager) => {
				// Revalida dentro de la transacción: un contrato creado entre la clasificación y la importación también protege.
				const protection = await this.getQuoteProtection(holdingId, existingQuoteId, manager);
				if (protection.protection) {
					return { outcome: 'protected', message: CRM_QUOTE_PROTECTION_MESSAGES[protection.protection] } as CrmQuoteSyncResult;
				}

				const before = await manager.getRepository(Quote).findOne({ where: { id: existingQuoteId, holding_id: holdingId } });
				const beforeItems = await manager.getRepository(QuoteItem).find({ where: { quote_id: existingQuoteId, holding_id: holdingId } });
				await manager.getRepository(Quote).update({ id: existingQuoteId, holding_id: holdingId }, headerUpdate);
				const quoteItems = resolvedItems.map((item) => ({ quote_id: existingQuoteId, ...item }));
				await this.typeormService.createQuoteItems(quoteItems, manager);
				const afterItems = await manager.getRepository(QuoteItem).find({ where: { quote_id: existingQuoteId, holding_id: holdingId } });

				await this.insertCrmSyncEvent(manager, {
					holdingId,
					quoteId: existingQuoteId,
					stageId: protection.stageId,
					stageKind: protection.stageKind,
					confirmedBy: options.confirmedBy ?? null,
					opportunityId: opportunity.Id,
					before: (before ?? {}) as Record<string, unknown>,
					after: headerUpdate,
					beforeItems,
					afterItems,
					crmChanges: crmSnapshotChanges(stored, snapshot),
				});
				await manager
					.getRepository(SalesforceOpportunitiesStg)
					.update(record.id, { last_imported_snapshot: storedCrmQuoteSnapshot(snapshot), last_imported_at: new Date() });
				stats.quoteItemsCreated += quoteItems.length;

				return { outcome: 'updated', message: CRM_QUOTE_NOTES.applied } as CrmQuoteSyncResult;
			});
			if (outcome.outcome === 'updated') {
				stats.quotesUpdated++;
			}

			return outcome;
		}

		try {
			await this.quoteRepository.manager.transaction(async (manager) => {
				const createdQuoteId = insertOnly
					? await this.typeormService.createQuoteIfAbsent(quoteData, manager)
					: await this.typeormService.upsertQuote(quoteData, manager);
				if (!createdQuoteId) {
					// Otro proceso ya la integró: el conflicto dejó la transacción abortada.
					throw new QuoteAlreadyIntegratedError();
				}
				await this.typeormService.createObjectMapping(holdingId, 'Opportunity', opportunity.Id, 'quotes', createdQuoteId, manager);
				const quoteItems = resolvedItems.map((item) => ({ quote_id: createdQuoteId, ...item }));
				if (quoteItems.length) {
					await this.typeormService.createQuoteItems(quoteItems, manager);
				}
				await manager
					.getRepository(SalesforceOpportunitiesStg)
					.update(record.id, { last_imported_snapshot: storedCrmQuoteSnapshot(snapshot), last_imported_at: new Date() });
				stats.quoteItemsCreated += quoteItems.length;
			});
		} catch (error) {
			if (error instanceof QuoteAlreadyIntegratedError) {
				return { outcome: 'skipped', message: null };
			}
			throw error;
		}
		stats.quotesCreated++;

		return { outcome: 'created', message: null };
	}

	/** Cotización existente que la importación no puede tocar: protegida o sin confirmación. `null` = se puede evaluar para aplicar. */
	private async guardExistingQuote(holdingId: string, quoteId: string, confirmedBy: string | null): Promise<CrmQuoteSyncResult | null> {
		const { protection } = await this.getQuoteProtection(holdingId, quoteId);
		if (protection) {
			return { outcome: 'protected', message: CRM_QUOTE_PROTECTION_MESSAGES[protection] };
		}
		if (!confirmedBy) {
			return { outcome: 'needs_confirmation', message: CRM_QUOTE_NOTES.needsConfirmation };
		}

		return null;
	}

	/**
	 * Evento `UPDATED` en el historial de la cotización (mismo mecanismo que la edición manual, `quote-edit-diff`): antes/después del
	 * encabezado y por ítem, más lo que cambió en el CRM. Autor "Sincronización del CRM"; `actor_id` = quien confirmó.
	 */
	private async insertCrmSyncEvent(
		manager: EntityManager,
		input: {
			holdingId: string;
			quoteId: string;
			stageId: string | null;
			stageKind: string | null;
			confirmedBy: string | null;
			opportunityId: string;
			before: Record<string, unknown>;
			after: Record<string, unknown>;
			beforeItems: QuoteItem[];
			afterItems: QuoteItem[];
			crmChanges: CrmSnapshotFieldChange[];
		}
	): Promise<void> {
		const header = (source: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(source).map(([key, value]) => [key, snapshotValue(value)]));
		const itemSnapshot = (item: Record<string, any>): QuoteItemSnapshot => ({
			product_id: (snapshotValue(item.product_id) as string) ?? null,
			product_name: (snapshotValue(item.product_name) as string) ?? null,
			quantity: item.quantity == null ? null : Number(item.quantity),
			unit_price: item.unit_price == null ? null : Number(item.unit_price),
			annual_unit_price: item.annual_unit_price == null ? null : Number(item.annual_unit_price),
			price_entry_mode: (snapshotValue(item.price_entry_mode) as string) ?? null,
			discount_value: item.discount_value == null ? null : Number(item.discount_value),
			final_price: item.final_price == null ? null : Number(item.final_price),
			start_date: (snapshotValue(item.start_date) as string) ?? null,
			end_date: (snapshotValue(item.end_date) as string) ?? null,
			term_months: item.term_months == null ? null : Number(item.term_months),
			billing_frequency: (snapshotValue(item.billing_frequency) as string) ?? null,
			billing_method: (snapshotValue(item.billing_method) as string) ?? null,
			is_recurring: item.is_recurring == null ? null : Boolean(item.is_recurring),
		});
		const amount = (value: unknown) => (value === null || value === undefined || value === '' ? null : Number(value));
		const beforeHeader = header(input.before);
		const afterHeader = { ...beforeHeader, ...header(input.after) };
		const metadata = {
			source: 'crm_sync',
			author_label: CRM_SYNC_EVENT_AUTHOR,
			confirmed_by: input.confirmedBy,
			salesforce_opportunity_id: input.opportunityId,
			total_amount: { from: amount(input.before.total_amount), to: amount(afterHeader.total_amount) },
			changes: headerChanges(beforeHeader, afterHeader),
			item_changes: itemChanges(
				new Map(input.beforeItems.map((item) => [item.id, itemSnapshot(item)])),
				// Un ítem que no estaba antes queda como agregado; uno que ya no está, como quitado.
				input.afterItems.map((item) => ({ id: item.id, snapshot: itemSnapshot(item) }))
			),
			crm_changes: input.crmChanges,
		};

		await manager.query(
			`INSERT INTO quote_events (holding_id, quote_id, type, from_stage_id, to_stage_id, from_kind, to_kind, actor_id, reason, metadata)
			VALUES ($1, $2, 'UPDATED', $3, $3, $4, $4, $5, $6, $7::jsonb)`,
			[input.holdingId, input.quoteId, input.stageId, input.stageKind, input.confirmedBy, CRM_SYNC_EVENT_AUTHOR, JSON.stringify(metadata)]
		);
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
		const payload = this.normalizeClientEntityPayload(await this.fieldMappingEngine.buildMappedRecord(holdingId, 'client_entity', account));
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

	private async isOpportunityAlreadyIntegrated(holdingId: string, opportunityId: string): Promise<boolean> {
		const [mappedQuoteId, quote] = await Promise.all([
			this.typeormService.getObjectMapping(holdingId, 'Opportunity', opportunityId),
			this.quoteRepository.findOne({
				where: { holding_id: holdingId, salesforce_opportunity_id: opportunityId },
				select: ['id'],
			}),
		]);

		return Boolean(mappedQuoteId || quote);
	}

	/**
	 * Fecha de "ayer" en el calendario de `America/Santiago`.
	 * Se usa como valor por defecto de los flujos manuales que no reciben rango.
	 */
	private getYesterdayDate(): string {
		const { start } = this.getSantiagoCloseDateRange(2);
		return start;
	}

	/**
	 * Ventana de `CloseDate` expresada como fechas calendario de `America/Santiago`.
	 *
	 * `CloseDate` es un campo `Date` en Salesforce, por lo que el literal SOQL
	 * debe ser `YYYY-MM-DD` sin hora ni zona. Ambos extremos son inclusivos.
	 */
	private getSantiagoCloseDateRange(days: number, reference = new Date()): { start: string; end: string } {
		if (!Number.isInteger(days) || days < 1) {
			throw new Error('El rango de sincronización debe contener al menos un día calendario.');
		}

		const formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'America/Santiago',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		});
		const parts = Object.fromEntries(formatter.formatToParts(reference).map((part) => [part.type, part.value]));
		const endDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
		const startDate = new Date(endDate);
		startDate.setUTCDate(startDate.getUTCDate() - (days - 1));

		const toCalendarDate = (date: Date) => date.toISOString().split('T')[0];

		return {
			start: toCalendarDate(startDate),
			end: toCalendarDate(endDate),
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
