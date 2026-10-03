import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceConsolidationService } from './contract-invoice-consolidation.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicePartialPoService } from './contract-invoice-partial-po.service';
import { ContractInvoiceReorganizeService } from './contract-invoice-reorganize.service';
import { ContractInvoiceVoidService } from './contract-invoice-void.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractRenewalsService } from './contract-renewals.service';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsService } from './contracts.service';
import { ActivateContractsDto, BulkContractIdsDto, BulkContractSettingsDto } from './dtos/bulk-contracts.dto';
import { ConsumptionBulkDto, QueryConsumptionPendingDto, UpsertConsumptionDto } from './dtos/consumption.dto';
import { ContractChangeRequestDto } from './dtos/contract-changes.dto';
import { ConsolidateInvoicesDto, UndoConsolidationDto } from './dtos/contract-invoice-consolidation.dto';
import { DiscountCreditNoteDto, VoidInvoiceDto } from './dtos/contract-invoice-credit-notes.dto';
import {
	PreviewDescriptionTemplateDto,
	SaveDescriptionTemplateDto,
	UpdateInvoiceDescriptionsDto,
	UpdateInvoiceReferencesDto,
} from './dtos/contract-invoice-descriptions.dto';
import { BulkEditInvoicesDto, EditInvoiceDto, ExplainInvoiceDeviationDto } from './dtos/contract-invoice-edit.dto';
import { PartialByPoDto } from './dtos/contract-invoice-partial-po.dto';
import { ReorganizeInvoicesDto } from './dtos/contract-invoice-reorganize.dto';
import {
	ErpResetInvoiceDto,
	ErpResetInvoicesBulkDto,
	InvoiceFxBulkDto,
	InvoiceFxDto,
	MarkInvoiceIssuedDto,
	RescheduleInvoiceDto,
	RescheduleInvoicesBulkDto,
	SendInvoiceNowDto,
} from './dtos/contract-invoices.dto';
import { DismissRenewalProposalDto } from './dtos/contract-renewals.dto';
import {
	ApplyScheduledChangeDto,
	CreateScheduledChangeDto,
	ScheduledChangeReasonDto,
	UpdateScheduledChangeDto,
} from './dtos/contract-scheduled-changes.dto';
import { CreateContractDto, PricePreviewDto, UpdateContractDto, UpdateContractTermsDto } from './dtos/create-contract.dto';
import { QueryContractFormOptionsDto } from './dtos/query-contract-form-options.dto';
import { QueryContractInvoicesDto } from './dtos/query-contract-invoices.dto';
import { QueryContractScheduleDto } from './dtos/query-contract-schedule.dto';
import { QueryContractSubscriptionsDto } from './dtos/query-contract-subscriptions.dto';
import { QueryContractsDto } from './dtos/query-contracts.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');

const INVOICE_PARAM = { name: 'invoiceId', type: String, description: 'UUID de la factura' };
const CONTRACT_PARAM = { name: 'id', type: String, description: 'UUID del contrato o su número (ej. CTR-2026-184)' };

/**
 * Contratos v2 — lectura (lista, KPIs, 360 con resumen, calendario de facturación, cantidades y documentos, ítems con
 * ítem madre, facturas, historial y devengo), creación de
 * borradores con vista previa del generador de facturas (C1, §3), activación con vista previa (C2), borrado lógico (C5,
 * uno o masivo), configuración masiva de envío al ERP y emisión automática, y Pricing v2 (`spec-pricing-v2.md`): vista
 * previa de precio y consumos por ítem y período con recálculo de la Por Emitir, y modificaciones de contrato con vista previa
 * (`spec-modificaciones-contrato-v2.md` §4: condiciones, razón social, bajas, cancelación, renovación, altas y cambios de precio o cantidad),
 * y operaciones sobre facturas del contrato (`spec-facturas-en-contrato-360.md` §3.1–3.3: enviar al ERP ahora, registrar emisión externa,
 * reprogramar y tipo de cambio por factura, cada una con `preview`; §3.6–3.7a: constructor de descripción y referencias OC/HES; §3.4: editar
 * una Por Emitir con conciliador de desvíos, masivo de encabezado y restablecer el borrador del ERP; §3.5: reorganizar el cronograma; §3.7b y
 * §3.8: facturar por OC, anular con NC espejo y reemitir, NC de descuento parcial sobre una emitida) y consolidación opcional entre
 * contratos (`spec-multimoneda-contrato.md` §7: candidatas, preview, aplicar y deshacer).
 * Holding por `HoldingScopeGuard` + `@HoldingId()` (`docs/v2-rediseno/autorizacion-y-tenancy.md`).
 */
