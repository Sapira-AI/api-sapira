import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { IntegrationLog } from '@/databases/postgresql/entities/integration-log.entity';

import { StripeStagingController } from './controllers/stripe-staging.controller';
import { StripeSyncController } from './controllers/stripe-sync.controller';
import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeCustomersStg } from './entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from './entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from './entities/stripe-subscriptions-stg.entity';
import { StripeSyncJob } from './entities/stripe-sync-job.entity';
import { StripeStagingService } from './services/stripe-staging.service';
import { StripeSyncService } from './services/stripe-sync.service';
import { StripeConnectionController } from './stripe-connection.controller';
import { StripeConnectionService } from './stripe-connection.service';
import { StripeController } from './stripe.controller';
import { StripeProviders } from './stripe.provider';
import { StripeService } from './stripe.service';

@Module({
	imports: [
		ConfigModule,
		AuthModule,
		TypeOrmModule.forFeature([StripeConnection, StripeSubscriptionsStg, StripeCustomersStg, StripeInvoicesStg, StripeSyncJob, IntegrationLog]),
	],
	controllers: [StripeController, StripeConnectionController, StripeSyncController, StripeStagingController],
	providers: [StripeService, ...StripeProviders, StripeConnectionService, StripeSyncService, StripeStagingService],
	exports: [StripeService, StripeConnectionService, StripeSyncService, StripeStagingService],
})
export class StripeModule {}
