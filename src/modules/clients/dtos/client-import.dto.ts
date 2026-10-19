import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	Min,
	MinLength,
	ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Claves con las que una fila encuentra a su cliente comercial: N° cliente o RUT de una razón social vinculada (Domi 19-10). */
export const CLIENT_IMPORT_KEYS = ['client_number', 'tax_id'] as const;
export type ClientImportKey = (typeof CLIENT_IMPORT_KEYS)[number];

/** Campos que "Importar para actualizar" puede cambiar (los mismos de la planilla exportada; sin campos personalizados por ahora). */
export const CLIENT_IMPORT_FIELDS = ['name_commercial', 'segment', 'industry', 'market', 'country', 'client_since', 'notes'] as const;
export type ClientImportField = (typeof CLIENT_IMPORT_FIELDS)[number];

/** Máximo de filas por importación (SimpliRoute tiene 1.656 clientes). */
export const CLIENT_IMPORT_MAX_ROWS = 5000;

/** Valores mapeados de una fila: solo los campos que la planilla mapeó y traen valor (celda vacía = no cambia, nunca viaja). */
export class ClientImportFieldsDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MinLength(1, { message: 'El nombre comercial no puede quedar vacío' })
	@MaxLength(200, { message: 'Nombre comercial: máximo 200 caracteres' })
	@IsOptional()
	name_commercial?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(120, { message: 'Segmento: máximo 120 caracteres' })
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(120, { message: 'Industria: máximo 120 caracteres' })
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(120, { message: 'Mercado: máximo 120 caracteres' })
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({ description: 'Nombre del país (español o inglés) o código ISO de 2 letras' })
	@Transform(trim)
	@IsString()
	@MaxLength(100, { message: 'País: máximo 100 caracteres' })
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({ example: '2024-03-01' })
	@Transform(trim)
	@Matches(DATE, { message: 'Cliente desde: fecha inválida (AAAA-MM-DD)' })
	@IsOptional()
	client_since?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString()
	@MaxLength(2000, { message: 'Notas: máximo 2.000 caracteres' })
	@IsOptional()
	notes?: string;
}

export class ClientImportRowDto {
	@ApiProperty({ description: 'Fila de la planilla (la 1 son los encabezados)' })
	@Type(() => Number)
	@IsInt({ message: 'Fila inválida' })
	@Min(1)
	row!: number;

	@ApiProperty({ description: 'Valor de la clave en la planilla (N° cliente o RUT)' })
	@Transform(trim)
	@IsString({ message: 'Falta la clave de la fila' })
	@MinLength(1, { message: 'Falta la clave de la fila' })
	@MaxLength(120)
	key!: string;

	@ApiProperty({ type: ClientImportFieldsDto })
	@ValidateNested()
	@Type(() => ClientImportFieldsDto)
	fields!: ClientImportFieldsDto;
}

export class ClientImportPreviewDto {
	@ApiProperty({ enum: CLIENT_IMPORT_KEYS, description: 'Con qué se busca a cada cliente' })
	@IsIn(CLIENT_IMPORT_KEYS, { message: 'Clave inválida: client_number o tax_id' })
	key_field!: ClientImportKey;

	@ApiProperty({ type: [String], enum: CLIENT_IMPORT_FIELDS, description: 'Campos mapeados en la planilla (al menos uno)' })
	@IsArray({ message: 'Indica los campos mapeados' })
	@ArrayMinSize(1, { message: 'Mapea al menos un campo para actualizar' })
	@IsIn(CLIENT_IMPORT_FIELDS, { each: true, message: 'Campo no importable' })
	fields!: ClientImportField[];

	@ApiProperty({ type: [ClientImportRowDto], description: `Máximo ${CLIENT_IMPORT_MAX_ROWS}` })
	@ValidateNested({ each: true })
	@Type(() => ClientImportRowDto)
	@ArrayMinSize(1, { message: 'La planilla no tiene filas' })
	@ArrayMaxSize(CLIENT_IMPORT_MAX_ROWS, { message: `Máximo ${CLIENT_IMPORT_MAX_ROWS} filas por importación` })
	@IsArray({ message: 'Indica las filas' })
	rows!: ClientImportRowDto[];
}

export class ClientImportApplyDto extends ClientImportPreviewDto {
	@ApiPropertyOptional({ description: 'Nombre del lote (por defecto, el archivo)' })
	@Transform(trim)
	@IsString()
	@MaxLength(160)
	@IsOptional()
	label?: string;
}
