import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { BILLING_PERMISSIONS, BillingPermissionGuard, RequireBillingPermission } from '@/modules/billing/billing-permissions.service';

import { BudgetsService } from './budgets.service';
import { BudgetsQueryDto, UpsertBudgetDto } from './dtos/budgets.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '') || null;
const BUDGET =
	'{ id, kind, name, scenario, currency, period_granularity, fiscal_year, status, notes, total, lines_count, created_at, updated_at, lines[{ period_start, dimension_type, dimension_id, dimension_key, amount }], monthly{ "YYYY-MM": monto } }';

/**
 * Presupuestos genéricos (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10"). Holding por `HoldingScopeGuard`. Permisos: por
 * ahora **todos los kinds** usan los de Facturación (`VIEW_FACTURACION` para leer, `EDIT_FACTURACION` para escribir), porque los únicos
 * presupuestos con pantalla son `cash_in` y `billing`; cuando Ventas/Métricas tengan permisos propios, bookings y MRR se separan.
 */
@ApiTags('Budgets')
@Controller('budgets')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, BillingPermissionGuard)
@RequireBillingPermission(BILLING_PERMISSIONS.view)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class BudgetsController {
	constructor(private readonly budgets: BudgetsService) {}

	@Get()
	@ApiOperation({
		summary: 'Presupuestos del holding',
		description:
			'Sin archivados; filtros `kind` y `fiscal_year`. `[{ id, kind, name, scenario, currency, period_granularity, fiscal_year, status, notes, total, lines_count, created_at, updated_at }]`',
	})
	async list(@Query() query: BudgetsQueryDto, @HoldingId() holdingId: string) {
		return await this.budgets.list(holdingId, query);
	}

	@Get(':id')
	@ApiParam({ name: 'id', description: 'UUID del presupuesto' })
	@ApiOperation({ summary: 'Un presupuesto con sus líneas', description: BUDGET })
	async get(@Param('id', ParseUUIDPipe) id: string, @HoldingId() holdingId: string) {
		return await this.budgets.get(holdingId, id);
	}

	@Put()
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiOperation({
		summary: 'Crear o reemplazar un presupuesto',
		description: `Upsert por (kind, fiscal_year, scenario) entre los no archivados: actualiza la cabecera y reemplaza todas las líneas en una transacción. Reglas: montos ≥ 0 con 2 decimales; \`period_start\` = primer día de un período de la granularidad dentro del año; \`total\` sin entidad, \`company|seller|product|client\` con \`dimension_id\` del holding, \`segment|market\` con \`dimension_key\`; con línea total, cada dimensión suma el total del período. 400 \`errors[{ field, message }]\`; 409 \`budget_storage_missing\` sin la migración. Responde ${BUDGET}`,
	})
	async upsert(@Body() body: UpsertBudgetDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.budgets.upsert(holdingId, body, authIdOf(req));
	}

	@Post(':id/archive')
	@HttpCode(200)
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiParam({ name: 'id', description: 'UUID del presupuesto' })
	@ApiOperation({ summary: 'Archivar un presupuesto', description: `Libera su lugar (kind · año · escenario). Idempotente. Responde ${BUDGET}` })
	async archive(@Param('id', ParseUUIDPipe) id: string, @HoldingId() holdingId: string) {
		return await this.budgets.archive(holdingId, id);
	}
}
