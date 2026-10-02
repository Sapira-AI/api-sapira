import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { BudgetLine } from '@/databases/postgresql/entities/revenue/budget-line.entity';

export const BUDGET_KINDS = ['cash_in', 'billing', 'bookings', 'mrr', 'new_mrr', 'expansion_mrr', 'contraction_mrr', 'churn_mrr'] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];
export const BUDGET_SCENARIOS = ['base', 'optimistic', 'pessimistic'] as const;
export type BudgetScenario = (typeof BUDGET_SCENARIOS)[number];
export const BUDGET_GRANULARITIES = ['month', 'quarter', 'year'] as const;
export type BudgetGranularity = (typeof BUDGET_GRANULARITIES)[number];
export const BUDGET_STATUSES = ['draft', 'active', 'archived'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/**
 * `budgets` — presupuestos por holding (`docs/v2-rediseno/budgets-forecast-real.md` → "Construido 02-10: esquema"): cabecera por `kind`,
 * año fiscal (= año calendario) y escenario; las celdas en `budget_lines`. Un presupuesto vivo por (holding, kind, año, escenario): índice
 * único parcial `WHERE status <> 'archived'`. Montos en `currency` = moneda de sistema del holding al guardar.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790750000000-Budgets` (NO aplicada al 02-10). RLS activado en
 * la migración; 4 policies por holding (`rls/tenant_isolation_*_budgets.sql`); `updated_at` por `triggers/trg_budgets_updated_at.sql`.
 */
@Entity({
	name: 'budgets',
	comment:
		'Presupuestos por holding (caja, facturación, bookings, MRR): cabecera por kind, año fiscal y escenario; las celdas en budget_lines (budgets-forecast-real.md)',
})
@Check(
	'budgets_kind_check',
	`"kind" = ANY (ARRAY['cash_in'::text, 'billing'::text, 'bookings'::text, 'mrr'::text, 'new_mrr'::text, 'expansion_mrr'::text, 'contraction_mrr'::text, 'churn_mrr'::text])`
)
@Check('budgets_scenario_check', `"scenario" = ANY (ARRAY['base'::text, 'optimistic'::text, 'pessimistic'::text])`)
@Check('budgets_period_granularity_check', `"period_granularity" = ANY (ARRAY['month'::text, 'quarter'::text, 'year'::text])`)
@Check('budgets_status_check', `"status" = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`)
@Index('uq_budgets_holding_kind_year_scenario', ['holding_id', 'kind', 'fiscal_year', 'scenario'], {
	unique: true,
	where: `(status <> 'archived'::text)`,
})
export class Budget {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'budgets_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	kind: BudgetKind;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text', default: 'base' })
	scenario: BudgetScenario;

	@Column({ type: 'text', comment: 'Moneda de sistema del holding al guardar (los montos de las líneas van en esta moneda)' })
	currency: string;

	@Column({ type: 'text', default: 'month' })
	period_granularity: BudgetGranularity;

	@Column({ type: 'smallint', comment: 'Año fiscal (= año calendario)' })
	fiscal_year: number;

	@Column({ type: 'text', default: 'active' })
	status: BudgetStatus;

	@Column({ type: 'text', nullable: true })
	notes?: string | null;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'budgets_holding_id_fkey' })
	holding?: CompanyHolding;

	@OneToMany(() => BudgetLine, (line) => line.budget)
	lines?: BudgetLine[];
}
