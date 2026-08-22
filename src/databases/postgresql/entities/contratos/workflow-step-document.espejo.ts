import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { User } from '@/modules/users/entities/user.entity';

import { WorkflowStep } from './workflow-step.espejo';

/**
 * Espejo de `public.workflow_step_documents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on (forzado).
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_wsd (DELETE, public); tenant_isolation_insert_wsd (INSERT, public); tenant_isolation_select_wsd (SELECT, public); tenant_isolation_update_wsd (UPDATE, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_wsd_uploaded_at ON public.workflow_step_documents USING btree (uploaded_at DESC)
 * FK duplicada sobre (uploaded_by): fk_wsd_uploaded_by (relación uploadedBy2)
 * FK duplicada sobre (contract_id): workflow_step_documents_contract_id_fkey (relación contract2)
 * FK duplicada sobre (holding_id): workflow_step_documents_holding_id_fkey (relación holding2)
 * FK duplicada sobre (workflow_step_id): fk_wsd_step (relación workflowStep2)
 */
@Entity('workflow_step_documents')
@Index('idx_wsd_contract', ['contract_id'])
@Index('idx_wsd_holding', ['holding_id'])
@Index('idx_wsd_step', ['workflow_step_id'])
export class WorkflowStepDocument {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'workflow_step_documents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	workflow_step_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'text', nullable: false })
	file_name: string;

	@Column({ type: 'text', nullable: false })
	file_url: string;

	@Column({ type: 'integer', nullable: true })
	file_size?: number;

	@Column({ type: 'text', nullable: true })
	file_type?: string;

	@Column({ type: 'uuid', nullable: true })
	uploaded_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	uploaded_at?: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_wsd_contract' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'workflow_step_documents_uploaded_by_fkey' })
	uploadedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => User, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
	@JoinColumn({ name: 'uploaded_by', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_wsd_uploaded_by' })
	uploadedBy2?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT', onUpdate: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_wsd_holding' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => WorkflowStep, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'workflow_step_id', referencedColumnName: 'id', foreignKeyConstraintName: 'workflow_step_documents_workflow_step_id_fkey' })
	workflowStep?: WorkflowStep;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'workflow_step_documents_contract_id_fkey' })
	contract2?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'workflow_step_documents_holding_id_fkey' })
	holding2?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => WorkflowStep, { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
	@JoinColumn({ name: 'workflow_step_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_wsd_step' })
	workflowStep2?: WorkflowStep;
}
