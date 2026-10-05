import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ApproveRunDto {
	/**
	 * Compatibilidad con el front actual, que todavía lo manda: el holding sale de `HoldingScopeGuard`,
	 * que rechaza (403) un valor distinto al de `x-holding-id`. El servicio lo ignora.
	 */
	@ApiPropertyOptional({ deprecated: true, description: 'Compatibilidad: debe coincidir con x-holding-id; se ignora' })
	@IsOptional()
	@IsUUID()
	holding_id?: string;
}
