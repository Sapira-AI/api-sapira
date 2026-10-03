import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsEmail,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { IsIsoDate } from '../settings-common';

import { emptyToNull, trim } from './holding.dto';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const TAX_MESSAGE = 'El impuesto va en porcentaje (19 = 19 %), entre 0 y 100';

/** Campos de texto opcionales que se pueden vaciar (`null`). */
function OptionalText(max: number, label: string) {
	return function (target: object, key: string) {
		Transform(emptyToNull)(target, key);
		ValidateIf((_: unknown, value: unknown) => value !== null)(target, key);
		IsString({ message: `${label} debe ser texto` })(target, key);
		MaxLength(max, { message: `${label} no puede superar ${max} caracteres` })(target, key);
		IsOptional()(target, key);
	};
}

export class CompanyFieldsDto {
	@ApiPropertyOptional({ nullable: true }) @OptionalText(50, 'El identificador tributario') tax_id?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(500, 'La dirección') legal_address?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(200, 'El representante') representative_name?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(50, 'El teléfono') phone?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(300, 'El sitio web') website?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(10, 'El prefijo de factura') invoice_prefix?: string | null;
	@ApiPropertyOptional({ nullable: true }) @OptionalText(10, 'El prefijo de contrato') contract_prefix?: string | null;

	@ApiPropertyOptional({ nullable: true })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsEmail({}, { message: 'El correo no es válido' })
	@IsOptional()
	email?: string | null;

	@ApiPropertyOptional({ nullable: true, description: 'Porcentaje: 19 = 19 %' })
	@ValidateIf((_, value) => value !== null)
	@Type(() => Number)
	@IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 4 }, { message: TAX_MESSAGE })
	@Min(0, { message: TAX_MESSAGE })
	@Max(100, { message: TAX_MESSAGE })
	@IsOptional()
	tax_rate?: number | null;
}

export class CreateCompanyDto extends CompanyFieldsDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'La razón social debe ser texto' })
	@MinLength(1, { message: 'La razón social es obligatoria' })
	@MaxLength(200, { message: 'La razón social no puede superar 200 caracteres' })
	legal_name!: string;

	@ApiProperty({ example: 'CL', description: 'ISO 3166-1 alfa-2' })
	@Transform(upper)
	@Matches(/^[A-Z]{2}$/, { message: 'El país debe ser un código ISO de 2 letras' })
	country_code!: string;

	@ApiProperty({ example: 'CLP' })
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	currency!: string;
}

export class UpdateCompanyDto extends CompanyFieldsDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'La razón social debe ser texto' })
	@MinLength(1, { message: 'La razón social no puede quedar vacía' })
	@MaxLength(200, { message: 'La razón social no puede superar 200 caracteres' })
	@IsOptional()
	legal_name?: string;

	@ApiPropertyOptional()
	@Transform(upper)
	@Matches(/^[A-Z]{2}$/, { message: 'El país debe ser un código ISO de 2 letras' })
	@IsOptional()
	country_code?: string;

	@ApiPropertyOptional()
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ nullable: true, description: 'null o la public_url que devolvió logo-upload' })
	@Transform(emptyToNull)
	@ValidateIf((_, value) => value !== null)
	@IsString({ message: 'El logo debe ser una URL' })
	@MaxLength(1000, { message: 'La URL del logo es demasiado larga' })
	@IsOptional()
	logo_url?: string | null;
}

