import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/** Cómo se agrega el valor de la métrica en el período (Zenskar/Relvo/Lago). */
export const BILLABLE_METRIC_AGGREGATIONS = ['sum', 'count', 'max', 'min', 'last', 'unique_count'] as const;
export type BillableMetricAggregation = (typeof BILLABLE_METRIC_AGGREGATIONS)[number];

/** De dónde llega el consumo. Etapa 1 y 2: solo `manual` es funcional; `csv` lo carga la usuaria; `dwh`/`api` llegan con el canal DWH. */
export const BILLABLE_METRIC_SOURCE_KINDS = ['manual', 'csv', 'dwh', 'api'] as const;
export type BillableMetricSourceKind = (typeof BILLABLE_METRIC_SOURCE_KINDS)[number];

export const BILLABLE_METRIC_STATUSES = ['active', 'archived'] as const;
export type BillableMetricStatus = (typeof BILLABLE_METRIC_STATUSES)[number];

/**
 * `billable_metrics` — qué se mide y cómo se agrega, por holding (Pricing v2, `docs/v2-rediseno/spec-pricing-v2.md` §2.1).
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790630000000-CreatePricingV2`. RLS por
 * holding con `rls/holding_access_billable_metrics.sql` (espejo de `holding_access_contract_items`). La API entra con rol
 * privilegiado y acota por holding en cada consulta.
 */
@Entity({ name: 'billable_metrics', comment: 'Métricas facturables por holding: qué se mide (rutas, usuarios, GB), cómo se agrega y de dónde llega' })
@Unique('billable_metrics_holding_id_code_key', ['holding_id', 'code'])
@Index('idx_billable_metrics_holding_status', ['holding_id', 'status'])
@Check(
	'billable_metrics_aggregation_check',
	`"aggregation" = ANY (ARRAY['sum'::text, 'count'::text, 'max'::text, 'min'::text, 'last'::text, 'unique_count'::text])`
)
@Check('billable_metrics_source_kind_check', `"source_kind" = ANY (ARRAY['manual'::text, 'csv'::text, 'dwh'::text, 'api'::text])`)
@Check('billable_metrics_status_check', `"status" = ANY (ARRAY['active'::text, 'archived'::text])`)
export class BillableMetric {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'billable_metrics_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'Slug estable para API y DWH, único por holding' })
	code: string;

	@Column({ type: 'text', comment: 'Lo que ve la usuaria ("Rutas completadas")' })
	name: string;

	@Column({ type: 'text', nullable: true })
	description?: string | null;

	@Column({ type: 'text', comment: 'sum, count, max, min, last o unique_count' })
	aggregation: BillableMetricAggregation;

	@Column({ type: 'text', comment: 'Unidad en singular para glosa y UI ("ruta", "usuario", "GB")' })
	unit: string;

	@Column({ type: 'text', default: 'manual', comment: 'manual, csv, dwh o api' })
	source_kind: BillableMetricSourceKind;

	@Column({ type: 'jsonb', default: () => `'{}'`, comment: 'Para dwh: referencia a la consulta/tabla de BigQuery; para el resto {}' })
	source_config: Record<string, unknown>;

	@Column({ type: 'text', default: 'active', comment: 'active o archived; una métrica con precios activos no se archiva' })
	status: BillableMetricStatus;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@Column({ type: 'uuid', nullable: true })
	updated_by?: string | null;

	@Column({ type: 'timestamp with time zone', nullable: true })
	archived_at?: Date | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'billable_metrics_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'billable_metrics_created_by_fkey' })
	createdBy?: User;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'updated_by', referencedColumnName: 'id', foreignKeyConstraintName: 'billable_metrics_updated_by_fkey' })
	updatedBy?: User;
}
