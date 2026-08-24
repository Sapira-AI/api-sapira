import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { Invoice } from '@/modules/invoices/entities/invoice.entity';

/**
 * Espejo de `public.invoice_collection_logs` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: ninguno.
 * Policies (4): tenant_isolation_delete_invoice_collection_logs (DELETE, public); tenant_isolation_insert_invoice_collection_logs (INSERT, public); tenant_isolation_select_invoice_collection_logs (SELECT, public); tenant_isolation_update_invoice_collection_logs (UPDATE, public).
 */
@Entity('invoice_collection_logs')
@Index('idx_invoice_collection_logs_holding_id', ['holding_id'])
@Index('idx_invoice_collection_logs_invoice_id', ['invoice_id'])
export class InvoiceCollectionLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_collection_logs_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	invoice_id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', array: true, nullable: false })
	recipients: string[];

	@Column({ type: 'text', nullable: true })
	subject?: string;

	@Column({ type: 'text', nullable: true })
	message?: string;

	@Column({ type: 'text', nullable: false, default: 'email' })
	channel: string;

	@Column({ type: 'text', nullable: false, default: 'sent' })
	status: string;

	@Column({ type: 'uuid', nullable: true })
	sent_by?: string;

	@Column({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	sent_at: Date;

	@Column({ type: 'jsonb', nullable: false, default: '{}' })
	metadata: any;

	@ManyToOne(() => Invoice, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'invoice_id', referencedColumnName: 'id', foreignKeyConstraintName: 'invoice_collection_logs_invoice_id_fkey' })
	invoice?: Invoice; // entity existente (no se duplica)
}
