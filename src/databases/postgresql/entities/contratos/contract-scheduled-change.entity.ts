import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ContractItem } from '@/databases/postgresql/entities/contratos/contract-item.entity';
import { ContractLifecycleEvent } from '@/databases/postgresql/entities/contratos/contract-lifecycle-event.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

export const SCHEDULED_CHANGE_TRIGGER_VALUES = ['on_renewal', 'on_date', 'every_n_months'] as const;
export const SCHEDULED_CHANGE_KIND_VALUES = ['percent_uplift', 'index', 'new_unit_price', 'quantity', 'term', 'billing_frequency'] as const;
export const SCHEDULED_CHANGE_ROUNDING_VALUES = ['none', 'unit_2', 'unit_0', 'monthly_0'] as const;
export const SCHEDULED_CHANGE_STATUS_VALUES = ['scheduled', 'applied', 'skipped', 'cancelled'] as const;

/**
 * `contract_scheduled_changes` — ajustes pactados del contrato o de un ítem (spec modificaciones §9.3.6, §9.4 #1; semántica en
 * `spec-renovacion-y-ajustes-pactados.md` §3): renovación con precio nuevo, IPC/UF, escalamientos, cambio de plazo o frecuencia.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790710000000-ContractModificationsBlock2`. RLS activado en
 * la migración; 4 policies como `contract_fx_period_rates` (`rls/tenant_isolation_*_contract_scheduled_changes.sql`); `updated_at` por
 * `triggers/trg_contract_scheduled_changes_updated_at.sql`. La API entra con rol privilegiado y acota por holding en cada consulta.
 */
@Entity({
	name: 'contract_scheduled_changes',
	comment:
		'Ajustes pactados del contrato o de un ítem (renovación con precio, IPC/UF, escalamientos, plazo, frecuencia): disparo, valor y estado (spec modificaciones §9.3.6)',
})
@Check('contract_scheduled_changes_trigger_check', `"trigger" = ANY (ARRAY['on_renewal'::text, 'on_date'::text, 'every_n_months'::text])`)
@Check(
	'contract_scheduled_changes_kind_check',
	`"kind" = ANY (ARRAY['percent_uplift'::text, 'index'::text, 'new_unit_price'::text, 'quantity'::text, 'term'::text, 'billing_frequency'::text])`
)
@Check('contract_scheduled_changes_rounding_check', `"rounding" = ANY (ARRAY['none'::text, 'unit_2'::text, 'unit_0'::text, 'monthly_0'::text])`)
@Check('contract_scheduled_changes_status_check', `"status" = ANY (ARRAY['scheduled'::text, 'applied'::text, 'skipped'::text, 'cancelled'::text])`)
@Check('contract_scheduled_changes_interval_months_check', `"interval_months" IS NULL OR "interval_months" > 0`)
@Check('contract_scheduled_changes_on_date_check', `"trigger" <> 'on_date' OR "effective_date" IS NOT NULL`)
@Check(
	'contract_scheduled_changes_every_n_months_check',
	`"trigger" <> 'every_n_months' OR ("anchor_date" IS NOT NULL AND "interval_months" IS NOT NULL)`
)
@Check('contract_scheduled_changes_index_check', `"kind" <> 'index' OR ("index_code" IS NOT NULL AND "index_base_value" IS NOT NULL)`)
@Index('idx_contract_scheduled_changes_contract_status', ['contract_id', 'status'])
@Index('idx_contract_scheduled_changes_holding_status_next', ['holding_id', 'status', 'next_effective_date'])
@Index('idx_contract_scheduled_changes_item', ['contract_item_id'])
export class ContractScheduledChange {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_scheduled_changes_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	contract_id: string;

	@Column({ type: 'uuid', nullable: true, comment: 'Ítem al que aplica; NULL = alcance contrato (todos los recurrentes vigentes al aplicar)' })
	contract_item_id?: string | null;

	/** Varios cambios del mismo acto (misma fecha) comparten la clave. */
	@Column({ type: 'uuid', nullable: true })
	group_key?: string | null;

	@Column({
		type: 'uuid',
		nullable: true,
		comment: 'every_n_months: cada aplicación es una fila hija applied; la madre sigue scheduled con next_effective_date',
	})
	parent_id?: string | null;

	@Column({ type: 'text' })
	trigger: (typeof SCHEDULED_CHANGE_TRIGGER_VALUES)[number];

	@Column({ type: 'date', nullable: true })
	effective_date?: string | null;

	@Column({ type: 'date', nullable: true })
	anchor_date?: string | null;

	@Column({ type: 'smallint', nullable: true })
	interval_months?: number | null;

	@Column({ type: 'date', nullable: true })
	next_effective_date?: string | null;

	@Column({ type: 'text' })
	kind: (typeof SCHEDULED_CHANGE_KIND_VALUES)[number];

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 6,
		comment:
			'Según kind: % (percent_uplift; index = puntos sobre el índice), precio en moneda del ítem, cantidad o meses (term, billing_frequency)',
	})
	value: number;

	@Column({ type: 'text', nullable: true })
	index_code?: string | null;

	@Column({ type: 'date', nullable: true })
	index_base_date?: string | null;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	index_base_value?: number | null;

	@Column({ type: 'smallint', nullable: true, default: 1 })
	index_lag_months?: number | null;

	@Column({ type: 'text', nullable: true, default: 'unit_2' })
	rounding?: (typeof SCHEDULED_CHANGE_ROUNDING_VALUES)[number] | null;

	@Column({ type: 'text', default: 'scheduled' })
	status: (typeof SCHEDULED_CHANGE_STATUS_VALUES)[number];

	@Column({ type: 'text', nullable: true })
	status_reason?: string | null;

	@Column({ type: 'uuid', nullable: true })
	status_changed_by?: string | null;

	@Column({ type: 'uuid', nullable: true, comment: 'Evento (contract_lifecycle_events) del cambio que materializó el pacto' })
	applied_event_id?: string | null;

	@Column({ type: 'timestamp with time zone', nullable: true })
	applied_at?: Date | null;

	@Column({
		type: 'numeric',
		precision: 18,
		scale: 6,
		nullable: true,
		comment: 'Valor efectivamente usado (índice real o valor editado en el acto)',
	})
	applied_value?: number | null;

	@Column({ type: 'jsonb', default: () => `'{"type":"manual"}'` })
	origin: Record<string, unknown>;

	@Column({ type: 'text', nullable: true })
	notes?: string | null;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_scheduled_changes_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_scheduled_changes_contract_id_fkey' })
	contract?: Contract;

	@ManyToOne(() => ContractItem, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'contract_item_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'contract_scheduled_changes_contract_item_id_fkey',
	})
	contractItem?: ContractItem;

	@ManyToOne(() => ContractScheduledChange, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'parent_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_scheduled_changes_parent_id_fkey' })
	parent?: ContractScheduledChange;

	@ManyToOne(() => ContractLifecycleEvent, { onDelete: 'SET NULL' })
	@JoinColumn({
		name: 'applied_event_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'contract_scheduled_changes_applied_event_id_fkey',
	})
	appliedEvent?: ContractLifecycleEvent;
}
