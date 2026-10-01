import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ConsumptionService } from './consumption.service';
import { QueryConsumptionPendingDto } from './dtos/consumption.dto';

/** Consumos a nivel holding (Pricing v2 §5): "pendientes de informar" entre contratos. Lo demás vive bajo `/contracts/:id`. */
@ApiTags('Consumption')
@Controller('consumption')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ConsumptionController {
	constructor(private readonly consumption: ConsumptionService) {}

	@Get('pending')
	@ApiOperation({
		summary: 'Pendientes de informar',
		description:
			'Líneas medidas con período de servicio terminado y sin consumo informado (`quantity_source = pending`) en facturas Por Emitir activas, con contrato, ítem, métrica y factura. Filtros `period=YYYY-MM`, `client_id`, `company_id`',
	})
	@ApiResponse({ status: 200, description: '{ data, total, currentPage, pages, limit }' })
	async pending(@Query() query: QueryConsumptionPendingDto, @HoldingId() holdingId: string) {
		return await this.consumption.pending(holdingId, query);
	}
}
