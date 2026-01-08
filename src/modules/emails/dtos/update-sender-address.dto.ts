import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateSenderAddressDto {
	@ApiPropertyOptional({
		description: 'Nombre del remitente',
		example: 'Cobranza Sapira',
	})
	@IsString()
	@IsOptional()
	from_name?: string;

	@ApiPropertyOptional({
		description: 'Email del remitente (debe pertenecer al dominio)',
		example: 'cobranza@mail.tuempresa.com',
	})
	@IsEmail()
	@IsOptional()
	from_email?: string;

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
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	is_default?: boolean;

	@ApiPropertyOptional({
		description: 'Activar o desactivar el remitente',
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class UpdateSenderAddressParamsDto {
	@ApiPropertyOptional({
		description: 'ID del remitente a actualizar',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	sender_id: string;
}
