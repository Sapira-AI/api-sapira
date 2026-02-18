import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetSubscriptionsDto {
	@ApiPropertyOptional({
		description: 'ID del cliente en Stripe',
	})
	@IsOptional()
	@IsString()
	customer?: string;

	@ApiPropertyOptional({
		description: 'Estado de las suscripciones (active, past_due, unpaid, canceled, incomplete, incomplete_expired, trialing, all, ended)',
		example: 'active',
	})
	@IsOptional()
	@IsString()
	status?: string;

	@ApiPropertyOptional({
		description: 'ID del precio',
	})
	@IsOptional()
	@IsString()
	price?: string;

	@ApiPropertyOptional({
		description: 'Número de resultados a retornar',
		example: 10,
		default: 10,
		minimum: 1,
		maximum: 100,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	limit?: number;

	@ApiPropertyOptional({
		description: 'ID del último objeto de la página anterior para paginación',
	})
	@IsOptional()
	@IsString()
	starting_after?: string;
}
