import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { HoldingIntegrationSettings } from '@/databases/postgresql/entities/base-tenancy/holding-integration-settings.entity';
import { OdooConnection } from '@/databases/postgresql/entities/integraciones/odoo/odoo-connection.entity';
import { BigQueryConnection } from '@/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity';
import { SalesforceConnection } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-connection.entity';
import { StripeConnection } from '@/databases/postgresql/entities/integraciones/stripe/stripe-connection.entity';
import { BigQueryModule } from '@/modules/bigquery/bigquery.module';
import { ClientsModule } from '@/modules/clients/clients.module';
import { InvoicesModule } from '@/modules/invoices/invoices.module';
import { InvoiceSchedulerJob, InvoiceSchedulerJobSchema } from '@/modules/invoices/schemas/invoice-scheduler-job.schema';
import { OdooModule } from '@/modules/odoo/odoo.module';
import { SalesforceModule } from '@/modules/salesforce/salesforce.module';
import { SalesforceSchedulerJob, SalesforceSchedulerJobSchema } from '@/modules/salesforce/schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncLog, SalesforceSyncLogSchema } from '@/modules/salesforce/schemas/salesforce-sync-log.schema';
import { StripeIntegrationLog, StripeIntegrationLogSchema } from '@/modules/stripe/schemas/stripe-integration-log.schema';
import { StripeModule } from '@/modules/stripe/stripe.module';

import { CrmAdapter } from './adapters/crm.adapter';
import { DatosAdapter } from './adapters/datos.adapter';
import { ErpAdapter } from './adapters/erp.adapter';
import { StripeAdapter } from './adapters/stripe.adapter';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

/**
 * Integraciones v2 (`docs/v2-rediseno/contrato-api-integraciones.md`): un adaptador por tipo que reutiliza los servicios de su módulo
 * (`OdooModule`, `SalesforceModule`, `StripeModule`, `BigQueryModule`, `InvoicesModule` para el envío al ERP, `ClientsModule` para vincular razones sociales con el ERP). Los modelos de Mongo se
 * registran de nuevo con el mismo esquema (Nest reutiliza el modelo ya compilado en la conexión). Los guards vienen de `GuardsModule`
 * (global); `DataSource` y `ConfigService` son globales.
 */
@Module({
	imports: [
		PostgreSQLDatabaseModule,
		OdooModule,
		SalesforceModule,
		StripeModule,
		BigQueryModule,
		InvoicesModule,
		ClientsModule,
		TypeOrmModule.forFeature([OdooConnection, SalesforceConnection, StripeConnection, BigQueryConnection, HoldingIntegrationSettings]),
		MongooseModule.forFeature([
			{ name: InvoiceSchedulerJob.name, schema: InvoiceSchedulerJobSchema },
			{ name: SalesforceSchedulerJob.name, schema: SalesforceSchedulerJobSchema },
			{ name: SalesforceSyncLog.name, schema: SalesforceSyncLogSchema },
			{ name: StripeIntegrationLog.name, schema: StripeIntegrationLogSchema },
		]),
	],
	controllers: [IntegrationsController],
	providers: [IntegrationsService, ErpAdapter, CrmAdapter, StripeAdapter, DatosAdapter],
})
export class IntegrationsModule {}
