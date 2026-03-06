import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { InvoiceSchedulerService } from './invoice-scheduler.service';

@Injectable()
export class InvoiceSchedulerScheduler {
	private readonly logger = new Logger(InvoiceSchedulerScheduler.name);
	private readonly schedulerEnabled: boolean;
	private readonly schedulerHour: number;
	private isRunning = false;

	constructor(
		private readonly invoiceSchedulerService: InvoiceSchedulerService,
		private readonly configService: ConfigService
	) {
		this.schedulerEnabled = this.configService.get<string>('INVOICE_SCHEDULER_ENABLED') !== 'false';
		this.schedulerHour = parseInt(this.configService.get<string>('INVOICE_SCHEDULER_HOUR') || '9', 10);

		this.logger.log(`📅 Invoice Scheduler configurado - Habilitado: ${this.schedulerEnabled}, Hora: ${this.schedulerHour}:00`);
	}

	@Cron('0 * * * *')
	async sendInvoicesToOdooDaily() {
		const currentHour = new Date().getHours();

		if (currentHour !== this.schedulerHour) {
			return;
		}

		if (!this.schedulerEnabled) {
			this.logger.log('⏸️ Scheduler deshabilitado por configuración');
			return;
		}

		if (this.isRunning) {
			this.logger.warn('⚠️ Scheduler ya está ejecutándose, omitiendo ejecución');
			return;
		}

		this.isRunning = true;
		const startTime = Date.now();

		try {
			this.logger.log('🚀 Iniciando envío automático de facturas a Odoo...');

			const result = await this.invoiceSchedulerService.processInvoicesToSend({
				dryRun: false,
			});

			const executionTime = Date.now() - startTime;
			this.logger.log(
				`✓ Envío completado en ${(executionTime / 1000).toFixed(2)}s - ` +
					`Total: ${result.summary.total}, Enviadas: ${result.summary.sent}, ` +
					`Errores: ${result.summary.errors}, Omitidas: ${result.summary.skipped}`
			);

			if (result.summary.errors > 0) {
				this.logger.warn(`⚠️ Se encontraron ${result.summary.errors} errores durante el envío`);
			}
		} catch (error) {
			this.logger.error('✗ Error crítico en envío automático:', error);
		} finally {
			this.isRunning = false;
		}
	}
}
