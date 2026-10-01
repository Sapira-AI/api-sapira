import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

import { QUOTE_DERIVED_STATUSES, QUOTE_STAGE_KINDS, QUOTE_TYPE_CODES } from '../quote-status';

const UUID_LIST =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49}$/i;
const CURRENCY_LIST = /^[A-Za-z]{3,6}(,[A-Za-z]{3,6}){0,19}$/;
const TEXT_LIST = /^[\p{L}\p{N} ._-]{1,60}(,[\p{L}\p{N} ._-]{1,60}){0,29}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOOL = ['true', 'false'] as const;
const list = (values: readonly string[]) => new RegExp(`^(${values.join('|')})(,(${values.join('|')})){0,9}$`);

/** Campos de orden de `GET /quotes` (lista blanca `QUOTE_SORT_FIELDS`, mapa §6). */
export const QUOTE_SORT_FIELDS = [
	'quote_number',
	'client_name',
	'status',
	'stage',
	'seller',
	'quote_type',
	'total_amount',
	'mrr',
	'currency',
	'quote_date',
	'booking_date',
	'valid_until',
	'created_at',
	'contract',
	'items_count',
] as const;
export type QuoteSortField = (typeof QUOTE_SORT_FIELDS)[number];

/** Query de `GET /quotes`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryQuotesDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 25, maximum: 500, description: 'Hasta 500 para que el exportador recorra el conjunto en pocas páginas' })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(500)
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({
		description: `Estado mostrado; varios separados por coma (${QUOTE_DERIVED_STATUSES.join(', ')}); \`open\` = draft + sent + expired`,
	})
	@Matches(list([...QUOTE_DERIVED_STATUSES, 'open', 'all']), {
		message: `status debe ser uno o varios de: ${QUOTE_DERIVED_STATUSES.join(', ')}, open`,
	})
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({ description: `Kind de la etapa guardada; varios separados por coma (${QUOTE_STAGE_KINDS.join(', ')})` })
	@Matches(list(QUOTE_STAGE_KINDS), { message: `kind debe ser uno o varios de: ${QUOTE_STAGE_KINDS.join(', ')}` })
	@IsOptional()
	kind?: string;

	@ApiPropertyOptional({ description: 'Etapa configurada del holding; varias separadas por coma' })
	@Matches(UUID_LIST, { message: 'stageId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	stageId?: string;

	@ApiPropertyOptional({
		description: 'Busca por número, cliente, RUT/tax id de sus razones sociales, producto de cualquier ítem u oportunidad SF',
	})
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ description: 'Cliente comercial; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'clientId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Razón social: cotizaciones de los clientes comerciales asociados a ella' })
	@Matches(UUID_LIST, { message: 'entityId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	entityId?: string;

	@ApiPropertyOptional({ description: 'Vendedor; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'sellerId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	sellerId?: string;

	@ApiPropertyOptional({ description: 'Moneda de la cotización; varias separadas por coma' })
	@Matches(CURRENCY_LIST, { message: 'currency debe ser uno o varios códigos de moneda separados por coma' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({
		description: `Tipo de negocio (código: ${QUOTE_TYPE_CODES.join(', ')}); varios separados por coma. Cubre las grafías viejas`,
	})
	@Matches(list(QUOTE_TYPE_CODES), { message: `quoteType debe ser uno o varios de: ${QUOTE_TYPE_CODES.join(', ')}` })
	@IsOptional()
	quoteType?: string;

	@ApiPropertyOptional({ description: 'Cotizaciones con al menos un ítem de alguno de estos productos; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'productId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	productId?: string;

	@ApiPropertyOptional({ description: 'País del cliente comercial; varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'clientCountry debe ser uno o varios países separados por coma' })
	@IsOptional()
	clientCountry?: string;

	@ApiPropertyOptional({ enum: ['salesforce', 'manual'], description: 'Origen: con `salesforce_opportunity_id` o manual' })
	@IsIn(['salesforce', 'manual'])
	@IsOptional()
	origin?: 'salesforce' | 'manual';

	@ApiPropertyOptional({ enum: BOOL, description: 'Con contrato vinculado (creado o aplicado)' })
	@IsIn(BOOL)
	@IsOptional()
	hasContract?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Válida hasta desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'validUntilFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	validUntilFrom?: string;

	@ApiPropertyOptional({ description: 'Válida hasta hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'validUntilTo debe ser YYYY-MM-DD' })
	@IsOptional()
	validUntilTo?: string;

	@ApiPropertyOptional({ description: 'Booking desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'bookingFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	bookingFrom?: string;

	@ApiPropertyOptional({ description: 'Booking hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'bookingTo debe ser YYYY-MM-DD' })
	@IsOptional()
	bookingTo?: string;

	@ApiPropertyOptional({ description: 'Fecha de cotización desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'quoteDateFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	quoteDateFrom?: string;

	@ApiPropertyOptional({ description: 'Fecha de cotización hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'quoteDateTo debe ser YYYY-MM-DD' })
	@IsOptional()
	quoteDateTo?: string;

	@ApiPropertyOptional({ description: 'Creada desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'createdFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	createdFrom?: string;

	@ApiPropertyOptional({ description: 'Creada hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'createdTo debe ser YYYY-MM-DD' })
	@IsOptional()
	createdTo?: string;

	@ApiPropertyOptional({ description: 'Monto total mínimo (moneda de la cotización)' })
	@Type(() => Number)
	@IsNumber()
	@IsOptional()
	amountMin?: number;

	@ApiPropertyOptional({ description: 'Monto total máximo (moneda de la cotización)' })
	@Type(() => Number)
	@IsNumber()
	@IsOptional()
	amountMax?: number;

	@ApiPropertyOptional({ enum: QUOTE_SORT_FIELDS, default: 'quote_date' })
	@IsIn(QUOTE_SORT_FIELDS)
	@IsOptional()
	sortBy?: QuoteSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}

/** Query de `GET /quotes/form-options`. */
export class QueryQuoteFormOptionsDto {
	@ApiPropertyOptional({ description: 'Cliente: afina contactos, vendedor y tipo de negocio sugeridos, moneda y condición de pago por defecto' })
	@Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { message: 'clientId inválido' })
	@IsOptional()
	clientId?: string;
}
