import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { CreatePriceDto, NewPriceVersionDto, QueryContractPricesDto, QueryPricesDto, UpdatePriceDto } from './dtos/price.dto';
import { PricesService } from './prices.service';

type AuthRequest = { user?: { sub?: string; id?: string } };
const authIdOf = (req: AuthRequest) => String(req.user?.sub ?? req.user?.id ?? '');

const PRICE_PARAM = { name: 'id', type: String, description: 'UUID del precio de catálogo' };
const PRICE_SHAPE =
	'{ id, name, product_id, product_name, currency, model, quantity_type, billable_metric: { id, code, name, unit } | null, version, status, supersedes_price_id, contracts_count, notes, published_at, archived_at, created_at, updated_at, spec: PriceSpec }';

/**
 * Catálogo de precios versionado (Pricing v2 etapa 3, `docs/v2-rediseno/spec-pricing-v2.md` §5). Los contratos lo referencian
 * con `items[].price_id` y reciben una copia (`owner = contract`, `list_price_id`): publicar o archivar una versión nunca toca
 * contratos existentes. Vive en el módulo de contratos hasta que exista un módulo de pricing. Holding por `HoldingScopeGuard`.
 */
@ApiTags('Prices')
@Controller('prices')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class PricesController {
	constructor(private readonly prices: PricesService) {}

	@Get()
	@ApiOperation({
		summary: 'Catálogo de precios del holding',
		description:
			'Paginado y filtrado en servidor (estado, producto, moneda, modelo, búsqueda por nombre de precio o producto); orden por lista blanca. `contracts_count` = contratos no eliminados con una copia del precio',
	})
	@ApiResponse({ status: 200, description: `{ data: [${PRICE_SHAPE}], total, currentPage, pages, limit }` })
	async list(@Query() query: QueryPricesDto, @HoldingId() holdingId: string) {
		return await this.prices.list(holdingId, query);
	}

	// Rutas fijas antes de `:id` (Nest las resuelve en orden de declaración).
	@Get('models/usage')
	@ApiOperation({
		summary: 'Uso de los modelos de precio en el holding',
		description:
			'Por modelo (standard, graduated, volume, package, seat) y tipo de cantidad (fixed, metered): ítems vivos (fin y churn nulos o desde hoy) de contratos no eliminados ni cancelados, contratos distintos, precios de catálogo no archivados y precios propios de contratos. Grilla completa con ceros; `model = none` = ítems vivos sin precio (fijo heredado). `totals.contracts` = contratos distintos con algún ítem vivo con precio',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ models: [{ model, quantity_type, items_in_use, contracts, catalog_prices, contract_prices }], by_model: [{ model, items_in_use, contracts }], by_quantity_type: [{ quantity_type, items_in_use, contracts }], totals: { items_in_use, contracts, catalog_prices, contract_prices } }',
	})
	async modelsUsage(@HoldingId() holdingId: string) {
		return await this.prices.modelsUsage(holdingId);
	}

	@Get('contract-prices')
	@ApiOperation({
		summary: 'Precios propios de los contratos (solo lectura)',
		description:
			'`owner = contract` de contratos no eliminados, paginado y filtrado (búsqueda por contrato, cliente, producto o precio; modelo; tipo de cantidad; producto). El modelo de un contrato se cambia en Modificar contrato',
	})
	@ApiResponse({
		status: 200,
		description:
			'{ data: [{ id, name, currency, model, quantity_type, contract: { id, number, status }, client: { id, name } | null, product: { id, name }, billable_metric | null, list_price_id, items_count, item_ids: string[] (el de inicio más reciente primero), updated_at, spec: PriceSpec }], total, currentPage, pages, limit }',
	})
	async contractPrices(@Query() query: QueryContractPricesDto, @HoldingId() holdingId: string) {
		return await this.prices.contractPrices(holdingId, query);
	}

	@Post()
	@ApiOperation({
		summary: 'Crear precio de catálogo',
		description:
			'Nace en borrador con `version` = siguiente de la cadena producto + moneda. `spec` tiene la misma forma que `items[].price` al crear un contrato',
	})
	@ApiResponse({ status: 201, description: PRICE_SHAPE + ' + versions[] + contracts[]' })
	@ApiResponse({ status: 400, description: '`message` + `errors[{ field, message }]` (producto, moneda, `spec.<campo>`)' })
	async create(@Body() body: CreatePriceDto, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.prices.create(body, holdingId, authIdOf(req));
	}

	@Get(':id')
	@ApiOperation({
		summary: 'Detalle de un precio de catálogo',
		description:
			'Con `versions[]` (cadena del mismo producto y moneda, la más nueva primero) y `contracts[]` que lo usan (hasta 50; el total es `contracts_count`)',
	})
	@ApiParam(PRICE_PARAM)
	@ApiResponse({
		status: 200,
		description: `${PRICE_SHAPE} & { versions: [{ id, name, version, status, supersedes_price_id, contracts_count, published_at, archived_at, updated_at }], contracts: [{ contract_id, contract_number, contract_status, client_name, item_id }] }`,
	})
	@ApiResponse({ status: 404, description: 'No es del holding o no es de catálogo' })
	async get(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.prices.get(id, holdingId);
	}

	@Patch(':id')
	@ApiOperation({
		summary: 'Editar un borrador',
		description: 'Nombre, modelo (`spec`) y nota. Producto y moneda no cambian: definen la cadena de versiones',
	})
	@ApiParam(PRICE_PARAM)
	@ApiResponse({ status: 409, description: 'El precio está publicado o archivado: crea una versión nueva' })
	async update(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: UpdatePriceDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.prices.update(id, body, holdingId, authIdOf(req));
	}

	@Post(':id/publish')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Publicar una versión',
		description:
			'Borrador → activo con `published_at`; la versión activa anterior del mismo producto + moneda queda archivada y la nueva la apunta con `supersedes_price_id`. Los contratos con copia de la anterior no cambian',
	})
	@ApiParam(PRICE_PARAM)
	@ApiResponse({ status: 200, description: 'Detalle + `superseded_price_id` (la versión que quedó archivada, o null)' })
	@ApiResponse({ status: 409, description: 'Ya publicado o archivado' })
	async publish(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.prices.publish(id, holdingId, authIdOf(req));
	}

	@Post(':id/archive')
	@HttpCode(200)
	@ApiOperation({
		summary: 'Archivar una versión',
		description:
			'Deja de poder elegirse en contratos nuevos. Permitido con contratos que la usan: conservan su copia (`warnings[]` lo avisa). Idempotente',
	})
	@ApiParam(PRICE_PARAM)
	@ApiResponse({ status: 200, description: 'Detalle + `warnings: string[]`' })
	async archive(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string, @Request() req: AuthRequest) {
		return await this.prices.archive(id, holdingId, authIdOf(req));
	}

	@Post(':id/new-version')
	@HttpCode(201)
	@ApiOperation({
		summary: 'Nueva versión desde una existente',
		description:
			'Copia el precio como borrador con `version + 1` de la cadena y `supersedes_price_id` = origen; el body (nombre, `spec`, nota) reemplaza lo copiado',
	})
	@ApiParam(PRICE_PARAM)
	async newVersion(
		@Param('id', new ParseUUIDPipe()) id: string,
		@Body() body: NewPriceVersionDto,
		@HoldingId() holdingId: string,
		@Request() req: AuthRequest
	) {
		return await this.prices.newVersion(id, body, holdingId, authIdOf(req));
	}
}
