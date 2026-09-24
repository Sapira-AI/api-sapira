import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const CLIENT_CONTRACT_SORT_FIELDS = ['contract_number', 'start_date', 'end_date', 'mrr', 'total_value', 'status'] as const;
export type ClientContractSortField = (typeof CLIENT_CONTRACT_SORT_FIELDS)[number];
export const CLIENT_CONTRACT_STATUS_FILTERS = ['all', 'active', 'in_review', 'cancelled'] as const;
export type ClientContractStatusFilter = (typeof CLIENT_CONTRACT_STATUS_FILTERS)[number];

/** Query de `GET /clients/:id/contracts`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryClientContractsDto {
	@ApiPropertyOptional({ description: 'Estado: activos, en revisión, cancelados o todos', enum: CLIENT_CONTRACT_STATUS_FILTERS, default: 'all' })
	@IsIn(CLIENT_CONTRACT_STATUS_FILTERS)
	@IsOptional()
	status?: ClientContractStatusFilter;

	@ApiPropertyOptional({ description: 'Filtrar por razón social' })
	@IsUUID()
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
