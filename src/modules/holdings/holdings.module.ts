import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { UserHolding } from '@/databases/postgresql/entities/base-tenancy/user-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([CompanyHolding, UserHolding, User])],
	controllers: [HoldingsController],
	providers: [HoldingsService],
	exports: [HoldingsService],
})
export class HoldingsModule {}
