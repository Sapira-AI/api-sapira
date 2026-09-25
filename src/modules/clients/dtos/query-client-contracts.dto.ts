import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';

/** UUID de una razón social, o `none` para lo que no tiene razón social. */
export const UUID_OR_NONE = /^(none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const CLIENT_CONTRACT_SORT_FIELDS = ['contract_number', 'start_date', 'end_date', 'mrr', 'total_value', 'status'] as const;
export type ClientContractSortField = (typeof CLIENT_CONTRACT_SORT_FIELDS)[number];
/** `active` = vigente (Activo con fin ≥ hoy o sin fin); `expired` = Activo con fin pasado (vencido sin renovar). */
export const CLIENT_CONTRACT_STATUS_FILTERS = ['all', 'active', 'expired', 'in_review', 'cancelled'] as const;
export type ClientContractStatusFilter = (typeof CLIENT_CONTRACT_STATUS_FILTERS)[number];

/** Query de `GET /clients/:id/contracts`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryClientContractsDto {
	@ApiPropertyOptional({ description: 'Estado: activos, en revisión, cancelados o todos', enum: CLIENT_CONTRACT_STATUS_FILTERS, default: 'all' })
	@IsIn(CLIENT_CONTRACT_STATUS_FILTERS)
	@IsOptional()
	status?: ClientContractStatusFilter;

	@ApiPropertyOptional({ description: 'Filtrar por razón social; `none` = sin razón social' })
	@Matches(UUID_OR_NONE, { message: 'client_entity_id debe ser un UUID o none' })
	@IsOptional()
	client_entity_id?: string;

	@ApiPropertyOptional({ description: 'Busca por número de contrato' })
	@IsString()
	@MaxLength(80)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ enum: CLIENT_CONTRACT_SORT_FIELDS, default: 'start_date' })
	@IsIn(CLIENT_CONTRACT_SORT_FIELDS)
	@IsOptional()
	sort_by?: ClientContractSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sort_order?: 'asc' | 'desc';

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
}

/** Query de `GET /client-entities/:id/contracts`: mismos filtros, por cliente comercial en vez de razón social. */
export class QueryEntityContractsDto extends OmitType(QueryClientContractsDto, ['client_entity_id'] as const) {
	@ApiPropertyOptional({ description: 'Filtrar por cliente comercial (una razón social puede facturar a varios)' })
	@IsUUID()
	@IsOptional()
	client_id?: string;
}
