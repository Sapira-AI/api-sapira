import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { SyncJobStatusDto, SyncProgressDto } from '../dto/sync-progress.dto';
import { EntitySyncStatsDto, SyncStatsDto } from '../dto/sync-response.dto';
import { StripeCustomersStg } from '../entities/stripe-customers-stg.entity';
import { StripeInvoicesStg } from '../entities/stripe-invoices-stg.entity';
import { StripeSubscriptionsStg } from '../entities/stripe-subscriptions-stg.entity';
import { StripeSyncJob } from '../entities/stripe-sync-job.entity';

@Injectable()
export class StripeSyncService {
	private readonly logger = new Logger(StripeSyncService.name);

	constructor(
		@InjectRepository(StripeCustomersStg)
		private readonly customersStgRepo: Repository<StripeCustomersStg>,
		@InjectRepository(StripeSubscriptionsStg)
		private readonly subscriptionsStgRepo: Repository<StripeSubscriptionsStg>,
		@InjectRepository(StripeInvoicesStg)
		private readonly invoicesStgRepo: Repository<StripeInvoicesStg>,
		@InjectRepository(StripeSyncJob)
		private readonly syncJobRepo: Repository<StripeSyncJob>
	) {}

	async syncAll(holdingId: string, batchSize: number = 100): Promise<{ jobId: string }> {
		const job = await this.syncJobRepo.save({
			holding_id: holdingId,
			status: 'running',
			progress: {
				customers: { total: 0, processed: 0 },
				subscriptions: { total: 0, processed: 0 },
				invoices: { total: 0, processed: 0 },
				currentPhase: 'customers',
				overallProgress: 0,
			},
		});

		this.executeSyncJob(job.id, holdingId, batchSize).catch((error) => {
			this.logger.error(`Error en job ${job.id}:`, error);
		});

		return { jobId: job.id };
	}

	async getJobStatus(jobId: string): Promise<SyncJobStatusDto> {
		const job = await this.syncJobRepo.findOne({ where: { id: jobId } });

		if (!job) {
			throw new Error('Job no encontrado');
		}

		this.logger.debug(`📊 getJobStatus para job ${jobId}:`);
		this.logger.debug(`   Status: ${job.status}`);
		this.logger.debug(`   Progress: ${JSON.stringify(job.progress)}`);
		this.logger.debug(`   Progress type: ${typeof job.progress}`);

		return {
			jobId: job.id,
			status: job.status as any,
			progress: job.progress,
			stats: job.stats,
			errors: job.errors,
			errorMessage: job.error_message,
			createdAt: job.created_at,
			updatedAt: job.updated_at,
			completedAt: job.completed_at,
		};
	}

