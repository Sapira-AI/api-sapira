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
	CreateFxRateDto,
	FxRatesQueryDto,
	FxSyncHistoryQueryDto,
	FxSyncMonthlyQueryDto,
	LogoUploadDto,
	UpdateFxRateDto,
	UpdateHoldingDto,
	UpdatePreferencesDto,
} from './dtos/holding.dto';
import { SettingsDbErrorsInterceptor } from './settings-db-errors';
import { SettingsHoldingService } from './settings-holding.service';

import type { SettingsRequest } from './settings-common';

/** Holding 360 (contrato: `docs/v2-rediseno/contrato-api-configuracion.md` §1). Leer = VIEW_CONFIGURACION, escribir = EDIT_CONFIGURACION. */
@ApiTags('Settings · Holding')
@Controller('settings/holding')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@UseInterceptors(SettingsDbErrorsInterceptor)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class SettingsHoldingController {
	constructor(private readonly holding: SettingsHoldingService) {}

	@Get()
	@ApiOperation({ summary: 'Datos del holding' })
	get(@HoldingId() holdingId: string) {
		return this.holding.getHolding(holdingId);
	}

	@Patch()
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Editar datos del holding (logo solo por logo-upload)' })
	update(@HoldingId() holdingId: string, @Body() body: UpdateHoldingDto) {
		return this.holding.updateHolding(holdingId, body);
	}

	@Post('logo-upload')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'URL firmada para subir el logo del holding (bucket público company-logos)' })
	logoUpload(@HoldingId() holdingId: string, @Body() body: LogoUploadDto) {
		return this.holding.prepareLogoUpload(holdingId, body);
	}

	@Get('preferences')
	@ApiOperation({ summary: 'Moneda de consolidación, política FX y días de aviso de renovación' })
	preferences(@HoldingId() holdingId: string) {
		return this.holding.getPreferences(holdingId);
	}

	@Patch('preferences')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Editar preferencias del holding' })
	updatePreferences(@HoldingId() holdingId: string, @Body() body: UpdatePreferencesDto) {
		return this.holding.updatePreferences(holdingId, body);
	}

	@Get('fx-rates')
	@ApiOperation({ summary: 'Tasas fijas por período del holding' })
	listFxRates(@HoldingId() holdingId: string, @Query() query: FxRatesQueryDto) {
		return this.holding.listFxRates(holdingId, query);
	}

	@Post('fx-rates')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Crear una tasa fija por período' })
	createFxRate(@HoldingId() holdingId: string, @Body() body: CreateFxRateDto, @Request() req: SettingsRequest) {
		return this.holding.createFxRate(holdingId, body, req.permissionContext?.userId ?? null);
	}

	@Patch('fx-rates/:id')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Editar una tasa fija por período' })
	updateFxRate(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateFxRateDto) {
		return this.holding.updateFxRate(holdingId, id, body);
	}

	@Delete('fx-rates/:id')
	@HttpCode(204)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Eliminar una tasa fija por período' })
	async deleteFxRate(@HoldingId() holdingId: string, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
		await this.holding.deleteFxRate(holdingId, id);
	}

	@Get('fx-sync-status')
	@ApiOperation({ summary: 'Última carga automática de tipos de cambio por moneda en uso (solo lectura)' })
	fxSyncStatus(@HoldingId() holdingId: string) {
		return this.holding.fxSyncStatus(holdingId);
	}

	@Get('fx-sync/history')
	@ApiOperation({ summary: 'Tipo de cambio diario de una moneda en uso hacia la de consolidación (fecha, tasa, fuente)' })
	fxSyncHistory(@HoldingId() holdingId: string, @Query() query: FxSyncHistoryQueryDto) {
		return this.holding.fxSyncHistory(holdingId, query);
	}

	@Get('fx-sync/monthly')
	@ApiOperation({ summary: 'Promedios mensuales de una moneda en uso hacia la de consolidación (12 meses del año)' })
	fxSyncMonthly(@HoldingId() holdingId: string, @Query() query: FxSyncMonthlyQueryDto) {
		return this.holding.fxSyncMonthly(holdingId, query);
	}

	@Get('tree')
	@ApiOperation({ summary: 'Árbol holding → compañías con chips de estado' })
	tree(@HoldingId() holdingId: string) {
		return this.holding.tree(holdingId);
	}
}
