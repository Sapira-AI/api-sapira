import { createHash, randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, In, Repository, SelectQueryBuilder } from 'typeorm';

import { Client } from '@/databases/postgresql/entities/client.entity';

import { SalesforceAccountsStg } from '../entities/salesforce-accounts-stg.entity';
import { SalesforceLineItemsStg } from '../entities/salesforce-line-items-stg.entity';
import { SalesforceObjectMapping } from '../entities/salesforce-object-mapping.entity';
import { SalesforceOpportunitiesStg } from '../entities/salesforce-opportunities-stg.entity';
import { isoToCountryName } from '../utils/salesforce-transformers';

export type SalesforceStagingObjectType = 'accounts' | 'opportunities' | 'line-items';

export interface SalesforceStagingListParams {
	search?: string;
	status?: string;
	statuses?: string[];
	page?: number;
	limit?: number;
}

export interface SalesforceAccountsMappingViewParams extends SalesforceStagingListParams {
	country?: string;
	countryCode?: string;
	mappingState?: 'all' | 'mapped' | 'unmapped' | 'outdated';
}

export interface SalesforceMappingViewClientSummary {
	id: string;
	name_commercial: string | null;
	client_number: string | null;
	industry: string | null;
	segment: string | null;
	country: string | null;
}

export interface SalesforceMappingViewItem {
	id: string;
	salesforce_id: string;
	salesforce_name: string | null;
	processing_status: string | null;
	error_message: string | null;
	integration_notes: string | null;
	batch_id: string | null;
	sync_session_id: string | null;
	raw_data: Record<string, any>;
	account_country: string | null;
	mapping: {
		id: string;
		sapira_record_id: string;
	} | null;
	client: SalesforceMappingViewClientSummary | null;
	is_mapped: boolean;
	is_outdated: boolean;
	outdated_fields: string[];
	created_at: Date;
	updated_at: Date;
	processed_at: Date | null;
	last_integrated_at: Date | null;
}

@Injectable()
export class SalesforceStagingService {
	constructor(
		@InjectRepository(SalesforceAccountsStg)
		private readonly accountsStgRepository: Repository<SalesforceAccountsStg>,
		@InjectRepository(SalesforceOpportunitiesStg)
		private readonly opportunitiesStgRepository: Repository<SalesforceOpportunitiesStg>,
		@InjectRepository(SalesforceLineItemsStg)
		private readonly lineItemsStgRepository: Repository<SalesforceLineItemsStg>,
		@InjectRepository(SalesforceObjectMapping)
		private readonly objectMappingRepository: Repository<SalesforceObjectMapping>,
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>
	) {}

	createRunContext() {
		return {
			batchId: randomUUID(),
			syncSessionId: randomUUID(),
		};
	}

	async upsertAccounts(holdingId: string, accounts: Record<string, any>[], batchId: string, syncSessionId: string): Promise<void> {
		for (const account of accounts) {
			const sourceHash = this.getSourceHash(account);
			const existing = await this.accountsStgRepository.findOne({
				where: { holding_id: holdingId, salesforce_id: account.Id },
			});

			if (existing) {
				await this.accountsStgRepository.update(existing.id, {
					salesforce_name: account.Name || null,
					raw_data: account,
					source_hash: sourceHash,
					batch_id: batchId,
					sync_session_id: syncSessionId,
					error_message: null,
					integration_notes: null,
				});
				continue;
			}

			await this.accountsStgRepository.save(
				this.accountsStgRepository.create({
					holding_id: holdingId,
					salesforce_id: account.Id,
					salesforce_name: account.Name || null,
					raw_data: account,
					source_hash: sourceHash,
					batch_id: batchId,
					sync_session_id: syncSessionId,
					processing_status: 'create',
				})
			);
		}
	}

