import {
	Body,
	Controller,
	Delete,
	ForbiddenException,
	Get,
	HttpCode,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
	Put,
	Request,
	UseGuards,
	UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import type { PermissionContext } from '@/guards/permissions.service';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { AccountingPeriodsService } from './accounting-periods.service';
import { CompanyLegalDocumentsService } from './company-legal-documents.service';
import {
	ClosePeriodDto,
	ConfirmLegalDocumentDto,
	CreateBankAccountDto,
	CreateCompanyDto,
	LegalDocumentUploadDto,
	PutAccountsDto,
	ReopenPeriodDto,
	UpdateBankAccountDto,
	UpdateCompanyDto,
} from './dtos/companies.dto';
import { LogoUploadDto } from './dtos/holding.dto';
import { SettingsCompaniesService } from './settings-companies.service';
import { SettingsDbErrorsInterceptor } from './settings-db-errors';

import type { SettingsRequest } from './settings-common';

const actorOf = (req: SettingsRequest): PermissionContext => {
	if (!req.permissionContext) throw new ForbiddenException('No se pudo identificar al usuario');

	return req.permissionContext;
};

/**
 * Compañía 360 (contrato §3): datos, cuentas contables, cuentas bancarias, documentos legales y cierre de períodos.
 * Leer = VIEW_CONFIGURACION; escribir = EDIT_CONFIGURACION; cerrar/reabrir = CLOSE_PERIODS.
 */
@ApiTags('Settings · Compañías')
@Controller('settings/companies')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@UseInterceptors(SettingsDbErrorsInterceptor)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsCompaniesController {
	constructor(
		private readonly companies: SettingsCompaniesService,
		private readonly documents: CompanyLegalDocumentsService,
		private readonly periods: AccountingPeriodsService
	) {}

	@Get()
	@ApiOperation({ summary: 'Compañías del holding' })
	list(@HoldingId() holdingId: string) {
		return this.companies.list(holdingId);
	}

	@Get(':id')
	@ApiOperation({ summary: 'Compañía con su uso y si se puede eliminar' })
	get(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.companies.get(holdingId, id);
	}

	@Post()
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Nueva compañía (tax_rate en porcentaje: 19 = 19 %)' })
	create(@HoldingId() holdingId: string, @Body() body: CreateCompanyDto) {
		return this.companies.create(holdingId, body);
	}

	@Patch(':id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	update(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCompanyDto) {
		return this.companies.update(holdingId, id, body);
	}

	@Delete(':id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Eliminar compañía (solo si nunca se usó)' })
	async remove(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.companies.remove(holdingId, id);
	}

	@Post(':id/logo-upload')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	logoUpload(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: LogoUploadDto) {
		return this.companies.prepareLogoUpload(holdingId, id, body);
	}

	// ── Cuentas contables ──

	@Get(':id/accounts')
	@ApiOperation({ summary: 'Las 5 cuentas del asiento' })
	getAccounts(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.companies.getAccounts(holdingId, id);
	}

	@Put(':id/accounts')
	@RequirePermission(PERMISSION_CODES.editSettings)
	putAccounts(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PutAccountsDto) {
		return this.companies.putAccounts(holdingId, id, body);
	}

	// ── Cuentas bancarias ──

	@Get(':id/bank-accounts')
	listBankAccounts(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.companies.listBankAccounts(holdingId, id);
	}

	@Post(':id/bank-accounts')
	@RequirePermission(PERMISSION_CODES.editSettings)
	createBankAccount(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateBankAccountDto) {
		return this.companies.createBankAccount(holdingId, id, body);
	}

	@Patch(':id/bank-accounts/:accountId')
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateBankAccount(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('accountId', ParseUUIDPipe) accountId: string,
		@Body() body: UpdateBankAccountDto
	) {
		return this.companies.updateBankAccount(holdingId, id, accountId, body);
	}

	@Delete(':id/bank-accounts/:accountId')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteBankAccount(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('accountId', ParseUUIDPipe) accountId: string
	): Promise<void> {
		await this.companies.deleteBankAccount(holdingId, id, accountId);
	}

	// ── Documentos legales ──

	@Get(':id/legal-documents')
	listDocuments(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.documents.list(holdingId, id);
	}

	@Post(':id/legal-documents/upload-url')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'URL firmada para subir un documento legal (bucket privado company-files)' })
	prepareDocument(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: LegalDocumentUploadDto) {
		return this.documents.prepareUpload(holdingId, id, body);
	}

	@Post(':id/legal-documents')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Registrar el documento ya subido' })
	confirmDocument(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: ConfirmLegalDocumentDto,
		@Request() req: SettingsRequest
	) {
		return this.documents.confirm(holdingId, id, body, req.permissionContext?.userId ?? null);
	}

	@Get(':id/legal-documents/:docId/download')
	@ApiOperation({ summary: 'URL firmada de descarga (60 s)' })
	downloadDocument(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Param('docId', ParseUUIDPipe) docId: string) {
		return this.documents.downloadUrl(holdingId, id, docId);
	}

	@Delete(':id/legal-documents/:docId')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteDocument(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Param('docId', ParseUUIDPipe) docId: string
	): Promise<void> {
		await this.documents.remove(holdingId, id, docId);
	}

	// ── Cierre de períodos ──

	@Get(':id/periods')
	@ApiOperation({ summary: 'Cierre actual e historial' })
	getPeriods(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.periods.get(holdingId, id);
	}

	@Post(':id/periods/close')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.closePeriods)
	@ApiOperation({ summary: 'Cerrar hasta el último día de un mes (motivo ≥ 10)' })
	closePeriod(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: ClosePeriodDto,
		@Request() req: SettingsRequest
	) {
		return this.periods.close(holdingId, id, body, actorOf(req));
	}

	@Post(':id/periods/reopen')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.closePeriods)
	@ApiOperation({ summary: 'Reabrir desde el día 1 de un mes (motivo ≥ 10)' })
	reopenPeriod(
		@HoldingId() holdingId: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: ReopenPeriodDto,
		@Request() req: SettingsRequest
	) {
		return this.periods.reopen(holdingId, id, body, actorOf(req));
	}
}
