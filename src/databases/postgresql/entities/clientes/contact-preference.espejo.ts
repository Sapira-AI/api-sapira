import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * Espejo de `public.contact_preferences` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: update_contact_preferences_updated_at · BEFORE UPDATE FOR EACH ROW → update_updated_at_column().
 * Policies (2): Contact preferences - manage own holding (ALL, public); Contact preferences - select own holding (SELECT, public).
 */
@Entity('contact_preferences')
@Unique('contact_preferences_holding_id_client_id_contact_id_key', ['holding_id', 'client_id', 'contact_id'])
@Index('contact_preferences_holding_idx', ['holding_id', 'client_id'])
export class ContactPreference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'contact_preferences_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	client_id: string;

	@Column({ type: 'uuid', nullable: false })
	contact_id: string;

	@Column({ type: 'boolean', nullable: false, default: true })
	allow_billing_emails: boolean;

	@Column({ type: 'boolean', nullable: false, default: true })
	allow_proforma: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;
}
