import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class CalculateMonthlyAvgDto {
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(2020)
	@Max(2100)
	year?: number;

	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(12)
	month?: number;
}

export class CalculateMonthlyAvgResponseDto {
	success: boolean;
	message: string;
	stats: {
		periodsProcessed: number;
		currencyPairsProcessed: number;
		recordsCreated: number;
		recordsUpdated: number;
	};
}
