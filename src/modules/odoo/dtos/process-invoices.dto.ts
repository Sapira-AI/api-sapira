import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class ProcessInvoicesDto {
	@ApiPropertyOptional({
		description: 'Tamaño del lote para procesar facturas. Determina cuántas facturas se procesan en cada iteración.',
		example: 500,
		default: 500,
		minimum: 1,
	})
	@IsOptional()
	@IsNumber()
	@Min(1)
	batchSize?: number = 500;
}

export class InvoiceDetailDto {
	@ApiProperty({
		description: 'ID de la factura en Odoo',
		example: 12345,
	})
	invoice_id: number;

	@ApiProperty({
		description: 'Estado del procesamiento de la factura',
		enum: ['success', 'error'],
		example: 'success',
	})
	status: 'success' | 'error';

	@ApiPropertyOptional({
		description: 'Mensaje de error si el procesamiento falló',
		example: 'No se encontró configuración de mapeo',
	})
	error?: string;
}

export class ProcessInvoicesResponseDto {
	@ApiProperty({
		description: 'Indica si el procesamiento fue exitoso',
		example: true,
	})
	success: boolean;

	@ApiProperty({
		description: 'Número de facturas procesadas exitosamente',
		example: 150,
	})
	processed: number;

	@ApiProperty({
		description: 'Número de facturas con errores durante el procesamiento',
		example: 2,
	})
	errors: number;

	@ApiProperty({
		description: 'Mensaje descriptivo del resultado del procesamiento',
		example: 'Se procesaron 150 facturas exitosamente',
	})
	message: string;

	@ApiPropertyOptional({
		description: 'Detalles del procesamiento de cada factura',
		type: [InvoiceDetailDto],
	})
	details?: InvoiceDetailDto[];
}

export class InvoiceStatsResponseDto {
	@ApiProperty({
		description: 'Total de facturas en staging',
		example: 500,
	})
	total: number;

	@ApiProperty({
		description: 'Facturas pendientes de procesar (con estado create o update)',
		example: 150,
	})
	pending: number;

	@ApiProperty({
		description: 'Facturas ya procesadas exitosamente',
		example: 340,
	})
	processed: number;

	@ApiProperty({
		description: 'Facturas con errores de procesamiento',
		example: 10,
	})
	errors: number;
}

export class InvoiceStatusCountsResponseDto {
	@ApiProperty({
		description: 'Facturas con estado "create"',
		example: 50,
	})
	create: number;

	@ApiProperty({
		description: 'Facturas con estado "update"',
		example: 30,
	})
	update: number;

	@ApiProperty({
		description: 'Facturas con estado "processed"',
		example: 340,
	})
	processed: number;

	@ApiProperty({
		description: 'Facturas con estado "error"',
		example: 10,
	})
	error: number;

	@ApiProperty({
		description: 'Facturas sin estado (null)',
		example: 5,
	})
	null: number;
}

export class GetInvoicesQueryDto {
	@ApiPropertyOptional({
		description: 'Término de búsqueda para filtrar por nombre o referencia de factura',
		example: 'INV/2024',
	})
	@IsOptional()
	searchTerm?: string;

	@ApiPropertyOptional({
		description: 'Estados de procesamiento para filtrar (separados por coma)',
		example: 'create,update',
	})
	@IsOptional()
	statusFilter?: string;

	@ApiPropertyOptional({
		description: 'Número de página (base 1)',
		example: 1,
		default: 1,
		minimum: 1,
	})
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	page?: number = 1;

	@ApiPropertyOptional({
		description: 'Cantidad de registros por página',
		example: 20,
		default: 20,
		minimum: 1,
		maximum: 100,
	})
	@IsOptional()
	@Type(() => Number)
	@IsNumber()
	@Min(1)
	limit?: number = 20;
}

export class InvoiceLineDto {
	@ApiProperty({ description: 'ID de la línea', example: '123e4567-e89b-12d3-a456-426614174000' })
	id: string;

	@ApiProperty({ description: 'ID de la factura en staging', example: '123e4567-e89b-12d3-a456-426614174000' })
	invoice_staging_id: string;

	@ApiProperty({ description: 'ID de la línea en Odoo', example: 12345 })
	odoo_line_id: number;

	@ApiProperty({ description: 'ID de la factura en Odoo', example: 12345 })
	odoo_invoice_id: number;

	@ApiProperty({ description: 'Datos raw de la línea desde Odoo' })
	raw_data: Record<string, any>;

	@ApiProperty({ description: 'Estado de procesamiento', example: 'pending' })
	processing_status: string | null;

	@ApiPropertyOptional({ description: 'Mensaje de error si existe' })
	error_message?: string | null;

	@ApiProperty({ description: 'Fecha de creación' })
	created_at: Date;
}

export class InvoiceWithLinesDto {
	@ApiProperty({ description: 'ID de la factura', example: '123e4567-e89b-12d3-a456-426614174000' })
	id: string;

	@ApiProperty({ description: 'ID de la factura en Odoo', example: 12345 })
	odoo_id: number;

	@ApiProperty({ description: 'Datos raw de la factura desde Odoo' })
	raw_data: Record<string, any>;

	@ApiProperty({ description: 'Estado de procesamiento', example: 'pending' })
	processing_status: string | null;

	@ApiPropertyOptional({ description: 'Mensaje de error si existe' })
	error_message?: string | null;

	@ApiProperty({ description: 'Fecha de creación' })
	created_at: Date;

	@ApiProperty({ description: 'Líneas de la factura', type: [InvoiceLineDto] })
	lines: InvoiceLineDto[];

	@ApiProperty({ description: 'Cantidad de líneas', example: 5 })
	lines_count: number;
}

export class GetInvoicesResponseDto {
	@ApiProperty({ description: 'Lista de facturas con sus líneas', type: [InvoiceWithLinesDto] })
	invoices: InvoiceWithLinesDto[];

	@ApiProperty({ description: 'Total de facturas (sin paginación)', example: 150 })
	total: number;

	@ApiProperty({ description: 'Página actual', example: 1 })
	page: number;

	@ApiProperty({ description: 'Registros por página', example: 20 })
	limit: number;

	@ApiProperty({ description: 'Total de páginas', example: 8 })
	totalPages: number;
}

export class SampleLineRawDataDto {
	@ApiProperty({ description: 'Datos raw de la línea desde Odoo' })
	raw_data: Record<string, any>;
}

export class GetSampleLinesResponseDto {
	@ApiProperty({ description: 'Lista de líneas de ejemplo con raw_data', type: [SampleLineRawDataDto] })
	lines: SampleLineRawDataDto[];

	@ApiProperty({ description: 'Cantidad de líneas retornadas', example: 10 })
	count: number;
}
