import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsEmail,
	IsIn,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateBy,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { QUOTE_NUMBERING_MODES, type QuoteNumberingMode } from '@/core/utils/holding-preferences';

import { IsIsoDate } from '../settings-common';

export const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** `''` → `null` para campos opcionales que se pueden vaciar. */
export const emptyToNull = ({ value }: { value: unknown }) =>
	typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value;

export const FX_SYSTEM_POLICIES = ['fixed_period', 'monthly_avg'] as const;

/** Sin `name`: el holding no se renombra desde Configuración (decisión de Domi 03-10); `name` en el body → 400. */
export class UpdateHoldingDto {
	/** Solo para responder un 400 claro si un cliente antiguo aún lo envía. */
	@ApiHideProperty()
	@ValidateIf((_, value) => value !== undefined)
	@ValidateBy({
		name: 'holdingNameLocked',
		validator: { validate: () => false, defaultMessage: () => 'El nombre del holding no se puede cambiar' },
	})
	name?: never;

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
	@MaxLength(1000, { message: 'La URL del logo es demasiado larga' })
	@IsOptional()
	logo_url?: string | null;
}

export class LogoUploadDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del archivo debe ser texto' })
	@MinLength(1, { message: 'Falta el nombre del archivo' })
	@MaxLength(200, { message: 'El nombre del archivo no puede superar 200 caracteres' })
	file_name!: string;

	@ApiProperty({ enum: ['image/png', 'image/jpeg', 'image/webp'] })
	@IsString({ message: 'El tipo de archivo debe ser texto' })
	mime_type!: string;

	@ApiProperty({ description: 'Bytes' })
	@Type(() => Number)
	@IsInt({ message: 'El tamaño del archivo no es válido' })
	@Min(1, { message: 'El archivo está vacío' })
	size!: number;
}

/** Numeración de cotizaciones creadas en Sapira (ronda 4). Todo opcional: se mezcla con lo guardado. */
export class QuoteNumberingDto {
	@ApiPropertyOptional({ enum: QUOTE_NUMBERING_MODES })
	@IsIn(QUOTE_NUMBERING_MODES, { message: 'Formato de numeración no válido: con prefijo, correlativo o manual' })
	@IsOptional()
	mode?: QuoteNumberingMode;

	@ApiPropertyOptional({ example: 'COT' })
	@Transform(trim)
	@IsString({ message: 'El prefijo solo admite letras y números (máximo 10)' })
	@Matches(/^[A-Za-z0-9]{1,10}$/, { message: 'El prefijo solo admite letras y números (máximo 10)' })
	@IsOptional()
	prefix?: string;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Incluir el año debe ser sí o no' })
	@IsOptional()
	include_year?: boolean;

	@ApiPropertyOptional({ minimum: 1, maximum: 8 })
	@Type(() => Number)
	@IsInt({ message: 'El ancho del correlativo debe estar entre 1 y 8' })
	@Min(1, { message: 'El ancho del correlativo debe estar entre 1 y 8' })
	@Max(8, { message: 'El ancho del correlativo debe estar entre 1 y 8' })
	@IsOptional()
	width?: number;
}

