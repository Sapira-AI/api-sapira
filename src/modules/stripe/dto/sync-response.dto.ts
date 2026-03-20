import { ApiProperty } from '@nestjs/swagger';

export class SyncStatsDto {
	@ApiProperty({ description: 'Total de registros procesados' })
	totalProcessed: number;

	@ApiProperty({ description: 'Registros creados exitosamente' })
	created: number;

	@ApiProperty({ description: 'Registros actualizados exitosamente' })
	updated: number;

	@ApiProperty({ description: 'Registros con errores' })
	errors: number;

	@ApiProperty({ description: 'Registros marcados como inválidos' })
	invalid: number;

	@ApiProperty({ description: 'Registros omitidos' })
	skipped: number;
}

export class EntitySyncStatsDto {
	@ApiProperty({ description: 'Estadísticas de clientes' })
	customers: SyncStatsDto;

	@ApiProperty({ description: 'Estadísticas de suscripciones' })
	subscriptions: SyncStatsDto;

	@ApiProperty({ description: 'Estadísticas de items de suscripción' })
	subscriptionItems: SyncStatsDto;

	@ApiProperty({ description: 'Estadísticas de facturas' })
	invoices: SyncStatsDto;

	@ApiProperty({ description: 'Estadísticas de items de factura' })
	invoiceItems: SyncStatsDto;
}

export class SyncResponseDto {
	@ApiProperty({ description: 'Indica si la sincronización fue exitosa' })
	success: boolean;

	@ApiProperty({ description: 'Mensaje descriptivo del resultado' })
	message: string;

	@ApiProperty({ description: 'Estadísticas detalladas por entidad' })
	stats: EntitySyncStatsDto;

	@ApiProperty({ description: 'Errores encontrados durante el proceso', required: false })
	errors?: string[];
}
