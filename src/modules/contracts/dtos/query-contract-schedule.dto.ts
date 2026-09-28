import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** Query de `GET /contracts/:id/schedule`. */
export class QueryContractScheduleDto {
	@ApiPropertyOptional({ enum: ['true', 'false'], default: 'false', description: 'Incluye las facturas canceladas o inactivas (estado cancelled)' })
	@IsIn(['true', 'false'])
	@IsOptional()
	includeCancelled?: 'true' | 'false';
}
