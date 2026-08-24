import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';

import { ContractItem } from '../contratos/contract-item.espejo';
import { SubscriptionItem } from '../suscripciones/subscription-item.espejo';
import { Subscription } from '../suscripciones/subscription.espejo';

/**
 * Espejo de `public.revenue_schedule_monthly` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 18415 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_assign_momentum · BEFORE INSERT OR UPDATE OF contract_item_id, period_month FOR EACH ROW → assign_momentum_to_revenue_schedule(); update_revenue_schedule_monthly_updated_at · BEFORE UPDATE FOR EACH ROW → update_revenue_schedule_monthly_updated_at().
 * Policies (4): tenant_isolation_delete_revenue_schedule_monthly (DELETE, public); tenant_isolation_insert_revenue_schedule_monthly (INSERT, public); tenant_isolation_select_revenue_schedule_monthly (SELECT, public); tenant_isolation_update_revenue_schedule_monthly (UPDATE, public).
 */
@Entity('revenue_schedule_monthly')
@Unique('revenue_schedule_monthly_contract_item_period_momentum_key', ['contract_id', 'contract_item_id', 'period_month', 'momentum'])
@Check(
	'revenue_schedule_monthly_momentum_check',
	"momentum = ANY (ARRAY['NEW'::text, 'REACTIVATION'::text, 'UPSELL'::text, 'CROSS-SELL'::text, 'DOWNSELL'::text, 'CHURN'::text, 'RENEWAL'::text, 'BOP'::text, 'PENDING_RENEWAL'::text])"
)
@Check('rsm_contract_or_subscription_required', '(contract_id IS NOT NULL) OR (subscription_id IS NOT NULL)')
@Index('idx_revenue_schedule_momentum', ['momentum', 'period_month'])
@Index('idx_revenue_schedule_monthly_company_period', ['company_id', 'period_month'])
@Index('idx_revenue_schedule_monthly_contract', ['contract_id'])
@Index('idx_revenue_schedule_monthly_holding_period', ['holding_id', 'period_month'])
@Index('idx_revenue_schedule_monthly_is_total_row', ['contract_id', 'is_total_row', 'period_month'])
@Index('idx_rsm_cmrr_period', ['holding_id', 'period_month', 'cmrr_period_contract_ccy'], { where: 'cmrr_period_contract_ccy > (0)::numeric' })
@Index('idx_rsm_company_period', ['company_id', 'period_month'])
@Index('idx_rsm_contract_period', ['contract_id', 'period_month'])
@Index('idx_rsm_mrr_contracted_period', ['holding_id', 'period_month', 'mrr_period_contracted_contract_ccy'], {
	where: 'mrr_period_contracted_contract_ccy > (0)::numeric',
})
@Index('idx_rsm_subscription_id', ['subscription_id'], { where: 'subscription_id IS NOT NULL' })
@Index('idx_rsm_subscription_item_id', ['subscription_item_id'], { where: 'subscription_item_id IS NOT NULL' })
export class RevenueScheduleMonthly {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'revenue_schedule_monthly_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_item_id?: string;

	@Column({ type: 'date', nullable: false })
	period_month: Date;

	@Column({ type: 'uuid', nullable: false })
	company_id: string;

	@Column({ type: 'text', nullable: false })
	company_currency: string;

	@Column({ type: 'text', nullable: false })
	contract_currency: string;

	@Column({ type: 'text', nullable: false, default: 'USD' })
	system_currency: string;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	recognized_period_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	recognized_cum_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	billed_period_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	billed_cum_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	deferred_balance_eom_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	unbilled_balance_eom_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	mrr_period_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	recognized_period_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	recognized_cum_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	billed_period_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	billed_cum_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	deferred_balance_eom_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	unbilled_balance_eom_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	mrr_period_contract_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	recognized_period_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	recognized_cum_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	billed_period_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	billed_cum_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	deferred_balance_eom_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	unbilled_balance_eom_system_ccy?: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true })
	mrr_period_system_ccy?: number;

	@Column({ type: 'text', nullable: false, default: 'v1.0' })
	calc_version: string;

	@Column({ type: 'text', nullable: true })
	source_snapshot_hash?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	deferred_balance_period_ccy?: number;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	unbilled_balance_period_ccy?: number;

	@Column({ type: 'text', nullable: true })
	product_name?: string;

	@Column({ type: 'numeric', nullable: true, default: 1 })
	fx_contract_to_company?: number;

	@Column({ type: 'numeric', nullable: true, default: 1 })
	fx_contract_to_system?: number;

	@Column({ type: 'text', nullable: true })
	fx_to_company_source?: string;

	@Column({ type: 'date', nullable: true })
	fx_to_company_date?: Date;

	@Column({ type: 'text', nullable: true })
	fx_to_system_source?: string;

	@Column({ type: 'date', nullable: true })
	fx_to_system_date?: Date;

	@Column({ type: 'boolean', nullable: false, default: false })
	is_total_row: boolean;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	deferred_balance_period_contract_ccy?: number;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	unbilled_balance_period_contract_ccy?: number;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	deferred_balance_period_system_ccy?: number;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	unbilled_balance_period_system_ccy?: number;

	/** Momentum del MRR: NEW/UPSELL/etc en primer periodo, BOP en periodos subsiguientes */
	@Column({ type: 'text', nullable: true })
	momentum?: string;

	/** MRR Contracted: Valor mensual del contrato original (monthly_price del contract_item). Solo items recurrentes con start_date <= period_month. No se ajusta con quantities ni descuentos puntuales. */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	mrr_period_contracted_contract_ccy?: number;

	/** CMRR (Committed MRR): Valor mensual contractual proyectado (monthly_price del contract_item). Incluye TODOS los items recurrentes del contrato sin importar start_date. No se ajusta con quantities ni descuentos puntuales. */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	cmrr_period_contract_ccy?: number;

	/** MRR Contracted en moneda de compañía (convertido con FX). */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	mrr_period_contracted_ccy?: number;

	/** CMRR en moneda de compañía (convertido con FX). */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	cmrr_period_ccy?: number;

	/** MRR Contracted en moneda de sistema (convertido con FX). */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	mrr_period_contracted_system_ccy?: number;

	/** CMRR en moneda de sistema (convertido con FX). */
	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: true, default: 0 })
	cmrr_period_system_ccy?: number;

	/** FK a subscriptions. Usado para registros RSM de suscripciones externas. Mutuamente excluyente con contract_id. */
	@Column({ type: 'uuid', nullable: true })
	subscription_id?: string;

	/** FK a subscription_items. Permite desglose de RSM por item de suscripción. */
	@Column({ type: 'uuid', nullable: true })
	subscription_item_id?: string;

	@ManyToOne(() => SubscriptionItem)
	@JoinColumn({
		name: 'subscription_item_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'revenue_schedule_monthly_subscription_item_id_fkey',
	})
	subscriptionItem?: SubscriptionItem; // espejo de otro módulo

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_revenue_schedule_holding' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Contract)
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_revenue_schedule_contract' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_revenue_schedule_company' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem)
	@JoinColumn({ name: 'contract_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_revenue_schedule_item' })
	contractItem?: ContractItem; // espejo de otro módulo

	@ManyToOne(() => Subscription)
	@JoinColumn({ name: 'subscription_id', referencedColumnName: 'id', foreignKeyConstraintName: 'revenue_schedule_monthly_subscription_id_fkey' })
	subscription?: Subscription; // espejo de otro módulo
}