	async upsertOpportunities(holdingId: string, opportunities: Record<string, any>[], batchId: string, syncSessionId: string): Promise<void> {
		for (const opportunity of opportunities) {
			const sourceHash = this.getSourceHash(opportunity);
			const existing = await this.opportunitiesStgRepository.findOne({
				where: { holding_id: holdingId, salesforce_id: opportunity.Id },
			});

			if (existing) {
				await this.opportunitiesStgRepository.update(existing.id, {
					salesforce_name: opportunity.Name || null,
					salesforce_account_id: opportunity.AccountId || null,
					raw_data: opportunity,
					source_hash: sourceHash,
					batch_id: batchId,
					sync_session_id: syncSessionId,
					error_message: null,
					integration_notes: null,
				});
				continue;
			}

			await this.opportunitiesStgRepository.save(
				this.opportunitiesStgRepository.create({
					holding_id: holdingId,
					salesforce_id: opportunity.Id,
					salesforce_name: opportunity.Name || null,
					salesforce_account_id: opportunity.AccountId || null,
					raw_data: opportunity,
					source_hash: sourceHash,
					batch_id: batchId,
					sync_session_id: syncSessionId,
					processing_status: 'create',
				})
			);
		}
	}

	async upsertLineItems(
		holdingId: string,
		opportunityStagingIdsBySalesforceId: Map<string, string>,
		lineItems: Record<string, any>[],
		batchId: string,
		syncSessionId: string
	): Promise<void> {
		for (const lineItem of lineItems) {
			const sourceHash = this.getSourceHash(lineItem);
			const existing = await this.lineItemsStgRepository.findOne({
				where: { holding_id: holdingId, salesforce_id: lineItem.Id },
			});

			const sharedPayload = {
				opportunity_staging_id: opportunityStagingIdsBySalesforceId.get(lineItem.OpportunityId || '') || null,
				salesforce_opportunity_id: lineItem.OpportunityId || null,
				salesforce_product_id: lineItem.Product2Id || null,
				salesforce_name: lineItem.Product2?.Name || lineItem.Description || lineItem.Id,
				raw_data: lineItem,
				source_hash: sourceHash,
				batch_id: batchId,
				sync_session_id: syncSessionId,
				error_message: null,
				integration_notes: null,
			};

			if (existing) {
				await this.lineItemsStgRepository.update(existing.id, sharedPayload);
				continue;
			}

			await this.lineItemsStgRepository.save(
				this.lineItemsStgRepository.create({
					holding_id: holdingId,
					salesforce_id: lineItem.Id,
					processing_status: 'create',
					...sharedPayload,
				})
			);
		}
	}

	async getOpportunityStagingIds(holdingId: string, salesforceIds: string[]): Promise<Map<string, string>> {
		const rows = await this.opportunitiesStgRepository.find({
			where: salesforceIds.map((salesforceId) => ({ holding_id: holdingId, salesforce_id: salesforceId })),
			select: ['id', 'salesforce_id'],
		});

		return new Map(rows.map((row) => [row.salesforce_id, row.id]));
	}

	async getStats(holdingId: string) {
		const [accounts, opportunities, lineItems] = await Promise.all([
			this.buildStatusStats(this.accountsStgRepository, holdingId),
			this.buildStatusStats(this.opportunitiesStgRepository, holdingId),
			this.buildStatusStats(this.lineItemsStgRepository, holdingId),
		]);

		return {
			accounts,
			opportunities,
			lineItems,
		};
	}

