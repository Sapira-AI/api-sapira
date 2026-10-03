import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { BILLING_PERMISSIONS, BillingPermissionGuard, RequireBillingPermission } from './billing-permissions.service';
import { BillingReconciliationService } from './billing-reconciliation.service';
import {
	IgnoreMovementDto,
	MatchesDto,
	ReconciliationCandidatesQueryDto,
	ReconciliationMovementsQueryDto,
	ReconciliationSuggestionsQueryDto,
	ReconciliationSummaryQueryDto,
	ReconciliationTemplateDto,
	RefreshSuggestionsDto,
	ReopenMovementDto,
	RevertStatementDto,
	StatementImportDto,
	StatementPreviewDto,
	StatementsListQueryDto,
	UndoMatchDto,
} from './dtos/billing-reconciliation.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');
const MOVEMENT_PARAM = { name: 'movementId', description: 'UUID del movimiento bancario' };
const ROW =
	'{ id, date, description, reference, counterparty_name, counterparty_tax_id, amount, currency, bank_account_id, bank_name, account_number, batch_id, state, applied, remaining, adjustments, ignore_reason, reconciled_at, reconciled_by{ id, name }, best{ key, confidence, score, shape, reasons[], allocations[{ invoice_id, invoice_number, client_id, client_name, contract_id, currency, balance, amount }], movement_ids[], total, difference } | null, payments[] }';
const MATCH_ITEM =
	'{ items[{ key, ok, movement_ids, currency, invoice_currency, fx_rate, movements[{ id, amount, applied_before, applied_after, remaining_after, state_after }], invoices[{ invoice_id, invoice_number, client_name, contract_id, cash_amount, adjustment_amount, adjustment_reason, before, after }], blockers[], warnings[] }], summary{ ok, blocked, by_currency[{ currency, cash, adjustments, items }] } }';

/**
 * Conciliación bancaria v2 (`docs/v2-rediseno/spec-conciliacion-v2.md` §4): cartolas, cola de abonos, sugerencias, conciliar (con vista
 * previa), deshacer, ignorar/reabrir y plantillas. Lecturas `VIEW_FACTURACION`; escrituras `EDIT_FACTURACION`. Holding por
 * `HoldingScopeGuard` + `@HoldingId()`. Todo pago pasa por `BillingPaymentsService` (single path).
 */
