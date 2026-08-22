import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

/**
 * Espejo de `public.holding_email_sender_settings` — generado desde prod en vivo (`hklompkypzqtglprfobu`, MCP Supabase, 2026-08-22). 0 filas · RLS on.
 * APAGADO en runtime: el archivo termina en `.espejo.ts` (no en `.entity.ts`), por lo que el glob de entities de database.module.ts no lo carga y ningún módulo lo registra en forFeature.
 * Configuración de remitente de email por holding con verificación de dominio en Resend
 * Referenciada por FK desde 1 tabla(s): email_sender_addresses.
 * Constraints, índices, triggers y policies verificados en vivo con `execute_sql` (pg_catalog).
 * Triggers: trigger_update_holding_email_sender_updated_at · BEFORE UPDATE FOR EACH ROW → update_holding_email_sender_updated_at().
 * Policies (4): Users can create email sender settings for their holding (INSERT, public); Users can delete their holding email sender settings (DELETE, public); Users can update their holding email sender settings (UPDATE, public); Users can view their holding email sender settings (SELECT, public).
 */
@Entity('holding_email_sender_settings')
@Index('idx_holding_email_sender_active', ['is_active'], { where: 'is_active = true' })
@Index('idx_holding_email_sender_default', ['holding_id', 'is_default'], { where: 'is_default = true' })
@Index('idx_holding_email_sender_holding', ['holding_id'])
@Index('idx_holding_email_sender_status', ['domain_status'])
@Index('unique_default_domain_per_holding', ['holding_id'], { unique: true, where: '(is_default = true) AND (is_active = true)' })
export class HoldingEmailSenderSettings {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'holding_email_sender_settings_pkey' })
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	/** Dominio o subdominio para envío (ej: mail.miempresa.com) */
	@Column({ type: 'text', nullable: false })
	sender_domain: string;

	/** ID del dominio en Resend API */
	@Column({ type: 'text', nullable: true })
	resend_domain_id?: string;

	/** Estado de verificación: pending, verified, failed */
	@Column({ type: 'text', nullable: false, default: 'pending' })
	domain_status: string;

	/** Registros DNS provistos por Resend (DKIM, SPF, DMARC) */
	@Column({ type: 'jsonb', nullable: true })
	domain_dns_records?: any;

	@Column({ type: 'timestamp with time zone', nullable: true })
	domain_verified_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	/** Dominio por defecto para el holding */
	@Column({ type: 'boolean', nullable: false, default: false })
	is_default: boolean;

	/** Si el dominio está activo para uso */
	@Column({ type: 'boolean', nullable: false, default: true })
	is_active: boolean;

	/** Nombre descriptivo del dominio */
	@Column({ type: 'text', nullable: true })
	display_name?: string;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_email_sender_settings_created_by_fkey' })
	createdBy?: User; // entity existente (no se duplica)

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'holding_email_sender_settings_holding_id_fkey' })
	holding?: CompanyHolding; // entity existente (no se duplica)
}
