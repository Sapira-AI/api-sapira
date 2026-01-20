import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ChatMessageDto } from './dtos/chat-message.dto';
import { CreateSessionDto, UpdateSessionDto } from './dtos/create-session.dto';
import { SapiraCopilotService } from './sapira-copilot.service';

@ApiTags('Sapira Copilot')
@Controller('sapira-copilot')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class SapiraCopilotController {
	constructor(private readonly sapiraCopilotService: SapiraCopilotService) {}

	@Post('chat')
	@ApiOperation({
		summary: 'Enviar mensaje al copilot',
		description: 'Envía un mensaje al copilot de Sapira y recibe una respuesta contextualizada.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mensaje enviado y respuesta recibida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al comunicarse con el copilot',
	})
	@HttpCode(HttpStatus.OK)
	async sendMessage(@Body() dto: ChatMessageDto) {
		const context = {
			session_id: dto.session_id, // Por ahora no se usa
			messages: dto.history || [],
			context: dto.context, // Por ahora no se usa
		};

		const result = await this.sapiraCopilotService.sendMessage(dto.message, dto.holding_id, context);

		return {
			success: true,
			data: result,
		};
	}

	@Post('sessions')
	@ApiOperation({
		summary: 'Crear nueva sesión',
		description: 'Crea una nueva sesión de chat con el copilot.',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Sesión creada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al crear la sesión',
	})
	@HttpCode(HttpStatus.CREATED)
	async createSession(@Body() dto: CreateSessionDto) {
		const session = await this.sapiraCopilotService.createSession(dto.name, dto.holding_id, dto.description);

		return {
			success: true,
			data: session,
		};
	}

	@Get('sessions')
	@ApiOperation({
		summary: 'Listar sesiones',
		description: 'Lista todas las sesiones de chat del holding.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sesiones obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listSessions(@Query('holding_id') holdingId: string) {
		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		const sessions = await this.sapiraCopilotService.listSessions(holdingId);

		return {
			success: true,
			data: sessions,
		};
	}

	@Get('sessions/:sessionId')
	@ApiOperation({
		summary: 'Obtener sesión por ID',
		description: 'Obtiene los detalles de una sesión específica.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sesión obtenida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Sesión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async getSession(@Param('sessionId') sessionId: string, @Query('holding_id') holdingId: string) {
		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		const session = await this.sapiraCopilotService.getSessionById(sessionId, holdingId);

		return {
			success: true,
			data: session,
		};
	}

	@Put('sessions/:sessionId')
	@ApiOperation({
		summary: 'Actualizar sesión',
		description: 'Actualiza el nombre o descripción de una sesión.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sesión actualizada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Sesión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async updateSession(@Param('sessionId') sessionId: string, @Body() dto: UpdateSessionDto) {
		const session = await this.sapiraCopilotService.updateSession(sessionId, dto, dto.holding_id);

		return {
			success: true,
			data: session,
		};
	}

	@Delete('sessions/:sessionId')
	@ApiOperation({
		summary: 'Eliminar sesión',
		description: 'Elimina una sesión de chat del sistema.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sesión eliminada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Sesión no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async deleteSession(@Param('sessionId') sessionId: string, @Query('holding_id') holdingId: string) {
		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		await this.sapiraCopilotService.deleteSession(sessionId, holdingId);

		return {
			success: true,
			message: 'Sesión eliminada exitosamente',
		};
	}
}
