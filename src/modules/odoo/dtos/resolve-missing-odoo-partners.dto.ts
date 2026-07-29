import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ResolveMissingOdooPartnersDto {
	@ApiPropertyOptional({
		description: 'Cuando es true no escribe datos y solo informa el resultado esperado',
		default: true,
	})
	@IsOptional()
	@IsBoolean()
	dryRun = true;

	@ApiPropertyOptional({
		description: 'Máximo de ejemplos por resultado',
		default: 20,
		minimum: 1,
		maximum: 100,
	})
	@IsOptional()
	@Type(() => Number)
	@IsInt()
	@Min(1)
	@Max(100)
	sampleSize = 20;
}

export class ResolveMissingOdooPartnersResponseDto {
	@ApiProperty({ description: 'Indica si la operación fue solo de simulación' })
	dryRun: boolean;

	@ApiProperty({ description: 'Entidades legales evaluadas' })
	evaluated: number;

	@ApiProperty({ description: 'Entidades con partner Odoo único nuevo o distinto' })
	wouldUpdate: number;

	@ApiProperty({ description: 'Entidades actualizadas en ejecución real porque su partner era nuevo o cambió' })
	updated: number;

	@ApiProperty({ description: 'Entidades cuyo partner Odoo ya coincide y no requieren escritura' })
	unchanged: number;

	@ApiProperty({ description: 'Entidades sin coincidencia, ambiguas o sin RUT válido' })
	unresolved: number;

	@ApiProperty({ description: 'Ejemplos de resultados' })
	examples: Array<{
		clientEntityId: string;
		legalName: string | null;
		taxId: string | null;
		status: 'would_create' | 'would_update' | 'updated' | 'unchanged' | 'not_found' | 'ambiguous' | 'missing_legal_name' | 'invalid_tax_id';
		odooPartnerId?: number;
		message: string;
	}>;
}
