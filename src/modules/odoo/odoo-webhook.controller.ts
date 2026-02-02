import { Body, Controller, Get, Headers, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { Public } from '@/decorators/public.decorator';

import { OdooWebhookService } from './odoo-webhook.service';

@ApiTags('Odoo - Webhooks')
@Controller('odoo/webhooks')
export class OdooWebhookController {
	constructor(private readonly odooWebhookService: OdooWebhookService) {}

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

			return {
				success: true,
				message: 'Webhook recibido y guardado exitosamente',
				webhook_id: webhookLog._id,
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
