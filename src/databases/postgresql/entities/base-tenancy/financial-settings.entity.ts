import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Entity de `public.financial_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 4 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
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
