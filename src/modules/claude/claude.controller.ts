import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { ClaudeService } from './claude.service';
import { CreateSkillDto, UpdateSkillDto } from './dtos/create-skill.dto';
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

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, dto.holding_id);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${dto.holding_id}`);
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

	@Post('skills')
	@ApiOperation({
		summary: 'Crear nueva skill',
		description: 'Crea una nueva skill que Claude puede utilizar durante las conversaciones.',
	})
	@ApiResponse({
		status: HttpStatus.CREATED,
		description: 'Skill creada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Ya existe una skill con ese nombre',
	})
	@HttpCode(HttpStatus.CREATED)
	async createSkill(@Body() dto: CreateSkillDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!dto.holding_id) {
			throw new BadRequestException('El campo holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, dto.holding_id);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${dto.holding_id}`);
		}

		const skill = await this.claudeService.createSkill(dto.name, dto.description, dto.input_schema, dto.holding_id);

		return {
			success: true,
			data: skill,
		};
	}

	@Get('skills')
	@ApiOperation({
		summary: 'Listar skills',
		description: 'Lista todas las skills disponibles para el holding.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Skills obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listSkills(@Query('holding_id') holdingId: string, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, holdingId);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${holdingId}`);
		}

		const skills = await this.claudeService.listSkills(holdingId);

		return {
			success: true,
			data: skills,
		};
	}

	@Get('skills/:skillId')
	@ApiOperation({
		summary: 'Obtener skill por ID',
		description: 'Obtiene los detalles de una skill específica.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Skill obtenida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Skill no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async getSkill(@Param('skillId') skillId: string, @Query('holding_id') holdingId: string, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, holdingId);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${holdingId}`);
		}

		const skill = await this.claudeService.getSkillById(skillId, holdingId);

		return {
			success: true,
			data: skill,
		};
	}

	@Put('skills/:skillId')
	@ApiOperation({
		summary: 'Actualizar skill',
		description: 'Actualiza la descripción o el schema de entrada de una skill.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Skill actualizada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Skill no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async updateSkill(@Param('skillId') skillId: string, @Body() dto: UpdateSkillDto, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!dto.holding_id) {
			throw new BadRequestException('El campo holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, dto.holding_id);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${dto.holding_id}`);
		}

		const skill = await this.claudeService.updateSkill(skillId, dto, dto.holding_id);

		return {
			success: true,
			data: skill,
		};
	}

	@Delete('skills/:skillId')
	@ApiOperation({
		summary: 'Eliminar skill',
		description: 'Elimina una skill del sistema.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Skill eliminada exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Skill no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async deleteSkill(@Param('skillId') skillId: string, @Query('holding_id') holdingId: string, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!holdingId) {
			throw new BadRequestException('El parámetro holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, holdingId);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${holdingId}`);
		}

		await this.claudeService.deleteSkill(skillId, holdingId);

		return {
			success: true,
			message: 'Skill eliminada exitosamente',
		};
	}

	@Put('skills/:skillId/toggle')
	@ApiOperation({
		summary: 'Activar/desactivar skill',
		description: 'Activa o desactiva una skill para que Claude pueda o no utilizarla.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado de la skill actualizado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Skill no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async toggleSkill(@Param('skillId') skillId: string, @Body() body: { is_active: boolean; holding_id: string }, @Req() req: any) {
		const authHeader = String(req?.headers?.authorization || '');
		const accessToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : undefined;

		if (!accessToken) {
			throw new BadRequestException('Falta el header Authorization Bearer.');
		}

		if (!body.holding_id) {
			throw new BadRequestException('El campo holding_id es obligatorio.');
		}

		const hasAccess = await this.claudeService.validateUserHasAccessToHolding(accessToken, body.holding_id);
		if (!hasAccess) {
			throw new ForbiddenException(`No tienes acceso al holding ${body.holding_id}`);
		}

		const skill = await this.claudeService.toggleSkill(skillId, body.is_active, body.holding_id);

		return {
			success: true,
			data: skill,
		};
	}
}
