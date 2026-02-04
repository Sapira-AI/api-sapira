import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	GetInvoicesQueryDto,
	GetInvoicesResponseDto,
	GetSampleLinesResponseDto,
	InvoiceStatsResponseDto,
	InvoiceStatusCountsResponseDto,
	ProcessInvoicesDto,
	ProcessInvoicesResponseDto,
} from './dtos/process-invoices.dto';
import { InvoiceProcessingService } from './invoice-processing.service';

@ApiTags('Odoo - Invoice Processing')
@Controller('odoo/invoice-processing')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class InvoiceProcessingController {
	constructor(private readonly invoiceProcessingService: InvoiceProcessingService) {}

	@Post('process')
	@ApiOperation({
		summary: 'Procesar facturas desde staging a invoices_legacy',
		description:
			'Procesa facturas y sus líneas desde las tablas de staging (odoo_invoices_stg, odoo_invoice_lines_stg) hacia las tablas finales (invoices_legacy, invoice_items_legacy). ' +
			'Aplica transformaciones de campos según la configuración de mapeo del holding. ' +
			'Procesa en lotes para optimizar el rendimiento y maneja upserts automáticos.',
	})
	@ApiBody({
		type: ProcessInvoicesDto,
		description: 'Configuración del procesamiento',
		examples: {
			default: {
				summary: 'Procesamiento con tamaño de lote por defecto',
				value: {
					batchSize: 500,
				},
			},
			small: {
				summary: 'Procesamiento con lotes pequeños',
				value: {
					batchSize: 100,
				},
			},
		},
	})
	@ApiOkResponse({
		type: ProcessInvoicesResponseDto,
		description: 'Facturas procesadas exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				processed: { type: 'number', example: 150 },
				errors: { type: 'number', example: 2 },
				message: { type: 'string', example: 'Se procesaron 150 facturas exitosamente' },
				details: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							invoice_id: { type: 'number', example: 12345 },
							status: { type: 'string', enum: ['success', 'error'], example: 'success' },
							error: { type: 'string', example: 'Error message if status is error' },
						},
					},
				},
			},
		},
	})
	@ApiBadRequestResponse({
		description: 'Error en el procesamiento',
		schema: {
			type: 'object',
			properties: {
				statusCode: { type: 'number', example: 400 },
				message: { type: 'string', example: 'No se encontró configuración de mapeo para facturas' },
				error: { type: 'string', example: 'Bad Request' },
			},
		},
	})
	async processInvoices(@Headers('x-holding-id') holdingId: string, @Body() dto: ProcessInvoicesDto): Promise<ProcessInvoicesResponseDto> {
		return this.invoiceProcessingService.processInvoices(holdingId, dto.batchSize);
	}

	@Get('stats')
	@ApiOperation({
		summary: 'Obtener estadísticas de procesamiento de facturas',
		description:
			'Retorna estadísticas sobre el estado de las facturas en staging: ' +
			'total de facturas, facturas pendientes (create/update), facturas procesadas y facturas con error.',
	})
	@ApiOkResponse({
		type: InvoiceStatsResponseDto,
		description: 'Estadísticas obtenidas exitosamente',
		schema: {
			type: 'object',
			properties: {
				total: { type: 'number', example: 500, description: 'Total de facturas en staging' },
				pending: { type: 'number', example: 150, description: 'Facturas pendientes de procesar (create/update)' },
				processed: { type: 'number', example: 340, description: 'Facturas ya procesadas' },
				errors: { type: 'number', example: 10, description: 'Facturas con errores de procesamiento' },
			},
		},
	})
	@ApiBadRequestResponse({
		description: 'Error al obtener estadísticas',
		schema: {
			type: 'object',
			properties: {
				statusCode: { type: 'number', example: 400 },
				message: { type: 'string', example: 'Error al obtener estadísticas' },
				error: { type: 'string', example: 'Bad Request' },
			},
		},
	})
	async getStats(@Headers('x-holding-id') holdingId: string): Promise<InvoiceStatsResponseDto> {
		return this.invoiceProcessingService.getProcessingStats(holdingId);
	}

	@Get('status-counts')
	@ApiOperation({
		summary: 'Obtener conteos de facturas por estado',
		description:
			'Retorna el conteo de facturas agrupadas por su estado de procesamiento: ' + 'create, update, processed, error y null (sin estado).',
	})
	@ApiOkResponse({
		type: InvoiceStatusCountsResponseDto,
		description: 'Conteos obtenidos exitosamente',
		schema: {
			type: 'object',
			properties: {
				create: { type: 'number', example: 50, description: 'Facturas con estado "create"' },
				update: { type: 'number', example: 30, description: 'Facturas con estado "update"' },
				processed: { type: 'number', example: 340, description: 'Facturas con estado "processed"' },
				error: { type: 'number', example: 10, description: 'Facturas con estado "error"' },
				null: { type: 'number', example: 5, description: 'Facturas sin estado (null)' },
			},
		},
	})
	@ApiBadRequestResponse({
		description: 'Error al obtener conteos',
		schema: {
			type: 'object',
			properties: {
				statusCode: { type: 'number', example: 400 },
				message: { type: 'string', example: 'Error al obtener conteos por estado' },
				error: { type: 'string', example: 'Bad Request' },
			},
		},
	})
	async getStatusCounts(@Headers('x-holding-id') holdingId: string): Promise<InvoiceStatusCountsResponseDto> {
		return this.invoiceProcessingService.getStatusCounts(holdingId);
	}

	@Get('invoices')
	@ApiOperation({
		summary: 'Obtener facturas de staging con filtros y paginación',
		description:
			'Retorna facturas de staging con sus líneas asociadas. ' +
			'Soporta búsqueda por nombre o referencia, filtro por estado de procesamiento y paginación.',
	})
	@ApiOkResponse({
		type: GetInvoicesResponseDto,
		description: 'Facturas obtenidas exitosamente',
	})
	@ApiBadRequestResponse({
		description: 'Error al obtener facturas',
	})
	async getInvoices(@Headers('x-holding-id') holdingId: string, @Query() query: GetInvoicesQueryDto): Promise<GetInvoicesResponseDto> {
		const statusFilter = query.statusFilter ? query.statusFilter.split(',') : undefined;

		return this.invoiceProcessingService.getInvoicesWithLines(holdingId, query.searchTerm, statusFilter, query.page || 1, query.limit || 20);
	}

	@Get('sample-lines')
	@ApiOperation({
		summary: 'Obtener líneas de ejemplo para extracción de campos',
		description:
			'Retorna una muestra de líneas de facturas con sus datos raw (raw_data) desde Odoo. ' +
			'Útil para extraer los campos disponibles y mostrar ejemplos en la configuración de mapeo.',
	})
	@ApiOkResponse({
		type: GetSampleLinesResponseDto,
		description: 'Líneas de ejemplo obtenidas exitosamente',
	})
	@ApiBadRequestResponse({
		description: 'Error al obtener líneas de ejemplo',
	})
	async getSampleLines(@Headers('x-holding-id') holdingId: string): Promise<GetSampleLinesResponseDto> {
		return this.invoiceProcessingService.getSampleLines(holdingId, 10);
	}
}
