import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	Min,
	MinLength,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { trim } from './holding.dto';

export const CUSTOM_FIELD_ENTITY_TYPES = ['client', 'contract', 'contract_item', 'quote', 'quote_item', 'invoice', 'invoice_item'] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];
/** Ronda 3 (Domi 03-10): `select` (una opción de la lista), `boolean` (sí/no) y `date` (AAAA-MM-DD) se suman a texto y número. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'select', 'boolean', 'date'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
const FIELD_TYPE_MESSAGE = 'El tipo de campo debe ser texto, número, lista, sí/no o fecha';

/** Opción de un campo `select`: `value` es lo que se guarda en `custom_fields`; `label`, lo que se muestra. */
export class CustomFieldOptionDto {
	@ApiProperty({ example: 'enterprise' })
	@Transform(trim)
	@IsString({ message: 'El valor de la opción debe ser texto' })
	@MinLength(1, { message: 'El valor de la opción es obligatorio' })
	@MaxLength(100, { message: 'El valor de la opción no puede superar 100 caracteres' })
	value!: string;

	@ApiProperty({ example: 'Enterprise' })
	@Transform(trim)
	@IsString({ message: 'La etiqueta de la opción debe ser texto' })
	@MinLength(1, { message: 'La etiqueta de la opción es obligatoria' })
	@MaxLength(100, { message: 'La etiqueta de la opción no puede superar 100 caracteres' })
	label!: string;
}
const FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_NAME_MESSAGE = 'El nombre interno va en snake_case: minúsculas, números y guion bajo, empezando con letra (máx. 63)';

export class CustomFieldsQueryDto {
	@ApiPropertyOptional({ enum: CUSTOM_FIELD_ENTITY_TYPES })
	@IsIn(CUSTOM_FIELD_ENTITY_TYPES, {
		message: 'La entidad no es válida: cliente, contrato, ítem de contrato, cotización, ítem de cotización, factura o ítem de factura',
	})
	@IsOptional()
	entity_type?: CustomFieldEntityType;
}

export class CreateCustomFieldDto {
	@ApiProperty({ enum: CUSTOM_FIELD_ENTITY_TYPES })
	@IsIn(CUSTOM_FIELD_ENTITY_TYPES, {
		message: 'La entidad no es válida: cliente, contrato, ítem de contrato, cotización, ítem de cotización, factura o ítem de factura',
	})
	entity_type!: CustomFieldEntityType;

	@ApiProperty({ example: 'proyecto_cliente' })
	@Transform(trim)
	@Matches(FIELD_NAME, { message: FIELD_NAME_MESSAGE })
	field_name!: string;

	@ApiProperty({ example: 'Proyecto del cliente' })
	@Transform(trim)
	@IsString({ message: 'La etiqueta debe ser texto' })
	@MinLength(1, { message: 'La etiqueta es obligatoria' })
	@MaxLength(100, { message: 'La etiqueta no puede superar 100 caracteres' })
	field_label!: string;

	@ApiProperty({ enum: CUSTOM_FIELD_TYPES })
	@IsIn(CUSTOM_FIELD_TYPES, { message: FIELD_TYPE_MESSAGE })
	field_type!: CustomFieldType;

	@ApiPropertyOptional({ type: [CustomFieldOptionDto], nullable: true, description: 'Obligatoria para select; null en los otros tipos' })
	@ValidateIf((_, value) => value !== null && value !== undefined)
	@IsArray({ message: 'Las opciones deben ser una lista' })
	@ArrayMinSize(1, { message: 'Las opciones son obligatorias para un campo de lista' })
	@ArrayMaxSize(100, { message: 'Un campo de lista admite hasta 100 opciones' })
	@ValidateNested({ each: true })
	@Type(() => CustomFieldOptionDto)
	options?: CustomFieldOptionDto[] | null;

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'Obligatorio debe ser sí o no' })
	@IsOptional()
	is_required?: boolean;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsInt({ message: 'El orden debe ser un número entero mayor o igual a 0' })
	@Min(0, { message: 'El orden debe ser un número entero mayor o igual a 0' })
	@IsOptional()
	display_order?: number;
}

export class UpdateCustomFieldDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@Matches(FIELD_NAME, { message: FIELD_NAME_MESSAGE })
	@IsOptional()
	field_name?: string;

	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'La etiqueta debe ser texto' })
	@MinLength(1, { message: 'La etiqueta no puede quedar vacía' })
	@MaxLength(100, { message: 'La etiqueta no puede superar 100 caracteres' })
	@IsOptional()
	field_label?: string;

	@ApiPropertyOptional({ enum: CUSTOM_FIELD_TYPES })
	@IsIn(CUSTOM_FIELD_TYPES, { message: FIELD_TYPE_MESSAGE })
	@IsOptional()
	field_type?: CustomFieldType;

	@ApiPropertyOptional({ type: [CustomFieldOptionDto], nullable: true })
	@ValidateIf((_, value) => value !== null && value !== undefined)
	@IsArray({ message: 'Las opciones deben ser una lista' })
	@ArrayMinSize(1, { message: 'Las opciones son obligatorias para un campo de lista' })
	@ArrayMaxSize(100, { message: 'Un campo de lista admite hasta 100 opciones' })
	@ValidateNested({ each: true })
	@Type(() => CustomFieldOptionDto)
	options?: CustomFieldOptionDto[] | null;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Obligatorio debe ser sí o no' })
	@IsOptional()
	is_required?: boolean;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'Activo debe ser sí o no' })
	@IsOptional()
	is_active?: boolean;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsInt({ message: 'El orden debe ser un número entero mayor o igual a 0' })
	@Min(0, { message: 'El orden debe ser un número entero mayor o igual a 0' })
	@IsOptional()
	display_order?: number;
}
