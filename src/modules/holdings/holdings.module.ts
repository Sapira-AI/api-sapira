import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseModule } from '@/databases/postgresql/database.module';
import { User } from '@/modules/users/entities/user.entity';

import { CompanyHolding } from './entities/company-holding.entity';
import { UserHolding } from './entities/user-holding.entity';
import { HoldingsController } from './holdings.controller';
import { HoldingsService } from './holdings.service';

@Module({
	imports: [PostgreSQLDatabaseModule, TypeOrmModule.forFeature([CompanyHolding, UserHolding, User])],
	controllers: [HoldingsController],
	providers: [HoldingsService],
	exports: [HoldingsService],
})
export class HoldingsModule {}
