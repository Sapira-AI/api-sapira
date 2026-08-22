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

export const INTEGRACIONES_ODOO_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	odoo_object_mappings: {
		columns: {
			id: false,
			holding_id: false,
			odoo_object_type: false,
			odoo_object_id: false,
			sapira_table_name: false,
			sapira_record_id: false,
			created_at: false,
			updated_at: false,
			last_synced_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			odoo_object_mappings_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			unique_odoo_object_per_holding: ['holding_id', 'odoo_object_type', 'odoo_object_id'],
		},
		checks: [],
		indexes: {
			idx_odoo_object_mappings_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_odoo_object_mappings_odoo_lookup: {
				columns: ['holding_id', 'odoo_object_type', 'odoo_object_id'],
				unique: false,
				where: null,
			},
			idx_odoo_object_mappings_sapira_lookup: {
				columns: ['holding_id', 'sapira_table_name', 'sapira_record_id'],
				unique: false,
				where: null,
			},
		},
	},
};
