import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { User } from '@/modules/users/entities/user.entity';

import { HoldingEmailSenderSettings } from './holding-email-sender-settings.espejo';

/**
 * Espejo de `public.email_sender_addresses` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Múltiples direcciones de correo remitente por dominio verificado
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_update_email_sender_addresses_updated_at · BEFORE UPDATE FOR EACH ROW → update_email_sender_addresses_updated_at(); trigger_validate_email_matches_domain · BEFORE INSERT OR UPDATE FOR EACH ROW → validate_email_matches_domain().
 * Policies (4): Users can create email senders for their holding domains (INSERT, public); Users can delete email senders of their holding domains (DELETE, public); Users can update email senders of their holding domains (UPDATE, public); Users can view email senders of their holding domains (SELECT, public).
 */
@Entity('email_sender_addresses')
@Index('idx_email_sender_addresses_active', ['is_active'], { where: 'is_active = true' })
@Index('idx_email_sender_addresses_default', ['domain_config_id', 'is_default'], { where: 'is_default = true' })
@Index('idx_email_sender_addresses_domain', ['domain_config_id'])
@Index('unique_default_sender_per_domain', ['domain_config_id'], { unique: true, where: '(is_default = true) AND (is_active = true)' })
export class EmailSenderAddress {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'email_sender_addresses_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	domain_config_id: string;

	/** Nombre del remitente (ej: Cobranza Sapira) */
	@Column({ type: 'text', nullable: false })
	from_name: string;

	/** Email del remitente, debe pertenecer al dominio */
	@Column({ type: 'text', nullable: false })
	from_email: string;

	/** Email de respuesta opcional */
	@Column({ type: 'text', nullable: true })
	reply_to_email?: string;

	@Column({ type: 'boolean', nullable: false, default: false })
	is_default: boolean;

	@Column({ type: 'boolean', nullable: false, default: true })
	is_active: boolean;

	/** Propósito del remitente (cobranzas, notificaciones, etc) */
	@Column({ type: 'text', nullable: true })
	purpose?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@ManyToOne(() => HoldingEmailSenderSettings, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'domain_config_id', referencedColumnName: 'id', foreignKeyConstraintName: 'email_sender_addresses_domain_config_id_fkey' })
	domainConfig?: HoldingEmailSenderSettings;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'email_sender_addresses_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)
}
