import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { Product } from '@/modules/odoo/entities/products.entity';

import { ClientContact } from '../entities/client-contact.entity';
import {
	SalesforceDuplicateClientEntitiesQueryDto,
	SalesforceDuplicateClientEntitiesResponseDto,
	SalesforceDuplicateTaxIdGroupDto,
} from '../dtos/salesforce-duplicate-client-entities.dto';
import { MasterData } from '../entities/master-data.entity';
import { QuoteItem } from '../entities/quote-item.entity';
import { QuoteStage } from '../entities/quote-stage.entity';
import { Quote } from '../entities/quote.entity';
import { SalesforceObjectMapping } from '../entities/salesforce-object-mapping.entity';
import { SalesforceProductMapping } from '../entities/salesforce-product-mapping.entity';
import { Seller } from '../entities/seller.entity';

export interface ClientEntityTaxIdResolution {
	entities: Pick<
		ClientEntity,
		'id' | 'client_id' | 'legal_name' | 'tax_id' | 'country' | 'legal_address' | 'economic_activity' | 'client_number'
	>[];
}

@Injectable()
export class SalesforceTypeOrmService {
	private readonly logger = new Logger(SalesforceTypeOrmService.name);

	constructor(
		@InjectRepository(MasterData)
		private readonly masterDataRepository: Repository<MasterData>,
		@InjectRepository(SalesforceObjectMapping)
		private readonly objectMappingRepository: Repository<SalesforceObjectMapping>,
		@InjectRepository(Product)
		private readonly productRepository: Repository<Product>,
		@InjectRepository(Quote)
		private readonly quoteRepository: Repository<Quote>,
		@InjectRepository(QuoteItem)
		private readonly quoteItemRepository: Repository<QuoteItem>,
		@InjectRepository(QuoteStage)
		private readonly quoteStageRepository: Repository<QuoteStage>,
		@InjectRepository(ClientContact)
		private readonly clientContactRepository: Repository<ClientContact>,
		@InjectRepository(Seller)
		private readonly sellerRepository: Repository<Seller>,
		@InjectRepository(Client)
		private readonly clientRepository: Repository<Client>,
		@InjectRepository(ClientEntity)
		private readonly clientEntityRepository: Repository<ClientEntity>,
		@InjectRepository(ClientEntityClient)
		private readonly clientEntityClientRepository: Repository<ClientEntityClient>,
		@InjectRepository(SalesforceProductMapping)
		private readonly salesforceProductMappingRepository: Repository<SalesforceProductMapping>
	) {}

	async ensureMasterDataValue(holdingId: string, category: string, value: string): Promise<void> {
		if (!value) return;

		const existing = await this.masterDataRepository.findOne({
			where: { holding_id: holdingId, category, value },
		});

		if (existing) return;

		try {
			await this.masterDataRepository.save({
				holding_id: holdingId,
				category: category,
				value: value,
			});
		} catch (error: any) {
			this.logger.error(`Error creating master_data: ${error.message}`);
		}
	}

