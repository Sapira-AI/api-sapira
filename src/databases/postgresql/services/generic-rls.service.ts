import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface RLSPolicy {
	tableName: string;
	policyName: string;
	command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
	using?: string;
	withCheck?: string;
	roles?: string[];
}

export interface TableRLSConfig {
	tableName: string;
	enableRLS: boolean;
	policies: RLSPolicy[];
	indexes?: string[];
}

@Injectable()
export class GenericRLSService {
	constructor(private readonly dataSource: DataSource) {}

	/**
	 * Configuraciones de RLS por tabla
	 */
	private readonly tableConfigs: Record<string, TableRLSConfig> = {
		integration_logs: {
			tableName: 'integration_logs',
			enableRLS: true,
			policies: [
				{
					tableName: 'integration_logs',
					policyName: 'Users can view integration logs from their holding',
					command: 'SELECT',
					using: `holding_id IN (
						SELECT user_holdings.holding_id
						FROM user_holdings
						WHERE user_holdings.user_id = auth.uid()
					)`,
					roles: ['public'],
				},
				{
					tableName: 'integration_logs',
					policyName: 'Users can create integration logs for their holding',
					command: 'INSERT',
					withCheck: `holding_id IN (
						SELECT user_holdings.holding_id
						FROM user_holdings
						WHERE user_holdings.user_id = auth.uid()
					)`,
					roles: ['public'],
				},
				{
					tableName: 'integration_logs',
					policyName: 'Users can update integration logs from their holding',
					command: 'UPDATE',
					using: `holding_id IN (
						SELECT user_holdings.holding_id
						FROM user_holdings
						WHERE user_holdings.user_id = auth.uid()
					)`,
					roles: ['public'],
				},
			],
			indexes: [
				'CREATE INDEX IF NOT EXISTS idx_integration_logs_integration_type ON integration_logs (integration_type)',
				'CREATE INDEX IF NOT EXISTS idx_integration_logs_connection_id ON integration_logs (connection_id)',
				'CREATE INDEX IF NOT EXISTS idx_integration_logs_progress_total ON integration_logs (progress_total)',
			],
		},
		// Ejemplo para otra tabla
		user_profiles: {
			tableName: 'user_profiles',
			enableRLS: true,
			policies: [
				{
					tableName: 'user_profiles',
					policyName: 'Users can view their own profile',
					command: 'SELECT',
					using: 'user_id = auth.uid()',
					roles: ['public'],
				},
				{
					tableName: 'user_profiles',
					policyName: 'Users can update their own profile',
					command: 'UPDATE',
					using: 'user_id = auth.uid()',
					roles: ['public'],
				},
			],
		},
		// Ejemplo para tabla con holding_id
		company_data: {
			tableName: 'company_data',
			enableRLS: true,
			policies: [
				{
					tableName: 'company_data',
					policyName: 'Users can access company data from their holding',
					command: 'ALL',
					using: `holding_id IN (
						SELECT user_holdings.holding_id
						FROM user_holdings
						WHERE user_holdings.user_id = auth.uid()
					)`,
					roles: ['public'],
				},
			],
		},
	};

