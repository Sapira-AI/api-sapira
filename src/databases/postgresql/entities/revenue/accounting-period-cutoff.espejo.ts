import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.accounting_period_cutoff` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 18 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Cierre contable por compañía (modelo lineal). Una fila por (holding, company). cutoff_date marca la última fecha cerrada — todo <= es CLOSED, todo > es OPEN.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_accounting_period_cutoff_updated_at · BEFORE UPDATE FOR EACH ROW → trg_set_updated_at_accounting_period_cutoff(); trg_cutoff_validate_company_holding · BEFORE INSERT OR UPDATE OF holding_id, company_id FOR EACH ROW → trg_validate_cutoff_company_holding_match().
 * Policies (3): cutoff_insert (INSERT, public); cutoff_select (SELECT, public); cutoff_update (UPDATE, public).
 */
@Entity('accounting_period_cutoff')
@Unique('accounting_period_cutoff_holding_id_company_id_key', ['holding_id', 'company_id'])
@Check('accounting_period_cutoff_last_action_check', "last_action = ANY (ARRAY['CLOSED'::text, 'REOPENED'::text])")
@Index('idx_cutoff_lookup', ['holding_id', 'company_id'])
export class AccountingPeriodCutoff {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'accounting_period_cutoff_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'date', nullable: true })
	cutoff_date?: Date;

	@Column({ type: 'text', nullable: true })
	last_action?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_action_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	last_action_by?: string;

	@Column({ type: 'text', nullable: true })
	last_action_by_name?: string;

	@Column({ type: 'text', nullable: true })
	last_action_by_email?: string;

	@Column({ type: 'text', nullable: true })
	last_action_reason?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'last_action_by', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_cutoff_last_action_by_fkey' })
	lastActionBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_cutoff_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Company, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'accounting_period_cutoff_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)
}
