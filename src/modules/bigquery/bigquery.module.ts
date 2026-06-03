import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { BigQueryConnection } from '@/databases/postgresql/entities/bigquery-connection.entity';
import { StripeCustomerBigQuery } from '@/databases/postgresql/entities/stripe-customer-bigquery.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { BigQueryConnectionController } from './bigquery-connection.controller';
import { BigQueryController } from './bigquery.controller';
import { BigQueryProviders } from './bigquery.provider';
import { BigQueryScheduler } from './bigquery.scheduler';
import { BigQueryService } from './bigquery.service';

@Module({
	imports: [AuthModule, ScheduleModule.forRoot(), TypeOrmModule.forFeature([StripeCustomerBigQuery, CompanyHolding, BigQueryConnection])],
	controllers: [BigQueryController, BigQueryConnectionController],
	providers: [BigQueryService, BigQueryScheduler, ...BigQueryProviders],
	exports: [BigQueryService],
})
export class BigQueryModule {}