	/**
	 * Aplica políticas RLS para una tabla específica
	 */
	async applyTablePolicies(tableName: string): Promise<void> {
		const config = this.tableConfigs[tableName];
		if (!config) {
			throw new Error(`No hay configuración RLS para la tabla: ${tableName}`);
		}

		const queryRunner = this.dataSource.createQueryRunner();

		try {
			// Habilitar RLS si está configurado
			if (config.enableRLS) {
				await queryRunner.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;`);
				console.log(`✅ RLS habilitado para tabla: ${tableName}`);
			}

			// Aplicar cada política
			for (const policy of config.policies) {
				await this.createPolicy(queryRunner, policy);
			}

			// Crear índices adicionales si están definidos
			if (config.indexes && config.indexes.length > 0) {
				for (const indexSQL of config.indexes) {
					await queryRunner.query(indexSQL);
				}
				console.log(`✅ Índices creados para tabla: ${tableName}`);
			}

			console.log(`✅ Políticas RLS aplicadas exitosamente para: ${tableName}`);
		} catch (error) {
			console.error(`❌ Error aplicando políticas RLS para ${tableName}:`, error);
			throw error;
		} finally {
			await queryRunner.release();
		}
	}

	/**
	 * Aplica políticas RLS para todas las tablas configuradas
	 */
	async applyAllTablePolicies(): Promise<void> {
		const tableNames = Object.keys(this.tableConfigs);
		console.log(`🔒 Aplicando políticas RLS para ${tableNames.length} tablas...`);

		for (const tableName of tableNames) {
			try {
				await this.applyTablePolicies(tableName);
			} catch (error) {
				console.error(`❌ Error en tabla ${tableName}:`, error);
				// Continuar con las demás tablas
			}
		}

		console.log('🎉 Proceso de aplicación de políticas RLS completado');
	}

	/**
	 * Elimina políticas RLS para una tabla específica
	 */
	async removeTablePolicies(tableName: string): Promise<void> {
		const config = this.tableConfigs[tableName];
		if (!config) {
			throw new Error(`No hay configuración RLS para la tabla: ${tableName}`);
		}

		const queryRunner = this.dataSource.createQueryRunner();

		try {
			// Eliminar cada política
			for (const policy of config.policies) {
				await queryRunner.query(`DROP POLICY IF EXISTS "${policy.policyName}" ON ${tableName};`);
			}

			// Deshabilitar RLS si estaba habilitado
			if (config.enableRLS) {
				await queryRunner.query(`ALTER TABLE ${tableName} DISABLE ROW LEVEL SECURITY;`);
			}

			console.log(`✅ Políticas RLS eliminadas exitosamente para: ${tableName}`);
		} catch (error) {
			console.error(`❌ Error eliminando políticas RLS para ${tableName}:`, error);
			throw error;
		} finally {
			await queryRunner.release();
		}
	}

	/**
	 * Registra una nueva configuración de tabla
	 */
	registerTableConfig(config: TableRLSConfig): void {
		this.tableConfigs[config.tableName] = config;
		console.log(`📝 Configuración RLS registrada para tabla: ${config.tableName}`);
	}

	/**
	 * Obtiene la configuración de una tabla
	 */
	getTableConfig(tableName: string): TableRLSConfig | undefined {
		return this.tableConfigs[tableName];
	}

	/**
	 * Lista todas las tablas configuradas
	 */
	getConfiguredTables(): string[] {
		return Object.keys(this.tableConfigs);
	}

	/**
	 * Verifica el estado de las políticas RLS para una tabla
	 */
	async checkTablePoliciesStatus(tableName: string): Promise<any[]> {
		const queryRunner = this.dataSource.createQueryRunner();

		try {
			const policies = await queryRunner.query(
				`
				SELECT 
					schemaname,
					tablename,
					policyname,
					permissive,
					roles,
					cmd,
					qual,
					with_check
				FROM pg_policies 
				WHERE tablename = $1
				ORDER BY policyname;
			`,
				[tableName]
			);

			return policies;
		} finally {
			await queryRunner.release();
		}
	}

	/**
	 * Crea una política RLS individual
	 */
	private async createPolicy(queryRunner: any, policy: RLSPolicy): Promise<void> {
		// Eliminar política existente si existe
		await queryRunner.query(`DROP POLICY IF EXISTS "${policy.policyName}" ON ${policy.tableName};`);

		// Construir comando CREATE POLICY
		let policySQL = `CREATE POLICY "${policy.policyName}" ON ${policy.tableName}`;

		if (policy.command !== 'ALL') {
			policySQL += ` FOR ${policy.command}`;
		}

		if (policy.roles && policy.roles.length > 0) {
			policySQL += ` TO ${policy.roles.join(', ')}`;
		}

		if (policy.using) {
			policySQL += ` USING (${policy.using})`;
		}

		if (policy.withCheck) {
			policySQL += ` WITH CHECK (${policy.withCheck})`;
		}

		policySQL += ';';

		await queryRunner.query(policySQL);
		console.log(`✅ Política creada: ${policy.policyName}`);
	}

	/**
	 * Genera configuración RLS estándar para tabla con holding_id
	 */
	static createHoldingBasedConfig(tableName: string, additionalPolicies: RLSPolicy[] = []): TableRLSConfig {
		const standardPolicies: RLSPolicy[] = [
			{
				tableName,
				policyName: `Users can view ${tableName} from their holding`,
				command: 'SELECT',
				using: `holding_id IN (
					SELECT user_holdings.holding_id
					FROM user_holdings
					WHERE user_holdings.user_id = auth.uid()
				)`,
				roles: ['public'],
			},
			{
				tableName,
				policyName: `Users can create ${tableName} for their holding`,
				command: 'INSERT',
				withCheck: `holding_id IN (
					SELECT user_holdings.holding_id
					FROM user_holdings
					WHERE user_holdings.user_id = auth.uid()
				)`,
				roles: ['public'],
			},
			{
				tableName,
				policyName: `Users can update ${tableName} from their holding`,
				command: 'UPDATE',
				using: `holding_id IN (
					SELECT user_holdings.holding_id
					FROM user_holdings
					WHERE user_holdings.user_id = auth.uid()
				)`,
				roles: ['public'],
			},
		];

		return {
			tableName,
			enableRLS: true,
			policies: [...standardPolicies, ...additionalPolicies],
		};
	}

	/**
	 * Genera configuración RLS estándar para tabla con user_id
	 */
	static createUserBasedConfig(tableName: string, additionalPolicies: RLSPolicy[] = []): TableRLSConfig {
		const standardPolicies: RLSPolicy[] = [
			{
				tableName,
				policyName: `Users can access their own ${tableName}`,
				command: 'ALL',
				using: 'user_id = auth.uid()',
				roles: ['public'],
			},
		];

		return {
			tableName,
			enableRLS: true,
			policies: [...standardPolicies, ...additionalPolicies],
		};
	}
}
