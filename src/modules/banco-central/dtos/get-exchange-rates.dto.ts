import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class GetExchangeRatesDto {
	@IsOptional()
	@IsString()
	fromCurrency?: string;

	@IsOptional()
	@IsString()
	toCurrency?: string;

	@IsOptional()
	@IsDateString()
	startDate?: string;

	@IsOptional()
	@IsDateString()
	endDate?: string;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	limit?: number = 100;
}

export class GetLatestExchangeRatesDto {
	@IsOptional()
	@IsString()
	fromCurrency?: string;

	@IsOptional()
	@IsString()
	toCurrency?: string;
}

export class ExchangeRateResponseDto {
	rate_date: Date;
	from_currency: string;
	to_currency: string;
	rate: number;
	source_type: string;
	api_source?: string;
	is_indirect_conversion: boolean;
	conversion_chain?: Record<string, any>;
}

export class MonthlyAvgResponseDto {
	from_currency: string;
	to_currency: string;
	year: number;
	month: number;
	avg_rate: number;
	min_rate: number;
	max_rate: number;
	data_points: number;
	calculated_at: Date;
}
