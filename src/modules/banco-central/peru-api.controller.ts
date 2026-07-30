import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { GetExchangeRatesDto, ExchangeRateResponseDto } from './dtos/get-exchange-rates.dto';
import { SyncExchangeRatesDto, SyncExchangeRatesResponseDto } from './dtos/sync-exchange-rates.dto';
import { ExchangeRatesService } from './services/exchange-rates.service';

@ApiTags('Perú API')
@Controller('peru-api')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class PeruApiController {
	constructor(private readonly exchangeRatesService: ExchangeRatesService) {}

	@Get('exchange-rates/history')
	@ApiOperation({
		summary: 'Obtener historial USD/PEN desde Perú API',
		description: 'Retorna exclusivamente las cotizaciones USD/PEN almacenadas desde Perú API.',
	})
	async getExchangeRatesHistory(@Query() dto: GetExchangeRatesDto): Promise<ExchangeRateResponseDto[]> {
		const rates = await this.exchangeRatesService.getExchangeRates({
			...dto,
			fromCurrency: 'USD',
			toCurrency: 'PEN',
		});

		return rates.filter((rate) => rate.source_type === 'PERU_API');
	}

	@Post('exchange-rates/sync')
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: 'Sincronizar USD/PEN desde Perú API',
		description: 'Sincroniza únicamente USD/PEN desde Perú API usando la cotización de venta SUNAT.',
	})
	async syncExchangeRates(@Body() dto: SyncExchangeRatesDto): Promise<SyncExchangeRatesResponseDto> {
		return this.exchangeRatesService.syncExchangeRates({
			...dto,
			currencyPairs: ['USD/PEN'],
		});
	}
}
