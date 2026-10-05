import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Budget } from '@/databases/postgresql/entities/revenue/budget.entity';

export const BUDGET_DIMENSION_TYPES = ['total', 'company', 'seller', 'product', 'segment', 'market', 'client'] as const;
export type BudgetDimensionType = (typeof BUDGET_DIMENSION_TYPES)[number];
/** Dimensiones que se identifican por id (`dimension_id`); `segment` y `market` van por texto (`dimension_key`). */
export const BUDGET_ID_DIMENSIONS = ['company', 'seller', 'product', 'client'] as const;
export const BUDGET_KEY_DIMENSIONS = ['segment', 'market'] as const;

/**
 * `budget_lines` — celdas de un presupuesto (`budgets`): período (`period_start` = primer día del mes, trimestre o año según la granularidad
 * del presupuesto), dimensión y monto (≥ 0) en la moneda del presupuesto. `total` sin id ni clave; `company`/`seller`/`product`/`client` con
 * `dimension_id`; `segment`/`market` con `dimension_key` (texto de `clients.segment` / `clients.market`).
 *
 * Celda única por índice de expresión `uq_budget_lines_cell` (COALESCE de id y clave), que `@Index` no representa: lo crea la migración y
 * también es asset (`special-index/uq_budget_lines_cell.sql`); aquí solo se avisa con `synchronize: false`.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790750000000-Budgets` (NO aplicada al 02-10). RLS activado en
 * la migración; 4 policies por holding (`rls/tenant_isolation_*_budget_lines.sql`); `updated_at` por `triggers/trg_budget_lines_updated_at.sql`.
 */
@Entity({
	name: 'budget_lines',
	comment: 'Celdas de un presupuesto: período (primer día del mes, trimestre o año), dimensión y monto en la moneda del presupuesto',
})
@Check(
	'budget_lines_dimension_type_check',
	`"dimension_type" = ANY (ARRAY['total'::text, 'company'::text, 'seller'::text, 'product'::text, 'segment'::text, 'market'::text, 'client'::text])`
)
@Check(
	'budget_lines_dimension_check',
	`("dimension_type" = 'total' AND "dimension_id" IS NULL AND "dimension_key" IS NULL) OR ("dimension_type" = ANY (ARRAY['segment'::text, 'market'::text]) AND "dimension_id" IS NULL AND "dimension_key" IS NOT NULL) OR ("dimension_type" = ANY (ARRAY['company'::text, 'seller'::text, 'product'::text, 'client'::text]) AND "dimension_id" IS NOT NULL AND "dimension_key" IS NULL)`
)
@Check('budget_lines_amount_check', `"amount" >= 0`)
@Check('budget_lines_period_start_check', `EXTRACT(DAY FROM "period_start") = 1`)
@Index('uq_budget_lines_cell', { synchronize: false })
@Index('idx_budget_lines_budget', ['budget_id'])
@Index('idx_budget_lines_holding_period', ['holding_id', 'period_start'])
export class BudgetLine {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'budget_lines_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	budget_id: string;

	@Column({ type: 'date' })
	period_start: string;

	@Column({ type: 'text', default: 'total' })
	dimension_type: BudgetDimensionType;

	@Column({ type: 'uuid', nullable: true, comment: 'company, seller, product, client: id de la entidad; NULL en total, segment y market' })
	dimension_id?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'segment, market: valor del cliente (clients.segment / clients.market)' })
	dimension_key?: string | null;

	@Column({ type: 'numeric', precision: 18, scale: 2 })
	amount: string;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'budget_lines_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Budget, (budget) => budget.lines, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'budget_id', referencedColumnName: 'id', foreignKeyConstraintName: 'budget_lines_budget_id_fkey' })
	budget?: Budget;
}
