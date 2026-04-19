import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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
		this.logger.log('\n┌─────────────────────────────────────────────────────────────┐');
		this.logger.log('│  STRIPE SYNC SERVICE - syncAll()                           │');
		this.logger.log('└─────────────────────────────────────────────────────────────┘');
		this.logger.log(`📝 Creando job de sincronización...`);
		this.logger.log(`   - Holding ID: ${holdingId}`);
		this.logger.log(`   - Batch Size: ${batchSize}`);

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

		this.logger.log(`✅ Job creado con ID: ${job.id}`);
		this.logger.log(`🚀 Iniciando ejecución asíncrona del job...\n`);

		this.executeSyncJob(job.id, holdingId, batchSize).catch((error) => {
			this.logger.error(`❌ Error en job ${job.id}:`, error);
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
		const startTime = Date.now();
		this.logger.log('\n╔═════════════════════════════════════════════════════════════╗');
		this.logger.log('║  EJECUTANDO JOB DE SINCRONIZACIÓN                           ║');
		this.logger.log('╚═════════════════════════════════════════════════════════════╝');
		this.logger.log(`🆔 Job ID: ${jobId}`);
		this.logger.log(`🏢 Holding ID: ${holdingId}`);
		this.logger.log(`📦 Batch Size: ${batchSize}`);
		this.logger.log(`⏰ Inicio: ${new Date().toISOString()}\n`);

		const stats: EntitySyncStatsDto = {
			customers: this.initStats(),
			subscriptions: this.initStats(),
			subscriptionItems: this.initStats(),
			invoices: this.initStats(),
			invoiceItems: this.initStats(),
		};

		const errors: string[] = [];

		try {
			this.logger.log('\n┌─────────────────────────────────────────────────────────────┐');
			this.logger.log('│  FASE 0: VALIDACIÓN DE CLIENTES CONTRA BIGQUERY            │');
			this.logger.log('└─────────────────────────────────────────────────────────────┘');
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
				} else {
					// Si el cliente es válido pero tiene integration_notes de inválido anterior, limpiarlas
					if (customer.integration_notes === 'Cliente no valido') {
						await this.customersStgRepo.update(customer.id, {
							integration_notes: null,
						});
						this.logger.debug(`Cliente ${customer.stripe_id} ahora es válido - limpiando integration_notes`);
					}
				}
			}

			this.logger.log(`\n✅ Validación completada:`);
			this.logger.log(`   - Total validados: ${customersToValidate.length}`);
			this.logger.log(`   - Marcados como inválidos: ${invalidCount}`);
			this.logger.log(`   - Válidos: ${customersToValidate.length - invalidCount}\n`);

			this.logger.log('┌─────────────────────────────────────────────────────────────┐');
			this.logger.log('│  CONTANDO REGISTROS PARA SINCRONIZAR                       │');
			this.logger.log('└─────────────────────────────────────────────────────────────┘');

			// Contar clientes a sincronizar (Fase 0 ya limpió integration_notes de clientes válidos)
			const customerCount = await this.customersStgRepo
				.createQueryBuilder('c')
				.where('c.holding_id = :holdingId', { holdingId })
				.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
				.getCount();
			this.logger.log(`📊 Clientes a sincronizar: ${customerCount}`);

			const subscriptionCount = await this.subscriptionsStgRepo
				.createQueryBuilder('s')
				.where('s.holding_id = :holdingId', { holdingId })
				.andWhere("s.processing_status IN ('to_create', 'to_update', 'error')")
				.getCount();
			this.logger.log(`📊 Suscripciones a sincronizar: ${subscriptionCount}`);

			const invoiceCount = await this.invoicesStgRepo
				.createQueryBuilder('i')
				.where('i.holding_id = :holdingId', { holdingId })
				.andWhere("i.processing_status IN ('to_create', 'to_update', 'error')")
				.getCount();
			this.logger.log(`📊 Facturas a sincronizar: ${invoiceCount}`);

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: 0 },
				subscriptions: { total: subscriptionCount, processed: 0 },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'customers',
				overallProgress: 0,
			});

			this.logger.log('\n╔═════════════════════════════════════════════════════════════╗');
			this.logger.log('║  FASE 1: SINCRONIZACIÓN DE CLIENTES                        ║');
			this.logger.log('╚═════════════════════════════════════════════════════════════╝');
			this.logger.log(`📊 Total a sincronizar: ${customerCount}`);
			const customersStartTime = Date.now();
			stats.customers = await this.syncCustomers(holdingId, batchSize, jobId, customerCount);
			const customersEndTime = Date.now();
			this.logger.log(`\n✅ Fase 1 completada en ${((customersEndTime - customersStartTime) / 1000).toFixed(2)}s`);
			this.logger.log(`   - Creados: ${stats.customers.created}`);
			this.logger.log(`   - Actualizados: ${stats.customers.updated}`);
			this.logger.log(`   - Omitidos: ${stats.customers.skipped}`);
			this.logger.log(`   - Errores: ${stats.customers.errors}`);

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: 0 },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'subscriptions',
				overallProgress: 33,
			});

			this.logger.log('\n╔═════════════════════════════════════════════════════════════╗');
			this.logger.log('║  FASE 2: SINCRONIZACIÓN DE SUSCRIPCIONES                   ║');
			this.logger.log('╚═════════════════════════════════════════════════════════════╝');
			this.logger.log(`📊 Total a sincronizar: ${subscriptionCount}`);
			const subscriptionsStartTime = Date.now();
			const subscriptionResult = await this.syncSubscriptions(holdingId, batchSize, jobId, subscriptionCount);
			const subscriptionsEndTime = Date.now();
			this.logger.log(`\n✅ Fase 2 completada en ${((subscriptionsEndTime - subscriptionsStartTime) / 1000).toFixed(2)}s`);
			stats.subscriptions = subscriptionResult.subscriptions;
			stats.subscriptionItems = subscriptionResult.subscriptionItems;

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: subscriptionCount },
				invoices: { total: invoiceCount, processed: 0 },
				currentPhase: 'invoices',
				overallProgress: 66,
			});

			this.logger.log('\n╔═════════════════════════════════════════════════════════════╗');
			this.logger.log('║  FASE 3: SINCRONIZACIÓN DE FACTURAS                        ║');
			this.logger.log('╚═════════════════════════════════════════════════════════════╝');
			this.logger.log(`📊 Total a sincronizar: ${invoiceCount}`);
			const invoicesStartTime = Date.now();
			const invoiceResult = await this.syncInvoices(holdingId, batchSize, jobId, invoiceCount);
			const invoicesEndTime = Date.now();
			this.logger.log(`\n✅ Fase 3 completada en ${((invoicesEndTime - invoicesStartTime) / 1000).toFixed(2)}s`);
			stats.invoices = invoiceResult.invoices;
			stats.invoiceItems = invoiceResult.invoiceItems;

			await this.updateJobProgress(jobId, {
				customers: { total: customerCount, processed: customerCount },
				subscriptions: { total: subscriptionCount, processed: subscriptionCount },
				invoices: { total: invoiceCount, processed: invoiceCount },
				currentPhase: 'completed',
				overallProgress: 100,
			});

			const endTime = Date.now();
			const totalTime = ((endTime - startTime) / 1000).toFixed(2);

			this.logger.log('\n╔═════════════════════════════════════════════════════════════╗');
			this.logger.log('║  ✅ SINCRONIZACIÓN COMPLETADA EXITOSAMENTE                 ║');
			this.logger.log('╚═════════════════════════════════════════════════════════════╝');
			this.logger.log(`⏱️  Tiempo total: ${totalTime}s`);
			this.logger.log(`📊 Resumen de estadísticas:`);
			this.logger.log(
				`   Clientes: ${stats.customers.created} creados, ${stats.customers.updated} actualizados, ${stats.customers.errors} errores`
			);
			this.logger.log(`   Suscripciones: ${stats.subscriptions.created} creadas, ${stats.subscriptions.updated} actualizadas`);
			this.logger.log(`   Facturas: ${stats.invoices.created} creadas, ${stats.invoices.updated} actualizadas`);
			this.logger.log(`🏁 Finalizando job ${jobId}\n`);

			await this.syncJobRepo.update(jobId, {
				status: 'completed',
				stats: stats as any,
				errors: errors.length > 0 ? errors : null,
				completed_at: new Date(),
			});
		} catch (error) {
			const endTime = Date.now();
			const totalTime = ((endTime - startTime) / 1000).toFixed(2);

			this.logger.error('\n╔═════════════════════════════════════════════════════════════╗');
			this.logger.error('║  ❌ ERROR DURANTE LA SINCRONIZACIÓN                        ║');
			this.logger.error('╚═════════════════════════════════════════════════════════════╝');
			this.logger.error(`⏱️  Tiempo hasta el error: ${totalTime}s`);
			this.logger.error(`❌ Error: ${error.message}`);
			this.logger.error(`📍 Stack trace:`, error.stack);
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
		let hasMore = true;
		let totalProcessedSoFar = 0;

		this.logger.log(`🔍 Iniciando syncCustomers con holdingId: ${holdingId}, batchSize: ${batchSize}, total esperado: ${total}`);

		try {
			while (hasMore) {
				this.logger.debug(
					`🔎 Buscando clientes - chunkSize: ${chunkSize} (siempre desde el inicio porque los procesados salen de la consulta)`
				);

				const queryBuilder = this.customersStgRepo
					.createQueryBuilder('c')
					.where('c.holding_id = :holdingId', { holdingId })
					.andWhere("c.processing_status IN ('to_create', 'to_update', 'error')")
					.orderBy('c.created_at', 'ASC')
					.take(chunkSize);

				const sql = queryBuilder.getSql();
				this.logger.debug(`📝 Query SQL: ${sql}`);
				this.logger.debug(`📝 Parámetros: ${JSON.stringify(queryBuilder.getParameters())}`);

				const customers = await queryBuilder.getMany();

				this.logger.log(`📊 Clientes encontrados en este chunk: ${customers.length}`);

				if (customers.length === 0) {
					this.logger.warn(`⚠️ No se encontraron más clientes para procesar. Deteniendo sincronización.`);
					hasMore = false;
					break;
				}

				this.logger.log(`✅ Procesando chunk de ${customers.length} clientes...`);

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
							},
						});
					}
				}

				if (customers.length < chunkSize) {
					hasMore = false;
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
			this.logger.debug(`\n  ┌─── Procesando cliente: ${customer.stripe_id}`);
			const rawData = customer.raw_data as any;

			// PASO 1: Obtener datos de stripe_customers_bigquery
			this.logger.debug(`  │ PASO 1: Consultando BigQuery...`);
			const bigQueryData = await this.customersStgRepo.query(
				`SELECT salesforce_account_id, client_name, salesforce_account_segment, salesforce_account_industry, salesforce_account_country 
				 FROM stripe_customers_bigquery 
				 WHERE stripe_customer_id = $1 AND holding_id = $2`,
				[customer.stripe_id, holdingId]
			);

			if (!bigQueryData || bigQueryData.length === 0) {
				this.logger.error(`  │ ❌ Cliente ${customer.stripe_id} no encontrado en BigQuery`);
				this.logger.debug(`  └─── ERROR\n`);
				return { success: false, error: 'Cliente no encontrado en BigQuery' };
			}

			const bqData = bigQueryData[0];
			const salesforceAccountId = bqData.salesforce_account_id;
			this.logger.debug(`  │ ✅ BigQuery: salesforce_account_id = ${salesforceAccountId || 'NULL'}`);

			if (!salesforceAccountId || salesforceAccountId === '') {
				this.logger.debug(`  │ ⚠️  Sin salesforce_account_id - creará client_entity sin relación`);
			}

			// PASO 2: Buscar client_id en tabla clients usando salesforce_account_id
			this.logger.debug(`  │ PASO 2: Buscando client por salesforce_account_id...`);
			const clientRecord = await this.customersStgRepo.query(`SELECT id FROM clients WHERE salesforce_account_id = $1 AND holding_id = $2`, [
				salesforceAccountId,
				holdingId,
			]);

			let clientId: string | null = null;
			if (!clientRecord || clientRecord.length === 0) {
				this.logger.debug(`  │ ⚠️  Client NO encontrado - client_entity quedará sin relación`);
			} else {
				clientId = clientRecord[0].id;
				this.logger.debug(`  │ ✅ Client encontrado: ${clientId}`);
			}

			// PASO 3: Buscar o crear client_entity
			this.logger.debug(`  │ PASO 3: Buscando client_entity existente...`);
			const existingClientEntity = await this.customersStgRepo.query(
				`SELECT id, legal_name, email, client_number, client_id FROM client_entities WHERE tax_id = $1 AND holding_id = $2`,
				[customer.stripe_id, holdingId]
			);

			const clientEntityData = {
				client_id: clientId,
				legal_name: rawData.email || bqData.client_name || '',
				tax_id: customer.stripe_id,
				country: bqData.salesforce_account_country || '',
				email: rawData.email || '',
				client_number: customer.stripe_id,
				holding_id: holdingId,
			};

			let clientEntityId: string;
			let action: 'create' | 'update' | 'no_change' = 'no_change';

			if (existingClientEntity && existingClientEntity.length > 0) {
				const existing = existingClientEntity[0];
				clientEntityId = existing.id;
				const fieldsToCompare = ['legal_name', 'email', 'client_number', 'client_id'];

				if (this.hasChanges(clientEntityData, existing, fieldsToCompare)) {
					this.logger.debug(`  │ 🔄 Actualizando client_entity ${clientEntityId}`);
					await this.customersStgRepo.query(
						`UPDATE client_entities SET legal_name = $1, email = $2, client_number = $3, client_id = $4, country = $5 WHERE id = $6`,
						[
							clientEntityData.legal_name,
							clientEntityData.email,
							clientEntityData.client_number,
							clientEntityData.client_id,
							clientEntityData.country,
							clientEntityId,
						]
					);
					action = 'update';
				} else {
					this.logger.debug(`  │ ℹ️  Sin cambios en client_entity`);
				}
			} else {
				this.logger.debug(`  │ ➕ Creando nuevo client_entity`);
				const result = await this.customersStgRepo.query(
					`INSERT INTO client_entities (client_id, legal_name, tax_id, country, email, client_number, holding_id) 
					 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
					[
						clientEntityData.client_id,
						clientEntityData.legal_name,
						clientEntityData.tax_id,
						clientEntityData.country,
						clientEntityData.email,
						clientEntityData.client_number,
						clientEntityData.holding_id,
					]
				);
				clientEntityId = result[0].id;
				this.logger.debug(`  │ ✅ Client_entity creado: ${clientEntityId}`);
				action = 'create';
			}

			// PASO 4: Crear o actualizar relación en client_entity_clients
			this.logger.debug(`  │ PASO 4: Gestionando relación client_entity_clients...`);
			if (clientId) {
				await this.syncClientEntityRelation(clientEntityId, clientId, holdingId);
				this.logger.debug(`  │ ✅ Relación creada/verificada`);
			} else {
				this.logger.debug(`  │ ⏭️  Sin client_id - omitiendo relación`);
			}

			this.logger.debug(`  └─── ✅ Completado: action=${action}\n`);
			return { success: true, action };
		} catch (error) {
			this.logger.error(`  └─── ❌ ERROR: ${error.message}\n`);
			return { success: false, error: error.message };
		}
	}

	private async syncClientEntityRelation(clientEntityId: string, clientId: string, holdingId: string): Promise<void> {
		try {
			// Buscar si ya existe la relación
			const existingRelation = await this.customersStgRepo.query(
				`SELECT id FROM client_entity_clients WHERE client_entity_id = $1 AND client_id = $2`,
				[clientEntityId, clientId]
			);

			if (existingRelation && existingRelation.length > 0) {
				this.logger.debug(`Relación client_entity_clients ya existe para client_entity_id: ${clientEntityId}, client_id: ${clientId}`);
				return;
			}

			// Crear nueva relación
			this.logger.debug(`Creando relación en client_entity_clients: client_entity_id=${clientEntityId}, client_id=${clientId}`);
			await this.customersStgRepo.query(
				`INSERT INTO client_entity_clients (client_entity_id, client_id, holding_id, is_primary) 
				 VALUES ($1, $2, $3, $4)`,
				[clientEntityId, clientId, holdingId, true]
			);
			this.logger.debug(`Relación client_entity_clients creada exitosamente`);
		} catch (error) {
			// Si el error es por constraint de unique, no es un error crítico
			if (error.code === '23505') {
				this.logger.debug(`Relación client_entity_clients ya existe (unique constraint)`);
			} else {
				this.logger.error(`Error creando relación client_entity_clients`, error);
				throw error;
			}
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
		let hasMore = true;
		let totalProcessedSoFar = 0;

		this.logger.log(`🔍 Iniciando syncSubscriptions con holdingId: ${holdingId}, batchSize: ${batchSize}, total esperado: ${total}`);

		try {
			while (hasMore) {
				this.logger.debug(`🔎 Buscando suscripciones - chunkSize: ${chunkSize} (siempre desde el inicio)`);

				const queryBuilder = this.subscriptionsStgRepo
					.createQueryBuilder('s')
					.where('s.holding_id = :holdingId', { holdingId })
					.andWhere("s.processing_status IN ('to_create', 'to_update', 'error')")
					.andWhere("(s.integration_notes IS NULL OR s.integration_notes != 'Cliente no valido')")
					.orderBy('s.created_at', 'ASC')
					.take(chunkSize);

				const sql = queryBuilder.getSql();
				this.logger.debug(`📝 Query SQL: ${sql}`);
				this.logger.debug(`📝 Parámetros: ${JSON.stringify(queryBuilder.getParameters())}`);

				const subscriptions = await queryBuilder.getMany();

				this.logger.log(`📊 Suscripciones encontradas en este chunk: ${subscriptions.length}`);

				if (subscriptions.length === 0) {
					this.logger.warn(`⚠️ No se encontraron más suscripciones para procesar. Deteniendo sincronización.`);
					hasMore = false;
					break;
				}

				this.logger.log(`Procesando chunk de ${subscriptions.length} suscripciones...`);

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
							},
						});
					}
				}

				if (subscriptions.length < chunkSize) {
					hasMore = false;
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

			const clientData = await this.customersStgRepo.query(`SELECT name_commercial FROM clients WHERE id = $1`, [clientId]);

			const clientEntityData = await this.customersStgRepo.query(`SELECT legal_name FROM client_entities WHERE id = $1`, [clientEntityId]);

			const clientNameCommercial = clientData && clientData.length > 0 ? clientData[0].name_commercial : null;
			const legalClientName = clientEntityData && clientEntityData.length > 0 ? clientEntityData[0].legal_name : null;

			const existingSubscription = await this.customersStgRepo.query(
				`SELECT id, status, canceled_at, ended_at, monthly_amount FROM subscriptions WHERE external_id = $1 AND holding_id = $2`,
				[rawData.id, holdingId]
			);

			let monthlyAmount = 0;
			const items = rawData.items?.data || [];
			for (const item of items) {
				const quantity = item.quantity || 0;
				const unitPrice = (item.price?.unit_amount || 0) / 100;
				monthlyAmount += quantity * unitPrice;
			}

			const firstItem = items[0];
			const currentPeriodStart = firstItem?.current_period_start ? new Date(firstItem.current_period_start * 1000) : null;
			const currentPeriodEnd = firstItem?.current_period_end ? new Date(firstItem.current_period_end * 1000) : null;

			const subscriptionData = {
				holding_id: holdingId,
				company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961',
				client_id: clientId,
				client_entity_id: clientEntityId,
				client_name_commercial: clientNameCommercial,
				legal_client_name: legalClientName,
				external_id: rawData.id,
				source: 'stripe',
				status: rawData.status,
				start_date: rawData.start_date ? new Date(rawData.start_date * 1000) : null,
				canceled_at: rawData.canceled_at ? new Date(rawData.canceled_at * 1000) : null,
				cancel_at_period_end: rawData.cancel_at_period_end || false,
				ended_at: rawData.ended_at ? new Date(rawData.ended_at * 1000) : null,
				current_period_start: currentPeriodStart,
				current_period_end: currentPeriodEnd,
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
						`UPDATE subscriptions SET status = $1, canceled_at = $2, ended_at = $3, monthly_amount = $4, current_period_start = $5, current_period_end = $6, last_synced_at = NOW(), updated_at = NOW() WHERE id = $7`,
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
					await this.customersStgRepo.query(`UPDATE subscriptions SET last_synced_at = NOW() WHERE id = $1`, [subscriptionId]);
					action = 'no_change';
				}
			} else {
				const result = await this.customersStgRepo.query(
					`INSERT INTO subscriptions (holding_id, company_id, client_id, client_entity_id, client_name_commercial, legal_client_name, external_id, source, status, start_date, canceled_at, cancel_at_period_end, ended_at, current_period_start, current_period_end, billing_cycle_anchor, cancellation_reason, cancellation_comment, currency, monthly_amount, collection_method, system_currency, fx_to_system, monthly_amount_system_currency, metadata, last_synced_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, NOW()) RETURNING id`,
					[
						subscriptionData.holding_id,
						subscriptionData.company_id,
						subscriptionData.client_id,
						subscriptionData.client_entity_id,
						subscriptionData.client_name_commercial,
						subscriptionData.legal_client_name,
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

				const stripeProductId = item.price?.product || null;
				let productId = null;
				let productName = '';

				if (stripeProductId) {
					const productMapping = await this.customersStgRepo.query(
						`SELECT sapira_product_id FROM stripe_product_mappings WHERE stripe_product_id = $1 AND holding_id = $2 LIMIT 1`,
						[stripeProductId, holdingId]
					);

					if (productMapping && productMapping.length > 0) {
						productId = productMapping[0].sapira_product_id;
						this.logger.debug(`Producto mapeado encontrado: ${stripeProductId} -> ${productId}`);

						const productData = await this.customersStgRepo.query(`SELECT name FROM products WHERE id = $1`, [productId]);

						if (productData && productData.length > 0) {
							productName = productData[0].name;
							this.logger.debug(`Nombre de producto obtenido: ${productName}`);
						}
					} else {
						this.logger.warn(`Producto sin mapear: ${stripeProductId} en subscription_item ${item.id}`);
					}
				}

				if (existingItem && existingItem.length > 0) {
					await this.customersStgRepo.query(
						`UPDATE subscription_items SET quantity = $1, unit_price = $2, monthly_amount = $3, product_id = $4, product_name = $5, updated_at = NOW() WHERE id = $6`,
						[quantity, unitPrice, monthlyAmount, productId, productName, existingItem[0].id]
					);
					updated++;
				} else {
					await this.customersStgRepo.query(
						`INSERT INTO subscription_items (subscription_id, holding_id, external_id, stripe_product_id, stripe_price_id, product_id, product_name, item_type, quantity, unit_price, monthly_amount, currency, system_currency, fx_to_system, unit_price_system_currency, monthly_amount_system_currency, billing_scheme, interval, interval_count, current_period_start, current_period_end, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
						[
							subscriptionId,
							holdingId,
							item.id,
							stripeProductId,
							item.price?.id || null,
							productId,
							productName,
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
					.take(chunkSize)
					.getMany();

				if (invoices.length === 0) {
					hasMore = false;
					break;
				}

				this.logger.log(`Procesando chunk de ${invoices.length} facturas...`);

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
							},
						});
					}
				}

				if (invoices.length < chunkSize) {
					hasMore = false;
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
			let clientId = null;

			// Buscar subscription_id - puede estar en rawData.subscription o en rawData.parent.subscription_details.subscription
			const subscriptionExternalId = rawData.subscription || rawData.parent?.subscription_details?.subscription;

			if (subscriptionExternalId) {
				this.logger.debug(`Buscando suscripción con external_id: ${subscriptionExternalId}`);
				const subscription = await this.customersStgRepo.query(
					`SELECT id, client_id FROM subscriptions WHERE external_id = $1 AND holding_id = $2`,
					[subscriptionExternalId, holdingId]
				);

				if (subscription && subscription.length > 0) {
					subscriptionId = subscription[0].id;
					clientId = subscription[0].client_id;
					this.logger.debug(`Suscripción encontrada: ${subscriptionId}, client_id: ${clientId}`);
				} else {
					this.logger.warn(`No se encontró suscripción con external_id: ${subscriptionExternalId}`);
				}
			}

			// Si no se encontró client_id desde subscription, obtenerlo desde client_entities
			if (!clientId) {
				const clientEntityData = await this.customersStgRepo.query(`SELECT client_id FROM client_entities WHERE id = $1`, [clientEntityId]);

				if (clientEntityData && clientEntityData.length > 0) {
					clientId = clientEntityData[0].client_id;
					this.logger.debug(`client_id obtenido desde client_entities: ${clientId}`);
				}
			}

			// Primero buscar por stripe_id (más confiable)
			let existingInvoice = await this.customersStgRepo.query(
				`SELECT id, status, total_invoice_currency, subscription_id FROM invoices WHERE stripe_id = $1 AND holding_id = $2`,
				[invoice.stripe_id, holdingId]
			);

			// Fallback: buscar por invoice_number si no tiene stripe_id
			if ((!existingInvoice || existingInvoice.length === 0) && rawData.number) {
				existingInvoice = await this.customersStgRepo.query(
					`SELECT id, status, total_invoice_currency, subscription_id FROM invoices WHERE invoice_number = $1 AND holding_id = $2`,
					[rawData.number, holdingId]
				);
			}

			const amountInvoiceCurrency = (rawData.subtotal || 0) / 100;
			const vat = (rawData.total_taxes?.[0]?.amount || 0) / 100;
			const totalInvoiceCurrency = (rawData.total || 0) / 100;

			const issueDate = rawData.created ? new Date(rawData.created * 1000) : new Date();

			const invoiceData = {
				company_id: '373c1b3b-5f91-4a4d-a28a-a146d0af6961',
				client_id: clientId,
				client_entity_id: clientEntityId,
				contract_id: null,
				subscription_id: subscriptionId,
				invoice_number: rawData.number,
				stripe_id: invoice.stripe_id,
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
				invoice_type: 'Suscripción',
				invoice_series: 'FAC',
				document_type: 'Invoice',
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
						`UPDATE invoices SET status = $1, total_invoice_currency = $2, subscription_id = $3, invoice_type = $4, document_type = $5, stripe_id = $6 WHERE id = $7`,
						[
							invoiceData.status,
							invoiceData.total_invoice_currency,
							subscriptionId,
							invoiceData.invoice_type,
							invoiceData.document_type,
							invoiceData.stripe_id,
							invoiceId,
						]
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
					`INSERT INTO invoices (company_id, client_id, client_entity_id, contract_id, subscription_id, invoice_number, stripe_id, issue_date, due_date, contract_currency, amount_contract_currency, invoice_currency, fx_contract_to_invoice, amount_invoice_currency, vat, tax_rate, total_invoice_currency, system_currency, fx_contract_to_system, amount_system_currency, total_system_currency, status, notes, sent_at, scheduled_at, original_issue_date, invoice_type, invoice_series, document_type, payment_method, export_type, is_active, auto_invoice, holding_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34) RETURNING id`,
					[
						invoiceData.company_id,
						invoiceData.client_id,
						invoiceData.client_entity_id,
						invoiceData.contract_id,
						invoiceData.subscription_id,
						invoiceData.invoice_number,
						invoiceData.stripe_id,
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
			const itemsResult = await this.syncInvoiceItems(invoiceId, items, holdingId);

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

	private async syncInvoiceItems(invoiceId: string, items: any[], holdingId: string): Promise<{ created: number; updated: number }> {
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

				const stripeProductId = item.pricing?.price_details?.product || null;
				let productId = null;

				if (stripeProductId) {
					const productMapping = await this.customersStgRepo.query(
						`SELECT sapira_product_id FROM stripe_product_mappings WHERE stripe_product_id = $1 AND holding_id = $2 LIMIT 1`,
						[stripeProductId, holdingId]
					);

					if (productMapping && productMapping.length > 0) {
						productId = productMapping[0].sapira_product_id;
						this.logger.debug(`Producto mapeado encontrado: ${stripeProductId} -> ${productId}`);
					} else {
						this.logger.warn(`Producto sin mapear: ${stripeProductId} en invoice_item para factura ${invoiceId}`);
					}
				}

				if (existingItem && existingItem.length > 0) {
					await this.customersStgRepo.query(
						`UPDATE invoice_items SET quantity = $1, unit_price_invoice_currency = $2, total_invoice_currency = $3, subscription_item_id = $4, product_id = $5, updated_at = NOW() WHERE id = $6`,
						[quantity, unitPrice, total, subscriptionItemId, productId, existingItem[0].id]
					);
					updated++;
				} else {
					await this.customersStgRepo.query(
						`INSERT INTO invoice_items (invoice_id, subscription_item_id, product_id, holding_id, description, quantity, unit_of_measure, discount_pct, contract_currency, unit_price_contract_currency, subtotal_contract_currency, tax_amount_contract_currency, total_contract_currency, invoice_currency, fx_contract_to_invoice, unit_price_invoice_currency, subtotal_invoice_currency, tax_amount_invoice_currency, total_invoice_currency, billing_period_start, billing_period_end) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
						[
							invoiceId,
							subscriptionItemId,
							productId,
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
			open: 'Emitida',
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
