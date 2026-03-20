import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';
import { BigQueryModule } from '@/modules/bigquery/bigquery.module';

import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { StripeClientsController } from './stripe-clients.controller';
import { StripeClientsService } from './stripe-clients.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([Client, ClientEntity, ClientEntityClient]), BigQueryModule],
	controllers: [ClientsController, StripeClientsController],
	providers: [ClientsService, StripeClientsService],
	exports: [ClientsService, StripeClientsService],
})
export class ClientsModule {}
