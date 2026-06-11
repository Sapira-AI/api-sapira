import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseProvider } from './database.provider';

@Module({
	imports: [
		TypeOrmModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: async (configService: ConfigService) => {
				const supabaseUrl = configService.get<string>('SUPABASE_DATABASE_URL');

				if (!supabaseUrl) {
					console.log('🔵 PostgreSQL/Supabase no configurado - saltando conexión');
					return null;
				}

				console.log('🟢 Configurando conexión a Supabase...');
				console.log('📋 URL recibida:', supabaseUrl.replace(/:[^:@]*@/, ':***@')); // Ocultar password

				// Usar la URL del .env directamente
				console.log('🔗 Usando URL de .env');
				return {
					type: 'postgres',
					url: supabaseUrl,
					entities: [__dirname + '/../../**/*.entity{.ts,.js}'],
					synchronize: false,
					logging: configService.get<boolean>('SUPABASE_LOGGING', false) ? ['error', 'schema', 'warn', 'info', 'log'] : false,
					ssl: {
						rejectUnauthorized: false,
					},
					retryAttempts: 5,
					retryDelay: 5000,
					autoLoadEntities: true,
					extra: {
						// Pool de conexiones optimizado para producción
						max: configService.get<number>('SUPABASE_POOL_MAX', 20), // Máximo de conexiones
						min: configService.get<number>('SUPABASE_POOL_MIN', 2), // Mínimo de conexiones activas
						idleTimeoutMillis: configService.get<number>('SUPABASE_IDLE_TIMEOUT', 300000), // 5 minutos
						connectionTimeoutMillis: configService.get<number>('SUPABASE_CONNECTION_TIMEOUT', 60000), // 60 segundos
						acquireTimeoutMillis: configService.get<number>('SUPABASE_ACQUIRE_TIMEOUT', 60000), // 60 segundos
						evictionRunIntervalMillis: 10000, // Limpiar conexiones muertas cada 10 segundos
						softIdleTimeoutMillis: 30000, // Soft timeout para conexiones idle
						statement_timeout: 30000, // Timeout de queries a 30 segundos
						query_timeout: 30000, // Timeout de queries a 30 segundos
					},
				};
			},
			inject: [ConfigService],
		}),
	],
	providers: [PostgreSQLDatabaseProvider],
	exports: [PostgreSQLDatabaseProvider, TypeOrmModule],
})
export class PostgreSQLDatabaseModule {}
