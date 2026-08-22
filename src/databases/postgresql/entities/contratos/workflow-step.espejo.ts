import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Espejo de `public.workflow_steps` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 17 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 3 tabla(s): contract_workflow_history, contracts, workflow_step_documents.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_workflow_steps_updated_at · BEFORE UPDATE FOR EACH ROW → update_workflow_steps_updated_at().
 * Policies (4): Users can delete workflow steps from their holding (DELETE, public); Users can insert workflow steps for their holding (INSERT, public); Users can update workflow steps from their holding (UPDATE, public); Users can view workflow steps from their holding (SELECT, public).
 */
@Entity('workflow_steps')
@Index('idx_workflow_steps_holding_id', ['holding_id'])
@Index('idx_workflow_steps_order', ['holding_id', 'order_index'])
export class WorkflowStep {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'workflow_steps_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'integer', nullable: false })
	order_index: number;

	@Column({ type: 'uuid', array: true, nullable: true, default: () => 'ARRAY[]::uuid[]' })
	assigned_user_ids?: string[];

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_manual_approval?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_client_step?: boolean;

	@Column({ type: 'text', nullable: true })
	client_email?: string;

	@Column({ type: 'text', nullable: true, default: '#3B82F6' })
	color?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;
}
