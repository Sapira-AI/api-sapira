import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SalesforceConnection } from '../entities/salesforce-connection.entity';
import { SalesforceOpportunityCache } from '../entities/salesforce-opportunity-cache.entity';
import { SalesforceOpportunity, SalesforceSyncResult } from '../interfaces/salesforce.interface';

import { SalesforceQueryService } from './salesforce-query.service';
import { SalesforceTokenService } from './salesforce-token.service';

@Injectable()
export class SalesforceSyncService {
	private readonly logger = new Logger(SalesforceSyncService.name);

	constructor(
		@InjectRepository(SalesforceConnection)
		private readonly connectionRepository: Repository<SalesforceConnection>,
		@InjectRepository(SalesforceOpportunityCache)
		private readonly opportunityCacheRepository: Repository<SalesforceOpportunityCache>,
		private readonly queryService: SalesforceQueryService,
		private readonly tokenService: SalesforceTokenService
	) {}

	async syncOpportunities(holdingId: string, dateFrom?: string, dateTo?: string): Promise<SalesforceSyncResult> {
		this.logger.log(`Starting sync for holding ${holdingId}`);

		const connection = await this.connectionRepository.findOne({
			where: { holding_id: holdingId, is_active: true },
		});

		if (!connection) {
			throw new Error('No active Salesforce connection found');
		}

		const from = dateFrom || this.getYesterdayDate();
		const to = dateTo || from;

		this.logger.log(`Sync date range: ${from} to ${to}`);

		const soql = this.buildSyncQuery(from);

		try {
			const { data } = await this.queryService.executeQuery(soql, holdingId);
			const opportunities = data.records || [];

			this.logger.log(`Found ${opportunities.length} opportunities`);

			const saved = await this.saveOpportunitiesToCache(opportunities, holdingId, from);

			await this.connectionRepository.update({ holding_id: holdingId }, { last_sync_at: new Date() });

			return {
				holding_id: holdingId,
				opportunities: opportunities.length,
				saved,
				success: true,
			};
		} catch (error: any) {
			this.logger.error(`Sync failed for holding ${holdingId}:`, error.message);
			return {
				holding_id: holdingId,
				opportunities: 0,
				saved: 0,
				success: false,
				error: error.message,
			};
		}
	}

	async syncAllActiveConnections(): Promise<SalesforceSyncResult[]> {
		this.logger.log('Starting sync for all active connections');

		const connections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		this.logger.log(`Found ${connections.length} active connections`);

		const results: SalesforceSyncResult[] = [];

		for (const connection of connections) {
			const result = await this.syncOpportunities(connection.holding_id);
			results.push(result);
		}

		return results;
	}

	buildSyncQuery(dateFrom: string): string {
		return `
			SELECT 
				Id, Name, AccountId, Type, CloseDate, StageName, IsWon, IsClosed,
				Amount, CurrencyIsoCode, 
				Modalidad_de_pago__c, Forma_de_pago__c, Contrato__c, 
				Orden_de_compra__c, QuoteProjectManager__c, QuoteBillingEmail__c,
				id_largo_oportunidad__c,
				Account.Id, Account.Name, Account.BillingCountry
			FROM Opportunity
			WHERE CloseDate = ${dateFrom}
				AND (StageName = 'Ganado' OR StageName = 'Closed Won' OR StageName = 'Cerrada Win')
				AND IsDeleted = false
			ORDER BY CloseDate DESC
			LIMIT 1000
		`.trim();
	}

	async saveOpportunitiesToCache(opportunities: SalesforceOpportunity[], holdingId: string, syncDate: string): Promise<number> {
		let savedCount = 0;

		for (const opp of opportunities) {
			try {
				const cacheData = {
					holding_id: holdingId,
					salesforce_id: opp.Id,
					salesforce_account_id: opp.AccountId,
					opportunity_name: opp.Name,
					account_name: opp.Account?.Name || 'Sin cuenta',
					account_country: opp.Account?.BillingCountry || null,
					opportunity_type: opp.Type,
					stage_name: opp.StageName,
					is_won: opp.IsWon || false,
					is_closed: opp.IsClosed || false,
					amount: opp.Amount || 0,
					currency_iso_code: opp.CurrencyIsoCode || 'USD',
					close_date: new Date(opp.CloseDate),
					id_largo_oportunidad__c: opp.id_largo_oportunidad__c,
					modalidad_de_pago__c: opp.Modalidad_de_pago__c,
					forma_de_pago__c: opp.Forma_de_pago__c,
					contrato__c: opp.Contrato__c,
					orden_de_compra__c: opp.Orden_de_compra__c,
					quote_project_manager__c: opp.QuoteProjectManager__c,
					quote_billing_email__c: opp.QuoteBillingEmail__c,
					line_items_count: 0,
					line_items: [],
					sync_date: new Date(syncDate),
				};

				const existing = await this.opportunityCacheRepository.findOne({
					where: {
						holding_id: holdingId,
						salesforce_id: opp.Id,
					},
				});

				if (existing) {
					await this.opportunityCacheRepository.update({ id: existing.id }, cacheData);
				} else {
					const cache = this.opportunityCacheRepository.create(cacheData);
					await this.opportunityCacheRepository.save(cache);
				}

				savedCount++;
			} catch (error: any) {
				this.logger.error(`Failed to save opportunity ${opp.Id}:`, error.message);
			}
		}

		return savedCount;
	}

	private getYesterdayDate(): string {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);
		return yesterday.toISOString().split('T')[0];
	}
}
