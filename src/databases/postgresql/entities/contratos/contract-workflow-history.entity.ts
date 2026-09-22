import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { WorkflowStep } from './workflow-step.entity';

/**
 * Entity de `public.contract_workflow_history` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 996 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (3): Users can insert contract workflow history for their holding (INSERT, public); Users can update contract workflow history from their holding (UPDATE, public); Users can view contract workflow history from their holding (SELECT, public).
 */
@Entity('contract_workflow_history')
@Check('contract_workflow_history_transition_type_check', "transition_type = ANY (ARRAY['manual'::text, 'automatic'::text, 'system'::text])")
@Index('idx_contract_workflow_history_contract_id', ['contract_id'])
@Index('idx_contract_workflow_history_created_at', ['created_at'])
@Index('idx_contract_workflow_history_step_id', ['workflow_step_id'])
@Index('idx_contract_workflow_history_user_id', ['user_id'])
export class ContractWorkflowHistory {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_workflow_history_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	/** ID del paso del workflow. Puede ser NULL para registros de activación masiva o acciones fuera del workflow normal. */
	@Column({
		type: 'uuid',
		comment: 'ID del paso del workflow. Puede ser NULL para registros de activación masiva o acciones fuera del workflow normal.',
		nullable: true,
	})
	workflow_step_id?: string;

	@Column({ type: 'uuid', nullable: true })
	user_id?: string;

	@Column({ type: 'text', nullable: false, default: 'pending' })
	status: string;

	@Column({ type: 'text', nullable: true })
	comments?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	completed_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@Column({ type: 'text', array: true, nullable: true })
	files_attached?: string[];

	@Column({ type: 'uuid', nullable: true })
	previous_step_id?: string;

	@Column({ type: 'text', nullable: true, default: 'manual' })
	transition_type?: string;

	@ManyToOne(() => WorkflowStep)
	@JoinColumn({ name: 'previous_step_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_workflow_history_previous_step_id_fkey' })
	previousStep?: WorkflowStep;
}
