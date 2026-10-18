import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { PERMISSION_CODES } from '@/guards/permission-codes';
import { RequirePermission, RequirePermissionGuard } from '@/guards/require-permission.guard';

import { AdoptPreviousInvoicesDto, AdoptPreviousInvoicesPreviewDto } from './dtos/onboarding-adopt.dto';
import {
	AssignInvoiceClientDto,
	CloseHistoryLineDto,
	EditHistoryLineDto,
	HistoryLinesQueryDto,
	HistorySeriesQueryDto,
	ImportApplyDto,
	ImportPreviewDto,
	LinkHistoryLineDto,
	OnboardingContractDto,
	OnboardingEventsQueryDto,
	PreviousInvoicesQueryDto,
	QuickStartApplyDto,
	QuickStartPreviewDto,
	RegisterHistoryDto,
	UnifyHistoryLinesDto,
} from './dtos/onboarding.dto';
import { OnboardingAdoptService } from './onboarding-adopt.service';
import { actorOf, type OnboardingRequest } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';
import { OnboardingSeriesService } from './onboarding-series.service';
import { OnboardingService } from './onboarding.service';

const KEY = {
	name: 'key',
	description: 'Clave del registro de MRR histórico (batch_id × cliente × moneda × contrato o vacío, codificada en base64url)',
};
const LINE =
	'{ key, root_key, batch_id, client{id,name}, currency, products[{ product_name, product_id, first_month, last_month, months_count, mrr_last, mrr_last_system }], first_month, last_month, months_count, mrr_last (= Σ products[].mrr_last, cada producto en su último mes vivo), mrr_last_system, status (linked si tiene contrato; si no pending | closed = No activado), contract{id,contract_number,status}|null, invoices_count, skip_reason (nota), companies[{id,legal_name}], legal_names[], registered_at, issues[] (history_after_contract) }';

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
		private readonly quickStart: OnboardingQuickStartService,
		private readonly series: OnboardingSeriesService,
		private readonly adopt: OnboardingAdoptService
	) {}

	// ---------------------------------------------------------------- resumen y eventos

	@Get('summary')
	@ApiOperation({
		summary: 'Resumen del empalme',
		description:
			'{ history{ records (batch_id × cliente × moneda × contrato), pending, linked, closed }, splice{ gap, seam_months, history_after_contract{ months, records, contracts }, contract_without_mrr }, previous_invoices{ total, without_history, with_history, linked, adopted, by_status }, settings{ metrics_history_start, system_currency } }',
	})
	summary(@HoldingId() holdingId: string) {
		return this.onboarding.summary(holdingId);
	}

	@Get('events')
	@ApiOperation({
		summary: 'Registro de cambios',
		description:
			'Paginado de { id, type, line_key (raíz del registro: batch_id × cliente × moneda), entity_type, entity_id, payload, actor{id,name}|null, created_at }. lineKey acepta la clave de un registro o su root_key: el historial sigue al registro aunque se empalme',
	})
	events(@HoldingId() holdingId: string, @Query() query: OnboardingEventsQueryDto) {
		return this.onboarding.events(holdingId, query);
	}

	// ---------------------------------------------------------------- MRR histórico (rutas fijas antes de lines/:key)

	@Get('history/series')
	@ApiOperation({
		summary: 'Serie mensual del MRR histórico',
		description:
			'{ currency_mode, system_currency, months[{ month, counted, counted_linked, counted_not_activated, counted_pending, after_contract, removed, contracts, by_currency[{ currency, …mismos montos }] }], rows[{ key, label, currency, values[] }], totals{ last_month, counted_last, lines, clients, rows_total }, filters_applied }. counted = cuenta (U14, sin quitadas) = empalmado + no activado + pendiente; after_contract = histórico después del inicio del contrato (error de datos; el mes de empalme no se reporta); removed = quitadas con código; contracts = MRR del devengo de los contratos empalmados (moneda de sistema). En contract/invoice los montos del mes son null y by_currency trae el desglose. Con groupBy, rows = top filas por el último mes con datos + "Otros". Con concept (linked | not_activated | pending), counted, by_currency, rows y rows_total consideran solo las filas de ese concepto (los otros counted_* van en 0); after_contract y removed no cambian',
	})
	historySeries(@HoldingId() holdingId: string, @Query() query: HistorySeriesQueryDto) {
		return this.series.series(holdingId, query);
	}

	@Get('history/filter-options')
	@ApiOperation({
		summary: 'Opciones de filtro de la serie del MRR histórico',
		description:
			'{ companies[{ id, legal_name }], countries[], currencies{ contract[], invoice[] } }: solo lo presente en el MRR histórico del holding',
	})
	historyFilterOptions(@HoldingId() holdingId: string) {
		return this.series.filterOptions(holdingId);
	}

	@Get('history/lines')
	@ApiOperation({
		summary: 'Registros de MRR histórico',
		description: `Un registro = batch_id × cliente × moneda × contrato (o sin contrato), con uno o varios productos y un solo estado. Query: status (pending,linked,closed), clientId, product (registros que lo contienen), batchId, contractId, issue, search, sortBy, sortOrder. Paginado { data[registro], total, currentPage, pages, limit }; registro ${LINE}`,
	})
	lines(@HoldingId() holdingId: string, @Query() query: HistoryLinesQueryDto) {
		return this.history.list(holdingId, query);
	}

	@Post('history/lines/unify')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Unificar registros pendientes',
		description:
			'Body { keys[] } (2–50 registros pendientes del mismo cliente y moneda; el primero manda): las filas de los demás toman su batch_id. Devuelve el registro resultante',
	})
	@ApiResponse({ status: 409, description: '{ code: record_not_pending | unify_mismatch }' })
	unify(@HoldingId() holdingId: string, @Body() body: UnifyHistoryLinesDto, @Request() req: OnboardingRequest) {
		return this.history.unify(holdingId, body, actorOf(req));
	}

	@Get('history/lines/:key')
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Detalle de un registro',
		description:
			'Registro + months[] (× producto, con counted U14), invoices[] (con registration por producto), splice, candidates[], events[] (de la raíz); 404 fuera del holding',
	})
	line(@HoldingId() holdingId: string, @Param('key') key: string) {
		return this.history.detail(holdingId, key);
	}

	@Post('history/lines/:key/edit/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Vista previa: editar línea (volver a registrar sus facturas)',
		description:
			'Body { invoices[{ invoice_id, period_from, period_to, contract_currency, amount_contract_currency, is_recurring?, products[] }] }. { line{ key, batch_id, currency, products[{ product_name, product_id, mrr_last }], first_month, last_month, months_count }, months[{ period_month, subtotal_contract_currency, mrr_contract_ccy, mrr_system_ccy, fx_contract_to_system, invoice_id, invoice_number, invoice_currency, amount_invoice_currency, fx_contract_to_invoice, is_recurring, products[], status: kept|changed|added|removed }], totals{ mrr_last_contract_ccy, mrr_last_system_ccy, system_currency }, warnings[{ code, invoice_id?, period_month?, message }], rekey{ from, to }|null, lines_touched[] }. No escribe',
	})
	editPreview(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: EditHistoryLineDto) {
		return this.history.editPreview(holdingId, key, body);
	}

	@Patch('history/lines/:key')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Editar línea (volver a registrar sus facturas)',
		description:
			'Borra las filas de cada factura listada en este registro y las vuelve a registrar (mismo batch_id, mismo contrato). { line|null, key, lines_touched[] }',
	})
	@ApiResponse({ status: 409, description: '{ code: line_linked_rekey }' })
	editLine(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: EditHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.editLine(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/link')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Relacionar con un contrato',
		description:
			'Solo sobre el registro sin contrato: todas sus filas pendientes. { line (el registro relacionado resultante, con su clave nueva), splice{ gap_months, seam_month, months_after_contract[], contract_first_month } }',
	})
	@ApiResponse({ status: 409, description: '{ code: contract_other_client | line_not_pending }' })
	link(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: LinkHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.link(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/unlink')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Desvincular',
		description: 'Solo sobre un registro con contrato; devuelve el registro sin contrato resultante (pendiente); 409 line_not_linked',
	})
	unlink(@HoldingId() holdingId: string, @Param('key') key: string, @Request() req: OnboardingRequest) {
		return this.history.unlink(holdingId, key, actorOf(req));
	}

	@Post('history/lines/:key/close')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'No activar',
		description: 'Solo registro sin contrato. Body { notes? }. Cuenta hasta su último mes (código churn); 409 line_not_pending',
	})
	close(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: CloseHistoryLineDto, @Request() req: OnboardingRequest) {
		return this.history.close(holdingId, key, body, actorOf(req));
	}

	@Post('history/lines/:key/reopen')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({ summary: 'Reabrir', description: 'Solo registro sin contrato. Lo no activado vuelve a pendiente; 409 line_not_closed' })
	reopen(@HoldingId() holdingId: string, @Param('key') key: string, @Request() req: OnboardingRequest) {
		return this.history.reopen(holdingId, key, actorOf(req));
	}

	@Get('history/lines/:key/contract/defaults')
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Contrato prellenado desde el registro',
		description: 'CreateContractDto prellenado (un ítem por producto) + products[] + origin{ type: history, record_key } + warnings[]',
	})
	contractDefaults(@HoldingId() holdingId: string, @Param('key') key: string) {
		return this.history.contractDefaults(holdingId, key);
	}

	@Post('history/lines/:key/contract/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Vista previa del contrato',
		description:
			'Body CreateContractDto + origin? + products? (del registro; por defecto todos). La de POST /contracts/preview + splice. No escribe',
	})
	contractPreview(@HoldingId() holdingId: string, @Param('key') key: string, @Body() body: OnboardingContractDto) {
		return this.history.contractPreview(holdingId, key, body);
	}

	@Post('history/lines/:key/contract')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam(KEY)
	@ApiOperation({
		summary: 'Crear contrato desde el registro',
		description:
			'Solo registro sin contrato. Body CreateContractDto + products? (los que se empalman; uno fuera queda pendiente). { contract{ id, contract_number }, line (el registro relacionado nuevo) }: En revisión y empalmado',
	})
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

	@Get('previous-invoices/filter-options')
	@ApiOperation({
		summary: 'Opciones de filtro de facturas previas',
		description: '{ companies[{ id, legal_name }], countries[] }: solo las presentes en facturas previas del holding',
	})
	filterOptions(@HoldingId() holdingId: string) {
		return this.previousInvoices.filterOptions(holdingId);
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
		description:
			'{ batch_id, inserted, skipped_duplicates, errors, entities_created, needs_client, history_rows_created, history_records_touched[], history_batch_ids[], history_skipped[] }. Registra el MRR histórico de las facturas con histórico ready (un registro por cliente × moneda). Nunca crea clientes comerciales',
	})
	@ApiResponse({ status: 409, description: '{ code: nothing_to_import }' })
	importApply(@HoldingId() holdingId: string, @Body() body: ImportApplyDto, @Request() req: OnboardingRequest) {
		return this.previousInvoices.applyImport(holdingId, body, actorOf(req));
	}

	@Post('previous-invoices/import/:batchId/revert')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiParam({ name: 'batchId', description: 'Lote de importación' })
	@ApiOperation({
		summary: 'Revertir importación',
		description: '{ batch_id, removed, history_rows_removed } (revierte también el MRR histórico registrado por el mismo lote)',
	})
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
			'Body { invoices[{ …, target_key? }], target_key? } (registro pendiente al que se suman). { rows[{ invoice_id, months[], mrr_per_month, fx_contract_to_invoice, products[], record_key|null, record_exists, existing_records[], warnings[], errors[] }], summary{ …, records_touched[], records_to_create } }. No escribe',
	})
	registerPreview(@HoldingId() holdingId: string, @Body() body: RegisterHistoryDto) {
		return this.registerHistory.preview(holdingId, body);
	}

	@Post('previous-invoices/register-history')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Registrar histórico',
		description:
			'Un registro (batch_id) por cliente × moneda, salvo target_key. { created_rows, records_touched[], batch_ids[], skipped[{ invoice_id, reason }] }',
	})
	register(@HoldingId() holdingId: string, @Body() body: RegisterHistoryDto, @Request() req: OnboardingRequest) {
		return this.registerHistory.register(holdingId, body, actorOf(req));
	}

	@Post('previous-invoices/adopt/preview')
	@HttpCode(200)
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Vista previa: adoptar como factura del contrato',
		description:
			'{ client, contracts[{ id, contract_number, status, contract_currency, first_month, last_month, pending_months[] }], contract, invoices[{ invoice, month, target{ kind: replace | create, invoice_id, amount_contract_currency, template_invoice_number }, amounts, history_months[], blockers[], warnings[], can_apply }], can_apply }. Sin contract_id trae los contratos candidatos del cliente. No escribe',
	})
	adoptPreview(@HoldingId() holdingId: string, @Body() body: AdoptPreviousInvoicesPreviewDto) {
		return this.adopt.preview(holdingId, body);
	}

	@Post('previous-invoices/adopt')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Adoptar como factura del contrato',
		description:
			'La factura previa pasa a ser la factura del mes del contrato (reemplaza la Por Emitir o se crea), con número, fechas, montos, estado e id del ERP; sus meses salen del histórico. Todo o nada. { applied, contract, adopted[{ previous_invoice_id, invoice_id, invoice_number, month, created }] }',
	})
	@ApiResponse({ status: 409, description: '{ code: adopt_blocked | target_changed | template_missing, preview }' })
	adoptApply(@HoldingId() holdingId: string, @Body() body: AdoptPreviousInvoicesDto, @Request() req: OnboardingRequest) {
		return this.adopt.apply(holdingId, body, actorOf(req));
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
	@ApiOperation({
		summary: 'Vista previa del arranque rápido',
		description:
			'Última factura por razón social, sus líneas, flags y existing_records[] (registros pendientes del cliente en esa moneda). No escribe',
	})
	quickStartPreview(@HoldingId() holdingId: string, @Body() body: QuickStartPreviewDto) {
		return this.quickStart.preview(holdingId, body);
	}

	@Post('quick-start')
	@RequirePermission(PERMISSION_CODES.editSettings)
	@ApiOperation({
		summary: 'Arranque rápido',
		description: '{ created[{ entity_id, contract{ id, contract_number }, history_rows, record_key }], skipped[{ entity_id, reason }] }',
	})
	quickStartApply(@HoldingId() holdingId: string, @Body() body: QuickStartApplyDto, @Request() req: OnboardingRequest) {
		return this.quickStart.apply(holdingId, body, actorOf(req));
	}
}
