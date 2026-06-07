import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsDateString, IsOptional, IsString } from 'class-validator';

export class SalesforceSyncCompleteDto {
	@ApiPropertyOptional({
		description: 'Fecha desde (YYYY-MM-DD)',
		example: '2024-01-01',
	})
	@IsOptional()
	@IsDateString()
	dateFrom?: string;

	@ApiPropertyOptional({
		description: 'Fecha hasta (YYYY-MM-DD)',
		example: '2024-01-31',
	})
	@IsOptional()
	@IsDateString()
	dateTo?: string;

	@ApiPropertyOptional({
		description: 'IDs específicos de oportunidades a sincronizar (opcional, si no se envía sincroniza todas)',
		type: [String],
		example: ['006RO00000czj8nYAA', '006RO00000d3MLkYAM'],
	})
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	opportunityIds?: string[];

	@ApiPropertyOptional({
		description: 'Sincronizar clientes',
		default: true,
	})
	@IsOptional()
	@IsBoolean()
	syncClients?: boolean = true;

	@ApiPropertyOptional({
		description: 'Sincronizar cotizaciones',
		default: true,
	})
	@IsOptional()
	@IsBoolean()
	syncQuotes?: boolean = true;

	@ApiPropertyOptional({
		description: 'Sincronizar productos',
		default: true,
	})
	@IsOptional()
	@IsBoolean()
	syncProducts?: boolean = true;
}

export class SyncCompleteStats {
	@ApiProperty({ description: 'Número de oportunidades procesadas' })
	opportunities: number;

	@ApiProperty({ description: 'Número de clientes creados' })
	clientsCreated: number;

	@ApiProperty({ description: 'Número de clientes actualizados' })
	clientsUpdated: number;

	@ApiProperty({ description: 'Número de cotizaciones creadas' })
	quotesCreated: number;

	@ApiProperty({ description: 'Número de cotizaciones actualizadas' })
	quotesUpdated: number;

	@ApiProperty({ description: 'Número de productos sincronizados' })
	productsSynced: number;

	@ApiProperty({ description: 'Número de items de cotización creados' })
	quoteItemsCreated: number;

	@ApiProperty({ description: 'Número de vendedores creados' })
	sellersCreated: number;

	@ApiProperty({ description: 'Errores encontrados' })
	errors: string[];
}

export class SyncCompleteResponseDto {
	@ApiProperty({ description: 'ID del holding' })
	holding_id: string;

	@ApiProperty({ description: 'Éxito de la sincronización' })
	success: boolean;

	@ApiProperty({ description: 'Estadísticas de sincronización', type: SyncCompleteStats })
	stats: SyncCompleteStats;

	@ApiPropertyOptional({ description: 'Mensaje de error si falló' })
	error?: string;

	@ApiProperty({ description: 'Fecha de inicio de sincronización' })
	started_at: Date;

	@ApiProperty({ description: 'Fecha de fin de sincronización' })
	completed_at: Date;

	@ApiProperty({ description: 'Duración en segundos' })
	duration_seconds: number;
}

export class SyncCompleteAllResponseDto {
	@ApiProperty({ description: 'Total de holdings procesados' })
	total_holdings: number;

	@ApiProperty({ description: 'Holdings exitosos' })
	successful: number;

	@ApiProperty({ description: 'Holdings fallidos' })
	failed: number;

	@ApiProperty({ description: 'Resultados por holding', type: [SyncCompleteResponseDto] })
	results: SyncCompleteResponseDto[];

	@ApiProperty({ description: 'Duración total en segundos' })
	total_duration_seconds: number;
}
