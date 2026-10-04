import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import {
	BookingsDto,
	ChurnDetailDto,
	CohortsDto,
	ExceptionsDto,
	MetricsFiltersDto,
	MovementDetailDto,
	MrrBasisDto,
	MrrDimensionDto,
	MrrOverviewDto,
	RenewalsDto,
	RevenueDimensionDto,
	RevenueForwardDto,
	RevenueJournalDto,
	RevenueScheduleDto,
} from './dtos/query-metrics.dto';
import { MetricsDataService } from './metrics-data.service';
import { MrrMetricsService } from './mrr-metrics.service';
import { RevenueMetricsService } from './revenue-metrics.service';

/**
 * Revenue y Métricas v2 (`docs/v2-rediseno/spec-revenue-y-metricas.md` §3): solo lectura sobre el devengo (RSM) y el MRR legacy.
 * Montos agregados solo desde columnas `*_system_ccy` / `*_ccy` / `*_contract_ccy` (nunca `monthly_price`); filas sin tipo de cambio
 * fuera de los totales y en `unconverted`. Holding por `HoldingScopeGuard` + `@HoldingId()`.
 *
 * Moneda (Domi 04-10): Métricas (`mrr/*`, `clients/activity`, `churn`, `renewals`, `cohorts`, `bookings`) va siempre en moneda de sistema
 * (`currency` distinto de `system` → 400). Ingresos (`revenue/*`) admite sistema, compañía y contrato; en compañía, los meses sin cerrar
 * (`fx_to_company_source = 'pending_month_close'`) no tienen dato y no se leen (no son "sin convertir").
 */
