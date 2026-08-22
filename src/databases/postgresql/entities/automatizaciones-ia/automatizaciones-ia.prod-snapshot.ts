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

export const AUTOMATIZACIONES_IA_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	ai_agents: {
		columns: {
			id: false,
			holding_id: false,
			type: false,
			name: false,
			is_enabled: false,
			schedule: false,
			created_by: false,
			created_at: false,
			updated_at: false,
			auto_execute: true,
			require_approval: true,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {},
		checks: ['ai_agents_type_check'],
		indexes: {
			ai_agents_holding_type_idx: {
				columns: ['holding_id', 'type'],
				unique: false,
				where: null,
			},
		},
	},
	ai_agent_configs: {
		columns: {
			id: false,
			agent_id: false,
			key: false,
			value_json: false,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			ai_agent_configs_agent_id_fkey: {
				table: 'ai_agents',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			ai_agent_configs_agent_id_key_key: ['agent_id', 'key'],
		},
		checks: [],
		indexes: {
			ai_agent_configs_agent_idx: {
				columns: ['agent_id'],
				unique: false,
				where: null,
			},
		},
	},
	client_agent_configs: {
		columns: {
			id: false,
			holding_id: false,
			client_id: true,
			agent_type: false,
			is_enabled: false,
			config_json: false,
			created_at: false,
			updated_at: false,
			created_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			client_agent_configs_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			client_agent_configs_client_id_fkey: {
				table: 'clients',
				onDelete: 'CASCADE',
			},
			client_agent_configs_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {
			client_agent_configs_holding_id_client_id_agent_type_key: ['holding_id', 'client_id', 'agent_type'],
		},
		checks: ['client_agent_configs_agent_type_check'],
		indexes: {
			idx_client_agent_configs_agent_type: {
				columns: ['agent_type', 'is_enabled'],
				unique: false,
				where: null,
			},
			idx_client_agent_configs_enabled: {
				columns: ['is_enabled'],
				unique: false,
				where: 'is_enabled = true',
			},
			idx_client_agent_configs_holding_client: {
				columns: ['holding_id', 'client_id'],
				unique: false,
				where: null,
			},
			idx_client_agent_configs_holding_global: {
				columns: ['holding_id', 'agent_type'],
				unique: true,
				where: 'client_id IS NULL',
			},
			idx_client_agent_configs_holding_type: {
				columns: ['holding_id', 'agent_type'],
				unique: false,
				where: null,
			},
		},
	},
	agents: {
		columns: {
			id: false,
			company_id: true,
			name: true,
			description: true,
			type: true,
			is_active: true,
			last_activity: true,
			last_activity_at: true,
			created_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_agents_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			agents_company_id_fkey: {
				table: 'companies',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_agents_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	agent_logs: {
		columns: {
			id: false,
			agent_id: true,
			user_id: true,
			activity: true,
			executed_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			agent_logs_user_id_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			fk_agent_logs_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			agent_logs_agent_id_fkey: {
				table: 'agents',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_agent_logs_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	ai_runs: {
		columns: {
			id: false,
			agent_id: false,
			started_at: false,
			ended_at: true,
			status: false,
			stats_json: true,
			approver_user_id: true,
			error_message: true,
			created_at: false,
			holding_id: false,
		},
		primary: ['id'],
		foreignKeys: {
			ai_runs_agent_id_fkey: {
				table: 'ai_agents',
				onDelete: 'CASCADE',
			},
			ai_runs_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['ai_runs_status_check'],
		indexes: {},
	},
	ai_messages: {
		columns: {
			id: false,
			run_id: false,
			direction: false,
			channel: false,
			to: true,
			subject: true,
			body: true,
			meta_json: true,
			created_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			ai_messages_run_id_fkey: {
				table: 'ai_runs',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['ai_messages_channel_check', 'ai_messages_direction_check'],
		indexes: {},
	},
	rag_documents: {
		columns: {
			id: false,
			holding_id: false,
			source_type: false,
			source_id: true,
			content: false,
			metadata: false,
			embedding: true,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			rag_documents_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			rag_documents_holding_id_idx: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			rag_documents_source_idx: {
				columns: ['source_type', 'source_id'],
				unique: false,
				where: null,
			},
		},
	},
	email_sender_addresses: {
		columns: {
			id: false,
			domain_config_id: false,
			from_name: false,
			from_email: false,
			reply_to_email: true,
			is_default: false,
			is_active: false,
			purpose: true,
			created_at: false,
			updated_at: false,
			created_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			email_sender_addresses_domain_config_id_fkey: {
				table: 'holding_email_sender_settings',
				onDelete: 'CASCADE',
			},
			email_sender_addresses_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_email_sender_addresses_active: {
				columns: ['is_active'],
				unique: false,
				where: 'is_active = true',
			},
			idx_email_sender_addresses_default: {
				columns: ['domain_config_id', 'is_default'],
				unique: false,
				where: 'is_default = true',
			},
			idx_email_sender_addresses_domain: {
				columns: ['domain_config_id'],
				unique: false,
				where: null,
			},
			unique_default_sender_per_domain: {
				columns: ['domain_config_id'],
				unique: true,
				where: '(is_default = true) AND (is_active = true)',
			},
		},
	},
	holding_email_sender_settings: {
		columns: {
			id: false,
			holding_id: false,
			sender_domain: false,
			resend_domain_id: true,
			domain_status: false,
			domain_dns_records: true,
			domain_verified_at: true,
			created_at: false,
			updated_at: false,
			created_by: true,
			is_default: false,
			is_active: false,
			display_name: true,
		},
		primary: ['id'],
		foreignKeys: {
			holding_email_sender_settings_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
			holding_email_sender_settings_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_holding_email_sender_active: {
				columns: ['is_active'],
				unique: false,
				where: 'is_active = true',
			},
			idx_holding_email_sender_default: {
				columns: ['holding_id', 'is_default'],
				unique: false,
				where: 'is_default = true',
			},
			idx_holding_email_sender_holding: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_holding_email_sender_status: {
				columns: ['domain_status'],
				unique: false,
				where: null,
			},
			unique_default_domain_per_holding: {
				columns: ['holding_id'],
				unique: true,
				where: '(is_default = true) AND (is_active = true)',
			},
		},
	},
};
