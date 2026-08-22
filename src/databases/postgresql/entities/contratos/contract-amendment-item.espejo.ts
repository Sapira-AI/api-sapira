import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';

import { ContractAmendment } from './contract-amendment.espejo';
import { ContractItem } from './contract-item.espejo';

/**
 * Espejo de `public.contract_amendment_items` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 35 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_set_amendment_item_holding · BEFORE INSERT FOR EACH ROW → set_contract_amendment_item_holding_id().
 * Policies (3): tenant_amend_items_ins (INSERT, public); tenant_amend_items_sel (SELECT, public); tenant_amend_items_upd (UPDATE, public).
 */
@Entity('contract_amendment_items')
@Index('idx_amendment_items_amendment', ['amendment_id'])
@Index('idx_amendment_items_holding', ['holding_id'])
@Index('idx_amendment_items_new', ['new_item_id'])
@Index('idx_amendment_items_original', ['original_item_id'])
export class ContractAmendmentItem {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_amendment_items_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	amendment_id: string;

	@Column({ type: 'uuid', nullable: true })
	original_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	new_item_id?: string;

	@Column({ type: 'enum', enum: ['permanent', 'one_time'], enumName: 'amendment_scope_type', nullable: true })
	scope?: string;

	@Column({ type: 'numeric', nullable: true })
	quantity_delta?: number;

	@Column({ type: 'numeric', nullable: true })
	price_delta?: number;

	@Column({ type: 'date', nullable: true })
	start_date_override?: Date;

	@Column({ type: 'date', nullable: true })
	end_date_override?: Date;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'jsonb', nullable: true, default: '{}' })
	item_metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => ContractAmendment, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'amendment_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendment_items_amendment_id_fkey' })
	amendment?: ContractAmendment;

	@ManyToOne(() => ContractItem)
	@JoinColumn({ name: 'original_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendment_items_original_item_id_fkey' })
	originalItem?: ContractItem;

	@ManyToOne(() => CompanyHolding, { onDelete: 'RESTRICT' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendment_items_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem)
	@JoinColumn({ name: 'new_item_id', referencedColumnName: 'id', foreignKeyConstraintName: 'contract_amendment_items_new_item_id_fkey' })
	newItem?: ContractItem;
}
