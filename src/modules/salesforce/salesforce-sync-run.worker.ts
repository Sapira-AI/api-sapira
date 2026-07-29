import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { SalesforceSyncRun } from './entities/salesforce-sync-run.entity';
import { SalesforceSyncCompleteService } from './services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from './services/salesforce-sync-run.service';

const BATCH_SIZE = 25;

@Injectable()
export class SalesforceSyncRunWorker {
	private readonly logger = new Logger(SalesforceSyncRunWorker.name);
	private isTickRunning = false;

	constructor(
		private readonly syncRunService: SalesforceSyncRunService,
		private readonly syncCompleteService: SalesforceSyncCompleteService
	) {}

	@Interval(1000)
	async processPendingRuns(): Promise<void> {
		if (this.isTickRunning) {
			return;
		}

		this.isTickRunning = true;
		try {
			await this.syncRunService.recoverExpiredClaims();
			const runs = await this.syncRunService.getRunnableRuns();
			for (const run of runs) {
				await this.processRunBatch(run);
			}
		} catch (error) {
			this.logger.error('No se pudieron procesar ejecuciones Salesforce', error instanceof Error ? error.stack : error);
		} finally {
			this.isTickRunning = false;
		}
	}

	private async processRunBatch(run: SalesforceSyncRun): Promise<void> {
		const hasLock = await this.syncRunService.acquireRunLock(run.id);
		if (!hasLock) {
			return;
		}

		try {
			await this.processLockedRunBatch(run);
		} finally {
			await this.syncRunService.releaseRunLock(run.id);
		}
	}

	private async processLockedRunBatch(run: SalesforceSyncRun): Promise<void> {
		if (run.status === 'cancellation_requested') {
			await this.syncRunService.finishRunIfDone(run.id);
			return;
		}

		const items = await this.syncRunService.claimPendingItems(run.id, BATCH_SIZE);
		for (const item of items) {
			const currentRun = await this.syncRunService.getRun(run.holding_id, run.id);
			if (currentRun.status === 'cancellation_requested') {
				await this.syncRunService.requestCancellation(run.holding_id, run.id);
				break;
			}

			try {
				if (run.type === 'update_staging' || run.type === 'retry_full') {
					await this.syncCompleteService.syncOpportunitiesToStaging(run.holding_id, run.date_from || undefined, run.date_to || undefined, [
						item.salesforce_opportunity_id,
					]);
					const staging = await this.syncCompleteService.getOpportunityStagingStatus(run.holding_id, item.salesforce_opportunity_id);
					if (!staging) {
						throw new Error('La oportunidad no quedó registrada en staging');
					}
					if (staging.status === 'error') {
						throw new Error(staging.errorMessage || 'La oportunidad quedó bloqueada en staging');
					}
					if (!['create', 'update', 'processed'].includes(staging.status || '')) {
						throw new Error(`La oportunidad quedó con estado staging no procesable: ${staging.status || 'sin estado'}`);
					}

					if (run.type === 'retry_full' && staging.status !== 'processed') {
						const stats = await this.syncCompleteService.processOpportunitiesStaging(run.holding_id, [item.salesforce_opportunity_id]);
						if (stats.errors.length) {
							throw new Error(stats.errors.join(' | '));
						}
					}
				} else {
					const stats = await this.syncCompleteService.processOpportunitiesStaging(run.holding_id, [item.salesforce_opportunity_id]);
					if (stats.errors.length) {
						throw new Error(stats.errors.join(' | '));
					}
				}
				await this.syncRunService.completeItem(item);
			} catch (error) {
				await this.syncRunService.failItem(item, error);
				this.logger.warn(`Falló oportunidad ${item.salesforce_opportunity_id} en ejecución ${run.id}`);
			}
		}
		await this.syncRunService.finishRunIfDone(run.id);
	}
}
