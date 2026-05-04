import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class OdooSendLogItemDto {
	@ApiProperty({
		description: 'ID del log en MongoDB',
		example: '663f1234567890abcdef1234',
	})
	_id: string;

	@ApiProperty({
		description: 'ID del holding',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	holding_id: string;

	@ApiProperty({
		description: 'ID de la factura en Sapira',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	invoice_id: string;

	@ApiProperty({
		description: 'Número de factura',
		example: 'F-2026-001',
	})
	invoice_number: string;

	@ApiPropertyOptional({
		description: 'ID de la factura en Odoo',
		example: 12345,
	})
	odoo_invoice_id?: number;

	@ApiProperty({
		description: 'Tipo de operación',
		enum: ['create_draft', 'post_invoice'],
		example: 'create_draft',
	})
	operation: string;

	@ApiProperty({
		description: 'Estado del log',
		enum: ['success', 'error', 'skipped'],
		example: 'success',
	})
	status: string;

	@ApiProperty({
		description: 'Nombre del cliente',
		example: 'Acme Corp',
	})
	client_name: string;

	@ApiProperty({
		description: 'Nombre de la compañía',
		example: 'Mi Empresa SAS',
	})
	company_name: string;

	@ApiPropertyOptional({
		description: 'Moneda de la factura',
		example: 'COP',
	})
	invoice_currency?: string;

	@ApiPropertyOptional({
		description: 'Monto de la factura',
		example: 1000000,
	})
	invoice_amount?: number;

	@ApiPropertyOptional({
		description: 'Datos de la petición enviada',
		type: 'object',
	})
	request_data?: any;

	@ApiPropertyOptional({
		description: 'Datos de la respuesta recibida',
		type: 'object',
	})
	response_data?: any;

	@ApiPropertyOptional({
		description: 'Mensaje de error (si aplica)',
		example: 'Error al crear factura en Odoo',
	})
	error_message?: string;

	@ApiPropertyOptional({
		description: 'Tipo de error (si aplica)',
		example: 'odoo_api_error',
	})
	error_type?: string;

	@ApiPropertyOptional({
		description: 'Detalles adicionales del error',
		type: 'object',
	})
	error_details?: any;

	@ApiPropertyOptional({
		description: 'Duración de la operación en milisegundos',
		example: 1234,
	})
	duration_ms?: number;

	@ApiProperty({
		description: 'Fecha de creación del log',
		example: '2026-05-01T12:00:00.000Z',
	})
	createdAt: Date;

	@ApiProperty({
		description: 'Fecha de última actualización del log',
		example: '2026-05-01T12:00:00.000Z',
	})
	updatedAt: Date;
}

export class OdooSendLogsResponseDto {
	@ApiProperty({
		description: 'Total de registros encontrados',
		example: 150,
	})
	total: number;

	@ApiProperty({
		description: 'Lista de logs de envío a Odoo',
		type: [OdooSendLogItemDto],
	})
	logs: OdooSendLogItemDto[];
}
