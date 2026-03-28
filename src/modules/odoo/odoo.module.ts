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

import { Company } from './entities/companies.entity';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { OdooProductMapping } from './entities/odoo-product-mapping.entity';
import { Product } from './entities/products.entity';
import { InvoiceProcessingController } from './invoice-processing.controller';
import { InvoiceProcessingService } from './invoice-processing.service';
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
import { GenericVatsService } from './services/generic-vats.service';
import { PartnersProcessorService } from './services/partners-processor.service';

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
		]),
	],
	controllers: [
		OdooController,
		OdooConnectionController,
		OdooInvoicesController,
		OdooWebhookController,
		OdooPartnersController,
		InvoiceProcessingController,
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
		GenericVatsService,
		InvoiceProcessingService,
	],
	exports: [OdooService, OdooInvoicesService, OdooConnectionService],
})
export class OdooModule {}
