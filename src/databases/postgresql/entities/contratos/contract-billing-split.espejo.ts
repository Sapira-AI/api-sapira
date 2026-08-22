import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';

/**
 * Espejo de `public.contract_billing_splits` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_billing_splits (DELETE, public); tenant_isolation_insert_billing_splits (INSERT, public); tenant_isolation_select_billing_splits (SELECT, public); tenant_isolation_update_billing_splits (UPDATE, public).
 */
@Entity('contract_billing_splits')
@Check('contract_billing_splits_percent_allocation_check', '(percent_allocation >= (0)::numeric) AND (percent_allocation <= (100)::numeric)')
@Check('valid_date_range', '(effective_to IS NULL) OR (effective_to >= effective_from)')
@Index('idx_billing_splits_company', ['billing_company_id'])
@Index('idx_billing_splits_contract', ['contract_id'])
@Index('idx_billing_splits_dates', ['effective_from', 'effective_to'])
export class ContractBillingSplit {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_billing_splits_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: false })
	billing_company_id: string;

	@Column({ type: 'text', nullable: false })
	billing_currency: string;

	@Column({ type: 'numeric', nullable: false })
	percent_allocation: number;

	@Column({ type: 'date', nullable: false })
	effective_from: Date;

	@Column({ type: 'date', nullable: true })
	effective_to?: Date;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => Company)
	@JoinColumn({
		name: 'billing_company_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'contract_billing_splits_billing_company_id_fkey',
	})
	billingCompany?: Company; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_billing_splits_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_billing_splits_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)
}
