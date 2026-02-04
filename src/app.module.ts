import { CacheModule } from '@nestjs/cache-manager';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from '@/audit/audit.module';
import { EventsModule } from '@/events/events.module';
import { SecurityModule } from '@/security/security.module';
import { SecurityService } from '@/security/services/security.service';

import { AuthModule } from './auth/auth.module';
import { SupabaseAuthGuard } from './auth/strategies/supabase-auth.guard';
import { eventConfig } from './core/config/event.config';
import { MongooseModules } from './databases/mongoose/database.module';
import { PostgreSQLDatabaseModule } from './databases/postgresql/database.module';
import { GuardsModule } from './guards/guards.module';
import { HealthModule } from './health/health.module';
import { AuditInterceptorModule } from './interceptors/audit.interceptor.module';
import { UserIdInterceptor } from './interceptors/user-id.interceptor';
import { LoggerModule } from './logger/logger.module';
import { RequestContextMiddleware } from './middlewares/common/request-context.middleware';
import { IpFilterMiddleware } from './middlewares/security/ip-filter.middleware';
import { AgentsModule } from './modules/agents/agents.module';
import { BigQueryModule } from './modules/bigquery/bigquery.module';
import { ClaudeModule } from './modules/claude/claude.module';
import { ClientsModule } from './modules/clients';
import { DatabaseAnalyzerModule } from './modules/database/database-analyzer.module';
import { DevicesModule } from './modules/devices/devices.module';
import { EmailModule } from './modules/email/email.module';
import { EmailsModule } from './modules/emails/emails.module';
import { HoldingsModule } from './modules/holdings/holdings.module';
import { OdooModule } from './modules/odoo/odoo.module';
import { SapiraCopilotModule } from './modules/sapira-copilot/sapira-copilot.module';
import { UsersModule } from './modules/users/users.module';
import { CitiesModule } from './modules/utils/cities/cities.module';
import { TelemetryModule } from './telemetry/telemetry.module';

@Module({
	imports: [
		ConfigModule.forRoot({
			isGlobal: true,
			load: [eventConfig],
		}),
		ScheduleModule.forRoot(),
		CacheModule.register({
			isGlobal: true,
			ttl: 0, // Desactivado por defecto
			max: 100, // máximo número de items en cache
		}),
		ThrottlerModule.forRoot([
			{
				name: 'short', // Para endpoints sensibles (auth, login, etc.)
				ttl: 60000, // 1 minuto
				limit: 1000, // 1000 requests por minuto
			},
			{
				name: 'medium', // Para operaciones regulares
				ttl: 300000, // 5 minutos
				limit: 5000, // 5000 requests por 5 minutos
			},
			{
				name: 'long', // Para operaciones pesadas o batch
				ttl: 3600000, // 1 hora
				limit: 20000, // 20000 requests por hora
			},
		]),
		AuditInterceptorModule,
		MongooseModules,
		SecurityModule,
		AuthModule,
		GuardsModule,
		HealthModule,
		CitiesModule,
		AuditModule,
		LoggerModule,
		TelemetryModule,
		EventsModule,
		DevicesModule,
		DatabaseAnalyzerModule,
		PostgreSQLDatabaseModule,
		HoldingsModule,
		UsersModule,
		ClientsModule,
		OdooModule,
		EmailModule,
		EmailsModule,
		BigQueryModule,
		AgentsModule,
		ClaudeModule,
		SapiraCopilotModule,
	],
	providers: [
		{
			provide: APP_GUARD,
			useClass: ThrottlerGuard,
		},
		{
			provide: APP_GUARD,
			useClass: SupabaseAuthGuard,
		},
		{
			provide: APP_INTERCEPTOR,
			useClass: UserIdInterceptor,
		},
		SecurityService,
	],
})
export class AppModule implements NestModule {
	constructor(private readonly securityService: SecurityService) {}

	configure(consumer: MiddlewareConsumer) {
		consumer.apply(RequestContextMiddleware, IpFilterMiddleware).forRoutes('*');
	}
}
