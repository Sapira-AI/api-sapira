import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import {
	AssignInvoiceClientDto,
	CloseHistoryLineDto,
	EditHistoryMonthsDto,
	HistoryLinesQueryDto,
	ImportApplyDto,
	ImportPreviewDto,
	LinkHistoryLineDto,
	OnboardingContractDto,
	OnboardingEventsQueryDto,
	PreviousInvoicesQueryDto,
	QuickStartApplyDto,
	QuickStartPreviewDto,
	RegisterHistoryDto,
	RemoveHistoryLineDto,
} from './dtos/onboarding.dto';
import { actorOf, type OnboardingRequest } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';
import { OnboardingService } from './onboarding.service';

const KEY = { name: 'key', description: 'Clave de la línea de MRR histórico (cliente × producto × moneda, codificada)' };
const LINE =
	'{ key, client{id,name}, product_name, product_id, currency, first_month, last_month, months_count, mrr_last, mrr_last_system, status, ended, contract{id,contract_number,status}|null, batch_ids[], invoices_count, skip_reason_code, skip_reason }';

/**
 * Onboarding de datos históricos (`docs/v2-rediseno/spec-onboarding-y-mrr-historico-v2.md` §5; formas exactas en
 * `mapa-v2-onboarding.md`): resumen, bandeja de MRR histórico, facturas previas (importar, registrar histórico, revertir), arranque
 * rápido y registro de cambios. Administración: leer = `VIEW_CONFIGURACION`, escribir = `EDIT_CONFIGURACION`. Holding por
 * `HoldingScopeGuard` + `@HoldingId()`.
 */
