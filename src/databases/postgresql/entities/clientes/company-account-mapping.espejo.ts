import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.company_account_mappings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): Users delete own holding mappings (DELETE, public); Users insert own holding mappings (INSERT, public); Users update own holding mappings (UPDATE, public); Users view own holding mappings (SELECT, public).
 */
@Entity('company_account_mappings')
@Unique('unique_company_mapping', ['company_id'])
@Index('idx_company_account_mappings_company', ['company_id'])
export class CompanyAccountMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'company_account_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false, default: '4.1.01' })
	revenue_account_code: string;

	@Column({ type: 'text', nullable: false, default: 'Revenue' })
	revenue_account_name: string;

	@Column({ type: 'text', nullable: false, default: '1.1.03' })
	unbilled_account_code: string;

	@Column({ type: 'text', nullable: false, default: 'Unbilled Revenue (Contract Asset)' })
	unbilled_account_name: string;

	@Column({ type: 'text', nullable: false, default: '2.2.05' })
	deferred_account_code: string;

	@Column({ type: 'text', nullable: false, default: 'Deferred Revenue' })
	deferred_account_name: string;

	@Column({ type: 'text', nullable: true })
	external_revenue_code?: string;

	@Column({ type: 'text', nullable: true })
	external_unbilled_code?: string;

	@Column({ type: 'text', nullable: true })
	external_deferred_code?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'company_account_mappings_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}
