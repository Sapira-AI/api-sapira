import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import {
	KameAutoDto,
	KameCompanyParamDto,
	KameConnectionDto,
	KameEnvironmentParamDto,
	KameExportsQueryDto,
	KamePeriodParamDto,
	KameRetryDto,
	KameSendNowDto,
	KameSettingsDto,
	KameSwitchEnvironmentDto,
} from './dtos/kame.dto';
import { KameConnectionsService } from './kame-connections.service';
import { KameExportService } from './kame-export.service';

interface KameRequest {
	permissionContext?: PermissionContext;
}

const VIEW = PERMISSION_CODES.viewIntegrations;
const EDIT = PERMISSION_CODES.editIntegrations;

/**
 * Integraciones › ERP › Kame (`front-sapira/docs/integracion-kame/README.md`): conexiones por compañía y ambiente, interruptores, envío automático del
 * holding y la cola de envíos (facturas emitidas y asientos de devengo). Lectura con `VIEW_INTEGRACIONES`, cambios con
 * `EDIT_INTEGRACIONES`. Toda compañía se valida contra el holding (404 si es de otro). Nunca devuelve el client secret.
 */
@ApiTags('Integraciones v2 · Kame')
@Controller('integrations/erp/kame')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(VIEW)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class KameController {
	constructor(
		private readonly connections: KameConnectionsService,
		private readonly exports: KameExportService
	) {}

	private userId(req: KameRequest) {
		return req.permissionContext?.userId ?? null;
	}

	@Get('companies')
	@ApiOperation({ summary: 'Compañías chilenas del holding con su conexión a Kame, interruptores y envíos' })
	overview(@HoldingId() holdingId: string) {
		return this.connections.overview(holdingId);
	}

	@Put('auto')
	@RequirePermission(EDIT)
	@ApiOperation({ summary: 'Prende o apaga el envío automático a Kame del holding' })
	setAuto(@HoldingId() holdingId: string, @Body() dto: KameAutoDto, @Req() req: KameRequest) {
		return this.connections.setAuto(holdingId, dto.enabled, this.userId(req));
	}

	@Put('companies/:companyId/connections/:environment')
	@RequirePermission(EDIT)
	@ApiOperation({ summary: 'Guarda la credencial de Kame de la compañía en un ambiente (pruebas o producción)' })
	saveConnection(
		@HoldingId() holdingId: string,
		@Param() params: KameEnvironmentParamDto,
		@Body() dto: KameConnectionDto,
		@Req() req: KameRequest
	) {
		return this.connections.saveConnection(holdingId, params.companyId, params.environment, dto, this.userId(req));
	}

	@Post('companies/:companyId/connections/:environment/test')
	@RequirePermission(EDIT)
	@HttpCode(200)
	@ApiOperation({ summary: 'Prueba la conexión: pide el token y lista las unidades de negocio' })
	testConnection(@HoldingId() holdingId: string, @Param() params: KameEnvironmentParamDto) {
		return this.connections.testConnection(holdingId, params.companyId, params.environment);
	}

	@Delete('companies/:companyId/connections/:environment')
	@RequirePermission(EDIT)
	@HttpCode(204)
	@ApiOperation({ summary: 'Borra la credencial de un ambiente (no la activa)' })
	deleteConnection(@HoldingId() holdingId: string, @Param() params: KameEnvironmentParamDto) {
		return this.connections.deleteConnection(holdingId, params.companyId, params.environment);
	}

	@Patch('companies/:companyId/settings')
	@RequirePermission(EDIT)
	@ApiOperation({ summary: 'Interruptores de la compañía: conexión activa, facturas, asientos y simulación' })
	updateSettings(@HoldingId() holdingId: string, @Param() params: KameCompanyParamDto, @Body() dto: KameSettingsDto, @Req() req: KameRequest) {
		return this.connections.updateSettings(holdingId, params.companyId, dto, this.userId(req));
	}

	@Post('companies/:companyId/environment')
	@RequirePermission(EDIT)
	@HttpCode(200)
	@ApiOperation({ summary: 'Cambia el ambiente activo (pruebas ↔ producción)' })
	switchEnvironment(
		@HoldingId() holdingId: string,
		@Param() params: KameCompanyParamDto,
		@Body() dto: KameSwitchEnvironmentDto,
		@Req() req: KameRequest
	) {
		return this.connections.switchEnvironment(holdingId, params.companyId, dto, this.userId(req));
	}

	@Get('companies/:companyId/journal/:period')
	@ApiOperation({ summary: 'Vista previa del comprobante de devengo de un mes (no envía nada)' })
	previewJournal(@HoldingId() holdingId: string, @Param() params: KamePeriodParamDto) {
		return this.exports.previewJournal(holdingId, params.companyId, params.period);
	}

	@Post('companies/:companyId/journal/:period/send')
	@RequirePermission(EDIT)
	@HttpCode(200)
	@ApiOperation({ summary: 'Envía ya los asientos de un mes cerrado (en simulación, solo los arma)' })
	sendJournal(@HoldingId() holdingId: string, @Param() params: KamePeriodParamDto, @Req() req: KameRequest) {
		return this.exports.sendJournalNow(holdingId, params.companyId, params.period, this.userId(req));
	}

	@Get('exports')
	@ApiOperation({ summary: 'Envíos a Kame (cola e historial)' })
	listExports(@HoldingId() holdingId: string, @Query() query: KameExportsQueryDto) {
		return this.exports.list(holdingId, query);
	}

	@Get('exports/:id')
	@ApiOperation({ summary: 'Un envío, con el cuerpo enviado (o que se enviaría)' })
	getExport(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.exports.exportById(holdingId, id);
	}

	@Post('exports/send-now')
	@RequirePermission(EDIT)
	@HttpCode(200)
	@ApiOperation({ summary: 'Encola y envía ya lo pendiente (no depende del envío automático)' })
	sendNow(@HoldingId() holdingId: string, @Body() dto: KameSendNowDto, @Req() req: KameRequest) {
		return this.exports.sendNow(holdingId, dto.company_id, this.userId(req));
	}

	@Post('exports/retry')
	@RequirePermission(EDIT)
	@HttpCode(200)
	@ApiOperation({ summary: 'Reintenta ya envíos con error, simulados u omitidos' })
	retry(@HoldingId() holdingId: string, @Body() dto: KameRetryDto, @Req() req: KameRequest) {
		return this.exports.retry(holdingId, dto.ids, this.userId(req));
	}
}
