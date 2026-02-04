import { Body, Controller, Delete, Get, HttpStatus, Param, Patch, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ClientsService } from './clients.service';
import { AssignEntityResponseDto, AssignEntityToClientDto } from './dtos/assign-entity.dto';
import { ClientResponseDto } from './dtos/client-response.dto';
import { CreateClientDto } from './dtos/create-client.dto';
import { QueryClientsDto } from './dtos/query-clients.dto';
import { UpdateClientDto } from './dtos/update-client.dto';

@ApiTags('Clients')
@Controller('clients')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class ClientsController {
	constructor(private readonly clientsService: ClientsService) {}

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
	async create(@Body() createClientDto: CreateClientDto): Promise<ClientResponseDto> {
		return await this.clientsService.create(createClientDto);
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
	async findAll(@Query() queryDto: QueryClientsDto) {
		return await this.clientsService.findAll(queryDto);
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
	async findOne(@Param('id') id: string): Promise<ClientResponseDto> {
		return await this.clientsService.findOne(id);
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
	async findOneWithEntities(@Param('id') id: string) {
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
	async update(@Param('id') id: string, @Body() updateClientDto: UpdateClientDto): Promise<ClientResponseDto> {
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
	async remove(@Param('id') id: string) {
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
	async assignEntity(@Param('id') id: string, @Body() assignDto: AssignEntityToClientDto, @Request() req) {
		const holdingId = req.user?.holdingId;
		const userId = req.user?.userId;
		return await this.clientsService.assignEntity(id, assignDto, holdingId, userId);
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
	async unassignEntity(@Param('id') id: string, @Param('entityId') entityId: string) {
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
	async setPrimaryEntity(@Param('id') id: string, @Param('entityId') entityId: string) {
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
	async getClientEntities(@Param('id') id: string) {
		return await this.clientsService.getClientEntities(id);
	}
}
