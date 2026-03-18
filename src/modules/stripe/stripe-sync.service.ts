import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Stripe from 'stripe';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { CountStripeRecordsDto, SyncStripeDataDto } from './dtos/sync-stripe-data.dto';
import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeCustomersStg } from './entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from './entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from './entities/stripe-subscriptions-stg.entity';
import { StripeConnectionService } from './stripe-connection.service';
import { STRIPE_CLIENT } from './stripe.provider';

@Injectable()
export class StripeSyncService {
	private readonly logger = new Logger(StripeSyncService.name);

	constructor(
		@Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
		@InjectRepository(StripeConnection)
		private readonly connectionRepository: Repository<StripeConnection>,
		@InjectRepository(StripeSubscriptionsStg)
		private readonly subscriptionsStgRepository: Repository<StripeSubscriptionsStg>,
		@InjectRepository(StripeCustomersStg)
		private readonly customersStgRepository: Repository<StripeCustomersStg>,
		@InjectRepository(StripeInvoicesStg)
		private readonly invoicesStgRepository: Repository<StripeInvoicesStg>,
		private readonly connectionService: StripeConnectionService
	) {}

	async countRecords(dto: CountStripeRecordsDto, holdingId: string) {
		this.logger.log(`Contando registros de Stripe para conexión: ${dto.connection_id}`);

		const connection = await this.connectionService.findOne(dto.connection_id, holdingId);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const params: any = {};
		if (dto.date_from) {
			params.created = { gte: Math.floor(new Date(dto.date_from).getTime() / 1000) };
		}
		if (dto.date_to) {
			if (params.created) {
				params.created.lte = Math.floor(new Date(dto.date_to).getTime() / 1000);
			} else {
				params.created = { lte: Math.floor(new Date(dto.date_to).getTime() / 1000) };
			}
		}

		// Función auxiliar para obtener todas las facturas iterando sobre páginas
		const getAllInvoices = async (params: any): Promise<Stripe.Invoice[]> => {
			const allInvoices: Stripe.Invoice[] = [];
			let hasMore = true;
			let startingAfter: string | undefined = undefined;

			while (hasMore) {
				const result = await stripeClient.invoices.list({
					...params,
					limit: 100,
					starting_after: startingAfter,
				});

				allInvoices.push(...result.data);
				hasMore = result.has_more;

				if (hasMore && result.data.length > 0) {
					startingAfter = result.data[result.data.length - 1].id;
				}
			}

			return allInvoices;
		};

		// 1. Obtener todas las facturas en el rango de fechas
		this.logger.log('Obteniendo facturas en el rango de fechas...');
		const allInvoices = await getAllInvoices(params);
		const invoicesCount = allInvoices.length;

		// 2. Extraer IDs únicos de clientes y suscripciones
		const uniqueCustomerIds = new Set<string>();
		const uniqueSubscriptionIds = new Set<string>();
		let invoicesWithoutSubscription = 0;

		for (const invoice of allInvoices) {
			// Agregar customer ID (siempre presente)
			if (invoice.customer) {
				uniqueCustomerIds.add(typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id);
			}

			// Buscar subscription ID en parent.subscription_details.subscription
			let subscriptionId = null;
			const parent = (invoice as any).parent;

			if (parent?.subscription_details?.subscription) {
				subscriptionId = parent.subscription_details.subscription;
			}

			// Log detallado para debugging (solo primeras 3 facturas)
			if (allInvoices.indexOf(invoice) < 3) {
				this.logger.debug(`Factura ${invoice.id}: subscription = ${subscriptionId}, parent.type = ${parent?.type}`);
			}

			if (subscriptionId) {
				uniqueSubscriptionIds.add(typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id);
			} else {
				invoicesWithoutSubscription++;
			}
		}

		const customersCount = uniqueCustomerIds.size;
		const subscriptionsCount = uniqueSubscriptionIds.size;

		this.logger.log(
			`Conteo completado: ${invoicesCount} facturas, ${customersCount} clientes únicos, ${subscriptionsCount} suscripciones únicas, ${invoicesWithoutSubscription} facturas sin suscripción`
		);

		return {
			total_invoices: invoicesCount,
			total_customers: customersCount,
			total_subscriptions: subscriptionsCount,
			invoices_without_subscription: invoicesWithoutSubscription,
			message: 'Conteo completado exitosamente',
		};
	}

