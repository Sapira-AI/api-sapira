import { GenericRLSService, TableRLSConfig } from '../services/generic-rls.service';

/**
 * Configuraciones RLS para todas las tablas del sistema
 */
export class RLSConfigurations {
	/**
	 * Configuración para integration_logs
	 */
	static getIntegrationLogsConfig(): TableRLSConfig {
		return GenericRLSService.createHoldingBasedConfig('integration_logs', [
			// Política adicional para permitir que service_role haga todo
			{
				tableName: 'integration_logs',
				policyName: 'Service role can manage all integration logs',
				command: 'ALL',
				roles: ['service_role'],
			},
		]);
	}

	/**
	 * Configuración para user_profiles
	 */
	static getUserProfilesConfig(): TableRLSConfig {
		return GenericRLSService.createUserBasedConfig('user_profiles');
	}

	/**
	 * Configuración para odoo_invoices
	 */
	static getOdooInvoicesConfig(): TableRLSConfig {
		return GenericRLSService.createHoldingBasedConfig('odoo_invoices', [
			// Política adicional para lectura por conexión
			{
				tableName: 'odoo_invoices',
				policyName: 'Users can view invoices by connection',
				command: 'SELECT',
				using: `connection_id IN (
					SELECT oc.id
					FROM odoo_connections oc
					JOIN user_holdings uh ON oc.holding_id = uh.holding_id
					WHERE uh.user_id = auth.uid()
				)`,
				roles: ['public'],
			},
		]);
	}

	/**
	 * Configuración para company_holdings
	 */
	static getCompanyHoldingsConfig(): TableRLSConfig {
		return {
			tableName: 'company_holdings',
			enableRLS: true,
			policies: [
				{
					tableName: 'company_holdings',
					policyName: 'Users can view their assigned holdings',
					command: 'SELECT',
					using: `id IN (
						SELECT holding_id
						FROM user_holdings
						WHERE user_id = auth.uid()
					)`,
					roles: ['public'],
				},
				// Solo admins pueden crear/modificar holdings
				{
					tableName: 'company_holdings',
					policyName: 'Only admins can manage holdings',
					command: 'INSERT',
					withCheck: `auth.jwt() ->> 'role' = 'admin'`,
					roles: ['public'],
				},
				{
					tableName: 'company_holdings',
					policyName: 'Only admins can update holdings',
					command: 'UPDATE',
					using: `auth.jwt() ->> 'role' = 'admin'`,
					roles: ['public'],
				},
			],
		};
	}

	/**
	 * Configuración para audit_logs (solo lectura para usuarios)
	 */
	static getAuditLogsConfig(): TableRLSConfig {
		return {
			tableName: 'audit_logs',
			enableRLS: true,
			policies: [
				{
					tableName: 'audit_logs',
					policyName: 'Users can view audit logs from their holding',
					command: 'SELECT',
					using: `holding_id IN (
						SELECT holding_id
						FROM user_holdings
						WHERE user_id = auth.uid()
					)`,
					roles: ['public'],
				},
				// Solo el sistema puede insertar audit logs
				{
					tableName: 'audit_logs',
					policyName: 'Only service role can create audit logs',
					command: 'INSERT',
					roles: ['service_role'],
				},
			],
		};
	}

	/**
	 * Configuración para workspace_members
	 */
	static getWorkspaceMembersConfig(): TableRLSConfig {
		return {
			tableName: 'workspace_members',
			enableRLS: true,
			policies: [
				{
					tableName: 'workspace_members',
					policyName: 'Users can view workspace members where they belong',
					command: 'SELECT',
					using: `workspace_id IN (
						SELECT workspace_id
						FROM workspace_members
						WHERE user_id = auth.uid()
					)`,
					roles: ['public'],
				},
				{
					tableName: 'workspace_members',
					policyName: 'Workspace owners can manage members',
					command: 'ALL',
					using: `workspace_id IN (
						SELECT workspace_id
						FROM workspace_members
						WHERE user_id = auth.uid() AND role = 'owner'
					)`,
					roles: ['public'],
				},
			],
		};
	}

	/**
	 * Obtiene todas las configuraciones disponibles
	 */
	static getAllConfigurations(): Record<string, TableRLSConfig> {
		return {
			integration_logs: this.getIntegrationLogsConfig(),
			user_profiles: this.getUserProfilesConfig(),
			odoo_invoices: this.getOdooInvoicesConfig(),
			company_holdings: this.getCompanyHoldingsConfig(),
			audit_logs: this.getAuditLogsConfig(),
			workspace_members: this.getWorkspaceMembersConfig(),
		};
	}

	/**
	 * Registra todas las configuraciones en el servicio RLS
	 */
	static registerAllConfigurations(rlsService: GenericRLSService): void {
		const configurations = this.getAllConfigurations();

		Object.values(configurations).forEach((config) => {
			rlsService.registerTableConfig(config);
		});

		console.log(`📝 Registradas ${Object.keys(configurations).length} configuraciones RLS`);
	}
}
