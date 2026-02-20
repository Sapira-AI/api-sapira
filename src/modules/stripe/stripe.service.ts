import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Stripe from 'stripe';

import { GetCustomerByIdDto } from './dtos/get-customer-by-id.dto';
import { GetCustomersDto } from './dtos/get-customers.dto';
import { GetInvoiceByIdDto } from './dtos/get-invoice-by-id.dto';
import { GetInvoicesDto } from './dtos/get-invoices.dto';
import { GetSubscriptionByIdDto } from './dtos/get-subscription-by-id.dto';
import { GetSubscriptionsDto } from './dtos/get-subscriptions.dto';
import { StripeCustomer, StripeCustomerListResponse } from './interfaces/stripe-customer.interface';
import { StripeInvoice, StripeInvoiceListResponse } from './interfaces/stripe-invoice.interface';
import { StripeSubscription, StripeSubscriptionListResponse } from './interfaces/stripe-subscription.interface';
import { STRIPE_CLIENT } from './stripe.provider';

@Injectable()
export class StripeService {
	private readonly logger = new Logger(StripeService.name);

	constructor(@Inject(STRIPE_CLIENT) private readonly stripe: Stripe) {}

	async getInvoices(dto: GetInvoicesDto): Promise<StripeInvoiceListResponse> {
		try {
			this.logger.log(`Consultando invoices de Stripe con parámetros: ${JSON.stringify(dto)}`);

			const params: Stripe.InvoiceListParams = {
				limit: dto.limit || 10,
			};

			if (dto.customer) {
				params.customer = dto.customer;
			}

			if (dto.status) {
				params.status = dto.status as Stripe.InvoiceListParams.Status;
			}

			if (dto.starting_after) {
				params.starting_after = dto.starting_after;
			}

			const invoices = await this.stripe.invoices.list(params);

			this.logger.log(`Se encontraron ${invoices.data.length} invoices`);

			return {
				object: invoices.object,
				data: invoices.data as unknown as StripeInvoice[],
				has_more: invoices.has_more,
				url: invoices.url,
			};
		} catch (error) {
			this.logger.error(`Error al consultar invoices: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getInvoiceById(dto: GetInvoiceByIdDto): Promise<StripeInvoice> {
		try {
			this.logger.log(`Consultando invoice con ID: ${dto.invoice_id}`);

			const invoice = await this.stripe.invoices.retrieve(dto.invoice_id);

			if (!invoice) {
				throw new NotFoundException(`Invoice con ID ${dto.invoice_id} no encontrada`);
			}

			this.logger.log(`Invoice ${dto.invoice_id} encontrada exitosamente`);

			return invoice as unknown as StripeInvoice;
		} catch (error) {
			if (error.type === 'StripeInvalidRequestError') {
				throw new NotFoundException(`Invoice con ID ${dto.invoice_id} no encontrada`);
			}
			this.logger.error(`Error al consultar invoice: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getInvoicesByCustomer(customerId: string, limit: number = 10): Promise<StripeInvoiceListResponse> {
		return this.getInvoices({ customer: customerId, limit });
	}

	async getInvoicesByStatus(status: string, limit: number = 10): Promise<StripeInvoiceListResponse> {
		return this.getInvoices({ status, limit });
	}

	async getCustomers(dto: GetCustomersDto): Promise<StripeCustomerListResponse> {
		try {
			this.logger.log(`Consultando clientes de Stripe con parámetros: ${JSON.stringify(dto)}`);

			const params: Stripe.CustomerListParams = {
				limit: dto.limit || 10,
			};

			if (dto.email) {
				params.email = dto.email;
			}

			if (dto.starting_after) {
				params.starting_after = dto.starting_after;
			}

			const customers = await this.stripe.customers.list(params);

			this.logger.log(`Se encontraron ${customers.data.length} clientes`);

			return {
				object: customers.object,
				data: customers.data as unknown as StripeCustomer[],
				has_more: customers.has_more,
				url: customers.url,
			};
		} catch (error) {
			this.logger.error(`Error al consultar clientes: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getCustomerById(dto: GetCustomerByIdDto): Promise<StripeCustomer> {
		try {
			this.logger.log(`Consultando cliente con ID: ${dto.customer_id}`);

			const customer = await this.stripe.customers.retrieve(dto.customer_id);

			if (!customer || customer.deleted) {
				throw new NotFoundException(`Cliente con ID ${dto.customer_id} no encontrado`);
			}

			this.logger.log(`Cliente ${dto.customer_id} encontrado exitosamente`);

			return customer as unknown as StripeCustomer;
		} catch (error) {
			if (error.type === 'StripeInvalidRequestError') {
				throw new NotFoundException(`Cliente con ID ${dto.customer_id} no encontrado`);
			}
			this.logger.error(`Error al consultar cliente: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getSubscriptions(dto: GetSubscriptionsDto): Promise<StripeSubscriptionListResponse> {
		try {
			this.logger.log(`Consultando suscripciones de Stripe con parámetros: ${JSON.stringify(dto)}`);

			const params: Stripe.SubscriptionListParams = {
				limit: dto.limit || 10,
			};

			if (dto.customer) {
				params.customer = dto.customer;
			}

			if (dto.status) {
				params.status = dto.status as Stripe.SubscriptionListParams.Status;
			}

			if (dto.price) {
				params.price = dto.price;
			}

			if (dto.starting_after) {
				params.starting_after = dto.starting_after;
			}

			const subscriptions = await this.stripe.subscriptions.list(params);

			this.logger.log(`Se encontraron ${subscriptions.data.length} suscripciones`);

			return {
				object: subscriptions.object,
				data: subscriptions.data as unknown as StripeSubscription[],
				has_more: subscriptions.has_more,
				url: subscriptions.url,
			};
		} catch (error) {
			this.logger.error(`Error al consultar suscripciones: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getSubscriptionById(dto: GetSubscriptionByIdDto): Promise<StripeSubscription> {
		try {
			this.logger.log(`Consultando suscripción con ID: ${dto.subscription_id}`);

			const subscription = await this.stripe.subscriptions.retrieve(dto.subscription_id);

			if (!subscription) {
				throw new NotFoundException(`Suscripción con ID ${dto.subscription_id} no encontrada`);
			}

			this.logger.log(`Suscripción ${dto.subscription_id} encontrada exitosamente`);

			return subscription as unknown as StripeSubscription;
		} catch (error) {
			if (error.type === 'StripeInvalidRequestError') {
				throw new NotFoundException(`Suscripción con ID ${dto.subscription_id} no encontrada`);
			}
			this.logger.error(`Error al consultar suscripción: ${error.message}`, error.stack);
			throw error;
		}
	}

	async getSubscriptionsByCustomer(customerId: string, limit: number = 10): Promise<StripeSubscriptionListResponse> {
		return this.getSubscriptions({ customer: customerId, limit });
	}

	async getSubscriptionsByStatus(status: string, limit: number = 10): Promise<StripeSubscriptionListResponse> {
		return this.getSubscriptions({ status, limit });
	}
}
