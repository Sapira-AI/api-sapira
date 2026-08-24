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

export const INTEGRACIONES_SALESFORCE_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	salesforce_sync_logs: {
		columns: {
			id: false,
			holding_id: true,
			sync_date: false,
			opportunities_count: true,
			accounts_count: true,
			success: true,
			error_message: true,
			execution_time_ms: true,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			salesforce_sync_logs_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_salesforce_sync_logs_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
};
