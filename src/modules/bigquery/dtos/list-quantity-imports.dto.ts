import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { QUANTITY_IMPORT_STATUSES, QuantityImportStatus } from '@/databases/postgresql/entities/facturacion/sapira-quantity-import.entity';

/** Filtros del listado de auditoría del canal automático DWH → quantities. */
export class ListQuantityImportsDto {
	@ApiPropertyOptional({
		description: 'Filtra por resultado del mapeo. Útil para revisar por qué una fila no se integró.',
		enum: QUANTITY_IMPORT_STATUSES,
	})
	@IsOptional()
	@IsIn(QUANTITY_IMPORT_STATUSES as unknown as string[])
	integration_status?: QuantityImportStatus;

	@ApiPropertyOptional({ description: 'Período puntual (primer día del mes, YYYY-MM-01). Tiene prioridad sobre `from`/`to`.' })
	@IsOptional()
	@IsString()
	period?: string;

	@ApiPropertyOptional({
		description: 'Inicio del rango a auditar, en formato `YYYY-MM-DD`. Debe enviarse junto con `to`.',
		example: '2026-07-01',
		format: 'date',
	})
	@IsOptional()
	@Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from debe tener formato YYYY-MM-DD (por ejemplo 2026-07-01)' })
	from?: string;

	@ApiPropertyOptional({
		description: 'Fin del rango a auditar, en formato `YYYY-MM-DD`. Debe enviarse junto con `from`.',
		example: '2026-07-31',
		format: 'date',
	})
	@IsOptional()
	@Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to debe tener formato YYYY-MM-DD (por ejemplo 2026-07-31)' })
	to?: string;

	@ApiPropertyOptional({ default: 100, maximum: 500 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(500)
	limit?: number;

	@ApiPropertyOptional({ default: 0 })
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(0)
	offset?: number;
}