	async getRecords(holdingId: string, objectType: SalesforceStagingObjectType, params: SalesforceStagingListParams = {}) {
		const repository = this.getRepository(objectType);
		const page = params.page && params.page > 0 ? params.page : 1;
		const limit = params.limit && params.limit > 0 ? params.limit : 20;
		const where = this.buildWhereClause(holdingId, params);

		const [items, total] = await repository.findAndCount({
			where,
			order: { updated_at: 'DESC' as const },
			skip: (page - 1) * limit,
			take: limit,
		});

		return {
			items,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit) || 1,
		};
	}

	async getAccountsMappingView(holdingId: string, params: SalesforceAccountsMappingViewParams = {}) {
		const page = params.page && params.page > 0 ? params.page : 1;
		const limit = params.limit && params.limit > 0 ? params.limit : 50;
		const mappingState = params.mappingState || 'all';

		const summaryBaseQuery = this.buildAccountsMappingBaseQuery(holdingId, params);
		const listBaseQuery = this.buildAccountsMappingBaseQuery(holdingId, params);
		this.applyMappingStateFilter(listBaseQuery, mappingState);

		const [summary, total, availableCountries] = await Promise.all([
			this.buildAccountsMappingSummary(summaryBaseQuery),
			this.countDistinctAccounts(listBaseQuery),
			this.getAvailableCountries(summaryBaseQuery),
		]);

		const rows = await this.selectAccountsMappingViewColumns(listBaseQuery)
			.orderBy('stg.updated_at', 'DESC')
			.skip((page - 1) * limit)
			.take(limit)
			.getRawMany();

		const items = rows.map((row) => this.buildAccountsMappingViewItem(row));

		return {
			items,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit) || 1,
			summary,
			availableCountries,
		};
	}

	async markStatus(
		holdingId: string,
		objectType: SalesforceStagingObjectType,
		id: string,
		processingStatus: string,
		integrationNotes?: string | null
	) {
		const repository = this.getRepository(objectType);
		await repository.update({ id, holding_id: holdingId } as any, {
			processing_status: processingStatus,
			integration_notes: integrationNotes ?? null,
		});
	}

	private getRepository(objectType: SalesforceStagingObjectType) {
		switch (objectType) {
			case 'accounts':
				return this.accountsStgRepository;
			case 'opportunities':
				return this.opportunitiesStgRepository;
			case 'line-items':
				return this.lineItemsStgRepository;
		}
	}

	private async buildStatusStats(repository: Repository<any>, holdingId: string) {
		const rows = await repository
			.createQueryBuilder('stg')
			.select('COALESCE(stg.processing_status, :unknown)', 'status')
			.addSelect('COUNT(1)', 'count')
			.where('stg.holding_id = :holdingId', { holdingId, unknown: 'unknown' })
			.groupBy('COALESCE(stg.processing_status, :unknown)')
			.setParameter('unknown', 'unknown')
			.getRawMany<{ status: string; count: string }>();

		const summary = {
			total: 0,
			create: 0,
			update: 0,
			processed: 0,
			error: 0,
		};

		for (const row of rows) {
			const count = Number(row.count || 0);
			summary.total += count;

			if (row.status === 'create') {
				summary.create = count;
			} else if (row.status === 'update') {
				summary.update = count;
			} else if (row.status === 'processed') {
				summary.processed = count;
			} else if (row.status === 'error') {
				summary.error = count;
			}
		}

		return summary;
	}

	private buildWhereClause(holdingId: string, params: SalesforceStagingListParams): FindOptionsWhere<any> | FindOptionsWhere<any>[] {
		const base: FindOptionsWhere<any> = { holding_id: holdingId };
		if (params.statuses?.length) {
			base.processing_status = In(params.statuses);
		} else if (params.status) {
			base.processing_status = params.status;
		}

		if (!params.search) {
			return base;
		}

		return [
			{ ...base, salesforce_name: ILike(`%${params.search}%`) },
			{ ...base, salesforce_id: ILike(`%${params.search}%`) },
		];
	}

	getSourceHash(payload: Record<string, any>): string {
		return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
	}

	private buildAccountsMappingBaseQuery(holdingId: string, params: SalesforceAccountsMappingViewParams) {
		const query = this.accountsStgRepository
			.createQueryBuilder('stg')
			.leftJoin(
				SalesforceObjectMapping,
				'mapping',
				"mapping.holding_id = stg.holding_id AND mapping.salesforce_object_id = stg.salesforce_id AND mapping.salesforce_object_type = 'Account' AND mapping.sapira_table_name = 'clients'"
			)
			.leftJoin(Client, 'client', 'client.id = mapping.sapira_record_id')
			.where('stg.holding_id = :holdingId', { holdingId });

		if (params.status) {
			query.andWhere('stg.processing_status = :status', { status: params.status });
		}

		if (params.search?.trim()) {
			query.andWhere(
				`(
					stg.salesforce_name ILIKE :search
					OR stg.salesforce_id ILIKE :search
					OR COALESCE(stg.raw_data->>'BusinessName__c', '') ILIKE :search
					OR COALESCE(stg.raw_data->>'RUT__c', '') ILIKE :search
					OR COALESCE(stg.raw_data->>'Salesforce_API_ID__c', '') ILIKE :search
					OR COALESCE(stg.raw_data->>'Industry', '') ILIKE :search
					OR COALESCE(stg.raw_data->>'Segmento__c', '') ILIKE :search
				)`,
				{ search: `%${params.search.trim()}%` }
			);
		}

		const country = params.country?.trim().toLowerCase();
		const countryCode = params.countryCode?.trim().toLowerCase();
		if (country || countryCode) {
			const comparisons = [
				"LOWER(COALESCE(stg.raw_data->>'BillingCountry', '')) = :country",
				"LOWER(COALESCE(stg.raw_data->>'DemoCountry__c', '')) = :country",
			];

			if (countryCode) {
				comparisons.push("LOWER(COALESCE(stg.raw_data->>'BillingCountry', '')) = :countryCode");
				comparisons.push("LOWER(COALESCE(stg.raw_data->>'DemoCountry__c', '')) = :countryCode");
			}

			query.andWhere(`(${comparisons.join(' OR ')})`, {
				country: country || countryCode,
				countryCode,
			});
		}

		return query;
	}

	private applyMappingStateFilter(
		query: SelectQueryBuilder<SalesforceAccountsStg>,
		mappingState: NonNullable<SalesforceAccountsMappingViewParams['mappingState']>
	) {
		switch (mappingState) {
			case 'mapped':
				query.andWhere('mapping.id IS NOT NULL');
				break;
			case 'unmapped':
				query.andWhere('mapping.id IS NULL');
				break;
			case 'outdated':
				query.andWhere(this.getOutdatedWhereClause());
				break;
			default:
				break;
		}
	}

	private selectAccountsMappingViewColumns(query: SelectQueryBuilder<SalesforceAccountsStg>) {
		return query
			.select('stg.id', 'id')
			.addSelect('stg.salesforce_id', 'salesforce_id')
			.addSelect('stg.salesforce_name', 'salesforce_name')
			.addSelect('stg.processing_status', 'processing_status')
			.addSelect('stg.error_message', 'error_message')
			.addSelect('stg.integration_notes', 'integration_notes')
			.addSelect('stg.batch_id', 'batch_id')
			.addSelect('stg.sync_session_id', 'sync_session_id')
			.addSelect('stg.raw_data', 'raw_data')
			.addSelect('stg.created_at', 'created_at')
			.addSelect('stg.updated_at', 'updated_at')
			.addSelect('stg.processed_at', 'processed_at')
			.addSelect('stg.last_integrated_at', 'last_integrated_at')
			.addSelect('mapping.id', 'mapping_id')
			.addSelect('mapping.sapira_record_id', 'mapping_sapira_record_id')
			.addSelect('client.id', 'client_id')
			.addSelect('client.name_commercial', 'client_name_commercial')
			.addSelect('client.client_number', 'client_client_number')
			.addSelect('client.industry', 'client_industry')
			.addSelect('client.segment', 'client_segment')
			.addSelect('client.country', 'client_country');
	}

	private async countDistinctAccounts(query: SelectQueryBuilder<SalesforceAccountsStg>) {
		const result = await query.clone().select('COUNT(DISTINCT stg.id)', 'count').getRawOne<{ count?: string }>();
		return Number(result?.count || 0);
	}

	private async buildAccountsMappingSummary(baseQuery: SelectQueryBuilder<SalesforceAccountsStg>) {
		const [total, mapped, unmapped, outdated] = await Promise.all([
			this.countDistinctAccounts(baseQuery),
			this.countDistinctAccounts(baseQuery.clone().andWhere('mapping.id IS NOT NULL')),
			this.countDistinctAccounts(baseQuery.clone().andWhere('mapping.id IS NULL')),
			this.countDistinctAccounts(baseQuery.clone().andWhere(this.getOutdatedWhereClause())),
		]);

		return {
			total,
			mapped,
			unmapped,
			outdated,
		};
	}

	private async getAvailableCountries(baseQuery: SelectQueryBuilder<SalesforceAccountsStg>) {
		const rows = await baseQuery
			.clone()
			.select("stg.raw_data->>'DemoCountry__c'", 'demo_country')
			.addSelect("stg.raw_data->>'BillingCountry'", 'billing_country')
			.distinct(true)
			.getRawMany<{ demo_country?: string | null; billing_country?: string | null }>();

		return Array.from(
			new Set(
				rows
					.map((row) => this.getAccountCountry({ DemoCountry__c: row.demo_country, BillingCountry: row.billing_country }))
					.filter((country): country is string => Boolean(country))
			)
		).sort((left, right) => left.localeCompare(right));
	}

	private buildAccountsMappingViewItem(row: Record<string, unknown>): SalesforceMappingViewItem {
		const rawData = (row.raw_data as Record<string, any>) || {};
		const accountCountry = this.getAccountCountry(rawData);
		const client = this.buildClientSummary(row);
		const outdatedFields = this.getOutdatedFields(rawData, client);
		const mappingId = this.asNullableString(row.mapping_id);
		const sapiraRecordId = this.asNullableString(row.mapping_sapira_record_id);

		return {
			id: String(row.id),
			salesforce_id: String(row.salesforce_id),
			salesforce_name: this.asNullableString(row.salesforce_name),
			processing_status: this.asNullableString(row.processing_status),
			error_message: this.asNullableString(row.error_message),
			integration_notes: this.asNullableString(row.integration_notes),
			batch_id: this.asNullableString(row.batch_id),
			sync_session_id: this.asNullableString(row.sync_session_id),
			raw_data: rawData,
			account_country: accountCountry,
			mapping: mappingId && sapiraRecordId ? { id: mappingId, sapira_record_id: sapiraRecordId } : null,
			client,
			is_mapped: Boolean(mappingId && sapiraRecordId),
			is_outdated: outdatedFields.length > 0,
			outdated_fields: outdatedFields,
			created_at: row.created_at as Date,
			updated_at: row.updated_at as Date,
			processed_at: (row.processed_at as Date | null) ?? null,
			last_integrated_at: (row.last_integrated_at as Date | null) ?? null,
		};
	}

	private buildClientSummary(row: Record<string, unknown>): SalesforceMappingViewClientSummary | null {
		const clientId = this.asNullableString(row.client_id);
		if (!clientId) {
			return null;
		}

		return {
			id: clientId,
			name_commercial: this.asNullableString(row.client_name_commercial),
			client_number: this.asNullableString(row.client_client_number),
			industry: this.asNullableString(row.client_industry),
			segment: this.asNullableString(row.client_segment),
			country: this.asNullableString(row.client_country),
		};
	}

	private getOutdatedFields(rawData: Record<string, any>, client: SalesforceMappingViewClientSummary | null) {
		if (!client) {
			return [];
		}

		const outdatedFields: string[] = [];
		const salesforceCountry = this.getAccountCountry(rawData);

		if (salesforceCountry && client.country !== salesforceCountry) {
			outdatedFields.push('País');
		}
		if (rawData.Industry && client.industry !== rawData.Industry) {
			outdatedFields.push('Industria');
		}
		if (rawData.Segmento__c && client.segment !== rawData.Segmento__c) {
			outdatedFields.push('Segmento');
		}
		if (rawData.Name && client.name_commercial !== rawData.Name) {
			outdatedFields.push('Nombre');
		}

		return outdatedFields;
	}

	private getAccountCountry(rawData: Record<string, any>) {
		return isoToCountryName(rawData.DemoCountry__c || undefined) || rawData.BillingCountry || null;
	}

	private asNullableString(value: unknown) {
		return typeof value === 'string' && value.length > 0 ? value : null;
	}

	private getOutdatedWhereClause() {
		return `mapping.id IS NOT NULL AND (
			COALESCE(client.name_commercial, '') <> COALESCE(stg.raw_data->>'Name', '')
			OR COALESCE(client.industry, '') <> COALESCE(stg.raw_data->>'Industry', '')
			OR COALESCE(client.segment, '') <> COALESCE(stg.raw_data->>'Segmento__c', '')
			OR (
				COALESCE(client.country, '') <> COALESCE(stg.raw_data->>'BillingCountry', '')
				AND COALESCE(client.country, '') <> COALESCE(stg.raw_data->>'DemoCountry__c', '')
			)
		)`;
	}
}
