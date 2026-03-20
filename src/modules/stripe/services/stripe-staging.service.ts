import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { StagingFiltersDto } from '../dto/staging-filters.dto';
import { ProcessingStatus } from '../dto/update-processing-status.dto';
import { StripeCustomersStg } from '../entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from '../entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from '../entities/stripe-subscriptions-stg.entity';

@Injectable()
export class StripeStagingService {
	constructor(
		@InjectRepository(StripeCustomersStg)
		private readonly customersStgRepository: Repository<StripeCustomersStg>,
		@InjectRepository(StripeSubscriptionsStg)
		private readonly subscriptionsStgRepository: Repository<StripeSubscriptionsStg>,
		@InjectRepository(StripeInvoicesStg)
		private readonly invoicesStgRepository: Repository<StripeInvoicesStg>
	) {}

	async getCustomers(holdingId: string, filters: StagingFiltersDto) {
		const { processing_status, search, page = 1, limit = 50 } = filters;

		const queryBuilder = this.customersStgRepository
			.createQueryBuilder('customer')
			.where('customer.holding_id = :holdingId', { holdingId })
			.orderBy('customer.created_at', 'DESC');

		if (processing_status) {
			queryBuilder.andWhere('customer.processing_status = :status', { status: processing_status });
		}

		if (search) {
			queryBuilder.andWhere('(customer.stripe_id ILIKE :search OR customer.raw_data::text ILIKE :search)', { search: `%${search}%` });
		}

		const [data, total] = await queryBuilder
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			data,
			total,
			page,
			limit,
		};
	}

	async getSubscriptions(holdingId: string, filters: StagingFiltersDto) {
		const { processing_status, search, page = 1, limit = 50 } = filters;

		const queryBuilder = this.subscriptionsStgRepository
			.createQueryBuilder('subscription')
			.where('subscription.holding_id = :holdingId', { holdingId })
			.orderBy('subscription.created_at', 'DESC');

		if (processing_status) {
			queryBuilder.andWhere('subscription.processing_status = :status', { status: processing_status });
		}

		if (search) {
			queryBuilder.andWhere('(subscription.stripe_id ILIKE :search OR subscription.raw_data::text ILIKE :search)', { search: `%${search}%` });
		}

		const [data, total] = await queryBuilder
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			data,
			total,
			page,
			limit,
		};
	}

	async getInvoices(holdingId: string, filters: StagingFiltersDto) {
		const { processing_status, search, page = 1, limit = 50 } = filters;

		const queryBuilder = this.invoicesStgRepository
			.createQueryBuilder('invoice')
			.where('invoice.holding_id = :holdingId', { holdingId })
			.orderBy('invoice.created_at', 'DESC');

		if (processing_status) {
			queryBuilder.andWhere('invoice.processing_status = :status', { status: processing_status });
		}

		if (search) {
			queryBuilder.andWhere('(invoice.stripe_id ILIKE :search OR invoice.raw_data::text ILIKE :search)', { search: `%${search}%` });
		}

		const [data, total] = await queryBuilder
			.skip((page - 1) * limit)
			.take(limit)
			.getManyAndCount();

		return {
			data,
			total,
			page,
			limit,
		};
	}

	async updateCustomerStatus(id: string, status: ProcessingStatus) {
		await this.customersStgRepository.update(id, {
			processing_status: status,
		});
	}

	async updateSubscriptionStatus(id: string, status: ProcessingStatus) {
		await this.subscriptionsStgRepository.update(id, {
			processing_status: status,
		});
	}

	async updateInvoiceStatus(id: string, status: ProcessingStatus) {
		await this.invoicesStgRepository.update(id, {
			processing_status: status,
		});
	}

	async bulkUpdateCustomersStatus(ids: string[], status: ProcessingStatus) {
		await this.customersStgRepository.update({ id: In(ids) }, { processing_status: status });
	}

	async bulkUpdateSubscriptionsStatus(ids: string[], status: ProcessingStatus) {
		await this.subscriptionsStgRepository.update({ id: In(ids) }, { processing_status: status });
	}

	async bulkUpdateInvoicesStatus(ids: string[], status: ProcessingStatus) {
		await this.invoicesStgRepository.update({ id: In(ids) }, { processing_status: status });
	}
}
