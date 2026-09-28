import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

export const CONTRACT_INVOICE_SORT_FIELDS = ['issue_date', 'amount', 'status'] as const;
export type ContractInvoiceSortField = (typeof CONTRACT_INVOICE_SORT_FIELDS)[number];

/**
 * `pending` = Por Emitir activas; `issued` = Emitida, Enviada, Vencida o Pagada activas;
 * `cancelled` = Cancelada o inactivas (consolidadas en otra factura).
 */
export const CONTRACT_INVOICE_STATUS_FILTERS = ['all', 'pending', 'issued', 'cancelled'] as const;
export type ContractInvoiceStatusFilter = (typeof CONTRACT_INVOICE_STATUS_FILTERS)[number];

/** Query de `GET /contracts/:id/invoices`. */
export class QueryContractInvoicesDto {
	@ApiPropertyOptional({ default: 1 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@IsOptional()
	page?: number;

	@ApiPropertyOptional({ default: 50, maximum: 200 })
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(200)
	@IsOptional()
	limit?: number;

	@ApiPropertyOptional({ enum: CONTRACT_INVOICE_STATUS_FILTERS, default: 'all' })
	@IsIn(CONTRACT_INVOICE_STATUS_FILTERS)
	@IsOptional()
	status?: ContractInvoiceStatusFilter;

	@ApiPropertyOptional({ enum: CONTRACT_INVOICE_SORT_FIELDS, default: 'issue_date' })
	@IsIn(CONTRACT_INVOICE_SORT_FIELDS)
	@IsOptional()
	sortBy?: ContractInvoiceSortField;

	@ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
	@IsIn(['asc', 'desc'])
	@IsOptional()
	sortOrder?: 'asc' | 'desc';
}
