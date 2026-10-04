import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { FX_MONTH_CLOSE_JOB, type FxMonthCloseResult } from './fx-month-close';
import { FxMonthCloseService } from './services/fx-month-close.service';

/**
 * Cierre mensual de la moneda de compañía (decisión de Domi 04-10): el día 1 a las 10:00 (America/Santiago), después de la
 * sincronización diaria de tipos de cambio (`ExchangeRatesScheduler`, `BANCO_CENTRAL_SYNC_HOUR`, default 08:00, con reintentos de hasta
 * ~50 minutos), cierra el promedio del mes que terminó y completa la moneda de compañía del devengo (`FxMonthCloseService`). Los días 2 a
 * 5 a la misma hora reintenta: si el día 1 todo quedó cerrado no encuentra nada que hacer (idempotente); si faltaban tasas diarias, las
 * toma apenas se cargan. `FX_MONTH_CLOSE_ENABLED=false` lo apaga. A mano: `POST /banco-central/exchange-rates/close-month` (super admin).
 */
@Injectable()
export class FxMonthCloseScheduler {
	private readonly logger = new Logger(FxMonthCloseScheduler.name);
	private readonly enabled: boolean;
	private running = false;

	constructor(
		private readonly service: FxMonthCloseService,
		private readonly configService: ConfigService
	) {
		this.enabled = this.configService.get<string>('FX_MONTH_CLOSE_ENABLED') !== 'false';
	}

	@Cron('0 10 1-5 * *', { name: FX_MONTH_CLOSE_JOB, timeZone: 'America/Santiago' })
	async closeMonth(): Promise<FxMonthCloseResult | null> {
		if (!this.enabled) {
			this.logger.debug(`${FX_MONTH_CLOSE_JOB}: desactivado (FX_MONTH_CLOSE_ENABLED=false)`);

			return null;
		}
		if (this.running) {
			this.logger.warn(`${FX_MONTH_CLOSE_JOB}: ya está corriendo en esta réplica; se omite`);

			return null;
		}
		this.running = true;
		const started = Date.now();

		try {
			const result = await this.service.run();
			const failed = result.holdings.filter((holding) => !holding.success);

			this.logger.log(
				`${FX_MONTH_CLOSE_JOB} ${result.month.slice(0, 7)}: ${result.closed_averages.length} promedio(s) cerrado(s), ` +
					`${result.incomplete_averages.length} incompleto(s), ${result.holdings.reduce((sum, h) => sum + h.contracts, 0)} contrato(s) ` +
					`recalculado(s) en ${result.holdings.length} holding(s), ${failed.length} con error, ` +
					`${result.holdings.reduce((sum, h) => sum + h.pending_rows, 0)} fila(s) del mes sin moneda de compañía, en ${(Date.now() - started) / 1000}s`
			);

			return result;
		} catch (error) {
			this.logger.error(`${FX_MONTH_CLOSE_JOB}: error crítico: ${error instanceof Error ? error.message : String(error)}`);

			return null;
		} finally {
			this.running = false;
		}
	}
}
