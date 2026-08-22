import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';

/**
 * Espejo de `public.contract_amendments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 56 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): contract_amendment_items.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_set_amendment_holding · BEFORE INSERT FOR EACH ROW → set_contract_amendment_holding_id().
 * Policies (3): tenant_amendments_ins (INSERT, public); tenant_amendments_sel (SELECT, public); tenant_amendments_upd (UPDATE, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_contract_amendments_contract_date ON public.contract_amendments USING btree (contract_id, effective_date DESC, created_at DESC)
 */
@Entity('contract_amendments')
@Index('idx_contract_amendments_contract', ['contract_id'])
@Index('idx_contract_amendments_holding', ['holding_id'])
@Index('idx_contract_amendments_status', ['status'])
export class ContractAmendment {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_amendments_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'enum', enum: ['RENEWAL', 'UPSELL', 'CROSS_SELL', 'DOWNSELL', 'CHURN'], enumName: 'contract_amendment_type', nullable: false })
	type: string;

	@Column({ type: 'text', nullable: true })
	reason?: string;

	@Column({ type: 'date', nullable: false })
	effective_date: Date;

	@Column({ type: 'text', nullable: false, default: 'Pending' })
	status: string;

	@Column({ type: 'uuid', nullable: true })
	requested_by?: string;

	@Column({ type: 'uuid', nullable: true })
	approved_by?: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	approval_required: boolean;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendments_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendments_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
