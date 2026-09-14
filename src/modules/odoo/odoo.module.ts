import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MongooseModules } from '@/databases/mongoose/database.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { Company } from '@/databases/postgresql/entities/base-tenancy/companies.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { InvoiceItem } from '@/databases/postgresql/entities/facturacion/invoice-item.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';
import { GenericExportVat } from '@/databases/postgresql/entities/fx/generic-export-vat.entity';
import { OdooConnection } from '@/databases/postgresql/entities/integraciones/odoo/odoo-connection.entity';
import { OdooInvoiceLinesStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-invoices-stg.entity';
import { OdooPartnersStg } from '@/databases/postgresql/entities/integraciones/odoo/odoo-partners-stg.entity';
import { OdooProductMapping } from '@/databases/postgresql/entities/integraciones/odoo/odoo-product-mapping.entity';
import { FieldMapping } from '@/databases/postgresql/entities/integraciones/otras/field-mapping.entity';
import { EventsModule } from '@/events/events.module';

import { FiscalPositionsController } from './fiscal-positions.controller';
import { InvoiceProcessingController } from './invoice-processing.controller';
import { InvoiceProcessingService } from './invoice-processing.service';
import { InvoiceTaxValidatorController } from './invoice-tax-validator.controller';
import { OdooConnectionController } from './odoo-connection.controller';
import { OdooConnectionService } from './odoo-connection.service';
import { OdooInvoicesController } from './odoo-invoices.controller';
import { OdooInvoicesService } from './odoo-invoices.service';
import { OdooPartnersController } from './odoo-partners.controller';
import { OdooPartnersService } from './odoo-partners.service';
import { OdooWebhookController } from './odoo-webhook.controller';
import { OdooWebhookService } from './odoo-webhook.service';
import { OdooController } from './odoo.controller';
import { OdooProvider } from './odoo.provider';
import { OdooService } from './odoo.service';
import { OdooIntegrationLog, OdooIntegrationLogSchema } from './schemas/odoo-integration-log.schema';
import { DocumentTypeMappingService } from './services/document-type-mapping.service';
import { FieldMappingService } from './services/field-mapping.service';
import { FieldTransformationService } from './services/field-transformation.service';
import { FiscalPositionsService } from './services/fiscal-positions.service';
import { GenericVatsService } from './services/generic-vats.service';
import { InvoiceTaxValidatorService } from './services/invoice-tax-validator.service';
import { OdooIntegrationLogService } from './services/odoo-integration-log.service';
import { PartnersProcessorService } from './services/partners-processor.service';
import { TaxMappingService } from './services/tax-mapping.service';

@Module({
	imports: [
		MongooseModules,
		PostgreSQLDatabaseModule,
		HttpModule,
		EventsModule,
		MongooseModule.forFeature([{ name: OdooIntegrationLog.name, schema: OdooIntegrationLogSchema }]),
		TypeOrmModule.forFeature([
			Company,
			OdooConnection,
			OdooInvoicesStg,
			OdooInvoiceLinesStg,
			OdooPartnersStg,
			Product,
			OdooProductMapping,
			ClientEntity,
			FieldMapping,
			GenericExportVat,
			Invoice,
			InvoiceItem,
		]),
	],
	controllers: [
		OdooController,
		OdooConnectionController,
		OdooInvoicesController,
		OdooWebhookController,
		OdooPartnersController,
		InvoiceProcessingController,
		FiscalPositionsController,
		InvoiceTaxValidatorController,
	],
	providers: [
		OdooService,
		OdooConnectionService,
		OdooInvoicesService,
		OdooWebhookService,
		OdooPartnersService,
		OdooProvider,
		PartnersProcessorService,
		FieldTransformationService,
		FieldMappingService,
		FiscalPositionsService,
		DocumentTypeMappingService,
		TaxMappingService,
		InvoiceTaxValidatorService,
		GenericVatsService,
		InvoiceProcessingService,
		OdooIntegrationLogService,
	],
	exports: [
		OdooService,
		OdooInvoicesService,
		OdooConnectionService,
		OdooPartnersService,
		FiscalPositionsService,
		TaxMappingService,
		DocumentTypeMappingService,
	],
})
export class OdooModule {}
