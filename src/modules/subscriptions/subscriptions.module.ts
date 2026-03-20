import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

@Module({
	imports: [TypeOrmModule.forFeature([])],
	controllers: [SubscriptionsController],
	providers: [SubscriptionsService],
	exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
