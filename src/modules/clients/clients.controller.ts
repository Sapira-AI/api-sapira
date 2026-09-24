import { Body, Controller, Delete, Get, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ClientMetricsService } from './client-metrics.service';
import { ClientsService } from './clients.service';
import { AssignEntityResponseDto, AssignEntityToClientDto } from './dtos/assign-entity.dto';
import { ClientResponseDto } from './dtos/client-response.dto';
import { CreateClientDto } from './dtos/create-client.dto';
import { QueryClientInvoicesDto } from './dtos/query-client-invoices.dto';
import { QueryClientsDto } from './dtos/query-clients.dto';
import { UpdateClientDto } from './dtos/update-client.dto';

@ApiTags('Clients')
@Controller('clients')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ClientsController {
	constructor(
		private readonly clientsService: ClientsService,
		private readonly clientMetricsService: ClientMetricsService
	) {}

	@Post()
	@ApiOperation({
		summary: 'Crear un nuevo cliente comercial',
		description: 'Crea un nuevo cliente comercial en el sistema',
	})
	@ApiBody({ type: CreateClientDto })
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Cliente creado exitosamente',
		type: ClientResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos de entrada inválidos',
	})
	async create(@Body() createClientDto: CreateClientDto, @HoldingId() holdingId: string): Promise<ClientResponseDto> {
		return await this.clientsService.create(createClientDto, holdingId);
	}

	@Get()
	@ApiOperation({
		summary: 'Obtener lista de clientes',
		description: 'Retorna una lista paginada de clientes con filtros opcionales',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de clientes obtenida exitosamente',
		schema: {
			type: 'object',
			properties: {
				data: { type: 'array', items: { $ref: '#/components/schemas/ClientResponseDto' } },
				items: { type: 'number', example: 100, description: 'Número total de elementos' },
				pages: { type: 'number', example: 5, description: 'Número total de páginas' },
				currentPage: { type: 'number', example: 1, description: 'Página actual' },
				limit: { type: 'number', example: 20, description: 'Elementos por página' },
			},
		},
	})
	async findAll(@Query() queryDto: QueryClientsDto, @HoldingId() holdingId: string) {
		return await this.clientsService.findAll(queryDto, holdingId);
	}

	// Debe declararse antes de `:id` para que Nest no lo capture como un id.
	@Get('filter-options')
	@ApiOperation({
		summary: 'Opciones de filtro de clientes',
		description: 'Valores distintos de segmento, industria, mercado, país y estado de los clientes del holding',
	})
	async getFilterOptions(@HoldingId() holdingId: string) {
		return await this.clientsService.getFilterOptions(holdingId);
	}

	@Get('summary')
	@ApiOperation({
		summary: 'Totales de la lista de clientes',
		description: 'MRR del mes, cartera abierta y vencida del holding (moneda del sistema)',
	})
	async getListSummary(@HoldingId() holdingId: string) {
		return await this.clientMetricsService.getListSummary(holdingId);
	}

	@Get(':id/summary')
	@ApiOperation({
		summary: 'Resumen del cliente',
		description: 'Contratos activos, próxima renovación, MRR, por cobrar, vencido y facturado 12 meses',
	})
	@ApiParam({ name: 'id', type: String })
	async getSummary(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.clientMetricsService.getSummary(id, holdingId);
	}

	@Get(':id/invoices')
	@ApiOperation({
		summary: 'Facturas del cliente',
		description: 'Paginadas, de todas sus razones sociales; filtro por estado, razón social y número, con conteo por estado',
	})
	@ApiParam({ name: 'id', type: String })
	async getInvoices(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: QueryClientInvoicesDto, @HoldingId() holdingId: string) {
		return await this.clientMetricsService.getInvoices(id, holdingId, {
			page: query.page,
			limit: query.limit,
			status: query.status,
			entityId: query.client_entity_id,
			search: query.search,
			sortBy: query.sort_by,
			sortOrder: query.sort_order,
		});
	}

	@Get(':id/receivables')
	@ApiOperation({
		summary: 'Cartera del cliente',
		description: 'Facturas abiertas con antigüedad por vencimiento (por vencer, 1–30, 31–60, 61–90, +90)',
	})
	@ApiParam({ name: 'id', type: String })
	async getReceivables(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.clientMetricsService.getReceivables(id, holdingId);
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Obtener un cliente por ID',
		description: 'Retorna la información completa de un cliente específico',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Cliente encontrado',
		type: ClientResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	async findOne(@Param('id') id: string, @HoldingId() holdingId: string): Promise<ClientResponseDto> {
		return await this.clientsService.findOne(id, holdingId);
	}

	@Get(':id/with-entities')
	@ApiOperation({
		summary: 'Obtener un cliente con sus razones sociales',
		description: 'Retorna la información completa de un cliente incluyendo todas sus razones sociales asociadas',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Cliente con razones sociales encontrado',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	async findOneWithEntities(@Param('id') id: string, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.findOneWithEntities(id);
	}

	@Patch(':id')
	@ApiOperation({
		summary: 'Actualizar un cliente',
		description: 'Actualiza la información de un cliente existente',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiBody({ type: UpdateClientDto })
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Cliente actualizado exitosamente',
		type: ClientResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	async update(@Param('id') id: string, @Body() updateClientDto: UpdateClientDto, @HoldingId() holdingId: string): Promise<ClientResponseDto> {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.update(id, updateClientDto);
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Eliminar un cliente',
		description: 'Elimina un cliente del sistema',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Cliente eliminado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Cliente eliminado exitosamente' },
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	async remove(@Param('id') id: string, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.remove(id);
	}

	@Post(':id/entities')
	@ApiOperation({
		summary: 'Asignar una razón social a un cliente',
		description: 'Crea una relación entre un cliente comercial y una razón social',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiBody({ type: AssignEntityToClientDto })
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Razón social asignada exitosamente',
		type: AssignEntityResponseDto,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente o razón social no encontrada',
	})
	@ApiResponse({
		status: HttpStatus.CONFLICT,
		description: 'La razón social ya está asignada al cliente',
	})
	async assignEntity(@Param('id') id: string, @Body() assignDto: AssignEntityToClientDto, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.assignEntity(id, assignDto, holdingId);
	}

	@Delete(':id/entities/:entityId')
	@ApiOperation({
		summary: 'Desasignar una razón social de un cliente',
		description: 'Elimina la relación entre un cliente comercial y una razón social',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiParam({
		name: 'entityId',
		type: String,
		description: 'UUID de la razón social',
		example: '123e4567-e89b-12d3-a456-426614174001',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Razón social desasignada exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Razón social desasignada exitosamente del cliente' },
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente, razón social o relación no encontrada',
	})
	async unassignEntity(@Param('id') id: string, @Param('entityId') entityId: string, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.unassignEntity(id, entityId);
	}

	@Put(':id/entities/:entityId/set-primary')
	@ApiOperation({
		summary: 'Establecer una razón social como principal',
		description: 'Marca una razón social como la principal para un cliente',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiParam({
		name: 'entityId',
		type: String,
		description: 'UUID de la razón social',
		example: '123e4567-e89b-12d3-a456-426614174001',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Razón social establecida como principal exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Razón social establecida como principal exitosamente' },
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente, razón social o relación no encontrada',
	})
	async setPrimaryEntity(@Param('id') id: string, @Param('entityId') entityId: string, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.setPrimaryEntity(id, entityId);
	}

	@Get(':id/entities')
	@ApiOperation({
		summary: 'Obtener razones sociales de un cliente',
		description: 'Retorna todas las razones sociales asociadas a un cliente',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID del cliente',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de razones sociales obtenida exitosamente',
		type: [ClientResponseDto],
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	async getClientEntities(@Param('id') id: string, @HoldingId() holdingId: string) {
		await this.clientsService.findOne(id, holdingId);

		return await this.clientsService.getClientEntities(id);
	}

	@Post('sync-stripe-ids')
	@ApiOperation({
		summary: 'Sincronizar stripe_customer_id desde BigQuery',
		description:
			'Consulta todos los registros de la tabla sapira_stripe en BigQuery y actualiza el campo stripe_customer_id ' +
			'en los clientes que tengan un salesforce_account_id coincidente. Este proceso solo actualiza registros existentes.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Sincronización completada exitosamente' },
				stats: {
					type: 'object',
					properties: {
						totalFromBigQuery: { type: 'number', example: 150, description: 'Total de registros obtenidos de BigQuery' },
						clientsUpdated: { type: 'number', example: 120, description: 'Clientes actualizados exitosamente' },
						clientsNotFound: {
							type: 'number',
							example: 25,
							description: 'Registros de BigQuery sin cliente correspondiente',
						},
						errors: { type: 'number', example: 5, description: 'Errores durante el procesamiento' },
					},
				},
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al ejecutar la sincronización',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	async syncStripeCustomerIds(@HoldingId() holdingId: string) {
		return await this.clientsService.syncStripeCustomerIds(holdingId);
	}
}
