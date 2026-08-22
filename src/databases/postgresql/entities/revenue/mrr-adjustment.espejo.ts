import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.mrr_adjustments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_mrr_adjustments_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): tenant_isolation_delete_mrr_adjustments (DELETE, public); tenant_isolation_insert_mrr_adjustments (INSERT, public); tenant_isolation_select_mrr_adjustments (SELECT, public); tenant_isolation_update_mrr_adjustments (UPDATE, public).
 */
@Entity('mrr_adjustments')
@Index('idx_mrr_adj_company', ['company_id'])
@Index('idx_mrr_adj_contract', ['contract_id'])
@Index('idx_mrr_adj_effective_date', ['effective_date'])
export class MrrAdjustment {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'mrr_adjustments_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	type: string;

	@Column({ type: 'numeric', nullable: false })
	amount_contract_currency: number;

	@Column({ type: 'text', nullable: false })
	currency: string;

	@Column({ type: 'date', nullable: false })
	effective_date: Date;

	@Column({ type: 'boolean', nullable: false, default: false })
	approved: boolean;

	@Column({ type: 'uuid', nullable: true })
	approved_by?: string;

	@Column({ type: 'boolean', nullable: false, default: false })
	applied_retroactively: boolean;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => Company, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_adjustments_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'mrr_adjustments_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)
}
