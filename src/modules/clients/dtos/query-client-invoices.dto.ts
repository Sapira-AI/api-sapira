import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export const CLIENT_INVOICE_SORT_FIELDS = ['issue_date', 'due_date', 'amount', 'invoice_number', 'status', 'days_overdue'] as const;
export type ClientInvoiceSortField = (typeof CLIENT_INVOICE_SORT_FIELDS)[number];
export const CLIENT_INVOICE_STATUS_FILTERS = ['all', 'open', 'overdue', 'paid'] as const;
export type ClientInvoiceStatusFilter = (typeof CLIENT_INVOICE_STATUS_FILTERS)[number];

export class QueryClientInvoicesDto {
	@ApiPropertyOptional({
		description: 'Estado: abiertas, vencidas, pagadas o todas (sin "Por Emitir")',
		enum: CLIENT_INVOICE_STATUS_FILTERS,
		default: 'all',
	})
	@IsIn(CLIENT_INVOICE_STATUS_FILTERS)
	@IsOptional()
	status?: ClientInvoiceStatusFilter;

	@ApiPropertyOptional({ description: 'Filtrar por razón social' })
	@IsUUID()
	@IsOptional()
	client_entity_id?: string;

	@ApiPropertyOptional({ description: 'Busca por número de factura' })
	@IsString()
	@MaxLength(80)
	@IsOptional()
	search?: string;

	@ApiPropertyOptional({ enum: CLIENT_INVOICE_SORT_FIELDS, default: 'issue_date' })
	@IsIn(CLIENT_INVOICE_SORT_FIELDS)
	@IsOptional()
	sort_by?: ClientInvoiceSortField;

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

	@ApiPropertyOptional({ default: 20 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	@IsOptional()
	limit?: number;
}
