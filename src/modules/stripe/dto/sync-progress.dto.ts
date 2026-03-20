import { ApiProperty } from '@nestjs/swagger';

export interface SyncProgressDto {
	customers: {
		total: number;
		processed: number;
		current?: string;
	};
	subscriptions: {
		total: number;
		processed: number;
		current?: string;
	};
	invoices: {
		total: number;
		processed: number;
		current?: string;
	};
	currentPhase: 'customers' | 'subscriptions' | 'invoices' | 'completed';
	overallProgress: number;
}

export class SyncJobStatusDto {
	@ApiProperty({ description: 'ID del job' })
	jobId: string;

	@ApiProperty({ description: 'Estado del job' })
	status: 'running' | 'completed' | 'failed';

	@ApiProperty({ description: 'Progreso actual', required: false })
	progress?: SyncProgressDto;

	@ApiProperty({ description: 'Estadísticas finales', required: false })
	stats?: any;

	@ApiProperty({ description: 'Errores encontrados', required: false })
	errors?: string[];

	@ApiProperty({ description: 'Mensaje de error', required: false })
	errorMessage?: string;

	@ApiProperty({ description: 'Fecha de creación' })
	createdAt: Date;

	@ApiProperty({ description: 'Fecha de actualización' })
	updatedAt: Date;

	@ApiProperty({ description: 'Fecha de completado', required: false })
	completedAt?: Date;
}
