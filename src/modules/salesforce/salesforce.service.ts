import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EncryptionService } from '@/common/services/encryption.service';

import {
	SalesforceDuplicateClientEntitiesQueryDto,
	SalesforceDuplicateClientEntitiesResponseDto,
} from './dtos/salesforce-duplicate-client-entities.dto';
import { SalesforceTaxIdNormalizationResponseDto } from './dtos/salesforce-tax-id-normalization.dto';
import { IntegrationSalesforceConnection } from './entities/integration-salesforce-connection.entity';
import { IntegrationSalesforceFieldMapping } from './entities/integration-salesforce-field-mapping.entity';
import { IntegrationSalesforceMappingDetail } from './entities/integration-salesforce-mapping-detail.entity';
import { IntegrationSalesforceSyncRun } from './entities/integration-salesforce-sync-run.entity';
import { SalesforceAuthType, SalesforceConnection } from './entities/salesforce-connection.entity';
import { SalesforceAccount, SalesforceCredentials, SalesforceOpportunityLineItem, SalesforceOpportunityWithLineItems } from './interfaces/salesforce.interface';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';
import { SalesforceTypeOrmService } from './services/salesforce-typeorm.service';

@Injectable()
export class SalesforceService {
	private readonly logger = new Logger(SalesforceService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		@InjectRepository(IntegrationSalesforceConnection)
		private readonly integrationConnectionRepository: Repository<IntegrationSalesforceConnection>,
		@InjectRepository(IntegrationSalesforceFieldMapping)
		private readonly fieldMappingRepository: Repository<IntegrationSalesforceFieldMapping>,
		@InjectRepository(IntegrationSalesforceMappingDetail)
		private readonly mappingDetailRepository: Repository<IntegrationSalesforceMappingDetail>,
		@InjectRepository(IntegrationSalesforceSyncRun)
		private readonly syncRunRepository: Repository<IntegrationSalesforceSyncRun>,
		private readonly authService: SalesforceAuthService,
		private readonly queryService: SalesforceQueryService,
		private readonly syncService: SalesforceSyncService,
		private readonly syncCompleteService: SalesforceSyncCompleteService,
		private readonly tokenService: SalesforceTokenService,
		private readonly soapService: SalesforceSoapService,
		private readonly typeormService: SalesforceTypeOrmService,
		private readonly encryptionService: EncryptionService
	) {}

	async connect(credentials: SalesforceCredentials, userId: string, holdingId: string) {
		this.authService.validateCredentials(credentials);

		this.logger.log(`Connecting with Password Flow using SOAP for holding ${holdingId}`);

		// Para Password Flow, usar SOAP en lugar de OAuth
		const loginResult = await this.soapService.attemptLogin(
			credentials.loginUrl || 'https://login.salesforce.com',
			credentials.username,
			credentials.password,
			credentials.securityToken
		);

		// Guardar la conexión con los datos de SOAP
		await this.authService.storeConnectionFromSOAP(loginResult, credentials, userId, holdingId);

		return {
			success: true,
			message: 'Successfully connected to Salesforce using SOAP',
			instanceUrl: loginResult.serverUrl,
			authMethod: 'password_soap',
		};
	}

	async connectWithClientCredentials(clientId: string, clientSecret: string, userId: string, holdingId: string, loginUrl?: string) {
		const authData = await this.authService.authenticateWithClientCredentials(
			clientId,
			clientSecret,
			holdingId,
			loginUrl || 'https://login.salesforce.com'
		);

		await this.authService.storeClientCredentialsConnection(
			authData,
			clientId,
			clientSecret,
			userId,
			holdingId,
			loginUrl || 'https://login.salesforce.com'
		);

		return {
			success: true,
			message: 'Successfully connected to Salesforce using Client Credentials',
			instanceUrl: authData.instance_url,
			authMethod: 'client_credentials',
		};
	}

