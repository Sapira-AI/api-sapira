import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntityClient } from '@/databases/postgresql/entities/clientes/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { BigQueryModule } from '@/modules/bigquery/bigquery.module';

import { ClientsHoldingScopeGuard } from './access/clients-holding-scope.guard';
import { UserHoldingsService } from './access/user-holdings.service';
import { ClientContactsController } from './client-contacts.controller';
import { ClientDirectoryService } from './client-directory.service';
import { ClientEntitiesController } from './client-entities.controller';
import { ClientEntityMetricsService } from './client-entity-metrics.service';
import { ClientMetricsService } from './client-metrics.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { StripeClientsController } from './stripe-clients.controller';
import { StripeClientsService } from './stripe-clients.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([Client, ClientEntity, ClientEntityClient]), BigQueryModule],
	controllers: [ClientsController, ClientEntitiesController, ClientContactsController, StripeClientsController],
	providers: [
		UserHoldingsService,
		ClientsHoldingScopeGuard,
		ClientsService,
		ClientMetricsService,
		ClientEntityMetricsService,
		ClientDirectoryService,
		StripeClientsService,
	],
	exports: [ClientsService, StripeClientsService],
})
export class ClientsModule {}
