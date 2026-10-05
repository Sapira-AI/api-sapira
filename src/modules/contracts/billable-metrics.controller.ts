import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { BillableMetricsService } from './billable-metrics.service';
import { CreateBillableMetricDto, UpdateBillableMetricDto } from './dtos/billable-metric.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');

/**
 * Métricas facturables del holding (Pricing v2 §2.1 y §5). Vive en el módulo de contratos hasta que exista un módulo de
 * pricing. Holding por `HoldingScopeGuard` + `@HoldingId()`.
 */
@ApiTags('Billable metrics')
@Controller('billable-metrics')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class BillableMetricsController {
	constructor(private readonly metrics: BillableMetricsService) {}

	@Get()
	@ApiOperation({
		summary: 'Métricas facturables del holding',
		description: 'Activas (o todas con `?includeArchived=true`), con `prices_count` y `last_sync_at`',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ data: [{ id, code, name, description, aggregation, unit, source_kind, source_config, status, prices_count, prices_total, last_sync_at, … }] }',
	})
	async list(@Query('includeArchived') includeArchived: string | undefined, @HoldingId() holdingId: string) {
		return await this.metrics.list(holdingId, { includeArchived: includeArchived === 'true' });
	}

	@Post()
	@ApiOperation({
		summary: 'Crear métrica facturable',
		description: 'Código único por holding; nace activa. Solo `manual`/`csv` son funcionales hoy',
	})
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]` (código repetido incluido)' })
	async create(@Body() body: CreateBillableMetricDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.metrics.create(body, holdingId, authIdOf(req));
	}

	@Get(':id')
	@ApiOperation({ summary: 'Métrica facturable' })
	@ApiParam({ name: 'id', type: String })
	@ApiResponse({ status: 404, description: 'No es del holding' })
	async get(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.metrics.get(id, holdingId);
	}

	@Patch(':id')
	@ApiOperation({ summary: 'Editar métrica facturable', description: 'Nombre, descripción, agregación, unidad y fuente; el código no cambia' })
	@ApiParam({ name: 'id', type: String })
	@ApiResponse({ status: 409, description: 'La métrica está archivada' })
	async update(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: UpdateBillableMetricDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.metrics.update(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/archive')
	@HttpCode(200)
	@ApiOperation({ summary: 'Archivar métrica facturable', description: '409 si tiene precios activos que la usan' })
	@ApiParam({ name: 'id', type: String })
	async archive(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.metrics.archive(id, holdingId, authIdOf(req));
	}
}
