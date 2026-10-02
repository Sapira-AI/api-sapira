import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { CreateMasterDataDto, CreateNamedDto, CreateSellerDto, UpdateMasterDataDto, UpdateNamedDto, UpdateSellerDto } from './dtos/catalogs.dto';
import { SettingsCatalogsService } from './settings-catalogs.service';

const CATEGORY = { name: 'category', enum: ['payment_terms', 'item_types', 'units_of_measure'] };

/** Catálogos del Holding 360 (contrato §2.1–2.3). Borrar solo si no se usa; activar/desactivar con `PATCH { is_active }`. */
@ApiTags('Settings · Catálogos')
@Controller('settings')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsCatalogsController {
	constructor(private readonly catalogs: SettingsCatalogsService) {}

	@Get('sellers')
	@ApiOperation({ summary: 'Vendedores (activos e inactivos) con uso en cotizaciones' })
	listSellers(@HoldingId() holdingId: string) {
		return this.catalogs.listSellers(holdingId);
	}

	@Post('sellers')
	@RequirePermission(PERMISSION_CODES.editSettings)
	createSeller(@HoldingId() holdingId: string, @Body() body: CreateSellerDto) {
		return this.catalogs.createSeller(holdingId, body);
	}

	@Patch('sellers/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateSeller(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateSellerDto) {
		return this.catalogs.updateSeller(holdingId, id, body);
	}

	@Delete('sellers/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteSeller(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.catalogs.deleteSeller(holdingId, id);
	}

	@Get('churn-reasons')
	@ApiOperation({ summary: 'Motivos de baja con uso en contratos' })
	listChurnReasons(@HoldingId() holdingId: string) {
		return this.catalogs.listChurnReasons(holdingId);
	}

	@Post('churn-reasons')
	@RequirePermission(PERMISSION_CODES.editSettings)
	createChurnReason(@HoldingId() holdingId: string, @Body() body: CreateNamedDto) {
		return this.catalogs.createChurnReason(holdingId, body);
	}

	@Patch('churn-reasons/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateChurnReason(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateNamedDto) {
		return this.catalogs.updateChurnReason(holdingId, id, body);
	}

	@Delete('churn-reasons/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteChurnReason(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.catalogs.deleteChurnReason(holdingId, id);
	}

	@Get('master-data/:category')
	@ApiParam(CATEGORY)
	@ApiOperation({ summary: 'Condiciones de pago, tipos de ítem o unidades de medida' })
	listMasterData(@HoldingId() holdingId: string, @Param('category') category: string) {
		return this.catalogs.listMasterData(holdingId, category);
	}

	@Post('master-data/:category')
	@ApiParam(CATEGORY)
	@RequirePermission(PERMISSION_CODES.editSettings)
	createMasterData(@HoldingId() holdingId: string, @Param('category') category: string, @Body() body: CreateMasterDataDto) {
		return this.catalogs.createMasterData(holdingId, category, body);
	}

	@Patch('master-data/:category/:id')
	@ApiParam(CATEGORY)
	@RequirePermission(PERMISSION_CODES.editSettings)
	updateMasterData(
		@HoldingId() holdingId: string,
		@Param('category') category: string,
		@Param('id', ParseUUIDPipe) id: string,
		@Body() body: UpdateMasterDataDto
	) {
		return this.catalogs.updateMasterData(holdingId, category, id, body);
	}

	@Delete('master-data/:category/:id')
	@HttpCode(204)
	@ApiParam(CATEGORY)
	@RequirePermission(PERMISSION_CODES.editSettings)
	async deleteMasterData(
		@HoldingId() holdingId: string,
		@Param('category') category: string,
		@Param('id', ParseUUIDPipe) id: string
	): Promise<void> {
		await this.catalogs.deleteMasterData(holdingId, category, id);
	}
}
