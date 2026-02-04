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
						max: 5,
						min: 1,
						idleTimeoutMillis: 30000,
						connectionTimeoutMillis: 30000,
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
