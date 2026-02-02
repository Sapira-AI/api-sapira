import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateOdooConnectionDto {
	@ApiProperty({
		description: 'UUID del holding al que pertenece esta conexión',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
		type: String,
	})
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;

	@ApiProperty({
		description: 'UUID del usuario que crea la conexión',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
		type: String,
	})
	@IsUUID()
	@IsNotEmpty()
	user_id: string;

	@ApiProperty({
		description: 'Nombre identificador de la conexión Odoo',
		example: 'Odoo UPLANNER',
		type: String,
	})
	@IsString()
	@IsNotEmpty()
	name: string;

	@ApiProperty({
		description: 'URL base de la instancia Odoo',
		example: 'https://u-planner.odoo.com',
		type: String,
	})
	@IsString()
	@IsNotEmpty()
	url: string;

	@ApiProperty({
		description: 'API Key para autenticación con Odoo',
		example: '3b64a10cd6d56b4fce8acefc9d36969cd191019b',
		type: String,
	})
	@IsString()
	@IsNotEmpty()
	api_key: string;

	@ApiProperty({
		description: 'Nombre de la base de datos en Odoo',
		example: 'odoo-ps-psus-uplanner-production-5972971',
		type: String,
	})
	@IsString()
	@IsNotEmpty()
	database_name: string;

	@ApiPropertyOptional({
		description: 'Código de suscripción de Odoo (opcional)',
		example: 'SUB-12345',
		type: String,
	})
	@IsString()
	@IsOptional()
	subscription_code?: string;

	@ApiPropertyOptional({
		description: 'Usuario/email para autenticación en Odoo',
		example: 'sapira@u-planner.com',
		type: String,
	})
	@IsString()
	@IsOptional()
	username?: string;

	@ApiPropertyOptional({
		description: 'Indica si la conexión está activa',
		example: true,
		type: Boolean,
		default: true,
	})
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}

export class UpdateOdooConnectionDto {
	@ApiPropertyOptional({
		description: 'UUID del holding al que pertenece esta conexión',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
		type: String,
	})
	@IsUUID()
	@IsOptional()
	holding_id?: string;

	@ApiPropertyOptional({
		description: 'UUID del usuario que crea la conexión',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
		type: String,
	})
	@IsUUID()
	@IsOptional()
	user_id?: string;

	@ApiPropertyOptional({
		description: 'Nombre identificador de la conexión Odoo',
		example: 'Odoo UPLANNER',
		type: String,
	})
	@IsString()
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({
		description: 'URL base de la instancia Odoo',
		example: 'https://u-planner.odoo.com',
		type: String,
	})
	@IsString()
	@IsOptional()
	url?: string;

	@ApiPropertyOptional({
		description: 'API Key para autenticación con Odoo',
		example: '3b64a10cd6d56b4fce8acefc9d36969cd191019b',
		type: String,
	})
	@IsString()
	@IsOptional()
	api_key?: string;

	@ApiPropertyOptional({
		description: 'Nombre de la base de datos en Odoo',
		example: 'odoo-ps-psus-uplanner-production-5972971',
		type: String,
	})
	@IsString()
	@IsOptional()
	database_name?: string;

	@ApiPropertyOptional({
		description: 'Código de suscripción de Odoo (opcional)',
		example: 'SUB-12345',
		type: String,
	})
	@IsString()
	@IsOptional()
	subscription_code?: string;

	@ApiPropertyOptional({
		description: 'Usuario/email para autenticación en Odoo',
		example: 'sapira@u-planner.com',
		type: String,
	})
	@IsString()
	@IsOptional()
	username?: string;

	@ApiPropertyOptional({
		description: 'Indica si la conexión está activa',
		example: true,
		type: Boolean,
	})
	@IsBoolean()
	@IsOptional()
	is_active?: boolean;
}
