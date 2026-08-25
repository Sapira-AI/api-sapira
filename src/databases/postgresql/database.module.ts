import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PostgreSQLDatabaseProvider } from './database.provider';
import { createPostgreSqlOptions } from './typeorm-options';

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

				return createPostgreSqlOptions({
					...process.env,
					SUPABASE_DATABASE_URL: supabaseUrl,
					SUPABASE_LOGGING: configService.get<string | boolean>('SUPABASE_LOGGING', false),
				});
			},
			inject: [ConfigService],
		}),
	],
	providers: [PostgreSQLDatabaseProvider],
	exports: [PostgreSQLDatabaseProvider, TypeOrmModule],
})
export class PostgreSQLDatabaseModule {}
