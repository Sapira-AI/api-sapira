import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsIn,
	IsInt,
	IsNotEmpty,
	IsOptional,
	IsString,
	IsUUID,
	Matches,
	Max,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested,
} from 'class-validator';

import { CONTACT_SORT_FIELDS, ENTITY_SORT_FIELDS } from '../client-directory.service';

/** Lista paginada del holding activo (el holding sale de `HoldingScopeGuard`, nunca de la query). */
class PaginatedHoldingQuery {
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

export const PAYMENT_TERM_KINDS = ['net', 'end_of_month', 'day_of_next_month'] as const;

/**
 * Condición de pago por defecto (espejo del CHECK `client_entities_payment_terms_check`):
 * `net` y `end_of_month` usan `days` (0–365); `day_of_next_month` usa `day` (1–31).
 */
export class PaymentTermsDto {
	@ApiProperty({ enum: PAYMENT_TERM_KINDS })
	@IsIn(PAYMENT_TERM_KINDS)
	kind!: (typeof PAYMENT_TERM_KINDS)[number];

	@ApiPropertyOptional({ description: 'Días (net: desde la emisión; end_of_month: desde el fin de mes)' })
	@ValidateIf((terms: PaymentTermsDto) => terms.kind !== 'day_of_next_month')
	@IsInt()
	@Min(0)
	@Max(365)
	days?: number;

	@ApiPropertyOptional({ description: 'Día del mes siguiente (day_of_next_month)' })
	@ValidateIf((terms: PaymentTermsDto) => terms.kind === 'day_of_next_month')
	@IsInt()
	@Min(1)
	@Max(31)
	day?: number;
}

export class UpdateClientEntityDto {
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

	@ApiPropertyOptional({
		description: 'País ISO 3166-1 alfa-2 (manda sobre `country`, que se escribe con el nombre en español)',
		example: 'CL',
		nullable: true,
	})
	@ValidateIf((_, value) => value !== null && value !== '')
	@Matches(/^[A-Za-z]{2}$/, { message: 'El país debe ser un código ISO de 2 letras' })
	@IsOptional()
	country_code?: string | null;

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

	@ApiPropertyOptional({ type: PaymentTermsDto, nullable: true, description: 'Condición de pago por defecto; null la quita' })
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	payment_terms?: PaymentTermsDto | null;

	@ApiPropertyOptional({ description: 'Guardar aunque el RUT ya exista en otra razón social del holding (tras confirmar la alerta)' })
	@IsBoolean()
	@IsOptional()
	allow_duplicate_tax_id?: boolean;
}

/** Alta de razón social (`POST /client-entities`): mismos campos que la edición, con cliente, nombre, RUT y país obligatorios. */
export class CreateClientEntityDto {
	@ApiProperty({ description: 'Cliente comercial al que queda ligada' })
	@IsUUID('all', { message: 'Elige un cliente comercial' })
	client_id!: string;

	@ApiProperty()
	@IsString({ message: 'Escribe la razón social' })
	@IsNotEmpty({ message: 'Escribe la razón social' })
	@MaxLength(200)
	legal_name!: string;

	@ApiProperty({ description: 'RUT / NIT / RFC…' })
	@IsString({ message: 'Escribe el identificador tributario' })
	@IsNotEmpty({ message: 'Escribe el identificador tributario' })
	@MaxLength(40)
	tax_id!: string;

	@ApiPropertyOptional({ example: 'Chile', description: 'País en texto (front actual); obligatorio este o `country_code`' })
	@IsString({ message: 'Escribe el país' })
	@MaxLength(80)
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({
		description: 'País ISO 3166-1 alfa-2 (manda sobre `country`, que se escribe con el nombre en español)',
		example: 'CL',
		nullable: true,
	})
	@ValidateIf((_, value) => value !== null && value !== '')
	@Matches(/^[A-Za-z]{2}$/, { message: 'El país debe ser un código ISO de 2 letras' })
	@IsOptional()
	country_code?: string | null;

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

	@ApiPropertyOptional({ type: PaymentTermsDto, nullable: true })
	@IsOptional()
	@ValidateIf((_, value) => value !== null)
	@ValidateNested()
	@Type(() => PaymentTermsDto)
	payment_terms?: PaymentTermsDto | null;

	@ApiPropertyOptional({ description: 'Crear aunque el RUT ya exista en otra razón social del holding (tras confirmar la alerta)' })
	@IsBoolean()
	@IsOptional()
	allow_duplicate_tax_id?: boolean;

	@ApiPropertyOptional({
		description:
			'"Traer desde ERP": partner del ERP con el que nace vinculada (misma transacción). 409 `partner_already_linked` si otra razón social lo usa; 404 si no existe o está archivado',
	})
	@Type(() => Number)
	@IsInt({ message: 'Cliente del ERP inválido' })
	@Min(1, { message: 'Cliente del ERP inválido' })
	@IsOptional()
	odoo_partner_id?: number;
}

/** "Traer desde ERP" (`POST /client-entities/erp-partner/search`): RUT o nombre tal como están en el ERP. */
export class SearchNewErpPartnerDto {
	@ApiProperty({ description: 'RUT o nombre a buscar' })
	@IsString({ message: 'Escribe el RUT o el nombre' })
	@IsNotEmpty({ message: 'Escribe el RUT o el nombre' })
	@MaxLength(120)
	query!: string;
}

/** Búsqueda de partners de Odoo para una razón social. Sin `query`: por su RUT (y su nombre si no aparece). */
export class SearchErpPartnerDto {
	@ApiPropertyOptional({ description: 'RUT o nombre a buscar' })
	@IsString()
	@MaxLength(120)
	@IsOptional()
	query?: string;
}

export class LinkErpPartnerDto {
	@ApiProperty({ description: 'ID del partner en Odoo' })
	@Type(() => Number)
	@IsInt({ message: 'Partner inválido' })
	@Min(1, { message: 'Partner inválido' })
	odoo_partner_id!: number;
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

export class UpsertClientContactDto extends ContactFieldsDto {}

export class BulkUpdateContactsDto {
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
