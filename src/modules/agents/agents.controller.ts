import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { GetSupabaseUser } from '@/decorators/supabase-user.decorator';

import { AgentsService } from './agents.service';
import { ApproveRunDto } from './dtos/approve-run.dto';
import { CreateClientAgentConfigDto, CreateHoldingAgentConfigDto, UpdateClientAgentConfigDto } from './dtos/client-config.dto';
import { RenderEmailDto } from './dtos/render-email.dto';
import { RunAgentDto } from './dtos/run-agent.dto';
import { UpdateAgentConfigDto } from './dtos/update-agent-config.dto';

@ApiTags('Agents')
@Controller('agents')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class AgentsController {
	constructor(private readonly agentsService: AgentsService) {}

	@Post(':agentId/run')
	@ApiOperation({
		summary: 'Ejecutar agente',
		description: 'Ejecuta un agente en modo preview o execute. En preview solo genera los mensajes sin enviarlos.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Agente ejecutado exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Agente deshabilitado o configuración inválida',
	})
	@HttpCode(HttpStatus.OK)
	async runAgent(@Param('agentId') agentId: string, @Body() dto: RunAgentDto, @GetSupabaseUser() user: any) {
		const holdingId = dto.holding_id || user.holding_id;
		const result = await this.agentsService.runAgent(agentId, dto.mode, holdingId);

		return {
			success: true,
			data: result,
		};
	}

	@Post('runs/:runId/approve')
	@ApiOperation({
		summary: 'Aprobar ejecución',
		description: 'Aprueba y envía los mensajes de un run que está en estado queued.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Run aprobado y mensajes enviados',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Run no está en estado queued',
	})
	@HttpCode(HttpStatus.OK)
	async approveRun(@Param('runId') runId: string, @Body() dto: ApproveRunDto) {
		console.log('approveRun - runId:', runId);
		console.log('approveRun - dto:', dto);
		console.log('approveRun - holding_id:', dto.holding_id);
		const result = await this.agentsService.approveRun(runId, dto.holding_id);

		return {
			success: true,
			data: result,
		};
	}

	@Post('client-config')
	@ApiOperation({
		summary: 'Crear/actualizar configuración de cliente',
		description: 'Crea o actualiza la configuración personalizada de un agente para un cliente.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración creada/actualizada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async createClientConfig(@Body() dto: CreateClientAgentConfigDto) {
		const config = await this.agentsService.updateClientConfig(dto.client_id, dto.agent_type, dto.holding_id, {
			is_enabled: dto.is_enabled,
			config_json: dto.config_json,
		});

		return {
			success: true,
			data: config,
		};
	}

	@Get('client-config')
	@ApiOperation({
		summary: 'Obtener configuración de cliente (query params)',
		description: 'Obtiene la configuración personalizada de un agente para un cliente específico usando query params.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración obtenida exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getClientConfigByQuery(
		@Query('client_id') clientId: string,
		@Query('agent_type') agentType: string,
		@Query('holding_id') holdingId: string
	) {
		const config = await this.agentsService.getClientConfig(clientId, agentType, holdingId);

		return {
			success: true,
			data: config,
		};
	}

	@Get('client-configs/:client_id/:agent_type')
	@ApiOperation({
		summary: 'Obtener configuración de cliente',
		description: 'Obtiene la configuración personalizada de un agente para un cliente específico.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración obtenida exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getClientConfig(@Param('client_id') clientId: string, @Param('agent_type') agentType: string, @Query('holding_id') holdingId: string) {
		const config = await this.agentsService.getClientConfig(clientId, agentType, holdingId);

		return {
			success: true,
			data: config,
		};
	}

	@Put('client-configs/:client_id/:agent_type')
	@ApiOperation({
		summary: 'Actualizar configuración de cliente',
		description: 'Actualiza o crea la configuración personalizada de un agente para un cliente.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración actualizada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async updateClientConfig(
		@Param('client_id') clientId: string,
		@Param('agent_type') agentType: string,
		@Body() dto: UpdateClientAgentConfigDto,
		@Query('holding_id') holdingId: string
	) {
		const config = await this.agentsService.updateClientConfig(clientId, agentType, holdingId, dto);

		return {
			success: true,
			data: config,
		};
	}

	@Get('client-configs')
	@ApiOperation({
		summary: 'Listar configuraciones de clientes',
		description: 'Lista todas las configuraciones personalizadas de agentes por cliente.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuraciones obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listClientConfigs(@Query('agent_type') agentType: string | undefined, @Query('holding_id') holdingId: string) {
		const configs = await this.agentsService.listClientConfigs(holdingId, agentType);

		return {
			success: true,
			data: configs,
		};
	}

	@Get('email-senders')
	@ApiOperation({
		summary: 'Listar remitentes de email disponibles',
		description: 'Lista todos los remitentes de email configurados y activos para el holding.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Remitentes obtenidos exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async listEmailSenders(@Query('holdingId') holdingId: string, @GetSupabaseUser() user: any) {
		const finalHoldingId = holdingId || user.holding_id;
		const senders = await this.agentsService.listEmailSenders(finalHoldingId);

		return {
			success: true,
			data: senders,
		};
	}

	@Post('render-email')
	@ApiOperation({
		summary: 'Renderizar email (preview)',
		description: 'Renderiza una plantilla de email con variables para previsualización.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Email renderizado exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async renderEmail(@Body() dto: RenderEmailDto) {
		const result = await this.agentsService.renderEmail(dto.agent_type, dto.template, dto.variables);

		return {
			success: true,
			data: result,
		};
	}

	@Get('holding-config')
	@ApiOperation({
		summary: 'Obtener configuración global del holding',
		description:
			'Obtiene la configuración global de un agente para el holding. Esta configuración se aplica a todos los clientes que no tengan configuración personalizada.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración global obtenida exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getHoldingConfig(@Query('holding_id') holdingId: string, @Query('agent_type') agentType: string) {
		const config = await this.agentsService.getHoldingConfig(holdingId, agentType);

		return {
			success: true,
			data: config,
		};
	}

	@Post('holding-config')
	@ApiOperation({
		summary: 'Crear/actualizar configuración global del holding',
		description:
			'Crea o actualiza la configuración global de un agente para el holding. Esta configuración se aplica a todos los clientes sin configuración personalizada.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración global creada/actualizada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async updateHoldingConfig(@Body() dto: CreateHoldingAgentConfigDto) {
		const config = await this.agentsService.updateHoldingConfig(dto.holding_id, dto.agent_type, {
			is_enabled: dto.is_enabled,
			config_json: dto.config_json,
		});

		return {
			success: true,
			data: config,
		};
	}

	@Put(':agentId/config')
	@ApiOperation({
		summary: 'Actualizar configuración del agente',
		description: 'Actualiza la configuración de ejecución automática y aprobación del agente',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Configuración actualizada exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async updateAgentConfig(@Param('agentId') agentId: string, @Body() dto: UpdateAgentConfigDto, @GetSupabaseUser() user: any) {
		const holdingId = user.holding_id;
		const agent = await this.agentsService.updateAgentConfig(agentId, holdingId, dto);

		return {
			success: true,
			data: agent,
		};
	}
}
