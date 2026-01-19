import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
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
	async sendMessage(@Body() dto: ChatMessageDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}

		const holdingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!holdingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}

		console.log('-------------holdingId ------------------------------', holdingId);
		console.log('----------------------DTOOO.holdingid.. ------------------------------', dto.holding_id);
		const context = {
			session_id: dto.session_id,
			messages: dto.history || [],
			context: dto.context,
		};

		const result = await this.sapiraCopilotService.sendMessage(dto.message, holdingId, context, accessToken);

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
	async createSession(@Body() dto: CreateSessionDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}
		const holdingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!holdingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}

		const session = await this.sapiraCopilotService.createSession(dto.name, holdingId, dto.description);

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
	async listSessions(@Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}
		const finalHoldingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!finalHoldingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}
		const sessions = await this.sapiraCopilotService.listSessions(finalHoldingId);

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
	async getSession(@Param('sessionId') sessionId: string, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}
		const finalHoldingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!finalHoldingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}
		const session = await this.sapiraCopilotService.getSessionById(sessionId, finalHoldingId);

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
	async updateSession(@Param('sessionId') sessionId: string, @Body() dto: UpdateSessionDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}
		const holdingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!holdingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}

		const session = await this.sapiraCopilotService.updateSession(sessionId, dto, holdingId);

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
	async deleteSession(@Param('sessionId') sessionId: string, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;
		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer para poder aplicar RLS.');
		}
		const holdingId = await this.sapiraCopilotService.resolveHoldingId(accessToken);
		if (!holdingId) {
			throw new BadRequestException(
				'No se pudo resolver holding_id para tu usuario autenticado. Asegura que exista un registro en user_holdings accesible por RLS.'
			);
		}
		await this.sapiraCopilotService.deleteSession(sessionId, holdingId);

		return {
			success: true,
			message: 'Sesión eliminada exitosamente',
		};
	}
}
