import { Controller, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { StripeClientsService } from './stripe-clients.service';

@ApiTags('Clients - Stripe Integration')
@Controller('clients')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class StripeClientsController {
	constructor(private readonly stripeClientsService: StripeClientsService) {}

	@Post('sync-stripe-ids')
	@ApiOperation({
		summary: 'Sincronizar stripe_customer_id desde BigQuery',
		description:
			'Consulta todos los registros de la tabla sapira_stripe en BigQuery y actualiza el campo stripe_customer_id ' +
			'en los clientes que tengan un salesforce_account_id coincidente. Este proceso solo actualiza registros existentes.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completada exitosamente',
		schema: {
			type: 'object',
			properties: {
				success: { type: 'boolean', example: true },
				message: { type: 'string', example: 'Sincronización completada exitosamente' },
				stats: {
					type: 'object',
					properties: {
						totalFromBigQuery: { type: 'number', example: 150, description: 'Total de registros obtenidos de BigQuery' },
						clientsUpdated: { type: 'number', example: 120, description: 'Clientes actualizados exitosamente' },
						clientsNotFound: {
							type: 'number',
							example: 25,
							description: 'Registros de BigQuery sin cliente correspondiente',
						},
						errors: { type: 'number', example: 5, description: 'Errores durante el procesamiento' },
					},
				},
			},
		},
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Error al ejecutar la sincronización',
	})
	@ApiResponse({
		status: HttpStatus.UNAUTHORIZED,
		description: 'Token de autenticación inválido o no proporcionado',
	})
	async syncStripeCustomerIds() {
		return await this.stripeClientsService.syncStripeCustomerIds();
	}
}
