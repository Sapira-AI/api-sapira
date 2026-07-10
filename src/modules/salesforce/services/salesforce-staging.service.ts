import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'crypto';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';

import { SalesforceAccountsStg } from '../entities/salesforce-accounts-stg.entity';
import { SalesforceLineItemsStg } from '../entities/salesforce-line-items-stg.entity';
import { SalesforceOpportunitiesStg } from '../entities/salesforce-opportunities-stg.entity';

export type SalesforceStagingObjectType = 'accounts' | 'opportunities' | 'line-items';

export interface SalesforceStagingListParams {
	search?: string;
	status?: string;
	page?: number;
	limit?: number;
}

@Injectable()
export class SalesforceStagingService {
	constructor(
		@InjectRepository(SalesforceAccountsStg)
		private readonly accountsStgRepository: Repository<SalesforceAccountsStg>,
		@InjectRepository(SalesforceOpportunitiesStg)
		private readonly opportunitiesStgRepository: Repository<SalesforceOpportunitiesStg>,
		@InjectRepository(SalesforceLineItemsStg)
		private readonly lineItemsStgRepository: Repository<SalesforceLineItemsStg>
	) {}

	createRunContext() {
		return {
			batchId: randomUUID(),
			syncSessionId: randomUUID(),
		};
	}

	async upsertAccounts(holdingId: string, accounts: Record<string, any>[], batchId: string, syncSessionId: string): Promise<void> {
		for (const account of accounts) {
			const sourceHash = this.buildSourceHash(account);
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
			const sourceHash = this.buildSourceHash(opportunity);
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
			const sourceHash = this.buildSourceHash(lineItem);
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

	async markStatus(holdingId: string, objectType: SalesforceStagingObjectType, id: string, processingStatus: string, integrationNotes?: string | null) {
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
		const [total, create, update, processed, error] = await Promise.all([
			repository.count({ where: { holding_id: holdingId } }),
			repository.count({ where: { holding_id: holdingId, processing_status: 'create' } }),
			repository.count({ where: { holding_id: holdingId, processing_status: 'update' } }),
			repository.count({ where: { holding_id: holdingId, processing_status: 'processed' } }),
			repository.count({ where: { holding_id: holdingId, processing_status: 'error' } }),
		]);

		return { total, create, update, processed, error };
	}

	private buildWhereClause(holdingId: string, params: SalesforceStagingListParams): FindOptionsWhere<any> | FindOptionsWhere<any>[] {
		const base: FindOptionsWhere<any> = { holding_id: holdingId };
		if (params.status) {
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

	private buildSourceHash(payload: Record<string, any>): string {
		return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
	}
}
