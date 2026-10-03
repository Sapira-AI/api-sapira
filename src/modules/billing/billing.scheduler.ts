import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { BillingCollectionsService } from './billing-collections.service';

export const BILLING_REMINDERS_JOB = 'billing-reminders';

export interface ReminderHoldingResult {
	holding_id: string;
	success: boolean;
	sent: number;
	skipped: number;
	failed: number;
	error?: string;
}

/**
 * Job diario `billing-reminders` (spec-facturacion-v2 §4.6, F5), 08:00 America/Santiago: correo de recordatorio de pago a las facturas
 * emitidas con saldo según `invoice_collection_settings` del holding. **Apagado por defecto en dos llaves**: la variable
 * `BILLING_REMINDERS_ENABLED=true` (global; sin ella no corre en ningún ambiente) y `dunning_enabled` por holding (la columna tiene
 * default `true` en la base y hay una fila en producción guardada por el front viejo, por eso la llave global). Solo correo, nunca NC,
 * idempotente por factura y día; un holding que falla no detiene a los demás.
 */
@Injectable()
export class BillingScheduler {
	private readonly logger = new Logger(BillingScheduler.name);
	private running = false;

	constructor(
		private readonly collections: BillingCollectionsService,
		private readonly config: ConfigService
	) {}

	get enabled(): boolean {
		return this.config.get<string>('BILLING_REMINDERS_ENABLED') === 'true';
	}

	@Cron('0 8 * * *', { name: BILLING_REMINDERS_JOB, timeZone: 'America/Santiago' })
	async remindersDaily(now = new Date()): Promise<ReminderHoldingResult[] | null> {
		if (!this.enabled) {
			this.logger.debug(`${BILLING_REMINDERS_JOB}: desactivado (BILLING_REMINDERS_ENABLED distinto de true)`);

			return null;
		}
		if (this.running) {
			this.logger.warn(`${BILLING_REMINDERS_JOB}: ya está corriendo en esta réplica; se omite`);

			return null;
		}
		this.running = true;
		try {
			const results: ReminderHoldingResult[] = [];

			for (const holdingId of await this.collections.reminderHoldings()) {
				try {
					results.push({ holding_id: holdingId, success: true, ...(await this.collections.runReminders(holdingId, now)) });
				} catch (error) {
					results.push({
						holding_id: holdingId,
						success: false,
						sent: 0,
						skipped: 0,
						failed: 0,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			this.logger.log(
				`${BILLING_REMINDERS_JOB}: ${results.length} holding(s), ${results.reduce((sum, result) => sum + result.sent, 0)} enviado(s), ${
					results.filter((result) => !result.success).length
				} con error`
			);

			return results;
		} finally {
			this.running = false;
		}
	}
}
