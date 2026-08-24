import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Contract } from '@/modules/invoices/entities/contract.entity';

import { InvoicesLegacy } from '../legacy/invoices-legacy.espejo';

/**
 * Espejo de `public.contract_invoices` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 4922 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (5): Users can delete contract invoices from their holding (DELETE, public); Users can insert contract invoices for their holding (INSERT, public); Users can update contract invoices from their holding (UPDATE, public); Users can view contract invoices from their holding (SELECT, public); holding_access_contract_invoices (ALL, public).
 */
@Entity('contract_invoices')
@Index('idx_contract_invoices_contract_id', ['contract_id'])
@Index('idx_contract_invoices_date', ['invoice_date'])
@Index('idx_contract_invoices_holding_id', ['holding_id'])
@Index('idx_contract_invoices_status', ['status'])
export class ContractInvoice {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contract_invoices_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	contract_id: string;

	@Column({ type: 'date', nullable: false })
	invoice_date: Date;

	@Column({ type: 'numeric', nullable: false })
	amount: number;

	@Column({ type: 'text', nullable: false })
	currency: string;

	@Column({ type: 'text', nullable: false, default: 'Programada' })
	status: string;

	@Column({ type: 'jsonb', nullable: false, default: '[]' })
	contract_items: any;

	@Column({ type: 'jsonb', nullable: false, default: '[]' })
	contract_item_details: any;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_editable: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: false, default: () => 'gen_random_uuid()' })
	holding_id: string;

	/** Moneda de emisión de la factura (puede diferir de currency que es moneda del contrato) */
	@Column({ type: 'text', nullable: true })
	invoice_currency?: string;

	/** Política FX: fixed (tipo cambio fijo) o spot (tipo cambio del día de emisión) */
	@Column({ type: 'text', nullable: true })
	fx_policy?: string;

	/** Tipo de cambio fijo cuando fx_policy = fixed */
	@Column({ type: 'numeric', nullable: true })
	fx_contract_to_invoice?: number;

	/** Factura legacy que satisfizo esta factura programada */
	@Column({ type: 'uuid', nullable: true })
	satisfied_by_legacy_id?: string;

	/** Indica si la factura programada ya fue cubierta por legacy */
	@Column({ type: 'boolean', nullable: true, default: false })
	is_satisfied?: boolean;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_invoices_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Contract, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'contract_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_contract_invoices_contract_id' })
	contract?: Contract; // entity existente (no se duplica)

	@ManyToOne(() => InvoicesLegacy, { onDelete: 'SET NULL' })
	@JoinColumn({
		name: 'satisfied_by_legacy_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'contract_invoices_satisfied_by_legacy_id_fkey',
	})
	satisfiedByLegacy?: InvoicesLegacy; // espejo de otro módulo
}
