import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';

import { emptyToNull, trim } from './holding.dto';

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** Dominio de envío: `mail.empresa.com` (letras, números y guiones por etiqueta; TLD de 2+ letras). */
export const SENDER_DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class CreateDomainDto {
	@ApiProperty({ example: 'mail.empresa.com' })
	@Transform(lowerTrim)
	@IsString({ message: 'El dominio no es válido (ejemplo: mail.empresa.com)' })
	@Matches(SENDER_DOMAIN, { message: 'El dominio no es válido (ejemplo: mail.empresa.com)' })
	sender_domain!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del remitente debe ser texto' })
	@MinLength(1, { message: 'El nombre del remitente es obligatorio' })
	@MaxLength(100, { message: 'El nombre del remitente no puede superar 100 caracteres' })
	from_name!: string;

	@ApiProperty()
	@Transform(lowerTrim)
	@IsEmail({}, { message: 'El correo del remitente no es válido' })
	from_email!: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El nombre del dominio debe ser texto' })
	@MaxLength(100, { message: 'El nombre del dominio no puede superar 100 caracteres' })
	@IsOptional()
	display_name?: string | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Por defecto debe ser sí o no' })
	@IsOptional()
	is_default?: boolean;
}

export class UpdateDomainDto {
	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El nombre del dominio debe ser texto' })
	@MaxLength(100, { message: 'El nombre del dominio no puede superar 100 caracteres' })
	@IsOptional()
	display_name?: string | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Por defecto debe ser sí o no' })
	@IsOptional()
	is_default?: boolean;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Activo debe ser sí o no' })
	@IsOptional()
	is_active?: boolean;
}

export class SendersQueryDto {
	@ApiPropertyOptional()
	@IsUUID('all', { message: 'El dominio no es válido' })
	@IsOptional()
	domain_id?: string;
}

export class CreateSenderDto {
	@ApiProperty()
	@IsUUID('all', { message: 'El dominio no es válido' })
	domain_id!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del remitente debe ser texto' })
	@MinLength(1, { message: 'El nombre del remitente es obligatorio' })
	@MaxLength(100, { message: 'El nombre del remitente no puede superar 100 caracteres' })
	from_name!: string;

	@ApiProperty()
	@Transform(lowerTrim)
	@IsEmail({}, { message: 'El correo del remitente no es válido' })
	from_email!: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsEmail({}, { message: 'El correo de respuesta no es válido' })
	@IsOptional()
	reply_to_email?: string | null;

	@ApiPropertyOptional({ nullable: true, example: 'cobranza' })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El uso debe ser texto' })
	@MaxLength(50, { message: 'El uso no puede superar 50 caracteres' })
	@IsOptional()
	purpose?: string | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Por defecto debe ser sí o no' })
	@IsOptional()
	is_default?: boolean;
}

export class UpdateSenderDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre del remitente debe ser texto' })
	@MinLength(1, { message: 'El nombre del remitente no puede quedar vacío' })
	@MaxLength(100, { message: 'El nombre del remitente no puede superar 100 caracteres' })
	@IsOptional()
	from_name?: string;

	@ApiPropertyOptional()
	@Transform(lowerTrim)
	@IsEmail({}, { message: 'El correo del remitente no es válido' })
	@IsOptional()
	from_email?: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsEmail({}, { message: 'El correo de respuesta no es válido' })
	@IsOptional()
	reply_to_email?: string | null;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El uso debe ser texto' })
	@MaxLength(50, { message: 'El uso no puede superar 50 caracteres' })
	@IsOptional()
	purpose?: string | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Por defecto debe ser sí o no' })
	@IsOptional()
	is_default?: boolean;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Activo debe ser sí o no' })
	@IsOptional()
	is_active?: boolean;
}

export class TestEmailDto {
	@ApiProperty()
	@Transform(lowerTrim)
	@IsEmail({}, { message: 'El correo de destino no es válido' })
	to!: string;

	@ApiPropertyOptional()
	@IsUUID('all', { message: 'El remitente no es válido' })
	@IsOptional()
	sender_id?: string;
}
