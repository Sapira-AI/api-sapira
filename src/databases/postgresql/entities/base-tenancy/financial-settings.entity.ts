import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Entity de `public.financial_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 4 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_financial_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): tenant_isolation_delete_financial_settings (DELETE, public); tenant_isolation_insert_financial_settings (INSERT, public); tenant_isolation_select_financial_settings (SELECT, public); tenant_isolation_update_financial_settings (UPDATE, public).
 */
@Entity('financial_settings')
@Unique('financial_settings_holding_id_key', ['holding_id'])
export class FinancialSettings {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'financial_settings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false, default: 'monthly' })
	recognition_granularity: string;

	@Column({ type: 'text', nullable: false, default: 'from_application_date' })
	discount_policy: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	discounts_require_approval: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'boolean', nullable: false, default: false })
	revenue_schedule_monthly_enabled: boolean;
}
