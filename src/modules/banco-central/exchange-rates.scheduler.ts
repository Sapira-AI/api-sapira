import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { ExchangeRatesNotificationService } from './services/exchange-rates-notification.service';
import { ExchangeRatesService } from './services/exchange-rates.service';

@Injectable()
export class ExchangeRatesScheduler {
	private readonly logger = new Logger(ExchangeRatesScheduler.name);
	private readonly syncEnabled: boolean;
	private readonly syncHour: number;
	private isRunning = false;

	constructor(
		private readonly exchangeRatesService: ExchangeRatesService,
		private readonly notificationService: ExchangeRatesNotificationService,
		private readonly configService: ConfigService
	) {
		this.syncEnabled = this.configService.get<string>('BANCO_CENTRAL_SYNC_ENABLED') !== 'false';
		this.syncHour = parseInt(this.configService.get<string>('BANCO_CENTRAL_SYNC_HOUR') || '8', 10);

		if (!this.syncEnabled) {
			this.logger.warn('⚠️ Sincronización automática de tipos de cambio DESACTIVADA');
		} else {
			this.logger.log(`✓ Sincronización automática configurada para las ${this.syncHour}:00 hrs`);
		}
	}

	@Cron('0 * * * *')
	async syncExchangeRatesDaily() {
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

		this.logger.log('🚀 Iniciando sincronización automática de tipos de cambio...');

		try {
			const result = await this.syncWithRetries();
			const executionTime = Date.now() - startTime;

			this.logger.log(
				`✓ Sincronización completada exitosamente en ${(executionTime / 1000).toFixed(2)}s - ` +
					`Procesados: ${result.stats.totalProcessed}, Insertados: ${result.stats.inserted}, ` +
					`Actualizados: ${result.stats.updated}, Errores: ${result.stats.errors}`
			);

			await this.notificationService.sendSyncSuccessReport(result, executionTime);

			await this.calculateMonthlyAverages();
		} catch (error) {
			const executionTime = Date.now() - startTime;
			this.logger.error(`✗ Error en sincronización automática después de ${(executionTime / 1000).toFixed(2)}s:`, error);

			await this.notificationService.sendSyncFailureAlert(error, 'Sincronización automática diaria');
		} finally {
			this.isRunning = false;
		}
	}

	private async syncWithRetries(maxRetries = 3): Promise<any> {
		const retryDelays = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000];

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				this.logger.log(`Intento ${attempt}/${maxRetries} de sincronización...`);

				// Sincronizar solo el día actual para evitar modificar datos históricos ya usados en facturas
				const today = new Date().toISOString().split('T')[0];

				this.logger.log(`Sincronizando tipos de cambio del día: ${today}`);
				const result = await this.exchangeRatesService.syncExchangeRates({
					startDate: today,
					endDate: today,
				});

				if (result.stats.errors > 0) {
					this.logger.warn(`Sincronización completada con ${result.stats.errors} errores`);
				}

				return result;
			} catch (error) {
				this.logger.error(`Error en intento ${attempt}/${maxRetries}:`, error.message);

				if (attempt < maxRetries) {
					const delay = retryDelays[attempt - 1];
					this.logger.log(`Reintentando en ${delay / 60000} minutos...`);
					await this.sleep(delay);
				} else {
					throw error;
				}
			}
		}
	}

	private async calculateMonthlyAverages(): Promise<void> {
		try {
			this.logger.log('Calculando promedios mensuales...');
			await this.exchangeRatesService.calculateMonthlyAverages({});
			this.logger.log('✓ Promedios mensuales calculados exitosamente');
		} catch (error) {
			this.logger.error('Error calculando promedios mensuales:', error);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
