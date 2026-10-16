import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Query,
	Request,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import {
	CreateDomainDto,
	CreateInboundDomainDto,
	CreateSenderDto,
	SendersQueryDto,
	TestEmailDto,
	UpdateDomainDto,
	UpdateSenderDto,
} from './dtos/communications.dto';
import { authIdOf, type SettingsRequest } from './settings-common';
import { SettingsCommunicationsService } from './settings-communications.service';
import { SettingsDbErrorsInterceptor } from './settings-db-errors';
import { SettingsInboundDomainService } from './settings-inbound-domain.service';

/**
 * Comunicaciones del holding (contrato §8.2): dominios de envío (SendGrid) y remitentes. Rutas nuevas, siempre con el holding del header
 * y cada id filtrado por holding. Las rutas viejas `/emails/*` y `/email/*` no se tocan (bloque de seguridad aparte).
 */
@ApiTags('Settings · Comunicaciones')
@Controller('settings/communications')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@UseInterceptors(SettingsDbErrorsInterceptor)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsCommunicationsController {
	constructor(
		private readonly communications: SettingsCommunicationsService,
		private readonly inboundDomain: SettingsInboundDomainService
	) {}

	@Get('inbound-domain')
	@ApiOperation({ summary: 'Dominio de recepción de documentos tributarios del holding (null si no hay)' })
	getInboundDomain(@HoldingId() holdingId: string) {
		return this.inboundDomain.get(holdingId);
	}

	@Post('inbound-domain')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Registra el subdominio de recepción: autenticación en SendGrid y registro MX a publicar' })
	createInboundDomain(@HoldingId() holdingId: string, @Body() body: CreateInboundDomainDto, @Request() req: SettingsRequest) {
		return this.inboundDomain.create(holdingId, body.inbound_domain, authIdOf(req));
	}

	@Post('inbound-domain/verify')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Verifica MX y CNAME; con todo puesto, conecta el Inbound Parse con api-factura' })
	verifyInboundDomain(@HoldingId() holdingId: string) {
		return this.inboundDomain.verify(holdingId);
	}

	@Delete('inbound-domain')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteInboundDomain(@HoldingId() holdingId: string): Promise<void> {
		await this.inboundDomain.remove(holdingId);
	}

	@Get('domains')
	@ApiOperation({ summary: 'Dominios de envío del holding con sus remitentes y registros DNS' })
	listDomains(@HoldingId() holdingId: string) {
		return this.communications.listDomains(holdingId);
	}

	@Post('domains')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Registra un dominio en SendGrid y crea su remitente por defecto' })
	createDomain(@HoldingId() holdingId: string, @Body() body: CreateDomainDto, @Request() req: SettingsRequest) {
		return this.communications.createDomain(holdingId, body, authIdOf(req));
	}

	@Patch('domains/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateDomain(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDomainDto) {
		return this.communications.updateDomain(holdingId, id, body);
	}

	@Delete('domains/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteDomain(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.communications.deleteDomain(holdingId, id);
	}

	@Post('domains/:id/verify')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Pide a SendGrid validar los registros DNS ahora' })
	verifyDomain(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.communications.verifyDomain(holdingId, id);
	}

	@Post('domains/:id/check-status')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Estado actual del dominio en SendGrid (sin pedir validación); actualiza el estado guardado' })
	checkStatus(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.communications.checkStatus(holdingId, id);
	}

	@Get('senders')
	@ApiOperation({ summary: 'Remitentes de los dominios del holding (o de uno)' })
	listSenders(@HoldingId() holdingId: string, @Query() query: SendersQueryDto) {
		return this.communications.listSenders(holdingId, query.domain_id);
	}

	@Post('senders')
	@RequirePermission(PERMISSION_CODES.editSettings)
	createSender(@HoldingId() holdingId: string, @Body() body: CreateSenderDto, @Request() req: SettingsRequest) {
		return this.communications.createSender(holdingId, body, authIdOf(req));
	}

	@Patch('senders/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateSender(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSenderDto) {
		return this.communications.updateSender(holdingId, id, body);
	}

	@Delete('senders/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteSender(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.communications.deleteSender(holdingId, id);
	}

	@Post('test-email')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Correo de prueba (solo a tu correo o al de un miembro del holding)' })
	testEmail(@HoldingId() holdingId: string, @Body() body: TestEmailDto, @Request() req: SettingsRequest) {
		return this.communications.sendTestEmail(holdingId, body, authIdOf(req));
	}
}
