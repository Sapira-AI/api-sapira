import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from '@/modules/invoices/entities/invoice.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.invoice_emails` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_invoice_emails (DELETE, public); tenant_isolation_insert_invoice_emails (INSERT, public); tenant_isolation_select_invoice_emails (SELECT, public); tenant_isolation_update_invoice_emails (UPDATE, public).
 */
@Entity('invoice_emails')
@Check('invoice_emails_template_check', "template = ANY (ARRAY['proforma'::text, 'invoice'::text, 'reminder'::text])")
@Index('idx_invoice_emails_holding_id', ['holding_id'])
@Index('idx_invoice_emails_invoice_id', ['invoice_id'])
@Index('idx_invoice_emails_template', ['template'])
export class InvoiceEmail {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_emails_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'text', nullable: false })
	template: string;

	@Column({ type: 'text', nullable: false })
	recipient: string;

	@Column({ type: 'text', nullable: true })
	subject?: string;

	@Column({ type: 'text', nullable: true })
	message?: string;

	@Column({ type: 'uuid', nullable: true })
	sent_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	sent_at: Date;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'sent_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_emails_sent_by_fkey' })
	sentBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_emails_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)
}
