import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IntegrationSalesforceConnection } from './entities/integration-salesforce-connection.entity';
import { IntegrationSalesforceFieldMapping } from './entities/integration-salesforce-field-mapping.entity';
import { IntegrationSalesforceMappingDetail } from './entities/integration-salesforce-mapping-detail.entity';
import { IntegrationSalesforceSyncRun } from './entities/integration-salesforce-sync-run.entity';
import { SalesforceConnection } from './entities/salesforce-connection.entity';
import { SalesforceCredentials } from './interfaces/salesforce.interface';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';

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
		private readonly tokenService: SalesforceTokenService,
		private readonly soapService: SalesforceSoapService
	) {}

	async connect(credentials: SalesforceCredentials, userId: string, holdingId: string) {
		this.authService.validateCredentials(credentials);

		const authData = await this.authService.authenticate(credentials, holdingId);
		await this.authService.storeConnection(authData, credentials, userId, holdingId);

		return {
			success: true,
			message: 'Successfully connected to Salesforce',
			instanceUrl: authData.instance_url,
		};
	}

	async getConnection(holdingId: string) {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			return null;
		}

		return {
			id: connection.id,
			holding_id: connection.holding_id,
			username: connection.username,
			instance_url: connection.instance_url,
			is_active: connection.is_active,
			last_sync_at: connection.last_sync_at,
			created_at: connection.created_at,
		};
	}

	async disconnect(holdingId: string) {
		const result = await this.connectionRepository.update({ holding_id: holdingId, is_active: true }, { is_active: false });

		if (result.affected === 0) {
			throw new NotFoundException('No active connection found');
		}

		return {
			success: true,
			message: 'Successfully disconnected from Salesforce',
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

	async testConnection(holdingId: string) {
		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new NotFoundException('No active Salesforce connection found');
		}

		const testedAt = new Date().toISOString();

		try {
			const loginResult = await this.soapService.attemptLogin(
				connection.login_url,
				connection.username,
				connection.client_secret,
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
				},
			};
		} catch (error: any) {
			this.logger.error(`❌ SOAP test failed for holding ${holdingId}:`, error.message);

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
