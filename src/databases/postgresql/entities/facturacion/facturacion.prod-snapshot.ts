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

export const FACTURACION_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	invoice_payments: {
		columns: {
			id: false,
			invoice_id: false,
			holding_id: false,
			amount: false,
			currency: false,
			payment_date: false,
			method: true,
			reference: true,
			notes: true,
			confirmed: false,
			created_by: true,
			created_at: false,
			bank_movement_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_payments_bank_movement_id_fkey: {
				table: 'bank_movements',
				onDelete: 'NO ACTION',
			},
			invoice_payments_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_invoice_payments_bank_movement: {
				columns: ['bank_movement_id'],
				unique: false,
				where: null,
			},
			idx_invoice_payments_holding_date: {
				columns: ['holding_id', 'payment_date'],
				unique: false,
				where: null,
			},
		},
	},
	billing_references: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			reference_type: false,
			reference_code: false,
			issuer: true,
			issue_date: true,
			valid_from: false,
			valid_to: true,
			covers_multiple_invoices: true,
			status: true,
			file_url: true,
			file_metadata: true,
			notes: true,
			created_at: true,
			updated_at: true,
			created_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			billing_references_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			billing_references_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			billing_references_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_billing_references_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_billing_references_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_billing_references_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	reference_requests: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			invoice_id: true,
			reference_type: false,
			status: false,
			file_url: true,
			note: true,
			requested_at: false,
			received_at: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {},
		checks: ['reference_requests_reference_type_check', 'reference_requests_status_check'],
		indexes: {
			reference_requests_holding_idx: {
				columns: ['holding_id', 'contract_id', 'invoice_id'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_reference_links: {
		columns: {
			id: false,
			invoice_id: false,
			reference_id: false,
			holding_id: false,
			linked_at: true,
			linked_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_reference_links_linked_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			invoice_reference_links_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
			invoice_reference_links_reference_id_fkey: {
				table: 'billing_references',
				onDelete: 'CASCADE',
			},
			invoice_reference_links_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			invoice_reference_links_invoice_id_reference_id_key: ['invoice_id', 'reference_id'],
		},
		checks: [],
		indexes: {
			idx_invoice_reference_links_invoice: {
				columns: ['invoice_id'],
				unique: false,
				where: null,
			},
			idx_invoice_reference_links_reference: {
				columns: ['reference_id'],
				unique: false,
				where: null,
			},
		},
	},
	quantities: {
		columns: {
			id: false,
			contract_item_id: false,
			holding_id: false,
			period: false,
			unit_price: true,
			unit_of_measure: true,
			quantity: true,
			created_at: false,
			updated_at: false,
			created_by: true,
			notes: true,
			contract_id: true,
			amount: true,
			salesforce_opportunity_id: true,
			salesforce_line_item_id: true,
			account: true,
		},
		primary: ['id'],
		foreignKeys: {
			quantities_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			quantities_contract_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'CASCADE',
			},
			quantities_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			quantities_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {
			quantities_unique_item_period: ['contract_item_id', 'period'],
		},
		checks: ['quantities_period_check', 'quantities_quantity_check', 'quantities_unit_price_check'],
		indexes: {
			quantities_contract_item_idx: {
				columns: ['contract_item_id'],
				unique: false,
				where: null,
			},
			quantities_holding_idx: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			quantities_period_idx: {
				columns: ['period'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_restructure_log: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			actor_user_id: true,
			action: false,
			payload: false,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_restructure_log_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'NO ACTION',
			},
			invoice_restructure_log_actor_user_id_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['invoice_restructure_log_action_check'],
		indexes: {},
	},
	invoice_reschedules: {
		columns: {
			id: false,
			invoice_id: false,
			holding_id: false,
			old_date: false,
			new_date: false,
			reason: false,
			changed_by: true,
			changed_at: true,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_reschedules_changed_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			invoice_reschedules_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			invoice_reschedules_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_invoice_reschedules_invoice_id: {
				columns: ['invoice_id'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_adjustments: {
		columns: {
			id: false,
			invoice_id: false,
			type: false,
			amount_diff: false,
			notes: true,
			adjusted_by: true,
			adjusted_at: false,
			holding_id: false,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_adjustments_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
			invoice_adjustments_adjusted_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['invoice_adjustments_type_check'],
		indexes: {
			idx_invoice_adjustments_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_invoice_adjustments_invoice_id: {
				columns: ['invoice_id'],
				unique: false,
				where: null,
			},
			idx_invoice_adjustments_type: {
				columns: ['type'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_emails: {
		columns: {
			id: false,
			invoice_id: false,
			template: false,
			recipient: false,
			subject: true,
			message: true,
			sent_by: true,
			sent_at: false,
			holding_id: false,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_emails_sent_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			invoice_emails_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['invoice_emails_template_check'],
		indexes: {
			idx_invoice_emails_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_invoice_emails_invoice_id: {
				columns: ['invoice_id'],
				unique: false,
				where: null,
			},
			idx_invoice_emails_template: {
				columns: ['template'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_collection_settings: {
		columns: {
			id: false,
			holding_id: false,
			dunning_enabled: false,
			email_from: true,
			bcc: true,
			reminder_days_before: false,
			reminder_days_after: false,
			email_subject_template: false,
			email_body_template: false,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			invoice_collection_settings_holding_id_key: ['holding_id'],
		},
		checks: [],
		indexes: {
			idx_invoice_collection_settings_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_collection_logs: {
		columns: {
			id: false,
			invoice_id: false,
			holding_id: false,
			recipients: false,
			subject: true,
			message: true,
			channel: false,
			status: false,
			sent_by: true,
			sent_at: false,
			metadata: false,
		},
		primary: ['id'],
		foreignKeys: {
			invoice_collection_logs_invoice_id_fkey: {
				table: 'invoices',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_invoice_collection_logs_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_invoice_collection_logs_invoice_id: {
				columns: ['invoice_id'],
				unique: false,
				where: null,
			},
		},
	},
	invoice_trigger_debug_logs: {
		columns: {
			id: false,
			trigger_name: false,
			operation: false,
			holding_id: true,
			odoo_id: true,
			raw_data_sample: true,
			processing_status: true,
			integration_notes: true,
			error_message: true,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {},
		checks: [],
		indexes: {},
	},
	overdue_check_log: {
		columns: {
			id: false,
			check_date: false,
			invoices_found: false,
			invoices_updated: false,
			holdings_affected: true,
			execution_time_ms: true,
			status: false,
			error_message: true,
			created_at: false,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			overdue_check_log_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['overdue_check_log_status_check'],
		indexes: {},
	},
	period_guard_warnings: {
		columns: {
			id: false,
			occurred_at: false,
			triggered_by: true,
			table_name: false,
			operation: false,
			contract_id: true,
			contract_item_id: true,
			holding_id: true,
			company_id: true,
			cutoff_date: true,
			fields_changed: true,
			message: false,
			payload: true,
		},
		primary: ['id'],
		foreignKeys: {
			period_guard_warnings_triggered_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: [],
		indexes: {},
	},
};
