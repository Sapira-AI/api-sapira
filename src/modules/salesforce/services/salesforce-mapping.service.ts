import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppLoggerService } from '@/logger/app-logger.service';

import {
	CreateObjectMappingDto,
	CreateProductMappingDto,
	CreateQuoteTypeMappingDto,
	UpdateObjectMappingDto,
	UpdateProductMappingDto,
	UpdateQuoteTypeMappingDto,
} from '../dtos/salesforce-mapping.dto';
import { SalesforceObjectMapping } from '../entities/salesforce-object-mapping.entity';
import { SalesforceProductMapping } from '../entities/salesforce-product-mapping.entity';
import { SalesforceQuoteTypeMapping } from '../entities/salesforce-quote-type-mapping.entity';

@Injectable()
export class SalesforceMappingService {
	constructor(
		@InjectRepository(SalesforceProductMapping)
		private readonly productMappingRepository: Repository<SalesforceProductMapping>,
		@InjectRepository(SalesforceQuoteTypeMapping)
		private readonly quoteTypeMappingRepository: Repository<SalesforceQuoteTypeMapping>,
		@InjectRepository(SalesforceObjectMapping)
		private readonly objectMappingRepository: Repository<SalesforceObjectMapping>,
		private readonly logger: AppLoggerService
	) {}

	async getProductMappings(holdingId: string): Promise<SalesforceProductMapping[]> {
		this.logger.log(`Getting product mappings for holding ${holdingId}`);

		return this.productMappingRepository.find({
			where: { holding_id: holdingId },
			order: { created_at: 'DESC' },
		});
	}

	async createProductMapping(holdingId: string, dto: CreateProductMappingDto): Promise<SalesforceProductMapping> {
		this.logger.log(`Creating product mapping for holding ${holdingId}`);

		const existing = await this.productMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_product_id: dto.salesforce_product_id,
			},
		});

		if (existing) {
			this.logger.log(`Product mapping already exists, updating it`);
			Object.assign(existing, dto);
			existing.is_active = true;
			return this.productMappingRepository.save(existing);
		}

		const mapping = this.productMappingRepository.create({
			holding_id: holdingId,
			...dto,
			is_active: true,
		});

		return this.productMappingRepository.save(mapping);
	}

	async updateProductMapping(id: string, holdingId: string, dto: UpdateProductMappingDto): Promise<SalesforceProductMapping> {
		this.logger.log(`Updating product mapping ${id} for holding ${holdingId}`);

		const mapping = await this.productMappingRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!mapping) {
			throw new NotFoundException(`Product mapping ${id} not found`);
		}

		Object.assign(mapping, dto);
		return this.productMappingRepository.save(mapping);
	}

	async deleteProductMapping(id: string, holdingId: string): Promise<void> {
		this.logger.log(`Deleting product mapping ${id} for holding ${holdingId}`);

		const result = await this.productMappingRepository.delete({
			id,
			holding_id: holdingId,
		});

		if (result.affected === 0) {
			throw new NotFoundException(`Product mapping ${id} not found`);
		}
	}

	async getQuoteTypeMappings(holdingId: string): Promise<SalesforceQuoteTypeMapping[]> {
		this.logger.log(`Getting quote type mappings for holding ${holdingId}`);

		return this.quoteTypeMappingRepository.find({
			where: { holding_id: holdingId },
			order: { created_at: 'DESC' },
		});
	}

	async createQuoteTypeMapping(holdingId: string, dto: CreateQuoteTypeMappingDto): Promise<SalesforceQuoteTypeMapping> {
		this.logger.log(`Creating quote type mapping for holding ${holdingId}`);

		const existing = await this.quoteTypeMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_type: dto.salesforce_type,
			},
		});

		if (existing) {
			this.logger.log(`Quote type mapping already exists, updating it`);
			Object.assign(existing, dto);
			existing.is_active = true;
			return this.quoteTypeMappingRepository.save(existing);
		}

		const mapping = this.quoteTypeMappingRepository.create({
			holding_id: holdingId,
			...dto,
			is_active: true,
		});

		return this.quoteTypeMappingRepository.save(mapping);
	}

	async updateQuoteTypeMapping(id: string, holdingId: string, dto: UpdateQuoteTypeMappingDto): Promise<SalesforceQuoteTypeMapping> {
		this.logger.log(`Updating quote type mapping ${id} for holding ${holdingId}`);

		const mapping = await this.quoteTypeMappingRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!mapping) {
			throw new NotFoundException(`Quote type mapping ${id} not found`);
		}

		Object.assign(mapping, dto);
		return this.quoteTypeMappingRepository.save(mapping);
	}

	async deleteQuoteTypeMapping(id: string, holdingId: string): Promise<void> {
		this.logger.log(`Deleting quote type mapping ${id} for holding ${holdingId}`);

		const result = await this.quoteTypeMappingRepository.delete({
			id,
			holding_id: holdingId,
		});

		if (result.affected === 0) {
			throw new NotFoundException(`Quote type mapping ${id} not found`);
		}
	}

	async getObjectMappings(holdingId: string, objectType?: string): Promise<SalesforceObjectMapping[]> {
		this.logger.log(`Getting object mappings for holding ${holdingId}, type: ${objectType || 'all'}`);

		const where: any = { holding_id: holdingId };
		if (objectType) {
			where.salesforce_object_type = objectType;
		}

		return this.objectMappingRepository.find({
			where,
			order: { created_at: 'DESC' },
		});
	}

	async createObjectMapping(holdingId: string, dto: CreateObjectMappingDto): Promise<SalesforceObjectMapping> {
		this.logger.log(`Creating object mapping for holding ${holdingId}`);

		const existing = await this.objectMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_object_id: dto.salesforce_object_id,
				salesforce_object_type: dto.salesforce_object_type,
			},
		});

		if (existing) {
			this.logger.log(`Object mapping already exists, updating it`);
			Object.assign(existing, dto);
			return this.objectMappingRepository.save(existing);
		}

		const mapping = this.objectMappingRepository.create({
			holding_id: holdingId,
			...dto,
		});

		return this.objectMappingRepository.save(mapping);
	}

	async updateObjectMapping(id: string, holdingId: string, dto: UpdateObjectMappingDto): Promise<SalesforceObjectMapping> {
		this.logger.log(`Updating object mapping ${id} for holding ${holdingId}`);

		const mapping = await this.objectMappingRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!mapping) {
			throw new NotFoundException(`Object mapping ${id} not found`);
		}

		Object.assign(mapping, dto);
		return this.objectMappingRepository.save(mapping);
	}

	async deleteObjectMapping(id: string, holdingId: string): Promise<void> {
		this.logger.log(`Deleting object mapping ${id} for holding ${holdingId}`);

		const result = await this.objectMappingRepository.delete({
			id,
			holding_id: holdingId,
		});

		if (result.affected === 0) {
			throw new NotFoundException(`Object mapping ${id} not found`);
		}
	}
}
