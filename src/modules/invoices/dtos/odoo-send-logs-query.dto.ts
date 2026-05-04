import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

export class OdooSendLogsQueryDto {
	@ApiPropertyOptional({
		description: 'Filtrar por estado del log',
		enum: ['success', 'error', 'skipped'],
		example: 'success',
	})
	@IsOptional()
	@IsEnum(['success', 'error', 'skipped'])
	status?: 'success' | 'error' | 'skipped';

	@ApiPropertyOptional({
		description: 'Filtrar por tipo de operación',
		enum: ['create_draft', 'post_invoice'],
		example: 'create_draft',
	})
	@IsOptional()
	@IsEnum(['create_draft', 'post_invoice'])
	operation?: 'create_draft' | 'post_invoice';

	@ApiPropertyOptional({
		description: 'Fecha de inicio (ISO 8601)',
		example: '2026-05-01T00:00:00.000Z',
	})
	@IsOptional()
	@IsDateString()
	startDate?: string;

	@ApiPropertyOptional({
		description: 'Fecha de fin (ISO 8601)',
		example: '2026-05-31T23:59:59.999Z',
	})
	@IsOptional()
	@IsDateString()
	endDate?: string;

	@ApiPropertyOptional({
		description: 'Filtrar por ID de factura de Sapira',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@IsOptional()
	@IsString()
	invoice_id?: string;
}
