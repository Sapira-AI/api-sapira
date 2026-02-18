import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class GetCustomersDto {
	@ApiPropertyOptional({
		description: 'Email del cliente',
	})
	@IsOptional()
	@IsEmail()
	email?: string;

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
