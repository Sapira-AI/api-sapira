import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { CreateCustomFieldDto, CustomFieldsQueryDto, UpdateCustomFieldDto } from './dtos/custom-fields.dto';
import { SettingsCustomFieldsService } from './settings-custom-fields.service';

import type { SettingsRequest } from './settings-common';

/** Campos personalizados (contrato §2.4, D13). */
@ApiTags('Settings · Campos personalizados')
@Controller('settings/custom-fields')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsCustomFieldsController {
	constructor(private readonly fields: SettingsCustomFieldsService) {}

	@Get()
	@ApiOperation({ summary: 'Definiciones con cuántos registros tienen valor' })
	list(@HoldingId() holdingId: string, @Query() query: CustomFieldsQueryDto) {
		return this.fields.list(holdingId, query);
	}

	@Post()
	@RequirePermission(PERMISSION_CODES.editSettings)
	create(@HoldingId() holdingId: string, @Body() body: CreateCustomFieldDto, @Request() req: SettingsRequest) {
		return this.fields.create(holdingId, body, req.permissionContext?.userId ?? null);
	}

	@Patch(':id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	update(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCustomFieldDto) {
		return this.fields.update(holdingId, id, body);
	}

	@Delete(':id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async remove(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.fields.remove(holdingId, id);
	}
}
