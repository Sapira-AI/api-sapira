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

export const BASE_TENANCY_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	roles: {
		columns: {
			id: false,
			name: false,
			description: true,
			created_at: true,
			holding_id: true,
		},
		primary: ['id'],
		foreignKeys: {
			fk_roles_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			roles_name_holding_id_key: ['name', 'holding_id'],
		},
		checks: [],
		indexes: {
			idx_roles_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
		},
	},
	permissions: {
		columns: {
			id: false,
			code: false,
			description: true,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			permissions_code_key: ['code'],
		},
		checks: [],
		indexes: {},
	},
	role_permissions: {
		columns: {
			role_id: false,
			permission_id: false,
			holding_id: true,
		},
		primary: ['role_id', 'permission_id'],
		foreignKeys: {
			role_permissions_role_id_fkey: {
				table: 'roles',
				onDelete: 'NO ACTION',
			},
			role_permissions_permission_id_fkey: {
				table: 'permissions',
				onDelete: 'NO ACTION',
			},
			fk_role_permissions_holding_id: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: [],
		indexes: {
			idx_role_permissions_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_role_permissions_permission_id: {
				columns: ['permission_id'],
				unique: false,
				where: null,
			},
			idx_role_permissions_role_id: {
				columns: ['role_id'],
				unique: false,
				where: null,
			},
		},
	},
	financial_settings: {
		columns: {
			id: false,
			holding_id: false,
			recognition_granularity: false,
			discount_policy: false,
			discounts_require_approval: false,
			created_at: false,
			updated_at: false,
			revenue_schedule_monthly_enabled: false,
		},
		primary: ['id'],
		foreignKeys: {},
		uniques: {
			financial_settings_holding_id_key: ['holding_id'],
		},
		checks: [],
		indexes: {},
	},
	holding_settings: {
		columns: {
			holding_id: false,
			system_currency: false,
			created_at: false,
			updated_at: false,
			fx_system_policy: true,
			currencies_in_use: true,
		},
		primary: ['holding_id'],
		foreignKeys: {
			holding_settings_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {},
		checks: ['holding_settings_fx_system_policy_check'],
		indexes: {},
	},
	custom_field_definitions: {
		columns: {
			id: false,
			holding_id: false,
			entity_type: false,
			field_name: false,
			field_label: false,
			field_type: false,
			is_required: false,
			is_active: false,
			display_order: false,
			created_at: false,
			created_by: true,
		},
		primary: ['id'],
		foreignKeys: {
			custom_field_definitions_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
			custom_field_definitions_created_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {
			unique_field_per_entity: ['holding_id', 'entity_type', 'field_name'],
		},
		checks: ['custom_field_definitions_field_type_check', 'valid_entity_type'],
		indexes: {
			idx_custom_field_defs_active: {
				columns: ['holding_id', 'entity_type', 'is_active'],
				unique: false,
				where: 'is_active = true',
			},
			idx_custom_field_defs_holding_entity: {
				columns: ['holding_id', 'entity_type'],
				unique: false,
				where: null,
			},
			idx_custom_field_defs_order: {
				columns: ['holding_id', 'entity_type', 'display_order', 'created_at'],
				unique: false,
				where: null,
			},
		},
	},
	user_view_preferences: {
		columns: {
			id: false,
			user_id: false,
			entity_type: false,
			view_name: false,
			column_config: false,
			filter_config: false,
			is_default: false,
			created_at: false,
			updated_at: false,
		},
		primary: ['id'],
		foreignKeys: {
			user_view_preferences_user_id_fkey: {
				table: 'users',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			user_view_preferences_user_id_entity_type_view_name_key: ['user_id', 'entity_type', 'view_name'],
		},
		checks: [],
		indexes: {
			idx_user_view_prefs_one_default_per_entity: {
				columns: ['user_id', 'entity_type'],
				unique: true,
				where: 'is_default = true',
			},
			idx_user_view_prefs_user_entity: {
				columns: ['user_id', 'entity_type'],
				unique: false,
				where: null,
			},
		},
	},
	claude_skills: {
		columns: {
			id: false,
			name: false,
			description: false,
			input_schema: false,
			holding_id: true,
			is_active: true,
			created_at: true,
			updated_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			claude_skills_holding_id_fkey: {
				table: 'company_holdings',
				onDelete: 'CASCADE',
			},
		},
		uniques: {
			claude_skills_name_holding_id_key: ['name', 'holding_id'],
		},
		checks: [],
		indexes: {
			idx_claude_skills_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_claude_skills_is_active: {
				columns: ['is_active'],
				unique: false,
				where: null,
			},
			idx_claude_skills_name: {
				columns: ['name'],
				unique: false,
				where: null,
			},
		},
	},
};
