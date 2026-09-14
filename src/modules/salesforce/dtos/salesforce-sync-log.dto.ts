import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SalesforceSyncLogListDto {
	@ApiPropertyOptional({
		description: 'Entorno donde se ejecutó la integración. Si se omite se devuelven todos los entornos.',
		example: 'production',
	})
	@IsOptional()
	@IsString()
	environment?: string;

	@ApiPropertyOptional({
		description: 'Severidad del evento',
		enum: ['info', 'warning', 'error'],
	})
	@IsOptional()
	@IsIn(['info', 'warning', 'error'])
	level?: 'info' | 'warning' | 'error';

	@ApiPropertyOptional({
		description: 'Etapa de la sincronización',
		enum: ['run', 'holding', 'selection', 'staging', 'processing', 'opportunity'],
	})
	@IsOptional()
	@IsIn(['run', 'holding', 'selection', 'staging', 'processing', 'opportunity'])
	stage?: 'run' | 'holding' | 'selection' | 'staging' | 'processing' | 'opportunity';

	@ApiPropertyOptional({ description: 'Identificador de la corrida del scheduler' })
	@IsOptional()
	@IsString()
	jobId?: string;

	@ApiPropertyOptional({ description: 'Id de la oportunidad Salesforce' })
	@IsOptional()
	@IsString()
	opportunityId?: string;

	@ApiPropertyOptional({ description: 'Fecha desde (ISO) para acotar los eventos', example: '2026-09-01T00:00:00.000Z' })
	@IsOptional()
	@IsDateString()
	dateFrom?: string;

	@ApiPropertyOptional({ description: 'Fecha hasta (ISO) para acotar los eventos', example: '2026-09-30T23:59:59.000Z' })
	@IsOptional()
	@IsDateString()
	dateTo?: string;

	@ApiPropertyOptional({ description: 'Página', example: 1, default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({ description: 'Cantidad de eventos por página', example: 50, default: 50 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200)
	limit?: number;
}

export class SalesforceSyncJobListDto {
	@ApiPropertyOptional({
		description: 'Entorno donde se ejecutó la integración',
		example: 'production',
	})
	@IsOptional()
	@IsString()
	environment?: string;

	@ApiPropertyOptional({
		description: 'Estado de la corrida',
		enum: ['pending', 'running', 'completed', 'failed'],
	})
	@IsOptional()
	@IsIn(['pending', 'running', 'completed', 'failed'])
	status?: 'pending' | 'running' | 'completed' | 'failed';

	@ApiPropertyOptional({
		description: 'Cuando es true devuelve corridas de todos los holdings, no solo del holding activo',
		example: false,
	})
	@IsOptional()
	@IsString()
	allHoldings?: string;

	@ApiPropertyOptional({ description: 'Página', example: 1, default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	page?: number;

	@ApiPropertyOptional({ description: 'Cantidad de corridas por página', example: 20, default: 20 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;
}
