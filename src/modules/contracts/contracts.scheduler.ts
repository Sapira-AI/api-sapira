import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { AUTO_RENEWAL_JOB, EXTEND_HORIZON_JOB, RENEWAL_REMINDERS_JOB, SCHEDULED_CHANGES_JOB } from './contract-renewals';
import { ContractRenewalsService, type JobHoldingResult } from './contract-renewals.service';
import { InvoiceConsolidationRulesService } from './invoice-consolidation-rules.service';

export const CONSOLIDATION_RULES_JOB = 'contracts-consolidation-rules';

/**
 * Jobs diarios de contratos v2 (spec modificaciones §9.3.5 y §9.3.6, B2-4). Se disparan a su hora en `America/Santiago` (hora del
 * servidor); dentro de la corrida cada holding calcula su "hoy" con su zona (`holding_settings.timezone`, Configuración ronda 4):
 * - `contracts-scheduled-changes` (05:30): pactos `on_date` / `every_n_months` por vencer → evento `SCHEDULED_CHANGE_DUE` + notificación.
 * - `contracts-extend-horizon` (05:45): ítems recurrentes sin término → las Por Emitir que faltan para tener siempre
 *   12 períodos desde hoy (`HORIZON_PERIODS_AHEAD`, fijo por sistema: calendario rodante)
 *   (evento `HORIZON_EXTENDED` por contrato solo si creó algo; idempotente con el contrato bloqueado).
 * - `contracts-auto-renewal` (06:00): ítems `auto_renew` por vencer → evento `RENEWAL_PROPOSED` + notificación. **Nunca renueva sola.**
 * - `contracts-consolidation-rules` (06:30): unificación recurrente de cada razón social con regla activa
 *   (`InvoiceConsolidationRulesService.runAll`): une las Por Emitir que nacieron después de guardarla, antes del envío automático.
 * - `contracts-renewal-reminders` (06:15): ítems que terminan sin decisión → alertas crecientes (`auto_renewal_notice_days` y la escalera del
 *   holding `renewal_reminder_days`, default 60/30/15/7/0 días antes del fin; vencido, cada `renewal_overdue_every_days`, default 7),
 *   evento `RENEWAL_REMINDER` (idempotente por contrato, fin y escalón) + notificación (S2-1 / S5-4).
 * Por holding con try/catch (un holding que falla no detiene a los demás) e idempotentes (por ítem y fin / por pacto y fecha, revisado con el
 * contrato bloqueado): dos réplicas o un reintento no duplican eventos. `CONTRACT_JOBS_ENABLED=false` los apaga. Reemplazan al cron legacy
 * `process_auto_renewals` (ya desprogramado; sus funciones se retiran al switch).
 */
@Injectable()
export class ContractsScheduler {
	private readonly logger = new Logger(ContractsScheduler.name);
	private readonly enabled: boolean;
	private readonly running = new Set<string>();

	constructor(
		private readonly renewals: ContractRenewalsService,
		private readonly consolidationRules: InvoiceConsolidationRulesService,
		private readonly configService: ConfigService
	) {
		this.enabled = this.configService.get<string>('CONTRACT_JOBS_ENABLED') !== 'false';
	}

	@Cron('30 5 * * *', { name: SCHEDULED_CHANGES_JOB, timeZone: 'America/Santiago' })
	async scheduledChangesDaily(): Promise<JobHoldingResult[] | null> {
		return await this.run(SCHEDULED_CHANGES_JOB, () => this.renewals.flagDueScheduledChanges(new Date()));
	}

	@Cron('45 5 * * *', { name: EXTEND_HORIZON_JOB, timeZone: 'America/Santiago' })
	async extendHorizonDaily(): Promise<JobHoldingResult[] | null> {
		return await this.run(EXTEND_HORIZON_JOB, () => this.renewals.extendHorizons(new Date()));
	}

	@Cron('0 6 * * *', { name: AUTO_RENEWAL_JOB, timeZone: 'America/Santiago' })
	async autoRenewalDaily(): Promise<JobHoldingResult[] | null> {
		return await this.run(AUTO_RENEWAL_JOB, () => this.renewals.proposeRenewals(new Date()));
	}

	@Cron('15 6 * * *', { name: RENEWAL_REMINDERS_JOB, timeZone: 'America/Santiago' })
	async renewalRemindersDaily(): Promise<JobHoldingResult[] | null> {
		return await this.run(RENEWAL_REMINDERS_JOB, () => this.renewals.remindRenewals(new Date()));
	}

	@Cron('30 6 * * *', { name: CONSOLIDATION_RULES_JOB, timeZone: 'America/Santiago' })
	async consolidationRulesDaily(): Promise<JobHoldingResult[] | null> {
		return await this.run(CONSOLIDATION_RULES_JOB, () => this.consolidationRules.runAll(new Date()));
	}

	private async run(job: string, work: () => Promise<JobHoldingResult[]>): Promise<JobHoldingResult[] | null> {
		if (!this.enabled) {
			this.logger.debug(`${job}: desactivado (CONTRACT_JOBS_ENABLED=false)`);

			return null;
		}
		if (this.running.has(job)) {
			this.logger.warn(`${job}: ya está corriendo en esta réplica; se omite`);

			return null;
		}
		this.running.add(job);
		const started = Date.now();

		try {
			const results = await work();
			const failed = results.filter((result) => !result.success);

			this.logger.log(
				`${job}: ${results.length} holding(s), ${results.reduce((sum, result) => sum + result.events, 0)} evento(s), ${failed.length} con error en ${
					(Date.now() - started) / 1000
				}s`
			);

			return results;
		} catch (error) {
			this.logger.error(`${job}: error crítico: ${error instanceof Error ? error.message : String(error)}`);

			return null;
		} finally {
			this.running.delete(job);
		}
	}
}
