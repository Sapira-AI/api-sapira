import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';

import { PRICE_MODELS, type PriceModel } from '../pricing-engine';

import { PriceSpecDto } from './create-contract.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const present = (value: unknown) => value !== null && value !== undefined;
const CURRENCY = /^[A-Z]{2,4}$/;

/** Columnas por las que se ordena `GET /prices` (lista blanca; el SQL nunca recibe la query cruda). */
export const PRICE_SORT_FIELDS = ['name', 'product_name', 'currency', 'model', 'version', 'status', 'contracts_count', 'updated_at'] as const;
export type PriceSortField = (typeof PRICE_SORT_FIELDS)[number];
export const PRICE_STATUS_FILTERS = ['active', 'draft', 'archived', 'all'] as const;
export type PriceStatusFilter = (typeof PRICE_STATUS_FILTERS)[number];

/** Query de `GET /prices` (catálogo, Pricing v2 etapa 3). El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryPricesDto {
	@ApiPropertyOptional({ enum: ['catalog'], default: 'catalog', description: 'Solo el catálogo se lista; los precios inline viven en su contrato' })
	@IsIn(['catalog'], { message: 'Solo se lista el catálogo (owner = catalog)' })
	@IsOptional()
	owner?: 'catalog';

	@ApiPropertyOptional({ enum: PRICE_STATUS_FILTERS, default: 'all' })
	@IsIn(PRICE_STATUS_FILTERS, { message: 'Estado inválido: active, draft, archived o all' })
	@IsOptional()
	status?: PriceStatusFilter;

	@ApiPropertyOptional({ description: 'Producto del catálogo' })
	@IsUUID(undefined, { message: 'Producto inválido' })
	@IsOptional()
	product_id?: string;

	@ApiPropertyOptional({ example: 'CLP' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda inválida' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ enum: PRICE_MODELS })
	@IsIn(PRICE_MODELS, { message: 'Modelo inválido' })
	@IsOptional()
	model?: PriceModel;

	@ApiPropertyOptional({ description: 'Busca por nombre del precio o del producto' })
	@Transform(trim)
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ enum: PRICE_SORT_FIELDS, default: 'updated_at' })
	@IsIn(PRICE_SORT_FIELDS, { message: 'Orden inválido' })
	@IsOptional()
	sortBy?: PriceSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'], { message: 'Orden inválido' })
	@IsOptional()
	sortOrder?: 'asc' | 'desc';

	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt({ message: 'Página inválida' })
	@Min(1, { message: 'Página inválida' })
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25, maximum: 200 })
	@Type(() => Number)
	@IsInt({ message: 'Límite inválido' })
	@Min(1, { message: 'Límite inválido' })
	@Max(200, { message: 'Máximo 200 por página' })
	@IsOptional()
	limit?: number;
}

/** Body de `POST /prices`: nace en borrador con la versión siguiente del mismo producto + moneda. */
export class CreatePriceDto {
	@ApiProperty({ example: 'Tramos LatAm — UF', description: 'Etiqueta del precio (se copia al contrato como nombre del precio)' })
	@Transform(trim)
	@IsString({ message: 'Escribe el nombre del precio' })
	@MinLength(1, { message: 'Escribe el nombre del precio' })
	@MaxLength(160, { message: 'El nombre no puede superar 160 caracteres' })
	name!: string;

	@ApiProperty({ description: 'Producto del holding al que pertenece el precio' })
	@IsUUID(undefined, { message: 'Producto inválido' })
	product_id!: string;

	@ApiProperty({ example: 'CLP', description: 'Moneda del precio; solo se puede usar en contratos de esa moneda' })
	@Transform(upper)
	@Matches(CURRENCY, { message: 'Moneda inválida' })
	currency!: string;

	@ApiProperty({ type: PriceSpecDto, description: 'Modelo de precio (misma forma que `items[].price` al crear un contrato)' })
	@ValidateNested()
	@Type(() => PriceSpecDto)
	spec!: PriceSpecDto;

	@ApiPropertyOptional({ description: 'Nota interna de la versión (qué cambió, para quién aplica)' })
	@ValidateIf((_dto: CreatePriceDto, value: unknown) => present(value))
	@Transform(trim)
	@IsString({ message: 'Nota inválida' })
	@MaxLength(2000, { message: 'La nota no puede superar 2.000 caracteres' })
	notes?: string | null;
}

/** Body de `PATCH /prices/:id` (solo borradores): nombre, modelo y nota. Producto y moneda definen la cadena de versiones y no cambian. */
export class UpdatePriceDto {
	@ApiPropertyOptional()
	@Transform(trim)
	@IsString({ message: 'Escribe el nombre del precio' })
	@MinLength(1, { message: 'Escribe el nombre del precio' })
	@MaxLength(160, { message: 'El nombre no puede superar 160 caracteres' })
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ type: PriceSpecDto })
	@ValidateIf((_dto: UpdatePriceDto, value: unknown) => present(value))
	@ValidateNested()
	@Type(() => PriceSpecDto)
	spec?: PriceSpecDto;

	@ApiPropertyOptional()
	@ValidateIf((_dto: UpdatePriceDto, value: unknown) => present(value))
	@Transform(trim)
	@IsString({ message: 'Nota inválida' })
	@MaxLength(2000, { message: 'La nota no puede superar 2.000 caracteres' })
	notes?: string | null;
}

/** Body de `POST /prices/:id/new-version`: copia la versión como borrador; lo que venga reemplaza a la copia. */
export class NewPriceVersionDto extends UpdatePriceDto {}
