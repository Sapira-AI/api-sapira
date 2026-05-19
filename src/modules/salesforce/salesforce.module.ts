import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IntegrationSalesforceConnection } from './entities/integration-salesforce-connection.entity';
import { IntegrationSalesforceFieldMapping } from './entities/integration-salesforce-field-mapping.entity';
import { IntegrationSalesforceMappingDetail } from './entities/integration-salesforce-mapping-detail.entity';
import { IntegrationSalesforceSyncRun } from './entities/integration-salesforce-sync-run.entity';
import { SalesforceConnection } from './entities/salesforce-connection.entity';
import { SalesforceOpportunityCache } from './entities/salesforce-opportunity-cache.entity';
import { SalesforceController } from './salesforce.controller';
import { SalesforceService } from './salesforce.service';
import { SalesforceAuthService } from './services/salesforce-auth.service';
import { SalesforceQueryService } from './services/salesforce-query.service';
import { SalesforceSoapService } from './services/salesforce-soap.service';
import { SalesforceSyncService } from './services/salesforce-sync.service';
import { SalesforceTokenService } from './services/salesforce-token.service';

@Module({
	imports: [
		HttpModule,
		TypeOrmModule.forFeature([
			SalesforceConnection,
			SalesforceOpportunityCache,
			IntegrationSalesforceConnection,
			IntegrationSalesforceFieldMapping,
			IntegrationSalesforceMappingDetail,
			IntegrationSalesforceSyncRun,
		]),
	],
	controllers: [SalesforceController],
	providers: [
		SalesforceService,
		SalesforceAuthService,
		SalesforceTokenService,
		SalesforceQueryService,
		SalesforceSyncService,
		SalesforceSoapService,
	],
	exports: [SalesforceService],
})
export class SalesforceModule {}
