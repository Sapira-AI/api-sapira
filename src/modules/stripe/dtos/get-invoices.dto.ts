import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetInvoicesDto {
	@ApiPropertyOptional({
		description: 'ID del cliente en Stripe',
		example: 'cus_123456789',
	})
	@IsOptional()
	@IsString()
	customer?: string;

	@ApiPropertyOptional({
		description: 'Estado de las facturas (draft, open, paid, uncollectible, void)',
		example: 'paid',
	})
	@IsOptional()
	@IsString()
	status?: string;

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
