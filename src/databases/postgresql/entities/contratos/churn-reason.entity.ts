import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Entity de `public.churn_reasons` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 15 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Referenciada por FK desde 1 tabla(s): contracts.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: churn_reasons_set_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at().
 * Policies (4): tenant_isolation_delete_churn_reasons (DELETE, public); tenant_isolation_insert_churn_reasons (INSERT, public); tenant_isolation_select_churn_reasons (SELECT, public); tenant_isolation_update_churn_reasons (UPDATE, public).
 */
@Entity('churn_reasons')
@Unique('churn_reasons_holding_id_name_key', ['holding_id', 'name'])
@Index('idx_churn_reasons_active', ['holding_id', 'is_active'])
@Index('idx_churn_reasons_holding', ['holding_id'])
export class ChurnReason {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'churn_reasons_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;
}
