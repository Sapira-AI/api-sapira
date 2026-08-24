import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Espejo de `public.ai_agents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 16 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 2 tabla(s): ai_agent_configs, ai_runs.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_ai_agents_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (2): AI agents - manage own holding (ALL, public); AI agents - select own holding (SELECT, public).
 */
@Entity('ai_agents')
@Check('ai_agents_type_check', "type = ANY (ARRAY['collections'::text, 'proforma'::text, 'deal_validation'::text])")
@Index('ai_agents_holding_type_idx', ['holding_id', 'type'])
export class AiAgent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'ai_agents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	type: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_enabled: boolean;

	@Column({ type: 'text', nullable: false })
	schedule: string;

	@Column({ type: 'uuid', nullable: false })
	created_by: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	/** Indica si el agente se ejecuta automáticamente según el schedule configurado */
	@Column({ type: 'boolean', nullable: true, default: false })
	auto_execute?: boolean;

	/** Indica si los mensajes generados requieren aprobación manual antes de enviarse */
	@Column({ type: 'boolean', nullable: true, default: true })
	require_approval?: boolean;
}
