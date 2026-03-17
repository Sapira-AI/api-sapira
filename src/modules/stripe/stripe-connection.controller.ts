import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CreateStripeConnectionDto } from './dtos/create-stripe-connection.dto';
import { UpdateStripeConnectionDto } from './dtos/update-stripe-connection.dto';
import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeConnectionService } from './stripe-connection.service';

@ApiTags('Stripe Connections')
@Controller('stripe/connections')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class StripeConnectionController {
	constructor(private readonly stripeConnectionService: StripeConnectionService) {}

	@Get()
	@ApiOperation({
		summary: 'Obtener todas las conexiones de Stripe del holding',
		description: 'Retorna todas las conexiones de Stripe configuradas para el holding actual',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexiones obtenidas exitosamente',
		type: [StripeConnection],
	})
	@HttpCode(HttpStatus.OK)
	async findAll(@Headers('x-holding-id') holdingId: string): Promise<StripeConnection[]> {
		return this.stripeConnectionService.findAll(holdingId);
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Obtener una conexión de Stripe por ID',
		description: 'Retorna los detalles de una conexión específica de Stripe',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión obtenida exitosamente',
		type: StripeConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async findOne(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<StripeConnection> {
		return this.stripeConnectionService.findOne(id, holdingId);
	}

	@Post()
	@ApiOperation({
		summary: 'Crear una nueva conexión de Stripe',
		description: 'Crea una nueva conexión de Stripe para el holding',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Conexión creada exitosamente',
		type: StripeConnection,
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Datos inválidos',
	})
	@HttpCode(HttpStatus.CREATED)
	async create(@Body() createDto: CreateStripeConnectionDto): Promise<StripeConnection> {
		return this.stripeConnectionService.create(createDto);
	}

	@Put(':id')
	@ApiOperation({
		summary: 'Actualizar una conexión de Stripe',
		description: 'Actualiza los datos de una conexión existente de Stripe',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión actualizada exitosamente',
		type: StripeConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async update(
		@Param('id') id: string,
		@Headers('x-holding-id') holdingId: string,
		@Body() updateDto: UpdateStripeConnectionDto
	): Promise<StripeConnection> {
		return this.stripeConnectionService.update(id, holdingId, updateDto);
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Eliminar una conexión de Stripe',
		description: 'Elimina una conexión de Stripe del sistema',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conexión eliminada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async remove(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<{ message: string }> {
		await this.stripeConnectionService.remove(id, holdingId);
		return { message: 'Conexión eliminada exitosamente' };
	}

	@Patch(':id/toggle-active')
	@ApiOperation({
		summary: 'Activar/desactivar una conexión de Stripe',
		description: 'Cambia el estado activo de una conexión de Stripe',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado actualizado exitosamente',
		type: StripeConnection,
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Conexión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async toggleActive(@Param('id') id: string, @Headers('x-holding-id') holdingId: string): Promise<StripeConnection> {
		return this.stripeConnectionService.toggleActive(id, holdingId);
	}
}