	async getConnection(holdingId: string) {
		this.logger.log(`Getting connection for holding: ${holdingId}`);

		if (!holdingId) {
			this.logger.warn('No holding ID provided to getConnection');
			return null;
		}

		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (!connection) {
			this.logger.warn(`No connection found for holding: ${holdingId}`);
			return null;
		}

		const hasValidToken = !!connection.access_token;

		this.logger.log(
			`Connection found for holding: ${holdingId}, username: ${connection.username || 'null'}, has_token: ${hasValidToken}, is_active: ${connection.is_active}`
		);

		return {
			id: connection.id,
			holding_id: connection.holding_id,
			username: connection.username,
			instance_url: connection.instance_url,
			auth_type: connection.auth_type,
			is_active: connection.is_active,
			has_valid_token: hasValidToken,
			client_id: connection.client_id,
			has_client_secret: !!connection.client_secret,
			login_url: connection.login_url,
			last_sync_at: connection.last_sync_at,
			created_at: connection.created_at,
		};
	}

	async validateStoredCredentials(holdingId: string) {
		this.logger.log(`Validating stored credentials for holding ${holdingId}`);

		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (!connection) {
			throw new NotFoundException('No credentials found. Please save credentials first.');
		}

		if (connection.auth_type === SalesforceAuthType.PASSWORD) {
			if (!connection.username || !connection.password || !connection.security_token) {
				throw new NotFoundException('Incomplete credentials. Please save complete credentials first.');
			}

			const decryptedPassword = this.encryptionService.decrypt(connection.password);
			const loginResult = await this.soapService.attemptLogin(
				connection.login_url,
				connection.username,
				decryptedPassword,
				connection.security_token
			);
			const instanceUrl = loginResult.serverUrl.split('/services/')[0];

			await this.connectionRepository.update(
				{ holding_id: holdingId },
				{
					access_token: loginResult.sessionId,
					instance_url: instanceUrl,
					salesforce_user_id: loginResult.userId,
					token_issued_at: new Date(),
					token_expires_at: null,
					is_active: true,
					last_sync_at: new Date(),
				}
			);

			this.logger.log(`✅ Password credentials validated successfully for holding ${holdingId}`);

			return {
				success: true,
				message: 'Password credentials validated successfully',
				instanceUrl: instanceUrl,
			};
		}

		if (connection.auth_type === SalesforceAuthType.CLIENT_CREDENTIALS) {
			if (!connection.client_id || !connection.client_secret) {
				throw new NotFoundException('Incomplete client credentials. Please save complete credentials first.');
			}

			const authData = await this.authService.authenticateWithClientCredentials(
				connection.client_id,
				connection.client_secret,
				holdingId,
				connection.login_url
			);

			await this.connectionRepository.update(
				{ holding_id: holdingId },
				{
					access_token: authData.access_token,
					instance_url: authData.instance_url,
					salesforce_user_id: authData.id || null,
					token_issued_at: new Date(parseInt(authData.issued_at)),
					token_expires_at: authData.expires_in ? new Date(Date.now() + authData.expires_in * 1000) : null,
					is_active: true,
					last_sync_at: new Date(),
				}
			);

			this.logger.log(`✅ Client credentials validated successfully for holding ${holdingId}`);

			return {
				success: true,
				message: 'Client credentials validated successfully',
				instanceUrl: authData.instance_url,
			};
		}

		throw new BadRequestException(`Unknown auth_type: ${connection.auth_type}`);
	}

