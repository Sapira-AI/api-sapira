import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ClientDirectoryService } from './client-directory.service';
import { ClientEntityErpService } from './client-entity-erp.service';
import { ClientEntityMetricsService } from './client-entity-metrics.service';
import { ClientMetricsService } from './client-metrics.service';
import {
	AssignClientEntitiesDto,
	CreateClientEntityDto,
	LinkErpPartnerDto,
	QueryClientEntitiesDto,
	SearchErpPartnerDto,
	SearchNewErpPartnerDto,
	UpdateClientEntityDto,
} from './dtos/client-directory.dto';
import { QueryEntityContractsDto } from './dtos/query-client-contracts.dto';
import { QueryEntityInvoicesDto } from './dtos/query-entity-invoices.dto';

/** Razón social 360: detalle, indicadores y facturas de una razón social (`client_entities`). */
@ApiTags('Client entities')
@Controller('client-entities')
@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
@ApiBearerAuth()
@ApiHeader({ name: 'x-holding-id', required: true, description: 'Holding activo (validado contra user_holdings)' })
export class ClientEntitiesController {
	constructor(
		private readonly entityMetrics: ClientEntityMetricsService,
		private readonly directory: ClientDirectoryService,
		private readonly clientMetrics: ClientMetricsService,
		private readonly erp: ClientEntityErpService
	) {}

	@Get()
	@ApiOperation({
		summary: 'Razones sociales del holding',
		description: 'Paginadas, con clientes comerciales vinculados y cartera; filtro "sin cliente asignado"',
	})
	async list(@Query() query: QueryClientEntitiesDto, @HoldingId() holdingId: string) {
		return await this.directory.listEntities(holdingId, {
			page: query.page,
			limit: query.limit,
			search: query.search,
			country: query.country,
			unassigned: query.unassigned,
			sortBy: query.sort_by,
			sortOrder: query.sort_order,
		});
	}

	@Post()
	@ApiOperation({
		summary: 'Crear una razón social ligada a un cliente comercial',
		description:
			'Mismo camino que `change_entity` con `new_entity`. 409 `duplicate_tax_id` si el RUT ya existe en el holding (reintentar con `allow_duplicate_tax_id`)',
	})
	async create(@Body() body: CreateClientEntityDto, @HoldingId() holdingId: string) {
		const { allow_duplicate_tax_id: allowDuplicate, odoo_partner_id: partnerId, ...data } = body;

		if (partnerId) return await this.erp.createWithPartner(holdingId, data, partnerId, allowDuplicate ?? false);

		return await this.directory.createEntity(holdingId, data, allowDuplicate ?? false);
	}

	// Rutas fijas antes de `:id` para que Nest no las capture como id.
	@Get('erp-connection')
	@ApiOperation({
		summary: '¿El holding tiene una integración de ERP activa?',
		description: 'Solo lee la configuración (no llama al ERP): habilita "Traer desde ERP". `name` = nombre de la conexión',
	})
	async erpConnection(@HoldingId() holdingId: string) {
		return await this.erp.connection(holdingId);
	}

	@Post('erp-partner/search')
	@ApiOperation({
		summary: 'Buscar en el ERP para crear una razón social ("Traer desde ERP")',
		description: 'Por RUT (si el texto parece uno) o por nombre; cada candidato trae correo y dirección y dice si otra razón social ya lo usa',
	})
	async searchNewErpPartner(@Body() body: SearchNewErpPartnerDto, @HoldingId() holdingId: string) {
		return await this.erp.searchForNew(holdingId, body.query);
	}

	@Get('stats')
	@ApiOperation({ summary: 'Totales de razones sociales (total y sin cliente asignado)' })
	async stats(@HoldingId() holdingId: string) {
		return await this.directory.entityStats(holdingId);
	}

	@Post('assign')
	@ApiOperation({
		summary: 'Vincular razones sociales a un cliente comercial',
		description: 'Valida que cliente y razones sociales sean del holding; omite las ya vinculadas',
	})
	async assign(@Body() body: AssignClientEntitiesDto, @HoldingId() holdingId: string) {
		return await this.directory.assignEntities(holdingId, body.client_id, body.entity_ids, body.make_primary_if_none ?? true);
	}

	@Get(':id')
	@ApiOperation({ summary: 'Razón social con los clientes comerciales a los que factura' })
	@ApiParam({ name: 'id', type: String })
	async getDetail(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.entityMetrics.getDetail(id, holdingId);
	}

