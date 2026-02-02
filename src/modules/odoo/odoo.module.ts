import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MongooseModules } from '@/databases/mongoose/database.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';
import { EventsModule } from '@/events/events.module';

import { IntegrationLog } from '../../databases/postgresql/entities/integration-log.entity';

import { Company } from './entities/companies.entity';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { Product } from './entities/products.entity';
import { OdooConnectionController } from './odoo-connection.controller';
import { OdooConnectionService } from './odoo-connection.service';
import { OdooController } from './odoo.controller';
import { OdooProvider } from './odoo.provider';
import { OdooService } from './odoo.service';
import { PartnersController } from './partners.controller';
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
			IntegrationLog,
			ClientEntity,
			FieldMapping,
		]),
	],
	controllers: [OdooController, OdooConnectionController, PartnersController],
	providers: [OdooService, OdooConnectionService, OdooProvider, PartnersProcessorService],
	exports: [OdooService],
})
export class OdooModule {}
