import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ClaudeService } from './claude.service';
import { SendMessageDto } from './dtos/send-message.dto';

@ApiTags('Claude')
@Controller('claude')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class ClaudeController {
	constructor(private readonly claudeService: ClaudeService) {}

	@Post('message')
	@ApiOperation({
		summary: 'Enviar mensaje a Claude',
		description: 'Envía un mensaje a Claude Sonnet 4.5 y recibe una respuesta. Soporta conversaciones con contexto y uso de skills.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Mensaje enviado y respuesta recibida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al comunicarse con Claude API',
	})
	@HttpCode(HttpStatus.OK)
	async sendMessage(@Body() dto: SendMessageDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!dto.holding_id) {
			throw new BadRequestException('El campo holding_id es obligatorio.');
		}

		const context = {
			conversation_id: dto.conversation_id,
			messages: dto.messages || [],
			system_prompt: dto.system_prompt,
		};

		const result = await this.claudeService.sendMessage(dto.message, dto.holding_id, context, dto.use_skills ?? true, accessToken);

		return {
			success: true,
			data: result,
		};
	}
}
