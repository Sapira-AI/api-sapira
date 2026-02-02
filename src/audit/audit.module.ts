import { CacheModule } from '@nestjs/cache-manager';
import { forwardRef, Global, Module } from '@nestjs/common';

import { MongooseModules } from '@/databases/mongoose/database.module';
import { EventsModule } from '@/events/events.module';
import { HoldingsModule } from '@/modules/holdings/holdings.module';

import { AuditConfigService } from './audit-config.service';
import { AuditController } from './audit.controller';
import { AuditProviders } from './audit.provider';
import { AuditService } from './audit.service';

@Global()
@Module({
	imports: [
		MongooseModules,
		CacheModule.register({
			ttl: 300000, // 5 minutos por defecto
			max: 100, // máximo número de items en cache
		}),
		forwardRef(() => HoldingsModule),
		forwardRef(() => EventsModule),
	],
	controllers: [AuditController],
	providers: [...AuditProviders, AuditService, AuditConfigService],
	exports: [AuditService, AuditConfigService],
})
export class AuditModule {}
