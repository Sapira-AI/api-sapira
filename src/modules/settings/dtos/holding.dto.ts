import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

import { ISO_DATE } from '../settings-common';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** `''` → `null` para campos opcionales que se pueden vaciar. */
export const emptyToNull = ({ value }: { value: unknown }) =>
	typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value;

export const FX_SYSTEM_POLICIES = ['fixed_period', 'monthly_avg'] as const;

export class UpdateHoldingDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El nombre debe ser texto' })
	@MinLength(1, { message: 'El nombre no puede quedar vacío' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El sitio web debe ser texto' })
	@MaxLength(300, { message: 'El sitio web no puede superar 300 caracteres' })
	@IsOptional()
	website?: string | null;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El teléfono debe ser texto' })
	@MaxLength(50, { message: 'El teléfono no puede superar 50 caracteres' })
	@IsOptional()
	phone?: string | null;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsEmail({}, { message: 'El correo no es válido' })
	@IsOptional()
	email?: string | null;

	@ApiPropertyOptional({ nullable: true, description: 'null o la public_url que devolvió logo-upload' })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El logo debe ser una URL' })
	@MaxLength(1000)
	@IsOptional()
	logo_url?: string | null;
}

export class LogoUploadDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'file_name debe ser texto' })
	@MinLength(1, { message: 'Falta el nombre del archivo' })
	@MaxLength(200)
	file_name!: string;

	@ApiProperty({ enum: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] })
	@IsString({ message: 'mime_type debe ser texto' })
	mime_type!: string;

	@ApiProperty({ description: 'Bytes' })
	@Type(() => Number)
	@IsInt({ message: 'size debe ser un número entero de bytes' })
	@Min(1, { message: 'El archivo está vacío' })
	size!: number;
}

export class UpdatePreferencesDto {
	@ApiPropertyOptional({ description: 'Moneda de consolidación' })
	@Transform(trim)
	@IsString({ message: 'system_currency debe ser un código de moneda' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'system_currency debe ser un código de 3 letras' })
	@IsOptional()
	system_currency?: string;

	@ApiPropertyOptional({ enum: FX_SYSTEM_POLICIES })
	@IsIn(FX_SYSTEM_POLICIES, { message: 'fx_system_policy debe ser fixed_period o monthly_avg' })
	@IsOptional()
	fx_system_policy?: (typeof FX_SYSTEM_POLICIES)[number];

	@ApiPropertyOptional({ minimum: 1, maximum: 180 })
	@Type(() => Number)
	@IsInt({ message: 'Los días de aviso deben estar entre 1 y 180' })
	@Min(1, { message: 'Los días de aviso deben estar entre 1 y 180' })
	@Max(180, { message: 'Los días de aviso deben estar entre 1 y 180' })
	@IsOptional()
	auto_renewal_notice_days?: number;
}

export class FxRatesQueryDto {
	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'from_currency debe ser un código de 3 letras' })
	@IsOptional()
	from_currency?: string;

	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'to_currency debe ser un código de 3 letras' })
	@IsOptional()
	to_currency?: string;
}

export class CreateFxRateDto {
	@ApiProperty()
	@Matches(/^[A-Za-z]{3}$/, { message: 'from_currency debe ser un código de 3 letras' })
	from_currency!: string;

	@ApiProperty()
	@Matches(/^[A-Za-z]{3}$/, { message: 'to_currency debe ser un código de 3 letras' })
	to_currency!: string;

	@ApiProperty()
	@Type(() => Number)
	@IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 10 }, { message: 'La tasa debe ser un número' })
	rate!: number;

	@ApiProperty()
	@Matches(ISO_DATE, { message: 'period_start debe ser YYYY-MM-DD' })
	period_start!: string;

	@ApiProperty()
	@Matches(ISO_DATE, { message: 'period_end debe ser YYYY-MM-DD' })
	period_end!: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'Las notas deben ser texto' })
	@MaxLength(500, { message: 'Las notas no pueden superar 500 caracteres' })
	@IsOptional()
	notes?: string | null;
}

export class UpdateFxRateDto {
	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'from_currency debe ser un código de 3 letras' })
	@IsOptional()
	from_currency?: string;

	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'to_currency debe ser un código de 3 letras' })
	@IsOptional()
	to_currency?: string;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 10 }, { message: 'La tasa debe ser un número' })
	@IsOptional()
	rate?: number;

	@ApiPropertyOptional()
	@Matches(ISO_DATE, { message: 'period_start debe ser YYYY-MM-DD' })
	@IsOptional()
	period_start?: string;

	@ApiPropertyOptional()
	@Matches(ISO_DATE, { message: 'period_end debe ser YYYY-MM-DD' })
	@IsOptional()
	period_end?: string;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'Las notas deben ser texto' })
	@MaxLength(500, { message: 'Las notas no pueden superar 500 caracteres' })
	@IsOptional()
	notes?: string | null;
}
