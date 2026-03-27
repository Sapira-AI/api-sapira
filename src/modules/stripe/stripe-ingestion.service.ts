import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Stripe from 'stripe';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { IntegrationLog } from '@/databases/postgresql/entities/integration-log.entity';

import { CountStripeRecordsDto, SyncStripeDataDto } from './dtos/sync-stripe-data.dto';
import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeCustomersStg } from './entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from './entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from './entities/stripe-subscriptions-stg.entity';
import { StripeConnectionService } from './stripe-connection.service';
import { STRIPE_CLIENT } from './stripe.provider';

@Injectable()
export class StripeIngestionService {
	private readonly logger = new Logger(StripeIngestionService.name);

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
		@InjectRepository(IntegrationLog)
		private readonly integrationLogRepository: Repository<IntegrationLog>,
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
		let createdCount = 0;
		let updatedCount = 0;
		let unchangedCount = 0;

		for (const subscription of subscriptions.data) {
			const existing = await this.subscriptionsStgRepository.findOne({
				where: { stripe_id: subscription.id, holding_id: holdingId },
			});

			if (existing) {
				const dataChanged = this.hasDataChanged(existing.raw_data, subscription);

				if (dataChanged) {
					existing.raw_data = subscription;
					existing.sync_batch_id = batchId;
					existing.processing_status = 'to_update';
					await this.subscriptionsStgRepository.save(existing);
					savedSubscriptions.push(existing);
					updatedCount++;
				} else {
					await this.subscriptionsStgRepository.update(existing.id, {
						sync_batch_id: batchId,
					});
					savedSubscriptions.push(existing);
					unchangedCount++;
				}
			} else {
				// No está en staging - verificar si existe en destino
				const existsInDest = await this.existsInDestination(subscription.id, holdingId, 'subscription');

				const newSubscription = this.subscriptionsStgRepository.create({
					holding_id: holdingId,
					stripe_id: subscription.id,
					raw_data: subscription,
					sync_batch_id: batchId,
					processing_status: existsInDest ? 'to_update' : 'to_create',
					connection_id: connection.id,
				});
				const saved = await this.subscriptionsStgRepository.save(newSubscription);
				savedSubscriptions.push(saved);

				if (existsInDest) {
					updatedCount++;
				} else {
					createdCount++;
				}
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		this.logger.log(`📊 Resumen de suscripciones: ${createdCount} para crear, ${updatedCount} para actualizar, ${unchangedCount} sin cambios`);

		return {
			success: true,
			message: `${savedSubscriptions.length} suscripciones sincronizadas`,
			subscriptions_synced: savedSubscriptions.length,
			batch_id: batchId,
			summary: {
				to_create: createdCount,
				to_update: updatedCount,
				unchanged: unchangedCount,
				total: savedSubscriptions.length,
			},
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
		let createdCount = 0;
		let updatedCount = 0;
		let unchangedCount = 0;

		for (const customer of customers.data) {
			const existing = await this.customersStgRepository.findOne({
				where: { stripe_id: customer.id, holding_id: holdingId },
			});

			if (existing) {
				const dataChanged = this.hasDataChanged(existing.raw_data, customer);

				if (dataChanged) {
					existing.raw_data = customer;
					existing.sync_batch_id = batchId;
					existing.processing_status = 'to_update';
					await this.customersStgRepository.save(existing);
					savedCustomers.push(existing);
					updatedCount++;
				} else {
					await this.customersStgRepository.update(existing.id, {
						sync_batch_id: batchId,
					});
					savedCustomers.push(existing);
					unchangedCount++;
				}
			} else {
				// No está en staging - verificar si existe en destino
				const existsInDest = await this.existsInDestination(customer.id, holdingId, 'customer');

				const newCustomer = this.customersStgRepository.create({
					holding_id: holdingId,
					stripe_id: customer.id,
					raw_data: customer,
					sync_batch_id: batchId,
					processing_status: existsInDest ? 'to_update' : 'to_create',
					connection_id: connection.id,
				});
				const saved = await this.customersStgRepository.save(newCustomer);
				savedCustomers.push(saved);

				if (existsInDest) {
					updatedCount++;
				} else {
					createdCount++;
				}
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		this.logger.log(`📊 Resumen de clientes: ${createdCount} para crear, ${updatedCount} para actualizar, ${unchangedCount} sin cambios`);

		return {
			success: true,
			message: `${savedCustomers.length} clientes sincronizados`,
			customers_synced: savedCustomers.length,
			batch_id: batchId,
			summary: {
				to_create: createdCount,
				to_update: updatedCount,
				unchanged: unchangedCount,
				total: savedCustomers.length,
			},
		};
	}

	async syncInvoices(dto: SyncStripeDataDto, holdingId: string, jobId?: string) {
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

		const batchId = uuidv4();
		const savedInvoices = [];
		const uniqueCustomerIds = new Set<string>();
		const uniqueSubscriptionIds = new Set<string>();

		let processedCount = 0;
		let successCount = 0;
		let failedCount = 0;
		let updatedCount = 0;
		let unchangedCount = 0;
		let createdCount = 0;
		let hasMore = true;
		let startingAfter: string | undefined = undefined;
		let batchNumber = 0;

		// Primero contar el total de facturas para establecer progress_total
		if (jobId) {
			this.logger.log('🔢 Contando total de facturas para establecer progreso...');
			let totalInvoices = 0;
			let countHasMore = true;
			let countStartingAfter: string | undefined = undefined;

			while (countHasMore) {
				const countResult = await stripeClient.invoices.list({
					...params,
					limit: 100,
					starting_after: countStartingAfter,
				});

				totalInvoices += countResult.data.length;
				countHasMore = countResult.has_more;

				if (countHasMore && countResult.data.length > 0) {
					countStartingAfter = countResult.data[countResult.data.length - 1].id;
				}
			}

			this.logger.log(`📊 Total de facturas a procesar: ${totalInvoices}`);

			// Establecer progress_total en el job
			await this.updateJobStatus(jobId, 'running', {
				progress_total: totalInvoices,
				records_processed: 0,
				records_success: 0,
				records_failed: 0,
			});
		}

		// Procesar en batches de 100 facturas (paginación de Stripe)
		while (hasMore) {
			batchNumber++;

			// 1. Obtener batch de facturas desde Stripe
			const result = await stripeClient.invoices.list({
				...params,
				limit: 100,
				starting_after: startingAfter,
			});

			this.logger.log(`📦 Batch ${batchNumber}: Obtenidas ${result.data.length} facturas desde Stripe`);

			// 2. Procesar cada factura del batch actual
			for (const invoice of result.data) {
				try {
					const existing = await this.invoicesStgRepository.findOne({
						where: { stripe_id: invoice.id, holding_id: holdingId },
					});

					if (existing) {
						// Comparar datos para detectar cambios
						const dataChanged = this.hasDataChanged(existing.raw_data, invoice);

						if (dataChanged) {
							// Datos cambiaron: UPDATE completo
							existing.raw_data = invoice;
							existing.sync_batch_id = batchId;
							existing.processing_status = 'to_update';
							await this.invoicesStgRepository.save(existing);
							updatedCount++;
						} else {
							// Sin cambios: UPDATE solo metadatos (más rápido)
							await this.invoicesStgRepository.update(existing.id, {
								sync_batch_id: batchId,
							});
							unchangedCount++;
						}
						savedInvoices.push(existing);
					} else {
						// No está en staging - verificar si existe en destino
						const existsInDest = await this.existsInDestination(invoice.id, holdingId, 'invoice');

						const newInvoice = this.invoicesStgRepository.create({
							holding_id: holdingId,
							stripe_id: invoice.id,
							raw_data: invoice,
							sync_batch_id: batchId,
							processing_status: existsInDest ? 'to_update' : 'to_create',
							connection_id: connection.id,
						});
						const saved = await this.invoicesStgRepository.save(newInvoice);
						savedInvoices.push(saved);

						if (existsInDest) {
							updatedCount++;
						} else {
							createdCount++;
						}
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
					if (processedCount < 3) {
						this.logger.log(`[SYNC] Factura ${invoice.id}: subscription = ${subscriptionId}, parent.type = ${parent?.type}`);
					}

					if (subscriptionId) {
						uniqueSubscriptionIds.add(typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id);
					}

					successCount++;
				} catch (error) {
					this.logger.error(`Error procesando factura ${invoice.id}:`, error);
					failedCount++;
				}

				processedCount++;

				// 3. Actualizar progreso cada 10 facturas o en la última
				if (jobId && (processedCount % 10 === 0 || processedCount === result.data.length)) {
					await this.updateJobStatus(jobId, 'running', {
						records_processed: processedCount,
						records_success: successCount,
						records_failed: failedCount,
					});

					const percentage = Math.round((processedCount / (processedCount + (result.has_more ? 100 : 0))) * 100);
					this.logger.log(
						`📊 [FACTURAS] Progreso: ${processedCount} procesadas (${percentage}%) - Exitosas: ${successCount}, Fallidas: ${failedCount}`
					);
				}
			}

			// 4. Log de batch completado
			this.logger.log(`✅ Batch ${batchNumber} completado: ${result.data.length} facturas procesadas`);

			// 5. Preparar siguiente batch
			hasMore = result.has_more;
			if (hasMore && result.data.length > 0) {
				startingAfter = result.data[result.data.length - 1].id;
			}
		}

		await this.connectionService.updateLastSyncAt(connection.id);

		// Log de estadísticas de optimización
		this.logger.log(
			`📊 Estadísticas de sincronización: ` +
				`Creadas: ${createdCount}, Actualizadas: ${updatedCount}, Sin cambios: ${unchangedCount}, Fallidas: ${failedCount}`
		);

		return {
			success: true,
			message: `${savedInvoices.length} facturas sincronizadas`,
			invoices_synced: savedInvoices.length,
			batch_id: batchId,
			customer_ids: Array.from(uniqueCustomerIds),
			subscription_ids: Array.from(uniqueSubscriptionIds),
			connection,
			summary: {
				to_create: createdCount,
				to_update: updatedCount,
				unchanged: unchangedCount,
				total: savedInvoices.length,
			},
		};
	}

	async syncCustomersByIds(customerIds: string[], connection: StripeConnection, holdingId: string, batchId: string, jobId?: string) {
		this.logger.log(`Sincronizando ${customerIds.length} clientes por IDs`);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const savedCustomers = [];
		let processedCount = 0;
		let successCount = 0;
		let failedCount = 0;
		let createdCount = 0;
		let updatedCount = 0;
		let unchangedCount = 0;

		for (const customerId of customerIds) {
			try {
				const customer = await stripeClient.customers.retrieve(customerId);

				const existing = await this.customersStgRepository.findOne({
					where: { stripe_id: customer.id, holding_id: holdingId },
				});

				if (existing) {
					// Comparar datos para detectar cambios
					const dataChanged = this.hasDataChanged(existing.raw_data, customer);

					if (dataChanged) {
						// Datos cambiaron: UPDATE completo
						existing.raw_data = customer;
						existing.sync_batch_id = batchId;
						existing.processing_status = 'to_update';
						await this.customersStgRepository.save(existing);
						updatedCount++;
					} else {
						// Sin cambios: UPDATE solo metadatos (más rápido)
						await this.customersStgRepository.update(existing.id, {
							sync_batch_id: batchId,
						});
						unchangedCount++;
					}
					savedCustomers.push(existing);
				} else {
					// No está en staging - verificar si existe en destino
					const existsInDest = await this.existsInDestination(customer.id, holdingId, 'customer');

					const newCustomer = this.customersStgRepository.create({
						holding_id: holdingId,
						stripe_id: customer.id,
						raw_data: customer,
						sync_batch_id: batchId,
						processing_status: existsInDest ? 'to_update' : 'to_create',
						connection_id: connection.id,
					});
					const saved = await this.customersStgRepository.save(newCustomer);
					savedCustomers.push(saved);

					if (existsInDest) {
						updatedCount++;
					} else {
						createdCount++;
					}
				}
				successCount++;
			} catch (error) {
				this.logger.error(`Error sincronizando cliente ${customerId}:`, error);
				failedCount++;
			}

			processedCount++;

			// Log de progreso cada 10 registros o en el último
			if (processedCount % 10 === 0 || processedCount === customerIds.length) {
				const percentage = Math.round((processedCount / customerIds.length) * 100);
				this.logger.log(
					`📊 [CLIENTES] Progreso: ${processedCount}/${customerIds.length} (${percentage}%) - Exitosos: ${successCount}, Fallidos: ${failedCount}`
				);
			}

			// Actualizar progreso del job después de cada cliente
			if (jobId) {
				await this.updateJobStatus(jobId, 'running', {
					records_processed: processedCount,
					records_success: successCount,
					records_failed: failedCount,
				});
			}
		}

		this.logger.log(`📊 Resumen de clientes: ${createdCount} para crear, ${updatedCount} para actualizar, ${unchangedCount} sin cambios`);

		return {
			success: true,
			message: `${savedCustomers.length} clientes sincronizados`,
			customers_synced: savedCustomers.length,
			summary: {
				to_create: createdCount,
				to_update: updatedCount,
				unchanged: unchangedCount,
				total: savedCustomers.length,
			},
		};
	}

	async syncSubscriptionsByIds(subscriptionIds: string[], connection: StripeConnection, holdingId: string, batchId: string, jobId?: string) {
		this.logger.log(`Sincronizando ${subscriptionIds.length} suscripciones por IDs`);

		const stripeClient = new Stripe(connection.secret_key, {
			apiVersion: '2026-01-28.clover',
		});

		const savedSubscriptions = [];
		let processedCount = 0;
		let successCount = 0;
		let failedCount = 0;
		let createdCount = 0;
		let updatedCount = 0;
		let unchangedCount = 0;

		for (const subscriptionId of subscriptionIds) {
			try {
				const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);

				const existing = await this.subscriptionsStgRepository.findOne({
					where: { stripe_id: subscription.id, holding_id: holdingId },
				});

				if (existing) {
					// Comparar datos para detectar cambios
					const dataChanged = this.hasDataChanged(existing.raw_data, subscription);

					if (dataChanged) {
						// Datos cambiaron: UPDATE completo
						existing.raw_data = subscription;
						existing.sync_batch_id = batchId;
						existing.processing_status = 'to_update';
						await this.subscriptionsStgRepository.save(existing);
						updatedCount++;
					} else {
						// Sin cambios: UPDATE solo metadatos (más rápido)
						await this.subscriptionsStgRepository.update(existing.id, {
							sync_batch_id: batchId,
						});
						unchangedCount++;
					}
					savedSubscriptions.push(existing);
				} else {
					// No está en staging - verificar si existe en destino
					const existsInDest = await this.existsInDestination(subscription.id, holdingId, 'subscription');

					const newSubscription = this.subscriptionsStgRepository.create({
						holding_id: holdingId,
						stripe_id: subscription.id,
						raw_data: subscription,
						sync_batch_id: batchId,
						processing_status: existsInDest ? 'to_update' : 'to_create',
						connection_id: connection.id,
					});
					const saved = await this.subscriptionsStgRepository.save(newSubscription);
					savedSubscriptions.push(saved);

					if (existsInDest) {
						updatedCount++;
					} else {
						createdCount++;
					}
				}
				successCount++;
			} catch (error) {
				this.logger.error(`Error sincronizando suscripción ${subscriptionId}:`, error);
				failedCount++;
			}

			processedCount++;

			// Log de progreso cada 10 registros o en el último
			if (processedCount % 10 === 0 || processedCount === subscriptionIds.length) {
				const percentage = Math.round((processedCount / subscriptionIds.length) * 100);
				this.logger.log(
					`📊 [SUSCRIPCIONES] Progreso: ${processedCount}/${subscriptionIds.length} (${percentage}%) - Exitosos: ${successCount}, Fallidos: ${failedCount}`
				);
			}

			// Actualizar progreso del job después de cada suscripción
			if (jobId) {
				await this.updateJobStatus(jobId, 'running', {
					records_processed: processedCount,
					records_success: successCount,
					records_failed: failedCount,
				});
			}
		}

		this.logger.log(`📊 Resumen de suscripciones: ${createdCount} para crear, ${updatedCount} para actualizar, ${unchangedCount} sin cambios`);

		return {
			success: true,
			message: `${savedSubscriptions.length} suscripciones sincronizadas`,
			subscriptions_synced: savedSubscriptions.length,
			summary: {
				to_create: createdCount,
				to_update: updatedCount,
				unchanged: unchangedCount,
				total: savedSubscriptions.length,
			},
		};
	}

	async syncAll(dto: SyncStripeDataDto, holdingId: string) {
		this.logger.log(`Iniciando sincronización completa de Stripe para conexión: ${dto.connection_id}`);

		const batch_id = uuidv4();

		// Crear jobs de integración para tracking
		const invoicesJob = this.integrationLogRepository.create({
			holding_id: holdingId,
			source_table: 'stripe.invoices',
			target_table: 'stripe_invoices_stg',
			status: 'running',
			records_processed: 0,
			records_success: 0,
			records_failed: 0,
			started_at: new Date(),
			integration_type: 'stripe_invoices_sync',
			progress_total: 0,
			connection_id: dto.connection_id,
			metadata: { batch_id, entity_type: 'invoices' },
		});

		const customersJob = this.integrationLogRepository.create({
			holding_id: holdingId,
			source_table: 'stripe.customers',
			target_table: 'stripe_customers_stg',
			status: 'running',
			records_processed: 0,
			records_success: 0,
			records_failed: 0,
			started_at: new Date(),
			integration_type: 'stripe_customers_sync',
			progress_total: 0,
			connection_id: dto.connection_id,
			metadata: { batch_id, entity_type: 'customers' },
		});

		const subscriptionsJob = this.integrationLogRepository.create({
			holding_id: holdingId,
			source_table: 'stripe.subscriptions',
			target_table: 'stripe_subscriptions_stg',
			status: 'running',
			records_processed: 0,
			records_success: 0,
			records_failed: 0,
			started_at: new Date(),
			integration_type: 'stripe_subscriptions_sync',
			progress_total: 0,
			connection_id: dto.connection_id,
			metadata: { batch_id, entity_type: 'subscriptions' },
		});

		const [savedInvoicesJob, savedCustomersJob, savedSubscriptionsJob] = await Promise.all([
			this.integrationLogRepository.save(invoicesJob),
			this.integrationLogRepository.save(customersJob),
			this.integrationLogRepository.save(subscriptionsJob),
		]);

		// Ejecutar sincronización en background usando setImmediate
		setImmediate(async () => {
			try {
				await this.executeSyncInBackground(dto, holdingId, batch_id, savedInvoicesJob.id, savedCustomersJob.id, savedSubscriptionsJob.id);
			} catch (error) {
				this.logger.error('❌ Error en sincronización background:', error);
			}
		});

		// Retornar inmediatamente con los IDs de los jobs
		const response = {
			success: true,
			message: 'Sincronización iniciada',
			batch_id,
			job_ids: {
				invoices: savedInvoicesJob.id,
				customers: savedCustomersJob.id,
				subscriptions: savedSubscriptionsJob.id,
			},
		};

		this.logger.log(`✅ Retornando respuesta con job_ids: ${JSON.stringify(response.job_ids)}`);

		return response;
	}

	/**
	 * Ejecuta la sincronización en background actualizando el progreso
	 */
	private async executeSyncInBackground(
		dto: SyncStripeDataDto,
		holdingId: string,
		batch_id: string,
		invoicesJobId: string,
		customersJobId: string,
		subscriptionsJobId: string
	) {
		this.logger.log('🚀 Iniciando sincronización en background...');

		try {
			// Primero sincronizar facturas para obtener los IDs de clientes y suscripciones
			this.logger.log('📄 Sincronizando facturas...');
			const invoiceResult = await this.syncInvoices(dto, holdingId, invoicesJobId);

			this.logger.log(
				`Facturas sincronizadas: ${invoiceResult.invoices_synced}, ` +
					`Clientes únicos: ${invoiceResult.customer_ids.length}, ` +
					`Suscripciones únicas: ${invoiceResult.subscription_ids.length}`
			);

			// Declarar variables para resultados
			let customerResult: any = null;
			let subscriptionResult: any = null;

			// ✅ VERIFICACIÓN 1: Antes de procesar clientes
			if (await this.isJobCancelled(customersJobId)) {
				this.logger.log('🛑 Integración cancelada por el usuario, deteniendo proceso antes de clientes');
				return;
			}

			// 1. Sincronizar clientes (PRIMERO)
			if (invoiceResult.customer_ids.length > 0) {
				await this.updateJobStatus(customersJobId, 'running', {
					progress_total: invoiceResult.customer_ids.length,
				});

				this.logger.log(`1️⃣ Sincronizando ${invoiceResult.customer_ids.length} clientes por IDs`);
				customerResult = await this.syncCustomersByIds(
					invoiceResult.customer_ids,
					invoiceResult.connection,
					holdingId,
					invoiceResult.batch_id,
					customersJobId
				);

				await this.updateJobStatus(customersJobId, 'completed', {
					records_processed: customerResult.customers_synced,
					records_success: customerResult.customers_synced,
				});
			} else {
				await this.updateJobStatus(customersJobId, 'completed', {
					progress_total: 0,
					records_processed: 0,
				});
			}

			// ✅ VERIFICACIÓN 2: Antes de procesar suscripciones
			if (await this.isJobCancelled(subscriptionsJobId)) {
				this.logger.log('🛑 Integración cancelada por el usuario, deteniendo proceso antes de suscripciones');
				return;
			}

			// 2. Sincronizar suscripciones (SEGUNDO)
			if (invoiceResult.subscription_ids.length > 0) {
				await this.updateJobStatus(subscriptionsJobId, 'running', {
					progress_total: invoiceResult.subscription_ids.length,
				});

				this.logger.log(`2️⃣ Sincronizando ${invoiceResult.subscription_ids.length} suscripciones por IDs`);
				subscriptionResult = await this.syncSubscriptionsByIds(
					invoiceResult.subscription_ids,
					invoiceResult.connection,
					holdingId,
					invoiceResult.batch_id,
					subscriptionsJobId
				);

				await this.updateJobStatus(subscriptionsJobId, 'completed', {
					records_processed: subscriptionResult.subscriptions_synced,
					records_success: subscriptionResult.subscriptions_synced,
				});
			} else {
				await this.updateJobStatus(subscriptionsJobId, 'completed', {
					progress_total: 0,
					records_processed: 0,
				});
			}

			// ✅ VERIFICACIÓN 3: Antes de completar facturas
			if (await this.isJobCancelled(invoicesJobId)) {
				this.logger.log('🛑 Integración cancelada por el usuario, deteniendo proceso antes de completar facturas');
				return;
			}

			// 3. Marcar facturas como completadas (TERCERO)
			await this.updateJobStatus(invoicesJobId, 'completed', {
				progress_total: invoiceResult.invoices_synced,
				records_processed: invoiceResult.invoices_synced,
				records_success: invoiceResult.invoices_synced,
			});

			// Log consolidado con resumen de estados
			const totalToCreate =
				(invoiceResult.summary?.to_create || 0) + (customerResult?.summary?.to_create || 0) + (subscriptionResult?.summary?.to_create || 0);

			const totalToUpdate =
				(invoiceResult.summary?.to_update || 0) + (customerResult?.summary?.to_update || 0) + (subscriptionResult?.summary?.to_update || 0);

			const totalUnchanged =
				(invoiceResult.summary?.unchanged || 0) + (customerResult?.summary?.unchanged || 0) + (subscriptionResult?.summary?.unchanged || 0);

			this.logger.log('\n╔═══════════════════════════════════════════════════════════════╗');
			this.logger.log('║           RESUMEN DE INTEGRACIÓN A STAGING                    ║');
			this.logger.log('╚═══════════════════════════════════════════════════════════════╝');
			this.logger.log(`📊 TOTAL GENERAL:`);
			this.logger.log(`   ✨ ${totalToCreate} registros para crear (to_create)`);
			this.logger.log(`   🔄 ${totalToUpdate} registros para actualizar (to_update)`);
			this.logger.log(`   ✅ ${totalUnchanged} registros sin cambios (mantienen estado)`);
			this.logger.log(`\n📋 DETALLE POR TIPO:`);
			this.logger.log(
				`   Facturas: ${invoiceResult.summary?.to_create || 0} crear | ${invoiceResult.summary?.to_update || 0} actualizar | ${invoiceResult.summary?.unchanged || 0} sin cambios`
			);
			this.logger.log(
				`   Clientes: ${customerResult?.summary?.to_create || 0} crear | ${customerResult?.summary?.to_update || 0} actualizar | ${customerResult?.summary?.unchanged || 0} sin cambios`
			);
			this.logger.log(
				`   Suscripciones: ${subscriptionResult?.summary?.to_create || 0} crear | ${subscriptionResult?.summary?.to_update || 0} actualizar | ${subscriptionResult?.summary?.unchanged || 0} sin cambios`
			);
			this.logger.log('═══════════════════════════════════════════════════════════════\n');
		} catch (error) {
			this.logger.error('Error en sincronización background:', error);
			await Promise.all([
				this.updateJobStatus(invoicesJobId, 'failed', { error_details: error.message }),
				this.updateJobStatus(customersJobId, 'failed', { error_details: error.message }),
				this.updateJobStatus(subscriptionsJobId, 'failed', { error_details: error.message }),
			]);
		}
	}

	/**
	 * Actualiza el estado de un job de integración
	 */
	private async updateJobStatus(jobId: string, status: string, additionalData?: any) {
		try {
			const updateData: any = { status };

			if (status === 'completed') {
				updateData.completed_at = new Date();
			}

			if (additionalData) {
				Object.assign(updateData, additionalData);
			}

			await this.integrationLogRepository.update(jobId, updateData);
		} catch (error) {
			this.logger.error('Error actualizando estado del job:', error);
		}
	}

	/**
	 * Obtiene el estado de un job de integración
	 */
	async getJobStatus(jobId: string) {
		try {
			const integrationLog = await this.integrationLogRepository.findOne({
				where: { id: jobId },
			});

			if (!integrationLog) {
				throw new Error('Job no encontrado');
			}

			const progressPercentage = this.calculateProgressPercentage(
				integrationLog.records_processed || 0,
				integrationLog.progress_total || 0,
				integrationLog.status || 'running'
			);

			const executionTime = integrationLog.completed_at
				? new Date(integrationLog.completed_at).getTime() - new Date(integrationLog.started_at).getTime()
				: integrationLog.execution_time_ms || null;

			return {
				job_id: integrationLog.id,
				status: integrationLog.status || 'running',
				total_records: integrationLog.progress_total || 0,
				records_processed: integrationLog.records_processed || 0,
				records_success: integrationLog.records_success || 0,
				records_failed: integrationLog.records_failed || 0,
				progress_percentage: progressPercentage,
				execution_time_ms: executionTime,
				started_at: integrationLog.started_at,
				completed_at: integrationLog.completed_at || undefined,
				error_details: integrationLog.error_details || undefined,
			};
		} catch (error) {
			this.logger.error('Error obteniendo estado del job:', error);
			throw error;
		}
	}

	/**
	 * Verifica si un job fue cancelado
	 */
	private async isJobCancelled(jobId: string): Promise<boolean> {
		try {
			const job = await this.integrationLogRepository.findOne({
				where: { id: jobId },
				select: ['status'],
			});
			return job?.status === 'cancelled';
		} catch (error) {
			this.logger.error('Error verificando estado del job:', error);
			return false;
		}
	}

	/**
	 * Cancela un job de integración
	 */
	async cancelJob(jobId: string, holdingId: string) {
		try {
			const integrationLog = await this.integrationLogRepository.findOne({
				where: { id: jobId, holding_id: holdingId },
			});

			if (!integrationLog) {
				throw new Error('Job no encontrado');
			}

			if (integrationLog.status === 'completed' || integrationLog.status === 'failed') {
				throw new Error('El job ya finalizó');
			}

			await this.integrationLogRepository.update(jobId, {
				status: 'cancelled',
				completed_at: new Date(),
				error_details: { message: 'Cancelado por el usuario' } as any,
			});

			this.logger.log(`Job ${jobId} cancelado por el usuario`);

			return { success: true, message: 'Job cancelado exitosamente' };
		} catch (error) {
			this.logger.error('Error cancelando job:', error);
			throw error;
		}
	}

	/**
	 * Compara dos objetos para detectar si hay cambios en los datos
	 */
	private hasDataChanged(oldData: any, newData: any): boolean {
		try {
			// Comparación por JSON stringify (rápida y efectiva)
			return JSON.stringify(oldData) !== JSON.stringify(newData);
		} catch (error) {
			// Si hay error en la comparación, asumir que cambió para actualizar
			this.logger.warn('Error comparando datos, asumiendo cambio:', error);
			return true;
		}
	}

	/**
	 * Calcula el porcentaje de progreso de un job
	 */
	private calculateProgressPercentage(recordsProcessed: number, progressTotal: number, status: string): number {
		if (status === 'completed') {
			return 100;
		}

		if (!progressTotal || progressTotal === 0) {
			return 0;
		}

		return Math.min(100, Math.round((recordsProcessed / progressTotal) * 100));
	}

	/**
	 * Verifica si un registro existe en la tabla destino
	 */
	private async existsInDestination(stripeId: string, holdingId: string, entityType: 'customer' | 'subscription' | 'invoice'): Promise<boolean> {
		try {
			switch (entityType) {
				case 'customer':
					return await this.checkCustomerInDestination(stripeId, holdingId);
				case 'subscription':
					return await this.checkSubscriptionInDestination(stripeId, holdingId);
				case 'invoice':
					return await this.checkInvoiceInDestination(stripeId, holdingId);
				default:
					return false;
			}
		} catch (error) {
			this.logger.error(`Error verificando ${entityType} en destino:`, error);
			return false; // En caso de error, asumir que no existe (fail-safe)
		}
	}

	/**
	 * Verifica si un cliente existe en client_entities
	 */
	private async checkCustomerInDestination(stripeId: string, holdingId: string): Promise<boolean> {
		const result = await this.customersStgRepository.query(`SELECT 1 FROM client_entities WHERE tax_id = $1 AND holding_id = $2 LIMIT 1`, [
			stripeId,
			holdingId,
		]);
		return result && result.length > 0;
	}

	/**
	 * Verifica si una suscripción existe en subscriptions
	 */
	private async checkSubscriptionInDestination(stripeId: string, holdingId: string): Promise<boolean> {
		const result = await this.subscriptionsStgRepository.query(`SELECT 1 FROM subscriptions WHERE external_id = $1 AND holding_id = $2 LIMIT 1`, [
			stripeId,
			holdingId,
		]);
		return result && result.length > 0;
	}

	/**
	 * Verifica si una factura existe en invoices
	 */
	private async checkInvoiceInDestination(stripeId: string, holdingId: string): Promise<boolean> {
		const result = await this.invoicesStgRepository.query(`SELECT 1 FROM invoices WHERE stripe_id = $1 AND holding_id = $2 LIMIT 1`, [
			stripeId,
			holdingId,
		]);
		return result && result.length > 0;
	}
}
