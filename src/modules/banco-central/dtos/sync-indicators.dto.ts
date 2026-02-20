import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class SyncIndicatorsDto {
	@ApiPropertyOptional({
		description: 'Fecha desde la cual sincronizar datos (YYYY-MM-DD). Por defecto: hace 30 días',
		example: '2026-01-01',
	})
	@IsOptional()
	@IsDateString()
	firstdate?: string;

	@ApiPropertyOptional({
		description: 'Fecha hasta la cual sincronizar datos (YYYY-MM-DD). Por defecto: hoy',
		example: '2026-01-31',
	})
	@IsOptional()
	@IsDateString()
	lastdate?: string;
}
