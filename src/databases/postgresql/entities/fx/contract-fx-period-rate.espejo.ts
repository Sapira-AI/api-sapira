import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';

/**
 * Espejo de `public.contract_fx_period_rates` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_contract_fx_rates_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): tenant_isolation_delete_contract_fx_rates_enhanced (DELETE, public); tenant_isolation_insert_contract_fx_rates_enhanced (INSERT, public); tenant_isolation_select_contract_fx_rates_enhanced (SELECT, public); tenant_isolation_update_contract_fx_rates_enhanced (UPDATE, public).
 */
@Entity('contract_fx_period_rates')
@Check('contract_fx_period_rates_check', 'period_end > period_start')
@Check('contract_fx_period_rates_rate_check', 'rate > (0)::numeric')
@Index('idx_contract_fx_rates_contract_id', ['contract_id'])
@Index('idx_contract_fx_rates_currencies', ['from_currency', 'to_currency'])
@Index('idx_contract_fx_rates_holding_contract', ['holding_id', 'contract_id'])
@Index('idx_contract_fx_rates_period', ['period_start', 'period_end'])
export class ContractFxPeriodRate {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_fx_period_rates_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	from_currency: string;

	@Column({ type: 'text', nullable: false })
	to_currency: string;

	@Column({ type: 'numeric', precision: 15, scale: 6, nullable: false })
	rate: number;

	@Column({ type: 'date', nullable: false })
	period_start: Date;

	@Column({ type: 'date', nullable: false })
	period_end: Date;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_fx_period_rates_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_fx_period_rates_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
