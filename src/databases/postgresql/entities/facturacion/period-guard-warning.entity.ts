import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * Entity de `public.period_guard_warnings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
 * Registro de operaciones que el guard de cierre de períodos hubiera bloqueado, durante el modo "warn" del soft launch.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (1): pgw_select (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_pgw_company_time ON public.period_guard_warnings USING btree (holding_id, company_id, occurred_at DESC)
 */
@Entity({
	name: 'period_guard_warnings',
	comment: 'Registro de operaciones que el guard de cierre de períodos hubiera bloqueado, durante el modo "warn" del soft launch.',
})
export class PeriodGuardWarning {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'period_guard_warnings_pkey' })
	id: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	occurred_at: Date;

	@Column({ type: 'uuid', nullable: true })
	triggered_by?: string;

	@Column({ type: 'text', nullable: false })
	table_name: string;

	@Column({ type: 'text', nullable: false })
	operation: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'date', nullable: true })
	cutoff_date?: Date;

	@Column({ type: 'text', array: true, nullable: true })
	fields_changed?: string[];

	@Column({ type: 'text', nullable: false })
	message: string;

	@Column({ type: 'jsonb', nullable: true })
	payload?: any;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'triggered_by', referencedColumnName: 'id', foreignKeyConstraintName: 'period_guard_warnings_triggered_by_fkey' })
	triggeredBy?: User; // entity existente (no se duplica)
}
