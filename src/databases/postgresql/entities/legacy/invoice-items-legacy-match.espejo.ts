import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';
import { Product } from '@/modules/odoo/entities/products.entity';
import { User } from '@/modules/users/entities/user.entity';

import { ContractItem } from '../contratos/contract-item.espejo';

import { InvoiceItemsLegacy } from './invoice-items-legacy.espejo';

/**
 * Espejo de `public.invoice_items_legacy_match` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 78 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Asignaciones de líneas legacy a contract_items (permite splits)
 * Referenciada por FK desde 1 tabla(s): invoice_items.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_prevent_confirmed_match_edit · BEFORE UPDATE FOR EACH ROW → prevent_confirmed_match_edit(); trigger_set_match_confirmed_metadata · BEFORE UPDATE FOR EACH ROW → set_match_confirmed_metadata(); trigger_update_invoice_legacy_status · AFTER INSERT OR DELETE OR UPDATE FOR EACH ROW → update_invoice_legacy_status(); trigger_validate_match_total · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_match_total().
 * Policies (4): tenant_isolation_delete_legacy_match (DELETE, public); tenant_isolation_insert_legacy_match (INSERT, public); tenant_isolation_select_legacy_match (SELECT, public); tenant_isolation_update_legacy_match (UPDATE, public).
 */
@Entity('invoice_items_legacy_match')
@Check('invoice_items_legacy_match_status_check', "status = ANY (ARRAY['tentative'::text, 'confirmed'::text])")
@Check('match_amount_positive', '(amount_contract_currency > (0)::numeric) AND (amount_invoice_currency > (0)::numeric)')
@Index('idx_legacy_match_contract', ['contract_id'])
@Index('idx_legacy_match_contract_item', ['contract_item_id'])
@Index('idx_legacy_match_holding', ['holding_id'])
@Index('idx_legacy_match_item', ['invoice_item_legacy_id'])
@Index('idx_legacy_match_status', ['status'])
export class InvoiceItemsLegacyMatch {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_items_legacy_match_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_item_legacy_id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'uuid', nullable: true })
	contract_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	product_id?: string;

	@Column({ type: 'text', nullable: false })
	contract_currency: string;

	@Column({ type: 'numeric', precision: 12, scale: 6, nullable: false })
	fx_contract_to_invoice: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	amount_contract_currency: number;

	@Column({ type: 'numeric', precision: 15, scale: 2, nullable: false })
	amount_invoice_currency: number;

	@Column({ type: 'text', nullable: false, default: 'tentative' })
	status: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'uuid', nullable: false })
	created_by: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	confirmed_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	confirmed_by?: string;

	/** Holding ID para seguridad multi-tenant */
	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'confirmed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_confirmed_by_fkey' })
	confirmedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => ContractItem, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'contract_item_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'invoice_items_legacy_match_contract_item_id_fkey',
	})
	contractItem?: ContractItem; // espejo de otro módulo

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_contract_id_fkey' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => InvoiceItemsLegacy, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'invoice_item_legacy_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'invoice_items_legacy_match_invoice_item_legacy_id_fkey',
	})
	invoiceItemLegacy?: InvoiceItemsLegacy;

	@ManyToOne(() => Product, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'product_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_items_legacy_match_product_id_fkey' })
	product?: Product; // entity existente (no se duplica)
}
