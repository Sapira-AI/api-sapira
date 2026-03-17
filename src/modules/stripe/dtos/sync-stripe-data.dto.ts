import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class SyncStripeDataDto {
	@ApiProperty({ description: 'ID de la conexión de Stripe' })
	@IsUUID()
	connection_id: string;

	@ApiPropertyOptional({ description: 'Fecha desde (ISO 8601)' })
	@IsOptional()
	@IsDateString()
	date_from?: string;

	@ApiPropertyOptional({ description: 'Fecha hasta (ISO 8601)' })
	@IsOptional()
	@IsDateString()
	date_to?: string;

	@ApiPropertyOptional({ description: 'Límite de registros a sincronizar', default: 100 })
	@IsOptional()
	@IsNumber()
	@Min(1)
	@Max(1000)
	limit?: number;

	@ApiPropertyOptional({ description: 'Solo estimar registros sin sincronizar', default: false })
	@IsOptional()
	estimate_only?: boolean;
}

export class CountStripeRecordsDto {
	@ApiProperty({ description: 'ID de la conexión de Stripe' })
	@IsUUID()
	connection_id: string;

	@ApiPropertyOptional({ description: 'Fecha desde (ISO 8601)' })
	@IsOptional()
	@IsDateString()
	date_from?: string;

	@ApiPropertyOptional({ description: 'Fecha hasta (ISO 8601)' })
	@IsOptional()
	@IsDateString()
	date_to?: string;
}
