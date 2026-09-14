import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { BigQueryConnection } from '@/databases/postgresql/entities/integraciones/otras/bigquery-connection.entity';

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
		let quantitiesIngested = 0;
		let quantitiesChangedInSource = 0;
		let quantitiesIntegrated = 0;
		let quantitiesUnmapped = 0;
		let quantitiesBlocked = 0;
		let quantitiesCurrencyMismatch = 0;
		let quantitiesConflict = 0;
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
				this.logger.log(`   - Actualizados: ${result.updated}`);

				// Canal DWH → quantities: una sola consulta a BigQuery que cubre tanto la cola de
				// integración como la detección de cambios en el origen.
				const quantities = await this.bigQueryService.syncSapiraQuantities(holding.id);
				quantitiesIngested += quantities.ingest.inserted + quantities.ingest.updated;
				quantitiesChangedInSource += quantities.ingest.changedInSource;
				quantitiesIntegrated += quantities.integration.integrated;
				quantitiesUnmapped += quantities.integration.unmapped;
				quantitiesBlocked += quantities.integration.blocked;
				quantitiesCurrencyMismatch += quantities.integration.currencyMismatch;
				quantitiesConflict += quantities.integration.conflict;

				this.logger.log(`   - cantidades ingestadas: ${quantities.ingest.inserted + quantities.ingest.updated}`);
				this.logger.log(`   - cantidades cambiadas en el origen: ${quantities.ingest.changedInSource}`);
				this.logger.log(`   - cantidades integradas: ${quantities.integration.integrated}`);
				this.logger.log(`   - cantidades sin mapeo: ${quantities.integration.unmapped}`);
				this.logger.log(`   - cantidades bloqueadas por factura: ${quantities.integration.blocked}\n`);
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
		this.logger.log(`  Cantidades ingestadas: ${quantitiesIngested}`);
		this.logger.log(`  Cantidades cambiadas en el origen: ${quantitiesChangedInSource}`);
		this.logger.log(`  Cantidades integradas en quantities: ${quantitiesIntegrated}`);
		this.logger.log(`  Cantidades sin mapeo: ${quantitiesUnmapped}`);
		this.logger.log(`  Cantidades bloqueadas por estado de factura: ${quantitiesBlocked}`);
		this.logger.log(`  Cantidades con moneda distinta: ${quantitiesCurrencyMismatch}`);
		this.logger.log(`  Cantidades en conflicto con overrides existentes: ${quantitiesConflict}`);
		this.logger.log(`  Errores: ${errors}`);
		this.logger.log(`═══════════════════════════════════════════════════════════\n`);
	}
}
