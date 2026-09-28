import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

/** UUID de una razón social, o `none` para los contratos sin razón social. */
const UUID_OR_NONE = /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** Uno o varios UUID separados por coma (filtros de selección múltiple). */
const UUID_LIST =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49}$/i;
/** Uno o varios códigos de moneda separados por coma. */
const CURRENCY_LIST = /^[A-Za-z]{3,6}(,[A-Za-z]{3,6}){0,19}$/;

export const CONTRACT_SORT_FIELDS = [
	'contract_number',
	'client_name',
	'start_date',
	'end_date',
	'next_item_end_date',
	'mrr',
	'total_value',
	'status',
	'type',
	'legal_name',
	'company_name',
	'products',
	'contract_currency',
	'auto_send_to_odoo',
	'auto_invoice',
	'seller',
	'client_country',
	'entity_country',
	'quote',
	'client_segment',
	'client_market',
	'client_industry',
] as const;
export type ContractSortField = (typeof CONTRACT_SORT_FIELDS)[number];

/**
 * Estado mostrado (derivado al leer, ver `contract-status.ts`): `active`, `pending_renewal` (Por renovar), `expired`,
 * `draft` (En revisión), `paused` (Pausado) y `cancelled`. `in_review` se acepta como alias de `draft`.
 */
export const CONTRACT_STATUS_FILTERS = ['all', 'active', 'pending_renewal', 'expired', 'draft', 'paused', 'cancelled'] as const;
export type ContractStatusFilter = (typeof CONTRACT_STATUS_FILTERS)[number];
const STATUS_VALUES = [...CONTRACT_STATUS_FILTERS, 'in_review'];
/** Uno o varios estados separados por coma (lista blanca). */
const STATUS_LIST = new RegExp(`^(${STATUS_VALUES.join('|')})(,(${STATUS_VALUES.join('|')})){0,9}$`);
/** Texto libre acotado para tipos y países: letras (con tildes), números, espacio, punto, guion y guion bajo. */
const TEXT_LIST = /^[\p{L}\p{N} ._-]{1,60}(,[\p{L}\p{N} ._-]{1,60}){0,29}$/u;
/** Segmento, mercado e industria del cliente: textos libres de master data (pueden traer `/`, `&`, paréntesis). */
const CLIENT_TEXT_LIST = /^[\p{L}\p{N} ._\-/&()']{1,80}(,[\p{L}\p{N} ._\-/&()']{1,80}){0,49}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BOOL = ['true', 'false'] as const;

