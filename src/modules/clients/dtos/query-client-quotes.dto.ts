import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const CLIENT_QUOTE_SORT_FIELDS = ['quote_date', 'quote_number', 'total_amount', 'stage'] as const;
export type ClientQuoteSortField = (typeof CLIENT_QUOTE_SORT_FIELDS)[number];

/** Query de `GET /clients/:id/quotes`. El holding sale de `HoldingScopeGuard`, nunca de la query. */
export class QueryClientQuotesDto {
	@ApiPropertyOptional({ description: 'Etapa de la cotización (las etapas son configurables por holding)' })
	@IsUUID()
	@IsOptional()
	stage_id?: string;

	@ApiPropertyOptional({ description: 'Busca por número de cotización' })
	@IsString()
	@MaxLength(80)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ enum: CLIENT_QUOTE_SORT_FIELDS, default: 'quote_date' })
	@IsIn(CLIENT_QUOTE_SORT_FIELDS)
	@IsOptional()
	sort_by?: ClientQuoteSortField;

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
