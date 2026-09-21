import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import { HoldingResult, JobSummary, SalesforceSchedulerJob, SalesforceSchedulerJobDocument } from './schemas/salesforce-scheduler-job.schema';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncLogService } from './services/salesforce-sync-log.service';

/**
 * Tiempo tras el cual una corrida marcada `running` se considera abandonada y
 * otra réplica puede retomarla.
 */
export const RUN_LEASE_MS = 3 * 60 * 60 * 1000;

/**
 * Scheduler para sincronización automática de Salesforce.
 *
 * Reevalúa las oportunidades ganadas cuya `CloseDate` cae en los últimos
 * `DAILY_SYNC_WINDOW_DAYS` días calendario de `America/Santiago` y procesa solo
 * los registros sin bloqueo (corrida de solo inserción).
 *
 * Deja dos rastros en MongoDB: el resumen de la corrida en
 * `salesforce_scheduler_jobs` y el detalle evento por evento en
 * `salesforce_sync_logs`, filtrable por holding y entorno.
 */
@Injectable()
export class SalesforceScheduler {
	private readonly logger = new Logger(SalesforceScheduler.name);
	private readonly syncEnabled: boolean;

	constructor(
		private readonly syncCompleteService: SalesforceSyncCompleteService,
		@InjectModel(SalesforceSchedulerJob.name)
		private readonly schedulerJobModel: Model<SalesforceSchedulerJobDocument>,
		private readonly configService: ConfigService,
		private readonly syncLogService: SalesforceSyncLogService
	) {
		this.syncEnabled = this.configService.get<string>('SALESFORCE_SYNC_ENABLED') !== 'false';
	}

	/**
	 * Sincronización diaria a las 8:30 AM
	 * Cron expression: '30 8 * * *' = minuto 30, hora 8, todos los días
	 */
	@Cron('30 8 * * *', {
		name: 'salesforce-daily-sync',
		timeZone: 'America/Santiago', // Ajustar según zona horaria del servidor
	})
	async handleDailySync(options: { force?: boolean } = {}) {
		if (!this.syncEnabled) {
			this.logger.debug('Sincronización automática de Salesforce desactivada');
			return;
		}

		const startTime = new Date();
		const executionEnvironment = this.configService.get<string>('NODE_ENV') || 'development';
		const jobId = this.buildJobId(executionEnvironment, startTime, options.force);
		const logContext = { jobId, executionEnvironment };

		this.logger.log('🔄 Starting daily Salesforce staging sync at 8:30 AM');
		this.logger.log(`📝 Job ID: ${jobId}`);

		if (!(await this.claimRun(jobId, executionEnvironment, startTime))) {
			return;
		}

		await this.syncLogService.record({
			...logContext,
			stage: 'run',
			message: 'Inicio de la corrida diaria de sincronización Salesforce',
			metadata: { startedAt: startTime },
		});

		try {
			const results = await this.syncCompleteService.syncAllActiveConnectionsDaily(logContext);

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

			await this.syncLogService.record({
				...logContext,
				stage: 'run',
				level: failedCount > 0 ? 'warning' : 'info',
				message:
					failedCount > 0
						? `Corrida diaria finalizada con ${failedCount} de ${results.length} holdings fallidos`
						: `Corrida diaria finalizada correctamente para ${results.length} holdings`,
				durationMs: completedAt.getTime() - startTime.getTime(),
				metadata: { summary, holdingResults },
			});

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

			// Los fallos por holding ya se notifican desde SalesforceSyncCompleteService
			// con el tipo `salesforce_sync_failure`, junto al evento de bitácora.
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
			await this.syncLogService.recordError(
				{
					...logContext,
					stage: 'run',
					message: 'La corrida diaria de sincronización Salesforce falló con un error crítico',
					durationMs: completedAt.getTime() - startTime.getTime(),
				},
				error
			);
		}
	}

	/**
	 * Toma la corrida del día para esta réplica.
	 *
	 * El `jobId` es determinista por entorno y día calendario de Santiago, y la
	 * colección tiene índice único sobre él: con varias réplicas gana la primera
	 * que inserta y el resto sale sin hacer trabajo. Si la réplica dueña muere a
	 * mitad de la corrida, otra puede retomarla una vez vencido `RUN_LEASE_MS`.
	 *
	 * Devuelve `true` si esta réplica quedó a cargo de la corrida.
	 */
	private async claimRun(jobId: string, executionEnvironment: string, startTime: Date): Promise<boolean> {
		const job = new this.schedulerJobModel({
			jobId,
			status: 'running',
			startedAt: startTime,
			executionEnvironment,
			summary: this.buildEmptySummary(),
			holdingResults: [],
		});

		try {
			await job.save();
			return true;
		} catch (error: any) {
			// 11000 = clave duplicada: otra réplica ya insertó la corrida de hoy.
			if (error?.code !== 11000) {
				throw error;
			}
		}

		const reclaimed = await this.schedulerJobModel.findOneAndUpdate(
			{ jobId, status: 'running', startedAt: { $lt: new Date(startTime.getTime() - RUN_LEASE_MS) } },
			{ $set: { startedAt: startTime, summary: this.buildEmptySummary(), holdingResults: [], error: null } },
			{ new: true }
		);

		if (!reclaimed) {
			this.logger.log(`⏭️ La corrida ${jobId} ya está tomada por otra réplica; nada que hacer`);
			return false;
		}

		this.logger.warn(`♻️ Retomando la corrida ${jobId}: venció el lease de la réplica anterior`);
		return true;
	}

	/**
	 * Identificador determinista por entorno y día calendario de Santiago.
	 * Una corrida forzada lleva sufijo único para no quedar bloqueada por la del día.
	 */
	private buildJobId(executionEnvironment: string, reference: Date, force?: boolean): string {
		const santiagoDate = new Intl.DateTimeFormat('en-CA', {
			timeZone: 'America/Santiago',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(reference);
		const baseId = `salesforce-daily-sync:${executionEnvironment}:${santiagoDate}`;

		return force ? `${baseId}:manual:${uuidv4()}` : baseId;
	}

	private buildEmptySummary(): JobSummary {
		return {
			totalHoldings: 0,
			successfulHoldings: 0,
			failedHoldings: 0,
			totalOpportunities: 0,
			totalClients: 0,
			totalQuotes: 0,
			totalSellers: 0,
		};
	}

	/**
	 * Ejecuta la sincronización fuera del horario del cron, sin competir con la
	 * corrida del día ni quedar bloqueada por ella.
	 */
	async runManualSync() {
		this.logger.log('🔧 Running manual sync (triggered by admin)');
		await this.handleDailySync({ force: true });
	}
}
