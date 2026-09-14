import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EncryptionService } from '@/common/services/encryption.service';
import { GenericVatsService } from '@/common/services/generic-vats.service';
import { MasterData } from '@/databases/postgresql/entities/base-tenancy/master-data.entity';
import { UserHolding } from '@/databases/postgresql/entities/base-tenancy/user-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { ClientContact } from '@/databases/postgresql/entities/clientes/client-contact.entity';
import { ClientEntityClient } from '@/databases/postgresql/entities/clientes/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { Seller } from '@/databases/postgresql/entities/clientes/seller.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { QuoteItem } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote-item.entity';
import { QuoteStage } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote-stage.entity';
import { Quote } from '@/databases/postgresql/entities/cotizaciones-catalogo/quote.entity';
import { GenericExportVat } from '@/databases/postgresql/entities/fx/generic-export-vat.entity';
import { SalesforceAccountsStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-accounts-stg.entity';
import { SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { SalesforceFieldMapping } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-field-mapping.entity';
import { SalesforceLineItemsStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-line-items-stg.entity';
import { SalesforceObjectMapping } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-object-mapping.entity';
import { SalesforceOpportunitiesStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunities-stg.entity';
import { SalesforceOpportunityCache } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunity-cache.entity';
import { SalesforceProductMapping } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-product-mapping.entity';
import { SalesforceQuoteTypeMapping } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-quote-type-mapping.entity';
import { SalesforceSyncRunItem } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-sync-run-item.entity';
import { SalesforceSyncRun } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-sync-run.entity';
import { GuardsModule } from '@/guards/guards.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { OdooModule } from '@/modules/odoo/odoo.module';

import { SalesforceMappingController } from './salesforce-mapping.controller';
import { SalesforceStagingController } from './salesforce-staging.controller';
import { SalesforceSyncLogController } from './salesforce-sync-log.controller';
import { SalesforceSyncRunWorker } from './salesforce-sync-run.worker';
import { SalesforceController } from './salesforce.controller';
import { SalesforceScheduler } from './salesforce.scheduler';
import { SalesforceService } from './salesforce.service';
import { SalesforceSchedulerJob, SalesforceSchedulerJobSchema } from './schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog, SalesforceSyncLogSchema } from './schemas/salesforce-sync-log.schema';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceFieldMappingEngineService } from './services/salesforce-field-mapping-engine.service';
import { SalesforceMappingService } from './services/salesforce-mapping.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceStagingService } from './services/salesforce-staging.service';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncLogService } from './services/salesforce-sync-log.service';
import { SalesforceSyncRunService } from './services/salesforce-sync-run.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';
import { SalesforceTypeOrmService } from './services/salesforce-typeorm.service';

@Module({
	imports: [
		HttpModule,
		GuardsModule,
		OdooModule,
		NotificationsModule,
		MongooseModule.forFeature([
			{ name: SalesforceSchedulerJob.name, schema: SalesforceSchedulerJobSchema },
			{ name: SalesforceSyncLog.name, schema: SalesforceSyncLogSchema },
		]),
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
			UserHolding,
			User,
		]),
	],
	controllers: [SalesforceController, SalesforceMappingController, SalesforceStagingController, SalesforceSyncLogController],
	providers: [
		SalesforceService,
		SalesforceAuthService,
		SalesforceTokenService,
		SalesforceQueryService,
		SalesforceSyncService,
		SalesforceSyncCompleteService,
		SalesforceSyncLogService,
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
