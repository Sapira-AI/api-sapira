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

export const LEGACY_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	invoices_legacy: {
		columns: {
			id: false,
			holding_id: false,
			company_id: false,
			client_id: true,
			client_tax_id: true,
			legal_client_name: false,
			source_type: false,
			source_system: true,
			invoice_number: false,
			issue_date: false,
			due_date: true,
			invoice_currency: false,
			amount_invoice_currency: false,
			total_invoice_currency: false,
			vat: true,
			fx_contract_to_invoice: true,
			status: false,
			pdf_url: true,
			notes: true,
			created_at: true,
			created_by: true,
			contract_id: true,
			reconciliation_status: true,
			reconciled_invoice_id: true,
			reconciled_at: true,
			client_entity_id: true,
			odoo_integration_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			invoices_legacy_company_id_fkey: {
				table: 'companies',
				onDelete: 'CASCADE',
			},
			fk_invoices_client_entity: {
				table: 'client_entities',
				onDelete: 'NO ACTION',
			},
			invoices_legacy_created_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
			invoices_legacy_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			invoices_legacy_client_id_fkey: {
				table: 'clients',
				onDelete: 'SET NULL',
			},
			invoices_legacy_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'SET NULL',
			},
			invoices_legacy_reconciled_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'SET NULL',
			},
		},
		uniques: {
			invoices_legacy_holding_invoice_number_unique: ['holding_id', 'invoice_number'],
			invoices_legacy_holding_odoo_integration_key: ['holding_id', 'odoo_integration_id'],
		},
		checks: ['invoices_legacy_reconciliation_status_check', 'invoices_legacy_source_type_check', 'invoices_legacy_status_check'],
		indexes: {
			idx_invoices_legacy_client_entity_id: {
				columns: ['client_entity_id'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_client_id: {
				columns: ['client_id'],
				unique: false,
				where: 'client_id IS NOT NULL',
			},
			idx_invoices_legacy_client_tax_id: {
				columns: ['client_tax_id'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_issue_date: {
				columns: ['issue_date'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_odoo_integration_id: {
				columns: ['odoo_integration_id'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_reconciliation_status: {
				columns: ['reconciliation_status'],
				unique: false,
				where: null,
			},
			idx_invoices_legacy_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_items_legacy: {
		columns: {
			id: false,
			invoices_legacy_id: false,
			holding_id: false,
			product_external_code: true,
			description: false,
			quantity: false,
			unit_price: false,
			discount_pct: true,
			tax_code: true,
			currency: true,
			subtotal: false,
			tax_amount: true,
			total: false,
			account_code: true,
			created_at: true,
			item_type: true,
			unit_of_measure: true,
			odoo_line_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_items_legacy_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_invoices_legacy_id_fkey: {
				table: 'invoices_legacy',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			invoice_items_legacy_holding_odoo_line_id_key: ['holding_id', 'odoo_line_id'],
		},
		checks: [],
		indexes: {
			idx_invoice_items_legacy_currency: {
				columns: ['currency'],
				unique: false,
				where: 'currency IS NOT NULL',
			},
			idx_invoice_items_legacy_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_invoice_items_legacy_holding_odoo_line: {
				columns: ['holding_id', 'odoo_line_id'],
				unique: false,
				where: null,
			},
			idx_invoice_items_legacy_invoice: {
				columns: ['invoices_legacy_id'],
				unique: false,
				where: null,
			},
			idx_invoice_items_legacy_item_type: {
				columns: ['item_type'],
				unique: false,
				where: 'item_type IS NOT NULL',
			},
			idx_invoice_items_legacy_odoo_line_id: {
				columns: ['odoo_line_id'],
				unique: false,
				where: null,
			},
			idx_invoice_items_legacy_product_code: {
				columns: ['product_external_code'],
				unique: false,
				where: 'product_external_code IS NOT NULL',
			},
			idx_invoice_items_legacy_unit_of_measure: {
				columns: ['unit_of_measure'],
				unique: false,
				where: 'unit_of_measure IS NOT NULL',
			},
		},
	},
	invoice_items_legacy_match: {
		columns: {
			id: false,
			invoice_item_legacy_id: false,
			contract_id: false,
			contract_item_id: true,
			product_id: true,
			contract_currency: false,
			fx_contract_to_invoice: false,
			amount_contract_currency: false,
			amount_invoice_currency: false,
			status: false,
			notes: true,
			created_by: false,
			created_at: true,
			confirmed_at: true,
			confirmed_by: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_items_legacy_match_created_by_fkey: {
				table: 'users',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_match_confirmed_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
			invoice_items_legacy_match_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_match_contract_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_match_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_match_invoice_item_legacy_id_fkey: {
				table: 'invoice_items_legacy',
				onDelete: 'CASCADE',
			},
			invoice_items_legacy_match_product_id_fkey: {
				table: 'products',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: ['invoice_items_legacy_match_status_check', 'match_amount_positive'],
		indexes: {
			idx_legacy_match_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_legacy_match_contract_item: {
				columns: ['contract_item_id'],
				unique: false,
				where: null,
			},
			idx_legacy_match_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_legacy_match_item: {
				columns: ['invoice_item_legacy_id'],
				unique: false,
				where: null,
			},
			idx_legacy_match_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	mrr_legacy: {
		columns: {
			id: false,
			holding_id: false,
			invoice_legacy_id: false,
			invoice_item_legacy_id: false,
			split_index: false,
			company_id: false,
			client_tax_id: false,
			legal_client_name: false,
			invoice_number: false,
			issue_date: false,
			invoice_currency: false,
			amount_invoice_currency: false,
			total_invoice_currency: false,
			vat: true,
			status: false,
			description: false,
			currency: false,
			quantity: true,
			unit_price: true,
			discount_pct: true,
			subtotal: false,
			allocated_invoice_currency: false,
			client_id: false,
			contract_currency: false,
			subtotal_contract_currency: false,
			product_name: false,
			term: false,
			period_month: false,
			is_recurring: false,
			fx_contract_to_invoice: false,
			fx_contract_to_system: true,
			mrr_legacy: true,
			mrr_legacy_system_currency: true,
			momentum: true,
			created_by: true,
			created_at: false,
			updated_at: false,
			migrated_to_contract_id: true,
			migrated_at: true,
			migrated_by: true,
			batch_id: false,
			skip_activation: false,
			skip_activation_reason: true,
			skip_activation_at: true,
			skip_activation_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			mrr_legacy_invoice_item_legacy_id_fkey: {
				table: 'invoice_items_legacy',
				onDelete: 'CASCADE',
			},
			mrr_legacy_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			mrr_legacy_client_id_fkey: {
				table: 'clients',
				onDelete: 'NO ACTION',
			},
			mrr_legacy_migrated_to_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'SET NULL',
			},
			mrr_legacy_migrated_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			mrr_legacy_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
			mrr_legacy_invoice_legacy_id_fkey: {
				table: 'invoices_legacy',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			mrr_legacy_invoice_item_legacy_id_split_index_period_month_key: ['invoice_item_legacy_id', 'split_index', 'period_month'],
		},
		checks: [
			'mrr_legacy_fx_valid',
			'mrr_legacy_momentum_check',
			'mrr_legacy_period_month_check',
			'mrr_legacy_split_index_check',
			'mrr_legacy_term_check',
		],
		indexes: {
			idx_mrr_legacy_batch_id: {
				columns: ['batch_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_client: {
				columns: ['client_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_company: {
				columns: ['company_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_invoice: {
				columns: ['invoice_legacy_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_invoice_created: {
				columns: ['invoice_legacy_id', 'created_at'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_invoice_item: {
				columns: ['invoice_item_legacy_id'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_migrated: {
				columns: ['migrated_to_contract_id'],
				unique: false,
				where: 'migrated_to_contract_id IS NOT NULL',
			},
			idx_mrr_legacy_not_migrated: {
				columns: ['client_id', 'invoice_legacy_id', 'created_at'],
				unique: false,
				where: 'migrated_to_contract_id IS NULL',
			},
			idx_mrr_legacy_period: {
				columns: ['period_month'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_product: {
				columns: ['product_name'],
				unique: false,
				where: null,
			},
			idx_mrr_legacy_recurring: {
				columns: ['is_recurring'],
				unique: false,
				where: 'is_recurring = true',
			},
			idx_mrr_legacy_skip_activation: {
				columns: ['skip_activation'],
				unique: false,
				where: 'skip_activation = true',
			},
		},
	},
};