	async syncSubscriptions(dto: SyncStripeDataDto, holdingId: string) {
		this.logger.log(`Sincronizando suscripciones de Stripe para conexión: ${dto.connection_id}`);

		const connection = await this.connectionService.findOne(dto.connection_id, holdingId);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const params: Stripe.SubscriptionListParams = {
			limit: dto.limit || 100,
		};

		if (dto.date_from) {
			params.created = { gte: Math.floor(new Date(dto.date_from).getTime() / 1000) };
		}
		if (dto.date_to) {
			if (params.created) {
				(params.created as any).lte = Math.floor(new Date(dto.date_to).getTime() / 1000);
			} else {
				params.created = { lte: Math.floor(new Date(dto.date_to).getTime() / 1000) };
			}
		}

		const subscriptions = await stripeClient.subscriptions.list(params);
		const batchId = uuidv4();

		const savedSubscriptions = [];
		for (const subscription of subscriptions.data) {
			const existing = await this.subscriptionsStgRepository.findOne({
				where: { stripe_id: subscription.id, holding_id: holdingId },
			});

			if (existing) {
				existing.raw_data = subscription;
				existing.sync_batch_id = batchId;
				existing.processing_status = 'updated';
				await this.subscriptionsStgRepository.save(existing);
				savedSubscriptions.push(existing);
			} else {
				const newSubscription = this.subscriptionsStgRepository.create({
					holding_id: holdingId,
					stripe_id: subscription.id,
					raw_data: subscription,
					sync_batch_id: batchId,
					processing_status: 'pending',
					connection_id: connection.id,
				});
				const saved = await this.subscriptionsStgRepository.save(newSubscription);
				savedSubscriptions.push(saved);
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		return {
			success: true,
			message: `${savedSubscriptions.length} suscripciones sincronizadas`,
			subscriptions_synced: savedSubscriptions.length,
			batch_id: batchId,
		};
	}

	async syncCustomers(dto: SyncStripeDataDto, holdingId: string) {
		this.logger.log(`Sincronizando clientes de Stripe para conexión: ${dto.connection_id}`);

		const connection = await this.connectionService.findOne(dto.connection_id, holdingId);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const params: Stripe.CustomerListParams = {
			limit: dto.limit || 100,
		};

		if (dto.date_from) {
			params.created = { gte: Math.floor(new Date(dto.date_from).getTime() / 1000) };
		}
		if (dto.date_to) {
			if (params.created) {
				(params.created as any).lte = Math.floor(new Date(dto.date_to).getTime() / 1000);
			} else {
				params.created = { lte: Math.floor(new Date(dto.date_to).getTime() / 1000) };
			}
		}

		const customers = await stripeClient.customers.list(params);
		const batchId = uuidv4();

		const savedCustomers = [];
		for (const customer of customers.data) {
			const existing = await this.customersStgRepository.findOne({
				where: { stripe_id: customer.id, holding_id: holdingId },
			});

			if (existing) {
				existing.raw_data = customer;
				existing.sync_batch_id = batchId;
				existing.processing_status = 'updated';
				await this.customersStgRepository.save(existing);
				savedCustomers.push(existing);
			} else {
				const newCustomer = this.customersStgRepository.create({
					holding_id: holdingId,
					stripe_id: customer.id,
					raw_data: customer,
					sync_batch_id: batchId,
					processing_status: 'pending',
					connection_id: connection.id,
				});
				const saved = await this.customersStgRepository.save(newCustomer);
				savedCustomers.push(saved);
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		return {
			success: true,
			message: `${savedCustomers.length} clientes sincronizados`,
			customers_synced: savedCustomers.length,
			batch_id: batchId,
		};
	}

	async syncInvoices(dto: SyncStripeDataDto, holdingId: string) {
		this.logger.log(`Sincronizando facturas de Stripe para conexión: ${dto.connection_id}`);

		const connection = await this.connectionService.findOne(dto.connection_id, holdingId);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const params: any = {};
		if (dto.date_from) {
			params.created = { gte: Math.floor(new Date(dto.date_from).getTime() / 1000) };
		}
		if (dto.date_to) {
			if (params.created) {
				params.created.lte = Math.floor(new Date(dto.date_to).getTime() / 1000);
			} else {
				params.created = { lte: Math.floor(new Date(dto.date_to).getTime() / 1000) };
			}
		}

		// Obtener todas las facturas iterando sobre páginas
		const allInvoices: Stripe.Invoice[] = [];
		let hasMore = true;
		let startingAfter: string | undefined = undefined;

		while (hasMore) {
			const result = await stripeClient.invoices.list({
				...params,
				limit: 100,
				starting_after: startingAfter,
			});

			allInvoices.push(...result.data);
			hasMore = result.has_more;

			if (hasMore && result.data.length > 0) {
				startingAfter = result.data[result.data.length - 1].id;
			}
		}

		const batchId = uuidv4();
		const savedInvoices = [];
		const uniqueCustomerIds = new Set<string>();
		const uniqueSubscriptionIds = new Set<string>();

		// Guardar facturas y extraer IDs
		for (const invoice of allInvoices) {
			const existing = await this.invoicesStgRepository.findOne({
				where: { stripe_id: invoice.id, holding_id: holdingId },
			});

			if (existing) {
				existing.raw_data = invoice;
				existing.sync_batch_id = batchId;
				existing.processing_status = 'updated';
				await this.invoicesStgRepository.save(existing);
				savedInvoices.push(existing);
			} else {
				const newInvoice = this.invoicesStgRepository.create({
					holding_id: holdingId,
					stripe_id: invoice.id,
					raw_data: invoice,
					sync_batch_id: batchId,
					processing_status: 'pending',
					connection_id: connection.id,
				});
				const saved = await this.invoicesStgRepository.save(newInvoice);
				savedInvoices.push(saved);
			}

			// Extraer IDs de clientes y suscripciones
			if (invoice.customer) {
				uniqueCustomerIds.add(typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id);
			}

			// Buscar subscription ID en parent.subscription_details.subscription
			let subscriptionId = null;
			const parent = (invoice as any).parent;

			if (parent?.subscription_details?.subscription) {
				subscriptionId = parent.subscription_details.subscription;
			}

			// Log detallado para debugging (solo primeras 3 facturas)
			if (allInvoices.indexOf(invoice) < 3) {
				this.logger.log(`[SYNC] Factura ${invoice.id}: subscription = ${subscriptionId}, parent.type = ${parent?.type}`);
			}

			if (subscriptionId) {
				uniqueSubscriptionIds.add(typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id);
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		return {
			success: true,
			message: `${savedInvoices.length} facturas sincronizadas`,
			invoices_synced: savedInvoices.length,
			batch_id: batchId,
			customer_ids: Array.from(uniqueCustomerIds),
			subscription_ids: Array.from(uniqueSubscriptionIds),
			connection,
		};
	}

	async syncCustomersByIds(customerIds: string[], connection: StripeConnection, holdingId: string, batchId: string) {
		this.logger.log(`Sincronizando ${customerIds.length} clientes por IDs`);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const savedCustomers = [];
		for (const customerId of customerIds) {
			try {
				const customer = await stripeClient.customers.retrieve(customerId);

				const existing = await this.customersStgRepository.findOne({
					where: { stripe_id: customer.id, holding_id: holdingId },
				});

				if (existing) {
					existing.raw_data = customer;
					existing.sync_batch_id = batchId;
					existing.processing_status = 'updated';
					await this.customersStgRepository.save(existing);
					savedCustomers.push(existing);
				} else {
					const newCustomer = this.customersStgRepository.create({
						holding_id: holdingId,
						stripe_id: customer.id,
						raw_data: customer,
						sync_batch_id: batchId,
						processing_status: 'pending',
						connection_id: connection.id,
					});
					const saved = await this.customersStgRepository.save(newCustomer);
					savedCustomers.push(saved);
				}
			} catch (error) {
				this.logger.error(`Error sincronizando cliente ${customerId}:`, error);
			}
		}

		return {
			success: true,
			message: `${savedCustomers.length} clientes sincronizados`,
			customers_synced: savedCustomers.length,
		};
	}

	async syncSubscriptionsByIds(subscriptionIds: string[], connection: StripeConnection, holdingId: string, batchId: string) {
		this.logger.log(`Sincronizando ${subscriptionIds.length} suscripciones por IDs`);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const savedSubscriptions = [];
		for (const subscriptionId of subscriptionIds) {
			try {
				const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);

				const existing = await this.subscriptionsStgRepository.findOne({
					where: { stripe_id: subscription.id, holding_id: holdingId },
				});

				if (existing) {
					existing.raw_data = subscription;
					existing.sync_batch_id = batchId;
					existing.processing_status = 'updated';
					await this.subscriptionsStgRepository.save(existing);
					savedSubscriptions.push(existing);
				} else {
					const newSubscription = this.subscriptionsStgRepository.create({
						holding_id: holdingId,
						stripe_id: subscription.id,
						raw_data: subscription,
						sync_batch_id: batchId,
						processing_status: 'pending',
						connection_id: connection.id,
					});
					const saved = await this.subscriptionsStgRepository.save(newSubscription);
					savedSubscriptions.push(saved);
				}
			} catch (error) {
				this.logger.error(`Error sincronizando suscripción ${subscriptionId}:`, error);
			}
		}

		return {
			success: true,
			message: `${savedSubscriptions.length} suscripciones sincronizadas`,
			subscriptions_synced: savedSubscriptions.length,
		};
	}

	async syncAll(dto: SyncStripeDataDto, holdingId: string) {
		this.logger.log(`Iniciando sincronización completa de Stripe para conexión: ${dto.connection_id}`);

		// 1. Sincronizar facturas y extraer IDs
		const invoiceResult = await this.syncInvoices(dto, holdingId);

		this.logger.log(
			`Facturas sincronizadas: ${invoiceResult.invoices_synced}, ` +
				`Clientes únicos: ${invoiceResult.customer_ids.length}, ` +
				`Suscripciones únicas: ${invoiceResult.subscription_ids.length}`
		);

		// 2. Sincronizar clientes relacionados
		let customerResult = { customers_synced: 0, message: 'Sin clientes para sincronizar' };
		if (invoiceResult.customer_ids.length > 0) {
			customerResult = await this.syncCustomersByIds(invoiceResult.customer_ids, invoiceResult.connection, holdingId, invoiceResult.batch_id);
		}

		// 3. Sincronizar suscripciones relacionadas
		let subscriptionResult = { subscriptions_synced: 0, message: 'Sin suscripciones para sincronizar' };
		if (invoiceResult.subscription_ids.length > 0) {
			subscriptionResult = await this.syncSubscriptionsByIds(
				invoiceResult.subscription_ids,
				invoiceResult.connection,
				holdingId,
				invoiceResult.batch_id
			);
		}

		this.logger.log(
			`Sincronización completa finalizada: ` +
				`${invoiceResult.invoices_synced} facturas, ` +
				`${customerResult.customers_synced} clientes, ` +
				`${subscriptionResult.subscriptions_synced} suscripciones`
		);

		return {
			success: true,
			message: 'Sincronización completa exitosa',
			batch_id: invoiceResult.batch_id,
			invoices: {
				synced: invoiceResult.invoices_synced,
				message: invoiceResult.message,
			},
			customers: {
				synced: customerResult.customers_synced,
				message: customerResult.message,
			},
			subscriptions: {
				synced: subscriptionResult.subscriptions_synced,
				message: subscriptionResult.message,
			},
		};
	}
}
