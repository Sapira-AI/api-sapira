import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

import { CONTACT_SORT_FIELDS, ENTITY_SORT_FIELDS } from '../client-directory.service';

class PaginatedHoldingQuery {
	@ApiProperty({ description: 'ID del holding' })
	@IsUUID()
	holding_id!: string;

	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({ description: 'Búsqueda parcial' })
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ enum: ['asc', 'desc'] })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sort_order?: 'asc' | 'desc';
}

export class QueryClientEntitiesDto extends PaginatedHoldingQuery {
	@ApiPropertyOptional({ enum: Object.keys(ENTITY_SORT_FIELDS) })
	@IsIn(Object.keys(ENTITY_SORT_FIELDS))
	@IsOptional()
	sort_by?: keyof typeof ENTITY_SORT_FIELDS;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(80)
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({ description: 'Solo razones sociales sin cliente comercial asignado' })
	@Transform(({ value }) => value === true || value === 'true')
	@IsBoolean()
	@IsOptional()
	unassigned?: boolean;
}

export class QueryClientContactsDto extends PaginatedHoldingQuery {
	@ApiPropertyOptional({ enum: Object.keys(CONTACT_SORT_FIELDS) })
	@IsIn(Object.keys(CONTACT_SORT_FIELDS))
	@IsOptional()
	sort_by?: keyof typeof CONTACT_SORT_FIELDS;

	@ApiPropertyOptional()
	@IsUUID()
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(60)
	@IsOptional()
	contact_type?: string;
}

export class AssignClientEntitiesDto {
	@ApiProperty()
	@IsUUID()
	holding_id!: string;

	@ApiProperty({ description: 'Cliente comercial al que se vinculan' })
	@IsUUID()
	client_id!: string;

	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(100)
	@IsUUID('all', { each: true })
	entity_ids!: string[];

	@ApiPropertyOptional({ default: true, description: 'Si el cliente no tiene principal, la primera pasa a serlo' })
	@IsBoolean()
	@IsOptional()
	make_primary_if_none?: boolean;
}

export class UpdateClientEntityDto {
	@ApiProperty()
	@IsUUID()
	holding_id!: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	legal_name?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(40)
	@IsOptional()
	tax_id?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(80)
	@IsOptional()
	country?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(300)
	@IsOptional()
	legal_address?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	email?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(60)
	@IsOptional()
	phone?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	economic_activity?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(80)
	@IsOptional()
	client_number?: string;

	@ApiPropertyOptional({ description: 'Guardar aunque el RUT ya exista en otra razón social del holding (tras confirmar la alerta)' })
	@IsBoolean()
	@IsOptional()
	allow_duplicate_tax_id?: boolean;
}

export class ContactFieldsDto {
	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	name?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	position?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(200)
	@IsOptional()
	email?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(60)
	@IsOptional()
	phone?: string;

	@ApiPropertyOptional({ example: 'Facturación' })
	@IsString()
	@MaxLength(60)
	@IsOptional()
	contact_type?: string;

	@ApiPropertyOptional()
	@IsUUID()
	@IsOptional()
	client_id?: string;
}

export class UpsertClientContactDto extends ContactFieldsDto {
	@ApiProperty()
	@IsUUID()
	holding_id!: string;
}

export class BulkUpdateContactsDto {
	@ApiProperty()
	@IsUUID()
	holding_id!: string;

	@ApiProperty({ type: [String] })
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(100)
	@IsUUID('all', { each: true })
	contact_ids!: string[];

	@ApiPropertyOptional()
	@IsUUID()
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional()
	@IsString()
	@MaxLength(60)
	@IsOptional()
	contact_type?: string;
}
