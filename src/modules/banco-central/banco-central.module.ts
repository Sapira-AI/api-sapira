import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';
import { EmailsModule } from '@/modules/emails/emails.module';

import { BancoCentralController } from './banco-central.controller';
import { BancoCentralService } from './banco-central.service';
import { ExchangeRateMonthlyAvgEntity } from './entities/exchange-rate-monthly-avg.entity';
import { ExchangeRateEntity } from './entities/exchange-rate.entity';
import { IndicadorEconomicoEntity } from './entities/indicador-economico.entity';
import { ExchangeRatesScheduler } from './exchange-rates.scheduler';
import { ExchangeRatesNotificationService } from './services/exchange-rates-notification.service';
import { ExchangeRatesService } from './services/exchange-rates.service';

@Module({
	imports: [
		TypeOrmModule.forFeature([IndicadorEconomicoEntity, ExchangeRateEntity, ExchangeRateMonthlyAvgEntity]),
		ConfigModule,
		AuthModule,
		EmailsModule,
	],
	controllers: [BancoCentralController],
	providers: [BancoCentralService, ExchangeRatesService, ExchangeRatesNotificationService, ExchangeRatesScheduler],
	exports: [BancoCentralService, ExchangeRatesService],
})
export class BancoCentralModule {}
