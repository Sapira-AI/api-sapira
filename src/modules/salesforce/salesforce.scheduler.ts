import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';

/**
 * Scheduler para sincronización automática de Salesforce
 * Ejecuta sincronización completa diariamente a las 8:30 AM
 */
@Injectable()
export class SalesforceScheduler {
	private readonly logger = new Logger(SalesforceScheduler.name);

	constructor(private readonly syncCompleteService: SalesforceSyncCompleteService) {}

	/**
	 * Sincronización diaria a las 8:30 AM
	 * Cron expression: '30 8 * * *' = minuto 30, hora 8, todos los días
	 */
	@Cron('30 8 * * *', {
		name: 'salesforce-daily-sync',
		timeZone: 'America/Santiago', // Ajustar según zona horaria del servidor
	})
	async handleDailySync() {
		this.logger.log('🔄 Starting daily Salesforce complete sync at 8:30 AM');

		try {
			const results = await this.syncCompleteService.syncAllActiveConnectionsComplete();

			const successCount = results.filter((r) => r.success).length;
			const failedCount = results.filter((r) => !r.success).length;

			const totalClients = results.reduce((sum, r) => sum + (r.stats?.clientsCreated || 0), 0);
			const totalQuotes = results.reduce((sum, r) => sum + (r.stats?.quotesCreated || 0), 0);
			const totalOpportunities = results.reduce((sum, r) => sum + (r.stats?.opportunities || 0), 0);
			const totalSellers = results.reduce((sum, r) => sum + (r.stats?.sellersCreated || 0), 0);

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
