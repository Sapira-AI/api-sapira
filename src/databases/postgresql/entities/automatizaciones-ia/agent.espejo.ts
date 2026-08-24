import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.agents` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): agent_logs.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_agents (DELETE, authenticated); tenant_isolation_insert_agents (INSERT, authenticated); tenant_isolation_select_agents (SELECT, authenticated); tenant_isolation_update_agents (UPDATE, authenticated).
 */
@Entity('agents')
@Index('idx_agents_holding_id', ['holding_id'])
export class Agent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'agents_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'text', nullable: true })
	type?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@Column({ type: 'text', nullable: true })
	last_activity?: string;

	@Column({ type: 'timestamp without time zone', nullable: true })
	last_activity_at?: Date;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_agents_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'agents_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}
