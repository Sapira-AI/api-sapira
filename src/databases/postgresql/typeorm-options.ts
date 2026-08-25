import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';

import * as mirrorEntities from './entities/espejo.index';

export type SchemaSyncEnvironment = 'development' | 'test' | 'qa' | 'production';

export type PostgreSqlEnvironment = Record<string, string | boolean | number | undefined>;

const isEnabled = (value: unknown): boolean => value === true || value === 'true';

const toNumber = (value: unknown, fallback: number): number => {
	if (typeof value === 'number') return value;
	if (!value) return fallback;

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

export function getSchemaSyncEnvironment(environment: PostgreSqlEnvironment): SchemaSyncEnvironment {
	const value = environment.NODE_ENV ?? 'development';
	return value === 'production' || value === 'qa' || value === 'test' ? value : 'development';
}

/**
 * Bloquea synchronize en producción salvo que el deploy lo autorice de forma
 * explícita después de QA. Esta protección aplica tanto a Nest como a los CLI.
 */
export function resolveSchemaSynchronization(environment: PostgreSqlEnvironment): boolean {
	const synchronize = isEnabled(environment.TYPEORM_SCHEMA_SYNC);
	if (!synchronize) return false;

	if (!environment.SUPABASE_DATABASE_URL) {
		throw new Error('TYPEORM_SCHEMA_SYNC=true requiere SUPABASE_DATABASE_URL.');
	}

	if (getSchemaSyncEnvironment(environment) !== 'production') return true;

	const productionEnabled =
		isEnabled(environment.TYPEORM_ALLOW_PROD_SYNC) &&
		isEnabled(environment.TYPEORM_SCHEMA_BACKUP_CONFIRMED) &&
		environment.SCHEMA_SYNC_CONFIRMATION === 'production';

	if (!productionEnabled) {
		throw new Error(
			'La sincronización en producción requiere TYPEORM_ALLOW_PROD_SYNC=true, TYPEORM_SCHEMA_BACKUP_CONFIRMED=true y SCHEMA_SYNC_CONFIRMATION=production.'
		);
	}

	return true;
}

export function createPostgreSqlOptions(environment: PostgreSqlEnvironment): TypeOrmModuleOptions {
	const url = environment.SUPABASE_DATABASE_URL;
	if (typeof url !== 'string' || !url) {
		throw new Error('SUPABASE_DATABASE_URL no está configurada.');
	}

	const synchronize = resolveSchemaSynchronization(environment);
	// Los espejos se habilitan por lote mediante un flag independiente. No se
	// promueven masivamente solo por activar synchronize en QA.
	const loadMirrors = isEnabled(environment.TYPEORM_LOAD_MIRROR_ENTITIES);

	return {
		type: 'postgres',
		url,
		entities: [__dirname + '/../../**/*.entity{.ts,.js}', ...(loadMirrors ? Object.values(mirrorEntities) : [])],
		autoLoadEntities: true,
		synchronize,
		logging: isEnabled(environment.SUPABASE_LOGGING) ? ['error', 'schema', 'warn', 'info', 'log'] : false,
		ssl: { rejectUnauthorized: false },
		retryAttempts: 5,
		retryDelay: 5000,
		extra: {
			max: toNumber(environment.SUPABASE_POOL_MAX, 20),
			min: toNumber(environment.SUPABASE_POOL_MIN, 2),
			idleTimeoutMillis: toNumber(environment.SUPABASE_IDLE_TIMEOUT, 300000),
			connectionTimeoutMillis: toNumber(environment.SUPABASE_CONNECTION_TIMEOUT, 60000),
			acquireTimeoutMillis: toNumber(environment.SUPABASE_ACQUIRE_TIMEOUT, 60000),
			evictionRunIntervalMillis: 10000,
			softIdleTimeoutMillis: 30000,
			statement_timeout: 30000,
			query_timeout: 30000,
		},
	};
}

export function createPostgreSqlCliOptions(environment: PostgreSqlEnvironment): DataSourceOptions {
	const { autoLoadEntities: _autoLoadEntities, retryAttempts: _retryAttempts, retryDelay: _retryDelay, ...options } =
		createPostgreSqlOptions(environment);

	return options as DataSourceOptions;
}
