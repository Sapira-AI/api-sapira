import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';

import { KameExportService } from './kame-export.service';
import { kameJobEnabled } from './kame.types';

/**
 * Job horario del envío a Kame: encola y envía las facturas y los meses de asientos de los holdings con «Envío automático a Kame»
 * prendido (`holding_integration_settings`, `integration = 'kame'`; fila ausente = apagado). Tres llaves, todas apagadas por defecto:
 * `KAME_EXPORT_JOB_ENABLED=true` en el servidor, el interruptor del holding y la conexión activa de cada compañía. El envío manual
 * («Enviar ahora») no depende del job ni del interruptor del holding.
 */
@Injectable()
export class KameScheduler {
	private readonly logger = new Logger(KameScheduler.name);
	private readonly enabled: boolean;
	private running = false;

	constructor(
		private readonly exports: KameExportService,
		private readonly dataSource: DataSource,
		config: ConfigService
	) {
		this.enabled = kameJobEnabled(config.get<string>('KAME_EXPORT_JOB_ENABLED'));
	}

	@Cron('30 * * * *')
	async run() {
		if (!this.enabled || this.running) return;
		this.running = true;
		try {
			const holdings: Array<{ holding_id: string }> = await this.dataSource.query(
				`SELECT holding_id::text AS holding_id FROM holding_integration_settings WHERE integration = 'kame' AND auto_enabled = true`
			);

			for (const { holding_id: holdingId } of holdings) {
				try {
					const enqueued = await this.exports.enqueue(holdingId);
					const result = await this.exports.process({ holdingId });

					if (enqueued.invoices || enqueued.journal || result.processed) {
						this.logger.log(
							`Kame ${holdingId}: ${enqueued.invoices} facturas y ${enqueued.journal} meses en cola; ${result.sent} enviados, ${result.simulated} simulados, ${result.errors} con error`
						);
					}
				} catch (error) {
					this.logger.error(`Envío a Kame del holding ${holdingId}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} finally {
			this.running = false;
		}
	}
}
