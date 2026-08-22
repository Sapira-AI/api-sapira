import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';

/**
 * Espejo de `public.contract_lifecycle_events` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 176 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: set_updated_at_on_contract_lifecycle_events · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at(); trg_lifecycle_events_update_updated_at · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at(); trg_set_lifecycle_event_holding_id_ins · BEFORE INSERT FOR EACH ROW → set_lifecycle_event_holding_id(); trg_set_lifecycle_event_holding_id_upd · BEFORE UPDATE OF contract_id FOR EACH ROW → set_lifecycle_event_holding_id(); update_contract_lifecycle_events_updated_at · BEFORE UPDATE FOR EACH ROW → update_contract_lifecycle_events_updated_at().
 * Policies (3): Users can insert lifecycle events for their holding contracts (INSERT, public); Users can update lifecycle events from their holding contracts (UPDATE, public); Users can view lifecycle events from their holding contracts (SELECT, public).
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_contract_lifecycle_events_contract_date ON public.contract_lifecycle_events USING btree (contract_id, effective_date DESC, created_at DESC)
 * Índice no declarado (expresión/orden/método): CREATE INDEX idx_contract_lifecycle_events_contract_effective ON public.contract_lifecycle_events USING btree (contract_id, effective_date DESC)
 */
@Entity('contract_lifecycle_events')
@Index('idx_contract_lifecycle_events_contract_id', ['contract_id'])
@Index('idx_contract_lifecycle_events_holding_id', ['holding_id'])
export class ContractLifecycleEvent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_lifecycle_events_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'text', nullable: false })
	event_type: string;

	@Column({ type: 'text', nullable: false, default: 'pending' })
	event_status: string;

	@Column({ type: 'text', nullable: false })
	title: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'uuid', nullable: false })
	created_by: string;

	@Column({ type: 'uuid', nullable: true })
	approved_by?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	client_approval_required?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	client_approved_at?: Date;

	@Column({ type: 'text', nullable: true })
	client_approved_by?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	internal_approval_required?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	internal_approved_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	internal_approved_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	completed_at?: Date;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	metadata?: any;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'date', nullable: true })
	effective_date?: Date;

	@Column({ type: 'numeric', nullable: true })
	amount_delta?: number;

	@Column({ type: 'text', nullable: true })
	summary?: string;

	@Column({ type: 'jsonb', nullable: true })
	items_affected?: any;

	@Column({ type: 'text', nullable: true })
	event_subtype?: string;

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_lifecycle_events_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_lifecycle_events_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)
}
