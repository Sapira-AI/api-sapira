import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class UpdateDomainDto {
	@ApiPropertyOptional({
		description: 'Nombre descriptivo del dominio',
		example: 'Dominio principal',
	})
	@IsString()
	@IsOptional()
	display_name?: string;

	@ApiPropertyOptional({
		description: 'Marcar como dominio por defecto',
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	is_default?: boolean;

	@ApiPropertyOptional({
		description: 'Activar o desactivar el dominio',
		example: true,
	})
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class UpdateDomainParamsDto {
	@ApiPropertyOptional({
		description: 'ID del dominio a actualizar',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsUUID()
	domain_id: string;
}
