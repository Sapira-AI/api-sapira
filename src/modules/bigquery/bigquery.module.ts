import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { StripeCustomerBigQuery } from '@/databases/postgresql/entities/stripe-customer-bigquery.entity';

import { BigQueryController } from './bigquery.controller';
import { BigQueryProviders } from './bigquery.provider';
import { BigQueryService } from './bigquery.service';

@Module({
	imports: [AuthModule, TypeOrmModule.forFeature([StripeCustomerBigQuery])],
	controllers: [BigQueryController],
	providers: [BigQueryService, ...BigQueryProviders],
	exports: [BigQueryService],
})
export class BigQueryModule {}
