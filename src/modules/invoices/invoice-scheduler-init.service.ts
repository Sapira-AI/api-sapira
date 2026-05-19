import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { InvoiceSchedulerScheduler } from './invoice-scheduler.scheduler';

@Injectable()
export class InvoiceSchedulerInitService implements OnModuleInit {
	private readonly logger = new Logger(InvoiceSchedulerInitService.name);

	constructor(private readonly scheduler: InvoiceSchedulerScheduler) {}

	onModuleInit() {
		this.logger.log('✓ Invoice Scheduler inicializado correctamente');
	}
}
