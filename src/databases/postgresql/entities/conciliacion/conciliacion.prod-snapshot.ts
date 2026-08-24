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

export const CONCILIACION_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	bank_movements: {
		columns: {
			id: false,
			company_id: true,
			bank_name: true,
			bank_account: true,
			movement_date: true,
			description: true,
			amount: true,
			currency: true,
			status: true,
			suggested_invoice_id: true,
			created_at: true,
			holding_id: true,
			batch_id: true,
			reconciled_invoice_id: true,
			reconciled_at: true,
			reconciled_by: true,
			match_confidence: true,
			match_score: true,
			original_row_data: true,
		},
		primary: ['id'],
		foreignKeys: {
			bank_movements_reconciled_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			fk_bank_movements_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			bank_movements_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
			bank_movements_suggested_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'NO ACTION',
			},
			bank_movements_batch_id_fkey: {
				table: 'bank_upload_batches',
				onDelete: 'CASCADE',
			},
			bank_movements_reconciled_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['bank_movements_match_confidence_check', 'bank_movements_status_check'],
		indexes: {
			idx_bank_movements_batch_id: {
				columns: ['batch_id'],
				unique: false,
				where: null,
			},
			idx_bank_movements_holding_date: {
				columns: ['holding_id', 'movement_date'],
				unique: false,
				where: null,
			},
			idx_bank_movements_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_bank_movements_reconciled_invoice: {
				columns: ['reconciled_invoice_id'],
				unique: false,
				where: null,
			},
			idx_bank_movements_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	bank_upload_batches: {
		columns: {
			id: false,
			holding_id: false,
			company_id: true,
			bank_account_id: true,
			file_name: false,
			file_hash: true,
			row_count: false,
			column_mapping: false,
			status: false,
			uploaded_by: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			bank_upload_batches_uploaded_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			bank_upload_batches_bank_account_id_fkey: {
				table: 'company_bank_accounts',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['bank_upload_batches_status_check'],
		indexes: {},
	},
	bank_column_mappings: {
		columns: {
			id: false,
			holding_id: false,
			bank_name: false,
			mapping_name: false,
			column_mapping: false,
			is_default: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {},
		checks: [],
		indexes: {},
	},
};
