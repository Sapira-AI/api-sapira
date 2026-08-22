import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { WorkflowStep } from './workflow-step.espejo';

/**
 * Espejo de `public.contract_workflow_history` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1004 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
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
	@Column({ type: 'uuid', nullable: true })
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
