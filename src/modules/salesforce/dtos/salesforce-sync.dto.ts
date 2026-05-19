import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export enum SyncType {
	DELTA = 'delta',
	FULL = 'full',
}

export class SalesforceSyncDto {
	@ApiProperty({
		description: 'Fecha desde (formato YYYY-MM-DD)',
		example: '2024-01-01',
		required: false,
	})
	@IsOptional()
	@IsDateString()
	dateFrom?: string;

	@ApiProperty({
		description: 'Fecha hasta (formato YYYY-MM-DD)',
		example: '2024-01-31',
		required: false,
	})
	@IsOptional()
	@IsDateString()
	dateTo?: string;

	@ApiProperty({
		description: 'Tipo de sincronización',
		enum: SyncType,
		example: SyncType.DELTA,
		required: false,
	})
	@IsOptional()
	@IsEnum(SyncType)
	syncType?: SyncType;
}
