import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { Product } from '@/modules/odoo/entities/products.entity';

import { ClientContact } from '../entities/client-contact.entity';
import { MasterData } from '../entities/master-data.entity';
import { QuoteItem } from '../entities/quote-item.entity';
import { QuoteStage } from '../entities/quote-stage.entity';
import { Quote } from '../entities/quote.entity';
import { SalesforceObjectMapping } from '../entities/salesforce-object-mapping.entity';
import { Seller } from '../entities/seller.entity';

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
		private readonly clientEntityClientRepository: Repository<ClientEntityClient>
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
			await this.quoteItemRepository.save(items);
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
		const contact = await this.clientContactRepository.findOne({
			where: { client_id: clientId, contact_type: contactType },
		});

		return !!contact;
	}

	async getSellerBySalesforceId(holdingId: string, salesforceUserId: string): Promise<string | null> {
		const seller = await this.sellerRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_user_id: salesforceUserId,
			},
		});

		return seller?.id || null;
	}

	async getClientByNumber(holdingId: string, clientNumber: string): Promise<string | null> {
		const client = await this.clientRepository.findOne({
			where: { holding_id: holdingId, client_number: clientNumber },
		});

		return client?.id || null;
	}

	async getClientEntityByTaxId(holdingId: string, taxId: string): Promise<any | null> {
		const clientEntity = await this.clientEntityRepository.findOne({
			where: { holding_id: holdingId, tax_id: taxId },
			select: ['id', 'client_id', 'legal_name'],
		});

		return clientEntity || null;
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
}
