import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	CountRecordsDTO,
	CountRecordsResponseDTO,
	GetCompaniesResponseDTO,
	GetProductsDTO,
	JobStatusResponseDTO,
	StartAsyncJobDTO,
	SyncInvoicesDTO,
} from './odoo.dto';
import { OdooService } from './odoo.service';

@ApiTags('Odoo')
@Controller('odoo')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class OdooController {
	constructor(private readonly odooService: OdooService) {}

	@Get('companies')
	@ApiOperation({
		summary: 'Obtener compañías desde Odoo',
		description: 'Obtiene todas las compañías disponibles en Odoo junto con las compañías existentes en Sapira para mapeo',
	})
	@ApiQuery({
		name: 'connection_id',
		required: true,
		type: String,
		description: 'ID de la conexión de Odoo',
		example: '1',
	})
	@ApiQuery({
		name: 'holding_id',
		required: true,
		type: String,
		description: 'ID del holding para filtrar compañías de Sapira',
		example: '05583c6e-9364-4672-a610-0744324e44b4',
	})
	@ApiOkResponse({
		type: GetCompaniesResponseDTO,
		description: 'Compañías obtenidas exitosamente',
	})
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	async getCompanies(@Query('connection_id') connectionId: string, @Query('holding_id') holdingId: string): Promise<GetCompaniesResponseDTO> {
		const result = await this.odooService.getCompanies({ connection_id: connectionId, holding_id: holdingId });
		return result as GetCompaniesResponseDTO;
	}

	@Get('products')
	@ApiOperation({ summary: 'Obtener productos de Odoo y Sapira' })
	@ApiQuery({ name: 'connection_id', description: 'ID de la conexión de Odoo', required: true })
	@ApiOkResponse({ description: 'Productos obtenidos exitosamente' })
	@ApiBadRequestResponse({ description: 'Error al obtener productos' })
	async getProducts(@Query() query: GetProductsDTO) {
		return await this.odooService.getProducts(query);
	}

	@Post('count-records')
	@ApiOperation({
		summary: 'Contar facturas, líneas de facturas y clientes',
		description: 'Cuenta el total de facturas, líneas de facturas y clientes dentro de un rango de fechas específico',
	})
	@ApiBody({
		type: CountRecordsDTO,
		required: true,
		description: 'Parámetros para conteo de registros',
		examples: {
			'count-example': {
				summary: 'Ejemplo de conteo de registros',
				description: 'Ejemplo con filtros de fecha',
				value: {
					connection_id: '1',
					date_from: '2025-01-01',
					date_to: '2025-12-31',
				},
			},
		},
	})
	@ApiOkResponse({
		type: CountRecordsResponseDTO,
		description: 'Conteo exitoso de registros',
	})
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	async countRecords(@Body() countData: CountRecordsDTO): Promise<CountRecordsResponseDTO> {
		return await this.odooService.countRecords(countData);
	}

	@Post('invoices/start-async')
	@ApiOperation({ summary: 'Iniciar sincronización asíncrona de facturas' })
	@ApiBody({ type: StartAsyncJobDTO })
	@ApiOkResponse({
		description: 'Job iniciado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				job_id: { type: 'string' },
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Error al iniciar el job' })
	async startAsyncInvoiceSync(@Body() body: StartAsyncJobDTO) {
		return await this.odooService.startAsyncInvoiceSync(body);
	}

	@Post('invoices/job-status')
	@ApiOperation({ summary: 'Consultar estado de job de sincronización (POST)' })
	@ApiBody({
		schema: {
			type: 'object',
			properties: {
				job_id: { type: 'string', description: 'ID del job a consultar' },
			},
			required: ['job_id'],
		},
	})
	@ApiOkResponse({
		description: 'Estado del job obtenido exitosamente',
		type: JobStatusResponseDTO,
	})
	@ApiBadRequestResponse({ description: 'Job no encontrado' })
	async getJobStatusPost(@Body() body: { job_id: string }): Promise<JobStatusResponseDTO> {
		return await this.odooService.getJobStatus(body.job_id);
	}

	@Post('sync-invoices')
	@ApiOperation({
		summary: 'Sincronizar facturas desde Odoo',
		description: 'Sincroniza facturas y líneas de factura desde Odoo con filtros opcionales de fecha y paginación',
	})
	@ApiBody({
		type: SyncInvoicesDTO,
		required: true,
		description: 'Parámetros para sincronización de facturas',
		examples: {
			'sync-example': {
				summary: 'Ejemplo de sincronización de facturas',
				description: 'Ejemplo completo con todos los parámetros disponibles',
				value: {
					connection_id: '1',
					limit: 60,
					offset: 0,
					date_from: '2025-01-01',
					date_to: '2025-12-10',
					estimate_only: true,
					sync_session_id: '1',
				},
			},
		},
	})
	@ApiOkResponse({ description: 'Sincronización exitosa' })
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	async syncInvoices(@Body() syncData: SyncInvoicesDTO): Promise<any> {
		return await this.odooService.syncInvoices(syncData);
	}
}
