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

export const CONTRATOS_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	contract_items: {
		columns: {
			id: false,
			contract_id: true,
			product_id: true,
			product_name: false,
			term_months: true,
			currency: true,
			price: true,
			discount_type: true,
			discount_value: true,
			final_price: true,
			billing_method: true,
			billing_frequency: true,
			start_date: true,
			quote_item_id: true,
			holding_id: false,
			end_date: true,
			renews_item_id: true,
			renewed_by_item_id: true,
			is_recurring: false,
			categoria: true,
			related_item_id: true,
			item_type: true,
			unit_of_measure: true,
			unit_price: true,
			quantity: true,
			account: true,
			custom_fields: true,
			churn_date: true,
			churn_monthly_amount: true,
			monthly_price: true,
			billing_period_price: true,
			auto_renew: false,
			auto_renew_term_months: true,
			auto_renewed_at: true,
			quote_item_number: true,
			annual_unit_price: true,
			annual_price: true,
			price_entry_mode: true,
			booking_date: true,
			renewal_base_unit_price: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_contract_items_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			contract_items_renewed_by_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'NO ACTION',
			},
			contract_items_renews_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'NO ACTION',
			},
			contract_items_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			contract_items_product_id_fkey: {
				table: 'products',
				onDelete: 'NO ACTION',
			},
			contract_items_quote_item_id_fkey: {
				table: 'quote_items',
				onDelete: 'NO ACTION',
			},
			contract_items_related_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: [
			'chk_contract_items_price_entry_mode',
			'contract_items_billing_frequency_check',
			'contract_items_billing_method_check',
			'contract_items_categoria_check',
			'contract_items_discount_type_check',
		],
		indexes: {
			idx_contract_items_auto_renew_end_date: {
				columns: ['auto_renew', 'end_date'],
				unique: false,
				where: 'auto_renew = true',
			},
			idx_contract_items_categoria: {
				columns: ['categoria'],
				unique: false,
				where: null,
			},
			idx_contract_items_churn_date: {
				columns: ['churn_date'],
				unique: false,
				where: 'churn_date IS NOT NULL',
			},
			idx_contract_items_contract_end_date: {
				columns: ['contract_id', 'end_date'],
				unique: false,
				where: null,
			},
			idx_contract_items_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_contract_items_monthly_price: {
				columns: ['monthly_price'],
				unique: false,
				where: '(monthly_price IS NOT NULL) AND (is_recurring = true)',
			},
			idx_contract_items_quote_item_id: {
				columns: ['quote_item_id'],
				unique: false,
				where: null,
			},
			idx_contract_items_quote_item_number: {
				columns: ['quote_item_number'],
				unique: false,
				where: 'quote_item_number IS NOT NULL',
			},
			idx_contract_items_recurring_dates: {
				columns: ['is_recurring', 'start_date', 'end_date'],
				unique: false,
				where: 'is_recurring = true',
			},
			idx_contract_items_related: {
				columns: ['related_item_id'],
				unique: false,
				where: 'related_item_id IS NOT NULL',
			},
		},
	},
	contract_amendments: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			type: false,
			reason: true,
			effective_date: false,
			status: false,
			requested_by: true,
			approved_by: true,
			approval_required: false,
			metadata: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			contract_amendments_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			contract_amendments_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_amendments_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_amendments_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_contract_amendments_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	contract_amendment_items: {
		columns: {
			id: false,
			holding_id: false,
			amendment_id: false,
			original_item_id: true,
			new_item_id: true,
			scope: true,
			quantity_delta: true,
			price_delta: true,
			start_date_override: true,
			end_date_override: true,
			notes: true,
			item_metadata: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			contract_amendment_items_amendment_id_fkey: {
				table: 'contract_amendments',
				onDelete: 'CASCADE',
			},
			contract_amendment_items_original_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'NO ACTION',
			},
			contract_amendment_items_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			contract_amendment_items_new_item_id_fkey: {
				table: 'contract_items',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_amendment_items_amendment: {
				columns: ['amendment_id'],
				unique: false,
				where: null,
			},
			idx_amendment_items_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_amendment_items_new: {
				columns: ['new_item_id'],
				unique: false,
				where: null,
			},
			idx_amendment_items_original: {
				columns: ['original_item_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_lifecycle_events: {
		columns: {
			id: false,
			contract_id: false,
			event_type: false,
			event_status: false,
			title: false,
			description: true,
			created_by: false,
			approved_by: true,
			client_approval_required: true,
			client_approved_at: true,
			client_approved_by: true,
			internal_approval_required: true,
			internal_approved_at: true,
			internal_approved_by: true,
			completed_at: true,
			metadata: true,
			holding_id: false,
			created_at: false,
			updated_at: false,
			effective_date: true,
			amount_delta: true,
			summary: true,
			items_affected: true,
			event_subtype: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_lifecycle_events_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			contract_lifecycle_events_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_lifecycle_events_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_lifecycle_events_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_change_log: {
		columns: {
			id: false,
			contract_id: false,
			company_id: false,
			holding_id: false,
			changed_at: false,
			changed_by: true,
			changed_by_name: true,
			changed_by_email: true,
			change_type: false,
			fields_changed: true,
			before_values: true,
			after_values: true,
			reason: true,
			source: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_change_log_changed_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: ['contract_change_log_change_type_check'],
		indexes: {},
	},
	contract_item_change_log: {
		columns: {
			id: false,
			contract_item_id: false,
			contract_id: false,
			company_id: false,
			holding_id: false,
			changed_at: false,
			changed_by: true,
			changed_by_name: true,
			changed_by_email: true,
			change_type: false,
			fields_changed: true,
			before_values: true,
			after_values: true,
			reason: true,
			source: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_item_change_log_changed_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: ['contract_item_change_log_change_type_check'],
		indexes: {},
	},
	contract_workflow_history: {
		columns: {
			id: false,
			contract_id: false,
			workflow_step_id: true,
			user_id: true,
			status: false,
			comments: true,
			completed_at: true,
			created_at: false,
			metadata: true,
			files_attached: true,
			previous_step_id: true,
			transition_type: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_workflow_history_previous_step_id_fkey: {
				table: 'workflow_steps',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['contract_workflow_history_transition_type_check'],
		indexes: {
			idx_contract_workflow_history_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_workflow_history_created_at: {
				columns: ['created_at'],
				unique: false,
				where: null,
			},
			idx_contract_workflow_history_step_id: {
				columns: ['workflow_step_id'],
				unique: false,
				where: null,
			},
			idx_contract_workflow_history_user_id: {
				columns: ['user_id'],
				unique: false,
				where: null,
			},
		},
	},
	workflow_steps: {
		columns: {
			id: false,
			holding_id: false,
			name: false,
			description: true,
			order_index: false,
			assigned_user_ids: true,
			requires_manual_approval: true,
			is_client_step: true,
			client_email: true,
			color: true,
			is_active: true,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {},
		checks: [],
		indexes: {
			idx_workflow_steps_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_workflow_steps_order: {
				columns: ['holding_id', 'order_index'],
				unique: false,
				where: null,
			},
		},
	},
	workflow_step_documents: {
		columns: {
			id: false,
			workflow_step_id: false,
			contract_id: false,
			file_name: false,
			file_url: false,
			file_size: true,
			file_type: true,
			uploaded_by: true,
			uploaded_at: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			fk_wsd_contract: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			workflow_step_documents_uploaded_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			fk_wsd_uploaded_by: {
				table: 'users',
				onDelete: 'SET NULL',
			},
			fk_wsd_holding: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			workflow_step_documents_workflow_step_id_fkey: {
				table: 'workflow_steps',
				onDelete: 'CASCADE',
			},
			workflow_step_documents_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			workflow_step_documents_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			fk_wsd_step: {
				table: 'workflow_steps',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_wsd_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_wsd_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_wsd_step: {
				columns: ['workflow_step_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_clauses: {
		columns: {
			id: false,
			company_id: true,
			name: true,
			category: true,
			content: true,
			created_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_contract_clauses_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			contract_clauses_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_clauses_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_templates: {
		columns: {
			id: false,
			company_id: true,
			name: true,
			file_url: true,
			created_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_templates_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
			fk_contract_templates_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_templates_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_documents: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			document_name: false,
			file_url: false,
			file_size: true,
			file_type: true,
			category: true,
			uploaded_by: true,
			uploaded_at: true,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_documents_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			contract_documents_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			contract_documents_uploaded_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_documents_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_documents_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_notifications: {
		columns: {
			id: false,
			contract_id: false,
			user_id: true,
			notification_type: false,
			title: false,
			message: false,
			is_read: true,
			metadata: true,
			created_at: true,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			contract_notifications_user_id_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			contract_notifications_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			contract_notifications_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['contract_notifications_notification_type_check'],
		indexes: {
			idx_contract_notifications_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_notifications_created_at: {
				columns: ['created_at'],
				unique: false,
				where: null,
			},
			idx_contract_notifications_is_read: {
				columns: ['is_read'],
				unique: false,
				where: null,
			},
			idx_contract_notifications_user_id: {
				columns: ['user_id'],
				unique: false,
				where: null,
			},
		},
	},
	contract_billing_splits: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			billing_company_id: false,
			billing_currency: false,
			percent_allocation: false,
			effective_from: false,
			effective_to: true,
			notes: true,
			created_at: true,
			updated_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			contract_billing_splits_billing_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
			contract_billing_splits_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'NO ACTION',
			},
			contract_billing_splits_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['contract_billing_splits_percent_allocation_check', 'valid_date_range'],
		indexes: {
			idx_billing_splits_company: {
				columns: ['billing_company_id'],
				unique: false,
				where: null,
			},
			idx_billing_splits_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_billing_splits_dates: {
				columns: ['effective_from', 'effective_to'],
				unique: false,
				where: null,
			},
		},
	},
	contract_invoices: {
		columns: {
			id: false,
			contract_id: false,
			invoice_date: false,
			amount: false,
			currency: false,
			status: false,
			contract_items: false,
			contract_item_details: false,
			is_editable: false,
			created_at: false,
			updated_at: false,
			holding_id: false,
			invoice_currency: true,
			fx_policy: true,
			fx_contract_to_invoice: true,
			satisfied_by_legacy_id: true,
			is_satisfied: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_contract_invoices_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			fk_contract_invoices_contract_id: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
			contract_invoices_satisfied_by_legacy_id_fkey: {
				table: 'invoices_legacy',
				onDelete: 'SET NULL',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_contract_invoices_contract_id: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_contract_invoices_date: {
				columns: ['invoice_date'],
				unique: false,
				where: null,
			},
			idx_contract_invoices_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_contract_invoices_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	churn_reasons: {
		columns: {
			id: false,
			holding_id: false,
			name: false,
			is_active: false,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			churn_reasons_holding_id_name_key: ['holding_id', 'name'],
		},
		checks: [],
		indexes: {
			idx_churn_reasons_active: {
				columns: ['holding_id', 'is_active'],
				unique: false,
				where: null,
			},
			idx_churn_reasons_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
};
