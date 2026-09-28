import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

/**
 * Entity de `public.contract_fx_period_rates` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 6 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_contract_fx_rates_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): tenant_isolation_delete_contract_fx_rates_enhanced (DELETE, public); tenant_isolation_insert_contract_fx_rates_enhanced (INSERT, public); tenant_isolation_select_contract_fx_rates_enhanced (SELECT, public); tenant_isolation_update_contract_fx_rates_enhanced (UPDATE, public).
 */
@Entity('contract_fx_period_rates')
@Check('contract_fx_period_rates_check', 'period_end > period_start')
@Check('contract_fx_period_rates_rate_check', 'rate > (0)::numeric')
@Check('contract_fx_period_rates_purpose_check', `purpose = ANY (ARRAY['company'::text, 'invoice'::text])`)
@Index('idx_contract_fx_rates_contract_id', ['contract_id'])
@Index('idx_contract_fx_rates_currencies', ['from_currency', 'to_currency'])
@Index('idx_contract_fx_rates_holding_contract', ['holding_id', 'contract_id'])
@Index('idx_contract_fx_rates_period', ['period_start', 'period_end'])
@Index('idx_contract_fx_rates_contract_purpose', ['contract_id', 'purpose'])
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

	/** Regla única (v2): "1 [from_currency] = rate [to_currency]". v2 escribe siempre contrato → otra moneda. */
	@Column({ type: 'numeric', precision: 15, scale: 6, nullable: false })
	rate: number;

	/**
	 * Para qué es la tasa fija: `company` (devengo en moneda de la compañía, política `fixed_period`) o `invoice` (tipo de
	 * cambio fijo de facturación). Default `company`: el front viejo inserta sin este campo.
	 */
	@Column({
		type: 'text',
		nullable: false,
		default: 'company',
		comment:
			'Uso de la tasa fija: company (devengo en moneda de la compañía, fx_company_policy = fixed_period) o invoice (tipo de cambio fijo de facturación, fx_invoice_policy = fixed). Regla: 1 [from_currency] = rate [to_currency]',
	})
	purpose: 'company' | 'invoice';

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
