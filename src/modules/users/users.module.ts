import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { HoldingsModule } from '@/modules/holdings/holdings.module';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
	imports: [PostgreSQLDatabaseModule, HoldingsModule, TypeOrmModule.forFeature([User])],
	controllers: [UsersController],
	providers: [UsersService],
	exports: [UsersService],
})
export class UsersModule {}
