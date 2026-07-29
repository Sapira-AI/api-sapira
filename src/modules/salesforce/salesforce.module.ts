import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EncryptionService } from '@/common/services/encryption.service';
import { GenericVatsService } from '@/common/services/generic-vats.service';
import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { GenericExportVat } from '@/databases/postgresql/entities/generic-export-vat.entity';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { OdooModule } from '@/modules/odoo/odoo.module';
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
import { SalesforceAccountsStg } from './entities/salesforce-accounts-stg.entity';
import { SalesforceConnection } from './entities/salesforce-connection.entity';
import { SalesforceFieldMapping } from './entities/salesforce-field-mapping.entity';
import { SalesforceLineItemsStg } from './entities/salesforce-line-items-stg.entity';
import { SalesforceObjectMapping } from './entities/salesforce-object-mapping.entity';
import { SalesforceOpportunitiesStg } from './entities/salesforce-opportunities-stg.entity';
import { SalesforceOpportunityCache } from './entities/salesforce-opportunity-cache.entity';
import { SalesforceProductMapping } from './entities/salesforce-product-mapping.entity';
import { SalesforceQuoteTypeMapping } from './entities/salesforce-quote-type-mapping.entity';
import { SalesforceSyncRunItem } from './entities/salesforce-sync-run-item.entity';
import { SalesforceSyncRun } from './entities/salesforce-sync-run.entity';
import { Seller } from './entities/seller.entity';
import { SalesforceMappingController } from './salesforce-mapping.controller';
import { SalesforceStagingController } from './salesforce-staging.controller';
import { SalesforceController } from './salesforce.controller';
import { SalesforceScheduler } from './salesforce.scheduler';
import { SalesforceService } from './salesforce.service';
import { SalesforceSchedulerJob, SalesforceSchedulerJobSchema } from './schemas/salesforce-scheduler-job.schema';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceFieldMappingEngineService } from './services/salesforce-field-mapping-engine.service';
import { SalesforceMappingService } from './services/salesforce-mapping.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceStagingService } from './services/salesforce-staging.service';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from './services/salesforce-sync-run.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';
import { SalesforceTypeOrmService } from './services/salesforce-typeorm.service';
import { SalesforceSyncRunWorker } from './salesforce-sync-run.worker';

@Module({
	imports: [
		HttpModule,
		OdooModule,
		NotificationsModule,
		ScheduleModule.forRoot(),
		MongooseModule.forFeature([{ name: SalesforceSchedulerJob.name, schema: SalesforceSchedulerJobSchema }]),
		TypeOrmModule.forFeature([
			SalesforceConnection,
			SalesforceFieldMapping,
			SalesforceAccountsStg,
			SalesforceOpportunitiesStg,
			SalesforceLineItemsStg,
			SalesforceOpportunityCache,
			SalesforceProductMapping,
			SalesforceQuoteTypeMapping,
			SalesforceSyncRun,
			SalesforceSyncRunItem,
			SalesforceObjectMapping,
			IntegrationSalesforceConnection,
			IntegrationSalesforceFieldMapping,
			IntegrationSalesforceMappingDetail,
			IntegrationSalesforceSyncRun,
			Client,
			ClientEntity,
			ClientEntityClient,
			GenericExportVat,
			Product,
			MasterData,
			Quote,
			QuoteItem,
			QuoteStage,
			ClientContact,
			Seller,
		]),
	],
	controllers: [SalesforceController, SalesforceMappingController, SalesforceStagingController],
	providers: [
		SalesforceService,
		SalesforceAuthService,
		SalesforceTokenService,
		SalesforceQueryService,
		SalesforceSyncService,
		SalesforceSyncCompleteService,
			SalesforceSyncRunService,
			SalesforceSyncRunWorker,
		SalesforceStagingService,
		SalesforceSoapService,
		SalesforceTypeOrmService,
		SalesforceMappingService,
		SalesforceFieldMappingEngineService,
		GenericVatsService,
		SalesforceScheduler,
		EncryptionService,
	],
	exports: [SalesforceService, SalesforceMappingService],
})
export class SalesforceModule {}
