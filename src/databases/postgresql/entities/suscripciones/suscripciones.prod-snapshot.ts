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

export const SUSCRIPCIONES_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	subscriptions: {
		columns: {
			id: false,
			holding_id: false,
			company_id: false,
			client_id: false,
			client_entity_id: false,
			client_name_commercial: true,
			legal_client_name: true,
			external_id: false,
			source: false,
			connection_id: true,
			status: false,
			start_date: true,
			canceled_at: true,
			cancel_at_period_end: true,
			ended_at: true,
			current_period_start: true,
			current_period_end: true,
			billing_cycle_anchor: true,
			cancellation_reason: true,
			cancellation_comment: true,
			currency: false,
			monthly_amount: true,
			collection_method: true,
			system_currency: true,
			fx_to_system: true,
			monthly_amount_system_currency: true,
			notes: true,
			metadata: true,
			created_at: true,
			updated_at: true,
			last_synced_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			subscriptions_company_id_fkey: {
				table: 'companies',
				onDelete: 'RESTRICT',
			},
			subscriptions_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			subscriptions_connection_id_fkey: {
				table: 'stripe_connections',
				onDelete: 'NO ACTION',
			},
			subscriptions_client_entity_id_fkey: {
				table: 'client_entities',
				onDelete: 'RESTRICT',
			},
			subscriptions_client_id_fkey: {
				table: 'clients',
				onDelete: 'RESTRICT',
			},
		},
		uniques: {
			uq_subscriptions_holding_external: ['holding_id', 'external_id'],
		},
		checks: ['subscriptions_status_check'],
		indexes: {
			idx_subscriptions_client_entity_id: {
				columns: ['client_entity_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_client_id: {
				columns: ['client_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_company_id: {
				columns: ['company_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_connection_id: {
				columns: ['connection_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_external_id: {
				columns: ['external_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_subscriptions_source: {
				columns: ['source'],
				unique: false,
				where: null,
			},
			idx_subscriptions_status: {
				columns: ['status'],
				unique: false,
				where: null,
			},
		},
	},
	subscription_items: {
		columns: {
			id: false,
			subscription_id: false,
			holding_id: false,
			external_id: false,
			stripe_product_id: true,
			stripe_price_id: true,
			product_id: true,
			product_name: true,
			item_type: true,
			quantity: true,
			unit_price: true,
			monthly_amount: true,
			currency: true,
			system_currency: true,
			fx_to_system: true,
			unit_price_system_currency: true,
			monthly_amount_system_currency: true,
			billing_scheme: true,
			interval: true,
			interval_count: true,
			current_period_start: true,
			current_period_end: true,
			start_date: true,
			canceled_at: true,
			discounts: true,
			metadata: true,
			created_at: true,
			updated_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			subscription_items_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			subscription_items_subscription_id_fkey: {
				table: 'subscriptions',
				onDelete: 'CASCADE',
			},
			subscription_items_product_id_fkey: {
				table: 'products',
				onDelete: 'RESTRICT',
			},
		},
		uniques: {
			uq_subscription_items_holding_external: ['holding_id', 'external_id'],
		},
		checks: [],
		indexes: {
			idx_subscription_items_external_id: {
				columns: ['external_id'],
				unique: false,
				where: null,
			},
			idx_subscription_items_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_subscription_items_product_id: {
				columns: ['product_id'],
				unique: false,
				where: null,
			},
			idx_subscription_items_stripe_product_id: {
				columns: ['stripe_product_id'],
				unique: false,
				where: null,
			},
			idx_subscription_items_subscription_id: {
				columns: ['subscription_id'],
				unique: false,
				where: null,
			},
		},
	},
};
