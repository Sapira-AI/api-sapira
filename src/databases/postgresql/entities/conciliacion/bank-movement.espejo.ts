import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { Company } from '@/modules/odoo/entities/companies.entity';
import { User } from '@/modules/users/entities/user.entity';

import { BankUploadBatch } from './bank-upload-batch.espejo';

/**
 * Espejo de `public.bank_movements` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Referenciada por FK desde 1 tabla(s): invoice_payments.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_bank_movements (DELETE, authenticated); tenant_isolation_insert_bank_movements (INSERT, authenticated); tenant_isolation_select_bank_movements (SELECT, authenticated); tenant_isolation_update_bank_movements (UPDATE, authenticated).
 */
@Entity('bank_movements')
@Check('bank_movements_match_confidence_check', "match_confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])")
@Check('bank_movements_status_check', "status = ANY (ARRAY['Pendiente'::text, 'Conciliado'::text])")
@Index('idx_bank_movements_batch_id', ['batch_id'])
@Index('idx_bank_movements_holding_date', ['holding_id', 'movement_date'])
@Index('idx_bank_movements_holding_id', ['holding_id'])
@Index('idx_bank_movements_reconciled_invoice', ['reconciled_invoice_id'])
@Index('idx_bank_movements_status', ['status'])
export class BankMovement {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'bank_movements_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	bank_name?: string;

	@Column({ type: 'text', nullable: true })
	bank_account?: string;

	@Column({ type: 'date', nullable: true })
	movement_date?: Date;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'numeric', nullable: true })
	amount?: number;

	@Column({ type: 'text', nullable: true })
	currency?: string;

	@Column({ type: 'text', nullable: true, default: 'Pendiente' })
	status?: string;

	@Column({ type: 'uuid', nullable: true })
	suggested_invoice_id?: string;

	@CreateDateColumn({ type: 'timestamp without time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string;

	@Column({ type: 'uuid', nullable: true })
	reconciled_invoice_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	reconciled_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	reconciled_by?: string;

	@Column({ type: 'text', nullable: true })
	match_confidence?: string;

	@Column({ type: 'numeric', nullable: true })
	match_score?: number;

	@Column({ type: 'jsonb', nullable: true })
	original_row_data?: any;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'reconciled_by', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_movements_reconciled_by_fkey' })
	reconciledBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'fk_bank_movements_holding_id' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Company)
	@JoinColumn({ name: 'company_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_movements_company_id_fkey' })
	company?: Company; // entity existente (no se duplica)

	@ManyToOne(() => Invoice)
	@JoinColumn({ name: 'suggested_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_movements_suggested_invoice_id_fkey' })
	suggestedInvoice?: Invoice; // entity existente (no se duplica)

	@ManyToOne(() => BankUploadBatch, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'batch_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_movements_batch_id_fkey' })
	batch?: BankUploadBatch;

	@ManyToOne(() => Invoice)
	@JoinColumn({ name: 'reconciled_invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'bank_movements_reconciled_invoice_id_fkey' })
	reconciledInvoice?: Invoice; // entity existente (no se duplica)
}
