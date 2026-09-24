import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ClientDirectoryService } from './client-directory.service';
import { ClientEntityMetricsService } from './client-entity-metrics.service';
import { ClientMetricsService } from './client-metrics.service';
import { AssignClientEntitiesDto, QueryClientEntitiesDto, UpdateClientEntityDto } from './dtos/client-directory.dto';
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
		private readonly clientMetrics: ClientMetricsService
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

	// Rutas fijas antes de `:id` para que Nest no las capture como id.
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
}
