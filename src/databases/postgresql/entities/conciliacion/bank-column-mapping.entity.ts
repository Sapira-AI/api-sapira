import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Entity de `public.bank_column_mappings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Presets de mapeo de columnas para importación de cartolas bancarias
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_bank_column_mappings (DELETE, authenticated); tenant_isolation_insert_bank_column_mappings (INSERT, authenticated); tenant_isolation_select_bank_column_mappings (SELECT, authenticated); tenant_isolation_update_bank_column_mappings (UPDATE, authenticated).
 */
@Entity({ name: 'bank_column_mappings', comment: 'Presets de mapeo de columnas para importación de cartolas bancarias' })
export class BankColumnMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'bank_column_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	bank_name: string;

	@Column({ type: 'text', nullable: false })
	mapping_name: string;

	/** JSON con: date_column, description_column, amount_column, currency_column, default_currency, date_format, decimal_separator, thousands_separator, skip_rows, amount_sign_convention */
	@Column({
		type: 'jsonb',
		comment:
			'JSON con: date_column, description_column, amount_column, currency_column, default_currency, date_format, decimal_separator, thousands_separator, skip_rows, amount_sign_convention',
		nullable: false,
	})
	column_mapping: any;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_default?: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;
}
