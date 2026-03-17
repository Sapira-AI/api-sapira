import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateStripeConnectionDto {
	@ApiProperty({ description: 'ID del holding' })
	@IsUUID()
	holding_id: string;

	@ApiProperty({ description: 'ID del usuario' })
	@IsUUID()
	user_id: string;

	@ApiProperty({ description: 'Nombre de la conexión' })
	@IsString()
	name: string;

	@ApiProperty({ description: 'Secret Key de Stripe' })
	@IsString()
	secret_key: string;

	@ApiPropertyOptional({ description: 'Publishable Key de Stripe' })
	@IsOptional()
	@IsString()
	publishable_key?: string;

	@ApiProperty({ description: 'Modo de operación', enum: ['test', 'live'], default: 'test' })
	@IsIn(['test', 'live'])
	mode: string;

	@ApiPropertyOptional({ description: 'Si la conexión está activa', default: true })
	@IsOptional()
	@IsBoolean()
	is_active?: boolean;
}
