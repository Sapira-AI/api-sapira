import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';

import { CompanyHolding } from './entities/company-holding.entity';
import { UserHolding } from './entities/user-holding.entity';
import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([CompanyHolding, UserHolding])],
	controllers: [HoldingsController],
	providers: [HoldingsService],
	exports: [HoldingsService],
})
export class HoldingsModule {}
