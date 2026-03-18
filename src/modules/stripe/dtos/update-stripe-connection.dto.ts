import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateStripeConnectionDto {
	@ApiPropertyOptional({ description: 'Nombre de la conexión' })
	@IsOptional()
	@IsString()
	name?: string;

	@ApiPropertyOptional({ description: 'Secret Key de Stripe' })
	@IsOptional()
	@IsString()
	secret_key?: string;

	@ApiPropertyOptional({ description: 'Publishable Key de Stripe' })
	@IsOptional()
	@IsString()
	publishable_key?: string;

	@ApiPropertyOptional({ description: 'Modo de operación', enum: ['test', 'live'] })
	@IsOptional()
	@IsIn(['test', 'live'])
	mode?: string;

	@ApiPropertyOptional({ description: 'Si la conexión está activa' })
	@IsOptional()
	@IsBoolean()
	is_active?: boolean;
}
