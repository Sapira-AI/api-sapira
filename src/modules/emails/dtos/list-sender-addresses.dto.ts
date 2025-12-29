import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class ListSenderAddressesDto {
	@ApiProperty({
		description: 'ID del dominio configurado',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	domain_config_id: string;

	@ApiPropertyOptional({
		description: 'Filtrar solo remitentes activos',
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	active_only?: boolean;
}
