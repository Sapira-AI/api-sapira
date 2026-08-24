import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { AiAgent } from './ai-agent.espejo';

/**
 * Espejo de `public.ai_agent_configs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 122 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_ai_agent_configs_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (2): AI agent configs - manage via agent (ALL, public); AI agent configs - select via agent (SELECT, public).
 */
@Entity('ai_agent_configs')
@Unique('ai_agent_configs_agent_id_key_key', ['agent_id', 'key'])
@Index('ai_agent_configs_agent_idx', ['agent_id'])
export class AiAgentConfig {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'ai_agent_configs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	agent_id: string;

	@Column({ type: 'text', nullable: false })
	key: string;

	@Column({ type: 'jsonb', nullable: false })
	value_json: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => AiAgent, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'agent_id', referencedColumnName: 'id', foreignKeyConstraintName: 'ai_agent_configs_agent_id_fkey' })
	agent?: AiAgent;
}
