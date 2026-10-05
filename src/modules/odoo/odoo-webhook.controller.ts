import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingId } from '@/decorators/holding-id.decorator';
import { Public } from '@/decorators/public.decorator';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { BackfillResultadoDto, EjecutarBackfillDto } from './dtos/odoo-invoice-backfill.dto';
import { OdooWebhookDiagnosticsDto } from './dtos/odoo-webhook-diagnostics.dto';
import { OdooWebhookService } from './odoo-webhook.service';
import { OdooInvoiceBackfillService } from './services/odoo-invoice-backfill.service';

@ApiTags('Odoo - Webhooks')
@Controller('odoo/webhooks')
export class OdooWebhookController {
	constructor(
		private readonly odooWebhookService: OdooWebhookService,
		private readonly backfillService: OdooInvoiceBackfillService
	) {}

	@Post()
	@Public()
	@ApiOperation({
		summary: 'Webhook para recibir eventos de Odoo',
		description:
			'Endpoint que escucha automated actions de Odoo cuando hay cambios en facturas de cliente. Los datos se guardan en MongoDB para análisis.',
	})
	@ApiBody({
		description: 'Payload enviado por Odoo automated action',
		examples: {
			'invoice-update': {
				summary: 'Ejemplo de actualización de factura',
				value: {
					model: 'account.move',
					record_id: 123,
					action: 'write',
					values: {
						name: 'INV/2025/0001',
						state: 'posted',
						partner_id: 456,
					},
				},
			},
		},
	})
	@ApiOkResponse({
		description: 'Webhook recibido y guardado exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean' },
				message: { type: 'string' },
				webhook_id: { type: 'string' },
			},
		},
	})
	async receiveWebhook(@Body() payload: any, @Headers() headers: any): Promise<any> {
		try {
			const webhookLog = await this.odooWebhookService.saveWebhookLog({
				event_type: payload.action || 'unknown',
				model: payload.model || 'account.move',
				payload: payload,
				headers: {
					'content-type': headers['content-type'],
					'user-agent': headers['user-agent'],
					'x-forwarded-for': headers['x-forwarded-for'],
				},
				odoo_id: payload.record_id || payload.id,
				holding_id: payload.holding_id,
				connection_id: payload.connection_id,
			});

			// Procesar actualización de estado de factura si viene de Odoo con state=posted
			const statusUpdateResult = await this.odooWebhookService.processInvoiceStatusUpdate(payload);

			return {
				success: true,
				message: 'Webhook recibido y guardado exitosamente',
				webhook_id: webhookLog._id,
				invoice_update: statusUpdateResult.updated
					? {
							updated: true,
							invoice_id: statusUpdateResult.invoiceId,
							message: statusUpdateResult.message,
						}
					: undefined,
			};
		} catch (error) {
			console.error('Error procesando webhook:', error);
			return {
				success: false,
				message: 'Error procesando webhook',
				error: error.message,
			};
		}
	}

	/**
	 * El guard va en el método, no en el controlador: `POST /odoo/webhooks` lo llama Odoo y tiene que
	 * seguir siendo público, y `GET /odoo/webhooks` lo usa el front viejo sin el header. Mismo
	 * criterio que `GET /invoices/scheduler/report`.
	 */
	@Get('diagnostico')
	@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
	@ApiBearerAuth()
	@ApiHeader({ name: 'x-holding-id', description: 'Holding activo', required: true, schema: { type: 'string' } })
	@ApiOperation({
		summary: 'Diagnóstico de la pierna de vuelta (Odoo → Sapira)',
		description:
			'El aviso de Odoo es la única fuente del folio y del avance de estado de una factura: el scheduler escribe ' +
			'`odoo_invoice_id` y `status=Emitida`, pero nunca el folio. Cuando el folio no vuelve, la base se ve igual en los dos ' +
			'casos posibles (Odoo dejó de llamar, u Odoo llama y el webhook no puede aplicar el aviso). Este reporte cruza los ' +
			'avisos recibidos, las actualizaciones aplicadas y las facturas sin folio, y resuelve cuál de los dos es en `veredicto`. ' +
			'`facturas_sin_folio` y `corte` salen acotados al holding activo; los dos contadores de Mongo son globales, porque el ' +
			'webhook solo guarda `holding_id` si Odoo lo manda en el payload y hoy no lo manda.',
	})
	@ApiQuery({ name: 'dias', required: false, description: 'Ventana en días (1-365, default 30)' })
	@ApiOkResponse({ description: 'Reporte de la pierna de vuelta', type: OdooWebhookDiagnosticsDto })
	async getDiagnostics(@HoldingId() holdingId: string, @Query('dias') dias?: string): Promise<OdooWebhookDiagnosticsDto> {
		return await this.odooWebhookService.getReturnLegDiagnostics({
			dias: dias ? parseInt(dias, 10) : undefined,
			holdingId,
		});
	}

	/**
	 * Recupera el folio y el estado de las facturas cuyo aviso nunca llegó, preguntándole a Odoo.
	 *
	 * **Corre en seco salvo que se pida lo contrario**: sin `aplicar: true` devuelve exactamente lo
	 * que escribiría, factura por factura, sin tocar la base. Ese es el modo con el que se revisa
	 * antes de aplicar en firme.
	 */
	@Post('backfill')
	@UseGuards(SupabaseAuthGuard, HoldingScopeGuard)
	@ApiBearerAuth()
	@ApiHeader({ name: 'x-holding-id', description: 'Holding activo', required: true, schema: { type: 'string' } })
	@ApiOperation({
		summary: 'Recupera folio y estado desde Odoo de las facturas sin aviso',
		description:
			'Toma las facturas del holding enviadas a Odoo y todavía sin folio, les lee `name`, `state`, `payment_state`, montos y ' +
			'fecha desde Odoo por `odoo_invoice_id`, y sincroniza los mismos campos que aplicaría el aviso del webhook. ' +
			'**Es una corrida en seco mientras no se mande `aplicar: true`.** Omite toda factura cuyo `x_sapira_invoice_id` en Odoo ' +
			'falte o no coincida con el id de Sapira, que es la guarda que evita escribir el folio en la factura equivocada. ' +
			'Por defecto sincroniza solo `folio` y `estado`: sumar `montos` o `fecha` obliga a reconstruir `revenue_schedule_monthly` ' +
			'a mano, porque el trigger de RSM no se dispara con la conexión de la API.',
	})
	@ApiBody({ type: EjecutarBackfillDto, required: false })
	@ApiOkResponse({ description: 'Lo que se escribió, o lo que se escribiría en seco', type: BackfillResultadoDto })
	async backfill(@HoldingId() holdingId: string, @Body() body?: EjecutarBackfillDto): Promise<BackfillResultadoDto> {
		return await this.backfillService.backfillFolios(holdingId, {
			dias: body?.dias,
			aplicar: body?.aplicar,
			odooInvoiceIds: body?.odoo_invoice_ids,
			campos: body?.campos,
			estados: body?.estados,
		});
	}

	@Get()
	@UseGuards(SupabaseAuthGuard)
	@ApiBearerAuth()
	@ApiOperation({
		summary: 'Obtener logs de webhooks recibidos',
		description: 'Consulta los webhooks recibidos de Odoo para analizar la estructura de datos',
	})
	@ApiQuery({ name: 'event_type', required: false, description: 'Filtrar por tipo de evento' })
	@ApiQuery({ name: 'model', required: false, description: 'Filtrar por modelo de Odoo' })
	@ApiQuery({ name: 'holding_id', required: false, description: 'Filtrar por holding' })
	@ApiQuery({ name: 'status', required: false, description: 'Filtrar por estado (received, processed, error)' })
	@ApiQuery({ name: 'limit', required: false, description: 'Límite de registros (default: 100)' })
	@ApiOkResponse({
		description: 'Lista de webhooks recibidos',
		schema: {
			type: 'array',
			items: {
				type: 'object',
			},
		},
	})
	async getWebhookLogs(
		@Query('event_type') eventType?: string,
		@Query('model') model?: string,
		@Query('holding_id') holdingId?: string,
		@Query('status') status?: string,
		@Query('limit') limit?: string
	): Promise<any[]> {
		return await this.odooWebhookService.getWebhookLogs({
			event_type: eventType,
			model: model,
			holding_id: holdingId,
			status: status,
			limit: limit ? parseInt(limit, 10) : 100,
		});
	}
}
