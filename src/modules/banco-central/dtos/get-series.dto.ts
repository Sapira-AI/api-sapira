import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional } from 'class-validator';

import { IndicadorEconomico } from '../interfaces/banco-central.interface';

export class GetSeriesDto {
	@ApiProperty({
		description: 'Código de la serie a consultar',
		enum: IndicadorEconomico,
		example: IndicadorEconomico.UF,
	})
	@IsEnum(IndicadorEconomico)
	@IsNotEmpty()
	timeseries: IndicadorEconomico;

	@ApiPropertyOptional({
		description: 'Fecha desde la cual se requiere recoger datos (YYYY-MM-DD)',
		example: '2026-01-01',
	})
	@IsOptional()
	@IsDateString()
	firstdate?: string;

	@ApiPropertyOptional({
		description: 'Fecha hasta la cual se requiere recoger datos (YYYY-MM-DD)',
		example: '2026-01-31',
	})
	@IsOptional()
	@IsDateString()
	lastdate?: string;
}
