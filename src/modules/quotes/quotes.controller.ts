import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { CreateContractDto } from '@/modules/contracts/dtos/create-contract.dto';

import { CreateQuoteDto, DuplicateQuoteDto, UpdateQuoteDto } from './dtos/create-quote.dto';
import { QueryQuoteFormOptionsDto, QueryQuotesDto } from './dtos/query-quotes.dto';
import { QuoteStageTransitionDto, UpdateQuoteStagesDto } from './dtos/quote-stage.dto';
import { QuoteListService } from './quote-list.service';
import { QuoteStagesService } from './quote-stages.service';
import { QuotesService } from './quotes.service';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');
const QUOTE_PARAM = { name: 'id', type: String, description: 'UUID de la cotización' };

/**
 * Cotizaciones v2 (`docs/v2-rediseno/mapa-v2-cotizaciones.md` §6): lista paginada con KPIs, 360, formulario, vista previa,
 * creación y edición con precios de Pricing v2, duplicado, borrado lógico, transiciones de etapa y la costura con Contratos.
 * Holding por `HoldingScopeGuard` + `@HoldingId()`.
 */
@ApiTags('Quotes')
@Controller('quotes')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class QuotesController {
	constructor(
		private readonly quotes: QuotesService,
		private readonly list: QuoteListService
	) {}

	@Get()
	@ApiOperation({
		summary: 'Lista de cotizaciones',
		description:
			'Paginada y filtrada en servidor (estado mostrado, kind, etapa, cliente, razón social, compañía, vendedor, moneda, tipo de negocio, producto, país, origen, con contrato, fechas y montos), con conteo por estado, totales por moneda y conversión 90 d',
	})
	@ApiResponse({
		status: 200,
		description: '{ data, items, pages, currentPage, limit, counts, totals: { quotes, by_currency[], conversion_90d } }',
	})
	async index(@Query() query: QueryQuotesDto, @HoldingId() holdingId: string) {
		return await this.list.list(holdingId, query);
	}

	// Rutas fijas antes de `:id`.
	@Get('summary')
	@ApiOperation({
		summary: 'KPIs de cotizaciones',
		description: 'Abiertas, enviadas, firmadas sin contrato, vencidas, perdidas 90 d, pipeline y MRR por moneda, conversión 90 d',
	})
	async summary(@HoldingId() holdingId: string) {
		return await this.list.summary(holdingId);
	}

	@Get('filter-options')
	@ApiOperation({
		summary: 'Opciones de filtro',
		description:
			'Etapas, estados, tipos de negocio, vendedores, compañías, monedas, productos, países y contactos usados por las cotizaciones del holding',
	})
	async filterOptions(@HoldingId() holdingId: string) {
		return await this.list.filterOptions(holdingId);
	}

	@Get('form-options')
	@ApiOperation({
		summary: 'Opciones del formulario',
		description:
			'Clientes, contactos y vendedores, tipos de negocio, etapas, monedas, compañías, catálogo de productos, tipos de ítem, unidades, métricas y defaults (`?clientId=` afina condición de pago, moneda y tipo sugerido)',
	})
	async formOptions(@Query() query: QueryQuoteFormOptionsDto, @HoldingId() holdingId: string) {
		return await this.quotes.formOptions(holdingId, { clientId: query.clientId });
	}

	@Post('preview')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Vista previa de la cotización',
		description: 'Mismo body que crear; devuelve ítems tarifados, totales, MRR y avisos. No guarda nada',
	})
	async preview(@Body() body: CreateQuoteDto, @HoldingId() holdingId: string) {
		return await this.quotes.preview(body, holdingId);
	}

	@Post()
	@ApiOperation({
		summary: 'Crear cotización (borrador)',
		description: 'Una transacción: correlativo COT-{año}-{NNNN}, encabezado, ítems con precio y evento CREATED. Devuelve el 360',
	})
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]`' })
	@ApiResponse({ status: 409, description: '`code: quote_number_taken | stage_kind_missing`' })
	async create(@Body() body: CreateQuoteDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.quotes.create(body, holdingId, authIdOf(req));
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Cotización 360',
		description: 'Encabezado, estado mostrado, ítems con modelo de precio, totales, vínculos con contratos, alertas, historial y documentos',
	})
	@ApiParam(QUOTE_PARAM)
	@ApiResponse({ status: 404 })
	async detail(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.quotes.detail(id, holdingId);
	}

	@Get(':id/form')
	@ApiOperation({
		summary: 'Cotización como formulario',
		description: 'La cotización en la forma exacta del body de crear/editar (`form`, con `items[].id`) y si es editable',
	})
	@ApiParam(QUOTE_PARAM)
	async form(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.quotes.form(id, holdingId);
	}

	@Put(':id')
	@ApiOperation({
		summary: 'Editar cotización',
		description:
			'Cualquier etapa salvo con contrato. En firmada/perdida exige `confirm_edit_after_signature: true`. Ítems: con id se actualizan (conservan el id), sin id se crean, ausentes se eliminan. Recalcula precios y total; evento UPDATED con el diff campo a campo (`metadata.changes`, `metadata.item_changes`)',
	})
	@ApiParam(QUOTE_PARAM)
	@ApiResponse({ status: 409, description: '`code: quote_has_contract | edit_requires_confirmation | item_linked_to_contract`' })
	async update(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: UpdateQuoteDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.quotes.update(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/stage')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Cambiar de etapa',
		description:
			'`{ stage_id | kind, booking_date?, reason? }`. Libre entre draft, sent, signed y lost en ambos sentidos (a signed: ítems completos + booking; a lost: motivo). booking_date se conserva al salir de firmada salvo que venga en el body. Nada entra ni sale de contract_created a mano; con contrato nada se mueve',
	})
	@ApiParam(QUOTE_PARAM)
	@ApiResponse({
		status: 409,
		description: '`code: invalid_transition | quote_has_contract | items_incomplete (+ errors[]) | booking_date_required | stage_kind_mismatch`',
	})
	async stage(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: QuoteStageTransitionDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.quotes.transition(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/duplicate')
	@ApiOperation({
		summary: 'Duplicar',
		description: 'Borrador nuevo con correlativo propio, sin datos de Salesforce ni booking; copia ítems y precios. Evento DUPLICATED_FROM',
	})
	@ApiParam(QUOTE_PARAM)
	async duplicate(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: DuplicateQuoteDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.quotes.duplicate(id, body ?? {}, holdingId, authIdOf(req));
	}

	@Get(':id/contract-targets')
	@ApiOperation({
		summary: 'Contratos donde aplicar la cotización',
		description:
			'Contratos Activos (vigentes o Por renovar) del cliente de la cotización, con sugerencia por ítem cotizado: `item_change` (producto vivo en el contrato, con el ítem madre y sus valores actuales) o `item_add` (producto nuevo, en la moneda de la cotización), `blockers` (quote_not_signed, quote_already_applied, new_business_quote_on_existing_contract) y `warnings` (pending_renewal_item_add, multicurrency_not_enabled). Se aplica con `POST /contracts/:id/changes` y `origin { type: quote, quote_id }` (`items[].quote_item_id`)',
	})
	@ApiParam(QUOTE_PARAM)
	async contractTargets(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.quotes.contractTargets(id, holdingId);
	}

	@Post(':id/contract')
	@ApiOperation({
		summary: 'Crear contrato desde la cotización',
		description:
			'Mismo body que `POST /contracts` (armado con `GET /contracts/from-quote/:id`); exige firmada sin contrato y delega en Contratos, que marca "Contrato creado". Devuelve el contrato 360',
	})
	@ApiParam(QUOTE_PARAM)
	@ApiResponse({ status: 409, description: '`code: quote_not_signed | quote_already_applied` o los 409 de `POST /contracts`' })
	async createContract(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: CreateContractDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.quotes.createContract(id, body, holdingId, authIdOf(req));
	}

	@Delete(':id')
	@ApiOperation({
		summary: 'Eliminar (lógico)',
		description: 'Solo borrador/enviada/perdida sin contrato; marca deleted_at y deja el evento DELETED',
	})
	@ApiParam(QUOTE_PARAM)
	@ApiResponse({ status: 409, description: '`code: quote_not_deletable`' })
	async remove(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.quotes.remove(id, holdingId, authIdOf(req));
	}
}

/** Etapas de cotización del holding (CRUD y orden con `kind`). */
@ApiTags('Quotes')
@Controller('quote-stages')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true })
export class QuoteStagesController {
	constructor(private readonly stages: QuoteStagesService) {}

	@Get()
	@ApiOperation({ summary: 'Etapas del holding', description: 'Ordenadas por posición, con kind y cantidad de cotizaciones' })
	async index(@HoldingId() holdingId: string) {
		return await this.stages.list(holdingId);
	}

	@Put()
	@ApiOperation({
		summary: 'Guardar etapas',
		description:
			'Lista completa y ordenada: con id actualiza, sin id crea, ausentes se eliminan (409 con cotizaciones o de sistema). Un solo signed y un solo lost (varios contract_created valen); al menos un draft',
	})
	@ApiResponse({ status: 409, description: '`code: stage_in_use`' })
	async replace(@Body() body: UpdateQuoteStagesDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.stages.replace(body, holdingId, authIdOf(req));
	}
}
