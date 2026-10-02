import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LIST =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}){0,49}$/i;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TEXT_LIST = /^[^,]{1,120}(,[^,]{1,120}){0,29}$/;
const list = (values: readonly string[]) => new RegExp(`^(${values.join('|')})(,(${values.join('|')})){0,9}$`);

export const METRIC_CURRENCIES = ['system', 'company', 'contract'] as const;
export const METRIC_SOURCES = ['contract', 'subscription', 'legacy'] as const;
export const MRR_DIMENSIONS = [
	'client',
	'product',
	'segment',
	'industry',
	'market',
	'company',
	'item_type',
	'unit_of_measure',
	'country',
	'source',
] as const;
export const REVENUE_DIMENSIONS = ['client', 'client_entity', 'client_country', 'entity_country', 'product', 'company', 'recurring'] as const;
export const MOVEMENT_GROUPS = ['client', 'contract', 'item', 'segment', 'market'] as const;
export const SCHEDULE_SORT_FIELDS = [
	'period',
	'contract_number',
	'client_name',
	'company_name',
	'product',
	'recognized',
	'billed',
	'deferred_eom',
	'unbilled_eom',
	'mrr',
] as const;

export type MetricCurrency = (typeof METRIC_CURRENCIES)[number];
export type MrrDimension = (typeof MRR_DIMENSIONS)[number];
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];
export type MovementGroup = (typeof MOVEMENT_GROUPS)[number];
export type ScheduleSortField = (typeof SCHEDULE_SORT_FIELDS)[number];

/**
 * Filtros comunes de `/metrics/*` (spec-revenue-y-metricas §3). Listas separadas por coma. El holding sale de `HoldingScopeGuard`,
 * nunca de la query. `currency=company` exige un `companyId`; `currency=contract`, un `contractId` (§1.1).
 */
export class MetricsFiltersDto {
	@ApiPropertyOptional({ description: 'Mes inicial YYYY-MM (default: 11 meses antes de `to`)' })
	@Matches(MONTH, { message: 'from debe ser YYYY-MM' })
	@IsOptional()
	from?: string;

	@ApiPropertyOptional({ description: 'Mes final YYYY-MM (default: mes actual)' })
	@Matches(MONTH, { message: 'to debe ser YYYY-MM' })
	@IsOptional()
	to?: string;

	@ApiPropertyOptional({ enum: METRIC_CURRENCIES, default: 'system' })
	@IsIn(METRIC_CURRENCIES)
	@IsOptional()
	currency?: MetricCurrency;

	@ApiPropertyOptional({ description: 'Compañía emisora; varias separadas por coma (una sola con currency=company)' })
	@Matches(UUID_LIST, { message: 'companyId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	companyId?: string;

	@ApiPropertyOptional({ description: 'Cliente comercial; varios separados por coma' })
	@Matches(UUID_LIST, { message: 'clientId debe ser uno o varios UUID separados por coma' })
	@IsOptional()
	clientId?: string;

	@ApiPropertyOptional({ description: 'Contrato (obligatorio con currency=contract)' })
	@Matches(UUID, { message: 'contractId debe ser un UUID' })
	@IsOptional()
	contractId?: string;

	@ApiPropertyOptional({ description: 'Producto (nombre); varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'product debe ser uno o varios nombres separados por coma' })
	@IsOptional()
	product?: string;

	@ApiPropertyOptional({ description: 'Segmento del cliente; varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'segment inválido' })
	@IsOptional()
	segment?: string;

	@ApiPropertyOptional({ description: 'Mercado del cliente; varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'market inválido' })
	@IsOptional()
	market?: string;

	@ApiPropertyOptional({ description: 'Industria del cliente; varias separadas por coma' })
	@Matches(TEXT_LIST, { message: 'industry inválido' })
	@IsOptional()
	industry?: string;

	@ApiPropertyOptional({ description: 'País del cliente; varios separados por coma' })
	@Matches(TEXT_LIST, { message: 'country inválido' })
	@IsOptional()
	country?: string;

	@ApiPropertyOptional({ description: `Origen del MRR (${METRIC_SOURCES.join(', ')}); varios separados por coma` })
	@Matches(list(METRIC_SOURCES), { message: `source debe ser uno o varios de: ${METRIC_SOURCES.join(', ')}` })
	@IsOptional()
	source?: string;
}

export class MrrBasisDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ enum: ['mrr', 'cmrr'], default: 'mrr', description: 'MRR vigente o CMRR contratado (incluye firmados no iniciados)' })
	@IsIn(['mrr', 'cmrr'])
	@IsOptional()
	basis?: 'mrr' | 'cmrr';
}

export class MrrOverviewDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ description: 'Mes de corte YYYY-MM (default: mes actual)' })
	@Matches(MONTH, { message: 'asOf debe ser YYYY-MM' })
	@IsOptional()
	asOf?: string;
}

class PageDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 50, maximum: 1000 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(1000)
	@IsOptional()
	limit?: number;
}

export class MovementDetailDto extends PageDto {
	@ApiPropertyOptional({ enum: ['mrr', 'cmrr'], default: 'mrr' })
	@IsIn(['mrr', 'cmrr'])
	@IsOptional()
	basis?: 'mrr' | 'cmrr';

