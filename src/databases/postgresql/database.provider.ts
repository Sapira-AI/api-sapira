import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

@Injectable()
export class PostgreSQLDatabaseProvider implements OnModuleInit {
	private readonly logger = new Logger(PostgreSQLDatabaseProvider.name);

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource
	) {
		this.setupConnectionEvents();
	}

	/**
	 * Configura los eventos de monitoreo de la conexión
	 */
	private setupConnectionEvents(): void {
		if (!this.dataSource) return;

		// Manejar cierre de la aplicación
		process.on('SIGINT', async () => {
			try {
				if (this.dataSource.isInitialized) {
					await this.dataSource.destroy();
					this.logger.log(' Conexión PostgreSQL cerrada por terminación de la aplicación');
				}
			} catch (error) {
				this.logger.error('Error cerrando conexión PostgreSQL:', error);
			}
			process.exit(0);
		});

		process.on('SIGTERM', async () => {
			try {
				if (this.dataSource.isInitialized) {
					await this.dataSource.destroy();
					this.logger.log(' Conexión PostgreSQL cerrada por SIGTERM');
				}
			} catch (error) {
				this.logger.error('Error cerrando conexión PostgreSQL:', error);
			}
			process.exit(0);
		});

		// Configurar eventos de conexión usando el pool interno
		this.setupPoolEvents();
	}

	/**
	 * Configura eventos del pool de conexiones
	 */
	private setupPoolEvents(): void {
		try {
			// Acceder al pool de conexiones de manera segura
			const driver = this.dataSource.driver as any;
			const pool = driver?.master || driver?.pool;

			if (pool && typeof pool.on === 'function') {
				// Evento de conexión establecida
				pool.on('connect', (_client: any) => {
					this.logger.log('🟢 Nueva conexión PostgreSQL establecida', _client);
				});

				// Evento de error en el pool
				pool.on('error', (error: Error) => {
					this.logger.error('🔴 Error en pool PostgreSQL:', error.message);
				});

				// Evento cuando se adquiere una conexión del pool
				// pool.on('acquire', (_client: any) => {
				// 	this.logger.debug('📤 Conexión adquirida del pool');
				// });

				// Evento cuando se libera una conexión al pool
				// pool.on('release', (_client: any) => {
				// 	this.logger.debug('📥 Conexión liberada al pool');
				// });

				// Evento cuando se elimina una conexión del pool
				pool.on('remove', (_client: any) => {
					this.logger.debug('🗑️ Conexión removida del pool', _client);
				});
			}
		} catch (error) {
			this.logger.debug('No se pudieron configurar eventos del pool:', error.message);
		}
	}

	async onModuleInit() {
		try {
			if (this.dataSource.isInitialized) {
				this.logger.log(' Supabase PostgreSQL inicializado correctamente');

				// Obtener información de la conexión
				const dbInfo = await this.getDatabaseInfo();
				this.logger.log(` Base de datos: ${dbInfo.database_name}`);
				this.logger.log(` Usuario: ${dbInfo.username}`);
				this.logger.log(` Versión PostgreSQL: ${dbInfo.version.split(' ')[0]} ${dbInfo.version.split(' ')[1]}`);

				// Verificar estado del pool de conexiones
				this.logConnectionPoolStatus();
			}
		} catch (error) {
			this.logger.error(' Error conectando a Supabase PostgreSQL:', error);
			throw error;
		}
	}

	/**
	 * Registra el estado del pool de conexiones
	 */
	private logConnectionPoolStatus(): void {
		try {
			const driver = this.dataSource.driver as any;
			const pool = driver?.master || driver?.pool;

			if (pool) {
				const totalCount = pool.totalCount || pool._count || 'N/A';
				const idleCount = pool.idleCount || pool._idle?.length || 'N/A';
				const waitingCount = pool.waitingCount || pool._pendingAcquires?.length || 'N/A';

				this.logger.log(`🏊 Pool de conexiones - Total: ${totalCount}, Idle: ${idleCount}, Waiting: ${waitingCount}`);
			} else {
				this.logger.debug('🏊 Pool de conexiones - Información no disponible');
			}
		} catch (error) {
			// Silenciar errores de pool info si no está disponible
			this.logger.debug('No se pudo obtener información del pool:', error.message);
		}
	}

	/**
	 * Obtiene la instancia de DataSource de TypeORM
	 */
	getDataSource(): DataSource {
		return this.dataSource;
	}

	/**
	 * Ejecuta una consulta SQL raw
	 */
	async executeQuery(query: string, parameters?: any[]): Promise<any> {
		try {
			return await this.dataSource.query(query, parameters);
		} catch (error) {
			this.logger.error('Error ejecutando consulta SQL:', error);
			throw error;
		}
	}

	/**
	 * Inicia una transacción
	 */
	async startTransaction(): Promise<any> {
		const queryRunner = this.dataSource.createQueryRunner();
		await queryRunner.connect();
		await queryRunner.startTransaction();
		return queryRunner;
	}

	/**
	 * Confirma una transacción
	 */
	async commitTransaction(queryRunner: any): Promise<void> {
		await queryRunner.commitTransaction();
		await queryRunner.release();
	}

	/**
	 * Revierte una transacción
	 */
	async rollbackTransaction(queryRunner: any): Promise<void> {
		await queryRunner.rollbackTransaction();
		await queryRunner.release();
	}

	/**
	 * Verifica el estado de la conexión
	 */
	async checkConnection(): Promise<boolean> {
		try {
			await this.dataSource.query('SELECT 1');
			return true;
		} catch (error) {
			this.logger.error('Error verificando conexión PostgreSQL:', error);
			return false;
		}
	}

	/**
	 * Obtiene información de la base de datos
	 */
	async getDatabaseInfo(): Promise<any> {
		try {
			const result = await this.dataSource.query(`
				SELECT 
					version() as version,
					current_database() as database_name,
					current_user as username,
					inet_server_addr() as host,
					inet_server_port() as port
			`);
			return result[0];
		} catch (error) {
			this.logger.error('Error obteniendo información de la base de datos:', error);
			throw error;
		}
	}

	/**
	 * Lista todas las tablas existentes en la base de datos
	 */
	async listTables(): Promise<any[]> {
		try {
			return await this.dataSource.query(`
				SELECT 
					table_name,
					table_schema,
					table_type,
					is_insertable_into,
					is_typed
				FROM information_schema.tables 
				WHERE table_schema = 'public'
				ORDER BY table_name
			`);
		} catch (error) {
			this.logger.error('Error listando tablas:', error);
			throw error;
		}
	}

	/**
	 * Obtiene la estructura de una tabla específica
	 */
	async getTableStructure(tableName: string): Promise<any[]> {
		try {
			return await this.dataSource.query(
				`
				SELECT 
					column_name,
					data_type,
					is_nullable,
					column_default,
					character_maximum_length,
					numeric_precision,
					numeric_scale
				FROM information_schema.columns 
				WHERE table_schema = 'public' 
				AND table_name = $1
				ORDER BY ordinal_position
			`,
				[tableName]
			);
		} catch (error) {
			this.logger.error(`Error obteniendo estructura de tabla ${tableName}:`, error);
			throw error;
		}
	}

	/**
	 * Obtiene estadísticas de tablas
	 */
	async getTableStats(): Promise<any[]> {
		try {
			return await this.dataSource.query(`
				SELECT 
					schemaname,
					tablename,
					attname,
					n_distinct,
					correlation
				FROM pg_stats 
				WHERE schemaname = 'public'
				ORDER BY tablename, attname
			`);
		} catch (error) {
			this.logger.error('Error obteniendo estadísticas de tablas:', error);
			throw error;
		}
	}

	/**
	 * Monitorea la salud de la conexión periódicamente
	 */
	startHealthMonitoring(intervalMs: number = 60000): void {
		setInterval(async () => {
			try {
				const isHealthy = await this.checkConnection();
				if (!isHealthy) {
					this.logger.warn('⚠️ Conexión PostgreSQL no saludable');
				} else {
					this.logger.debug('💚 Conexión PostgreSQL saludable');
				}

				// Log del estado del pool cada minuto
				this.logConnectionPoolStatus();
			} catch (error) {
				this.logger.error('Error en monitoreo de salud:', error);
			}
		}, intervalMs);
	}

	/**
	 * Obtiene métricas de performance de la base de datos
	 */
	async getPerformanceMetrics(): Promise<any> {
		try {
			const [connections, activity, locks] = await Promise.all([
				// Conexiones activas
				this.dataSource.query(`
					SELECT count(*) as active_connections,
						   state,
						   application_name
					FROM pg_stat_activity 
					WHERE state IS NOT NULL 
					GROUP BY state, application_name
				`),

				// Actividad de la base de datos
				this.dataSource.query(`
					SELECT datname,
						   numbackends,
						   xact_commit,
						   xact_rollback,
						   blks_read,
						   blks_hit,
						   tup_returned,
						   tup_fetched,
						   tup_inserted,
						   tup_updated,
						   tup_deleted
					FROM pg_stat_database 
					WHERE datname = current_database()
				`),

				// Locks activos
				this.dataSource.query(`
					SELECT mode, count(*) as lock_count
					FROM pg_locks 
					GROUP BY mode
				`),
			]);

			return {
				connections,
				activity: activity[0],
				locks,
				timestamp: new Date().toISOString(),
			};
		} catch (error) {
			this.logger.error('Error obteniendo métricas de performance:', error);
			throw error;
		}
	}
}
