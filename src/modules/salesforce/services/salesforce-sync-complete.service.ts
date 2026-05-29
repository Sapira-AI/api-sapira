import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';

import { SyncCompleteResponseDto, SyncCompleteStats } from '../dtos/salesforce-sync-complete.dto';
import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceAccount, SalesforceOpportunityWithLineItems, SalesforceQuote, SalesforceQuoteLineItem } from '../interfaces/salesforce.interface';
import * as transformers from '../utils/salesforce-transformers';

import { SalesforceQueryService } from './salesforce-query.service';
import { SalesforceTypeOrmService } from './salesforce-typeorm.service';

/**
 * Servicio de sincronización completa de Salesforce
 * Sincroniza oportunidades, clientes, cotizaciones y productos
 */
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
		private readonly queryService: SalesforceQueryService,
		private readonly typeormService: SalesforceTypeOrmService
	) {}

	/**
	 * Sincronización completa de oportunidades para un holding
	 */
	async syncOpportunitiesComplete(holdingId: string, dateFrom?: string, dateTo?: string): Promise<SyncCompleteResponseDto> {
		const startTime = new Date();
		this.logger.log(`🔄 Starting complete sync for holding ${holdingId}`);

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
			// Verificar conexión activa
			const connection = await this.connectionRepository.findOne({
				where: { holding_id: holdingId, is_active: true },
			});

			if (!connection) {
				throw new Error('No active Salesforce connection found');
			}

			// Construir fechas
			const from = dateFrom || this.getYesterdayDate();
			const to = dateTo || from;

			this.logger.log(`📅 Sync date range: ${from} to ${to}`);

			// Consultar oportunidades con line items
			const opportunities = await this.fetchOpportunitiesWithLineItems(holdingId, from, to);
			stats.opportunities = opportunities.length;

			this.logger.log(`📦 Found ${opportunities.length} opportunities`);

			// Obtener QuoteLineItems para fusionar campos custom
			const opportunityIds = opportunities.map((opp) => opp.Id);
			const quoteLineItemsByOpp = await this.fetchQuoteLineItems(holdingId, opportunityIds);

			// Fusionar OpportunityLineItems con QuoteLineItems
			this.mergeLineItems(opportunities, quoteLineItemsByOpp);
			// Procesar cada oportunidad
			for (const opportunity of opportunities) {
				try {
					await this.processOpportunity(opportunity, holdingId, stats);
				} catch (error: any) {
					this.logger.error(`❌ Error processing opportunity ${opportunity.Id}:`, error.message);
					stats.errors.push(`Opportunity ${opportunity.Id}: ${error.message}`);
				}
			}

			// Actualizar last_sync_at
			await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });

			const endTime = new Date();
			const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

			this.logger.log(`✅ Complete sync finished for holding ${holdingId} in ${durationSeconds}s`);

			return {
				holding_id: holdingId,
				success: true,
				stats,
				started_at: startTime,
				completed_at: endTime,
				duration_seconds: durationSeconds,
			};
		} catch (error: any) {
			const endTime = new Date();
			const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

			this.logger.error(`❌ Complete sync failed for holding ${holdingId}:`, error.message);

			return {
				holding_id: holdingId,
				success: false,
				stats,
				error: error.message,
				started_at: startTime,
				completed_at: endTime,
				duration_seconds: durationSeconds,
			};
		}
	}

	/**
	 * Sincronizar todos los holdings activos
	 */
	async syncAllActiveConnectionsComplete(): Promise<SyncCompleteResponseDto[]> {
		this.logger.log('🔄 Starting complete sync for all active connections');

		const connections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		this.logger.log(`📊 Found ${connections.length} active connections`);

		const results: SyncCompleteResponseDto[] = [];

		for (const connection of connections) {
			const result = await this.syncOpportunitiesComplete(connection.holding_id);
			results.push(result);
		}

		return results;
	}

	/**
	 * Consultar oportunidades con line items desde Salesforce
	 */
	private async fetchOpportunitiesWithLineItems(
		holdingId: string,
		dateFrom: string,
		dateTo: string
	): Promise<SalesforceOpportunityWithLineItems[]> {
		const soql = `
			SELECT 
				Id, Name, AccountId, Type, CloseDate, StageName, IsWon, IsClosed,
				Amount, CurrencyIsoCode, CreatedDate,
				Modalidad_de_pago__c, Forma_de_pago__c, Contrato__c, 
				Orden_de_compra__c, QuoteProjectManager__c, QuoteBillingEmail__c,
				id_largo_oportunidad__c,
				OwnerId, Owner.Id, Owner.Name, Owner.Email,
				Account.Id, Account.Name, Account.BillingCountry,
				Account.Plazos_de_pago__c, Account.Lista_de_Precio__r.Tipo__c,
				(SELECT Id, Product2Id, Product2.Id, Product2.Name, Product2.ProductCode,
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

	/**
	 * Obtener QuoteLineItems para fusionar campos custom
	 * Los campos custom están en QuoteLineItem, no en OpportunityLineItem
	 */
	private async fetchQuoteLineItems(holdingId: string, opportunityIds: string[]): Promise<Map<string, SalesforceQuoteLineItem[]>> {
		if (opportunityIds.length === 0) {
			return new Map();
		}

		// 1. Obtener Quotes asociadas a las oportunidades
		const quotesSOQL = `
			SELECT Id, OpportunityId, Name, QuoteNumber, Status
			FROM Quote
			WHERE OpportunityId IN ('${opportunityIds.join("','")}')
		`.trim();

		const { data: quotesData } = await this.queryService.executeQuery(quotesSOQL, holdingId);
		const quotes: SalesforceQuote[] = quotesData.records || [];

		if (quotes.length === 0) {
			this.logger.log('📋 No Quotes found for opportunities');
			return new Map();
		}

		this.logger.log(`📋 Found ${quotes.length} Quotes`);

		// 2. Obtener QuoteLineItems con campos custom
		const quoteIds = quotes.map((q) => q.Id);
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

		this.logger.log(`📋 Found ${quoteLineItems.length} QuoteLineItems with custom fields`);

		// 3. Crear mapa: OpportunityId -> QuoteLineItems
		const qliByOppId = new Map<string, SalesforceQuoteLineItem[]>();

		quoteLineItems.forEach((qli) => {
			const quote = quotes.find((q) => q.Id === qli.QuoteId);
			if (quote) {
				if (!qliByOppId.has(quote.OpportunityId)) {
					qliByOppId.set(quote.OpportunityId, []);
				}
				qliByOppId.get(quote.OpportunityId).push(qli);
			}
		});

		return qliByOppId;
	}

	/**
	 * Fusionar OpportunityLineItems con QuoteLineItems
	 * QuoteLineItems tienen los campos custom que OpportunityLineItems no tienen
	 */
	private mergeLineItems(opportunities: SalesforceOpportunityWithLineItems[], quoteLineItemsByOpp: Map<string, SalesforceQuoteLineItem[]>): void {
		opportunities.forEach((opp) => {
			const quoteLineItems = quoteLineItemsByOpp.get(opp.Id) || [];

			if (quoteLineItems.length > 0 && opp.OpportunityLineItems?.records) {
				// Crear índice de OLI por Id
				const oliById = new Map(opp.OpportunityLineItems.records.map((oli) => [oli.Id, oli]));

				// Fusionar: QLI sobrescribe campos custom sobre OLI
				quoteLineItems.forEach((qli) => {
					if (qli.OpportunityLineItemId) {
						const oli = oliById.get(qli.OpportunityLineItemId);
						if (oli) {
							// Fusionar campos custom de QLI sobre OLI
							Object.assign(oli, {
								Fecha_de_inicio__c: qli.Fecha_de_inicio__c,
								Fecha_de_Fin__c: qli.Fecha_de_Fin__c,
								Calculo_para_facturaci_n__c: qli.Calculo_para_facturaci_n__c,
								Unidad_facturada__c: qli.Unidad_facturada__c,
								Fuente_de_unidad__c: qli.Fuente_de_unidad__c,
								Tipo_de_agregaci_n__c: qli.Tipo_de_agregaci_n__c,
								Fuente_Optimizaciones__c: qli.Fuente_Optimizaciones__c,
								// Sobrescribir también campos estándar si vienen de QLI
								Discount: qli.Discount,
								ServiceDate: qli.ServiceDate,
								SortOrder: qli.SortOrder,
							});
							this.logger.debug(`✅ Merged OLI ${oli.Id} with QLI ${qli.Id}`);
						} else {
							this.logger.warn(`⚠️ QLI ${qli.Id} references OLI ${qli.OpportunityLineItemId} that doesn't exist`);
						}
					} else {
						this.logger.warn(`⚠️ QLI ${qli.Id} has no OpportunityLineItemId`);
					}
				});
			}
		});
	}

	/**
	 * Procesar una oportunidad completa
	 */
	private async processOpportunity(opportunity: SalesforceOpportunityWithLineItems, holdingId: string, stats: SyncCompleteStats): Promise<void> {
		this.logger.log(`📝 Processing opportunity ${opportunity.Name} (${opportunity.Id})`);

		// 1. Sincronizar Account (cliente)
		const clientId = await this.syncAccount(opportunity.AccountId, holdingId, stats);

		// 2. Sincronizar productos de los line items
		const lineItems = opportunity.OpportunityLineItems?.records || [];
		for (const lineItem of lineItems) {
			if (lineItem.Product2Id) {
				await this.syncProduct(lineItem.Product2Id, lineItem.Product2, holdingId, stats);
			}
		}

		// 3. Sincronizar cotización y sus items
		await this.syncQuote(opportunity, clientId, holdingId, stats);
	}

	/**
	 * Sincronizar Account de Salesforce a Client de Sapira
	 * Implementa lógica completa del frontend con todas las validaciones
	 */
	private async syncAccount(accountId: string, holdingId: string, stats: SyncCompleteStats): Promise<string> {
		// 1. Verificar si ya existe mapping
		const existingClientId = await this.typeormService.getObjectMapping(holdingId, 'Account', accountId);

		if (existingClientId) {
			this.logger.log(`✓ Client mapping exists for Account ${accountId} -> ${existingClientId}`);

			// Actualizar datos del cliente con información fresca de Salesforce
			const accountData = await this.fetchAccount(accountId, holdingId);
			if (accountData) {
				await this.updateClientFromAccount(existingClientId, accountData, holdingId);
				stats.clientsUpdated++;

				// NUEVO: Verificar y crear contacto principal si no existe
				if (accountData.Email_de_contacto_principal__c) {
					const hasContact = await this.typeormService.hasClientContact(existingClientId, 'Principal');
					if (!hasContact) {
						await this.typeormService.createClientContact({
							client_id: existingClientId,
							holding_id: holdingId,
							contact_type: 'Principal',
							email: accountData.Email_de_contacto_principal__c,
						});
						this.logger.log(`✅ Contacto principal creado para cliente existente ${existingClientId}`);
					}
				}
			}

			return existingClientId;
		}

		// 2. No existe mapping, buscar cliente por client_number
		const accountData = await this.fetchAccount(accountId, holdingId);
		if (!accountData) {
			throw new Error(`Could not fetch Account ${accountId} from Salesforce`);
		}

		const clientNumber = transformers.generateClientNumber(accountId, accountData.Salesforce_API_ID__c);
		const existingClientByNumber = await this.typeormService.getClientByNumber(holdingId, clientNumber);

		if (existingClientByNumber) {
			this.logger.log(`✓ Found existing client by client_number ${clientNumber}: ${existingClientByNumber}`);

			// Crear mapping faltante
			await this.typeormService.createObjectMapping(holdingId, 'Account', accountId, 'clients', existingClientByNumber);

			// Actualizar country si viene de Salesforce
			const country = transformers.isoToCountryName(accountData.DemoCountry__c);
			if (country) {
				await this.updateClientFromAccount(existingClientByNumber, accountData, holdingId);
			}

			// Verificar y crear contacto principal si no existe
			if (accountData.Email_de_contacto_principal__c) {
				const hasContact = await this.typeormService.hasClientContact(existingClientByNumber, 'Principal');
				if (!hasContact) {
					await this.typeormService.createClientContact({
						client_id: existingClientByNumber,
						holding_id: holdingId,
						contact_type: 'Principal',
						email: accountData.Email_de_contacto_principal__c,
					});
					this.logger.log(`✅ Contacto principal creado para cliente existente ${existingClientByNumber}`);
				}
			}

			return existingClientByNumber;
		}

		// 3. No existe cliente, crear nuevo
		this.logger.log(`➕ Creating new client for Account ${accountId}`);

		// Crear master data si es necesario
		if (accountData.Industry) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'industries', accountData.Industry);
		}
		if (accountData.Segmento__c) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'segments', accountData.Segmento__c);
		}

		// Crear cliente
		const country = transformers.isoToCountryName(accountData.DemoCountry__c);
		const client = this.clientRepository.create({
			holding_id: holdingId,
			client_number: clientNumber,
			name_commercial: accountData.Name,
			industry: accountData.Industry || null,
			segment: accountData.Segmento__c || null,
			country: country,
			salesforce_account_id: accountId,
		});

		const savedClient = await this.clientRepository.save(client);
		stats.clientsCreated++;

		// Crear mapping
		await this.typeormService.createObjectMapping(holdingId, 'Account', accountId, 'clients', savedClient.id);

		// Crear contacto principal si existe email
		if (accountData.Email_de_contacto_principal__c) {
			await this.typeormService.createClientContact({
				client_id: savedClient.id,
				holding_id: holdingId,
				contact_type: 'Principal',
				email: accountData.Email_de_contacto_principal__c,
			});
		}

		// 4. Crear o vincular client_entity con lógica completa
		await this.createOrLinkClientEntity(savedClient.id, accountData, holdingId, clientNumber);

		return savedClient.id;
	}

	/**
	 * Consultar Account desde Salesforce
	 */
	private async fetchAccount(accountId: string, holdingId: string): Promise<SalesforceAccount | null> {
		const soql = `
			SELECT
				Id, Name, Salesforce_API_ID__c, Industry, Segmento__c,
				BillingCountry, BillingStreet, BillingCity, BillingState, BillingPostalCode,
				DemoCountry__c, BusinessName__c, RUT__c,
				Email_de_contacto_principal__c, Industria_sector__c,
				Plazos_de_pago__c, Lista_de_Precio__r.Tipo__c,
				M_nimo_facturable_licencias__c, Per_odo_de_facturaci_n__c
			FROM Account
			WHERE Id = '${accountId}'
			LIMIT 1
		`.trim();

		try {
			const { data } = await this.queryService.executeQuery(soql, holdingId);
			const accounts = data.records || [];
			return accounts.length > 0 ? accounts[0] : null;
		} catch (error: any) {
			this.logger.error(`Error fetching account ${accountId}:`, error.message);
			return null;
		}
	}

	/**
	 * Actualizar cliente existente con datos de Account
	 */
	private async updateClientFromAccount(clientId: string, accountData: SalesforceAccount, holdingId: string): Promise<void> {
		const country = transformers.isoToCountryName(accountData.DemoCountry__c);

		const updateData: Partial<Client> = {
			name_commercial: accountData.Name,
			industry: accountData.Industry || null,
			segment: accountData.Segmento__c || null,
			country: country,
		};

		// Usar holdingId en el filtro para seguridad multi-tenant
		await this.clientRepository.update({ id: clientId, holding_id: holdingId }, updateData);
	}

	/**
	 * Crear o vincular client_entity con lógica completa del frontend
	 * Maneja: RUT duplicado, junction table, casos sin RUT
	 */
	private async createOrLinkClientEntity(clientId: string, accountData: SalesforceAccount, holdingId: string, clientNumber: string): Promise<void> {
		const hasLegalInfo = accountData.BusinessName__c || accountData.RUT__c;

		if (!hasLegalInfo) {
			this.logger.log(`ℹ️ No se creó client_entity para ${accountData.Name} (sin datos legales)`);
			return;
		}

		const country = transformers.isoToCountryName(accountData.DemoCountry__c);
		const legalAddress = transformers.formatAddress(
			accountData.BillingStreet,
			accountData.BillingCity,
			accountData.BillingState,
			accountData.BillingPostalCode,
			accountData.BillingCountry
		);

		// Caso 1: Tiene RUT - verificar si ya existe entity con ese RUT
		if (accountData.RUT__c) {
			const existingEntity = await this.typeormService.getClientEntityByTaxId(holdingId, accountData.RUT__c);

			if (existingEntity) {
				// Ya existe entity con este RUT
				this.logger.log(`✓ Client entity con RUT ${accountData.RUT__c} ya existe: ${existingEntity.legal_name}`);

				// Solo asignar si no tiene client_id o es diferente
				if (!existingEntity.client_id || existingEntity.client_id !== clientId) {
					await this.typeormService.updateClientEntityClient(existingEntity.id, clientId);
					this.logger.log(`✅ Client entity asignado a cliente ${accountData.Name}`);
				}

				// Asegurar registro en junction table
				await this.typeormService.createClientEntityClient(existingEntity.id, clientId, holdingId);
				return;
			}

			// No existe, crear nuevo con RUT
			const clientEntity = this.clientEntityRepository.create({
				client_id: clientId,
				holding_id: holdingId,
				legal_name: accountData.BusinessName__c || accountData.Name,
				tax_id: accountData.RUT__c,
				country: country,
				legal_address: legalAddress,
				economic_activity: accountData.Industria_sector__c || accountData.Industry || null,
				client_number: clientNumber,
			});

			const savedEntity = await this.clientEntityRepository.save(clientEntity);
			this.logger.log(`✅ Client entity creada para ${accountData.BusinessName__c || accountData.Name}`);

			// Crear registro en junction table
			await this.typeormService.createClientEntityClient(savedEntity.id, clientId, holdingId);
			return;
		}

		// Caso 2: Tiene datos legales pero NO tiene RUT
		this.logger.log(`⚠️ Creando client_entity sin RUT para ${accountData.Name}`);
		const clientEntityNoRut = this.clientEntityRepository.create({
			client_id: clientId,
			holding_id: holdingId,
			legal_name: accountData.BusinessName__c || accountData.Name,
			tax_id: null,
			country: country,
			legal_address: legalAddress,
			economic_activity: accountData.Industria_sector__c || accountData.Industry || null,
			client_number: clientNumber,
		});

		const savedEntityNoRut = await this.clientEntityRepository.save(clientEntityNoRut);

		// Crear registro en junction table
		await this.typeormService.createClientEntityClient(savedEntityNoRut.id, clientId, holdingId);
	}

	/**
	 * Sincronizar producto de Salesforce
	 */
	private async syncProduct(productId: string, productData: any, holdingId: string, stats: SyncCompleteStats): Promise<string> {
		// Verificar si ya existe mapping
		const existingProductId = await this.typeormService.getObjectMapping(holdingId, 'Product2', productId);

		if (existingProductId) {
			return existingProductId;
		}

		// Crear producto
		const product = {
			holding_id: holdingId,
			product_code: productData?.ProductCode || productId,
			name: productData?.Name || 'Producto sin nombre',
			description: productData?.Description || null,
			category: productData?.Family || null,
			is_active: true,
			salesforce_product_id: productId,
		};

		const sapiraProductId = await this.typeormService.upsertProduct(product);
		stats.productsSynced++;

		// Crear mapping
		await this.typeormService.createObjectMapping(holdingId, 'Product2', productId, 'products', sapiraProductId);

		return sapiraProductId;
	}

	/**
	 * Sincronizar cotización desde oportunidad
	 * Incluye lógica completa de vendedores y contactos del frontend
	 */
	private async syncQuote(
		opportunity: SalesforceOpportunityWithLineItems,
		clientId: string,
		holdingId: string,
		stats: SyncCompleteStats
	): Promise<void> {
		// Buscar etapa de cotización
		let stageId = await this.typeormService.getQuoteStageByName(holdingId, 'enviada');
		if (!stageId) {
			stageId = await this.typeormService.getFirstQuoteStage(holdingId);
		}

		if (!stageId) {
			throw new Error(`No se encontró una etapa de cotización. Crea al menos una etapa en Configuración → Etapas de Cotización.`);
		}

		// NUEVO: Buscar o crear vendedor desde Owner de Salesforce
		let sellerId = null;
		const ownerEmail = opportunity.Owner?.Email;
		const ownerName = opportunity.Owner?.Name;
		const ownerId = opportunity.OwnerId;

		if (ownerEmail || ownerName || ownerId) {
			// 1. Intentar match por email (más confiable)
			if (ownerEmail) {
				sellerId = await this.typeormService.getSellerByEmail(holdingId, ownerEmail);
			}

			// 2. Fallback: match por nombre si no hay email
			if (!sellerId && ownerName) {
				sellerId = await this.typeormService.getSellerByName(holdingId, ownerName);
			}

			// 3. Si no existe, crear vendedor automáticamente
			if (!sellerId) {
				const sellerName = ownerName || ownerEmail || `SF Owner ${ownerId}`;
				const sellerEmail = ownerEmail || `sf_${(ownerId || 'unknown').toLowerCase()}@salesforce.local`;

				this.logger.log(`🆕 Creando vendedor automáticamente: ${sellerName}`);

				sellerId = await this.typeormService.createSeller({
					name: sellerName,
					email: sellerEmail,
					holding_id: holdingId,
					is_active: true,
				});

				if (sellerId) {
					stats.sellersCreated++;
					this.logger.log(`✅ Vendedor creado: ${sellerName}`);
				}
			}
		}

		// NUEVO: Auto-crear payment_terms en master_data si viene de SF
		const paymentTermsValue = (opportunity as any).Account?.Plazos_de_pago__c || opportunity.Modalidad_de_pago__c;
		if (paymentTermsValue) {
			await this.typeormService.ensureMasterDataValue(holdingId, 'payment_terms', paymentTermsValue);
		}

		// NUEVO: Buscar contacto principal del cliente
		const clientContactId = await this.typeormService.getPrincipalContact(clientId);

		// Preparar datos de cotización
		const quoteDate = transformers.formatDateToDDMMYYYY(opportunity.CloseDate);
		const billingMethod = transformers.transformBillingMethod(opportunity.Forma_de_pago__c);

		const quoteData = {
			holding_id: holdingId,
			client_id: clientId,
			client_contact_id: clientContactId,
			seller_id: sellerId,
			quote_date: quoteDate,
			quote_stage_id: stageId,
			billing_method: billingMethod,
			payment_terms: paymentTermsValue || opportunity.Modalidad_de_pago__c || null,
			contract_number: opportunity.Contrato__c || null,
			purchase_order: opportunity.Orden_de_compra__c || null,
			billing_email: opportunity.QuoteBillingEmail__c || null,
			salesforce_opportunity_id: opportunity.Id,
			salesforce_opportunity_name: opportunity.Name,
			total_amount: opportunity.Amount || 0,
			currency: opportunity.CurrencyIsoCode || 'USD',
		};

		// Verificar si ya existe cotización
		const existingQuoteId = await this.typeormService.getObjectMapping(holdingId, 'Opportunity', opportunity.Id);

		let quoteId: string;
		if (existingQuoteId) {
			// Actualizar cotización existente
			quoteId = await this.typeormService.upsertQuote({ ...quoteData, id: existingQuoteId });
			stats.quotesUpdated++;

			// Eliminar items existentes
			await this.typeormService.deleteQuoteItems(quoteId);
		} else {
			// Crear nueva cotización
			quoteId = await this.typeormService.upsertQuote(quoteData);
			stats.quotesCreated++;

			// Crear mapping
			await this.typeormService.createObjectMapping(holdingId, 'Opportunity', opportunity.Id, 'quotes', quoteId);
		}

		// Crear quote items
		const lineItems = opportunity.OpportunityLineItems?.records || [];
		const quoteItems = [];

		for (const lineItem of lineItems) {
			const productId = await this.typeormService.getObjectMapping(holdingId, 'Product2', lineItem.Product2Id);

			if (!productId) {
				this.logger.warn(`Product mapping not found for ${lineItem.Product2Id}, skipping line item`);
				continue;
			}

			const customFields = transformers.buildCustomFields(lineItem, (opportunity as any).Account?.Lista_de_Precio__r?.Tipo__c);
			const discountPercentage = transformers.calculateDiscountPercentage(lineItem.ListPrice, lineItem.UnitPrice);
			const discountType = transformers.getDiscountType(lineItem.ListPrice, lineItem.UnitPrice);

			quoteItems.push({
				quote_id: quoteId,
				product_id: productId,
				product_name: lineItem.Product2?.Name || 'Producto sin nombre',
				holding_id: holdingId,
				quantity: lineItem.Quantity || 1,
				unit_price: lineItem.UnitPrice || 0,
				price: lineItem.TotalPrice || lineItem.UnitPrice || 0,
				discount_value: discountPercentage,
				discount_type: discountType,
				is_recurring: transformers.isRecurring(lineItem.Recurrencia__c),
				description: lineItem.Description || null,
				custom_fields: customFields,
				salesforce_product_id: lineItem.Product2Id,
				salesforce_line_item_id: lineItem.Id,
			});
		}

		if (quoteItems.length > 0) {
			await this.typeormService.createQuoteItems(quoteItems);
			stats.quoteItemsCreated += quoteItems.length;
		}
	}

	/**
	 * Obtener fecha de ayer en formato YYYY-MM-DD
	 */
	private getYesterdayDate(): string {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		return yesterday.toISOString().split('T')[0];
	}
}
