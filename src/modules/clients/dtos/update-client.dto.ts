import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateClientDto {
	@ApiPropertyOptional({
		description: 'Nombre comercial del cliente',
		example: 'Acme Corporation',
	})
	@IsString()
	@IsOptional()
	name_commercial?: string;

	@ApiPropertyOptional({
		description: 'Segmento del cliente',
		example: 'Enterprise',
	})
	@IsString()
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional({
		description: 'Industria del cliente',
		example: 'Tecnología',
	})
	@IsString()
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional({
		description: 'Mercado del cliente',
		example: 'Latam',
	})
	@IsString()
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({
		description: 'Estado del cliente',
		example: 'Activo',
	})
	@IsString()
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({
		description: 'Indica si el portal está habilitado para el cliente',
		example: false,
	})
	@IsBoolean()
	@IsOptional()
	portal_enabled?: boolean;

	@ApiPropertyOptional({
		description: 'Fecha desde que es cliente',
		example: '2024-01-01',
	})
	@IsDateString()
	@IsOptional()
	client_since?: string;

	@ApiPropertyOptional({
		description: 'Notas adicionales sobre el cliente',
		example: 'Cliente VIP',
	})
	@IsString()
	@IsOptional()
	notes?: string;

	@ApiPropertyOptional({
		description: 'País del cliente',
		example: 'Chile',
	})
	@IsString()
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({
		description: 'Número de cliente',
		example: 'CLI-001',
	})
	@IsString()
	@IsOptional()
	client_number?: string;

	@ApiPropertyOptional({
		description: 'Campos personalizados en formato JSON',
		example: { custom_field_1: 'value1' },
	})
	@IsObject()
	@IsOptional()
	custom_fields?: Record<string, any>;

	@ApiPropertyOptional({
		description: 'ID de cuenta de Salesforce',
		example: '001RO00000OGBsvYAH',
	})
	@IsString()
	@IsOptional()
	salesforce_account_id?: string;
}
