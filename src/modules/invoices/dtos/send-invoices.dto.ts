import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class SendInvoicesDto {
	@ApiProperty({
		description: 'Modo dry run (solo simula, no envía a Odoo)',
		default: true,
		required: false,
		example: true,
	})
	@IsOptional()
	@IsBoolean()
	dryRun?: boolean = true;
}

export class InvoiceResultDto {
	@ApiProperty({
		description: 'ID de la factura en Sapira',
		example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
	})
	invoiceId: string;

	@ApiProperty({
		description: 'Número de factura',
		example: 'FAC-2026-001',
	})
	invoiceNumber: string;

	@ApiProperty({
		description: 'Nombre del cliente',
		required: false,
		example: 'Acme Corporation',
	})
	clientName?: string;

	@ApiProperty({
		description: 'Nombre de la compañía',
		required: false,
		example: 'Mi Empresa S.A.',
	})
	companyName?: string;

	@ApiProperty({
		description: 'Fecha de emisión de la factura',
		required: false,
		example: '2026-03-09',
	})
	issueDate?: Date;

	@ApiProperty({
		description: 'Estado del procesamiento',
		enum: ['sent', 'error', 'skipped'],
		example: 'sent',
	})
	status: 'sent' | 'error' | 'skipped';

	@ApiProperty({
		description: 'ID de la factura en Odoo (si se envió exitosamente)',
		required: false,
		example: 12345,
	})
	odooInvoiceId?: number;

	@ApiProperty({
		description: 'Mensaje de error (si falló)',
		required: false,
		example: 'Partner no encontrado en Odoo',
	})
	error?: string;

	@ApiProperty({
		description: 'Detalles adicionales del procesamiento',
		required: false,
		example: 'Factura enviada exitosamente a Odoo',
	})
	details?: string;
}

export class ProcessInvoicesSummaryDto {
	@ApiProperty({
		description: 'Total de facturas procesadas',
		example: 10,
	})
	total: number;

	@ApiProperty({
		description: 'Facturas enviadas exitosamente',
		example: 8,
	})
	sent: number;

	@ApiProperty({
		description: 'Facturas con errores',
		example: 1,
	})
	errors: number;

	@ApiProperty({
		description: 'Facturas omitidas (no cumplen criterios)',
		example: 1,
	})
	skipped: number;
}

export class ProcessInvoicesResponseDto {
	@ApiProperty({
		description: 'Indica si el proceso completó sin errores críticos',
		example: true,
	})
	success: boolean;

	@ApiProperty({
		description: 'Indica si fue una ejecución en modo dry run',
		example: true,
	})
	dryRun: boolean;

	@ApiProperty({
		description: 'Resumen del procesamiento',
		type: ProcessInvoicesSummaryDto,
	})
	summary: ProcessInvoicesSummaryDto;

	@ApiProperty({
		description: 'Resultados detallados por factura',
		type: [InvoiceResultDto],
	})
	results: InvoiceResultDto[];

	@ApiProperty({
		description: 'Timestamp de la ejecución',
		example: '2026-03-06T09:00:00.000Z',
	})
	executedAt: Date;
}

export class SchedulerStatusDto {
	@ApiProperty({
		description: 'Indica si el scheduler está habilitado',
		example: true,
	})
	enabled: boolean;

	@ApiProperty({
		description: 'Hora configurada para ejecución (0-23)',
		example: 9,
	})
	scheduledHour: number;

	@ApiProperty({
		description: 'Indica si el scheduler está ejecutándose actualmente',
		example: false,
	})
	isRunning: boolean;

	@ApiProperty({
		description: 'Timestamp de la última ejecución',
		required: false,
		example: '2026-03-06T09:00:00.000Z',
	})
	lastExecution?: Date;

	@ApiProperty({
		description: 'Resultado de la última ejecución',
		required: false,
	})
	lastResult?: ProcessInvoicesSummaryDto;
}