	@ApiPropertyOptional({ description: 'Categorías (new, expansion, reactivation, contraction, churn, fx, other); varias separadas por coma' })
	@Matches(list(['new', 'expansion', 'reactivation', 'contraction', 'churn', 'fx', 'other']), { message: 'category inválida' })
	@IsOptional()
	category?: string;

	@ApiPropertyOptional({ description: 'Subcategorías (momentum o derivadas); varias separadas por coma' })
	@Matches(/^[A-Z_-]{2,40}(,[A-Z_-]{2,40}){0,19}$/, { message: 'key inválida' })
	@IsOptional()
	key?: string;

	@ApiPropertyOptional({ enum: MOVEMENT_GROUPS, default: 'item' })
	@IsIn(MOVEMENT_GROUPS)
	@IsOptional()
	groupBy?: MovementGroup;
}

export class MrrDimensionDto extends MrrBasisDto {
	@ApiPropertyOptional({ enum: MRR_DIMENSIONS, default: 'client' })
	@IsIn(MRR_DIMENSIONS)
	@IsOptional()
	dimension?: MrrDimension;

	@ApiPropertyOptional({ default: 15, maximum: 100 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	top?: number;
}

export class CohortsDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ enum: ['revenue', 'logos'], default: 'revenue' })
	@IsIn(['revenue', 'logos'])
	@IsOptional()
	basis?: 'revenue' | 'logos';

	@ApiPropertyOptional({ enum: ['month', 'quarter'], default: 'month' })
	@IsIn(['month', 'quarter'])
	@IsOptional()
	grain?: 'month' | 'quarter';
}

export class ChurnDetailDto extends PageDto {}

export class RenewalsDto extends PageDto {
	@ApiPropertyOptional({ enum: ['30', '90', '180', '365', 'overdue'], default: '90', description: 'Próximos N días o vencidos sin decisión' })
	@IsIn(['30', '90', '180', '365', 'overdue'])
	@IsOptional()
	window?: '30' | '90' | '180' | '365' | 'overdue';
}

export class BookingsDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ enum: ['month', 'company', 'client'], default: 'month' })
	@IsIn(['month', 'company', 'client'])
	@IsOptional()
	groupBy?: 'month' | 'company' | 'client';
}

export class RevenueDimensionDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ enum: REVENUE_DIMENSIONS, default: 'client' })
	@IsIn(REVENUE_DIMENSIONS)
	@IsOptional()
	dimension?: RevenueDimension;

	@ApiPropertyOptional({ enum: ['recognized', 'billed'], default: 'recognized' })
	@IsIn(['recognized', 'billed'])
	@IsOptional()
	measure?: 'recognized' | 'billed';

	@ApiPropertyOptional({ default: 10, maximum: 100 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	top?: number;
}

export class RevenueForwardDto extends MetricsFiltersDto {
	@ApiPropertyOptional({ description: 'Mes de corte YYYY-MM (default: mes actual)' })
	@Matches(MONTH, { message: 'asOf debe ser YYYY-MM' })
	@IsOptional()
	asOf?: string;
}

export class RevenueScheduleDto extends PageDto {
	@ApiPropertyOptional({ enum: SCHEDULE_SORT_FIELDS, default: 'period' })
	@IsIn(SCHEDULE_SORT_FIELDS)
	@IsOptional()
	sortBy?: ScheduleSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';

	@ApiPropertyOptional({ description: 'Busca por número de contrato, cliente o producto' })
	@IsString()
	@MaxLength(120)
	@IsOptional()
	search?: string;
}

export class RevenueJournalDto extends MetricsFiltersDto {}

export class ExceptionsDto extends PageDto {}
