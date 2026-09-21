import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';
import { Invoice } from '@/databases/postgresql/entities/facturacion/invoice.entity';

/**
 * Entity de `public.invoice_emails` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * PROMOVIDA desde espejo: el archivo termina en `.entity.ts`, así que la carga el glob de entities de database.module.ts y puede registrarse en forFeature. Sigue siendo un archivo GENERADO por `scripts/espejo/generate-espejo.py`: lo que se edite a mano se pierde en la próxima regeneración.
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

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_emails_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)

	@ManyToOne(() => User)
	@JoinColumn({ name: 'sent_by', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_emails_sent_by_fkey' })
	sentBy?: User; // entity existente (no se duplica)
}
