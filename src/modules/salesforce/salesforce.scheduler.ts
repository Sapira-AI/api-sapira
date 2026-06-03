import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { HoldingResult, JobSummary, SalesforceSchedulerJob, SalesforceSchedulerJobDocument } from './schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';

/**
 * Scheduler para sincronización automática de Salesforce
 * Ejecuta sincronización completa diariamente a las 8:30 AM
 */
@Injectable()
export class SalesforceScheduler {
	private readonly logger = new Logger(SalesforceScheduler.name);

	constructor(
		private readonly syncCompleteService: SalesforceSyncCompleteService,
		@InjectModel(SalesforceSchedulerJob.name)
		private readonly schedulerJobModel: Model<SalesforceSchedulerJobDocument>
	) {}

	/**
	 * Sincronización diaria a las 8:30 AM
	 * Cron expression: '30 8 * * *' = minuto 30, hora 8, todos los días
	 */
	@Cron('30 8 * * *', {
		name: 'salesforce-daily-sync',
		timeZone: 'America/Santiago', // Ajustar según zona horaria del servidor
	})
	async handleDailySync() {
		const jobId = uuidv4();
		const startTime = new Date();

		this.logger.log('🔄 Starting daily Salesforce complete sync at 8:30 AM');
		this.logger.log(`📝 Job ID: ${jobId}`);

		// Crear registro inicial en MongoDB
		const job = new this.schedulerJobModel({
			jobId,
			status: 'running',
			startedAt: startTime,
			summary: {
				totalHoldings: 0,
				successfulHoldings: 0,
				failedHoldings: 0,
				totalOpportunities: 0,
				totalClients: 0,
				totalQuotes: 0,
				totalSellers: 0,
			},
			holdingResults: [],
		});

		await job.save();

		try {
			const results = await this.syncCompleteService.syncAllActiveConnectionsComplete();

			const successCount = results.filter((r) => r.success).length;
			const failedCount = results.filter((r) => !r.success).length;

			const totalClients = results.reduce((sum, r) => sum + (r.stats?.clientsCreated || 0) + (r.stats?.clientsUpdated || 0), 0);
			const totalQuotes = results.reduce((sum, r) => sum + (r.stats?.quotesCreated || 0) + (r.stats?.quotesUpdated || 0), 0);
			const totalOpportunities = results.reduce((sum, r) => sum + (r.stats?.opportunities || 0), 0);
			const totalSellers = results.reduce((sum, r) => sum + (r.stats?.sellersCreated || 0), 0);

			// Preparar resultados por holding para MongoDB
			const holdingResults: HoldingResult[] = results.map((r) => ({
				holding_id: r.holding_id,
				success: r.success,
				opportunities: r.stats?.opportunities || 0,
				clientsCreated: r.stats?.clientsCreated || 0,
				clientsUpdated: r.stats?.clientsUpdated || 0,
				quotesCreated: r.stats?.quotesCreated || 0,
				quotesUpdated: r.stats?.quotesUpdated || 0,
				sellersCreated: r.stats?.sellersCreated || 0,
				error: r.error,
				durationSeconds: r.duration_seconds || 0,
			}));

			const completedAt = new Date();
			const durationSeconds = (completedAt.getTime() - startTime.getTime()) / 1000;

			// Preparar resumen para MongoDB
			const summary: JobSummary = {
				totalHoldings: results.length,
				successfulHoldings: successCount,
				failedHoldings: failedCount,
				totalOpportunities,
				totalClients,
				totalQuotes,
				totalSellers,
			};

			// Actualizar registro en MongoDB con resultados
			await this.schedulerJobModel.updateOne(
				{ jobId },
				{
					status: 'completed',
					completedAt,
					durationSeconds,
					summary,
					holdingResults,
				}
			);

			this.logger.log(`✅ Daily sync completed successfully`);
			this.logger.log(`📊 Summary:`);
			this.logger.log(`   - Holdings processed: ${results.length}`);
			this.logger.log(`   - Successful: ${successCount}`);
			this.logger.log(`   - Failed: ${failedCount}`);
			this.logger.log(`   - Opportunities: ${totalOpportunities}`);
			this.logger.log(`   - Clients created: ${totalClients}`);
			this.logger.log(`   - Quotes created: ${totalQuotes}`);
			this.logger.log(`   - Sellers created: ${totalSellers}`);

			// Log errores si los hay
			if (failedCount > 0) {
				this.logger.warn(`⚠️ ${failedCount} holdings failed to sync:`);
				results
					.filter((r) => !r.success)
					.forEach((r) => {
						this.logger.error(`   - ${r.holding_id}: ${r.error}`);
					});
			}

			// Opcional: Enviar notificación si hay errores críticos
			// if (failedCount > 0) {
			//   await this.sendNotification(results);
			// }
		} catch (error: any) {
			this.logger.error('❌ Daily sync failed with critical error:', error.message);
			this.logger.error(error.stack);

			// Actualizar registro en MongoDB con error
			const completedAt = new Date();
			const durationSeconds = (completedAt.getTime() - startTime.getTime()) / 1000;

			await this.schedulerJobModel.updateOne(
				{ jobId },
				{
					status: 'failed',
					completedAt,
					durationSeconds,
					error: error.message || 'Error desconocido',
				}
			);

			// Opcional: Enviar notificación de error crítico
			// await this.sendCriticalErrorNotification(error);
		}
	}

	/**
	 * Método de prueba para ejecutar sincronización manualmente
	 * Útil para testing
	 */
	async runManualSync() {
		this.logger.log('🔧 Running manual sync (triggered by admin)');
		await this.handleDailySync();
	}
}
