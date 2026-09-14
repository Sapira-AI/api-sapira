import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { Product } from '@/databases/postgresql/entities/cotizaciones-catalogo/products.entity';
import { StripeConnection } from '@/databases/postgresql/entities/integraciones/stripe/stripe-connection.entity';
import { StripeCustomersStg } from '@/databases/postgresql/entities/integraciones/stripe/stripe-customers-stg.entity';
import { StripeInvoicesStg } from '@/databases/postgresql/entities/integraciones/stripe/stripe-invoices-stg.entity';
import { StripeProductMapping } from '@/databases/postgresql/entities/integraciones/stripe/stripe-product-mapping.entity';
import { StripeSubscriptionsStg } from '@/databases/postgresql/entities/integraciones/stripe/stripe-subscriptions-stg.entity';
import { StripeSyncJob } from '@/databases/postgresql/entities/integraciones/stripe/stripe-sync-job.entity';

import { StripeStagingController } from './controllers/stripe-staging.controller';
import { StripeSyncController } from './controllers/stripe-sync.controller';
import { StripeIntegrationLog, StripeIntegrationLogSchema } from './schemas/stripe-integration-log.schema';
import { StripeIntegrationLogService } from './services/stripe-integration-log.service';
import { StripeStagingService } from './services/stripe-staging.service';
import { StripeSyncService } from './services/stripe-sync.service';
import { StripeConnectionController } from './stripe-connection.controller';
import { StripeConnectionService } from './stripe-connection.service';
import { StripeIngestionController } from './stripe-ingestion.controller';
import { StripeIngestionService } from './stripe-ingestion.service';
import { StripeInitService } from './stripe-init.service';
import { StripeController } from './stripe.controller';
import { StripeProviders } from './stripe.provider';
import { StripeScheduler } from './stripe.scheduler';
import { StripeService } from './stripe.service';

@Module({
	imports: [
		ConfigModule,
		AuthModule,
		TypeOrmModule.forFeature([
			StripeConnection,
			StripeSubscriptionsStg,
			StripeCustomersStg,
			StripeInvoicesStg,
			StripeSyncJob,
			Product,
			StripeProductMapping,
		]),
		MongooseModule.forFeature([{ name: StripeIntegrationLog.name, schema: StripeIntegrationLogSchema }]),
	],
	controllers: [StripeController, StripeConnectionController, StripeIngestionController, StripeSyncController, StripeStagingController],
	providers: [
		StripeService,
		...StripeProviders,
		StripeConnectionService,
		StripeIngestionService,
		StripeIntegrationLogService,
		StripeSyncService,
		StripeStagingService,
		StripeScheduler,
		StripeInitService,
	],
	exports: [StripeService, StripeConnectionService, StripeIngestionService, StripeSyncService, StripeStagingService],
})
export class StripeModule {}
