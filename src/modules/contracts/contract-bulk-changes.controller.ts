import { Body, Controller, HttpCode, Post, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ContractBulkChangesService } from './contract-bulk-changes.service';
import { BulkAutoRenewDto, BulkScheduledChangeDto } from './dtos/bulk-contracts.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');

/**
 * Acciones masivas de la lista de contratos que cambian el contrato (Domi 13-11): ajuste de precio y renovación automática en lote.
 * Rutas fijas bajo `contracts/` (ninguna choca con `contracts/:id/...`); el controlador se registra antes que `ContractsController`.
 */
@ApiTags('Contracts')
@Controller('contracts')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ContractBulkChangesController {
	constructor(private readonly bulk: ContractBulkChangesService) {}

	@Post('bulk-scheduled-changes/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de un cambio futuro en lote',
		description:
			'`{ ids, change }` con `change` = el cuerpo de crear un ajuste pactado (sin contract_item_id). Por contrato: si se guardará el cambio futuro, cómo rige (desde el mes o al renovarse si termina antes), mensual antes y después, ítems excluidos (modelo de precio), bloqueos de hoy y motivo si se omite. No guarda nada',
	})
	@ApiResponse({
		status: 200,
		description: '{ data: [fila por contrato], summary: { contracts, to_save, skipped, on_date, on_renewal, with_blockers } }',
	})
	async bulkScheduledChangePreview(@Body() body: BulkScheduledChangeDto, @HoldingId() holdingId: string) {
		return await this.bulk.previewScheduledChange(body, holdingId);
	}

	@Post('bulk-scheduled-changes')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Cambio futuro en lote',
		description:
			'Crea un cambio futuro (reajuste porcentual de alcance contrato) en cada contrato, cada uno en su transacción con su evento. Rige desde el primer período de cada ítem en el mes pedido; el job diario lo aplica solo',
	})
	@ApiResponse({
		status: 200,
		description: '{ created: [{ id, contract_number, scheduled_change_id, applies }], skipped: [{ reason }], failed: [{ message }] }',
	})
	async bulkScheduledChange(@Body() body: BulkScheduledChangeDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.applyScheduledChange(body, holdingId, authIdOf(req));
	}

	@Post('bulk-auto-renew/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de la renovación automática en lote',
		description: '`{ ids, auto_renew }`. Por contrato: ítems que cambian, fin más próximo y motivo si se omite. No guarda nada',
	})
	async bulkAutoRenewPreview(@Body() body: BulkAutoRenewDto, @HoldingId() holdingId: string) {
		return await this.bulk.previewAutoRenew(body, holdingId);
	}

	@Post('bulk-auto-renew')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Renovación automática en lote',
		description:
			'Enciende o apaga la renovación automática de los ítems recurrentes vigentes de cada contrato (cambio billing_conditions, uno por contrato). Encendida, el contrato se renueva solo 30 días antes del fin',
	})
	@ApiResponse({ status: 200, description: '{ updated: [{ id, contract_number, items_changed }], skipped: [{ reason }], failed: [{ message }] }' })
	async bulkAutoRenew(@Body() body: BulkAutoRenewDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.bulk.applyAutoRenew(body, holdingId, authIdOf(req));
	}
}