export class UpdatePreferencesDto {
	@ApiPropertyOptional({ description: 'Moneda de consolidación' })
	@Transform(trim)
	@IsString({ message: 'La moneda de consolidación debe ser un código de moneda' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de consolidación debe ser un código de 3 letras' })
	@IsOptional()
	system_currency?: string;

	@ApiPropertyOptional({ enum: FX_SYSTEM_POLICIES })
	@IsIn(FX_SYSTEM_POLICIES, { message: 'La política de tipo de cambio debe ser tasa fija por período o promedio mensual' })
	@IsOptional()
	fx_system_policy?: (typeof FX_SYSTEM_POLICIES)[number];

	@ApiPropertyOptional({ minimum: 1, maximum: 180 })
	@Type(() => Number)
	@IsInt({ message: 'Los días de aviso deben estar entre 1 y 180' })
	@Min(1, { message: 'Los días de aviso deben estar entre 1 y 180' })
	@Max(180, { message: 'Los días de aviso deben estar entre 1 y 180' })
	@IsOptional()
	auto_renewal_notice_days?: number;

	@ApiPropertyOptional({ example: 'America/Santiago', description: 'Zona horaria IANA del holding (define su "hoy")' })
	@Transform(trim)
	@IsString({ message: 'La zona horaria debe ser texto' })
	@MaxLength(64, { message: 'La zona horaria no puede superar 64 caracteres' })
	@IsOptional()
	timezone?: string;

	@ApiPropertyOptional({ type: [Number], example: [60, 30, 15, 7, 0], description: 'Días antes del fin; se guarda de mayor a menor' })
	@IsArray({ message: 'Los recordatorios deben ser una lista de días' })
	@ArrayMinSize(1, { message: 'Indica entre 1 y 10 recordatorios' })
	@ArrayMaxSize(10, { message: 'Indica entre 1 y 10 recordatorios' })
	@IsInt({ each: true, message: 'Los recordatorios deben ser días entre 0 y 180' })
	@Min(0, { each: true, message: 'Los recordatorios deben ser días entre 0 y 180' })
	@Max(180, { each: true, message: 'Los recordatorios deben ser días entre 0 y 180' })
	@ValidateBy({
		name: 'uniqueReminderDays',
		validator: {
			validate: (value: unknown) => !Array.isArray(value) || new Set(value).size === value.length,
			defaultMessage: () => 'Hay días de recordatorio repetidos',
		},
	})
	@IsOptional()
	renewal_reminder_days?: number[];

	@ApiPropertyOptional({ minimum: 1, maximum: 90, description: 'Vencido sin decisión: un recordatorio cada N días' })
	@Type(() => Number)
	@IsInt({ message: 'La frecuencia de recordatorios vencidos debe estar entre 1 y 90 días' })
	@Min(1, { message: 'La frecuencia de recordatorios vencidos debe estar entre 1 y 90 días' })
	@Max(90, { message: 'La frecuencia de recordatorios vencidos debe estar entre 1 y 90 días' })
	@IsOptional()
	renewal_overdue_every_days?: number;

	@ApiPropertyOptional({ type: () => QuoteNumberingDto, description: 'Se mezcla con lo guardado' })
	@ValidateNested()
	@Type(() => QuoteNumberingDto)
	@IsOptional()
	quote_numbering?: QuoteNumberingDto;
}

export class FxRatesQueryDto {
	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de origen debe ser un código de 3 letras' })
	@IsOptional()
	from_currency?: string;

	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de destino debe ser un código de 3 letras' })
	@IsOptional()
	to_currency?: string;
}

/** `GET /settings/holding/fx-sync/history` (ronda 3). Sin fechas: últimos 90 días hasta hoy. */
export class FxSyncHistoryQueryDto {
	@ApiProperty({ example: 'CLP' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	currency!: string;

	@ApiPropertyOptional({ example: '2026-07-01' })
	@IsIsoDate('La fecha de inicio no es válida (AAAA-MM-DD)')
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ example: '2026-10-03' })
	@IsIsoDate('La fecha de fin no es válida (AAAA-MM-DD)')
	@IsOptional()
	to?: string;
}

/** `GET /settings/holding/fx-sync/monthly` (ronda 3). Sin año: el actual. */
export class FxSyncMonthlyQueryDto {
	@ApiProperty({ example: 'CLP' })
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	currency!: string;

	@ApiPropertyOptional({ example: 2026 })
	@Type(() => Number)
	@IsInt({ message: 'El año debe estar entre 2000 y 2100' })
	@Min(2000, { message: 'El año debe estar entre 2000 y 2100' })
	@Max(2100, { message: 'El año debe estar entre 2000 y 2100' })
	@IsOptional()
	year?: number;
}

export class CreateFxRateDto {
	@ApiProperty()
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de origen debe ser un código de 3 letras' })
	from_currency!: string;

	@ApiProperty()
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de destino debe ser un código de 3 letras' })
	to_currency!: string;

	@ApiProperty()
	@Type(() => Number)
	@IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 10 }, { message: 'La tasa debe ser un número' })
	rate!: number;

	@ApiProperty()
	@IsIsoDate('La fecha de inicio no es válida (AAAA-MM-DD)')
	period_start!: string;

	@ApiProperty()
	@IsIsoDate('La fecha de fin no es válida (AAAA-MM-DD)')
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
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de origen debe ser un código de 3 letras' })
	@IsOptional()
	from_currency?: string;

	@ApiPropertyOptional()
	@Matches(/^[A-Za-z]{3}$/, { message: 'La moneda de destino debe ser un código de 3 letras' })
	@IsOptional()
	to_currency?: string;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 10 }, { message: 'La tasa debe ser un número' })
	@IsOptional()
	rate?: number;

	@ApiPropertyOptional()
	@IsIsoDate('La fecha de inicio no es válida (AAAA-MM-DD)')
	@IsOptional()
	period_start?: string;

	@ApiPropertyOptional()
	@IsIsoDate('La fecha de fin no es válida (AAAA-MM-DD)')
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
