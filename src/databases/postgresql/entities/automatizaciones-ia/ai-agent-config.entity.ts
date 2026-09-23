import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { AiAgent } from './ai-agent.entity';

/**
 * Entity de `public.ai_agent_configs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 90 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
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
