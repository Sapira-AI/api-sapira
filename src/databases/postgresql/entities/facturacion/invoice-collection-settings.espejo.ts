import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Espejo de `public.invoice_collection_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 1 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trg_invoice_collection_settings_updated_at · BEFORE UPDATE FOR EACH ROW → set_updated_at(); trg_update_invoice_collection_settings_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (4): tenant_isolation_delete_invoice_collection_settings (DELETE, public); tenant_isolation_insert_invoice_collection_settings (INSERT, public); tenant_isolation_select_invoice_collection_settings (SELECT, public); tenant_isolation_update_invoice_collection_settings (UPDATE, public).
 */
@Entity('invoice_collection_settings')
@Unique('invoice_collection_settings_holding_id_key', ['holding_id'])
@Index('idx_invoice_collection_settings_holding_id', ['holding_id'])
export class InvoiceCollectionSettings {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'invoice_collection_settings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	dunning_enabled: boolean;

	@Column({ type: 'text', nullable: true })
	email_from?: string;

	@Column({ type: 'text', nullable: true })
	bcc?: string;

	@Column({ type: 'integer', array: true, nullable: false, default: '{7,3,1}' })
	reminder_days_before: number[];

	@Column({ type: 'integer', array: true, nullable: false, default: '{1,7,15}' })
	reminder_days_after: number[];

	@Column({ type: 'text', nullable: false, default: 'Recordatorio de pago factura {{invoice_number}}' })
	email_subject_template: string;

	@Column({
		type: 'text',
		nullable: false,
		default:
			'Estimado {{client_name}},\\n\\nLe recordamos que la factura {{invoice_number}} por {{amount_due}} vence el {{due_date}}.\\n\\nSaludos,\\n{{company_name}}',
	})
	email_body_template: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;
}
