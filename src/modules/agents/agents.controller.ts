import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	ParseEnumPipe,
	ParseUUIDPipe,
	Post,
	Put,
	Query,
	Request,
	UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { AgentsService } from './agents.service';
import { CreateClientAgentConfigDto, CreateHoldingAgentConfigDto, UpdateClientAgentConfigDto } from './dtos/client-config.dto';
import { ListRunsQueryDto } from './dtos/list-runs.dto';
import { RenderEmailDto } from './dtos/render-email.dto';
import { RunAgentDto } from './dtos/run-agent.dto';
import { UpdateAgentConfigDto } from './dtos/update-agent-config.dto';

type AgentsRequest = { permissionContext?: PermissionContext };

/**
 * Automatizaciones (agentes de proforma y cobranza). Leer = VIEW_AGENTES_IA; ejecutar, aprobar, descartar y configurar =
 * EDIT_AGENTES_IA ("Editar incluye Ver"). Documentación: `README.md` de este módulo.
 */
@ApiTags('Agents')
@Controller('agents')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(PERMISSION_CODES.viewAgents)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class AgentsController {
	constructor(private readonly agentsService: AgentsService) {}

	@Get()
	@ApiOperation({ summary: 'Listar agentes del holding', description: 'Agentes de proforma y cobranza con su programación.' })
	async listAgents(@HoldingId() holdingId: string) {
		return { success: true, data: await this.agentsService.listAgents(holdingId) };
	}

	@Get('runs')
	@ApiOperation({ summary: 'Historial de ejecuciones', description: 'Paginado; filtros opcionales por agente, tipo y estado.' })
	async listRuns(@Query() query: ListRunsQueryDto, @HoldingId() holdingId: string) {
		return { success: true, data: await this.agentsService.listRuns(holdingId, query) };
	}

	@Get('runs/:runId')
	@ApiOperation({ summary: 'Detalle de una ejecución' })
	async getRun(@Param('runId', ParseUUIDPipe) runId: string, @HoldingId() holdingId: string) {
		return { success: true, data: await this.agentsService.getRunDetail(runId, holdingId) };
	}

	@Get('runs/:runId/messages')
	@ApiOperation({ summary: 'Mensajes de una ejecución' })
	async listRunMessages(@Param('runId', ParseUUIDPipe) runId: string, @HoldingId() holdingId: string) {
		return { success: true, data: await this.agentsService.listRunMessages(runId, holdingId) };
	}

	@Post('runs/:runId/cancel')
	@HttpCode(HttpStatus.OK)
	@RequirePermission(PERMISSION_CODES.editAgents)
	@ApiOperation({
		summary: 'Descartar ejecución',
		description: 'Descarta un run pendiente de aprobación sin enviar sus mensajes (409 si no está pendiente).',
	})
	async cancelRun(@Param('runId', ParseUUIDPipe) runId: string, @HoldingId() holdingId: string, @Request() req: AgentsRequest) {
		return { success: true, data: await this.agentsService.cancelRun(runId, holdingId, req.permissionContext?.userId) };
	}

	@Get('client-configs/summary')
	@ApiOperation({ summary: 'Resumen de configuraciones por cliente', description: 'Conteo por tipo y clientes con configuración propia.' })
	async clientConfigsSummary(@HoldingId() holdingId: string) {
		return { success: true, data: await this.agentsService.clientConfigsSummary(holdingId) };
	}

	@Delete('client-configs/:client_id/:agent_type')
	@HttpCode(HttpStatus.NO_CONTENT)
	@RequirePermission(PERMISSION_CODES.editAgents)
	@ApiOperation({ summary: 'Volver a la configuración global', description: 'Borra la configuración propia del cliente para ese agente.' })
	async deleteClientConfig(
		@Param('client_id', ParseUUIDPipe) clientId: string,
		@Param('agent_type', new ParseEnumPipe(['proforma', 'collections'])) agentType: string,
		@HoldingId() holdingId: string
	) {
		await this.agentsService.deleteClientConfig(clientId, agentType, holdingId);
	}

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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async runAgent(@Param('agentId') agentId: string, @Body() dto: RunAgentDto, @HoldingId() holdingId: string) {
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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async approveRun(@Param('runId', ParseUUIDPipe) runId: string, @HoldingId() holdingId: string, @Request() req: AgentsRequest) {
		const result = await this.agentsService.approveRun(runId, holdingId, req.permissionContext?.userId);

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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async createClientConfig(@Body() dto: CreateClientAgentConfigDto, @HoldingId() holdingId: string) {
		const config = await this.agentsService.updateClientConfig(dto.client_id, dto.agent_type, holdingId, {
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
	async getClientConfigByQuery(@Query('client_id') clientId: string, @Query('agent_type') agentType: string, @HoldingId() holdingId: string) {
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
	async getClientConfig(@Param('client_id') clientId: string, @Param('agent_type') agentType: string, @HoldingId() holdingId: string) {
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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async updateClientConfig(
		@Param('client_id') clientId: string,
		@Param('agent_type') agentType: string,
		@Body() dto: UpdateClientAgentConfigDto,
		@HoldingId() holdingId: string
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
	async listClientConfigs(@Query('agent_type') agentType: string | undefined, @HoldingId() holdingId: string) {
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
	async listEmailSenders(@HoldingId() holdingId: string) {
		const finalHoldingId = holdingId;
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
	async getHoldingConfig(@HoldingId() holdingId: string, @Query('agent_type') agentType: string) {
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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async updateHoldingConfig(@Body() dto: CreateHoldingAgentConfigDto, @HoldingId() holdingId: string) {
		const config = await this.agentsService.updateHoldingConfig(holdingId, dto.agent_type, {
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
	@RequirePermission(PERMISSION_CODES.editAgents)
	@HttpCode(HttpStatus.OK)
	async updateAgentConfig(@Param('agentId') agentId: string, @Body() dto: UpdateAgentConfigDto, @HoldingId() holdingId: string) {
		const agent = await this.agentsService.updateAgentConfig(agentId, holdingId, dto);

		return {
			success: true,
			data: agent,
		};
	}
}
