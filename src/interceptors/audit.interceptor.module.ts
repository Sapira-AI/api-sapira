import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditModule } from '@/audit/audit.module';
import { EventsModule } from '@/events/events.module';
import { HoldingsModule } from '@/modules/holdings/holdings.module';

import { AuditInterceptor } from './audit.interceptor';
import { DeviceInfoInterceptor } from './device-info.interceptor';
// import { TokenInterceptor } from './token.interceptor'; // Comentado: incompatible con SupabaseAuthGuard

/**
 * Módulo global para registrar el interceptor de auditoría
 */
@Global()
@Module({
	imports: [AuditModule, EventsModule, HoldingsModule],
	providers: [
		{
			provide: APP_INTERCEPTOR,
			useClass: DeviceInfoInterceptor, // Luego el interceptor de dispositivo
		},
		{
			provide: APP_INTERCEPTOR,
			useClass: AuditInterceptor, // Finalmente el interceptor de auditoría
		},
	],
})
export class AuditInterceptorModule {}
