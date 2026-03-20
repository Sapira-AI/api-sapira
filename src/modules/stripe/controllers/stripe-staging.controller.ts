import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { BulkUpdateStatusDto } from '../dto/bulk-update-status.dto';
import { StagingFiltersDto } from '../dto/staging-filters.dto';
import { UpdateProcessingStatusDto } from '../dto/update-processing-status.dto';
import { StripeStagingService } from '../services/stripe-staging.service';

@ApiTags('Stripe Staging')
@Controller('stripe/staging')
@UseGuards(SupabaseAuthGuard)
@ApiHeader({
	name: 'x-holding-id',
	description: 'ID del holding para filtrar los datos de staging',
	required: true,
})
@ApiBearerAuth()
export class StripeStagingController {
	constructor(private readonly stagingService: StripeStagingService) {}

	@Get('customers')
	@ApiOperation({
		summary: 'Obtener clientes en staging',
		description:
			'Retorna una lista paginada de clientes sincronizados desde Stripe que están pendientes de integración a las tablas finales de Sapira.',
	})
	@ApiQuery({
		name: 'processing_status',
		required: false,
		description: 'Filtrar por estado de procesamiento (pending, to_create, to_update, processed, error)',
	})
	@ApiQuery({ name: 'search', required: false, description: 'Buscar por Stripe ID, email o nombre del cliente' })
	@ApiQuery({ name: 'page', required: false, type: Number, description: 'Número de página (default: 1)' })
	@ApiQuery({ name: 'limit', required: false, type: Number, description: 'Registros por página (default: 50)' })
	@ApiResponse({ status: 200, description: 'Lista de clientes en staging con paginación' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	async getCustomers(@Headers('x-holding-id') holdingId: string, @Query() filters: StagingFiltersDto) {
		return this.stagingService.getCustomers(holdingId, filters);
	}

	@Get('subscriptions')
	@ApiOperation({
		summary: 'Obtener suscripciones en staging',
		description:
			'Retorna una lista paginada de suscripciones sincronizadas desde Stripe que están pendientes de integración a las tablas finales de Sapira.',
	})
	@ApiQuery({
		name: 'processing_status',
		required: false,
		description: 'Filtrar por estado de procesamiento (pending, to_create, to_update, processed, error)',
	})
	@ApiQuery({ name: 'search', required: false, description: 'Buscar por Stripe ID o customer ID' })
	@ApiQuery({ name: 'page', required: false, type: Number, description: 'Número de página (default: 1)' })
	@ApiQuery({ name: 'limit', required: false, type: Number, description: 'Registros por página (default: 50)' })
	@ApiResponse({ status: 200, description: 'Lista de suscripciones en staging con paginación' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	async getSubscriptions(@Headers('x-holding-id') holdingId: string, @Query() filters: StagingFiltersDto) {
		return this.stagingService.getSubscriptions(holdingId, filters);
	}

	@Get('invoices')
	@ApiOperation({
		summary: 'Obtener facturas en staging',
		description:
			'Retorna una lista paginada de facturas sincronizadas desde Stripe que están pendientes de integración a las tablas finales de Sapira.',
	})
	@ApiQuery({
		name: 'processing_status',
		required: false,
		description: 'Filtrar por estado de procesamiento (pending, to_create, to_update, processed, error)',
	})
	@ApiQuery({ name: 'search', required: false, description: 'Buscar por Stripe ID, customer ID o subscription ID' })
	@ApiQuery({ name: 'page', required: false, type: Number, description: 'Número de página (default: 1)' })
	@ApiQuery({ name: 'limit', required: false, type: Number, description: 'Registros por página (default: 50)' })
	@ApiResponse({ status: 200, description: 'Lista de facturas en staging con paginación' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	async getInvoices(@Headers('x-holding-id') holdingId: string, @Query() filters: StagingFiltersDto) {
		return this.stagingService.getInvoices(holdingId, filters);
	}

	@Patch('customers/:id')
	@ApiOperation({
		summary: 'Actualizar estado de procesamiento de un cliente',
		description:
			'Permite marcar un cliente en staging con un estado específico (pending, to_create, to_update, processed, error) para controlar su flujo de integración.',
	})
	@ApiResponse({ status: 200, description: 'Estado actualizado exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 404, description: 'Cliente no encontrado' })
	async updateCustomerStatus(@Param('id') id: string, @Body() dto: UpdateProcessingStatusDto) {
		await this.stagingService.updateCustomerStatus(id, dto.processing_status);
		return { success: true };
	}

	@Patch('subscriptions/:id')
	@ApiOperation({
		summary: 'Actualizar estado de procesamiento de una suscripción',
		description:
			'Permite marcar una suscripción en staging con un estado específico (pending, to_create, to_update, processed, error) para controlar su flujo de integración.',
	})
	@ApiResponse({ status: 200, description: 'Estado actualizado exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 404, description: 'Suscripción no encontrada' })
	async updateSubscriptionStatus(@Param('id') id: string, @Body() dto: UpdateProcessingStatusDto) {
		await this.stagingService.updateSubscriptionStatus(id, dto.processing_status);
		return { success: true };
	}

	@Patch('invoices/:id')
	@ApiOperation({
		summary: 'Actualizar estado de procesamiento de una factura',
		description:
			'Permite marcar una factura en staging con un estado específico (pending, to_create, to_update, processed, error) para controlar su flujo de integración.',
	})
	@ApiResponse({ status: 200, description: 'Estado actualizado exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 404, description: 'Factura no encontrada' })
	async updateInvoiceStatus(@Param('id') id: string, @Body() dto: UpdateProcessingStatusDto) {
		await this.stagingService.updateInvoiceStatus(id, dto.processing_status);
		return { success: true };
	}

	@Post('customers/bulk-update')
	@ApiOperation({
		summary: 'Actualización masiva de estado de clientes',
		description:
			'Permite actualizar el estado de procesamiento de múltiples clientes en staging de forma simultánea. Útil para marcar lotes de registros como "to_create" o "to_update".',
	})
	@ApiResponse({ status: 200, description: 'Estados actualizados exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 400, description: 'IDs inválidos o vacíos' })
	async bulkUpdateCustomersStatus(@Body() dto: BulkUpdateStatusDto) {
		await this.stagingService.bulkUpdateCustomersStatus(dto.ids, dto.processing_status);
		return { success: true };
	}

	@Post('subscriptions/bulk-update')
	@ApiOperation({
		summary: 'Actualización masiva de estado de suscripciones',
		description:
			'Permite actualizar el estado de procesamiento de múltiples suscripciones en staging de forma simultánea. Útil para marcar lotes de registros como "to_create" o "to_update".',
	})
	@ApiResponse({ status: 200, description: 'Estados actualizados exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 400, description: 'IDs inválidos o vacíos' })
	async bulkUpdateSubscriptionsStatus(@Body() dto: BulkUpdateStatusDto) {
		await this.stagingService.bulkUpdateSubscriptionsStatus(dto.ids, dto.processing_status);
		return { success: true };
	}

	@Post('invoices/bulk-update')
	@ApiOperation({
		summary: 'Actualización masiva de estado de facturas',
		description:
			'Permite actualizar el estado de procesamiento de múltiples facturas en staging de forma simultánea. Útil para marcar lotes de registros como "to_create" o "to_update".',
	})
	@ApiResponse({ status: 200, description: 'Estados actualizados exitosamente' })
	@ApiResponse({ status: 401, description: 'No autorizado' })
	@ApiResponse({ status: 400, description: 'IDs inválidos o vacíos' })
	async bulkUpdateInvoicesStatus(@Body() dto: BulkUpdateStatusDto) {
		await this.stagingService.bulkUpdateInvoicesStatus(dto.ids, dto.processing_status);
		return { success: true };
	}
}
