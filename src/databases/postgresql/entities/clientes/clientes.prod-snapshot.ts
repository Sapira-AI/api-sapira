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

export const CLIENTES_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	contact_preferences: {
		columns: {
			id: false,
			holding_id: false,
			client_id: false,
			contact_id: false,
			allow_billing_emails: false,
			allow_proforma: false,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			contact_preferences_holding_id_client_id_contact_id_key: ['holding_id', 'client_id', 'contact_id'],
		},
		checks: [],
		indexes: {
			contact_preferences_holding_idx: {
				columns: ['holding_id', 'client_id'],
				unique: false,
				where: null,
			},
		},
	},
	client_documents: {
		columns: {
			id: false,
			client_id: true,
			document_name: true,
			file_url: true,
			uploaded_at: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			fk_client_documents_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			client_documents_client_id_fkey: {
				table: 'clients',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_client_documents_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	company_legal_documents: {
		columns: {
			id: false,
			company_id: false,
			document_name: false,
			document_type: false,
			upload_date: false,
			file_url: true,
			created_at: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			company_legal_documents_company_id_fkey: {
				table: 'companies',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {},
	},
	client_entity_tax_id_normalization_conflicts: {
		columns: {
			id: false,
			migration_name: false,
			holding_id: false,
			client_entity_id: false,
			conflicting_client_entity_ids: false,
			tax_id_current: false,
			tax_id_normalized: false,
			detected_at: false,
			resolved_at: true,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			client_entity_tax_id_normaliz_migration_name_client_entity__key: ['migration_name', 'client_entity_id'],
		},
		checks: [],
		indexes: {},
	},
	company_bank_accounts: {
		columns: {
			id: false,
			company_id: false,
			bank_name: false,
			account_type: false,
			account_number: false,
			currency: false,
			account_holder: true,
			created_at: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			company_bank_accounts_company_id_fkey: {
				table: 'companies',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {},
	},
	company_account_mappings: {
		columns: {
			id: false,
			company_id: false,
			revenue_account_code: false,
			revenue_account_name: false,
			unbilled_account_code: false,
			unbilled_account_name: false,
			deferred_account_code: false,
			deferred_account_name: false,
			external_revenue_code: true,
			external_unbilled_code: true,
			external_deferred_code: true,
			created_at: true,
			updated_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			company_account_mappings_company_id_fkey: {
				table: 'companies',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			unique_company_mapping: ['company_id'],
		},
		checks: [],
		indexes: {
			idx_company_account_mappings_company: {
				columns: ['company_id'],
				unique: false,
				where: null,
			},
		},
	},
};
