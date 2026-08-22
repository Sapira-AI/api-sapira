import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.invoice_adjustments` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_invoice_adjustments (DELETE, public); tenant_isolation_insert_invoice_adjustments (INSERT, public); tenant_isolation_select_invoice_adjustments (SELECT, public); tenant_isolation_update_invoice_adjustments (UPDATE, public).
 */
@Entity('invoice_adjustments')
@Check('invoice_adjustments_type_check', "type = ANY (ARRAY['discount'::text, 'downsell'::text, 'upsell'::text, 'reagenda'::text])")
@Index('idx_invoice_adjustments_holding_id', ['holding_id'])
@Index('idx_invoice_adjustments_invoice_id', ['invoice_id'])
@Index('idx_invoice_adjustments_type', ['type'])
export class InvoiceAdjustment {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_adjustments_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'text', nullable: false })
	type: string;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: false })
	amount_diff: number;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'uuid', nullable: true })
	adjusted_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	adjusted_at: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_adjustments_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'adjusted_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_adjustments_adjusted_by_fkey' })
	adjustedBy?: User; // entity existente (no se duplica)
}
