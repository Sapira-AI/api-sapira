import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { Currency } from '@/databases/postgresql/entities/base-tenancy/currency.entity';
import { ExchangeRateMonthlyAvgEntity } from '@/databases/postgresql/entities/fx/exchange-rate-monthly-avg.entity';
import { ExchangeRateEntity } from '@/databases/postgresql/entities/fx/exchange-rate.entity';
import { IndicadorEconomicoEntity } from '@/databases/postgresql/entities/fx/indicador-economico.entity';
import { EmailsModule } from '@/modules/emails/emails.module';

import { BancoCentralController } from './banco-central.controller';
import { BancoCentralService } from './banco-central.service';
import { ExchangeRatesScheduler } from './exchange-rates.scheduler';
import { PeruApiController } from './peru-api.controller';
import { BancoCentralSchemaService } from './services/banco-central-schema.service';
import { ExchangeRatesNotificationService } from './services/exchange-rates-notification.service';
import { ExchangeRatesService } from './services/exchange-rates.service';

@Module({
	imports: [
		TypeOrmModule.forFeature([IndicadorEconomicoEntity, ExchangeRateEntity, ExchangeRateMonthlyAvgEntity, Currency]),
		ConfigModule,
		AuthModule,
		EmailsModule,
	],
	controllers: [BancoCentralController, PeruApiController],
	providers: [BancoCentralService, BancoCentralSchemaService, ExchangeRatesService, ExchangeRatesNotificationService, ExchangeRatesScheduler],
	exports: [BancoCentralService, ExchangeRatesService],
})
export class BancoCentralModule {}
