import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MongooseModules } from '@/databases/mongoose/database.module';
import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { EventsModule } from '@/events/events.module';
import { ProfileModule } from '@/modules/profiles/profile.module';
import { WorkspaceModule } from '@/modules/workspaces/workspace.module';

import { IntegrationLog } from '../../databases/postgresql/entities/integration-log.entity';

import { Company } from './entities/companies.entity';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooInvoiceLinesStg } from './entities/odoo-invoice-lines-stg.entity';
import { OdooInvoicesStg } from './entities/odoo-invoices-stg.entity';
import { OdooPartnersStg } from './entities/odoo-partners-stg.entity';
import { Product } from './entities/products.entity';
import { OdooController } from './odoo.controller';
import { OdooProvider } from './odoo.provider';
import { OdooService } from './odoo.service';

@Module({
	imports: [
		MongooseModules,
		PostgreSQLDatabaseModule,
		HttpModule,
		EventsModule,
		ProfileModule,
		WorkspaceModule,
		TypeOrmModule.forFeature([Company, OdooConnection, OdooInvoicesStg, OdooInvoiceLinesStg, OdooPartnersStg, Product, IntegrationLog]),
	],
	controllers: [OdooController],
	providers: [OdooService, OdooProvider],
	exports: [OdooService],
})
export class OdooModule {}
