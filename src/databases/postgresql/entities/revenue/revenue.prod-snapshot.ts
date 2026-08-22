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

export const REVENUE_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	revenue_schedule_monthly: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: true,
			contract_item_id: true,
			period_month: false,
			company_id: false,
			company_currency: false,
			contract_currency: false,
			system_currency: false,
			recognized_period_ccy: true,
			recognized_cum_ccy: true,
			billed_period_ccy: true,
			billed_cum_ccy: true,
			deferred_balance_eom_ccy: true,
			unbilled_balance_eom_ccy: true,
			mrr_period_ccy: true,
			recognized_period_contract_ccy: true,
			recognized_cum_contract_ccy: true,
			billed_period_contract_ccy: true,
			billed_cum_contract_ccy: true,
			deferred_balance_eom_contract_ccy: true,
			unbilled_balance_eom_contract_ccy: true,
			mrr_period_contract_ccy: true,
			recognized_period_system_ccy: true,
			recognized_cum_system_ccy: true,
			billed_period_system_ccy: true,
			billed_cum_system_ccy: true,
			deferred_balance_eom_system_ccy: true,
			unbilled_balance_eom_system_ccy: true,
			mrr_period_system_ccy: true,
			calc_version: false,
			source_snapshot_hash: true,
			created_at: false,
			updated_at: false,
			deferred_balance_period_ccy: true,
			unbilled_balance_period_ccy: true,
			product_name: true,
			fx_contract_to_company: true,
			fx_contract_to_system: true,
			fx_to_company_source: true,
			fx_to_company_date: true,
			fx_to_system_source: true,
			fx_to_system_date: true,
			is_total_row: false,
			deferred_balance_period_contract_ccy: true,
			unbilled_balance_period_contract_ccy: true,
			deferred_balance_period_system_ccy: true,
			unbilled_balance_period_system_ccy: true,
			momentum: true,
			mrr_period_contracted_contract_ccy: true,
			cmrr_period_contract_ccy: true,
			mrr_period_contracted_ccy: true,
			cmrr_period_ccy: true,
			mrr_period_contracted_system_ccy: true,
			cmrr_period_system_ccy: true,
			subscription_id: true,
			subscription_item_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			revenue_schedule_monthly_subscription_item_id_fkey: {
				table: 'subscription_items',
				onDelete: 'NO ACTION',
			},
			fk_revenue_schedule_holding: {
				table: 'company_holdings',
				onDelete: 'NO ACTION',
			},
			fk_revenue_schedule_contract: {
				table: 'contracts',
				onDelete: 'NO ACTION',
			},
			fk_revenue_schedule_company: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
			fk_revenue_schedule_item: {
				table: 'contract_items',
				onDelete: 'NO ACTION',
			},
			revenue_schedule_monthly_subscription_id_fkey: {
				table: 'subscriptions',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {
			revenue_schedule_monthly_contract_item_period_momentum_key: ['contract_id', 'contract_item_id', 'period_month', 'momentum'],
		},
		checks: ['revenue_schedule_monthly_momentum_check', 'rsm_contract_or_subscription_required'],
		indexes: {
			idx_revenue_schedule_momentum: {
				columns: ['momentum', 'period_month'],
				unique: false,
				where: null,
			},
			idx_revenue_schedule_monthly_company_period: {
				columns: ['company_id', 'period_month'],
				unique: false,
				where: null,
			},
			idx_revenue_schedule_monthly_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_revenue_schedule_monthly_holding_period: {
				columns: ['holding_id', 'period_month'],
				unique: false,
				where: null,
			},
			idx_revenue_schedule_monthly_is_total_row: {
				columns: ['contract_id', 'is_total_row', 'period_month'],
				unique: false,
				where: null,
			},
			idx_rsm_cmrr_period: {
				columns: ['holding_id', 'period_month', 'cmrr_period_contract_ccy'],
				unique: false,
				where: 'cmrr_period_contract_ccy > (0)::numeric',
			},
			idx_rsm_company_period: {
				columns: ['company_id', 'period_month'],
				unique: false,
				where: null,
			},
			idx_rsm_contract_period: {
				columns: ['contract_id', 'period_month'],
				unique: false,
				where: null,
			},
			idx_rsm_mrr_contracted_period: {
				columns: ['holding_id', 'period_month', 'mrr_period_contracted_contract_ccy'],
				unique: false,
				where: 'mrr_period_contracted_contract_ccy > (0)::numeric',
			},
			idx_rsm_subscription_id: {
				columns: ['subscription_id'],
				unique: false,
				where: 'subscription_id IS NOT NULL',
			},
			idx_rsm_subscription_item_id: {
				columns: ['subscription_item_id'],
				unique: false,
				where: 'subscription_item_id IS NOT NULL',
			},
		},
	},
	revenue_rules: {
		columns: {
			id: false,
			company_id: true,
			target_type: true,
			target_name: true,
			method: true,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			revenue_rules_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['revenue_rules_target_type_check'],
		indexes: {},
	},
	mrr_adjustments: {
		columns: {
			id: false,
			holding_id: false,
			contract_id: false,
			company_id: false,
			type: false,
			amount_contract_currency: false,
			currency: false,
			effective_date: false,
			approved: false,
			approved_by: true,
			applied_retroactively: false,
			description: true,
			created_by: true,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			mrr_adjustments_company_id_fkey: {
				table: 'companies',
				onDelete: 'CASCADE',
			},
			mrr_adjustments_contract_id_fkey: {
				table: 'contracts',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_mrr_adj_company: {
				columns: ['company_id'],
				unique: false,
				where: null,
			},
			idx_mrr_adj_contract: {
				columns: ['contract_id'],
				unique: false,
				where: null,
			},
			idx_mrr_adj_effective_date: {
				columns: ['effective_date'],
				unique: false,
				where: null,
			},
		},
	},
	accounting_period_cutoff: {
		columns: {
			id: false,
			holding_id: false,
			company_id: false,
			cutoff_date: true,
			last_action: true,
			last_action_at: true,
			last_action_by: true,
			last_action_by_name: true,
			last_action_by_email: true,
			last_action_reason: true,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			accounting_period_cutoff_last_action_by_fkey: {
				table: 'users',
				onDelete: 'SET NULL',
			},
			accounting_period_cutoff_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			accounting_period_cutoff_company_id_fkey: {
				table: 'companies',
				onDelete: 'RESTRICT',
			},
		},
		uniques: {
			accounting_period_cutoff_holding_id_company_id_key: ['holding_id', 'company_id'],
		},
		checks: ['accounting_period_cutoff_last_action_check'],
		indexes: {
			idx_cutoff_lookup: {
				columns: ['holding_id', 'company_id'],
				unique: false,
				where: null,
			},
		},
	},
	accounting_period_events: {
		columns: {
			id: false,
			holding_id: false,
			company_id: false,
			action: false,
			cutoff_date_before: true,
			cutoff_date_after: false,
			performed_by: false,
			performed_by_name: false,
			performed_by_email: false,
			performed_at: false,
			reason: false,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			accounting_period_events_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'RESTRICT',
			},
			accounting_period_events_company_id_fkey: {
				table: 'companies',
				onDelete: 'RESTRICT',
			},
			accounting_period_events_performed_by_fkey: {
				table: 'users',
				onDelete: 'RESTRICT',
			},
		},
		uniques: {},
		checks: ['accounting_period_events_action_check', 'accounting_period_events_reason_check'],
		indexes: {},
	},
};
