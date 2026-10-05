import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { AppLoggerService } from '@/logger/app-logger.service';

import { InvoiceSchedulerService } from './invoice-scheduler.service';

@Injectable()
export class InvoiceSchedulerScheduler {
	private readonly logger = new Logger(InvoiceSchedulerScheduler.name);
	private readonly schedulerEnabled: boolean;
	private readonly schedulerHour: number;
	private isRunning = false;

	constructor(
		private readonly invoiceSchedulerService: InvoiceSchedulerService,
		private readonly configService: ConfigService,
		private readonly appLogger: AppLoggerService
	) {
		this.schedulerEnabled = this.configService.get<string>('INVOICE_SCHEDULER_ENABLED') !== 'false';
		this.schedulerHour = parseInt(this.configService.get<string>('INVOICE_SCHEDULER_HOUR') || '9', 10);

		this.logger.log(`📅 Invoice Scheduler configurado - Habilitado: ${this.schedulerEnabled}, Hora: ${this.schedulerHour}:00`);
		this.appLogger.log(
			`📅 Invoice Scheduler configurado - Habilitado: ${this.schedulerEnabled}, Hora: ${this.schedulerHour}:00`,
			'system',
			'InvoiceScheduler',
			{ enabled: this.schedulerEnabled, hour: this.schedulerHour }
		);
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
			this.appLogger.log('🚀 Iniciando envío automático de facturas a Odoo', 'system', 'InvoiceScheduler');

			const holdingIds = await this.invoiceSchedulerService.getHoldingIdsWithPendingInvoices();

			if (holdingIds.length === 0) {
				this.logger.log('✓ No hay holdings con facturas pendientes: no se crea ninguna corrida');
				this.appLogger.log('✓ Envío automático sin holdings pendientes', 'system', 'InvoiceScheduler');
				return;
			}

			this.logger.log(`📋 ${holdingIds.length} holding(s) con facturas pendientes`);

			for (const holdingId of holdingIds) {
				await this.runForHolding(holdingId);
			}

			const executionTime = Date.now() - startTime;
			this.logger.log(`✓ Envío completado en ${(executionTime / 1000).toFixed(2)}s para ${holdingIds.length} holding(s)`);
			this.appLogger.log(`✓ Envío de facturas a Odoo completado en ${(executionTime / 1000).toFixed(2)}s`, 'system', 'InvoiceScheduler', {
				holdings: holdingIds.length,
				executionTimeMs: executionTime,
				executionTimeSeconds: (executionTime / 1000).toFixed(2),
			});
		} catch (error) {
			this.logger.error('✗ Error crítico en envío automático:', error);
			this.appLogger.error(
				'✗ Error crítico en envío automático de facturas a Odoo',
				'system',
				error?.stack || error?.message,
				'InvoiceScheduler'
			);
		} finally {
			this.isRunning = false;
		}
	}

	/**
	 * Una corrida por holding, individualizada: su propio job, su propio progreso y su propio correo de
	 * errores. El `try/catch` es por holding a propósito — antes un fallo mataba el envío de todos.
	 */
	private async runForHolding(holdingId: string): Promise<void> {
		let jobId: string | null = null;

		try {
			jobId = await this.invoiceSchedulerService.createSystemSchedulerJob({ dryRun: false, holdingId });

			this.logger.log(`📝 Job del sistema creado para el holding ${holdingId}: ${jobId}`);

			const result = await this.invoiceSchedulerService.processInvoicesToSend({ dryRun: false, holdingId });

			await this.invoiceSchedulerService.updateSchedulerJobResult(jobId, result);

			this.logger.log(
				`✓ Holding ${holdingId} - Total: ${result.summary.total}, Enviadas: ${result.summary.sent}, ` +
					`Errores: ${result.summary.errors}, Omitidas: ${result.summary.skipped}`
			);

			if (result.summary.errors > 0) {
				this.logger.warn(`⚠️ Holding ${holdingId}: ${result.summary.errors} errores durante el envío`);
				this.appLogger.warn(`⚠️ Se encontraron ${result.summary.errors} errores durante el envío de facturas`, 'system', 'InvoiceScheduler', {
					jobId,
					holdingId,
					errorCount: result.summary.errors,
				});
			}
		} catch (error) {
			this.logger.error(`✗ Error en el envío automático del holding ${holdingId}:`, error);
			this.appLogger.error(
				`✗ Error en el envío automático de facturas a Odoo del holding ${holdingId}`,
				'system',
				error?.stack || error?.message,
				'InvoiceScheduler'
			);

			if (jobId) {
				await this.invoiceSchedulerService.updateSchedulerJobError(jobId, error);
			}
		}
	}
}
