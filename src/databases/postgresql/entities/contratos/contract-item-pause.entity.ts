import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { ContractItem } from '@/databases/postgresql/entities/contratos/contract-item.entity';
import { ContractLifecycleEvent } from '@/databases/postgresql/entities/contratos/contract-lifecycle-event.entity';
import { Contract } from '@/databases/postgresql/entities/contratos/contract.entity';

export const CONTRACT_ITEM_PAUSE_STATUS_VALUES = ['scheduled', 'active', 'ended', 'cancelled'] as const;

/**
 * `contract_item_pauses` — pausas de servicio por ítem (spec modificaciones §9.3.3, §9.4 #2): devengo y MRR 0 en el tramo; `pause_end`
 * NULL = hasta reanudar. La usa el bloque B2-5 (pausar / reanudar); este bloque solo crea la tabla.
 *
 * NO es un espejo: tabla propia de api-sapira, creada por entity + migración `1790710000000-ContractModificationsBlock2`. RLS activado en
 * la migración; 4 policies como `contract_fx_period_rates` (`rls/tenant_isolation_*_contract_item_pauses.sql`); `updated_at` por
 * `triggers/trg_contract_item_pauses_updated_at.sql`.
 */
@Entity({
	name: 'contract_item_pauses',
	comment: 'Pausas de servicio por ítem (spec modificaciones §9.3.3): devengo y MRR 0 en el tramo; pause_end NULL = hasta reanudar',
})
@Check('contract_item_pauses_status_check', `"status" = ANY (ARRAY['scheduled'::text, 'active'::text, 'ended'::text, 'cancelled'::text])`)
@Check('contract_item_pauses_dates_check', `"pause_end" IS NULL OR "pause_end" >= "pause_start"`)
@Index('idx_contract_item_pauses_item_status', ['contract_item_id', 'status'])
export class ContractItemPause {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_item_pauses_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	contract_id: string;

	@Column({ type: 'uuid' })
	contract_item_id: string;

	@Column({ type: 'date' })
	pause_start: string;

	@Column({ type: 'date', nullable: true })
	pause_end?: string | null;

	@Column({ type: 'boolean', default: false, comment: 'Al reanudar, el fin del ítem se corre en los días pausados' })
	extend_term: boolean;

	@Column({ type: 'text', default: 'scheduled' })
	status: (typeof CONTRACT_ITEM_PAUSE_STATUS_VALUES)[number];

	@Column({ type: 'text', nullable: true })
	reason?: string | null;

	@Column({ type: 'uuid', nullable: true })
	pause_event_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	resume_event_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_pauses_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_pauses_contract_id_fkey' })
	contract?: Contract;

	@ManyToOne(() => ContractItem, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_pauses_contract_item_id_fkey' })
	contractItem?: ContractItem;

	@ManyToOne(() => ContractLifecycleEvent, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'pause_event_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_pauses_pause_event_id_fkey' })
	pauseEvent?: ContractLifecycleEvent;

	@ManyToOne(() => ContractLifecycleEvent, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'resume_event_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_item_pauses_resume_event_id_fkey' })
	resumeEvent?: ContractLifecycleEvent;
}
