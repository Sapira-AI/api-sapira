import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '@/auth/auth.module';

import { BancoCentralController } from './banco-central.controller';
import { BancoCentralService } from './banco-central.service';
import { ExchangeRateMonthlyAvgEntity } from './entities/exchange-rate-monthly-avg.entity';
import { ExchangeRateEntity } from './entities/exchange-rate.entity';
import { IndicadorEconomicoEntity } from './entities/indicador-economico.entity';
import { ExchangeRatesService } from './services/exchange-rates.service';

@Module({
	imports: [TypeOrmModule.forFeature([IndicadorEconomicoEntity, ExchangeRateEntity, ExchangeRateMonthlyAvgEntity]), ConfigModule, AuthModule],
	controllers: [BancoCentralController],
	providers: [BancoCentralService, ExchangeRatesService],
	exports: [BancoCentralService, ExchangeRatesService],
})
export class BancoCentralModule {}
