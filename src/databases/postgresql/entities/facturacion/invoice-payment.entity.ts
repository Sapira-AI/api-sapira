import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

import { BankMovement } from '../conciliacion/bank-movement.entity';

/**
 * Entity de `public.invoice_payments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 243 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Desde el 2026-09-22 este archivo YA NO se regenera: es la fuente de verdad de su tabla y se edita a mano (entity → migración revisada → aplicar). El generador solo refresca el snapshot de prod contra el que su spec lo mide.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_recalc_after_delete · AFTER DELETE FOR EACH ROW → after_invoice_payment_change(); trg_recalc_after_insert · AFTER INSERT FOR EACH ROW → after_invoice_payment_change(); trg_recalc_after_update · AFTER UPDATE FOR EACH ROW → after_invoice_payment_change(); trg_set_invoice_payment_defaults · BEFORE INSERT FOR EACH ROW → set_invoice_payment_defaults().
 * Policies (4): invoice_payments_delete (DELETE, public); invoice_payments_insert (INSERT, public); invoice_payments_select (SELECT, public); invoice_payments_update (UPDATE, public).
 * Migración 1790740000000-BankReconciliationV2 (Conciliación v2, escrita y NO aplicada al 02-10-2026): `original_amount` + `fx_rate`
 * (pago en moneda distinta a la del movimiento bancario) y `settlement_reason` (ajuste no monetario) con sus dos CHECK. Hasta aplicarla,
 * el spec de deriva `facturacion.entities.spec.ts` falla a propósito.
 */
@Entity('invoice_payments')
@Check(
	'invoice_payments_settlement_reason_check',
	"((settlement_reason IS NULL) OR (settlement_reason = ANY (ARRAY['bank_fee'::text, 'withholding'::text, 'fx_difference'::text, 'rounding'::text, 'other'::text])))"
)
@Check(
	'invoice_payments_original_check',
	'(((original_amount IS NULL) = (fx_rate IS NULL)) AND ((original_amount IS NULL) OR (bank_movement_id IS NOT NULL)))'
)
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

	/** Monto en la moneda del movimiento bancario (`bank_movements.currency`) cuando difiere de la de la factura; con `fx_rate`. */
	@Column({ type: 'numeric', nullable: true })
	original_amount?: number;

	/** Unidades de moneda de la factura por 1 de la del movimiento: `amount = round2(original_amount × fx_rate)`. */
	@Column({ type: 'numeric', nullable: true })
	fx_rate?: number;

	/** Ajuste no monetario (`method = 'adjustment'`): bank_fee · withholding · fx_difference · rounding · other. NULL = pago monetario. */
	@Column({ type: 'text', nullable: true })
	settlement_reason?: string;

	@ManyToOne(() => BankMovement)
	@JoinColumn({ name: 'bank_movement_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_payments_bank_movement_id_fkey' })
	bankMovement?: BankMovement; // de otro módulo

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_payments_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)
}