@ApiTags('Metrics')
@Controller('metrics')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class MetricsController {
	constructor(
		private readonly mrr: MrrMetricsService,
		private readonly revenue: RevenueMetricsService,
		private readonly data: MetricsDataService
	) {}

	@Get('filters')
	@ApiOperation({
		summary: 'Opciones de filtro',
		description: 'Compañías, clientes, productos, segmentos, mercados, industrias, países, motivos de churn y orígenes del holding',
	})
	async filters(@HoldingId() holdingId: string) {
		return await this.data.filterOptions(holdingId);
	}

	@Get('mrr/overview')
	@ApiOperation({
		summary: 'KPIs de MRR',
		description:
			'MRR, ARR, CMRR, pendiente de renovar, clientes, ARPA, churn, NRR/GRR del mes e interanual, quick ratio; valor anterior y sparklines',
	})
	async mrrOverview(@Query() query: MrrOverviewDto, @HoldingId() holdingId: string) {
		return await this.mrr.overview(holdingId, query);
	}

	@Get('mrr/movements')
	@ApiOperation({
		summary: 'Movimientos de MRR',
		description: 'Inicio, movimientos por categoría y subcategoría (abiertas), cierre y check por mes; puente del rango',
	})
	async mrrMovements(@Query() query: MrrBasisDto, @HoldingId() holdingId: string) {
		return await this.mrr.movements(holdingId, query);
	}

	@Get('mrr/movements/detail')
	@ApiOperation({ summary: 'Detalle de movimientos', description: 'Drill-down paginado por ítem, contrato, cliente, segmento o mercado' })
	async mrrMovementDetail(@Query() query: MovementDetailDto, @HoldingId() holdingId: string) {
		return await this.mrr.movementDetail(holdingId, query);
	}

	@Get('mrr/by-dimension')
	@ApiOperation({ summary: 'MRR por dimensión', description: 'Matriz dimensión × mes, top N + Otros, pendiente de renovar aparte' })
	async mrrByDimension(@Query() query: MrrDimensionDto, @HoldingId() holdingId: string) {
		return await this.mrr.byDimension(holdingId, query);
	}

	@Get('clients/activity')
	@ApiOperation({ summary: 'Clientes por mes', description: 'Activos (MRR > 0), nuevos, reactivados, perdidos y churn de logos' })
	async clientActivity(@Query() query: MetricsFiltersDto, @HoldingId() holdingId: string) {
		return await this.mrr.clientActivity(holdingId, query);
	}

	@Get('churn')
	@ApiOperation({ summary: 'Churn y contracción', description: 'Por mes, por motivo y detalle paginado' })
	async churn(@Query() query: ChurnDetailDto, @HoldingId() holdingId: string) {
		return await this.mrr.churn(holdingId, query);
	}

	@Get('renewals')
	@ApiOperation({
		summary: 'Renovaciones',
		description: 'Ítems por vencer (30/90/180/365 días) o vencidos sin decisión, con MRR en riesgo; paginado',
	})
	async renewals(@Query() query: RenewalsDto, @HoldingId() holdingId: string) {
		return await this.mrr.renewals(holdingId, query);
	}

	@Get('cohorts')
	@ApiOperation({ summary: 'Cohortes', description: 'Retención por cohorte de primer MRR, por ingresos o por clientes' })
	async cohorts(@Query() query: CohortsDto, @HoldingId() holdingId: string) {
		return await this.mrr.cohorts(holdingId, query);
	}

	@Get('bookings')
	@ApiOperation({ summary: 'Bookings (TCV)', description: 'Valor total de contratos por mes de booking, compañía o cliente, en moneda de sistema' })
	async bookings(@Query() query: BookingsDto, @HoldingId() holdingId: string) {
		return await this.mrr.bookings(holdingId, query);
	}

	@Get('revenue/summary')
	@ApiOperation({
		summary: 'Resumen del devengo',
		description: 'Reconocido, facturado, diferido y por facturar (netting por contrato), diferencia de cambio, top y cortes',
	})
	async revenueSummary(@Query() query: MetricsFiltersDto, @HoldingId() holdingId: string) {
		return await this.revenue.summary(holdingId, query);
	}

	@Get('revenue/rollforward')
	@ApiOperation({
		summary: 'Roll-forward',
		description: 'Diferido y por facturar: inicial, facturado, reconocido, reclasificación, tipo de cambio, final',
	})
	async revenueRollforward(@Query() query: MetricsFiltersDto, @HoldingId() holdingId: string) {
		return await this.revenue.rollforward(holdingId, query);
	}

	@Get('revenue/forward')
	@ApiOperation({
		summary: 'Reconocimiento futuro (RPO)',
		description: '12 meses + posterior, separado en diferido y por facturar, corto y largo plazo',
	})
	async revenueForward(@Query() query: RevenueForwardDto, @HoldingId() holdingId: string) {
		return await this.revenue.forward(holdingId, query);
	}

	@Get('revenue/by-dimension')
	@ApiOperation({
		summary: 'Devengo por dimensión',
		description: 'Reconocido o facturado por cliente, razón social, países, producto, compañía o recurrencia',
	})
	async revenueByDimension(@Query() query: RevenueDimensionDto, @HoldingId() holdingId: string) {
		return await this.revenue.byDimension(holdingId, query);
	}

	@Get('revenue/schedule')
	@ApiOperation({
		summary: 'Detalle mensual',
		description: 'Período × contrato × ítem con las tres monedas, paginado; sirve para explicar una cifra',
	})
	async revenueSchedule(@Query() query: RevenueScheduleDto, @HoldingId() holdingId: string) {
		return await this.revenue.schedule(holdingId, query);
	}

	@Get('revenue/journal')
	@ApiOperation({
		summary: 'Asientos',
		description: 'Reconocimiento por mes de una compañía en su moneda, con su mapeo de cuentas y meses cerrados',
	})
	async revenueJournal(@Query() query: RevenueJournalDto, @HoldingId() holdingId: string) {
		return await this.revenue.journal(holdingId, query);
	}

	@Get('revenue/exceptions')
	@ApiOperation({
		summary: 'Excepciones',
		description: 'Sin tipo de cambio, sin devengo, sin cuentas, legacy sin vincular, recalculado en meses cerrados',
	})
	async revenueExceptions(@Query() query: ExceptionsDto, @HoldingId() holdingId: string) {
		return await this.revenue.exceptions(holdingId, query);
	}
}
