import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateDomainDto {
	@ApiProperty({
		description: 'Dominio del remitente (ej: mail.tuempresa.com)',
		example: 'mail.tuempresa.com',
	})
	@IsString()
	@IsNotEmpty()
	sender_domain: string;

	@ApiProperty({
		description: 'ID del holding',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;

	@ApiPropertyOptional({
		description: 'Nombre descriptivo del dominio',
		example: 'Dominio principal',
	})
	@IsString()
	@IsOptional()
	display_name?: string;

	@ApiPropertyOptional({
		description: 'Marcar como dominio por defecto',
		example: false,
		default: false,
	})
	@IsBoolean()
	@IsOptional()
	is_default?: boolean;
}
