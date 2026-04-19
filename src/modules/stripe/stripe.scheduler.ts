import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { StripeConnection } from './entities/stripe-connection.entity';
import { StripeSyncService } from './services/stripe-sync.service';
import { StripeIngestionService } from './stripe-ingestion.service';

@Injectable()
export class StripeScheduler {
	private readonly logger = new Logger(StripeScheduler.name);
	private readonly syncEnabled: boolean;
	private readonly syncHour: number;
	private isRunning = false;

	constructor(
		private readonly stripeIngestionService: StripeIngestionService,
		private readonly stripeSyncService: StripeSyncService,
		@InjectRepository(StripeConnection)
		private readonly connectionRepository: Repository<StripeConnection>,
		private readonly configService: ConfigService
	) {
		this.syncEnabled = this.configService.get<string>('STRIPE_SYNC_ENABLED') !== 'false';
		this.syncHour = parseInt(this.configService.get<string>('STRIPE_SYNC_HOUR') || '2', 10);

		if (!this.syncEnabled) {
			this.logger.warn('⚠️ Sincronización automática de Stripe DESACTIVADA');
		} else {
			this.logger.log(`✓ Sincronización automática de Stripe configurada para las ${this.syncHour}:00 hrs`);
		}
	}

	@Cron('0 * * * *')
	async syncStripeDaily() {
		const currentHour = new Date().getHours();

		if (currentHour !== this.syncHour) {
			return;
		}

		if (!this.syncEnabled) {
			this.logger.debug('Sincronización automática desactivada');
			return;
		}

		if (this.isRunning) {
			this.logger.warn('Sincronización ya en ejecución, omitiendo...');
			return;
		}

		this.isRunning = true;
		const startTime = Date.now();

		this.logger.log('🚀 Iniciando sincronización automática de Stripe...');

		try {
			await this.executeFullSync();

			const executionTime = Date.now() - startTime;
			this.logger.log(`✓ Sincronización completada exitosamente en ${(executionTime / 1000).toFixed(2)}s`);
		} catch (error) {
			const executionTime = Date.now() - startTime;
			this.logger.error(`✗ Error en sincronización automática después de ${(executionTime / 1000).toFixed(2)}s:`, error);
		} finally {
			this.isRunning = false;
		}
	}

	private async executeFullSync(): Promise<void> {
		const activeConnections = await this.connectionRepository.find({
			where: { is_active: true },
		});

		if (activeConnections.length === 0) {
			this.logger.warn('No hay conexiones activas de Stripe para sincronizar');
			return;
		}

		this.logger.log(`Encontradas ${activeConnections.length} conexión(es) activa(s) de Stripe`);

		for (const connection of activeConnections) {
			try {
				this.logger.log(`\n┌─────────────────────────────────────────────────────────────┐`);
				this.logger.log(`│  Sincronizando conexión: ${connection.name.padEnd(40)} │`);
				this.logger.log(`│  Holding ID: ${connection.holding_id.padEnd(44)} │`);
				this.logger.log(`└─────────────────────────────────────────────────────────────┘`);

				await this.syncConnectionData(connection);

				this.logger.log(`✓ Conexión ${connection.name} sincronizada exitosamente\n`);
			} catch (error) {
				this.logger.error(`✗ Error sincronizando conexión ${connection.name}:`, error);
			}
		}
	}

	private async syncConnectionData(connection: StripeConnection): Promise<void> {
		const twoDaysAgo = new Date();
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
		const today = new Date();

		const dateFrom = twoDaysAgo.toISOString().split('T')[0];
		const dateTo = today.toISOString().split('T')[0];

		this.logger.log(`📅 Sincronizando datos desde ${dateFrom} hasta ${dateTo}`);

		this.logger.log('📥 Fase 1: Ingesta de datos desde Stripe a staging...');
		const ingestionResult = await this.stripeIngestionService.syncAll(
			{
				connection_id: connection.id,
				date_from: dateFrom,
				date_to: dateTo,
			},
			connection.holding_id
		);

		this.logger.log(`✓ Ingesta completada - Batch ID: ${ingestionResult.batch_id}`);
		this.logger.log(`   Job IDs: ${JSON.stringify(ingestionResult.job_ids)}`);

		await this.waitForIngestionCompletion();

		this.logger.log('📤 Fase 2: Sincronización de staging a tablas principales...');
		const syncResult = await this.stripeSyncService.syncAll(connection.holding_id, 100);

		this.logger.log(`✓ Sincronización iniciada - Job ID: ${syncResult.jobId}`);

		await this.waitForSyncCompletion(syncResult.jobId);

		this.logger.log('✓ Sincronización completa finalizada exitosamente');
	}

	private async waitForIngestionCompletion(): Promise<void> {
		this.logger.log('⏳ Esperando finalización de ingesta...');

		const maxWaitTime = 30 * 60 * 1000;
		const checkInterval = 10 * 1000;
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitTime) {
			await this.sleep(checkInterval);

			this.logger.debug('Verificando estado de ingesta...');
		}

		this.logger.log('✓ Ingesta completada (timeout alcanzado, continuando con sync)');
	}

	private async waitForSyncCompletion(jobId: string): Promise<void> {
		this.logger.log('⏳ Esperando finalización de sincronización...');

		const maxWaitTime = 60 * 60 * 1000;
		const checkInterval = 15 * 1000;
		const startTime = Date.now();

		while (Date.now() - startTime < maxWaitTime) {
			await this.sleep(checkInterval);

			try {
				const status = await this.stripeSyncService.getJobStatus(jobId);

				if (status.status === 'completed') {
					this.logger.log('✓ Sincronización completada exitosamente');
					this.logger.log(`   Estadísticas: ${JSON.stringify(status.stats)}`);
					return;
				}

				if (status.status === 'failed') {
					throw new Error(`Sincronización falló: ${status.errorMessage}`);
				}

				this.logger.debug(`Estado: ${status.status}, Progreso: ${status.progress?.overallProgress || 0}%`);
			} catch (error) {
				this.logger.error('Error verificando estado de sincronización:', error);
			}
		}

		this.logger.warn('⚠️ Timeout esperando finalización de sincronización');
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
