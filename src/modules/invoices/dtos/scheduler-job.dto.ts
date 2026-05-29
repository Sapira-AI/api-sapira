import { ApiProperty } from '@nestjs/swagger';

import { ProcessInvoicesResponseDto } from './send-invoices.dto';

export class StartSchedulerJobResponseDto {
	@ApiProperty({
		description: 'ID del job creado',
		example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
	})
	jobId: string;

	@ApiProperty({
		description: 'Mensaje de confirmación',
		example: 'Scheduler job iniciado exitosamente',
	})
	message: string;

	@ApiProperty({
		description: 'Indica si es dry run',
		example: true,
	})
	dryRun: boolean;
}

export class SchedulerJobProgressDto {
	@ApiProperty({
		description: 'Total de facturas a procesar',
		example: 100,
	})
	total: number;

	@ApiProperty({
		description: 'Número de factura actual siendo procesada',
		example: 45,
	})
	current: number;

	@ApiProperty({
		description: 'Facturas enviadas exitosamente',
		example: 40,
	})
	sent: number;

	@ApiProperty({
		description: 'Facturas con errores',
		example: 3,
	})
	errors: number;

	@ApiProperty({
		description: 'Facturas omitidas',
		example: 2,
	})
	skipped: number;
}

export class SchedulerJobStatusDto {
	@ApiProperty({
		description: 'ID del job',
		example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
	})
	jobId: string;

	@ApiProperty({
		description: 'Estado del job',
		enum: ['pending', 'running', 'completed', 'failed'],
		example: 'running',
	})
	status: 'pending' | 'running' | 'completed' | 'failed';

	@ApiProperty({
		description: 'Progreso actual del job',
		type: SchedulerJobProgressDto,
	})
	progress: SchedulerJobProgressDto;

	@ApiProperty({
		description: 'Resultado completo (solo cuando status es completed)',
		type: ProcessInvoicesResponseDto,
		required: false,
	})
	result?: ProcessInvoicesResponseDto;

	@ApiProperty({
		description: 'Mensaje de error (solo cuando status es failed)',
		required: false,
		example: 'Error crítico al procesar facturas',
	})
	error?: string;

	@ApiProperty({
		description: 'Indica si es dry run',
		example: true,
	})
	dryRun: boolean;

	@ApiProperty({
		description: 'Fecha de inicio',
		example: '2026-05-25T10:00:00.000Z',
	})
	startedAt: Date;

	@ApiProperty({
		description: 'Fecha de finalización',
		required: false,
		example: '2026-05-25T10:05:00.000Z',
	})
	completedAt?: Date;
}

export class SchedulerJobListItemDto {
	@ApiProperty({
		description: 'ID del job',
		example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
	})
	jobId: string;

	@ApiProperty({
		description: 'Estado del job',
		enum: ['pending', 'running', 'completed', 'failed'],
		example: 'completed',
	})
	status: 'pending' | 'running' | 'completed' | 'failed';

	@ApiProperty({
		description: 'Indica si es dry run',
		example: true,
	})
	dryRun: boolean;

	@ApiProperty({
		description: 'ID del contrato (si aplica)',
		required: false,
		example: 'contract-123',
	})
	contractId?: string;

	@ApiProperty({
		description: 'Resumen del resultado',
		type: SchedulerJobProgressDto,
	})
	progress: SchedulerJobProgressDto;

	@ApiProperty({
		description: 'Fecha de inicio',
		example: '2026-05-25T10:00:00.000Z',
	})
	startedAt: Date;

	@ApiProperty({
		description: 'Fecha de finalización',
		required: false,
		example: '2026-05-25T10:05:00.000Z',
	})
	completedAt?: Date;
}
