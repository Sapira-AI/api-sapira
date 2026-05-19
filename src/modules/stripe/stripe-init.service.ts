import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { StripeScheduler } from './stripe.scheduler';

@Injectable()
export class StripeInitService implements OnModuleInit {
	private readonly logger = new Logger(StripeInitService.name);

	constructor(private readonly scheduler: StripeScheduler) {}

	onModuleInit() {
		this.logger.log('✓ Stripe Scheduler inicializado correctamente');
	}
}
