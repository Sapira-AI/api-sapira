import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BigQueryConnection } from '@/databases/postgresql/entities/bigquery-connection.entity';
import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { BigQueryService } from './bigquery.service';

@Injectable()
export class BigQueryScheduler {
	private readonly logger = new Logger(BigQueryScheduler.name);
	private readonly syncEnabled: boolean;
	private readonly syncHour: number;
	private isRunning = false;

	constructor(
		private readonly bigQueryService: BigQueryService,
		@InjectRepository(CompanyHolding)
		private readonly holdingRepository: Repository<CompanyHolding>,
		@InjectRepository(BigQueryConnection)
		private readonly bigQueryConnectionRepository: Repository<BigQueryConnection>,
		private readonly configService: ConfigService
	) {
		this.syncEnabled = this.configService.get<string>('BIGQUERY_SYNC_ENABLED') !== 'false';
		this.syncHour = parseInt(this.configService.get<string>('BIGQUERY_SYNC_HOUR') || '3', 10);

		if (!this.syncEnabled) {
			this.logger.warn('⚠️ Sincronización automática de BigQuery DESACTIVADA');
		} else {
			this.logger.log(`✓ Sincronización automática de BigQuery configurada para las ${this.syncHour}:00 hrs`);
		}
	}

	@Cron('0 * * * *')
	async syncBigQueryDaily() {
		const currentHour = new Date().getHours();

		if (currentHour !== this.syncHour) {
			return;
		}

		if (!this.syncEnabled) {
			this.logger.debug('Sincronización automática de BigQuery desactivada');
			return;
		}

		if (this.isRunning) {
			this.logger.warn('Sincronización de BigQuery ya en ejecución, omitiendo...');
			return;
		}

		this.isRunning = true;
		const startTime = Date.now();

		this.logger.log('🚀 Iniciando sincronización automática de BigQuery...');

		try {
			await this.executeFullSync();

			const executionTime = Date.now() - startTime;
			this.logger.log(`✓ Sincronización de BigQuery completada exitosamente en ${(executionTime / 1000).toFixed(2)}s`);
		} catch (error) {
			const executionTime = Date.now() - startTime;
			this.logger.error(`✗ Error en sincronización automática de BigQuery después de ${(executionTime / 1000).toFixed(2)}s:`, error);
		} finally {
			this.isRunning = false;
		}
	}

	private async executeFullSync(): Promise<void> {
		const activeConnections = await this.bigQueryConnectionRepository.find({
			where: { is_active: true },
			relations: ['holding'],
		});

		if (activeConnections.length === 0) {
			this.logger.warn('No hay holdings con BigQuery configurado para sincronizar');
			return;
		}

		const holdingIds = [...new Set(activeConnections.map((conn) => conn.holding_id))];
		const holdings = await this.holdingRepository.findByIds(holdingIds);

		this.logger.log(`Encontrados ${holdings.length} holding(s) con BigQuery configurado para sincronizar`);

		let totalProcessed = 0;
		let totalInserted = 0;
		let totalUpdated = 0;
		let errors = 0;

		for (const holding of holdings) {
			try {
				this.logger.log(`\n┌─────────────────────────────────────────────────────────────┐`);
				this.logger.log(`│  Sincronizando holding: ${holding.name.padEnd(40)} │`);
				this.logger.log(`│  Holding ID: ${holding.id.padEnd(44)} │`);
				this.logger.log(`└─────────────────────────────────────────────────────────────┘`);

				const result = await this.bigQueryService.syncStripeCustomers(holding.id);

				totalProcessed += result.totalProcessed;
				totalInserted += result.inserted;
				totalUpdated += result.updated;

				this.logger.log(`✓ Holding ${holding.name} sincronizado exitosamente`);
				this.logger.log(`   - Procesados: ${result.totalProcessed}`);
				this.logger.log(`   - Insertados: ${result.inserted}`);
				this.logger.log(`   - Actualizados: ${result.updated}\n`);
			} catch (error) {
				errors++;
				this.logger.error(`✗ Error sincronizando holding ${holding.name}:`, error);
				this.logger.error(`   Error detalle: ${error.message}\n`);
				if (error.message?.includes('No hay conexión de BigQuery')) {
					this.logger.warn(`   Holding ${holding.name} no tiene conexión de BigQuery activa`);
				}
			}
		}

		this.logger.log(`\n═══════════════════════════════════════════════════════════`);
		this.logger.log(`  RESUMEN DE SINCRONIZACIÓN`);
		this.logger.log(`═══════════════════════════════════════════════════════════`);
		this.logger.log(`  Holdings procesados: ${holdings.length}`);
		this.logger.log(`  Registros procesados: ${totalProcessed}`);
		this.logger.log(`  Registros insertados: ${totalInserted}`);
		this.logger.log(`  Registros actualizados: ${totalUpdated}`);
		this.logger.log(`  Errores: ${errors}`);
		this.logger.log(`═══════════════════════════════════════════════════════════\n`);
	}
}
