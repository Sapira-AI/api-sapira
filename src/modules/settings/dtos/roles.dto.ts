import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { emptyToNull, trim } from './holding.dto';

const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export class CreateRoleDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre es obligatorio' })
	@MaxLength(100, { message: 'El nombre no puede superar 100 caracteres' })
	name!: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'La descripción debe ser texto' })
	@MaxLength(300, { message: 'La descripción no puede superar 300 caracteres' })
	@IsOptional()
	description?: string | null;

	@ApiProperty({ type: [String], example: ['VIEW_CLIENTES', 'EDIT_CLIENTES'] })
	@IsArray({ message: 'Los permisos deben ser una lista de códigos' })
	@ArrayMaxSize(100, { message: 'Demasiados permisos' })
	@Matches(CODE, { each: true, message: 'Código de permiso no válido' })
	permissions!: string[];
}

export class UpdateRoleDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(100, { message: 'El nombre no puede superar 100 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'La descripción debe ser texto' })
	@MaxLength(300, { message: 'La descripción no puede superar 300 caracteres' })
	@IsOptional()
	description?: string | null;

	@ApiPropertyOptional({ type: [String] })
	@IsArray({ message: 'Los permisos deben ser una lista de códigos' })
	@ArrayMaxSize(100, { message: 'Demasiados permisos' })
	@Matches(CODE, { each: true, message: 'Código de permiso no válido' })
	@IsOptional()
	permissions?: string[];
}

export class DuplicateRoleDto {
	@ApiPropertyOptional({ description: 'Por defecto "<nombre> (copia)"' })
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(100, { message: 'El nombre no puede superar 100 caracteres' })
	@IsOptional()
	name?: string;
}

export class PutRoleAlertsDto {
	@ApiProperty({ type: [String], example: ['salesforce_staging_blocked'] })
	@IsArray({ message: 'Las alertas deben ser una lista' })
	@ArrayMaxSize(20, { message: 'Demasiadas alertas' })
	@IsString({ each: true, message: 'Tipo de alerta no válido' })
	types!: string[];
}

export class ChangeUserRoleDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'El rol no es válido' })
	role_id!: string;
}

/** Contrato §10.1. El email se normaliza (`trim().toLowerCase()`) aquí y otra vez en el servicio. */
export class InviteUserDto {
	@ApiProperty({ example: 'ana@cliente.com' })
	@Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
	@IsEmail({}, { message: 'El correo no es válido' })
	@MaxLength(254, { message: 'El correo no puede superar 254 caracteres' })
	email!: string;

	@ApiProperty({ example: 'Ana Pérez' })
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre es obligatorio' })
	@MaxLength(120, { message: 'El nombre no puede superar 120 caracteres' })
	name!: string;

	@ApiProperty()
	@IsUUID(undefined, { message: 'El rol no es válido' })
	role_id!: string;
}

/** Contrato §10.3. */
export class UserAccessDto {
	@ApiProperty({ description: 'true = reactivar, false = desactivar en este holding' })
	@IsBoolean({ message: 'Indica si el acceso queda activo (true o false)' })
	active!: boolean;
}
