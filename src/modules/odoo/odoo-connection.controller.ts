import { Body, Controller, Delete, Get, Headers, HttpStatus, Param, Patch, Post, Put } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CreateOdooConnectionDto, UpdateOdooConnectionDto } from './dtos/odoo-connection.dto';
import { OdooConnection } from './entities/odoo-connection.entity';
import { OdooConnectionService } from './odoo-connection.service';

@ApiTags('Odoo Connections')
@Controller('odoo/connections')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class OdooConnectionController {
	constructor(private readonly odooConnectionService: OdooConnectionService) {}

	@Get()
	@ApiOperation({
		summary: 'Listar todas las conexiones Odoo',
		description: 'Obtiene todas las conexiones Odoo configuradas filtradas por el holding del header X-Holding-Id.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de conexiones Odoo obtenida exitosamente',
		type: [OdooConnection],
	})
	async findAll(@Headers('x-holding-id') holdingId?: string): Promise<OdooConnection[]> {
		if (holdingId) {
			return await this.odooConnectionService.findByHoldingId(holdingId);
		}
		return await this.odooConnectionService.findAll();
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Obtener una conexión Odoo específica',
		description: 'Obtiene los detalles de una conexión Odoo por su ID',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID de la conexión Odoo',
		example: 'd44ef296-cd9a-4cd5-90fe-8d28111c7972',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión Odoo encontrada',
		type: OdooConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión Odoo no encontrada',
	})
	async findOne(@Param('id') id: string): Promise<OdooConnection> {
		return await this.odooConnectionService.findOne(id);
	}

	@Post()
	@ApiOperation({
		summary: 'Crear nueva conexión Odoo',
		description: 'Crea una nueva configuración de conexión a una instancia de Odoo',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Conexión Odoo creada exitosamente',
		type: OdooConnection,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos de entrada inválidos',
	})
	async create(@Body() createDto: CreateOdooConnectionDto): Promise<OdooConnection> {
		return await this.odooConnectionService.create(createDto);
	}

	@Put(':id')
	@ApiOperation({
		summary: 'Actualizar conexión Odoo',
		description: 'Actualiza los datos de una conexión Odoo existente',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID de la conexión Odoo a actualizar',
		example: 'd44ef296-cd9a-4cd5-90fe-8d28111c7972',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión Odoo actualizada exitosamente',
		type: OdooConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión Odoo no encontrada',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos de entrada inválidos',
	})
	async update(@Param('id') id: string, @Body() updateDto: UpdateOdooConnectionDto): Promise<OdooConnection> {
		return await this.odooConnectionService.update(id, updateDto);
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Eliminar conexión Odoo',
		description: 'Elimina permanentemente una conexión Odoo de la base de datos',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID de la conexión Odoo a eliminar',
		example: 'd44ef296-cd9a-4cd5-90fe-8d28111c7972',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión Odoo eliminada exitosamente',
		schema: {
			type: 'object',
			properties: {
				message: {
					type: 'string',
					example: 'Conexión Odoo d44ef296-cd9a-4cd5-90fe-8d28111c7972 eliminada exitosamente',
				},
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión Odoo no encontrada',
	})
	async delete(@Param('id') id: string): Promise<{ message: string }> {
		return await this.odooConnectionService.delete(id);
	}

	@Patch(':id/toggle-active')
	@ApiOperation({
		summary: 'Activar/Desactivar conexión Odoo',
		description: 'Cambia el estado activo/inactivo de una conexión Odoo sin eliminarla',
	})
	@ApiParam({
		name: 'id',
		type: String,
		description: 'UUID de la conexión Odoo',
		example: 'd44ef296-cd9a-4cd5-90fe-8d28111c7972',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado de la conexión Odoo actualizado exitosamente',
		type: OdooConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión Odoo no encontrada',
	})
	async toggleActive(@Param('id') id: string): Promise<OdooConnection> {
		return await this.odooConnectionService.toggleActive(id);
	}
}