export const ACCOUNT_KEYS = ['receivable', 'deferred', 'unbilled', 'revenue', 'fx_difference'] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export class AccountDto {
	@ApiProperty({ enum: ACCOUNT_KEYS })
	@IsString({ message: 'La clave de la cuenta debe ser texto' })
	key!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El código de la cuenta debe ser texto' })
	@MinLength(1, { message: 'El código de la cuenta es obligatorio' })
	@MaxLength(50, { message: 'El código no puede superar 50 caracteres' })
	code!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre de la cuenta debe ser texto' })
	@MinLength(1, { message: 'El nombre de la cuenta es obligatorio' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	name!: string;

	@ApiPropertyOptional({ nullable: true }) @OptionalText(100, 'El código del ERP') external_code?: string | null;
}

export class PutAccountsDto {
	@ApiProperty({ type: [AccountDto] })
	@IsArray({ message: 'Las cuentas deben ser una lista' })
	@ArrayMinSize(1, { message: 'Faltan las cuentas' })
	@ArrayMaxSize(10, { message: 'Son 5 cuentas' })
	@ValidateNested({ each: true })
	@Type(() => AccountDto)
	accounts!: AccountDto[];
}

export class CreateBankAccountDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El banco debe ser texto' })
	@MinLength(1, { message: 'El banco es obligatorio' })
	@MaxLength(100, { message: 'El banco no puede superar 100 caracteres' })
	bank_name!: string;

	@ApiProperty({ example: 'Cuenta Corriente' })
	@Transform(trim)
	@IsString({ message: 'El tipo de cuenta debe ser texto' })
	@MinLength(1, { message: 'El tipo de cuenta es obligatorio' })
	@MaxLength(50, { message: 'El tipo de cuenta no puede superar 50 caracteres' })
	account_type!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El número de cuenta debe ser texto' })
	@MinLength(1, { message: 'El número de cuenta es obligatorio' })
	@MaxLength(50, { message: 'El número de cuenta no puede superar 50 caracteres' })
	account_number!: string;

	@ApiProperty()
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	currency!: string;

	@ApiPropertyOptional({ nullable: true }) @OptionalText(200, 'El titular') account_holder?: string | null;
}

export class UpdateBankAccountDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El banco debe ser texto' })
	@MinLength(1, { message: 'El banco no puede quedar vacío' })
	@MaxLength(100, { message: 'El banco no puede superar 100 caracteres' })
	@IsOptional()
	bank_name?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El tipo de cuenta debe ser texto' })
	@MinLength(1, { message: 'El tipo de cuenta no puede quedar vacío' })
	@MaxLength(50, { message: 'El tipo de cuenta no puede superar 50 caracteres' })
	@IsOptional()
	account_type?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'El número de cuenta debe ser texto' })
	@MinLength(1, { message: 'El número de cuenta no puede quedar vacío' })
	@MaxLength(50, { message: 'El número de cuenta no puede superar 50 caracteres' })
	@IsOptional()
	account_number?: string;

	@ApiPropertyOptional()
	@Transform(upper)
	@Matches(/^[A-Z]{3}$/, { message: 'La moneda debe ser un código de 3 letras' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ nullable: true }) @OptionalText(200, 'El titular') account_holder?: string | null;
}

export class LegalDocumentUploadDto {
	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del archivo debe ser texto' })
	@MinLength(1, { message: 'Falta el nombre del archivo' })
	@MaxLength(200, { message: 'El nombre del archivo no puede superar 200 caracteres' })
	file_name!: string;

	@ApiProperty()
	@IsString({ message: 'El tipo de archivo debe ser texto' })
	mime_type!: string;

	@ApiProperty({ description: 'Bytes' })
	@Type(() => Number)
	@IsInt({ message: 'El tamaño del archivo no es válido' })
	@Min(1, { message: 'El archivo está vacío' })
	size!: number;
}

export class ConfirmLegalDocumentDto {
	@ApiProperty()
	@IsUUID(undefined, { message: 'El documento no es válido: vuelve a subir el archivo' })
	document_id!: string;

	@ApiProperty()
	@IsString({ message: 'La ruta del archivo no es válida' })
	@MaxLength(500, { message: 'La ruta del archivo es demasiado larga' })
	path!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del documento debe ser texto' })
	@MinLength(1, { message: 'El nombre del documento es obligatorio' })
	@MaxLength(200, { message: 'El nombre no puede superar 200 caracteres' })
	document_name!: string;

	@ApiProperty({ example: 'Poder legal' })
	@Transform(trim)
	@IsString({ message: 'El tipo de documento debe ser texto' })
	@MinLength(1, { message: 'El tipo de documento es obligatorio' })
	@MaxLength(100, { message: 'El tipo no puede superar 100 caracteres' })
	document_type!: string;

	@ApiProperty()
	@Transform(trim)
	@IsString({ message: 'El nombre del archivo debe ser texto' })
	@MinLength(1, { message: 'Falta el nombre del archivo' })
	@MaxLength(200, { message: 'El nombre del archivo no puede superar 200 caracteres' })
	file_name!: string;

	@ApiProperty()
	@IsString({ message: 'El tipo de archivo debe ser texto' })
	mime_type!: string;
}

export class ClosePeriodDto {
	@ApiProperty({ example: '2026-08-31', description: 'Último día de un mes' })
	@IsIsoDate('La fecha de cierre no es válida (AAAA-MM-DD)')
	until_date!: string;

	@ApiProperty({ minLength: 10 })
	@Transform(trim)
	@IsString({ message: 'El motivo debe ser texto' })
	@MinLength(10, { message: 'El motivo debe tener al menos 10 caracteres' })
	@MaxLength(1000, { message: 'El motivo no puede superar 1000 caracteres' })
	reason!: string;
}

export class ReopenPeriodDto {
	@ApiProperty({ example: '2026-07-01', description: 'Día 1 de un mes' })
	@IsIsoDate('La fecha de reapertura no es válida (AAAA-MM-DD)')
	from_date!: string;

	@ApiProperty({ minLength: 10 })
	@Transform(trim)
	@IsString({ message: 'El motivo debe ser texto' })
	@MinLength(10, { message: 'El motivo debe tener al menos 10 caracteres' })
	@MaxLength(1000, { message: 'El motivo no puede superar 1000 caracteres' })
	reason!: string;
}
