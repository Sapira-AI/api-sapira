/**
 * Snapshot de prod (`hklompkypzqtglprfobu`, schema public) tomado el 2026-08-22 vía MCP de Supabase (`list_tables verbose` + `execute_sql` de solo lectura sobre pg_catalog).
 * Solo las tablas espejadas (sin entity previa). Generado por scripts/espejo/generate-espejo.py — el spec compara la metadata TypeORM contra él sin conectarse.
 */
export interface ProdTableSnapshot {
	columns: Record<string, boolean>;
	primary: string[];
	foreignKeys: Record<string, { table: string; onDelete: string }>;
	uniques: Record<string, string[]>;
	checks: string[];
	indexes: Record<string, { columns: string[]; unique: boolean; where: string | null }>;
}

export const INTEGRACIONES_OTRAS_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	integration_configs: {
		columns: {
			id: false,
			company_id: true,
			service_name: true,
			status: true,
			last_sync_at: true,
			created_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_integration_configs_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			integration_configs_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['integration_configs_status_check'],
		indexes: {
			idx_integration_configs_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
};
