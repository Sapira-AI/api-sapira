import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export const AGENT_TYPES = ['proforma', 'collections'] as const;
export const RUN_STATUSES = ['queued', 'approved', 'sent', 'error', 'cancelled'] as const;

/** Filtros del historial de ejecuciones (`GET /agents/runs`). */
export class ListRunsQueryDto {
	@ApiPropertyOptional({ default: 1 })
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: 'page debe ser un número entero' })
	@Min(1, { message: 'page debe ser 1 o más' })
	page = 1;

	@ApiPropertyOptional({ default: 20, maximum: 100 })
	@IsOptional()
	@Type(() => Number)
	@IsInt({ message: 'limit debe ser un número entero' })
	@Min(1, { message: 'limit debe ser 1 o más' })
	@Max(100, { message: 'limit no puede superar 100' })
	limit = 20;

	@ApiPropertyOptional()
	@IsOptional()
	@IsUUID('4', { message: 'agent_id debe ser un UUID' })
	agent_id?: string;

	@ApiPropertyOptional({ enum: AGENT_TYPES })
	@IsOptional()
	@IsIn(AGENT_TYPES, { message: 'type debe ser proforma o collections' })
	type?: (typeof AGENT_TYPES)[number];

	@ApiPropertyOptional({ enum: RUN_STATUSES })
	@IsOptional()
	@IsIn(RUN_STATUSES, { message: 'Estado de ejecución inválido' })
	status?: (typeof RUN_STATUSES)[number];
}