	private async executeSyncJob(jobId: string, holdingId: string, batchSize: number): Promise<void> {
		this.logger.log(`Ejecutando job ${jobId} para holding ${holdingId}`);

		const stats: EntitySyncStatsDto = {
			customers: this.initStats(),
			subscriptions: this.initStats(),
			subscriptionItems: this.initStats(),
			invoices: this.initStats(),
			invoiceItems: this.initStats(),
		};

		const errors: string[] = [];

		try {
			this.logger.log('Fase 0: Validando clientes contra BigQuery...');
			const customersToValidate = await this.customersStgRepo
				.createQueryBuilder('c')
				.where('c.holding_id = :holdingId', { holdingId })
				.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
				.getMany();

			this.logger.log(`Validando ${customersToValidate.length} clientes...`);
			let invalidCount = 0;

			for (const customer of customersToValidate) {
				const isValid = await this.validateCustomerAgainstBigQuery(customer.stripe_id);
				if (!isValid) {
					await this.markCustomerAsInvalid(customer.id, 'Cliente no válido - sin Salesforce ID en BigQuery');
					await this.markRelatedRecordsAsInvalid(customer.stripe_id);
					invalidCount++;
				}
			}

			this.logger.log(`Validación completada. ${invalidCount} clientes marcados como inválidos`);

			this.logger.log(`📊 Contando registros para sincronizar...`);

			const customerCount = await this.customersStgRepo.count({
				where: {
					holding_id: holdingId,
					processing_status: In(['to_create', 'to_update', 'error']) as any,
				},
			});
			this.logger.log(`📊 Clientes a sincronizar (count simple): ${customerCount}`);

			// Verificar con query builder también
			const customerCountQB = await this.customersStgRepo
				.createQueryBuilder('c')
				.where('c.holding_id = :holdingId', { holdingId })
				.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
				.getCount();
			this.logger.log(`📊 Clientes a sincronizar (query builder sin filtro integration_notes): ${customerCountQB}`);

			const customerCountQBFiltered = await this.customersStgRepo
				.createQueryBuilder('c')
				.where('c.holding_id = :holdingId', { holdingId })
				.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
				.andWhere("(c.integration_notes IS NULL OR c.integration_notes != 'Cliente no valido')")
				.getCount();
			this.logger.log(`📊 Clientes a sincronizar (query builder CON filtro integration_notes): ${customerCountQBFiltered}`);

			const subscriptionCount = await this.subscriptionsStgRepo
				.createQueryBuilder('s')
				.where('s.holding_id = :holdingId', { holdingId })
				.andWhere("s.processing_status IN ('to_create', 'to_update', 'error')")
				.andWhere("(s.integration_notes IS NULL OR s.integration_notes != 'Cliente no valido')")
				.getCount();
			this.logger.log(`📊 Suscripciones a sincronizar: ${subscriptionCount}`);

			const invoiceCount = await this.invoicesStgRepo
				.createQueryBuilder('i')
				.where('i.holding_id = :holdingId', { holdingId })
				.andWhere("i.processing_status IN ('to_create', 'to_update', 'error')")
				.andWhere("(i.integration_notes IS NULL OR i.integration_notes != 'Cliente no valido')")
				.getCount();
			this.logger.log(`📊 Facturas a sincronizar: ${invoiceCount}`);

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: 0 },
				subscriptions: { total: subscriptionCount, processed: 0 },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'customers',
				overallProgress: 0,
			});

			this.logger.log(`🚀 Paso 1: Sincronizando clientes (total: ${customerCount})...`);
			stats.customers = await this.syncCustomers(holdingId, batchSize, jobId, customerCount);

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: 0 },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'subscriptions',
				overallProgress: 33,
			});

			this.logger.log('Paso 2: Sincronizando suscripciones...');
			const subscriptionResult = await this.syncSubscriptions(holdingId, batchSize, jobId, subscriptionCount);
			stats.subscriptions = subscriptionResult.subscriptions;
			stats.subscriptionItems = subscriptionResult.subscriptionItems;

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: subscriptionCount },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'invoices',
				overallProgress: 66,
			});

			this.logger.log('Paso 3: Sincronizando facturas...');
			const invoiceResult = await this.syncInvoices(holdingId, batchSize, jobId, invoiceCount);
			stats.invoices = invoiceResult.invoices;
			stats.invoiceItems = invoiceResult.invoiceItems;

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: subscriptionCount },
				invoices: { total: invoiceCount, processed: invoiceCount },
				currentPhase: 'completed',
				overallProgress: 100,
			});

			this.logger.log('Sincronización completada exitosamente');

			await this.syncJobRepo.update(jobId, {
				status: 'completed',
				stats: stats as any,
				errors: errors.length > 0 ? errors : null,
				completed_at: new Date(),
			});
		} catch (error) {
			this.logger.error('Error durante la sincronización', error);
			errors.push(error.message);

			await this.syncJobRepo.update(jobId, {
				status: 'failed',
				stats: stats as any,
				errors,
				error_message: error.message,
				completed_at: new Date(),
			});
		}
	}

	private async updateJobProgress(jobId: string, progress: SyncProgressDto): Promise<void> {
		await this.syncJobRepo.update(jobId, { progress: progress as any });
	}

	private async syncCustomers(holdingId: string, batchSize: number, jobId?: string, total?: number): Promise<SyncStatsDto> {
		const stats = this.initStats();
		const chunkSize = batchSize || 200;
		let offset = 0;
		let hasMore = true;
		let totalProcessedSoFar = 0;

		this.logger.log(`🔍 Iniciando syncCustomers con holdingId: ${holdingId}, batchSize: ${batchSize}, total esperado: ${total}`);

		try {
			while (hasMore) {
				this.logger.debug(`🔎 Buscando clientes - offset: ${offset}, chunkSize: ${chunkSize}`);

				const queryBuilder = this.customersStgRepo
					.createQueryBuilder('c')
					.where('c.holding_id = :holdingId', { holdingId })
					.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
					.andWhere("(c.integration_notes IS NULL OR c.integration_notes != 'Cliente no valido')")
					.orderBy('c.created_at', 'ASC')
					.skip(offset)
					.take(chunkSize);

				const sql = queryBuilder.getSql();
				this.logger.debug(`📝 Query SQL: ${sql}`);
				this.logger.debug(`📝 Parámetros: ${JSON.stringify(queryBuilder.getParameters())}`);

				const customers = await queryBuilder.getMany();

				this.logger.log(`📊 Clientes encontrados en este chunk: ${customers.length}`);

				if (customers.length === 0) {
					this.logger.warn(`⚠️ No se encontraron clientes en offset ${offset}. Deteniendo sincronización.`);
					hasMore = false;
					break;
				}

				this.logger.log(`✅ Procesando chunk de ${customers.length} clientes (offset: ${offset})...`);

				for (const customer of customers) {
					this.logger.debug(`🔄 Procesando cliente: ${customer.stripe_id}`);
					try {
						const result = await this.syncCustomerToDestination(customer, holdingId);
						this.logger.debug(`📤 Resultado para ${customer.stripe_id}: ${JSON.stringify(result)}`);

						if (result.success) {
							await this.updateCustomerStatus(customer.id, 'processed', result.action);
							if (result.action === 'create') {
								stats.created++;
							} else if (result.action === 'update') {
								stats.updated++;
							} else {
								stats.skipped++;
							}
						} else {
							await this.updateCustomerStatus(customer.id, 'error', null, result.error);
							stats.errors++;
						}

						stats.totalProcessed++;
						totalProcessedSoFar++;
					} catch (error) {
						this.logger.error(`Error procesando cliente ${customer.stripe_id}`, error);
						const errorMsg = this.getDetailedErrorMessage(error);
						await this.updateCustomerStatus(customer.id, 'error', null, errorMsg);
						stats.errors++;
						stats.totalProcessed++;
						totalProcessedSoFar++;
					}
				}

				if (jobId && total) {
					const job = await this.syncJobRepo.findOne({ where: { id: jobId } });
					if (job && job.progress) {
						await this.updateJobProgress(jobId, {
							...job.progress,
							customers: {
								total,
								processed: totalProcessedSoFar,
								current: `Chunk ${Math.floor(offset / chunkSize) + 1}`,
							},
						});
					}
				}

				if (customers.length < chunkSize) {
					hasMore = false;
				} else {
					offset += chunkSize;
				}
			}

			this.logger.log(`Sincronización de clientes completada. Total procesado: ${totalProcessedSoFar}`);
		} catch (error) {
			this.logger.error('Error en syncCustomers', error);
			throw error;
		}

		return stats;
	}

	private async validateCustomerAgainstBigQuery(stripeCustomerId: string): Promise<boolean> {
		try {
			const result = await this.customersStgRepo.query(
				`SELECT salesforce_account_id FROM stripe_customers_bigquery WHERE stripe_customer_id = $1 AND salesforce_account_id IS NOT NULL AND salesforce_account_id != ''`,
				[stripeCustomerId]
			);
			return result && result.length > 0;
		} catch (error) {
			this.logger.error(`Error validando cliente ${stripeCustomerId} contra BigQuery`, error);
			return false;
		}
	}

	private async markCustomerAsInvalid(customerId: string, reason: string): Promise<void> {
		await this.customersStgRepo.update(customerId, {
			processing_status: 'invalid',
			integration_notes: 'Cliente no valido',
			error_message: reason,
		});
	}

	private async markRelatedRecordsAsInvalid(stripeCustomerId: string): Promise<void> {
		await this.subscriptionsStgRepo
			.createQueryBuilder()
			.update()
			.set({
				processing_status: 'invalid',
				integration_notes: 'Cliente no valido',
				error_message: 'Cliente asociado no válido',
			})
			.where("raw_data->>'customer' = :stripeCustomerId", { stripeCustomerId })
			.execute();

		await this.invoicesStgRepo
			.createQueryBuilder()
			.update()
			.set({
				processing_status: 'invalid',
				integration_notes: 'Cliente no valido',
				error_message: 'Cliente asociado no válido',
			})
			.where("raw_data->>'customer' = :stripeCustomerId", { stripeCustomerId })
			.execute();
	}

	private async syncCustomerToDestination(
		customer: StripeCustomersStg,
		holdingId: string
	): Promise<{ success: boolean; action?: 'create' | 'update' | 'no_change'; error?: string }> {
		try {
			const rawData = customer.raw_data as any;

			// Obtener datos de BigQuery para crear/actualizar el client
			const bigQueryData = await this.customersStgRepo.query(
				`SELECT client_name, salesforce_account_segment, salesforce_account_industry, salesforce_account_country 
				 FROM stripe_customers_bigquery 
				 WHERE stripe_customer_id = $1 AND holding_id = $2`,
				[customer.stripe_id, holdingId]
			);

			let clientId: string | null = null;

			// Si hay datos de BigQuery, buscar o crear el client
			if (bigQueryData && bigQueryData.length > 0) {
				const bqData = bigQueryData[0];

				// Buscar client existente por nombre comercial
				const existingClientRecord = await this.customersStgRepo.query(
					`SELECT id FROM clients WHERE name_commercial = $1 AND holding_id = $2`,
					[bqData.client_name, holdingId]
				);

				if (existingClientRecord && existingClientRecord.length > 0) {
					clientId = existingClientRecord[0].id;
				} else {
					// Crear nuevo client
					const newClient = await this.customersStgRepo.query(
						`INSERT INTO clients (holding_id, name_commercial, segment, industry, status) 
						 VALUES ($1, $2, $3, $4, 'Activo') RETURNING id`,
						[holdingId, bqData.client_name, bqData.salesforce_account_segment, bqData.salesforce_account_industry]
					);
					clientId = newClient[0].id;
				}
			}

			this.logger.debug(`Buscando client_entity para stripe_id: ${customer.stripe_id}`);
			const existingClient = await this.customersStgRepo.query(
				`SELECT id, legal_name, email, client_number, client_id FROM client_entities WHERE tax_id = $1 AND holding_id = $2`,
				[customer.stripe_id, holdingId]
			);
			this.logger.debug(`Client_entity encontrado: ${existingClient && existingClient.length > 0 ? 'SI' : 'NO'}`);

			const clientData = {
				client_id: clientId,
				legal_name: rawData.email || '',
				tax_id: customer.stripe_id,
				country: bigQueryData && bigQueryData.length > 0 ? bigQueryData[0].salesforce_account_country : '',
				email: rawData.email || '',
				client_number: customer.stripe_id,
				holding_id: holdingId,
			};

			if (existingClient && existingClient.length > 0) {
				const existing = existingClient[0];
				const fieldsToCompare = ['legal_name', 'email', 'client_number', 'client_id'];

				if (this.hasChanges(clientData, existing, fieldsToCompare)) {
					this.logger.debug(`Actualizando client_entity ${existing.id}`);
					await this.customersStgRepo.query(
						`UPDATE client_entities SET legal_name = $1, email = $2, client_number = $3, client_id = $4, country = $5 WHERE id = $6`,
						[clientData.legal_name, clientData.email, clientData.client_number, clientData.client_id, clientData.country, existing.id]
					);
					return { success: true, action: 'update' };
				} else {
					return { success: true, action: 'no_change' };
				}
			} else {
				this.logger.debug(`Creando nuevo client_entity para stripe_id: ${customer.stripe_id}`);
				await this.customersStgRepo.query(
					`INSERT INTO client_entities (client_id, legal_name, tax_id, country, email, client_number, holding_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						clientData.client_id,
						clientData.legal_name,
						clientData.tax_id,
						clientData.country,
						clientData.email,
						clientData.client_number,
						clientData.holding_id,
					]
				);
				this.logger.debug(`Client_entity creado exitosamente`);
				return { success: true, action: 'create' };
			}
		} catch (error) {
			this.logger.error('Error en syncCustomerToDestination', error);
			return { success: false, error: error.message };
		}
	}

	private async updateCustomerStatus(customerId: string, status: string, integrationStatus?: string, errorMessage?: string): Promise<void> {
		const updateData: any = {
			processing_status: status,
			last_integrated_at: new Date(),
		};

		if (integrationStatus) {
			updateData.integration_notes = integrationStatus;
		}

		if (errorMessage) {
			updateData.error_message = errorMessage;
		}

		await this.customersStgRepo.update(customerId, updateData);
	}

	private async syncSubscriptions(
		holdingId: string,
		batchSize: number,
		jobId?: string,
		total?: number
	): Promise<{ subscriptions: SyncStatsDto; subscriptionItems: SyncStatsDto }> {
		const subscriptionStats = this.initStats();
		const itemStats = this.initStats();
		const chunkSize = batchSize || 200;
		let offset = 0;
		let hasMore = true;
		let totalProcessedSoFar = 0;

		this.logger.log(`🔍 Iniciando syncSubscriptions con holdingId: ${holdingId}, batchSize: ${batchSize}, total esperado: ${total}`);

		try {
			while (hasMore) {
				this.logger.debug(`🔎 Buscando suscripciones - offset: ${offset}, chunkSize: ${chunkSize}`);

				const queryBuilder = this.subscriptionsStgRepo
					.createQueryBuilder('s')
					.where('s.holding_id = :holdingId', { holdingId })
					.andWhere("s.processing_status IN ('to_create', 'to_update', 'error')")
					.andWhere("(s.integration_notes IS NULL OR s.integration_notes != 'Cliente no valido')")
					.orderBy('s.created_at', 'ASC')
					.skip(offset)
					.take(chunkSize);

				const sql = queryBuilder.getSql();
				this.logger.debug(`📝 Query SQL: ${sql}`);
				this.logger.debug(`📝 Parámetros: ${JSON.stringify(queryBuilder.getParameters())}`);

				const subscriptions = await queryBuilder.getMany();

				this.logger.log(`📊 Suscripciones encontradas en este chunk: ${subscriptions.length}`);

				if (subscriptions.length === 0) {
					this.logger.warn(`⚠️ No se encontraron suscripciones en offset ${offset}. Deteniendo sincronización.`);
					hasMore = false;
					break;
				}

				this.logger.log(`Procesando chunk de ${subscriptions.length} suscripciones (offset: ${offset})...`);

				for (const subscription of subscriptions) {
					try {
						const result = await this.syncSubscriptionToDestination(subscription, holdingId);

						if (result.success) {
							await this.updateSubscriptionStatus(subscription.id, 'processed', result.action);
							if (result.action === 'create') {
								subscriptionStats.created++;
							} else if (result.action === 'update') {
								subscriptionStats.updated++;
							} else {
								subscriptionStats.skipped++;
							}
							itemStats.created += result.itemsCreated || 0;
							itemStats.updated += result.itemsUpdated || 0;
						} else {
							await this.updateSubscriptionStatus(subscription.id, 'error', null, result.error);
							subscriptionStats.errors++;
						}

						subscriptionStats.totalProcessed++;
						totalProcessedSoFar++;
					} catch (error) {
						this.logger.error(`Error procesando suscripción ${subscription.stripe_id}`, error);
						const errorMsg = this.getDetailedErrorMessage(error);
						await this.updateSubscriptionStatus(subscription.id, 'error', null, errorMsg);
						subscriptionStats.errors++;
						subscriptionStats.totalProcessed++;
						totalProcessedSoFar++;
					}
				}

				if (jobId && total) {
					const job = await this.syncJobRepo.findOne({ where: { id: jobId } });
					if (job && job.progress) {
						await this.updateJobProgress(jobId, {
							...job.progress,
							subscriptions: {
								total,
								processed: totalProcessedSoFar,
								current: `Chunk ${Math.floor(offset / chunkSize) + 1}`,
							},
						});
					}
				}

				if (subscriptions.length < chunkSize) {
					hasMore = false;
				} else {
					offset += chunkSize;
				}
			}

			this.logger.log(`Sincronización de suscripciones completada. Total procesado: ${totalProcessedSoFar}`);
		} catch (error) {
			this.logger.error('Error en syncSubscriptions', error);
			throw error;
		}

		return { subscriptions: subscriptionStats, subscriptionItems: itemStats };
	}

	private async syncSubscriptionToDestination(
		subscription: StripeSubscriptionsStg,
		holdingId: string
	): Promise<{ success: boolean; action?: 'create' | 'update' | 'no_change'; itemsCreated?: number; itemsUpdated?: number; error?: string }> {
		try {
			const rawData = subscription.raw_data as any;

			const clientEntity = await this.customersStgRepo.query(
				`SELECT id, client_id FROM client_entities WHERE tax_id = $1 AND holding_id = $2`,
				[rawData.customer, holdingId]
			);

			if (!clientEntity || clientEntity.length === 0) {
				return { success: false, error: 'Cliente no encontrado en client_entities' };
			}

			const clientEntityId = clientEntity[0].id;
			const clientId = clientEntity[0].client_id;

			const existingSubscription = await this.customersStgRepo.query(
				`SELECT id, status, canceled_at, ended_at, monthly_amount, current_period_start, current_period_end FROM subscriptions WHERE external_id = $1 AND holding_id = $2`,
				[rawData.id, holdingId]
			);

			let monthlyAmount = 0;
			const items = rawData.items?.data || [];
			for (const item of items) {
				const quantity = item.quantity || 0;
				const unitPrice = (item.price?.unit_amount || 0) / 100;
				monthlyAmount += quantity * unitPrice;
			}

			const subscriptionData = {
				holding_id: holdingId,
				company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961',
				client_id: clientId,
				client_entity_id: clientEntityId,
				external_id: rawData.id,
				source: 'stripe',
				status: rawData.status,
				start_date: rawData.start_date ? new Date(rawData.start_date * 1000) : null,
				canceled_at: rawData.canceled_at ? new Date(rawData.canceled_at * 1000) : null,
				cancel_at_period_end: rawData.cancel_at_period_end || false,
				ended_at: rawData.ended_at ? new Date(rawData.ended_at * 1000) : null,
				current_period_start: rawData.current_period_start ? new Date(rawData.current_period_start * 1000) : null,
				current_period_end: rawData.current_period_end ? new Date(rawData.current_period_end * 1000) : null,
				billing_cycle_anchor: rawData.billing_cycle_anchor ? new Date(rawData.billing_cycle_anchor * 1000) : null,
				cancellation_reason: rawData.cancellation_details?.reason || null,
				cancellation_comment: rawData.cancellation_details?.comment || null,
				currency: rawData.currency?.toUpperCase() || 'USD',
				monthly_amount: monthlyAmount,
				collection_method: rawData.collection_method || 'charge_automatically',
				system_currency: 'USD',
				fx_to_system: 1,
				monthly_amount_system_currency: monthlyAmount,
				metadata: rawData.metadata || {},
			};

			let subscriptionId: string;
			let action: 'create' | 'update' | 'no_change';

			if (existingSubscription && existingSubscription.length > 0) {
				subscriptionId = existingSubscription[0].id;
				const existing = existingSubscription[0];
				const fieldsToCompare = ['status', 'canceled_at', 'ended_at', 'monthly_amount', 'current_period_start', 'current_period_end'];

				if (this.hasChanges(subscriptionData, existing, fieldsToCompare)) {
					await this.customersStgRepo.query(
						`UPDATE subscriptions SET status = $1, canceled_at = $2, ended_at = $3, monthly_amount = $4, current_period_start = $5, current_period_end = $6, updated_at = NOW() WHERE id = $7`,
						[
							subscriptionData.status,
							subscriptionData.canceled_at,
							subscriptionData.ended_at,
							subscriptionData.monthly_amount,
							subscriptionData.current_period_start,
							subscriptionData.current_period_end,
							subscriptionId,
						]
					);
					action = 'update';
				} else {
					action = 'no_change';
				}
			} else {
				const result = await this.customersStgRepo.query(
					`INSERT INTO subscriptions (holding_id, company_id, client_id, client_entity_id, external_id, source, status, start_date, canceled_at, cancel_at_period_end, ended_at, current_period_start, current_period_end, billing_cycle_anchor, cancellation_reason, cancellation_comment, currency, monthly_amount, collection_method, system_currency, fx_to_system, monthly_amount_system_currency, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING id`,
					[
						subscriptionData.holding_id,
						subscriptionData.company_id,
						subscriptionData.client_id,
						subscriptionData.client_entity_id,
						subscriptionData.external_id,
						subscriptionData.source,
						subscriptionData.status,
						subscriptionData.start_date,
						subscriptionData.canceled_at,
						subscriptionData.cancel_at_period_end,
						subscriptionData.ended_at,
						subscriptionData.current_period_start,
						subscriptionData.current_period_end,
						subscriptionData.billing_cycle_anchor,
						subscriptionData.cancellation_reason,
						subscriptionData.cancellation_comment,
						subscriptionData.currency,
						subscriptionData.monthly_amount,
						subscriptionData.collection_method,
						subscriptionData.system_currency,
						subscriptionData.fx_to_system,
						subscriptionData.monthly_amount_system_currency,
						JSON.stringify(subscriptionData.metadata),
					]
				);
				subscriptionId = result[0].id;
				action = 'create';
			}

			const itemsResult = await this.syncSubscriptionItems(subscriptionId, items, holdingId);

			return {
				success: true,
				action,
				itemsCreated: itemsResult.created,
				itemsUpdated: itemsResult.updated,
			};
		} catch (error) {
			this.logger.error('Error en syncSubscriptionToDestination', error);
			return { success: false, error: error.message };
		}
	}

	private async syncSubscriptionItems(subscriptionId: string, items: any[], holdingId: string): Promise<{ created: number; updated: number }> {
		let created = 0;
		let updated = 0;

		for (const item of items) {
			try {
				const existingItem = await this.customersStgRepo.query(
					`SELECT id FROM subscription_items WHERE external_id = $1 AND subscription_id = $2`,
					[item.id, subscriptionId]
				);

				const quantity = item.quantity || 0;
				const unitPrice = (item.price?.unit_amount || 0) / 100;
				const monthlyAmount = quantity * unitPrice;

				if (existingItem && existingItem.length > 0) {
					await this.customersStgRepo.query(
						`UPDATE subscription_items SET quantity = $1, unit_price = $2, monthly_amount = $3, updated_at = NOW() WHERE id = $4`,
						[quantity, unitPrice, monthlyAmount, existingItem[0].id]
					);
					updated++;
				} else {
					await this.customersStgRepo.query(
						`INSERT INTO subscription_items (subscription_id, holding_id, external_id, stripe_product_id, stripe_price_id, product_name, item_type, quantity, unit_price, monthly_amount, currency, system_currency, fx_to_system, unit_price_system_currency, monthly_amount_system_currency, billing_scheme, interval, interval_count, current_period_start, current_period_end, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
						[
							subscriptionId,
							holdingId,
							item.id,
							item.price?.product || null,
							item.price?.id || null,
							item.price?.nickname || '',
							'Digital',
							quantity,
							unitPrice,
							monthlyAmount,
							item.price?.currency?.toUpperCase() || 'USD',
							'USD',
							1,
							unitPrice,
							monthlyAmount,
							item.price?.billing_scheme || 'per_unit',
							item.price?.recurring?.interval || 'month',
							item.price?.recurring?.interval_count || 1,
							item.current_period_start ? new Date(item.current_period_start * 1000) : null,
							item.current_period_end ? new Date(item.current_period_end * 1000) : null,
							JSON.stringify(item.metadata || {}),
						]
					);
					created++;
				}
			} catch (error) {
				this.logger.error(`Error sincronizando subscription item ${item.id}`, error);
			}
		}

		return { created, updated };
	}

	private async updateSubscriptionStatus(subscriptionId: string, status: string, integrationStatus?: string, errorMessage?: string): Promise<void> {
		const updateData: any = {
			processing_status: status,
			last_integrated_at: new Date(),
		};

		if (integrationStatus) {
			updateData.integration_notes = integrationStatus;
		}

		if (errorMessage) {
			updateData.error_message = errorMessage;
		}

		await this.subscriptionsStgRepo.update(subscriptionId, updateData);
	}

	private async syncInvoices(
		holdingId: string,
		batchSize: number,
		jobId?: string,
		total?: number
	): Promise<{ invoices: SyncStatsDto; invoiceItems: SyncStatsDto }> {
		const invoiceStats = this.initStats();
		const itemStats = this.initStats();
		const chunkSize = batchSize || 200;
		let offset = 0;
		let hasMore = true;
		let totalProcessedSoFar = 0;

		try {
			while (hasMore) {
				const invoices = await this.invoicesStgRepo
					.createQueryBuilder('i')
					.where('i.holding_id = :holdingId', { holdingId })
					.andWhere("i.processing_status IN ('to_create', 'to_update', 'error')")
					.andWhere("(i.integration_notes IS NULL OR i.integration_notes != 'Cliente no valido')")
					.orderBy('i.created_at', 'ASC')
					.skip(offset)
					.take(chunkSize)
					.getMany();

				if (invoices.length === 0) {
					hasMore = false;
					break;
				}

				this.logger.log(`Procesando chunk de ${invoices.length} facturas (offset: ${offset})...`);

				for (const invoice of invoices) {
					try {
						const result = await this.syncInvoiceToDestination(invoice, holdingId);

						if (result.success) {
							await this.updateInvoiceStatus(invoice.id, 'processed', result.action);
							if (result.action === 'create') {
								invoiceStats.created++;
							} else if (result.action === 'update') {
								invoiceStats.updated++;
							} else {
								invoiceStats.skipped++;
							}
							itemStats.created += result.itemsCreated || 0;
							itemStats.updated += result.itemsUpdated || 0;
						} else {
							await this.updateInvoiceStatus(invoice.id, 'error', null, result.error);
							invoiceStats.errors++;
						}

						invoiceStats.totalProcessed++;
						totalProcessedSoFar++;
					} catch (error) {
						this.logger.error(`Error procesando factura ${invoice.stripe_id}`, error);
						const errorMsg = this.getDetailedErrorMessage(error);
						await this.updateInvoiceStatus(invoice.id, 'error', null, errorMsg);
						invoiceStats.errors++;
						invoiceStats.totalProcessed++;
						totalProcessedSoFar++;
					}
				}

				if (jobId && total) {
					const job = await this.syncJobRepo.findOne({ where: { id: jobId } });
					if (job && job.progress) {
						await this.updateJobProgress(jobId, {
							...job.progress,
							invoices: {
								total,
								processed: totalProcessedSoFar,
								current: `Chunk ${Math.floor(offset / chunkSize) + 1}`,
							},
						});
					}
				}

				if (invoices.length < chunkSize) {
					hasMore = false;
				} else {
					offset += chunkSize;
				}
			}

			this.logger.log(`Sincronización de facturas completada. Total procesado: ${totalProcessedSoFar}`);
		} catch (error) {
			this.logger.error('Error en syncInvoices', error);
			throw error;
		}

		return { invoices: invoiceStats, invoiceItems: itemStats };
	}

	private async syncInvoiceToDestination(
		invoice: StripeInvoicesStg,
		holdingId: string
	): Promise<{ success: boolean; action?: 'create' | 'update' | 'no_change'; itemsCreated?: number; itemsUpdated?: number; error?: string }> {
		try {
			const rawData = invoice.raw_data as any;

			const clientEntity = await this.customersStgRepo.query(`SELECT id FROM client_entities WHERE tax_id = $1 AND holding_id = $2`, [
				rawData.customer,
				holdingId,
			]);

			if (!clientEntity || clientEntity.length === 0) {
				return { success: false, error: 'Cliente no encontrado en client_entities' };
			}

			const clientEntityId = clientEntity[0].id;

			let subscriptionId = null;
			// Buscar subscription_id - puede estar en rawData.subscription o en rawData.parent.subscription_details.subscription
			const subscriptionExternalId = rawData.subscription || rawData.parent?.subscription_details?.subscription;

			if (subscriptionExternalId) {
				this.logger.debug(`Buscando suscripción con external_id: ${subscriptionExternalId}`);
				const subscription = await this.customersStgRepo.query(`SELECT id FROM subscriptions WHERE external_id = $1 AND holding_id = $2`, [
					subscriptionExternalId,
					holdingId,
				]);

				if (subscription && subscription.length > 0) {
					subscriptionId = subscription[0].id;
					this.logger.debug(`Suscripción encontrada: ${subscriptionId}`);
				} else {
					this.logger.warn(`No se encontró suscripción con external_id: ${subscriptionExternalId}`);
				}
			}

			const existingInvoice = await this.customersStgRepo.query(
				`SELECT id, status, total_invoice_currency, subscription_id FROM invoices WHERE invoice_number = $1 AND holding_id = $2`,
				[rawData.number, holdingId]
			);

			const amountInvoiceCurrency = (rawData.subtotal || 0) / 100;
			const vat = (rawData.total_taxes?.[0]?.amount || 0) / 100;
			const totalInvoiceCurrency = (rawData.total || 0) / 100;

			const issueDate = rawData.created ? new Date(rawData.created * 1000) : new Date();

			const invoiceData = {
				company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961',
				client_entity_id: clientEntityId,
				contract_id: null,
				subscription_id: subscriptionId,
				invoice_number: rawData.number,
				issue_date: issueDate,
				due_date: rawData.due_date ? new Date(rawData.due_date * 1000) : null,
				contract_currency: rawData.currency?.toUpperCase() || 'USD',
				amount_contract_currency: (rawData.amount_due || 0) / 100,
				invoice_currency: rawData.currency?.toUpperCase() || 'USD',
				fx_contract_to_invoice: 1,
				amount_invoice_currency: amountInvoiceCurrency,
				vat,
				tax_rate: 0,
				total_invoice_currency: totalInvoiceCurrency,
				system_currency: 'USD',
				fx_contract_to_system: 1,
				amount_system_currency: amountInvoiceCurrency,
				total_system_currency: totalInvoiceCurrency,
				status: this.mapStripeInvoiceStatus(rawData.status),
				notes: rawData.receipt_number || null,
				sent_at: rawData.webhooks_delivered_at ? new Date(rawData.webhooks_delivered_at * 1000) : null,
				scheduled_at: issueDate,
				original_issue_date: issueDate,
				invoice_type: 'Automatica',
				invoice_series: 'FAC',
				document_type: 'FACTURA',
				payment_method: 'CREDITO',
				export_type: 0,
				is_active: true,
				auto_invoice: false,
				holding_id: holdingId,
			};

			let invoiceId: string;
			let action: 'create' | 'update' | 'no_change';

			if (existingInvoice && existingInvoice.length > 0) {
				invoiceId = existingInvoice[0].id;
				const existing = existingInvoice[0];
				const fieldsToCompare = ['status', 'total_invoice_currency'];

				if (this.hasChanges(invoiceData, existing, fieldsToCompare)) {
					await this.customersStgRepo.query(
						`UPDATE invoices SET status = $1, total_invoice_currency = $2, subscription_id = $3 WHERE id = $4`,
						[invoiceData.status, invoiceData.total_invoice_currency, subscriptionId, invoiceId]
					);
					action = 'update';
				} else {
					// Aunque no haya cambios en status/total, actualizar subscription_id si es diferente
					if (subscriptionId && existing.subscription_id !== subscriptionId) {
						await this.customersStgRepo.query(`UPDATE invoices SET subscription_id = $1 WHERE id = $2`, [subscriptionId, invoiceId]);
						action = 'update';
					} else {
						action = 'no_change';
					}
				}
			} else {
				const result = await this.customersStgRepo.query(
					`INSERT INTO invoices (company_id, client_entity_id, contract_id, subscription_id, invoice_number, issue_date, due_date, contract_currency, amount_contract_currency, invoice_currency, fx_contract_to_invoice, amount_invoice_currency, vat, tax_rate, total_invoice_currency, system_currency, fx_contract_to_system, amount_system_currency, total_system_currency, status, notes, sent_at, scheduled_at, original_issue_date, invoice_type, invoice_series, document_type, payment_method, export_type, is_active, auto_invoice, holding_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32) RETURNING id`,
					[
						invoiceData.company_id,
						invoiceData.client_entity_id,
						invoiceData.contract_id,
						invoiceData.subscription_id,
						invoiceData.invoice_number,
						invoiceData.issue_date,
						invoiceData.due_date,
						invoiceData.contract_currency,
						invoiceData.amount_contract_currency,
						invoiceData.invoice_currency,
						invoiceData.fx_contract_to_invoice,
						invoiceData.amount_invoice_currency,
						invoiceData.vat,
						invoiceData.tax_rate,
						invoiceData.total_invoice_currency,
						invoiceData.system_currency,
						invoiceData.fx_contract_to_system,
						invoiceData.amount_system_currency,
						invoiceData.total_system_currency,
						invoiceData.status,
						invoiceData.notes,
						invoiceData.sent_at,
						invoiceData.scheduled_at,
						invoiceData.original_issue_date,
						invoiceData.invoice_type,
						invoiceData.invoice_series,
						invoiceData.document_type,
						invoiceData.payment_method,
						invoiceData.export_type,
						invoiceData.is_active,
						invoiceData.auto_invoice,
						invoiceData.holding_id,
					]
				);
				invoiceId = result[0].id;
				action = 'create';
			}

			const items = rawData.lines?.data || [];
			const itemsResult = await this.syncInvoiceItems(invoiceId, items, holdingId, subscriptionId);

			return {
				success: true,
				action,
				itemsCreated: itemsResult.created,
				itemsUpdated: itemsResult.updated,
			};
		} catch (error) {
			this.logger.error('Error en syncInvoiceToDestination', error);
			return { success: false, error: error.message };
		}
	}

	private async syncInvoiceItems(
		invoiceId: string,
		items: any[],
		holdingId: string,
		subscriptionId: string | null
	): Promise<{ created: number; updated: number }> {
		let created = 0;
		let updated = 0;

		for (const item of items) {
			try {
				const existingItem = await this.customersStgRepo.query(`SELECT id FROM invoice_items WHERE invoice_id = $1 AND description = $2`, [
					invoiceId,
					item.description,
				]);

				const quantity = item.quantity || 0;
				const unitPrice = (item.pricing?.unit_amount_decimal || 0) / 100;
				const subtotal = (item.amount || 0) / 100;
				const taxAmount = item.taxes?.[0]?.amount ? item.taxes[0].amount / 100 : 0;
				const total = subtotal + taxAmount;

				let subscriptionItemId = null;
				if (item.subscription_item) {
					const subItem = await this.customersStgRepo.query(`SELECT id FROM subscription_items WHERE external_id = $1`, [
						item.subscription_item,
					]);
					if (subItem && subItem.length > 0) {
						subscriptionItemId = subItem[0].id;
					}
				}

				if (existingItem && existingItem.length > 0) {
					await this.customersStgRepo.query(
						`UPDATE invoice_items SET quantity = $1, unit_price_invoice_currency = $2, total_invoice_currency = $3, subscription_item_id = $4, updated_at = NOW() WHERE id = $5`,
						[quantity, unitPrice, total, subscriptionItemId, existingItem[0].id]
					);
					updated++;
				} else {
					await this.customersStgRepo.query(
						`INSERT INTO invoice_items (invoice_id, subscription_item_id, holding_id, description, quantity, unit_of_measure, discount_pct, contract_currency, unit_price_contract_currency, subtotal_contract_currency, tax_amount_contract_currency, total_contract_currency, invoice_currency, fx_contract_to_invoice, unit_price_invoice_currency, subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency, billing_period_start, billing_period_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
						[
							invoiceId,
							subscriptionItemId,
							holdingId,
							item.description || '',
							quantity,
							'UND',
							0,
							item.currency?.toUpperCase() || 'USD',
							unitPrice,
							subtotal,
							taxAmount,
							total,
							item.currency?.toUpperCase() || 'USD',
							1,
							unitPrice,
							subtotal,
							taxAmount,
							total,
							item.period?.start ? new Date(item.period.start * 1000) : null,
							item.period?.end ? new Date(item.period.end * 1000) : null,
						]
					);
					created++;
				}
			} catch (error) {
				this.logger.error(`Error sincronizando invoice item`, error);
			}
		}

		return { created, updated };
	}

	private async updateInvoiceStatus(invoiceId: string, status: string, integrationStatus?: string, errorMessage?: string): Promise<void> {
		const updateData: any = {
			processing_status: status,
			last_integrated_at: new Date(),
		};

		if (integrationStatus) {
			updateData.integration_notes = integrationStatus;
		}

		if (errorMessage) {
			updateData.error_message = errorMessage;
		}

		await this.invoicesStgRepo.update(invoiceId, updateData);
	}

	private mapStripeInvoiceStatus(stripeStatus: string): string {
		const statusMap: Record<string, string> = {
			paid: 'Pagada',
			open: 'Por Emitir',
			draft: 'Por Emitir',
			void: 'Cancelada',
			uncollectible: 'Vencida',
		};
		return statusMap[stripeStatus] || 'Por Emitir';
	}

	private getDetailedErrorMessage(error: any): string {
		if (error.code) {
			switch (error.code) {
				case '23505':
					return `Registro duplicado: ${error.detail || error.message}`;
				case '23503':
					return `Referencia inválida (foreign key): ${error.detail || error.message}`;
				case '23502':
					return `Campo requerido faltante: ${error.detail || error.message}`;
				case '22P02':
					return `Formato de dato inválido: ${error.detail || error.message}`;
				default:
					return `Error de base de datos (${error.code}): ${error.message}`;
			}
		}
		return error.message || 'Error desconocido';
	}

	private hasChanges(newData: any, existingData: any, fieldsToCompare: string[]): boolean {
		for (const field of fieldsToCompare) {
			const newValue = newData[field];
			const existingValue = existingData[field];

			if (newValue instanceof Date && existingValue instanceof Date) {
				if (newValue.getTime() !== existingValue.getTime()) {
					return true;
				}
			} else if (newValue !== existingValue) {
				return true;
			}
		}
		return false;
	}

	private initStats(): SyncStatsDto {
		return {
			totalProcessed: 0,
			created: 0,
			updated: 0,
			errors: 0,
			invalid: 0,
			skipped: 0,
		};
	}
}
