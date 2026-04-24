import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { StripeCustomerBigQuery } from '@/databases/postgresql/entities/stripe-customer-bigquery.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { BigQueryController } from './bigquery.controller';
import { BigQueryProviders } from './bigquery.provider';
import { BigQueryScheduler } from './bigquery.scheduler';
import { BigQueryService } from './bigquery.service';

@Module({
	imports: [AuthModule, ScheduleModule.forRoot(), TypeOrmModule.forFeature([StripeCustomerBigQuery, CompanyHolding])],
	controllers: [BigQueryController],
	providers: [BigQueryService, BigQueryScheduler, ...BigQueryProviders],
	exports: [BigQueryService],
})
export class BigQueryModule {}
