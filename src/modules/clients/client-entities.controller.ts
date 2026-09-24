import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { ClientDirectoryService } from './client-directory.service';
import { ClientEntityMetricsService } from './client-entity-metrics.service';
import { AssignClientEntitiesDto, QueryClientEntitiesDto, UpdateClientEntityDto } from './dtos/client-directory.dto';
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
		private readonly directory: ClientDirectoryService
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
	async getSummary(@Param('id', new ParseUUIDPipe()) id: string, @HoldingId() holdingId: string) {
		return await this.entityMetrics.getSummary(id, holdingId);
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
