import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { CountStripeRecordsDto, SyncStripeDataDto } from './dtos/sync-stripe-data.dto';
import { StripeSyncService } from './stripe-sync.service';

@ApiTags('Stripe Sync')
@Controller('stripe/sync')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class StripeSyncController {
	constructor(private readonly stripeSyncService: StripeSyncService) {}

	@Post('count-records')
	@ApiOperation({
		summary: 'Contar registros de Stripe',
		description: 'Estima la cantidad de suscripciones, clientes y facturas en el rango de fechas especificado',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Conteo completado exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async countRecords(@Body() dto: CountStripeRecordsDto, @Headers('x-holding-id') holdingId: string) {
		return this.stripeSyncService.countRecords(dto, holdingId);
	}

	@Post('subscriptions')
	@ApiOperation({
		summary: 'Sincronizar suscripciones de Stripe',
		description: 'Sincroniza suscripciones desde Stripe a las tablas staging',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Suscripciones sincronizadas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async syncSubscriptions(@Body() dto: SyncStripeDataDto, @Headers('x-holding-id') holdingId: string) {
		return this.stripeSyncService.syncSubscriptions(dto, holdingId);
	}

	@Post('customers')
	@ApiOperation({
		summary: 'Sincronizar clientes de Stripe',
		description: 'Sincroniza clientes desde Stripe a las tablas staging',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Clientes sincronizados exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async syncCustomers(@Body() dto: SyncStripeDataDto, @Headers('x-holding-id') holdingId: string) {
		return this.stripeSyncService.syncCustomers(dto, holdingId);
	}

	@Post('invoices')
	@ApiOperation({
		summary: 'Sincronizar facturas de Stripe',
		description: 'Sincroniza facturas desde Stripe a las tablas staging',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Facturas sincronizadas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async syncInvoices(@Body() dto: SyncStripeDataDto, @Headers('x-holding-id') holdingId: string) {
		return this.stripeSyncService.syncInvoices(dto, holdingId);
	}

	@Post('all')
	@ApiOperation({
		summary: 'Sincronizar todos los datos de Stripe',
		description:
			'Sincroniza facturas, clientes y suscripciones relacionadas desde Stripe. El rango de fechas filtra las facturas, y a partir de ellas se obtienen los clientes y suscripciones asociadas.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Sincronización completa exitosa',
	})
	@HttpCode(HttpStatus.OK)
	async syncAll(@Body() dto: SyncStripeDataDto, @Headers('x-holding-id') holdingId: string) {
		return this.stripeSyncService.syncAll(dto, holdingId);
	}

	@Get('job/:jobId/status')
	@ApiOperation({
		summary: 'Obtener estado de un job de sincronización',
		description: 'Consulta el progreso y estado actual de un job de sincronización de Stripe',
	})
	@ApiParam({
		name: 'jobId',
		type: String,
		description: 'ID del job de sincronización',
		example: '123e4567-e89b-12d3-a456-426614174000',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Estado del job obtenido exitosamente',
		schema: {
			type: 'object',
			properties: {
				job_id: { type: 'string' },
				status: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
				total_records: { type: 'number' },
				records_processed: { type: 'number' },
				records_success: { type: 'number' },
				records_failed: { type: 'number' },
				progress_percentage: { type: 'number' },
				execution_time_ms: { type: 'number' },
				started_at: { type: 'string', format: 'date-time' },
				completed_at: { type: 'string', format: 'date-time' },
			},
		},
	})
	@HttpCode(HttpStatus.OK)
	async getJobStatus(@Param('jobId') jobId: string) {
		return this.stripeSyncService.getJobStatus(jobId);
	}
}
