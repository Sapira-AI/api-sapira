import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import {
	CountRecordsDTO,
	CountRecordsResponseDTO,
	GetCompaniesResponseDTO,
	GetFieldMappingResponseDTO,
	GetProductsDTO,
	JobStatusResponseDTO,
	MapCompaniesDTO,
	MapCompaniesResponseDTO,
	SaveFieldMappingDTO,
	SaveFieldMappingResponseDTO,
	StartAsyncJobDTO,
	SyncInvoicesDTO,
} from './dtos/odoo.dto';
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

	@Post('companies/map')
	@ApiOperation({
		summary: 'Mapear compañías de Sapira con compañías de Odoo',
		description: 'Asigna odoo_integration_id a las compañías de Sapira. Maneja correctamente duplicados reasignando automáticamente.',
	})
	@ApiBody({
		type: MapCompaniesDTO,
		required: true,
		description: 'Datos de mapeo de compañías',
		examples: {
			'map-example': {
				summary: 'Ejemplo de mapeo de compañías',
				value: {
					holding_id: '05583c6e-9364-4672-a610-0744324e44b4',
					mappings: [
						{
							sapira_company_id: '4453fc7e-af8d-40f0-a65a-eda4cfa2f974',
							odoo_company_id: 1,
							tax_rate: 19,
						},
						{
							sapira_company_id: '5c83a77b-325f-441b-b830-357210aa3178',
							odoo_company_id: 2,
							tax_rate: 18,
						},
					],
				},
			},
		},
	})
	@ApiOkResponse({
		type: MapCompaniesResponseDTO,
		description: 'Mapeos actualizados exitosamente',
	})
	@ApiBadRequestResponse({ description: 'Parámetros inválidos' })
	async mapCompanies(@Body() mapData: MapCompaniesDTO): Promise<MapCompaniesResponseDTO> {
		return await this.odooService.mapCompanies(mapData);
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

	@Get('invoice-processing/classify')
	@ApiOperation({
		summary: 'Clasificar facturas en staging',
		description:
			'Clasifica las facturas en staging según si necesitan crearse, actualizarse o ya están procesadas. Se puede llamar múltiples veces para reclasificar después de cambios en el mapeo.',
	})
	@ApiOkResponse({
		description: 'Clasificación completada exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				to_create: { type: 'number', description: 'Facturas nuevas que se crearán' },
				to_update: { type: 'number', description: 'Facturas existentes que se actualizarán' },
				already_processed: { type: 'number', description: 'Facturas ya procesadas sin cambios' },
				total: { type: 'number', description: 'Total de facturas en staging' },
				message: { type: 'string' },
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Error al clasificar facturas' })
	async classifyInvoices(@Headers('x-holding-id') holdingId: string) {
		return await this.odooService.classifyInvoices(holdingId);
	}

	@Post('field-mappings')
	@ApiOperation({
		summary: 'Guardar configuración de mapeo de campos',
		description: 'Guarda o actualiza la configuración de mapeo de campos entre Odoo y Sapira para el holding actual',
	})
	@ApiBody({ type: SaveFieldMappingDTO })
	@ApiOkResponse({
		description: 'Mapeo guardado exitosamente',
		type: SaveFieldMappingResponseDTO,
	})
	@ApiBadRequestResponse({ description: 'Error al guardar mapeo' })
	async saveFieldMapping(
		@Headers('x-holding-id') holdingId: string,
		@Body() saveFieldMappingDto: SaveFieldMappingDTO
	): Promise<SaveFieldMappingResponseDTO> {
		return await this.odooService.saveFieldMapping(holdingId, saveFieldMappingDto);
	}

	@Get('field-mappings')
	@ApiOperation({
		summary: 'Obtener configuración de mapeo de campos',
		description: 'Obtiene la configuración de mapeo de campos entre Odoo y Sapira para el holding actual',
	})
	@ApiQuery({
		name: 'source_model',
		type: String,
		required: true,
		description: 'Modelo origen en Odoo',
		example: 'account.move',
	})
	@ApiQuery({
		name: 'target_table',
		type: String,
		required: true,
		description: 'Tabla destino en Sapira',
		example: 'invoices_legacy',
	})
	@ApiOkResponse({
		description: 'Mapeo obtenido exitosamente',
		type: GetFieldMappingResponseDTO,
	})
	@ApiBadRequestResponse({ description: 'Error al obtener mapeo' })
	async getFieldMapping(
		@Headers('x-holding-id') holdingId: string,
		@Query('source_model') sourceModel: string,
		@Query('target_table') targetTable: string
	): Promise<GetFieldMappingResponseDTO> {
		return await this.odooService.getFieldMapping(holdingId, sourceModel, targetTable);
	}

	@Post('partners/clean-processed')
	@ApiOperation({
		summary: 'Limpiar registros procesados de staging',
		description: 'Elimina todos los registros con processing_status = "processed" de la tabla odoo_partners_stg para el holding especificado',
	})
	@ApiOkResponse({
		description: 'Registros eliminados exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				deleted_count: { type: 'number' },
			},
		},
	})
	@ApiBadRequestResponse({ description: 'Error al eliminar registros' })
	async cleanProcessedPartners(@Headers('x-holding-id') holdingId: string) {
		return await this.odooService.cleanProcessedPartners(holdingId);
	}
}
