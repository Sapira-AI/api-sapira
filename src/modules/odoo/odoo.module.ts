import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MongooseModules } from '@/databases/mongoose/database.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';
import { GenericExportVat } from '@/databases/postgresql/entities/generic-export-vat.entity';
import { EventsModule } from '@/events/events.module';

import { IntegrationLog } from '../../databases/postgresql/entities/integration-log.entity';

import { InvoiceItem } from '../invoices/entities/invoice-item.entity';
import { Invoice } from '../invoices/entities/invoice.entity';

import { Company } from './entities/companies.entity';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { OdooProductMapping } from './entities/odoo-product-mapping.entity';
import { Product } from './entities/products.entity';
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
import { FieldMappingService } from './services/field-mapping.service';
import { FieldTransformationService } from './services/field-transformation.service';
import { FiscalPositionsService } from './services/fiscal-positions.service';
import { GenericVatsService } from './services/generic-vats.service';
import { InvoiceTaxValidatorService } from './services/invoice-tax-validator.service';
import { PartnersProcessorService } from './services/partners-processor.service';
import { TaxMappingService } from './services/tax-mapping.service';

@Module({
	imports: [
		MongooseModules,
		PostgreSQLDatabaseModule,
		HttpModule,
		EventsModule,
		TypeOrmModule.forFeature([
			Company,
			OdooConnection,
			OdooInvoicesStg,
			OdooInvoiceLinesStg,
			OdooPartnersStg,
			Product,
			OdooProductMapping,
			IntegrationLog,
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
		TaxMappingService,
		InvoiceTaxValidatorService,
		GenericVatsService,
		InvoiceProcessingService,
	],
	exports: [OdooService, OdooInvoicesService, OdooConnectionService, FiscalPositionsService, TaxMappingService],
})
export class OdooModule {}