	async getObjectMapping(holdingId: string, salesforceObjectType: string, salesforceObjectId: string): Promise<string | null> {
		const mapping = await this.objectMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_object_type: salesforceObjectType,
				salesforce_object_id: salesforceObjectId,
			},
		});

		return mapping?.sapira_record_id || null;
	}

	async createObjectMapping(
		holdingId: string,
		salesforceObjectType: string,
		salesforceObjectId: string,
		sapiraTableName: string,
		sapiraRecordId: string
	): Promise<void> {
		try {
			await this.objectMappingRepository.save({
				holding_id: holdingId,
				salesforce_object_type: salesforceObjectType,
				salesforce_object_id: salesforceObjectId,
				sapira_table_name: sapiraTableName,
				sapira_record_id: sapiraRecordId,
			});
		} catch (error: any) {
			this.logger.error(`Error creating mapping: ${error.message}`);
			throw error;
		}
	}

	async upsertProduct(productData: any): Promise<string> {
		try {
			const existing = await this.productRepository.findOne({
				where: {
					holding_id: productData.holding_id,
					product_code: productData.product_code,
				},
			});

			if (existing) {
				await this.productRepository.update(existing.id, productData);
				return existing.id;
			}

			const product = await this.productRepository.save(productData);
			return product.id;
		} catch (error: any) {
			this.logger.error(`Error upserting product: ${error.message}`);
			throw error;
		}
	}

	async upsertQuote(quoteData: any): Promise<string> {
		try {
			const existing = await this.quoteRepository.findOne({
				where: {
					holding_id: quoteData.holding_id,
					salesforce_opportunity_id: quoteData.salesforce_opportunity_id,
				},
			});

			if (existing) {
				await this.quoteRepository.update(existing.id, quoteData);
				return existing.id;
			}

			const quote = await this.quoteRepository.save(quoteData);
			return quote.id;
		} catch (error: any) {
			this.logger.error(`Error upserting quote: ${error.message}`);
			throw error;
		}
	}

	async deleteQuoteItems(quoteId: string): Promise<void> {
		try {
			await this.quoteItemRepository.delete({ quote_id: quoteId });
		} catch (error: any) {
			this.logger.error(`Error deleting quote items: ${error.message}`);
		}
	}

	async createQuoteItems(items: any[]): Promise<void> {
		if (items.length === 0) return;

		try {
			const quoteId = items[0].quote_id;
			const existingItems = await this.quoteItemRepository.find({
				where: { quote_id: quoteId },
			});
			const buildItemKey = (item: { quote_item_number?: string | null; salesforce_line_item_id?: string | null }) =>
				item.quote_item_number || item.salesforce_line_item_id || null;
			const existingByKey = new Map(existingItems.map((item) => [buildItemKey(item), item]));

			// Logging detallado de is_recurring antes de guardar
			items.forEach((item, idx) => {
				this.logger.debug(
					`💾 QuoteItem ${idx + 1}: product="${item.product_name}", is_recurring=${item.is_recurring} (type: ${typeof item.is_recurring})`
				);
			});

			const itemsToSave = items.map((item) => {
				const existing = existingByKey.get(buildItemKey(item));
				return existing ? { ...existing, ...item, id: existing.id } : item;
			});

			await this.quoteItemRepository.save(itemsToSave);

			const incomingKeys = new Set(items.map((item) => buildItemKey(item)).filter(Boolean));
			const itemsToRemove = existingItems.filter((item) => {
				const key = buildItemKey(item);
				return key && !incomingKeys.has(key);
			});

			if (itemsToRemove.length > 0) {
				const removalIds = itemsToRemove.map((item) => item.id);
				const linkedRows: Array<{ id: string; quote_item_number: string | null }> = await this.quoteItemRepository.query(
					`
						SELECT qi.id, qi.quote_item_number
						FROM quote_items qi
						INNER JOIN contract_items ci ON ci.quote_item_id = qi.id
						WHERE qi.id = ANY($1::uuid[])
					`,
					[removalIds]
				);

				if (linkedRows.length > 0) {
					const linkedIdentifiers = linkedRows
						.map((row) => row.quote_item_number || row.id)
						.slice(0, 5)
						.join(', ');
					throw new Error(
						`No se pueden eliminar quote_items vinculados a contract_items. Items afectados: ${linkedIdentifiers}`
					);
				}

				await this.quoteItemRepository.delete(removalIds);
			}

			this.logger.log(`✅ ${itemsToSave.length} quote items sincronizados exitosamente`);
		} catch (error: any) {
			this.logger.error(`Error creating quote items: ${error.message}`);
			throw error;
		}
	}

	async getQuoteStageByName(holdingId: string, stageName: string): Promise<string | null> {
		const stage = await this.quoteStageRepository.findOne({
			where: {
				holding_id: holdingId,
				name: ILike(`%${stageName}%`),
			},
		});

		return stage?.id || null;
	}

	async getFirstQuoteStage(holdingId: string): Promise<string | null> {
		const stage = await this.quoteStageRepository.findOne({
			where: { holding_id: holdingId },
			order: { position: 'ASC' },
		});

		return stage?.id || null;
	}

	async createClientContact(contactData: any): Promise<void> {
		try {
			await this.clientContactRepository.save(contactData);
		} catch (error: any) {
			if (!error.message.includes('duplicate')) {
				this.logger.error(`Error creating client contact: ${error.message}`);
			}
		}
	}

	async hasClientContact(clientId: string, contactType: string): Promise<boolean> {
		return Boolean(await this.getClientContact(clientId, contactType));
	}

	async getClientContact(clientId: string, contactType: string): Promise<ClientContact | null> {
		return this.clientContactRepository.findOne({
			where: { client_id: clientId, contact_type: contactType },
		});
	}

	async updateClientContact(contactId: string, contactData: Partial<ClientContact>): Promise<void> {
		await this.clientContactRepository.update(contactId, contactData);
	}

	async getClientByNumber(holdingId: string, clientNumber: string): Promise<string | null> {
		const client = await this.clientRepository.findOne({
			where: { holding_id: holdingId, client_number: clientNumber },
		});

		return client?.id || null;
	}

	async resolveClientEntitiesByTaxId(holdingId: string, taxId: string): Promise<ClientEntityTaxIdResolution> {
		const candidates = await this.clientEntityRepository.find({
			where: { holding_id: holdingId, tax_id: taxId },
			select: ['id', 'client_id', 'legal_name', 'tax_id', 'country', 'legal_address', 'economic_activity', 'client_number'],
		});

		return { entities: candidates };
	}

	async getDuplicateClientEntitiesTaxIds(
		holdingId: string,
		query: SalesforceDuplicateClientEntitiesQueryDto
	): Promise<SalesforceDuplicateClientEntitiesResponseDto> {
		const page = query.page || 1;
		const limit = query.limit || 50;
		const normalizedTaxId = `UPPER(NULLIF(REGEXP_REPLACE(entity.tax_id, '[[:space:].]+', '', 'g'), ''))`;
		const genericVatNormalization = `UPPER(NULLIF(REGEXP_REPLACE(generic_vat.vat, '[[:space:].]+', '', 'g'), ''))`;
		const duplicateGroupsQuery = this.clientEntityRepository
			.createQueryBuilder('entity')
			.where('entity.holding_id = :holdingId', { holdingId })
			.andWhere(`${normalizedTaxId} IS NOT NULL`)
			.andWhere(`
				NOT EXISTS (
					SELECT 1
					FROM generic_export_vats generic_vat
					WHERE generic_vat.is_active = true
						AND ${genericVatNormalization} = ${normalizedTaxId}
				)
			`)
			.groupBy(normalizedTaxId)
			.having('COUNT(*) > 1');
		const total = (await duplicateGroupsQuery.clone().select(normalizedTaxId, 'taxId').getRawMany()).length;
		const rows = await duplicateGroupsQuery
			.clone()
			.select(normalizedTaxId, 'taxId')
			.addSelect('COUNT(*)', 'count')
			.addSelect(
				`
					json_agg(
						json_build_object(
							'id', entity.id,
							'legalName', entity.legal_name,
							'clientId', entity.client_id,
							'country', entity.country
						)
						ORDER BY entity.id
					)
				`,
				'entities'
			)
			.orderBy(normalizedTaxId, 'ASC')
			.offset((page - 1) * limit)
			.limit(limit)
			.getRawMany();
		const items: SalesforceDuplicateTaxIdGroupDto[] = rows.map((row) => ({
			taxId: row.taxId,
			count: Number(row.count),
			entities: typeof row.entities === 'string' ? JSON.parse(row.entities) : row.entities,
		}));

		return {
			items,
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit) || 1,
		};
	}

	async createClientEntityClient(clientEntityId: string, clientId: string, holdingId: string): Promise<void> {
		try {
			const existing = await this.clientEntityClientRepository.findOne({
				where: { client_entity_id: clientEntityId, client_id: clientId },
			});

			if (existing) {
				await this.clientEntityClientRepository.update(existing.id, {
					holding_id: holdingId,
					is_primary: true,
				});
			} else {
				await this.clientEntityClientRepository.save({
					client_entity_id: clientEntityId,
					client_id: clientId,
					holding_id: holdingId,
					is_primary: true,
				});
			}
		} catch (error: any) {
			this.logger.error(`Error creating client_entity_client: ${error.message}`);
		}
	}

	async updateClientEntityClient(clientEntityId: string, clientId: string): Promise<void> {
		try {
			await this.clientEntityRepository.update(clientEntityId, { client_id: clientId });
		} catch (error: any) {
			this.logger.error(`Error updating client_entity: ${error.message}`);
		}
	}

	async getSellerByEmail(holdingId: string, email: string): Promise<string | null> {
		const seller = await this.sellerRepository.findOne({
			where: { holding_id: holdingId, email: email },
		});

		return seller?.id || null;
	}

	async getSellerByName(holdingId: string, name: string): Promise<string | null> {
		const seller = await this.sellerRepository.findOne({
			where: { holding_id: holdingId, name: name },
		});

		return seller?.id || null;
	}

	async createSeller(sellerData: any): Promise<string | null> {
		try {
			const seller = await this.sellerRepository.save(sellerData);
			return seller.id;
		} catch (error: any) {
			this.logger.error(`Error creating seller: ${error.message}`);
			return null;
		}
	}

	async getPrincipalContact(clientId: string): Promise<string | null> {
		const contact = await this.clientContactRepository.findOne({
			where: { client_id: clientId, contact_type: 'Principal' },
		});

		return contact?.id || null;
	}

	async getSalesforceProductMapping(
		holdingId: string,
		salesforceProductId: string
	): Promise<{ sapira_product_id: string; sapira_product_name: string } | null> {
		const mapping = await this.salesforceProductMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_product_id: salesforceProductId,
				is_active: true,
			},
		});

		if (!mapping) return null;

		return {
			sapira_product_id: mapping.sapira_product_id,
			sapira_product_name: mapping.sapira_product_name,
		};
	}
}