@ApiTags('Billing · Conciliación')
@Controller('billing/reconciliation')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, BillingPermissionGuard)
@RequireBillingPermission(BILLING_PERMISSIONS.view)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class BillingReconciliationController {
	constructor(private readonly reconciliation: BillingReconciliationService) {}

	// ---------------------------------------------------------------- lecturas

	@Get('summary')
	@ApiOperation({
		summary: 'KPIs de conciliación',
		description:
			'{ period{ from, to }, pending, reconciled_period, differences, unidentified (cada uno { count, by_currency[{ currency, amount }] }), ignored{ count }, by_confidence{ exact, high, medium, none }, accounts[], has_source, last_batch }',
	})
	async summary(@Query() query: ReconciliationSummaryQueryDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.summary(holdingId, query);
	}

	@Get('movements')
	@ApiOperation({ summary: 'Cola de movimientos', description: `Paginado { data[fila], total, items, currentPage, pages, limit }; fila ${ROW}` })
	async movements(@Query() query: ReconciliationMovementsQueryDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.movements(holdingId, query);
	}

	@Get('movements/:movementId/suggestions')
	@ApiParam(MOVEMENT_PARAM)
	@ApiOperation({
		summary: 'Sugerencias de un movimiento',
		description:
			'{ movement: fila, suggestions[≤ 5]{ key, shape, confidence, score, reasons[], allocations[], movement_ids[], total, difference }, related_movements[fila] }; 404 fuera del holding',
	})
	async suggestions(
		@Param('movementId', new ParseUUIDPipe()) movementId: string,
		@Query() query: ReconciliationSuggestionsQueryDto,
		@HoldingId() holdingId: string
	) {
		return await this.reconciliation.suggestions(holdingId, movementId, query);
	}

	@Get('candidates')
	@ApiOperation({
		summary: 'Facturas candidatas',
		description:
			'Cobrables con saldo > 0 (vencimiento más antiguo primero): { data[{ invoice_id, invoice_number, client_id, client_name, client_entity_name, tax_id, contract_id, read_only, currency, total, balance, due_date, issue_date, status, payment_state }] }',
	})
	async candidates(@Query() query: ReconciliationCandidatesQueryDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.candidates(holdingId, query);
	}

	@Get('statements')
	@ApiOperation({
		summary: 'Importaciones de cartola',
		description:
			'Paginado de lotes { id, file_name, created_at, uploaded_by, bank_account, row_count, status, movements, reconciled, can_revert, revert_blocker }',
	})
	async statements(@Query() query: StatementsListQueryDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.statements(holdingId, query);
	}

	@Get('templates')
	@ApiOperation({ summary: 'Plantillas de mapeo por banco' })
	async templates(@HoldingId() holdingId: string) {
		return await this.reconciliation.templates(holdingId);
	}

	// ---------------------------------------------------------------- cartolas

	@Post('statements/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: importar cartola',
		description:
			'Normaliza y marca cada línea new | duplicate | error; resumen por moneda y aviso file_already_imported. No escribe. 404 no_bank_account',
	})
	async previewStatement(@Body() body: StatementPreviewDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.previewStatement(holdingId, body);
	}

	@Post('statements')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiOperation({
		summary: 'Importar cartola',
		description:
			'{ batch_id, inserted, skipped_duplicates, errors, template_id, warnings, suggestions{ exact, high, medium, none } }; 409 blocked nothing_to_import',
	})
	@ApiResponse({ status: 409, description: '{ code: blocked, blockers[{ code: nothing_to_import }] }' })
	async importStatement(@Body() body: StatementImportDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.reconciliation.importStatement(holdingId, body, authIdOf(req));
	}

	@Post('statements/:batchId/revert')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam({ name: 'batchId', description: 'UUID del lote' })
	@ApiOperation({ summary: 'Revertir importación', description: '{ batch_id, removed }; 409 batch_has_payments | already_reverted' })
	async revertStatement(
		@Param('batchId', new ParseUUIDPipe()) batchId: string,
		@Body() body: RevertStatementDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.reconciliation.revertStatement(holdingId, batchId, body, authIdOf(req));
	}

	// ---------------------------------------------------------------- plantillas

	@Post('templates')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiOperation({ summary: 'Crear plantilla de mapeo' })
	async createTemplate(@Body() body: ReconciliationTemplateDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.createTemplate(holdingId, body);
	}

	@Put('templates/:templateId')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiParam({ name: 'templateId', description: 'UUID de la plantilla' })
	@ApiOperation({ summary: 'Editar plantilla de mapeo' })
	async updateTemplate(
		@Param('templateId', new ParseUUIDPipe()) templateId: string,
		@Body() body: ReconciliationTemplateDto,
		@HoldingId() holdingId: string
	) {
		return await this.reconciliation.updateTemplate(holdingId, templateId, body);
	}

	@Delete('templates/:templateId')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@ApiParam({ name: 'templateId', description: 'UUID de la plantilla' })
	@ApiOperation({ summary: 'Eliminar plantilla de mapeo' })
	async deleteTemplate(@Param('templateId', new ParseUUIDPipe()) templateId: string, @HoldingId() holdingId: string) {
		return await this.reconciliation.deleteTemplate(holdingId, templateId);
	}

	// ---------------------------------------------------------------- conciliar

	@Post('matches/preview')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Vista previa: conciliar', description: `${MATCH_ITEM}. No escribe` })
	async previewMatches(@Body() body: MatchesDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.previewMatches(holdingId, body);
	}

	@Post('matches')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({
		summary: 'Conciliar',
		description: `Todo o nada por ítem, ítems independientes. ${MATCH_ITEM} + por ítem { applied, payment_ids, event_ids, error? }`,
	})
	async applyMatches(@Body() body: MatchesDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.reconciliation.applyMatches(holdingId, body, authIdOf(req));
	}

	@Post('movements/:movementId/undo')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam(MOVEMENT_PARAM)
	@ApiOperation({
		summary: 'Deshacer conciliación',
		description:
			'void de todos los pagos y ajustes del movimiento (nunca DELETE) y movimiento a Pendiente: { movement_id, voided_payment_ids, state }',
	})
	async undo(
		@Param('movementId', new ParseUUIDPipe()) movementId: string,
		@Body() body: UndoMatchDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.reconciliation.undo(holdingId, movementId, body, authIdOf(req));
	}

	@Post('movements/:movementId/ignore')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam(MOVEMENT_PARAM)
	@ApiOperation({ summary: 'Ignorar / No es una factura', description: '{ movement_id, state }; 409 movement_has_payments | movement_not_pending' })
	async ignore(
		@Param('movementId', new ParseUUIDPipe()) movementId: string,
		@Body() body: IgnoreMovementDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.reconciliation.ignore(holdingId, movementId, body, authIdOf(req));
	}

	@Post('movements/:movementId/reopen')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiParam(MOVEMENT_PARAM)
	@ApiOperation({ summary: 'Reabrir un ignorado', description: '{ movement_id, state }; 409 movement_not_ignored' })
	async reopen(
		@Param('movementId', new ParseUUIDPipe()) movementId: string,
		@Body() body: ReopenMovementDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.reconciliation.reopen(holdingId, movementId, body, authIdOf(req));
	}

	@Post('suggestions/refresh')
	@RequireBillingPermission(BILLING_PERMISSIONS.edit)
	@HttpCode(200)
	@ApiOperation({ summary: 'Actualizar sugerencias persistidas', description: '{ updated, by_confidence{ exact, high, medium, none } }' })
	async refreshSuggestions(@Body() body: RefreshSuggestionsDto, @HoldingId() holdingId: string) {
		return await this.reconciliation.refreshSuggestions(holdingId, body);
	}
}
