import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { AiAgent } from './ai-agent.espejo';

/**
 * Espejo de `public.ai_runs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): ai_messages.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): AI runs - manage via agent (ALL, public); AI runs - select via agent (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX ai_runs_agent_idx ON public.ai_runs USING btree (agent_id, created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX ai_runs_holding_idx ON public.ai_runs USING btree (holding_id, created_at DESC)
 */
@Entity('ai_runs')
@Check('ai_runs_status_check', "status = ANY (ARRAY['queued'::text, 'approved'::text, 'sent'::text, 'error'::text, 'cancelled'::text])")
export class AiRun {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'ai_runs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	agent_id: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	started_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	ended_at?: Date;

	@Column({ type: 'text', nullable: false })
	status: string;

	@Column({ type: 'jsonb', nullable: true })
	stats_json?: any;

	@Column({ type: 'uuid', nullable: true })
	approver_user_id?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	/** ID del holding al que pertenece esta ejecución */
	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => AiAgent, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'agent_id', referencedColumnName: 'id', foreignKeyConstraintName: 'ai_runs_agent_id_fkey' })
	agent?: AiAgent;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'ai_runs_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
