import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { ClientEntityClient } from '@/databases/postgresql/entities/client-entity-client.entity';
import { ClientEntity } from '@/databases/postgresql/entities/client-entity.entity';
import { Client } from '@/databases/postgresql/entities/client.entity';

import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([Client, ClientEntity, ClientEntityClient])],
	controllers: [ClientsController],
	providers: [ClientsService],
	exports: [ClientsService],
})
export class ClientsModule {}
