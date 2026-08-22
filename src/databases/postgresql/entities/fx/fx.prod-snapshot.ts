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

export const FX_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	holding_fx_period_rates: {
		columns: {
			id: false,
			holding_id: false,
			from_currency: false,
			to_currency: false,
			rate: false,
			period_start: false,
			period_end: false,
			notes: true,
			created_by: true,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			holding_fx_period_rates_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			holding_fx_period_rates_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			holding_fx_period_rates_unique_period: ['holding_id', 'from_currency', 'to_currency', 'period_start', 'period_end'],
		},
		checks: ['holding_fx_period_rates_period_check', 'holding_fx_period_rates_rate_check'],
		indexes: {
			idx_holding_fx_period_rates_currencies: {
				columns: ['from_currency', 'to_currency'],
				unique: false,
				where: null,
			},
			idx_holding_fx_period_rates_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_holding_fx_period_rates_period: {
				columns: ['period_start', 'period_end'],
				unique: false,
				where: null,
			},
		},
	},
	contract_fx_period_rates: {
		columns: {
			id: false,
			contract_id: false,
			holding_id: false,
			from_currency: false,
			to_currency: false,
			rate: false,
			period_start: false,
			period_end: false,
			notes: true,
			created_by: true,
			created_at: true,
			updated_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_fx_period_rates_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			fk_contract_fx_period_rates_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['contract_fx_period_rates_check', 'contract_fx_period_rates_rate_check'],
		indexes: {
			idx_contract_fx_rates_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_fx_rates_currencies: {
				columns: ['from_currency', 'to_currency'],
				unique: false,
				where: null,
			},
			idx_contract_fx_rates_holding_contract: {
				columns: ['holding_id', 'contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_fx_rates_period: {
				columns: ['period_start', 'period_end'],
				unique: false,
				where: null,
			},
		},
	},
	fx_api_sync_log: {
		columns: {
			id: false,
			holding_id: true,
			sync_date: false,
			api_source: false,
			currencies_synced: true,
			records_created: true,
			records_updated: true,
			status: false,
			error_details: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			fx_api_sync_log_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['fx_api_sync_log_status_check'],
		indexes: {},
	},
};
