import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppLoggerService } from '@/logger/app-logger.service';

import { SALESFORCE_FIELD_MAPPING_DEFAULTS, SALESFORCE_FIELD_MAPPING_OBJECT_TYPES } from '../constants/salesforce-field-mapping-defaults';
import {
	CreateObjectMappingDto,
	CreateFieldMappingDto,
	CreateProductMappingDto,
	CreateQuoteTypeMappingDto,
	UpdateObjectMappingDto,
	UpdateFieldMappingDto,
	UpdateProductMappingDto,
	UpdateQuoteTypeMappingDto,
} from '../dtos/salesforce-mapping.dto';
import { SalesforceFieldMapping, SalesforceFieldMappingObjectType } from '../entities/salesforce-field-mapping.entity';
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
		@InjectRepository(SalesforceFieldMapping)
		private readonly fieldMappingRepository: Repository<SalesforceFieldMapping>,
		private readonly logger: AppLoggerService
	) {}

	async ensureDefaultFieldMappings(holdingId: string, objectType?: SalesforceFieldMappingObjectType): Promise<void> {
		const objectTypes = objectType ? [objectType] : SALESFORCE_FIELD_MAPPING_OBJECT_TYPES;

		for (const currentObjectType of objectTypes) {
			const defaults = SALESFORCE_FIELD_MAPPING_DEFAULTS[currentObjectType];
			if (!defaults?.length) {
				continue;
			}

			for (const entry of defaults) {
				const existing = await this.fieldMappingRepository.findOne({
					where: {
						holding_id: holdingId,
						object_type: entry.object_type,
						sapira_field: entry.sapira_field,
					},
				});

				if (existing) {
					continue;
				}

				await this.fieldMappingRepository.save(
					this.fieldMappingRepository.create({
						holding_id: holdingId,
						object_type: entry.object_type,
						sapira_field: entry.sapira_field,
						salesforce_field: entry.salesforce_field,
						is_required: entry.is_required,
						is_active: true,
						data_type: entry.data_type || null,
						default_value: entry.default_value ?? null,
					})
				);
			}
		}
	}

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

	async getFieldMappings(holdingId: string, objectType?: SalesforceFieldMappingObjectType): Promise<SalesforceFieldMapping[]> {
		await this.ensureDefaultFieldMappings(holdingId, objectType);

		const where: Partial<SalesforceFieldMapping> = { holding_id: holdingId };
		if (objectType) {
			where.object_type = objectType;
		}

		return this.fieldMappingRepository.find({
			where,
			order: {
				object_type: 'ASC',
				sapira_field: 'ASC',
			},
		});
	}

	async createFieldMapping(holdingId: string, dto: CreateFieldMappingDto): Promise<SalesforceFieldMapping> {
		this.logger.log(`Creating Salesforce field mapping for holding ${holdingId}`);

		const existing = await this.fieldMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				object_type: dto.object_type as SalesforceFieldMappingObjectType,
				sapira_field: dto.sapira_field,
			},
		});

		if (existing) {
			Object.assign(existing, dto);
			return this.fieldMappingRepository.save(existing);
		}

		return this.fieldMappingRepository.save(
			this.fieldMappingRepository.create({
				holding_id: holdingId,
				object_type: dto.object_type as SalesforceFieldMappingObjectType,
				sapira_field: dto.sapira_field,
				salesforce_field: dto.salesforce_field,
				is_required: dto.is_required ?? false,
				is_active: dto.is_active ?? true,
				data_type: dto.data_type || null,
				default_value: dto.default_value || null,
			})
		);
	}

	async updateFieldMapping(id: string, holdingId: string, dto: UpdateFieldMappingDto): Promise<SalesforceFieldMapping> {
		const mapping = await this.fieldMappingRepository.findOne({
			where: { id, holding_id: holdingId },
		});

		if (!mapping) {
			throw new NotFoundException(`Field mapping ${id} not found`);
		}

		Object.assign(mapping, dto);
		return this.fieldMappingRepository.save(mapping);
	}

	async deleteFieldMapping(id: string, holdingId: string): Promise<void> {
		const result = await this.fieldMappingRepository.delete({
			id,
			holding_id: holdingId,
		});

		if (result.affected === 0) {
			throw new NotFoundException(`Field mapping ${id} not found`);
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
