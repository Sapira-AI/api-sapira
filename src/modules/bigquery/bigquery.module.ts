import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { SapiraQuantityImport } from '@/databases/postgresql/entities/facturacion/sapira-quantity-import.entity';
import { BigQueryConnection } from '@/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity';
import { StripeCustomerBigQuery } from '@/databases/postgresql/entities/integraciones/stripe/stripe-customer-bigquery.entity';
import { NotificationsModule } from '@/modules/notifications/notifications.module';

import { BigQueryConnectionController } from './bigquery-connection.controller';
import { BigQueryController } from './bigquery.controller';
import { BigQueryProviders } from './bigquery.provider';
import { BigQueryScheduler } from './bigquery.scheduler';
import { BigQueryService } from './bigquery.service';

@Module({
	imports: [
		AuthModule,
		ScheduleModule.forRoot(),
		NotificationsModule,
		TypeOrmModule.forFeature([StripeCustomerBigQuery, CompanyHolding, BigQueryConnection, SapiraQuantityImport]),
	],
	controllers: [BigQueryController, BigQueryConnectionController],
	providers: [BigQueryService, BigQueryScheduler, ...BigQueryProviders],
	exports: [BigQueryService],
})
export class BigQueryModule {}
