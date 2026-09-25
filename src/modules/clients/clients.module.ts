import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntityClient } from '@/databases/postgresql/entities/clientes/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/clientes/client.entity';
import { BigQueryModule } from '@/modules/bigquery/bigquery.module';
import { MetricsModule } from '@/modules/metrics/metrics.module';

import { ClientActivityService } from './client-activity.service';
import { ClientContactsController } from './client-contacts.controller';
import { ClientDirectoryService } from './client-directory.service';
import { ClientDocumentsController } from './client-documents.controller';
import { ClientDocumentsService } from './client-documents.service';
import { ClientEntitiesController } from './client-entities.controller';
import { ClientEntityMetricsService } from './client-entity-metrics.service';
import { ClientMetricsService } from './client-metrics.service';
import { ClientQuotesService } from './client-quotes.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { ClientFilesStorageService } from './storage/client-files-storage.service';
import { StripeClientsController } from './stripe-clients.controller';
import { StripeClientsService } from './stripe-clients.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([Client, ClientEntity, ClientEntityClient]), BigQueryModule, MetricsModule],
	controllers: [ClientsController, ClientEntitiesController, ClientContactsController, StripeClientsController, ClientDocumentsController],
	providers: [
		ClientsService,
		ClientMetricsService,
		ClientQuotesService,
		ClientActivityService,
		ClientDocumentsService,
		ClientFilesStorageService,
		ClientEntityMetricsService,
		ClientDirectoryService,
		StripeClientsService,
	],
	exports: [ClientsService, StripeClientsService],
})
export class ClientsModule {}
