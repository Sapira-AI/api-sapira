import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateSenderAddressDto {
	@ApiProperty({
		description: 'ID del dominio configurado',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	@IsNotEmpty()
	domain_config_id: string;

	@ApiProperty({
		description: 'Nombre del remitente',
		example: 'Cobranza Sapira',
	})
	@IsString()
	@IsNotEmpty()
	from_name: string;

	@ApiProperty({
		description: 'Email del remitente (debe pertenecer al dominio)',
		example: 'cobranza@mail.tuempresa.com',
	})
	@IsEmail()
	@IsNotEmpty()
	from_email: string;

	@ApiPropertyOptional({
		description: 'Email de respuesta opcional',
		example: 'soporte@tuempresa.com',
	})
	@IsEmail()
	@IsOptional()
	reply_to_email?: string;

	@ApiPropertyOptional({
		description: 'Propósito del remitente',
		example: 'cobranzas',
	})
	@IsString()
	@IsOptional()
	purpose?: string;

	@ApiPropertyOptional({
		description: 'Marcar como remitente por defecto para este dominio',
		example: false,
		default: false,
	})
	@IsBoolean()
	@IsOptional()
	is_default?: boolean;
}