/** Query de `GET /contracts`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryContractsDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	/** Hasta 500 para que el exportador del navegador recorra el conjunto filtrado en pocas páginas. */
	@ApiPropertyOptional({ default: 25, maximum: 500 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(500)
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({
		description: `Estado mostrado; varios separados por coma (${CONTRACT_STATUS_FILTERS.join(', ')}). \`in_review\` = alias de \`draft\``,
		default: 'all',
	})
	@Matches(STATUS_LIST, { message: `status debe ser uno o varios de: ${CONTRACT_STATUS_FILTERS.join(', ')}` })
	@IsOptional()
	status?: string;

	@ApiPropertyOptional({ description: 'Busca por número de contrato, cliente comercial o razón social' })
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ description: 'Cliente comercial' })
	@IsUUID()
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Razón social; `none` = sin razón social' })
	@Matches(UUID_OR_NONE, { message: 'entityId debe ser un UUID o none' })
	@IsOptional()
	entityId?: string;

	@ApiPropertyOptional({ description: 'Compañía emisora; varias separadas por coma' })
	@Matches(UUID_LIST, { message: 'companyId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	companyId?: string;

	@ApiPropertyOptional({ description: 'Moneda del contrato (ej. USD, CLP); varias separadas por coma' })
	@Matches(CURRENCY_LIST, { message: 'currency debe ser uno o varios códigos de moneda separados por coma' })
	@IsOptional()
	currency?: string;

	@ApiPropertyOptional({ description: 'Contratos con al menos un ítem de alguno de estos productos; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'productId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	productId?: string;

	@ApiPropertyOptional({ description: 'Contratos activos cuyo próximo fin de ítem cae entre hoy y hoy + N días' })
	@Type(() => Number)
	@IsInt()
	@Min(0)
	@Max(3650)
	@IsOptional()
	endingWithinDays?: number;

	@ApiPropertyOptional({ enum: ['true', 'false'], description: 'Envío automático a Odoo (NULL cuenta como sí, igual que el scheduler)' })
	@IsIn(['true', 'false'])
	@IsOptional()
	autoSendToOdoo?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Tipo de contrato (contracts.type); varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'type debe ser uno o varios tipos separados por coma' })
	@IsOptional()
	type?: string;

	@ApiPropertyOptional({ description: 'Valor total mínimo en moneda del sistema' })
	@Type(() => Number)
	@IsNumber()
	@IsOptional()
	minValue?: number;

	@ApiPropertyOptional({ description: 'Valor total máximo en moneda del sistema' })
	@Type(() => Number)
	@IsNumber()
	@IsOptional()
	maxValue?: number;

	@ApiPropertyOptional({ description: 'Inicio (primer ítem) desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'startFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	startFrom?: string;

	@ApiPropertyOptional({ description: 'Inicio (primer ítem) hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'startTo debe ser YYYY-MM-DD' })
	@IsOptional()
	startTo?: string;

	@ApiPropertyOptional({ description: 'Fin del contrato desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'endFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	endFrom?: string;

	@ApiPropertyOptional({ description: 'Fin del contrato hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'endTo debe ser YYYY-MM-DD' })
	@IsOptional()
	endTo?: string;

	@ApiPropertyOptional({ description: 'Próximo fin de ítem desde, YYYY-MM-DD' })
	@Matches(DATE, { message: 'nextEndFrom debe ser YYYY-MM-DD' })
	@IsOptional()
	nextEndFrom?: string;

	@ApiPropertyOptional({ description: 'Próximo fin de ítem hasta, YYYY-MM-DD' })
	@Matches(DATE, { message: 'nextEndTo debe ser YYYY-MM-DD' })
	@IsOptional()
	nextEndTo?: string;

	@ApiPropertyOptional({ enum: BOOL, description: 'Requiere facturación multicompañía' })
	@IsIn(BOOL)
	@IsOptional()
	multicompany?: 'true' | 'false';

	@ApiPropertyOptional({ enum: BOOL, description: 'Requiere facturación multimoneda' })
	@IsIn(BOOL)
	@IsOptional()
	multicurrency?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Segmento del cliente comercial (clients.segment); varios separados por coma' })
	@Matches(CLIENT_TEXT_LIST, { message: 'segment debe ser uno o varios segmentos separados por coma' })
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional({ description: 'Mercado del cliente comercial (clients.market); varios separados por coma' })
	@Matches(CLIENT_TEXT_LIST, { message: 'market debe ser uno o varios mercados separados por coma' })
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({ description: 'Industria del cliente comercial (clients.industry); varias separadas por coma' })
	@Matches(CLIENT_TEXT_LIST, { message: 'industry debe ser una o varias industrias separadas por coma' })
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional({ description: 'País del cliente comercial (clients.country); varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'clientCountry debe ser uno o varios países separados por coma' })
	@IsOptional()
	clientCountry?: string;

	@ApiPropertyOptional({ description: 'País de la razón social (client_entities.country); varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'entityCountry debe ser uno o varios países separados por coma' })
	@IsOptional()
	entityCountry?: string;

	@ApiPropertyOptional({ enum: BOOL, description: 'Facturación automática (contracts.auto_invoice; NULL cuenta como no)' })
	@IsIn(BOOL)
	@IsOptional()
	autoInvoice?: 'true' | 'false';

	@ApiPropertyOptional({ enum: BOOL, description: 'Tiene al menos una factura con id de Odoo (ERP)' })
	@IsIn(BOOL)
	@IsOptional()
	hasErpInvoice?: 'true' | 'false';

	@ApiPropertyOptional({ description: 'Vendedor de la cotización de origen (quotes.seller_id vía contracts.quote_id); varios separados por coma' })
	@Matches(UUID_LIST, { message: 'sellerId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	sellerId?: string;

	@ApiPropertyOptional({ enum: CONTRACT_SORT_FIELDS, default: 'start_date' })
	@IsIn(CONTRACT_SORT_FIELDS)
	@IsOptional()
	sortBy?: ContractSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}
