import { IsArray, IsDateString, IsOptional, IsString } from 'class-validator';

export class SyncExchangeRatesDto {
	@IsDateString()
	startDate: string;

	@IsDateString()
	endDate: string;

	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	currencyPairs?: string[];
}

export class SyncExchangeRatesResponseDto {
	success: boolean;
	message: string;
	stats: {
		totalProcessed: number;
		inserted: number;
		updated: number;
		errors: number;
		indirectConversions: number;
	};
	monthlyAveragesCalculated?: {
		periods: number;
		currencyPairs: number;
	};
}
