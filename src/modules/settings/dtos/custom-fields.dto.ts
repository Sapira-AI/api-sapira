import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';

import { trim } from './holding.dto';

export const CUSTOM_FIELD_ENTITY_TYPES = ['client', 'contract', 'contract_item', 'quote', 'quote_item', 'invoice', 'invoice_item'] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];
export const CUSTOM_FIELD_TYPES = ['text', 'number'] as const;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const FIELD_NAME_MESSAGE = 'El nombre interno va en snake_case: minúsculas, números y guion bajo, empezando con letra (máx. 63)';

export class CustomFieldsQueryDto {
	@ApiPropertyOptional({ enum: CUSTOM_FIELD_ENTITY_TYPES })
	@IsIn(CUSTOM_FIELD_ENTITY_TYPES, { message: `entity_type debe ser uno de: ${CUSTOM_FIELD_ENTITY_TYPES.join(', ')}` })
	@IsOptional()
	entity_type?: CustomFieldEntityType;
}

export class CreateCustomFieldDto {
	@ApiProperty({ enum: CUSTOM_FIELD_ENTITY_TYPES })
	@IsIn(CUSTOM_FIELD_ENTITY_TYPES, { message: `entity_type debe ser uno de: ${CUSTOM_FIELD_ENTITY_TYPES.join(', ')}` })
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
	@IsIn(CUSTOM_FIELD_TYPES, { message: 'field_type debe ser text o number' })
	field_type!: (typeof CUSTOM_FIELD_TYPES)[number];

	@ApiPropertyOptional({ default: false })
	@IsBoolean({ message: 'is_required debe ser verdadero o falso' })
	@IsOptional()
	is_required?: boolean;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsInt({ message: 'display_order debe ser un entero ≥ 0' })
	@Min(0, { message: 'display_order debe ser un entero ≥ 0' })
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
	@IsIn(CUSTOM_FIELD_TYPES, { message: 'field_type debe ser text o number' })
	@IsOptional()
	field_type?: (typeof CUSTOM_FIELD_TYPES)[number];

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_required debe ser verdadero o falso' })
	@IsOptional()
	is_required?: boolean;

	@ApiPropertyOptional()
	@IsBoolean({ message: 'is_active debe ser verdadero o falso' })
	@IsOptional()
	is_active?: boolean;

	@ApiPropertyOptional()
	@Type(() => Number)
	@IsInt({ message: 'display_order debe ser un entero ≥ 0' })
	@Min(0, { message: 'display_order debe ser un entero ≥ 0' })
	@IsOptional()
	display_order?: number;
}
