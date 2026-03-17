import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

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
}
