import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class QueryClientsDto {
	@ApiPropertyOptional({
		description: 'ID del holding para filtrar clientes',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
	})
	@IsUUID()
	@IsOptional()
	holding_id?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por segmento',
		example: 'Enterprise',
	})
	@IsString()
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por industria',
		example: 'Tecnología',
	})
	@IsString()
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por mercado',
		example: 'Latam',
	})
	@IsString()
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por estado',
		example: 'Activo',
	})
	@IsString()
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por país',
		example: 'Chile',
	})
	@IsString()
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({
		description: 'Buscar por nombre comercial (búsqueda parcial)',
		example: 'Acme',
	})
	@IsString()
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({
		description: 'Número de página',
		example: 1,
		default: 1,
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({
		description: 'Cantidad de resultados por página',
		example: 20,
		default: 20,
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	limit?: number;
}
