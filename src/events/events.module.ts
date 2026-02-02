import { forwardRef, Module } from '@nestjs/common';

import { LoggerModule } from '@/logger/logger.module';
import { HoldingsModule } from '@/modules/holdings/holdings.module';
import { SecurityModule } from '@/security/security.module';
import { TelemetryModule } from '@/telemetry/telemetry.module';

import { AuditModule } from '../audit/audit.module';

import { EventsController } from './events.controller';
import { BusinessHandler } from './handlers/business.handler';
import { SecurityHandler } from './handlers/security.handler';
import { EventDispatcherService } from './services/event-dispatcher.service';
import { EventHandlerService } from './services/event-handler.service';
import { EventsService } from './services/events.service';

@Module({
	imports: [LoggerModule, TelemetryModule, forwardRef(() => AuditModule), HoldingsModule, forwardRef(() => SecurityModule)],
	providers: [EventDispatcherService, EventHandlerService, EventsService, SecurityHandler, BusinessHandler],
	controllers: [EventsController],
	exports: [EventHandlerService, EventsService],
})
export class EventsModule {}
