import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.invoice_reschedules` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (3): tenant_isolation_insert_invoice_reschedules (INSERT, public); tenant_isolation_select_invoice_reschedules (SELECT, public); tenant_isolation_update_invoice_reschedules (UPDATE, public).
 */
@Entity('invoice_reschedules')
@Index('idx_invoice_reschedules_invoice_id', ['invoice_id'])
export class InvoiceReschedule {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_reschedules_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'date', nullable: false })
	old_date: Date;

	@Column({ type: 'date', nullable: false })
	new_date: Date;

	@Column({ type: 'text', nullable: false })
	reason: string;

	@Column({ type: 'uuid', nullable: true })
	changed_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	changed_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: true, default: () => 'now()' })
	created_at?: Date;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'changed_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reschedules_changed_by_fkey' })
	changedBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reschedules_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_reschedules_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)
}