@ApiTags('Onboarding · Datos históricos')
@Controller('onboarding')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard, RequirePermissionGuard)
@RequirePermission(PERMISSION_CODES.viewSettings)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class OnboardingController {
	constructor(
		private readonly onboarding: OnboardingService,
		private readonly history: OnboardingHistoryService,
		private readonly previousInvoices: OnboardingPreviousInvoicesService,
		private readonly registerHistory: OnboardingRegisterService,
		private readonly quickStart: OnboardingQuickStartService
	) {}

	// ---------------------------------------------------------------- resumen y eventos

	@Get('summary')
	@ApiOperation({
		summary: 'Resumen del empalme',
		description:
			'{ history{ lines, pending, pending_ended, linked, closed, removed, clients_without_contract }, splice{ gap, overlap_cut, contract_without_mrr }, previous_invoices{ total, pending, linked, by_status }, settings{ metrics_history_start, system_currency } }',
	})
	summary(@HoldingId() holdingId: string) {
		return this.onboarding.summary(holdingId);
	}

	@Get('events')
	@ApiOperation({
		summary: 'Registro de cambios',
		description: 'Paginado de { id, type, line_key, entity_type, entity_id, payload, actor{id,name}|null, created_at }',
	})
	events(@HoldingId() holdingId: string, @Query() query: OnboardingEventsQueryDto) {
		return this.onboarding.events(holdingId, query);
	}

	// ---------------------------------------------------------------- MRR histórico

	@Get('history/lines')
	@ApiOperation({ summary: 'Líneas de MRR histórico', description: `Paginado { data[línea], total, currentPage, pages, limit }; línea ${LINE}` })
	lines(@HoldingId() holdingId: string, @Query() query: HistoryLinesQueryDto) {
		return this.history.list(holdingId, query);
	}

	@Get('history/lines/:key')
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Detalle de una línea',
		description: 'Línea + months[] (con counted U14), invoices[], splice, candidates[], events[]; 404 fuera del holding',
	})
	line(@HoldingId() holdingId: string, @Param('key') key: string) {
		return this.history.detail(holdingId, key);
	}

	@Patch('history/lines/:key/months')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Editar meses', description: 'Monto en moneda de contrato y recurrente; devuelve la línea' })
	editMonths(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: EditHistoryMonthsDto, @Request() req: OnboardingRequest) {
		return this.history.editMonths(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/link')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Empalmar con un contrato', description: '{ line, splice{ gap_months, overlap_months, contract_first_month } }' })
	@ApiResponse({ status: 409, description: '{ code: contract_other_client | line_not_pending }' })
	link(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: LinkHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.link(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/unlink')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Desvincular', description: 'La línea vuelve a pendiente; 409 line_not_linked' })
	unlink(@HoldingId() holdingId: string, @Param('key') key: string, @Request() req: OnboardingRequest) {
		return this.history.unlink(holdingId, key, actorOf(req));
	}

	@Post('history/lines/:key/close')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Cerrar (fue baja)', description: 'Cuenta hasta su último mes; 409 line_not_pending' })
	close(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: CloseHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.close(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/remove')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Quitar (duplicado o error)', description: 'Deja de contar en todo; 409 line_not_removable' })
	remove(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: RemoveHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.remove(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/reopen')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Reabrir', description: 'Lo cerrado o quitado vuelve a pendiente; 409 line_not_closed' })
	reopen(@HoldingId() holdingId: string, @Param('key') key: string, @Request() req: OnboardingRequest) {
		return this.history.reopen(holdingId, key, actorOf(req));
	}

	@Get('history/lines/:key/contract/defaults')
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Contrato prellenado desde la línea',
		description: 'CreateContractDto prellenado + origin{ type: history, line_key } + warnings[]',
	})
	contractDefaults(@HoldingId() holdingId: string, @Param('key') key: string) {
		return this.history.contractDefaults(holdingId, key);
	}

	@Post('history/lines/:key/contract/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Vista previa del contrato', description: 'La de POST /contracts/preview + splice. No escribe' })
	contractPreview(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: OnboardingContractDto) {
		return this.history.contractPreview(holdingId, key, body);
	}

	@Post('history/lines/:key/contract')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Crear contrato desde la línea', description: '{ contract{ id, contract_number }, line }: En revisión y empalmado' })
	@ApiResponse({ status: 409, description: '{ code: contract_other_client | line_not_pending }' })
	createContract(
		@HoldingId() holdingId: string,
		@Param('key') key: string,
		@Body() body: OnboardingContractDto,
		@Request() req: OnboardingRequest
	) {
		return this.history.createContract(holdingId, key, body, actorOf(req));
	}

	// ---------------------------------------------------------------- facturas previas (rutas fijas antes de :id)

	@Get('previous-invoices')
	@ApiOperation({
		summary: 'Facturas previas',
		description: 'Paginado de facturas externas con razón social, cliente, compañía, contrato, lote y has_history',
	})
	previousInvoicesList(@HoldingId() holdingId: string, @Query() query: PreviousInvoicesQueryDto) {
		return this.previousInvoices.list(holdingId, query);
	}

	@Get('previous-invoices/batches')
	@ApiOperation({ summary: 'Lotes importados', description: '[{ id, label, created_at, created_by, count, reverted }]' })
	batches(@HoldingId() holdingId: string) {
		return this.previousInvoices.batches(holdingId);
	}

	@Post('previous-invoices/import/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Vista previa: importar facturas previas',
		description: 'Cada fila new | duplicate | error | needs_entity | needs_client, con razones sociales y compañías faltantes. No escribe',
	})
	importPreview(@HoldingId() holdingId: string, @Body() body: ImportPreviewDto) {
		return this.previousInvoices.previewImport(holdingId, body);
	}

	@Post('previous-invoices/import')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Importar facturas previas',
		description: '{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client }. Nunca crea clientes comerciales',
	})
	@ApiResponse({ status: 409, description: '{ code: nothing_to_import }' })
	importApply(@HoldingId() holdingId: string, @Body() body: ImportApplyDto, @Request() req: OnboardingRequest) {
		return this.previousInvoices.applyImport(holdingId, body, actorOf(req));
	}

	@Post('previous-invoices/import/:batchId/revert')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam({ name: 'batchId', description: 'Lote de importación' })
	@ApiOperation({ summary: 'Revertir importación', description: '{ batch_id, removed }' })
	@ApiResponse({ status: 409, description: '{ code: batch_has_history | batch_linked | already_reverted }' })
	revert(@HoldingId() holdingId: string, @Param('batchId', new ParseUUIDPipe()) batchId: string, @Request() req: OnboardingRequest) {
		return this.previousInvoices.revertImport(holdingId, batchId, actorOf(req));
	}

	@Post('previous-invoices/register-history/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Vista previa: registrar histórico',
		description:
			'{ rows[{ invoice_id, months[], mrr_per_month, fx_contract_to_invoice, products[], warnings[], errors[] }], summary }. No escribe',
	})
	registerPreview(@HoldingId() holdingId: string, @Body() body: RegisterHistoryDto) {
		return this.registerHistory.preview(holdingId, body);
	}

	@Post('previous-invoices/register-history')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Registrar histórico', description: '{ created_rows, lines_touched[], skipped[{ invoice_id, reason }], batch_id }' })
	register(@HoldingId() holdingId: string, @Body() body: RegisterHistoryDto, @Request() req: OnboardingRequest) {
		return this.registerHistory.register(holdingId, body, actorOf(req));
	}

	@Get('previous-invoices/:id')
	@ApiParam({ name: 'id', description: 'Factura previa' })
	@ApiOperation({ summary: 'Detalle de una factura previa', description: 'Factura + items[] + history_months[] + events[]; 404 fuera del holding' })
	previousInvoice(@HoldingId() holdingId: string, @Param('id', new ParseUUIDPipe()) id: string) {
		return this.previousInvoices.detail(holdingId, id);
	}

	@Post('previous-invoices/:id/client')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam({ name: 'id', description: 'Factura previa' })
	@ApiOperation({
		summary: 'Relacionar con un cliente comercial',
		description: 'Vincula la razón social de la factura con un cliente existente; devuelve el detalle',
	})
	@ApiResponse({ status: 409, description: '{ code: invoice_without_entity }' })
	assignClient(
		@HoldingId() holdingId: string,
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: AssignInvoiceClientDto,
		@Request() req: OnboardingRequest
	) {
		return this.previousInvoices.assignClient(holdingId, id, body, actorOf(req));
	}

	// ---------------------------------------------------------------- arranque rápido

	@Post('quick-start/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({ summary: 'Vista previa del arranque rápido', description: 'Última factura por razón social, sus líneas y flags. No escribe' })
	quickStartPreview(@HoldingId() holdingId: string, @Body() body: QuickStartPreviewDto) {
		return this.quickStart.preview(holdingId, body);
	}

	@Post('quick-start')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Arranque rápido',
		description: '{ created[{ entity_id, contract{ id, contract_number }, history_rows }], skipped[{ entity_id, reason }] }',
	})
	quickStartApply(@HoldingId() holdingId: string, @Body() body: QuickStartApplyDto, @Request() req: OnboardingRequest) {
		return this.quickStart.apply(holdingId, body, actorOf(req));
	}
}
