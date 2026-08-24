import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

import { Agent } from './agent.espejo';

/**
 * Espejo de `public.agent_logs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (2): tenant_isolation_insert_agent_logs (INSERT, authenticated); tenant_isolation_select_agent_logs (SELECT, authenticated).
 */
@Entity('agent_logs')
@Index('idx_agent_logs_holding_id', ['holding_id'])
export class AgentLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'agent_logs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	agent_id?: string;

	@Column({ type: 'uuid', nullable: true })
	user_id?: string;

	@Column({ type: 'text', nullable: true })
	activity?: string;

	@Column({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	executed_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'agent_logs_user_id_fkey' })
	user?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_agent_logs_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Agent)
	@JoinColumn({ name: 'agent_id', referencedColumnName: 'id', foreignKeyConstraintName: 'agent_logs_agent_id_fkey' })
	agent?: Agent;
}
