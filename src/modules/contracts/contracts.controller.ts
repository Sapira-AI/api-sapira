import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsService } from './contracts.service';
import { ActivateContractsDto, BulkContractIdsDto, BulkContractSettingsDto } from './dtos/bulk-contracts.dto';
import { CreateContractDto } from './dtos/create-contract.dto';
import { QueryContractInvoicesDto } from './dtos/query-contract-invoices.dto';
import { QueryContractScheduleDto } from './dtos/query-contract-schedule.dto';
import { QueryContractSubscriptionsDto } from './dtos/query-contract-subscriptions.dto';
import { QueryContractsDto } from './dtos/query-contracts.dto';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');

const CONTRACT_PARAM = { name: 'id', type: String, description: 'UUID del contrato o su número (ej. CTR-2026-184)' };

/**
 * Contratos v2 — lectura (lista, KPIs, 360 con resumen, calendario de facturación, cantidades y documentos, ítems con
 * ítem madre, facturas, historial y devengo), creación de
 * borradores con vista previa del generador de facturas (C1, §3), activación con vista previa (C2), borrado lógico (C5,
 * uno o masivo) y configuración masiva de envío al ERP y emisión automática.
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
		private readonly contractActivationService: ContractActivationService
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
			'Compañías (con próximo número), monedas, tipos de ítem, unidades, condiciones de pago, tipos de documento y catálogo de productos del holding',
	})
	async formOptions(@HoldingId() holdingId: string) {
		return await this.contractDraftsService.formOptions(holdingId);
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

	@Delete(':id')
	@ApiOperation({ summary: 'Eliminar borrador', description: 'Borrado lógico: solo contratos En revisión sin facturas; deja evento DELETED' })
	@ApiParam(CONTRACT_PARAM)
	@ApiResponse({ status: 409, description: 'El contrato no es borrador o ya tiene facturas' })
	async remove(@Param('id') id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.contractDraftsService.remove(id, holdingId, authIdOf(req));
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
		summary: 'Cantidades del contrato',
		description: 'Cantidades registradas por ítem y período, con la factura del período si existe, y los ítems del contrato',
	})
	@ApiParam(CONTRACT_PARAM)
	async consumption(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contract360Service.consumption(id, holdingId);
	}

	@Get(':id/documents')
	@ApiOperation({ summary: 'Documentos del contrato', description: 'Lista de documentos adjuntos (sin descarga por ahora)' })
	@ApiParam(CONTRACT_PARAM)
	async documents(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contract360Service.documents(id, holdingId);
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

	@Get(':id/history')
	@ApiOperation({
		summary: 'Historial del contrato',
		description: 'Eventos del ciclo de vida (tipo normalizado) y modificaciones sin evento, más nuevos primero',
	})
	@ApiParam(CONTRACT_PARAM)
	async history(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractsService.history(id, holdingId);
	}

	@Get(':id/revenue')
	@ApiOperation({
		summary: 'Devengo del contrato',
		description: 'Resumen mensual del revenue schedule: reconocido, facturado, MRR, diferido y por facturar',
	})
	@ApiParam(CONTRACT_PARAM)
	async revenue(@Param('id') id: string, @HoldingId() holdingId: string) {
		return await this.contractsService.revenue(id, holdingId);
	}
}
