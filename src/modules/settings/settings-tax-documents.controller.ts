import { Controller, Get, Param, ParseUUIDPipe, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { SettingsDbErrorsInterceptor } from './settings-db-errors';
import { SettingsTaxDocumentsService } from './settings-tax-documents.service';

/** Documentos tributarios de la compañía (contrato §8.1, solo lectura): catálogo del país (o genéricos), tasa y tasa efectiva, uso. */
@ApiTags('Settings · Compañías')
@Controller('settings/companies')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@UseInterceptors(SettingsDbErrorsInterceptor)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsTaxDocumentsController {
	constructor(private readonly taxDocuments: SettingsTaxDocumentsService) {}

	@Get(':id/tax-documents')
	@ApiOperation({ summary: 'Documentos tributarios del país de la compañía con su tasa, la tasa efectiva y el uso en contratos' })
	get(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string) {
		return this.taxDocuments.get(holdingId, id);
	}
}
