import { Body, Controller, Get, HttpStatus, Param, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { UpdateSelectedHoldingDto, UserHoldingResponseDto } from './dtos/holdings.dto';
import { HoldingsService } from './holdings.service';

@ApiTags('Holdings')
@Controller('holdings')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class HoldingsController {
	constructor(private readonly holdingsService: HoldingsService) {}

	@Get()
	@ApiOperation({
		summary: 'Obtener holdings del usuario autenticado',
		description: 'Retorna la lista de holdings a los que pertenece el usuario autenticado',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de holdings obtenida exitosamente',
		type: [UserHoldingResponseDto],
	})
	async getUserHoldings(@Request() req): Promise<UserHoldingResponseDto[]> {
		const userId = req.user?.id || req.user?.sub;
		return await this.holdingsService.getUserHoldings(userId);
	}

	@Get('user/:userId')
	@ApiOperation({
		summary: 'Obtener holdings de un usuario específico',
		description: 'Retorna la lista de holdings a los que pertenece un usuario específico (requiere permisos)',
	})
	@ApiParam({
		name: 'userId',
		type: String,
		description: 'UUID del usuario',
		example: '4f5e117a-f6b2-499b-a6bb-9fd6eb26fb49',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Lista de holdings obtenida exitosamente',
		type: [UserHoldingResponseDto],
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async getUserHoldingsByUserId(@Param('userId') userId: string): Promise<UserHoldingResponseDto[]> {
		return await this.holdingsService.getUserHoldings(userId);
	}

	@Get(':holdingId')
	@ApiOperation({
		summary: 'Obtener detalles de un holding específico',
		description: 'Retorna la información completa de un holding por su ID',
	})
	@ApiParam({
		name: 'holdingId',
		type: String,
		description: 'UUID del holding',
		example: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Holding encontrado',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Holding no encontrado',
	})
	async getHoldingById(@Param('holdingId') holdingId: string) {
		return await this.holdingsService.getHoldingById(holdingId);
	}

	@Post('assign-to-all-holdings/:userId')
	@ApiOperation({
		summary: 'Asociar usuario a todos los holdings existentes',
		description: 'Crea relaciones entre el usuario especificado y todos los holdings que existen en el sistema. Omite holdings ya asociados.',
	})
	@ApiParam({
		name: 'userId',
		type: String,
		description: 'UUID del usuario a asociar',
		example: '1dedf14a-ba51-4b93-9c74-7f869e17d4dc',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Usuario asociado exitosamente a los holdings',
		schema: {
			type: 'object',
			properties: {
				assigned: { type: 'number', example: 5, description: 'Cantidad de holdings asociados' },
				skipped: { type: 'number', example: 2, description: 'Cantidad de holdings ya asociados (omitidos)' },
				total: { type: 'number', example: 7, description: 'Total de holdings en el sistema' },
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Usuario no encontrado',
	})
	async assignUserToAllHoldings(@Param('userId') userId: string) {
		return await this.holdingsService.assignUserToAllHoldings(userId);
	}

	@Post('select')
	@ApiOperation({
		summary: 'Actualizar holding seleccionado',
		description: 'Marca un holding como seleccionado para el usuario autenticado. Solo puede haber un holding seleccionado a la vez.',
	})
	@ApiBody({
		type: UpdateSelectedHoldingDto,
		description: 'Datos del holding a seleccionar',
		examples: {
			'select-holding': {
				summary: 'Ejemplo de selección de holding',
				value: {
					holding_id: 'f6e3cb81-8b4a-451e-8402-573e47688d45',
				},
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Holding seleccionado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Holding f6e3cb81-8b4a-451e-8402-573e47688d45 seleccionado exitosamente' },
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'El usuario no tiene acceso al holding especificado',
	})
	async updateSelectedHolding(@Request() req, @Body() dto: UpdateSelectedHoldingDto) {
		const userId = req.user?.id || req.user?.sub;
		return await this.holdingsService.updateSelectedHolding(userId, dto.holding_id);
	}
}
