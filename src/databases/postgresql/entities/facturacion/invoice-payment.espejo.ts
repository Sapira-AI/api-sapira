import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from '@/modules/invoices/entities/invoice.entity';

import { BankMovement } from '../conciliacion/bank-movement.espejo';

/**
 * Espejo de `public.invoice_payments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 89 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_recalc_after_delete · AFTER DELETE FOR EACH ROW → after_invoice_payment_change(); trg_recalc_after_insert · AFTER INSERT FOR EACH ROW → after_invoice_payment_change(); trg_recalc_after_update · AFTER UPDATE FOR EACH ROW → after_invoice_payment_change(); trg_set_invoice_payment_defaults · BEFORE INSERT FOR EACH ROW → set_invoice_payment_defaults().
 * Policies (4): invoice_payments_delete (DELETE, public); invoice_payments_insert (INSERT, public); invoice_payments_select (SELECT, public); invoice_payments_update (UPDATE, public).
 */
@Entity('invoice_payments')
@Index('idx_invoice_payments_bank_movement', ['bank_movement_id'])
@Index('idx_invoice_payments_holding_date', ['holding_id', 'payment_date'])
export class InvoicePayment {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_payments_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'numeric', nullable: false })
	amount: number;

	@Column({ type: 'text', nullable: false })
	currency: string;

	@Column({ type: 'date', nullable: false, default: () => 'CURRENT_DATE' })
	payment_date: Date;

	@Column({ type: 'text', nullable: true })
	method?: string;

	@Column({ type: 'text', nullable: true })
	reference?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	confirmed: boolean;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	bank_movement_id?: string;

	@ManyToOne(() => BankMovement)
	@JoinColumn({ name: 'bank_movement_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_payments_bank_movement_id_fkey' })
	bankMovement?: BankMovement; // espejo de otro módulo

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_payments_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)
}
