import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

/**
 * Espejo de `public.claude_skills` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 2 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (0): ninguna (RLS on sin policies → solo service role).
 */
@Entity('claude_skills')
@Unique('claude_skills_name_holding_id_key', ['name', 'holding_id'])
@Index('idx_claude_skills_holding_id', ['holding_id'])
@Index('idx_claude_skills_is_active', ['is_active'])
@Index('idx_claude_skills_name', ['name'])
export class ClaudeSkill {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'claude_skills_pkey' })
	id: string;

	@Column({ type: 'varchar', length: 255, nullable: false })
	name: string;

	@Column({ type: 'text', nullable: false })
	description: string;

	@Column({ type: 'jsonb', nullable: false })
	input_schema: any;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'claude_skills_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
