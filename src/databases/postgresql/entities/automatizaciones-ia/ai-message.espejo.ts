import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AiRun } from './ai-run.espejo';

/**
 * Espejo de `public.ai_messages` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): AI messages - manage via run (ALL, public); AI messages - select via run (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX ai_messages_run_idx ON public.ai_messages USING btree (run_id, created_at DESC)
 */
@Entity('ai_messages')
@Check('ai_messages_channel_check', "channel = ANY (ARRAY['email'::text, 'crm'::text, 'webhook'::text])")
@Check('ai_messages_direction_check', "direction = ANY (ARRAY['out'::text, 'in'::text])")
export class AiMessage {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'ai_messages_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	run_id: string;

	@Column({ type: 'text', nullable: false })
	direction: string;

	@Column({ type: 'text', nullable: false })
	channel: string;

	@Column({ type: 'text', nullable: true })
	to?: string;

	@Column({ type: 'text', nullable: true })
	subject?: string;

	@Column({ type: 'text', nullable: true })
	body?: string;

	@Column({ type: 'jsonb', nullable: true })
	meta_json?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => AiRun, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'run_id', referencedColumnName: 'id', foreignKeyConstraintName: 'ai_messages_run_id_fkey' })
	run?: AiRun;
}
