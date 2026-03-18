import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';

import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeCustomersStg } from './entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from './entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from './entities/stripe-subscriptions-stg.entity';
import { StripeConnectionController } from './stripe-connection.controller';
import { StripeConnectionService } from './stripe-connection.service';
import { StripeSyncController } from './stripe-sync.controller';
import { StripeSyncService } from './stripe-sync.service';
import { StripeController } from './stripe.controller';
import { StripeProviders } from './stripe.provider';
import { StripeService } from './stripe.service';

@Module({
	imports: [ConfigModule, AuthModule, TypeOrmModule.forFeature([StripeConnection, StripeSubscriptionsStg, StripeCustomersStg, StripeInvoicesStg])],
	controllers: [StripeController, StripeConnectionController, StripeSyncController],
	providers: [StripeService, ...StripeProviders, StripeConnectionService, StripeSyncService],
	exports: [StripeService, StripeConnectionService, StripeSyncService],
})
export class StripeModule {}