	async disconnect(holdingId: string) {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId },
		});

		if (!connection) {
			throw new NotFoundException('No connection found for this holding');
		}

		await this.connectionRepository.update(
			{ holding_id: holdingId },
			{
				access_token: null,
				token_issued_at: null,
				token_expires_at: null,
				is_active: true,
			}
		);

		this.logger.log(`✅ Disconnected from Salesforce for holding ${holdingId} - credentials kept, token cleared`);

		return {
			success: true,
			message: 'Successfully disconnected from Salesforce',
		};
	}

	async savePasswordCredentials(credentials: SalesforceCredentials, userId: string, holdingId: string) {
		this.authService.validateCredentials(credentials);

		await this.authService.storeConnectionWithoutAuth(credentials, userId, holdingId, SalesforceAuthType.PASSWORD);

		return {
			success: true,
			message: 'Credenciales guardadas. Usa "Validar Credenciales" para activar la conexión.',
		};
	}

	async saveClientCredentials(clientId: string, clientSecret: string, userId: string, holdingId: string, loginUrl?: string) {
		await this.authService.storeConnectionWithoutAuth(
			{ clientId, clientSecret, loginUrl: loginUrl || 'https://login.salesforce.com' },
			userId,
			holdingId,
			SalesforceAuthType.CLIENT_CREDENTIALS
		);

		return {
			success: true,
			message: 'Credenciales guardadas. Usa "Validar Credenciales" para activar la conexión.',
		};
	}

	async refreshToken(holdingId: string) {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new NotFoundException('No active connection found');
		}

		const authData = await this.tokenService.refreshAccessToken(connection);
		await this.tokenService.updateTokens(holdingId, authData);

		return {
			success: true,
			message: 'Token refreshed successfully',
		};
	}

	async executeQuery(soql: string, holdingId: string) {
		const result = await this.queryService.executeQuery(soql, holdingId);

		return {
			success: true,
			data: result.data,
			tokenRefreshed: result.tokenRefreshed,
		};
	}

	async syncOpportunities(holdingId: string, dateFrom?: string, dateTo?: string) {
		return this.syncService.syncOpportunities(holdingId, dateFrom, dateTo);
	}

	async syncAllConnections() {
		const results = await this.syncService.syncAllActiveConnections();

		const successCount = results.filter((r) => r.success).length;
		const totalOpportunities = results.reduce((sum, r) => sum + (r.opportunities || 0), 0);

		return {
			success: true,
			message: 'Sync completed',
			holdings_synced: successCount,
			total_holdings: results.length,
			total_opportunities: totalOpportunities,
			results,
		};
	}

	async syncOpportunitiesComplete(holdingId: string, dateFrom?: string, dateTo?: string, opportunityIds?: string[]) {
		return this.syncCompleteService.syncOpportunitiesComplete(holdingId, dateFrom, dateTo, opportunityIds);
	}

	async normalizeTaxIds(holdingId: string): Promise<SalesforceTaxIdNormalizationResponseDto> {
		return this.syncCompleteService.normalizeTaxIdsForHolding(holdingId);
	}

	async getDuplicateClientEntitiesTaxIds(
		holdingId: string,
		query: SalesforceDuplicateClientEntitiesQueryDto
	): Promise<SalesforceDuplicateClientEntitiesResponseDto> {
		return this.typeormService.getDuplicateClientEntitiesTaxIds(holdingId, query);
	}

	async getPendingClientEntitiesSalesforceSource(holdingId: string) {
		const soql = `
			SELECT Id, BusinessName__c, RUT__c, LastModifiedDate
			FROM Account
			WHERE RUT__c = 'pendiente'
				OR BusinessName__c = 'pendiente'
		`;
		const { data } = await this.queryService.executeQuery(soql, holdingId);

		return (data.records as SalesforceAccount[]).map((account) => ({
			salesforceAccountId: account.Id,
			salesforceBusinessName: account.BusinessName__c || null,
			salesforceRut: account.RUT__c || null,
			salesforceLastModifiedDate: account.LastModifiedDate || null,
		}));
	}

	async previewLineItems(
		holdingId: string,
		previews: Array<{
			opportunity: SalesforceOpportunityWithLineItems;
			lineItems: SalesforceOpportunityLineItem[];
		}>
	) {
		const items = await Promise.all(
			previews.flatMap(({ opportunity, lineItems }) =>
				lineItems.map((lineItem) => this.syncCompleteService.resolveLineItemPreview(holdingId, opportunity, lineItem))
			)
		);

		return { items };
	}

	async previewClientEntities(holdingId: string, accounts: SalesforceAccount[]) {
		const items = await Promise.all(
			accounts.map((account) => this.syncCompleteService.resolveClientEntityPreview(holdingId, account))
		);

		return { items };
	}

	async syncOpportunitiesToStaging(holdingId: string, dateFrom?: string, dateTo?: string, opportunityIds?: string[]) {
		return this.syncCompleteService.syncOpportunitiesToStaging(holdingId, dateFrom, dateTo, opportunityIds);
	}

	async syncAccountsToStaging(holdingId: string, filters: { letter?: string; subRange?: string; dateFrom?: string; dateTo?: string }) {
		return this.syncCompleteService.syncAccountsToStaging(holdingId, filters);
	}

	async reclassifyAccountsStaging(holdingId: string) {
		return this.syncCompleteService.reclassifyAccountsStaging(holdingId);
	}

	async processAccountsStaging(holdingId: string, salesforceIds?: string[], clientFields?: string[]) {
		return this.syncCompleteService.processAccountsStaging(holdingId, salesforceIds, clientFields);
	}

	async processOpportunitiesStaging(holdingId: string, opportunityIds?: string[]) {
		return this.syncCompleteService.processOpportunitiesStaging(holdingId, opportunityIds);
	}

	async syncAllConnectionsComplete() {
		const results = await this.syncCompleteService.syncAllActiveConnectionsComplete();

		const successCount = results.filter((r) => r.success).length;
		const totalClients = results.reduce((sum, r) => sum + (r.stats?.clientsCreated || 0), 0);
		const totalQuotes = results.reduce((sum, r) => sum + (r.stats?.quotesCreated || 0), 0);
		const totalSellers = results.reduce((sum, r) => sum + (r.stats?.sellersCreated || 0), 0);

		return {
			success: true,
			message: 'Complete sync finished',
			holdings_synced: successCount,
			total_holdings: results.length,
			total_clients_created: totalClients,
			total_quotes_created: totalQuotes,
			total_sellers_created: totalSellers,
			results,
		};
	}

	async testConnection(holdingId: string) {
		this.logger.log(`Testing connection for holding: ${holdingId}`);

		if (!holdingId) {
			throw new NotFoundException('Holding ID not provided. Please select a holding.');
		}

		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			this.logger.warn(`No active connection found for holding: ${holdingId}`);
			throw new NotFoundException(`No active Salesforce connection found for holding ${holdingId}`);
		}

		const testedAt = new Date().toISOString();

		try {
			if (connection.auth_type === SalesforceAuthType.CLIENT_CREDENTIALS) {
				this.logger.log(`Testing Client Credentials connection for holding ${holdingId}`);

				const authData = await this.authService.authenticateWithClientCredentials(
					connection.client_id,
					connection.client_secret,
					holdingId,
					connection.login_url
				);

				await this.tokenService.updateTokens(holdingId, authData);

				this.logger.log(`✅ Client Credentials test successful for holding ${holdingId}`);

				return {
					ok: true,
					tested_at: testedAt,
					result: {
						instance_url: authData.instance_url,
						connection_id: connection.id,
						auth_type: 'client_credentials',
					},
				};
			}

			if (connection.auth_type === SalesforceAuthType.PASSWORD) {
				if (!connection.password) {
					throw new BadRequestException('Password not found in connection. Please reconnect using "Guardar Conexión y Validar".');
				}

				const decryptedPassword = this.encryptionService.decrypt(connection.password);
				const loginResult = await this.soapService.attemptLogin(
					connection.login_url,
					connection.username,
					decryptedPassword,
					connection.security_token
				);

				this.logger.log(`✅ SOAP test successful for holding ${holdingId}`);

				return {
					ok: true,
					tested_at: testedAt,
					result: {
						user_id: loginResult.userId,
						server_url: loginResult.serverUrl,
						connection_id: connection.id,
						auth_type: 'password',
					},
				};
			}

			throw new BadRequestException(`Unknown auth_type: ${connection.auth_type}`);
		} catch (error: any) {
			this.logger.error(`❌ Connection test failed for holding ${holdingId}:`, error.message);

			await this.connectionRepository.update(
				{ holding_id: holdingId },
				{
					access_token: null,
					is_active: false,
					token_issued_at: null,
					token_expires_at: null,
				}
			);

			this.logger.warn(`Access token cleared for holding ${holdingId} due to test failure`);

			throw new BadRequestException({
				ok: false,
				tested_at: testedAt,
				error: error.message,
			});
		}
	}

	async previewSync(holdingId: string, syncType: string = 'delta') {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new NotFoundException('No active Salesforce connection found');
		}

		const summary = {
			connection: {
				holding_id: connection.holding_id,
				username: connection.username,
				instance_url: connection.instance_url,
			},
			sync_type: syncType,
			preview: true,
			message: 'Preview generated successfully',
		};

		this.logger.log(`Preview sync generated for holding ${holdingId}`);

		return summary;
	}
}