@ApiTags('Contracts')
@Controller('contracts')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ContractsController {
	constructor(
		private readonly contractsService: ContractsService,
		private readonly contractDraftsService: ContractDraftsService,
		private readonly contractSubscriptionsService: ContractSubscriptionsService,
		private readonly contract360Service: Contract360Service,
		private readonly contractBulkService: ContractBulkService,
		private readonly contractActivationService: ContractActivationService,
		private readonly consumptionService: ConsumptionService,
		private readonly contractChangesService: ContractChangesService,
		private readonly contractInvoicesService: ContractInvoicesService,
		private readonly contractInvoiceDescriptionsService: ContractInvoiceDescriptionsService,
		private readonly contractInvoiceEditService: ContractInvoiceEditService,
		private readonly contractInvoiceReorganizeService: ContractInvoiceReorganizeService,
		private readonly contractInvoiceVoidService: ContractInvoiceVoidService,
		private readonly contractInvoicePartialPoService: ContractInvoicePartialPoService,
		private readonly contractInvoiceConsolidationService: ContractInvoiceConsolidationService,
		private readonly contractScheduledChangesService: ContractScheduledChangesService,
		private readonly contractRenewalsService: ContractRenewalsService
	) {}

	@Get()
	@ApiOperation({
		summary: 'Lista de contratos',
		description:
			'Paginada y filtrada en servidor (estado mostrado, cliente, razón social, compañía, moneda, producto, vencimiento por ítem y filtros avanzados), con conteo por estado y MRR del mes',
	})
	@ApiResponse({
		status: 200,
		description: '{ data, items, pages, currentPage, limit, counts, totals: { contracts, mrr, total_value_system, currency } }',
	})
	async list(@Query() query: QueryContractsDto, @HoldingId() holdingId: string) {
		return await this.contractsService.list(holdingId, query);
	}

	// Rutas fijas antes de `:id` para que Nest no las capture como un id.
	@Get('summary')
	@ApiOperation({
		summary: 'KPIs de contratos',
		description:
			'MRR del mes sin pendiente de renovar, pendiente de renovar aparte y conteos con el mismo estado de la lista: activos, por renovar, vencidos, borradores, pausados y por vencer en 30 días',
	})
	async summary(@HoldingId() holdingId: string) {
		return await this.contractsService.summary(holdingId);
	}

	@Get('renewal-proposals')
	@ApiOperation({
		summary: 'Propuestas de renovación abiertas (§9.3.5)',
		description:
			'Eventos RENEWAL_PROPOSED del job contracts-auto-renewal sin confirmar ni omitir, con los ítems que siguen sin renovar ni baja, fin más próximo, días que faltan, Σ mensual, preview y pactos on_renewal. `counts { open, renew_in_30_days, overdue }` = KPI "Renuevan en 30 días". Confirmar = POST /contracts/:id/changes con change.type renewal y origin { type: renewal_proposal, event_id }',
	})
	@ApiResponse({ status: 200, description: '{ data: RenewalProposalView[], counts: { open, renew_in_30_days, overdue } }' })
	async renewalProposals(@HoldingId() holdingId: string) {
		return await this.contractRenewalsService.listProposals(holdingId);
	}

	@Get('filter-options')
	@ApiOperation({
		summary: 'Opciones de filtro de contratos',
		description: 'Compañías, monedas, productos, tipos, países (cliente y razón social) y vendedores usados por los contratos del holding',
	})
	async filterOptions(@HoldingId() holdingId: string) {
		return await this.contractsService.filterOptions(holdingId);
	}

	@Get('subscriptions')
	@ApiOperation({
		summary: 'Suscripciones (Stripe)',
		description: 'Pestaña Suscripciones: paginada, búsqueda, estado (coma), orden, MRR del mes, ítems y productos, con conteo por estado',
	})
	@ApiResponse({ status: 200, description: '{ data, items, pages, currentPage, limit, counts }' })
	async subscriptions(@Query() query: QueryContractSubscriptionsDto, @HoldingId() holdingId: string) {
		return await this.contractSubscriptionsService.list(holdingId, query);
	}

	@Get('subscriptions/summary')
	@ApiOperation({ summary: 'KPIs de suscripciones', description: 'Suscripciones activas, con pago pendiente y MRR del mes en moneda del sistema' })
	async subscriptionsSummary(@HoldingId() holdingId: string) {
		return await this.contractSubscriptionsService.summary(holdingId);
	}

	@Get('form-options')
	@ApiOperation({
		summary: 'Opciones del formulario de contrato',
		description:
			'Compañías (con próximo número, país ISO-2, documentos tributarios que puede emitir y el sugerido), monedas, tipos de ítem, unidades, condiciones de pago, familias de documento y catálogo de productos del holding. `?client_entity_id` afina la sugerencia (exportación si la razón social es de otro país)',
	})
	async formOptions(@Query() query: QueryContractFormOptionsDto, @HoldingId() holdingId: string) {
		return await this.contractDraftsService.formOptions(holdingId, new Date(), { clientEntityId: query.client_entity_id });
	}

	@Get('from-quote/:quoteId')
	@ApiOperation({ summary: 'Borrador desde una cotización', description: 'Prellenado del contrato desde una cotización del holding' })
	@ApiParam({ name: 'quoteId', type: String })
	@ApiResponse({ status: 404, description: 'Cotización no encontrada en el holding' })
	@ApiResponse({ status: 409, description: 'La cotización ya tiene un contrato' })
	async fromQuote(@Param('quoteId', new ParseUUIDPipe()) quoteId: string, @HoldingId() holdingId: string) {
		return await this.contractDraftsService.fromQuote(quoteId, holdingId);
	}

	@Post('preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de facturas',
		description:
			'Mismo body que crear; devuelve las facturas que generaría el contrato (fechas, líneas, IVA, totales y advertencias). No guarda nada',
	})
	async preview(@Body() body: CreateContractDto, @HoldingId() holdingId: string) {
		return await this.contractDraftsService.preview(body, holdingId);
	}

	@Post('price-preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de un modelo de precio (Pricing v2)',
		description:
			'`{ price: PriceSpec, discount_pct?, quantities: number[] }` → un `PricedLine` por cantidad simulada (gratis → tramos → descuento → mínimo → tope, con sublíneas). No guarda nada',
	})
	@ApiResponse({
		status: 200,
		description: 'PricedLine[]: { quantity, quantity_source, billable_quantity, subtotal, effective_unit_price, breakdown[], warnings[] }',
	})
	@ApiResponse({ status: 400, description: '`errors[{ field: price.tiers[i].from, message }]` para tramos inválidos' })
	pricePreview(@Body() body: PricePreviewDto) {
		return ContractDraftsService.pricePreview(body);
	}

	@Post()
	@ApiOperation({
		summary: 'Crear contrato (borrador)',
		description: 'Crea el contrato en "En revisión" en una transacción (número correlativo, ítems, evento) y devuelve el contrato 360',
	})
	@ApiResponse({ status: 201, description: 'Contrato 360 del borrador creado' })
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]`' })
	@ApiResponse({ status: 409, description: 'Número de contrato repetido o cotización ya usada' })
	async create(@Body() body: CreateContractDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.create(body, holdingId, authIdOf(req));
	}

	@Patch('bulk-settings')
	@ApiOperation({
		summary: 'Configuración masiva',
		description:
			'Enciende o apaga el envío automático al ERP y la emisión automática en varios contratos del holding, en una transacción, con un evento por contrato que cambia. La emisión automática requiere el envío automático (S6-10)',
	})
	@ApiResponse({ status: 200, description: '{ updated, unchanged, results: [{ id, contract_number, changed }] }' })
	@ApiResponse({
		status: 400,
		description: 'Sin cambios pedidos, contratos que no son del holding o regla S6-10: `errors[{ field: ids.N, message }]`',
	})
	async bulkSettings(@Body() body: BulkContractSettingsDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractBulkService.updateSettings(body, holdingId, authIdOf(req));
	}

	@Post('bulk-delete')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Eliminar borradores (masivo)',
		description:
			'Borrado lógico en una transacción de los que califican (En revisión sin facturas); los demás vuelven en `skipped` con el motivo',
	})
	@ApiResponse({ status: 200, description: '{ deleted: [{ id, contract_number }], skipped: [{ id, contract_number, reason }] }' })
	@ApiResponse({ status: 409, description: 'Falta aplicar la migración de borrado lógico' })
	async bulkDelete(@Body() body: BulkContractIdsDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.bulkRemove(body.ids, holdingId, authIdOf(req));
	}

	@Post('activate/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de activación',
		description:
			'Por contrato: si se puede activar, bloqueos, advertencias, facturas que se crearían (cantidad, primera fecha, total y muestra). No guarda nada',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ data: [{ id, contract_number, can_activate, blockers[{ code, message }], warnings, invoices_count, first_issue_date, total_to_invoice, currency, document_type, sample }] }',
	})
	async activatePreview(@Body() body: ActivateContractsDto, @HoldingId() holdingId: string) {
		return await this.contractActivationService.preview(body.ids, holdingId);
	}

	@Post('activate')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Activar contratos (C2)',
		description:
			'Activa los borradores sin bloqueos, cada uno en su propia transacción: crea las facturas Por Emitir con el generador v2, pasa a Activo, reconstruye el devengo y deja el evento ACTIVATION',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ activated: [{ id, contract_number, invoices_created }], skipped: [{ id, contract_number, blockers }], failed: [{ id, contract_number, message }] }',
	})
	async activate(@Body() body: ActivateContractsDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractActivationService.activate(body.ids, holdingId, authIdOf(req));
	}

	// ---------------------------------------------------------------- consolidación entre contratos (spec multimoneda §7)
	// Rutas fijas `invoices/consolidations…` antes de `:id` para que Nest no las capture como un id de contrato.

	@Post('invoices/consolidations/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: consolidar facturas de varios contratos',
		description:
			'`{ invoice_ids[] (2–50), notes? }`: Por Emitir activas de 2 o más contratos con la misma compañía, razón social receptora, moneda de factura, mes de emisión, documento, exportación y serie (los clientes comerciales pueden diferir). Valoriza cada línea por su par (spot entero si alguna línea que convierte es spot), antepone el número de contrato a la glosa, aporte por contrato y contrato principal (mayor aporte). No escribe nada',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ invoices[{ id, invoice_number, contract_id, contract_number, client_id, client_name, issue_date, invoice_series, amounts, lines_count, auto_invoice, blockers[] }], contributions[{ contract_id, contract_number, client_id, client_name, invoice_ids, lines_count, contract_currency, amount_contract_currency, subtotal_invoice_currency, subtotal_by_currency[{ currency, subtotal }], weight, main }], main_contract_id, header{ contract_id, client_id, …, contract_currency_mode, amount_contract_currency, vat, amount_invoice_currency, total_invoice_currency, fx_contract_to_invoice, spot, pairs[], auto_invoice, auto_send_to_erp, requires_references_for_billing }, lines[{ source_line_id, contract_id, contract_number, description, currency, fx, *_invoice_currency, spot_propagated }], references{ invoice_reference_ids, contract_reference_ids, items[{ kind, code, source }], deduped }, warnings[], blockers[], can_apply }',
	})
	@ApiResponse({ status: 404, description: 'Alguna factura no existe o es de otro holding' })
	async consolidationPreview(@Body() body: ConsolidateInvoicesDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceConsolidationService.preview(body, holdingId);
	}

	@Post('invoices/consolidations')
	@ApiOperation({
		summary: 'Consolidar facturas de varios contratos',
		description:
			'Una transacción: documento `Unificada` nuevo (grupo propio; encabezado del contrato principal; `auto_invoice` = AND de los orígenes; `requires_references_for_billing` heredado) con COPIAS de las líneas (prefijo de contrato, `contract_id` de la línea, tasa por par), referencias OC/HES sin repetir tipo+folio, orígenes `is_active = false` con `consolidated_into_invoice_id`, y un evento INVOICE_CONSOLIDATED por contrato',
	})
	@ApiResponse({ status: 201, description: 'El preview más `applied`, `consolidated_invoice_id`, `event_ids`, `invoice`' })
	@ApiResponse({
		status: 409,
		description:
			'`code: blocked` con `blockers[]` (credit_note, not_pending, already_consolidated, legacy_invoice, no_contract, partial_billing_invoice, open_consumption, sent_to_erp_draft (action erp_reset), single_contract, company_mismatch, entity_mismatch, currency_mismatch, month_mismatch, document_type_mismatch, export_type_mismatch, series_mismatch, tax_rate_mismatch)',
	})
	async consolidate(@Body() body: ConsolidateInvoicesDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractInvoiceConsolidationService.apply(body, holdingId, authIdOf(req));
	}

	@Post('invoices/consolidations/:invoiceId/undo')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Deshacer una consolidación',
		description:
			'`{ reason }`. Solo un consolidado v2 (con evento INVOICE_CONSOLIDATED) Por Emitir y sin borrador en el ERP: pasa a Cancelada (no se borra), los orígenes vuelven a `is_active = true` sin `consolidated_into_invoice_id`; evento INVOICE_CONSOLIDATION_UNDONE por contrato',
	})
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ consolidated, origins[], undone, consolidated_invoice_id, status: Cancelada, restored_invoice_ids, event_ids }',
	})
	@ApiResponse({
		status: 409,
		description: '`code: blocked` con `blockers[]` (not_consolidated, legacy_unified, not_pending, sent_to_erp_draft, no_origins)',
	})
	async undoConsolidation(
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: UndoConsolidationDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceConsolidationService.undo(invoiceId, body, holdingId, authIdOf(req));
	}

	@Delete(':id')
	@ApiOperation({ summary: 'Eliminar borrador', description: 'Borrado lógico: solo contratos En revisión sin facturas; deja evento DELETED' })
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 409, description: 'El contrato no es borrador o ya tiene facturas' })
	async remove(@Param('id') id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.remove(id, holdingId, authIdOf(req));
	}

	@Put(':id')
	@ApiOperation({
		summary: 'Editar borrador',
		description:
			'Solo En revisión sin facturas. Mismo body que crear (más `items[].id`): reemplaza encabezado, ítems (con id se actualizan, sin id se crean, los ausentes se eliminan) y tasas fijas en una transacción; conserva número, cotización y fecha de creación; deja evento DRAFT_UPDATED y devuelve el contrato 360',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]` (incluye `items.N.id` ajeno, número o cotización cambiados)' })
	@ApiResponse({ status: 404, description: 'Contrato no encontrado en el holding' })
	@ApiResponse({ status: 409, description: 'No es borrador, ya tiene facturas o un ítem a quitar tiene cantidades registradas' })
	async update(@Param('id') id: string, @Body() body: UpdateContractDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.update(id, body, holdingId, authIdOf(req));
	}

	@Patch(':id/terms')
	@ApiOperation({
		summary: 'Condiciones de factura del contrato',
		description:
			'Cambia `invoice_terms_and_conditions` en borradores y contratos vigentes (no cancelados) y deja el evento TERMS_UPDATED. Solo afecta facturas futuras: las Por Emitir existentes conservan su texto (`pending_invoices_updated: false`)',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ id, contract_number, invoice_terms_and_conditions, changed, pending_invoices_updated: false }' })
	@ApiResponse({ status: 409, description: 'El contrato está cancelado' })
	async updateTerms(@Param('id') id: string, @Body() body: UpdateContractTermsDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.updateTerms(id, body, holdingId, authIdOf(req));
	}

	@Get(':id/form')
	@ApiOperation({
		summary: 'Borrador como formulario',
		description: 'El borrador en la forma exacta del body de crear/editar (`form`, con `items[].id`), para cargar el formulario de edición',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ id, contract_number, status, created_at, form: CreateContractDto & { items[].id } }' })
	@ApiResponse({ status: 409, description: 'El contrato no es borrador' })
	async form(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractDraftsService.form(id, holdingId);
	}

	@Get(':id')
	@ApiOperation({ summary: 'Contrato 360', description: 'Encabezado, partes, monedas y políticas, MRR del mes y alertas de salud' })
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 404, description: 'Contrato no encontrado en el holding' })
	async detail(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractsService.detail(id, holdingId);
	}

	@Get(':id/overview')
	@ApiOperation({
		summary: 'Resumen del contrato 360',
		description:
			'Ciclo de vida por etapas, datos clave (monedas, tipo de cambio, renovación, facturación, referencias), números en moneda del contrato (MRR, valor total, facturado, por facturar, cobrado, vencido), próxima factura con sus bloqueos y enlaces',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 404, description: 'Contrato no encontrado en el holding' })
	async overview(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contract360Service.overview(id, holdingId);
	}

	@Get(':id/schedule')
	@ApiOperation({
		summary: 'Calendario de facturación',
		description:
			'Facturas por período (estado, montos, bloqueos de las por emitir, cola futura igual agrupada), totales, cobranza y tipo de cambio. `includeCancelled=true` suma las canceladas',
	})
	@ApiParam(CONTRACT_PARAM)
	async schedule(@Param('id') id: string, @Query() query: QueryContractScheduleDto, @HoldingId() holdingId: string) {
		return await this.contract360Service.schedule(id, holdingId, { includeCancelled: query.includeCancelled === 'true' });
	}

	@Get(':id/consumption')
	@ApiOperation({
		summary: 'Consumos del contrato (Pricing v2)',
		description:
			'`uses_usage_pricing` (hay ítems medidos), consumos registrados por ítem y período (`consumption_entries` con revisión, origen, desglose y factura del período) más las cantidades del front viejo (`source = legacy`), ítems con precio, métrica y períodos facturables, y pendientes de informar',
	})
	@ApiParam(CONTRACT_PARAM)
	async consumption(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.consumptionService.list(id, holdingId);
	}

	@Get(':id/consumption/pending')
	@ApiOperation({ summary: 'Pendientes de informar del contrato', description: 'Igual que `GET /consumption/pending`, acotado al contrato' })
	@ApiParam(CONTRACT_PARAM)
	async consumptionPending(@Param('id') id: string, @Query() query: QueryConsumptionPendingDto, @HoldingId() holdingId: string) {
		const contract = await this.contractsService.resolveContract(id, holdingId);

		return await this.consumptionService.pending(holdingId, query, contract.id);
	}

	@Post(':id/consumption/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de un consumo',
		description:
			'Mismo body que el PUT más `item_id` y `period_start`; devuelve la línea recalculada (`line`), sus filas de factura (`lines[]`, una en `single` y varias en `per_tier`) y la factura destino sin escribir. `apply_as` (alias `on_issued`): con la factura del período emitida, `recompute` → 409 con `issued_invoice`, `additional_amount`, `additional_allowed`, `additional_reason`; `additional` muestra la complementaria que se crearía (también con la Por Emitir del período, que no se toca); `reissue` la NC espejo (`credit_note`, `cancelled_invoice`) y la factura nueva. Ítems estándar: aceptan cantidad con la Por Emitir (cantidad × unitario del período)',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 409, description: '`code: consumption_period_issued | period_out_of_item | item_not_metered`' })
	async consumptionPreview(
		@Param('id') id: string,
		@Body() body: UpsertConsumptionDto & { item_id: string; period_start: string },
		@HoldingId() holdingId: string
	) {
		return await this.consumptionService.preview(id, body.item_id, body.period_start, body, holdingId);
	}

	@Post(':id/consumption/bulk')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Importar consumos (CSV)',
		description:
			'1–500 filas (`item_id` o `product_name` + `account`, `period_start`, `quantity`…), una transacción por fila; ninguna fila salta la regla de factura emitida',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ applied, skipped: [{ row, reason }], results: [{ row, item_id, period_start, entry_id, revision, event }] }',
	})
	async consumptionBulk(@Param('id') id: string, @Body() body: ConsumptionBulkDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.consumptionService.bulk(id, body, holdingId, authIdOf(req));
	}

	@Put(':id/items/:itemId/consumption/:periodStart')
	@ApiOperation({
		summary: 'Registrar o corregir el consumo de un período',
		description:
			'Upsert idempotente del consumo del ítem para el período de servicio que empieza en `periodStart`; recalcula la factura Por Emitir del período (filas según `invoice_line_mode`, encabezado, devengo) y deja el evento CONSUMPTION_RECORDED / CONSUMPTION_CORRECTED. `apply_as` (alias `on_issued`, block = recompute) decide cómo se aplica: `recompute` (default) recalcula la Por Emitir y, si la factura del período ya se emitió, → 409; `additional` → la factura del período (Por Emitir o emitida) no se toca y se crea una complementaria Por Emitir con fecha de hoy y una línea por la diferencia (evento CONSUMPTION_ADDITIONAL_INVOICE); `reissue` → NC espejo de la emitida + factura nueva del período (evento CONSUMPTION_REISSUE). Ítems estándar (sin modelo de precio) aceptan cantidad mientras la factura esté Por Emitir; emitida + recompute → 409 item_not_metered. Nunca toca la factura emitida',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam({ name: 'itemId', type: String })
	@ApiParam({ name: 'periodStart', type: String, description: 'YYYY-MM-DD = billing_period_start de la línea' })
	@ApiResponse({
		status: 200,
		description:
			'{ entry, line, lines[], invoice, event, mode, apply_as, on_issued, complements_invoice, issued_invoice, additional_amount, additional_allowed, additional_reason, credit_note, cancelled_invoice, created: { invoice_id?, credit_note_id? }, warnings, idempotent }',
	})
	@ApiResponse({
		status: 400,
		description:
			'Motivo obligatorio al corregir; período inválido; `code: no_additional_consumption` (la diferencia no es positiva: usa reissue)',
	})
	@ApiResponse({
		status: 409,
		description:
			'`code: consumption_period_issued` (con `issued_invoice`, `additional_amount`, `additional_allowed`, `additional_reason`, `options[]`) | `period_out_of_item` | `item_not_metered` (ítem estándar con la factura del período emitida y `apply_as = recompute`)',
	})
	async upsertConsumption(
		@Param('id') id: string,
		@Param('itemId', new ParseUUIDPipe()) itemId: string,
		@Param('periodStart') periodStart: string,
		@Body() body: UpsertConsumptionDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.consumptionService.upsert(id, itemId, periodStart, body, holdingId, authIdOf(req));
	}

	@Post(':id/changes/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de una modificación de contrato',
		description:
			'Mismo body que aplicar. `change.type`: billing_conditions (incl. auto_renew) | change_entity (client_entity_id o new_entity) | item_remove | contract_cancel (invoice_decisions) | renewal (precio nuevo, pactos on_renewal, extensión de tasas; origin renewal_proposal confirma una propuesta) | item_add (billing_cycle, quote_item_id) | item_change (frecuencia/plazo §9.3.7, quote_item_id) | multicurrency | reactivate (§9.3.2) | pause { items?, pause_start?, pause_end?, extend_term?, invoice_decisions? } | resume { items?, resume_date? } (§9.3.3); price_adjustment → 400. Devuelve antes/después del contrato, ítems, facturas, RSM, advertencias y bloqueos con el paso siguiente, y según el tipo `invoice_decisions_required`, `effective_date_suggestions` (contract_cancel, item_remove, pause), `scheduled_changes`, `fx_rates_extended`, `reactivation`, `pauses`. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description: 'ChangePreview (spec §4): { type, effective_date, contract, items, invoices, rsm, warnings, blockers, can_apply }',
	})
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]` (tipo diferido, ítem ajeno, valores inválidos)' })
	async changePreview(@Param('id') id: string, @Body() body: ContractChangeRequestDto, @HoldingId() holdingId: string) {
		return await this.contractChangesService.preview(id, body, holdingId);
	}

	@Post(':id/changes')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Aplicar una modificación de contrato',
		description:
			'Una transacción: bloquea el contrato, valida, escribe ítems (categoría, fin y precios explícitos), aplica el cambio mínimo a las Por Emitir (nunca emitidas: NC espejo), reconstruye el devengo, actualiza el encabezado y deja el evento con antes/después. Con advertencias exige `reason` o `notes`. Header opcional `Idempotency-Key`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Reenviar con la misma clave no vuelve a aplicar el cambio' })
	@ApiResponse({
		status: 200,
		description: 'El preview más `applied`, `idempotent`, `event_id`, `created { items, invoices, credit_notes }` y `detail` (contrato 360)',
	})
	@ApiResponse({ status: 400, description: 'Pedido inválido o advertencias sin motivo' })
	@ApiResponse({
		status: 409,
		description:
			'`code: blocked` con el `preview` (bloqueos: period_closed, not_active, issued_after_effective_date, item_already_churned, item_already_renewed, unified_invoice_in_range, fixed_fx_without_rate, quote_already_applied, new_business_quote_on_existing_contract, uf_invoice_currency, invoice_decision_required, entity_belongs_to_other_client, not_cancelled, index_value_missing, scheduled_change_not_scheduled, renewal_proposal_not_open, item_already_paused, pause_overlaps, not_paused)',
	})
	async applyChange(
		@Param('id') id: string,
		@Body() body: ContractChangeRequestDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		return await this.contractChangesService.apply(id, body, holdingId, authIdOf(req), idempotencyKey);
	}

	@Post(':id/renewal-proposals/:eventId/dismiss')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Omitir una propuesta de renovación (§9.3.5)',
		description: '`{ reason }`. La propuesta queda dismissed (no se vuelve a proponer para el mismo fin); evento RENEWAL_PROPOSAL_DISMISSED',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam({ name: 'eventId', type: String, description: 'Evento RENEWAL_PROPOSED' })
	@ApiResponse({ status: 200, description: '{ proposal_event_id, event_id, status: dismissed, reason }' })
	@ApiResponse({ status: 404, description: '`code: renewal_proposal_not_found`' })
	@ApiResponse({ status: 409, description: '`code: renewal_proposal_not_open` (ya confirmada u omitida)' })
	async dismissRenewalProposal(
		@Param('id') id: string,
		@Param('eventId', ParseUUIDPipe) eventId: string,
		@Body() body: DismissRenewalProposalDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractRenewalsService.dismiss(id, eventId, body.reason, holdingId, authIdOf(req));
	}

	// ---------------------------------------------------------------- ajustes pactados (spec modificaciones §9.3.6)

	@Get(':id/scheduled-changes')
	@ApiOperation({
		summary: 'Ajustes pactados del contrato',
		description: 'Todos los pactos (scheduled, applied, skipped, cancelled) con su ítem, disparo, valor y evento aplicado',
	})
	@ApiParam(CONTRACT_PARAM)
	async scheduledChanges(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractScheduledChangesService.list(id, holdingId);
	}

	@Post(':id/scheduled-changes')
	@ApiOperation({
		summary: 'Crear un ajuste pactado',
		description:
			'`{ contract_item_id?, trigger: on_renewal|on_date|every_n_months, effective_date?, anchor_date?, interval_months?, kind: percent_uplift|index|new_unit_price|quantity|term|billing_frequency, value, index_code?, index_base_value?, index_lag_months?, rounding?, notes? }`. Evento SCHEDULED_CHANGE_CREATED',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 400, description: '`errors[{ field, message }]` (campos por disparo y tipo, ítem ajeno o con baja)' })
	@ApiResponse({ status: 409, description: '`code: scheduled_change_contract_not_open` (contrato cancelado)' })
	async createScheduledChange(
		@Param('id') id: string,
		@Body() body: CreateScheduledChangeDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractScheduledChangesService.create(id, body, holdingId, authIdOf(req));
	}

	@Patch(':id/scheduled-changes/:changeId')
	@ApiOperation({
		summary: 'Editar un ajuste pactado programado',
		description: 'Solo `scheduled`. Evento SCHEDULED_CHANGE_UPDATED con antes/después',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 409, description: '`code: scheduled_change_not_editable`' })
	async updateScheduledChange(
		@Param('id') id: string,
		@Param('changeId', ParseUUIDPipe) changeId: string,
		@Body() body: UpdateScheduledChangeDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractScheduledChangesService.update(id, changeId, body, holdingId, authIdOf(req));
	}

	@Post(':id/scheduled-changes/:changeId/skip')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Omitir un ajuste pactado',
		description: '`{ reason }`. every_n_months: omite solo la próxima ocurrencia. Evento SCHEDULED_CHANGE_SKIPPED',
	})
	@ApiParam(CONTRACT_PARAM)
	async skipScheduledChange(
		@Param('id') id: string,
		@Param('changeId', ParseUUIDPipe) changeId: string,
		@Body() body: ScheduledChangeReasonDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractScheduledChangesService.skip(id, changeId, body, holdingId, authIdOf(req));
	}

	@Post(':id/scheduled-changes/:changeId/cancel')
	@HttpCode(200)
	@ApiOperation({ summary: 'Cancelar un ajuste pactado', description: '`{ reason }`. Evento SCHEDULED_CHANGE_CANCELLED' })
	@ApiParam(CONTRACT_PARAM)
	async cancelScheduledChange(
		@Param('id') id: string,
		@Param('changeId', ParseUUIDPipe) changeId: string,
		@Body() body: ScheduledChangeReasonDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractScheduledChangesService.cancel(id, changeId, body, holdingId, authIdOf(req));
	}

	@Post(':id/scheduled-changes/:changeId/apply/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de aplicar un ajuste pactado',
		description:
			'`{ effective_date?, value?, reason?, notes? }`. on_renewal → renewal; precio/cantidad/índice → item_change desde el próximo inicio de período (sin prorrateo); plazo/frecuencia → item_change §9.3.7. Mismo ChangePreview; sin dato del índice → blocker index_value_missing',
	})
	@ApiParam(CONTRACT_PARAM)
	async previewScheduledChange(
		@Param('id') id: string,
		@Param('changeId', ParseUUIDPipe) changeId: string,
		@Body() body: ApplyScheduledChangeDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractScheduledChangesService.applyPreview(id, changeId, body, holdingId);
	}

	@Post(':id/scheduled-changes/:changeId/apply')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Aplicar un ajuste pactado',
		description:
			'Materializa el pacto con el motor de modificaciones (una transacción). El evento es el del cambio (UPSELL/DOWNSELL subtipo price_step o index, RENEWAL, RENEGOTIATION) con `metadata.scheduled_change_id`; la fila queda applied con `applied_event_id` (every_n_months: hija applied y la madre avanza)',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiHeader({ name: 'Idempotency-Key', required: false })
	@ApiResponse({ status: 409, description: '`code: blocked` con el preview o `scheduled_change_not_editable`' })
	async applyScheduledChange(
		@Param('id') id: string,
		@Param('changeId', ParseUUIDPipe) changeId: string,
		@Body() body: ApplyScheduledChangeDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest,
		@Headers('idempotency-key') idempotencyKey?: string
	) {
		return await this.contractScheduledChangesService.apply(id, changeId, body, holdingId, authIdOf(req), idempotencyKey);
	}

	@Get(':id/documents')
	@ApiOperation({ summary: 'Documentos del contrato', description: 'Lista de documentos adjuntos; la descarga va por `:docId/download-url`' })
	@ApiParam(CONTRACT_PARAM)
	async documents(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contract360Service.documents(id, holdingId);
	}

	@Get(':id/documents/:docId/download-url')
	@ApiOperation({
		summary: 'URL firmada para descargar un documento del contrato',
		description: 'URL firmada de 60 s del bucket privado `contract-documents` y su vencimiento',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam({ name: 'docId', type: String, description: 'UUID del documento' })
	@ApiResponse({ status: 200, description: '{ url, expires_at }' })
	@ApiResponse({ status: 404, description: 'Documento que no es del contrato o sin archivo adjunto' })
	@ApiResponse({ status: 409, description: 'El almacenamiento no está configurado en la API' })
	async documentDownloadUrl(@Param('id') id: string, @Param('docId', new ParseUUIDPipe()) docId: string, @HoldingId() holdingId: string) {
		return await this.contract360Service.documentDownloadUrl(id, docId, holdingId);
	}

	@Get(':id/items')
	@ApiOperation({
		summary: 'Ítems del contrato',
		description: 'Todos los ítems con su estado y el ítem madre (estado vigente por producto y cuenta)',
	})
	@ApiParam(CONTRACT_PARAM)
	async items(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractsService.items(id, holdingId);
	}

	@Get(':id/invoices')
	@ApiOperation({ summary: 'Facturas del contrato', description: 'Paginadas, con filtro por estado (por emitir, emitidas, canceladas) y conteo' })
	@ApiParam(CONTRACT_PARAM)
	async invoices(@Param('id') id: string, @Query() query: QueryContractInvoicesDto, @HoldingId() holdingId: string) {
		return await this.contractsService.invoices(id, holdingId, query);
	}

	@Get(':id/invoices/preview')
	@ApiOperation({
		summary: 'Vista previa de facturas del borrador',
		description:
			'Las facturas que generaría el borrador guardado, calculadas al vuelo con el mismo motor y la misma forma que `POST /contracts/preview` (fechas, líneas, IVA, totales, tipo de cambio y advertencias). No guarda nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 404, description: 'Contrato no encontrado en el holding' })
	@ApiResponse({ status: 409, description: '`code: not_draft` si el contrato no está En revisión' })
	async invoicePreview(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractDraftsService.invoicePreview(id, holdingId);
	}

	@Get(':id/invoices/deviations')
	@ApiOperation({
		summary: 'Por Emitir que se desvían del plan sin motivo',
		description:
			'Conciliador de desvíos (spec facturas §3.4) sobre las Por Emitir activas del contrato: las que difieren por línea de lo que el plan espera por ítem y período (motor con los ítems vigentes y los consumos) y no tienen motivo registrado en `invoice_adjustments`. Corre el motor una vez por contrato (no va en las alertas del 360)',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ data[{ invoice_id, invoice_number, issue_date, billing_period_start, billing_period_end, deviation: { has_deviation, total_diff, by_item[], inherited, changed, currency } }], total }',
	})
	async invoiceDeviations(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractInvoiceEditService.deviations(id, holdingId);
	}

	@Get(':id/invoices/schedule-lines')
	@ApiOperation({
		summary: 'Tablero de Reorganizar: Por Emitir con sus líneas',
		description:
			'Lectura para el tablero de Reorganizar (spec facturas §3.5) sin N llamadas al detalle: Por Emitir activas ordenadas por período, cada una con bloqueos (`operable`), residuo encabezado ↔ Σ líneas y sus líneas (ítem, período, montos, grupo por tramo `per_tier_group`, marcas `manual`, `locked`, `one_off_discount`, `metered`, `is_visible`); períodos ya emitidos por ítem (anclas) e ítems del contrato. No corre el motor',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ contract_id, cutoff_date, invoices[{ id, invoice_number, status, issue_date, due_date, period_start, period_end, client_entity_id, legal_name, document_type, contract_currency, invoice_currency, fx_contract_to_invoice, amount_contract_currency, total_invoice_currency, header_residual, operable, blockers[], lines[] }], issued_periods[], items[], total }',
	})
	async invoiceScheduleLines(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractInvoiceReorganizeService.scheduleLines(id, holdingId);
	}

	@Get(':id/invoices/:invoiceId')
	@ApiOperation({
		summary: 'Detalle de una factura del contrato',
		description:
			'Solo lectura: encabezado (fechas programada y real, monedas, tipo de cambio por factura derivado `fx_policy` (same_currency | spot | fixed) / `fx_rate` (= `fx_contract_to_invoice`) / `fx_rate_source` (de las líneas) / `fx_confirmed_at` (último evento FX), IVA, ERP y `erp_sync_state`, `issued_externally` (evento)), líneas con `pricing_breakdown` y `quantity_source`, referencias (OC/HES), ajustes posteriores a la emisión, documentos relacionados (NC, original, consolidada, dividida), `history[]` (eventos del contrato que nombran la factura) y `last_send_attempt` (último intento de envío al ERP del log del scheduler, traducido: `{ at, ok, operation, category, message, next_step, action, raw }` o null)',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam({ name: 'invoiceId', type: String, description: 'UUID de la factura' })
	@ApiResponse({
		status: 200,
		description:
			'{ ...factura, fx_policy, fx_rate, fx_rate_source, fx_confirmed_at, issued_externally, erp_sync_state, lines[], references[], adjustments[], related_documents[], history[], last_send_attempt }',
	})
	@ApiResponse({ status: 404, description: 'Contrato de otro holding o factura que no es del contrato' })
	async invoiceDetail(@Param('id') id: string, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.contractInvoicesService.invoiceDetail(id, invoiceId, holdingId);
	}

	// ---------------------------------------------------------------- facturas del contrato: operaciones (spec facturas §3.1–3.3)

	@Post(':id/invoices/reschedule-bulk/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: reprogramar varias facturas Por Emitir',
		description:
			'`{ invoice_ids[], shift_months (1–12) | issue_date, reason? }`. Por factura: antes/después de emisión, programación, vencimiento y fecha original, bloqueos y avisos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ invoices[{ id, invoice_number, blockers, warnings, before, after }], updated[], skipped[], warnings[], can_apply }',
	})
	async rescheduleBulkPreview(@Param('id') id: string, @Body() body: RescheduleInvoicesBulkDto, @HoldingId() holdingId: string) {
		return await this.contractInvoicesService.previewRescheduleBulk(id, body, holdingId);
	}

	@Post(':id/invoices/reschedule-bulk')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Reprogramar varias facturas Por Emitir ("mover al mes siguiente")',
		description:
			'Una transacción: cada factura sin bloqueos pasa a la fecha (o se corre `shift_months`), conserva `original_issue_date`, recalcula el vencimiento por condición de pago y deja un evento INVOICE_RESCHEDULED (con `bulk_id`). Las bloqueadas se informan en `skipped`; si ninguna aplica → 409',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_ids[]`' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async rescheduleBulk(
		@Param('id') id: string,
		@Body() body: RescheduleInvoicesBulkDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.rescheduleBulk(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/fx-bulk/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: tipo de cambio de varias facturas Por Emitir',
		description:
			'`{ invoice_ids[], policy: spot | fixed | net_exact, rate?, target_net_amount?, reason? }` (net_exact: una sola factura). Por factura: política, tasa y montos antes/después, líneas, bloqueos (same_currency, uf_invoice_currency, sent_to_erp_draft…). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ invoices[{ id, invoice_number, blockers, warnings, before, after, lines[] }], updated[], skipped[], warnings[], can_apply }',
	})
	async fxBulkPreview(@Param('id') id: string, @Body() body: InvoiceFxBulkDto, @HoldingId() holdingId: string) {
		return await this.contractInvoicesService.previewFxBulk(id, body, holdingId);
	}

	@Post(':id/invoices/fx-bulk')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Tipo de cambio de varias facturas Por Emitir',
		description:
			'Una transacción: tasa POR FACTURA en `fx_contract_to_invoice` (NULL = spot hasta emitir), origen en `invoice_items.fx_rate_source`/`fx_rate_date`, confirmación en el evento INVOICE_FX_CHANGED por factura; recalcula líneas y encabezado en moneda de factura. No cambia la política del contrato',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_ids[]`' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async fxBulk(@Param('id') id: string, @Body() body: InvoiceFxBulkDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractInvoicesService.fxBulk(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/send-now/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: enviar una factura al ERP ahora',
		description:
			'Bloqueos del 360 (already_sent, erp_send_disabled, no_erp_integration, no_erp_partner, needs_reference, item_without_product, product_without_erp_mapping, fixed_fx_without_rate, tax_rate_missing, not_pending…), avisos (past_issue_date, spot_fx) y resumen (receptor, documento, total, FX). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ invoice, summary, blockers[], warnings[], can_apply }' })
	async sendNowPreview(@Param('id') id: string, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @HoldingId() holdingId: string) {
		return await this.contractInvoicesService.previewSendNow(id, invoiceId, holdingId);
	}

	@Post(':id/invoices/:invoiceId/send-now')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Enviar una factura Por Emitir al ERP ahora',
		description:
			'Corre los bloqueos y delega en el envío del scheduler para ESTA factura (FX resuelto al enviar, borrador en Odoo, `odoo_invoice_id`, `auto_invoice` → emisión automática), sin la regla del mes en curso. Evento INVOICE_SENT_MANUALLY si el ERP recibió el borrador; si no, `sent: false` con el motivo',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ sent, status: sent | error | skipped, odoo_invoice_id, message, blockers: [], warnings[], event_id, invoice }',
	})
	@ApiResponse({
		status: 409,
		description: '`code: blocked` con `blockers[]` y `preview`; NC/ND → `code: credit_note_send_pending` (envío de NC al ERP aún no disponible)',
	})
	async sendNow(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: SendInvoiceNowDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.sendNow(id, invoiceId, body ?? {}, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/mark-issued/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: registrar la emisión externa de una factura',
		description:
			'`{ invoice_number, issue_date, fx_rate?, notes?, reason? }`. Antes/después (estado, folio, emisión, vencimiento por condición de pago, tasa), bloqueos (sent_to_erp_draft, fx_rate_missing…) y avisos (erp_auto_send). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ invoice, before, after, rsm_from_month, blockers[], warnings[], can_apply }' })
	async markIssuedPreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: MarkInvoiceIssuedDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoicesService.previewMarkIssued(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/mark-issued')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Registrar la emisión externa de una factura Por Emitir (sin ERP)',
		description:
			'Una transacción: Por Emitir → Emitida con folio y fecha reales (la emisión externa queda como evento INVOICE_ISSUED_EXTERNALLY → `issued_externally` derivado), vencimiento por condición de pago del contrato, montos valorizados (multimoneda: tasa fija de la factura o `fx_rate` del body), RSM del período reconstruido y evento INVOICE_ISSUED_EXTERNALLY',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_id`, `invoice` (detalle)' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async markIssued(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: MarkInvoiceIssuedDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.markIssued(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/reschedule/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: reprogramar la emisión de una factura',
		description:
			'`{ issue_date, apply_to?: this | this_and_following, reason? }`. Con this_and_following las Por Emitir posteriores van al mismo día del mes elegido (recortado al fin de mes). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ invoices[{ id, invoice_number, blockers, warnings, before, after }], updated[], skipped[], warnings[], can_apply }',
	})
	async reschedulePreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: RescheduleInvoiceDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoicesService.previewReschedule(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/reschedule')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Reprogramar la emisión de una factura Por Emitir',
		description:
			'Una transacción: `scheduled_at = issue_date = nueva`, conserva `original_issue_date`, vencimiento por condición de pago del contrato (México +1 mes), período y líneas intactos. Evento INVOICE_RESCHEDULED con antes/después por factura',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_ids[]`, `invoice` (detalle)' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async reschedule(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: RescheduleInvoiceDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.reschedule(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/fx/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: tipo de cambio de una factura',
		description:
			'`{ policy: spot | fixed | net_exact, rate?, target_net_amount?, reason? }`. Política, tasa y montos antes/después (encabezado y líneas). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ invoices[{ id, invoice_number, blockers, warnings, before, after, lines[] }], updated[], skipped[], warnings[], can_apply }',
	})
	async fxPreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: InvoiceFxDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoicesService.previewFx(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/fx')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Tipo de cambio de una factura Por Emitir',
		description:
			'Una transacción: tasa de ESTA factura en `fx_contract_to_invoice` (fixed × tasa; net_exact: tasa derivada del neto exacto con ajuste de redondeo a la línea mayor; spot → NULL hasta emitir), origen en las líneas (`invoice_items.fx_rate_source`) y confirmación en el evento INVOICE_FX_CHANGED; recalcula líneas y encabezado en moneda de factura. No cambia la política del contrato',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_ids[]`, `invoice` (detalle)' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async fx(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: InvoiceFxDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.fx(id, invoiceId, body, holdingId, authIdOf(req));
	}

	// ---------------------------------------------------------------- editar una Por Emitir, desvíos, masivo y borrador del ERP (spec facturas §3.4, §3.1)

	@Post(':id/invoices/bulk-edit/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: cambio masivo de encabezado en Por Emitir',
		description:
			'`{ invoice_ids[] (≤200), invoice_terms_and_conditions?, client_entity_id?, auto_invoice? }`. Por factura: encabezado antes/después (receptor re-deriva RUT, IVA y exportación), bloqueos y avisos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoices[{ id, invoice_number, blockers, warnings, before, after, lines_retaxed }], updated[], skipped[], warnings[], can_apply }',
	})
	async bulkEditPreview(@Param('id') id: string, @Body() body: BulkEditInvoicesDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceEditService.previewBulkEdit(id, body, holdingId);
	}

	@Patch(':id/invoices/bulk-edit')
	@ApiOperation({
		summary: 'Cambio masivo de encabezado en Por Emitir',
		description:
			'Una transacción: aplica términos, receptor y/o emisión automática a las Por Emitir que pasan (mismas reglas que editar una); las bloqueadas van en `skipped`; un INVOICE_EDITED por factura con `bulk_id`. Si ninguna aplica → 409',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `bulk_id`, `event_ids[]`' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async bulkEdit(@Param('id') id: string, @Body() body: BulkEditInvoicesDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractInvoiceEditService.bulkEdit(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/erp-reset')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Restablecer el borrador del ERP de varias Por Emitir',
		description:
			'`{ invoice_ids[] (≤200), reason? }`. Una transacción: cada Por Emitir vinculada al ERP queda con `odoo_invoice_id`, `sent_to_odoo_at` y `sent_at` en NULL (nada más); evento INVOICE_ERP_DRAFT_RESET por factura con `bulk_id`. El borrador sigue en el ERP (eliminarlo allí). Las bloqueadas van en `skipped`; si ninguna aplica → 409',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoices[{ id, invoice_number, blockers, warnings, before, after }], updated[], skipped[], warnings[], can_apply, applied, bulk_id, event_ids[] }',
	})
	@ApiResponse({
		status: 409,
		description: '`code: blocked` con `blockers[]` (not_pending, not_sent_to_erp, unified_invoice, legacy_invoice, credit_note) y `preview`',
	})
	async erpResetBulk(@Param('id') id: string, @Body() body: ErpResetInvoicesBulkDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractInvoicesService.erpResetBulk(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/erp-reset')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Restablecer el borrador del ERP de una Por Emitir',
		description:
			'`{ reason?, notes? }`. Misma acción que la función vieja `reset_invoice_odoo_draft` (`odoo_invoice_id`, `sent_to_odoo_at`, `sent_at` en NULL) con evento INVOICE_ERP_DRAFT_RESET (antes, motivo, usuario). El borrador sigue en el ERP: aviso `erp_draft_remains`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoice_id, reset: true, previous_odoo_invoice_id, before, warnings[{ code: erp_draft_remains, message }], event_id, invoice }',
	})
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` y `preview`' })
	async erpReset(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: ErpResetInvoiceDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicesService.erpReset(id, invoiceId, body ?? {}, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/edit/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: editar una factura Por Emitir',
		description:
			'`{ lines[{ id?, contract_item_id, description?, quantity, unit_price, discount_pct?, billing_period_start, billing_period_end, amount_basis?, exact_total? }], line_mode[{ contract_item_id, mode, scope? }], issue_date?, due_date?, client_entity_id?, invoice_terms_and_conditions?, notes?, auto_invoice?, deviation?: { type, reason }, confirm_manual_overwrite? }`. Encabezado y líneas antes/después (ambas monedas), desvío contra el plan por ítem y período, avisos y bloqueos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoice: { id, invoice_number, status, before, after }, lines[{ id, action, before, after, is_visible }], line_mode[], deviation, warnings[], blockers[], can_apply }',
	})
	@ApiResponse({ status: 400, description: '`errors[{ field, message }]` (línea de otra factura, período invertido, receptor de otro cliente…)' })
	async editPreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: EditInvoiceDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceEditService.previewEdit(id, invoiceId, body, holdingId);
	}

	@Put(':id/invoices/:invoiceId')
	@ApiOperation({
		summary: 'Editar una factura Por Emitir como un todo',
		description:
			'Una transacción: líneas (nunca aplana: cantidad × unitario × (1 − descuento); cantidad 0 = línea oculta, nunca se borra; línea tocada → `quantity_source = manual`), presentación por tramo, fechas (conserva `original_issue_date`), receptor, términos, notas y emisión automática; encabezado = Σ líneas con la convención FX; devengo si cambió un monto; evento INVOICE_EDITED. Si queda distinta al plan sin motivo → 409 `deviation_reason_required`; con motivo, fila en `invoice_adjustments`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: 'El preview más `applied`, `event_id`, `adjustment_id` (o null) e `invoice` (detalle)' })
	@ApiResponse({ status: 409, description: '`code: blocked` (o `deviation_reason_required`) con `blockers[]` y `preview`' })
	async editInvoice(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: EditInvoiceDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceEditService.edit(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/deviation')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Explicar el desvío de una factura contra el plan',
		description:
			'`{ type: discount | upsell | downsell | correction, reason }`: registra el motivo de un desvío heredado (fila en `invoice_adjustments` con la diferencia que calcula el conciliador) y deja el evento INVOICE_DEVIATION_EXPLAINED',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 200, description: '{ invoice_id, deviation, adjustment_id, event_id, invoice }' })
	@ApiResponse({ status: 409, description: '`code: blocked` con `blockers[]` (no_deviation, credit_note, legacy_invoice, not_editable)' })
	async explainDeviation(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: ExplainInvoiceDeviationDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceEditService.explainDeviation(id, invoiceId, body, holdingId, authIdOf(req));
	}

	// ---------------------------------------------------------------- reorganizar el cronograma (spec facturas §3.5)

	@Post(':id/invoices/reorganize/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: reorganizar el cronograma de facturas',
		description:
			'`{ operations[], reason?, deviation?: { type, reason } }`. Operaciones en orden: merge `{ invoice_ids }` · move_line `{ line_id, to_invoice_id | new_invoice: { issue_date } }` · split_line `{ line_id, by: date | amount | installments, at?, amount?, count?, installments?[{ amount, issue_date? }], issue_date? }` · split_invoice `{ invoice_id, cut_date, issue_date? }` · item_monthly / item_unify_pending `{ contract_item_id, issue_date? }` / item_even_split `{ contract_item_id, count? }` · round_fix `{ invoice_id }`. Devuelve resultado por operación, facturas y líneas antes/después, continuidad por ítem antes → después (por líneas), avisos y bloqueos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ operations[{ index, op, ok, blockers[], warnings[] }], invoices[{ id | null, key, invoice_number, action: updated | created | cancelled | unchanged, split_from_invoice_id, before, after, lines[{ id | null, key, action: moved | split | created | updated | unchanged | removed, from_invoice_id, origin_line_id, to_invoice_key, per_tier_group, before, after }] }], continuity: { by_item[], changed, total_diff, inherited, reason_required, currency }, warnings[], blockers[], can_apply, rsm_from_month, summary }',
	})
	@ApiResponse({
		status: 400,
		description: '`errors[{ field: operations.N.…, message }]` (línea o factura de otro contrato, corte fuera del período, cuotas que no suman…)',
	})
	async reorganizePreview(@Param('id') id: string, @Body() body: ReorganizeInvoicesDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceReorganizeService.preview(id, body, holdingId);
	}

	@Post(':id/invoices/reorganize')
	@ApiOperation({
		summary: 'Reorganizar el cronograma de facturas',
		description:
			'Una transacción con cambio mínimo: líneas movidas conservan cantidad, unitario, descuento y período; divididas conservan la cantidad (unitario = subtotal ÷ cantidad); facturas nuevas desde las reglas del generador (receptor, documento, IVA, vencimiento por condición de pago, FX del contrato para su período; `split_reason = reorganize`); las que quedan sin líneas → Cancelada; encabezado = Σ líneas; devengo si cambió un período; evento INVOICES_REORGANIZED. Si cambia el total de un ítem sin motivo → 409 `deviation_reason_required`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 201,
		description: 'El preview más `applied`, `event_id`, `created_invoice_ids[]`, `cancelled_invoice_ids[]`, `adjustment_ids[]`',
	})
	@ApiResponse({ status: 409, description: '`code: blocked` (o `deviation_reason_required`) con `blockers[]` y `preview`' })
	async reorganize(@Param('id') id: string, @Body() body: ReorganizeInvoicesDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractInvoiceReorganizeService.apply(id, body, holdingId, authIdOf(req));
	}

	// ---------------------------------------------------------------- anular / NC de descuento / facturar por OC (spec facturas §3.7b, §3.8)

	@Post(':id/invoices/:invoiceId/void/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: anular una emitida con NC espejo (y reemitir)',
		description:
			'`{ reason: issue_error | client_request | other, notes?, reissue, reissue_changes?: <cuerpo del editor §3.4> }`. NC espejo completa (montos exactos en ambas monedas, IVA de cada línea, tasa, receptor; `credit_type = cancellation`, con el estado de la original —nunca Por Emitir—, sin vencimiento, pendiente de emisión electrónica) y, con `reissue`, la Por Emitir que la reemplaza (copia o con cambios por la lógica del editor), consumos del período que se liberan, avisos y bloqueos. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoice: { id, invoice_number, status, voided, paid }, credit_note: { credit_type, credit_reason, nc_revenue_treatment, status, issue_date, due_date: null, related_invoice_id, contract_currency, invoice_currency, fx_contract_to_invoice, lines[], totals }, reissue: { issue_date, due_date, notes, related_invoice_id, split_reason: reissue, header, lines[], deviation, revenue_effect } | null, consumption_entries[], warnings[], blockers[], can_apply }',
	})
	async voidPreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: VoidInvoiceDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceVoidService.previewVoid(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/void')
	@ApiOperation({
		summary: 'Anular una emitida con NC espejo (y reemitir)',
		description:
			'Una transacción: NC espejo (`insertMirrorCreditNote`, related_invoice_id = la original; la original conserva su estado y queda `voided`), reemisión Por Emitir (`related_invoice_id`, `split_reason = reissue`, notas "Reemplaza a …", referencias OC/HES copiadas), consumos del período ligados a la reemisión (o libres), devengo del mes del período y eventos INVOICE_VOIDED (+ INVOICE_REISSUED). La NC se emite desde Facturación',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 201,
		description:
			'El preview más `applied`, `credit_note_id`, `reissue_invoice_id`, `adjustment_id`, `event_ids[]`, `invoice` (detalle de la original)',
	})
	@ApiResponse({
		status: 409,
		description:
			'`code: blocked` con `blockers[]` (credit_note, not_issued, unified_invoice, legacy_invoice, already_voided, no_lines y los del editor en la reemisión) o `deviation_reason_required`',
	})
	async voidInvoice(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: VoidInvoiceDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceVoidService.voidInvoice(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/credit-note/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: NC de descuento parcial sobre una emitida',
		description:
			'`{ lines?: [{ line_id, amount? | pct? }] | pct?, reason: prompt_payment_discount | one_time_discount | compensation | other, revenue_treatment: service_period | impact_month | defer_forward, notes? }`. Montos en moneda de factura; una línea negativa por línea afectada (mismo ítem y período), IVA con la tasa de la original, tasa de la original; `revenue_effect` por mes. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ credit_note: { …, lines[], totals }, lines[{ line_id, contract_item_id, original_amount, previously_credited, requested, remaining_after }], revenue_effect: { treatment, total, by_month[] }, rsm_from_month, warnings[], blockers[], can_apply }',
	})
	@ApiResponse({ status: 400, description: '`errors[{ field: lines.N.amount | pct…, message }]`' })
	async creditNotePreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: DiscountCreditNoteDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceVoidService.previewCreditNote(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/credit-note')
	@ApiOperation({
		summary: 'NC de descuento parcial sobre una emitida',
		description:
			'Una transacción: NC con el estado de la factura (nunca Por Emitir; pendiente de emisión electrónica) sin vencimiento (`credit_type = discount`, `credit_reason`, `nc_revenue_treatment`, `related_invoice_id`), devengo reconstruido y evento INVOICE_CREDIT_NOTE_CREATED. La NC se emite desde Facturación; al emitirse, `nc_discount_revenue_adjustment` aplica el devengo',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 201, description: 'El preview más `applied`, `credit_note_id`, `event_id`, `invoice`' })
	@ApiResponse({
		status: 409,
		description: '`code: blocked` con `blockers[]` (not_issued, credit_note, already_voided, exceeds_line, unified_invoice, legacy_invoice)',
	})
	async createCreditNote(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: DiscountCreditNoteDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceVoidService.createCreditNote(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/:invoiceId/partial-by-po/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: facturar un monto cerrado por OC',
		description:
			'`{ reference: { type: OC | HES, code, date? }, amount_invoice_currency, allocation?: [{ line_id, amount }], visible_line_text, reason }` sobre una Por Emitir. Propuesta: subconjunto exacto de líneas visibles (≤ 12) o las más grandes más una parcial a precio de lista; línea visible + internas; saldo a una Por Emitir nueva del mismo período; FX (neto exacto) y `fx_difference`. No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ proposal: { mode: exact | partial | allocation, allocation[] }, covered_lines[], partial_line, visible_line, balance_lines[], covered_invoice: { id, invoice_number, invoice_currency, before, after }, remainder_invoice | null, fx: { policy_before, fx_before, fx_after, net_exact, covered_contract_total, covered_invoice_total, fx_difference, remainder_fx }, reference, rsm_from_month, warnings[], blockers[], can_apply }',
	})
	@ApiResponse({ status: 400, description: '`errors[{ field: allocation.N.amount | visible_line_text | amount_invoice_currency, message }]`' })
	async partialByPoPreview(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: PartialByPoDto,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoicePartialPoService.preview(id, invoiceId, body, holdingId);
	}

	@Post(':id/invoices/:invoiceId/partial-by-po')
	@ApiOperation({
		summary: 'Facturar un monto cerrado por OC',
		description:
			'Una transacción: una línea visible (la del documento; única que debe viajar al ERP) + internas con `visible_line_id`, encabezado = neto de la OC (neto exacto con conversión), referencia OC/HES en `invoice_references`, saldo a una Por Emitir nueva (`split_reason = partial_by_po`, `split_from_invoice_id`, notas "Saldo de OC …"), devengo y evento INVOICE_PARTIAL_BILLING',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({ status: 201, description: 'El preview más `applied`, `event_id`, `visible_line_id`, `remainder_invoice_id`, `invoice`' })
	@ApiResponse({
		status: 409,
		description:
			'`code: blocked` con `blockers[]` (not_pending, unified_invoice, legacy_invoice, credit_note, sent_to_erp_draft, partial_billing_invoice, spot_without_rate, no_visible_lines, exceeds_invoice)',
	})
	async partialByPo(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: PartialByPoDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoicePartialPoService.apply(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Get(':id/invoices/:invoiceId/consolidation-candidates')
	@ApiOperation({
		summary: 'Candidatas para consolidar con una factura',
		description:
			'Por Emitir activas de OTROS contratos del holding con la misma compañía, razón social receptora, moneda de factura, mes de emisión, documento y exportación (hasta 100), cada una con sus bloqueos (serie, ERP, OC, consumo abierto, período) y `eligible`; más la factura base y por qué ella misma no se podría consolidar',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ invoice{ id, invoice_number, contract_id, contract_number, …, eligible, blockers[] }, base_blockers[], candidates[{ id, invoice_number, contract_id, contract_number, client_id, client_name, issue_date, invoice_series, contract_currency, invoice_currency, amount_contract_currency, amount_invoice_currency, total_invoice_currency, lines_count, auto_invoice, eligible, blockers[] }], total }',
	})
	async consolidationCandidates(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@HoldingId() holdingId: string
	) {
		return await this.contractInvoiceConsolidationService.candidates(id, invoiceId, holdingId);
	}

	// ---------------------------------------------------------------- constructor de descripción y referencias (spec facturas §3.6–3.7a)

	@Get(':id/invoice-description-template')
	@ApiOperation({
		summary: 'Plantilla de descripción de las facturas del contrato',
		description:
			'La plantilla efectiva (la propia del contrato o la estándar `PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa`), el límite de caracteres del documento tributario (`tax_document_types.description_max_chars`; null = sin límite) y una muestra con la primera línea de la próxima Por Emitir',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description:
			'{ template: { separator?, blocks[{ type, format?, text? }] }, is_default, max_chars, sample: { line_id, invoice_id, text, length, exceeds, pending_fields[] } | null }',
	})
	async descriptionTemplate(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractInvoiceDescriptionsService.getTemplate(id, holdingId);
	}

	@Post(':id/invoice-description-template/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: plantilla de descripción',
		description:
			'`{ template, line_id? }` → la descripción renderizada con una línea real (la pedida o la de muestra), su largo contra el límite del documento y los datos que se completan al emitir (`pending_fields`: quantity, unit_price, amount, fx_rate, references). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ line_id, text, length, max_chars, exceeds, pending_fields[] }' })
	@ApiResponse({ status: 400, description: 'Plantilla inválida: `errors[{ field: template.blocks.N.…, message }]`' })
	async descriptionTemplatePreview(@Param('id') id: string, @Body() body: PreviewDescriptionTemplateDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceDescriptionsService.previewTemplate(id, body, holdingId);
	}

	@Put(':id/invoice-description-template')
	@ApiOperation({
		summary: 'Guardar la plantilla de descripción del contrato',
		description:
			'`{ template | null, apply_to_pending? }`. Guarda `contracts.invoice_description_template` (null = vuelve a la estándar); las facturas que se generen desde ahora la usan. Con `apply_to_pending` regenera las líneas de las Por Emitir activas no protegidas (`description_locked`) ni enviadas al ERP. Evento CONTRACT_DESCRIPTION_TEMPLATE_CHANGED con antes/después',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ template, is_default, updated_lines, skipped_locked }' })
	@ApiResponse({
		status: 400,
		description: '`errors[{ field: template, message }]` si la muestra (o una línea regenerada) supera el límite del documento',
	})
	async saveDescriptionTemplate(
		@Param('id') id: string,
		@Body() body: SaveDescriptionTemplateDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDescriptionsService.saveTemplate(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/invoices/descriptions/preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa: descripciones de líneas de varias facturas',
		description:
			'`{ invoice_ids?, line_ids?, mode: apply_template | apply_blocks | set | unlock, template?, text?, include_locked? }`. Por línea: antes/después, largo, si supera el límite, protección resultante y motivo si se salta (locked, unchanged o el bloqueo de su factura: not_pending, sent_to_erp_draft…). No escribe nada',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ lines[{ line_id, invoice_id, before, after, length, exceeds, locked, pending_fields[], skipped_reason? }], max_chars }',
	})
	async descriptionsPreview(@Param('id') id: string, @Body() body: UpdateInvoiceDescriptionsDto, @HoldingId() holdingId: string) {
		return await this.contractInvoiceDescriptionsService.previewDescriptions(id, body, holdingId);
	}

	@Patch(':id/invoices/descriptions')
	@ApiOperation({
		summary: 'Descripciones de líneas de facturas Por Emitir',
		description:
			'Una transacción sobre Por Emitir activas del contrato: set = texto manual (la línea queda protegida, `description_locked`); unlock = libera y regenera con la plantilla del contrato; apply_template / apply_blocks = regenera (salta las protegidas salvo `include_locked`). Rechaza (400) si alguna línea a escribir supera el límite del documento. Un evento INVOICE_DESCRIPTIONS_UPDATED por factura. Reemplaza `invoice_items_bulk_update_description`',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 200, description: '{ updated, skipped[{ line_id, reason }], event_ids[] }' })
	@ApiResponse({ status: 400, description: '`errors[{ field: text | lines | template…, message }]`' })
	async updateDescriptions(
		@Param('id') id: string,
		@Body() body: UpdateInvoiceDescriptionsDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDescriptionsService.updateDescriptions(id, body, holdingId, authIdOf(req));
	}

	@Put(':id/invoices/:invoiceId/references')
	@ApiOperation({
		summary: 'Referencias OC/HES de una factura',
		description:
			'`{ references[{ type: OC | HES | OTHER, code, date?, name?, document_type_code? (OTHER) }], requires_references_for_billing? }`: reemplaza las referencias propias de la factura en `invoice_references` (OC = SII 801, HES = HES; las del contrato vinculadas no se tocan). Por Emitir (aviso si ya hay borrador en el ERP) y emitidas solo si no se enviaron al ERP. Evento INVOICE_REFERENCES_UPDATED con antes/después',
	})
	@ApiParam(CONTRACT_PARAM)
	@ApiParam(INVOICE_PARAM)
	@ApiResponse({
		status: 200,
		description: '{ invoice_id, requires_references_for_billing, references[{ id, kind, type, name, code, date, source }], warnings[] }',
	})
	@ApiResponse({
		status: 409,
		description: '`code: blocked` con `blockers[]` (credit_note, not_editable, unified_invoice, legacy_invoice, sent_to_erp)',
	})
	async updateReferences(
		@Param('id') id: string,
		@Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
		@Body() body: UpdateInvoiceReferencesDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.contractInvoiceDescriptionsService.updateReferences(id, invoiceId, body, holdingId, authIdOf(req));
	}

	@Get(':id/history')
	@ApiOperation({
		summary: 'Historial del contrato',
		description:
			'Eventos del ciclo de vida (tipo normalizado) y modificaciones sin evento, más nuevos primero. Cada evento: `{ id, type, subtype, title, description, effective_date, amount_delta, items_affected, metadata (jsonb tal cual; null en modificaciones sin evento), created_at, created_by }`',
	})
	@ApiParam(CONTRACT_PARAM)
	async history(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractsService.history(id, holdingId);
	}

	// D-CTR-2: el devengo del contrato se lee de `GET /metrics/revenue/schedule?contractId=` (una sola fuente); `GET /contracts/:id/revenue` se retiró.
}
