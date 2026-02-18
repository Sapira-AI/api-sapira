import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '@/auth/auth.module';

import { StripeController } from './stripe.controller';
import { StripeProviders } from './stripe.provider';
import { StripeService } from './stripe.service';

@Module({
	imports: [ConfigModule, AuthModule],
	controllers: [StripeController],
	providers: [StripeService, ...StripeProviders],
	exports: [StripeService],
})
export class StripeModule {}
