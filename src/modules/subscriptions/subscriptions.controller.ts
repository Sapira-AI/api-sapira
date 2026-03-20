import { Controller, Get, Headers, Logger, Param, Query, UseGuards } from '@nestjs/common';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';

import { SubscriptionQueryDto } from './dto/subscription-query.dto';
import { SubscriptionsService } from './subscriptions.service';

@Controller('subscriptions')
@UseGuards(SupabaseAuthGuard)
export class SubscriptionsController {
	private readonly logger = new Logger(SubscriptionsController.name);

	constructor(private readonly subscriptionsService: SubscriptionsService) {}

	@Get()
	async findAll(@Headers('x-holding-id') holdingId: string, @Query() query: SubscriptionQueryDto) {
		this.logger.log(`📥 GET /subscriptions - holdingId: ${holdingId}`);
		this.logger.log(`📋 Query params: ${JSON.stringify(query)}`);

		const result = await this.subscriptionsService.findAll(holdingId, query);

		this.logger.log(`📤 Retornando ${result.data.length} suscripciones de ${result.pagination.total} totales`);
		return result;
	}

	@Get('stats')
	async getStats(@Headers('x-holding-id') holdingId: string) {
		this.logger.log(`📥 GET /subscriptions/stats - holdingId: ${holdingId}`);
		return this.subscriptionsService.getStats(holdingId);
	}

	@Get(':id')
	async findOne(@Param('id') id: string, @Headers('x-holding-id') holdingId: string) {
		this.logger.log(`📥 GET /subscriptions/${id} - holdingId: ${holdingId}`);
		return this.subscriptionsService.findOne(id, holdingId);
	}
}
