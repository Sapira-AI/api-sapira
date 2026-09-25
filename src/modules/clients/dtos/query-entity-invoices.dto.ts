import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class QueryEntityInvoicesDto {
	@ApiPropertyOptional({ description: 'Filtrar por cliente comercial' })
	@IsUUID()
	@IsOptional()
	client_id?: string;

	@ApiPropertyOptional({
		description: 'Estado: abiertas, vencidas, pagadas o todas (sin "Por Emitir")',
		enum: ['open', 'overdue', 'paid', 'all'],
		default: 'all',
	})
	@IsIn(['open', 'overdue', 'paid', 'all'])
	@IsOptional()
	status?: 'open' | 'overdue' | 'paid' | 'all';

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
