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

export const COTIZACIONES_CATALOGO_PROD_SNAPSHOT: Record<string, ProdTableSnapshot> = {
	quote_attachments: {
		columns: {
			id: false,
			quote_id: false,
			file_name: false,
			file_url: false,
			file_type: true,
			file_size: true,
			attachment_type: false,
			uploaded_by: true,
			uploaded_at: true,
			holding_id: false,
			created_at: true,
		},
		primary: ['id'],
		foreignKeys: {
			quote_attachments_quote_id_fkey: {
				table: 'quotes',
				onDelete: 'CASCADE',
			},
			quote_attachments_uploaded_by_fkey: {
				table: 'users',
				onDelete: 'NO ACTION',
			},
		},
		uniques: {},
		checks: ['quote_attachments_attachment_type_check'],
		indexes: {
			idx_quote_attachments_attachment_type: {
				columns: ['attachment_type'],
				unique: false,
				where: null,
			},
			idx_quote_attachments_holding_id: {
				columns: ['holding_id'],
				unique: false,
				where: null,
			},
			idx_quote_attachments_quote_id: {
				columns: ['quote_id'],
				unique: false,
				where: null,
			},
		},
	},
};
