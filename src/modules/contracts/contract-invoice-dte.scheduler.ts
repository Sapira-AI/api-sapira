import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';

import { ContractInvoiceDteService } from './contract-invoice-dte.service';

/**
 * Job horario de los documentos tributarios emitidos desde Sapira: consulta en el SII los enviados que aún no tienen resultado y entrega
 * al cliente los aceptados que no se le han enviado (`ContractInvoiceDteService.pollPendingDtes`). Se apaga con
 * `DTE_STATUS_JOB_ENABLED=false`.
 */
@Injectable()
export class ContractInvoiceDteScheduler {
	private readonly logger = new Logger(ContractInvoiceDteScheduler.name);
	private readonly enabled: boolean;
	private running = false;

	constructor(
		private readonly dte: ContractInvoiceDteService,
		config: ConfigService
	) {
		this.enabled = config.get<string>('DTE_STATUS_JOB_ENABLED') !== 'false';
	}

	@Cron('15 * * * *')
	async pollDteStatuses() {
		if (!this.enabled || this.running) return;
		this.running = true;
		try {
			const result = await this.dte.pollPendingDtes();

			if (result.consulted || result.delivered || result.failed) {
				this.logger.log(
					`Documentos tributarios: ${result.consulted} consultados, ${result.delivered} enviados al cliente, ${result.failed} con error`
				);
			}
		} catch (error) {
			this.logger.error(`Job de estado de documentos tributarios: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.running = false;
		}
	}
}
