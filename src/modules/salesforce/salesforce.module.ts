import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EncryptionService } from '@/common/services/encryption.service';
import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { Product } from '@/modules/odoo/entities/products.entity';

import { ClientContact } from './entities/client-contact.entity';
import { IntegrationSalesforceConnection } from './entities/integration-salesforce-connection.entity';
import { IntegrationSalesforceFieldMapping } from './entities/integration-salesforce-field-mapping.entity';
import { IntegrationSalesforceMappingDetail } from './entities/integration-salesforce-mapping-detail.entity';
import { IntegrationSalesforceSyncRun } from './entities/integration-salesforce-sync-run.entity';
import { MasterData } from './entities/master-data.entity';
import { QuoteItem } from './entities/quote-item.entity';
import { QuoteStage } from './entities/quote-stage.entity';
import { Quote } from './entities/quote.entity';
import { SalesforceConnection } from './entities/salesforce-connection.entity';
import { SalesforceObjectMapping } from './entities/salesforce-object-mapping.entity';
import { SalesforceOpportunityCache } from './entities/salesforce-opportunity-cache.entity';
import { SalesforceProductMapping } from './entities/salesforce-product-mapping.entity';
import { SalesforceQuoteTypeMapping } from './entities/salesforce-quote-type-mapping.entity';
import { Seller } from './entities/seller.entity';
import { SalesforceMappingController } from './salesforce-mapping.controller';
import { SalesforceController } from './salesforce.controller';
import { SalesforceScheduler } from './salesforce.scheduler';
import { SalesforceService } from './salesforce.service';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceMappingService } from './services/salesforce-mapping.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';
import { SalesforceTypeOrmService } from './services/salesforce-typeorm.service';

@Module({
	imports: [
		HttpModule,
		ScheduleModule.forRoot(),
		TypeOrmModule.forFeature([
			SalesforceConnection,
			SalesforceOpportunityCache,
			SalesforceProductMapping,
			SalesforceQuoteTypeMapping,
			SalesforceObjectMapping,
			IntegrationSalesforceConnection,
			IntegrationSalesforceFieldMapping,
			IntegrationSalesforceMappingDetail,
			IntegrationSalesforceSyncRun,
			Client,
			ClientEntity,
			ClientEntityClient,
			Product,
			MasterData,
			Quote,
			QuoteItem,
			QuoteStage,
			ClientContact,
			Seller,
		]),
	],
	controllers: [SalesforceController, SalesforceMappingController],
	providers: [
		SalesforceService,
		SalesforceAuthService,
		SalesforceTokenService,
		SalesforceQueryService,
		SalesforceSyncService,
		SalesforceSyncCompleteService,
		SalesforceSoapService,
		SalesforceTypeOrmService,
		SalesforceMappingService,
		SalesforceScheduler,
		EncryptionService,
	],
	exports: [SalesforceService, SalesforceMappingService],
})
export class SalesforceModule {}
