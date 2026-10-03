import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DEFAULT_TIMEZONE } from '@/core/utils/holding-preferences';

import { localParts } from './local-time';
import { MonthCloseService } from './month-close.service';
import { NotificationDigestService } from './notification-digest.service';

export const NOTIFICATION_JOBS = 'notification-jobs';
/** Hora local del holding del aviso de cierre de mes y del resumen semanal (lunes). */
export const MONTH_CLOSE_HOUR = 7;
export const DIGEST_HOUR = 8;

type Row = Record<string, unknown>;

/**
 * Job horario de Notificaciones v2 fase 2 (contrato §8.4 y §8.6). Cada hora recorre los holdings y, en la **zona de cada uno**
 * (`holding_settings.timezone`): a las 07:xx corre el aviso de cierre de mes (tareas + alertas; fuera de la ventana solo cierra las abiertas)
 * y los **lunes a las 08:xx** envía el resumen semanal. Llave `NOTIFICATION_JOBS_ENABLED` (default activo; `false` apaga). Un holding que
 * falla no detiene a los demás. Varias réplicas: el resumen es idempotente por semana (`notification_email_log`) y la alerta se deduplica.
 */
@Injectable()
export class NotificationJobsScheduler {
	private readonly logger = new Logger(NotificationJobsScheduler.name);
	private running = false;

	constructor(
		@InjectDataSource() private readonly dataSource: DataSource,
		private readonly config: ConfigService,
		private readonly digest: NotificationDigestService,
		private readonly monthClose: MonthCloseService
	) {}

	get enabled(): boolean {
		return this.config.get<string>('NOTIFICATION_JOBS_ENABLED') !== 'false';
	}

	@Cron('5 * * * *', { name: NOTIFICATION_JOBS })
	async hourly(now = new Date()): Promise<Array<{ holding_id: string; month_close?: unknown; digest?: unknown; error?: string }> | null> {
		if (!this.enabled || this.running) return null;
		this.running = true;
		try {
			const holdings = (await this.dataSource.query(
				`SELECT h.id, COALESCE(NULLIF(hs.timezone, ''), $1) AS timezone FROM company_holdings h LEFT JOIN holding_settings hs ON hs.holding_id = h.id`,
				[DEFAULT_TIMEZONE]
			)) as Row[];
			const results: Array<{ holding_id: string; month_close?: unknown; digest?: unknown; error?: string }> = [];

			for (const holding of holdings ?? []) {
				const holdingId = String(holding.id);
				const local = localParts(now, String(holding.timezone));

				if (local.hour !== MONTH_CLOSE_HOUR && !(local.weekday === 1 && local.hour === DIGEST_HOUR)) continue;
				try {
					results.push({
						holding_id: holdingId,
						...(local.hour === MONTH_CLOSE_HOUR ? { month_close: await this.monthClose.run(holdingId, local.date) } : {}),
						...(local.weekday === 1 && local.hour === DIGEST_HOUR ? { digest: await this.digest.run(holdingId, now) } : {}),
					});
				} catch (error) {
					results.push({ holding_id: holdingId, error: error instanceof Error ? error.message : String(error) });
					this.logger.warn(`${NOTIFICATION_JOBS} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (results.length) this.logger.log(`${NOTIFICATION_JOBS}: ${results.length} holding(s) procesados`);

			return results;
		} finally {
			this.running = false;
		}
	}
}
