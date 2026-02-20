import { Controller, Get, HttpCode, HttpStatus, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { GetCustomerByIdDto } from './dtos/get-customer-by-id.dto';
import { GetCustomersDto } from './dtos/get-customers.dto';
import { GetInvoiceByIdDto } from './dtos/get-invoice-by-id.dto';
import { GetInvoicesDto } from './dtos/get-invoices.dto';
import { GetSubscriptionByIdDto } from './dtos/get-subscription-by-id.dto';
import { GetSubscriptionsDto } from './dtos/get-subscriptions.dto';
import { StripeCustomer, StripeCustomerListResponse } from './interfaces/stripe-customer.interface';
import { StripeInvoice, StripeInvoiceListResponse } from './interfaces/stripe-invoice.interface';
import { StripeSubscription, StripeSubscriptionListResponse } from './interfaces/stripe-subscription.interface';
import { StripeService } from './stripe.service';

@ApiTags('Stripe')
@Controller('stripe')
@UseGuards(SupabaseAuthGuard)
@ApiBearerAuth()
export class StripeController {
	constructor(private readonly stripeService: StripeService) {}

	@Get('invoices')
	@ApiOperation({
		summary: 'Obtener listado de invoices de Stripe',
		description: 'Retorna un listado de invoices emitidas en Stripe. Se puede filtrar por cliente, estado y paginar los resultados.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Listado de invoices obtenido exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Parámetros inválidos',
	})
	@HttpCode(HttpStatus.OK)
	async getInvoices(@Query() dto: GetInvoicesDto): Promise<StripeInvoiceListResponse> {
		return this.stripeService.getInvoices(dto);
	}

	@Get('invoices/:invoice_id')
	@ApiOperation({
		summary: 'Obtener una invoice específica por ID',
		description: 'Retorna los detalles completos de una invoice específica de Stripe.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Invoice obtenida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Invoice no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async getInvoiceById(@Param() dto: GetInvoiceByIdDto): Promise<StripeInvoice> {
		return this.stripeService.getInvoiceById(dto);
	}

	@Get('customers/:customer_id/invoices')
	@ApiOperation({
		summary: 'Obtener invoices de un cliente específico',
		description: 'Retorna todas las invoices asociadas a un cliente específico de Stripe.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Invoices del cliente obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getInvoicesByCustomer(@Param('customer_id') customerId: string, @Query('limit') limit?: number): Promise<StripeInvoiceListResponse> {
		return this.stripeService.getInvoicesByCustomer(customerId, limit);
	}

	@Get('customers')
	@ApiOperation({
		summary: 'Obtener listado de clientes de Stripe',
		description: 'Retorna un listado de clientes registrados en Stripe. Se puede filtrar por email y paginar los resultados.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Listado de clientes obtenido exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Parámetros inválidos',
	})
	@HttpCode(HttpStatus.OK)
	async getCustomers(@Query() dto: GetCustomersDto): Promise<StripeCustomerListResponse> {
		return this.stripeService.getCustomers(dto);
	}

	@Get('customers/:customer_id')
	@ApiOperation({
		summary: 'Obtener un cliente específico por ID',
		description: 'Retorna los detalles completos de un cliente específico de Stripe.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Cliente obtenido exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Cliente no encontrado',
	})
	@HttpCode(HttpStatus.OK)
	async getCustomerById(@Param() dto: GetCustomerByIdDto): Promise<StripeCustomer> {
		return this.stripeService.getCustomerById(dto);
	}

	@Get('subscriptions')
	@ApiOperation({
		summary: 'Obtener listado de suscripciones de Stripe',
		description: 'Retorna un listado de suscripciones en Stripe. Se puede filtrar por cliente, estado, precio y paginar los resultados.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Listado de suscripciones obtenido exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.BAD_REQUEST,
		description: 'Parámetros inválidos',
	})
	@HttpCode(HttpStatus.OK)
	async getSubscriptions(@Query() dto: GetSubscriptionsDto): Promise<StripeSubscriptionListResponse> {
		return this.stripeService.getSubscriptions(dto);
	}

	@Get('subscriptions/:subscription_id')
	@ApiOperation({
		summary: 'Obtener una suscripción específica por ID',
		description: 'Retorna los detalles completos de una suscripción específica de Stripe.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Suscripción obtenida exitosamente',
	})
	@ApiResponse({
		status: HttpStatus.NOT_FOUND,
		description: 'Suscripción no encontrada',
	})
	@HttpCode(HttpStatus.OK)
	async getSubscriptionById(@Param() dto: GetSubscriptionByIdDto): Promise<StripeSubscription> {
		return this.stripeService.getSubscriptionById(dto);
	}

	@Get('customers/:customer_id/subscriptions')
	@ApiOperation({
		summary: 'Obtener suscripciones de un cliente específico',
		description: 'Retorna todas las suscripciones asociadas a un cliente específico de Stripe.',
	})
	@ApiResponse({
		status: HttpStatus.OK,
		description: 'Suscripciones del cliente obtenidas exitosamente',
	})
	@HttpCode(HttpStatus.OK)
	async getSubscriptionsByCustomer(
		@Param('customer_id') customerId: string,
		@Query('limit') limit?: number
	): Promise<StripeSubscriptionListResponse> {
		return this.stripeService.getSubscriptionsByCustomer(customerId, limit);
	}
}