	@Get(':id/summary')
	@ApiOperation({ summary: 'Indicadores de la razón social', description: 'Facturado 12 meses, por cobrar, vencido y comportamiento de pago' })
	@ApiParam({ name: 'id', type: String })
	@ApiQuery({ name: 'client_id', type: String, required: false, description: 'Solo lo facturado a este cliente comercial' })
	async getSummary(
		@Param('id', new ParseUUIDPipe()) id: string,
		@HoldingId() holdingId: string,
		@Query('client_id', new ParseUUIDPipe({ optional: true })) clientId?: string
	) {
		return await this.entityMetrics.getSummary(id, holdingId, new Date(), clientId);
	}

	@Get(':id/invoices')
	@ApiOperation({ summary: 'Facturas emitidas a la razón social', description: 'Paginadas; filtro por cliente comercial y estado' })
	@ApiParam({ name: 'id', type: String })
	async getInvoices(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: QueryEntityInvoicesDto, @HoldingId() holdingId: string) {
		return await this.entityMetrics.getInvoices(id, holdingId, {
			page: query.page,
			limit: query.limit,
			clientId: query.client_id,
			status: query.status,
		});
	}

	@Get(':id/contracts')
	@ApiOperation({
		summary: 'Contratos de la razón social',
		description: 'Paginados; filtro por cliente comercial, estado y número, con conteo por estado y MRR del mes',
	})
	@ApiParam({ name: 'id', type: String })
	async getContracts(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: QueryEntityContractsDto, @HoldingId() holdingId: string) {
		return await this.clientMetrics.getEntityContracts(id, holdingId, {
			page: query.page,
			limit: query.limit,
			status: query.status,
			clientId: query.client_id,
			search: query.search,
			sortBy: query.sort_by,
			sortOrder: query.sort_order,
		});
	}

	@Patch(':id')
	@ApiOperation({
		summary: 'Editar datos tributarios de una razón social',
		description: 'Rechaza (409) un RUT/ID tributario ya usado por otra razón social del holding',
	})
	@ApiParam({ name: 'id', type: String })
	async update(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateClientEntityDto, @HoldingId() holdingId: string) {
		const { allow_duplicate_tax_id: allowDuplicate, ...changes } = body;

		return await this.directory.updateEntity(holdingId, id, changes, allowDuplicate ?? false);
	}

	@Get(':id/deletion-check')
	@ApiOperation({
		summary: '¿Se puede eliminar la razón social?',
		description: 'Uso (contratos, facturas, suscripciones) y bloqueos `entity_in_use`',
	})
	@ApiParam({ name: 'id', type: String })
	async deletionCheck(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.directory.deletionCheck(holdingId, id);
	}

	@Delete(':id')
	@ApiOperation({ summary: 'Eliminar una razón social sin uso', description: '409 `entity_in_use` si tiene contratos, facturas o suscripciones' })
	@ApiParam({ name: 'id', type: String })
	async remove(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.directory.deleteEntity(holdingId, id);
	}

	@Get(':id/erp-partner')
	@ApiOperation({
		summary: 'Partner de Odoo vinculado a la razón social',
		description: 'Leído en Odoo; `archived` si ya no está activo; `blockers` si Odoo no responde',
	})
	@ApiParam({ name: 'id', type: String })
	async currentErpPartner(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.erp.current(holdingId, id);
	}

	@Post(':id/erp-partner/search')
	@ApiOperation({
		summary: 'Buscar el partner de Odoo de la razón social',
		description: 'Por RUT (y por nombre si no aparece) o por `query`; cada candidato dice por qué coincidió y si otra razón social ya lo usa',
	})
	@ApiParam({ name: 'id', type: String })
	async searchErpPartner(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: SearchErpPartnerDto, @HoldingId() holdingId: string) {
		return await this.erp.search(holdingId, id, body.query);
	}

	@Put(':id/erp-partner')
	@ApiOperation({
		summary: 'Vincular la razón social con un partner de Odoo',
		description: '409 `partner_already_linked` si otra razón social del holding lo usa; 404 si no existe o está archivado en Odoo',
	})
	@ApiParam({ name: 'id', type: String })
	async linkErpPartner(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: LinkErpPartnerDto, @HoldingId() holdingId: string) {
		return await this.erp.link(holdingId, id, body.odoo_partner_id);
	}

	@Delete(':id/erp-partner')
	@ApiOperation({ summary: 'Desvincular la razón social de su partner de Odoo' })
	@ApiParam({ name: 'id', type: String })
	async unlinkErpPartner(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.erp.unlink(holdingId, id);
	}
}
