import { Check, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Unique('users_email_key', ['email'])
@Check('users_status_check', `((status = ANY (ARRAY['Pendiente'::text, 'Activo'::text, 'Inactivo'::text])))`)
@Index('idx_users_auth_id', ['auth_id'])
@Index('idx_users_role_id', ['role_id'])
@Entity('users')
export class User {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'users_pkey' })
	id: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'text', nullable: false, unique: true })
	email: string;

	@Column({ type: 'uuid', nullable: true })
	role_id?: string;

	@Column({ type: 'text', nullable: true, default: 'Pendiente' })
	status?: string;

	@Column({ type: 'timestamp', nullable: true })
	last_access?: Date;

	@Column({ type: 'text', nullable: true })
	auth_provider?: string;

	@Column({ type: 'uuid', nullable: true })
	auth_id?: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_super_admin?: boolean;

	// Tres columnas que existen en producción y la entity no declaraba. Sin ellas, una
	// migración generada intentaba borrarlas.
	@Column({ type: 'timestamptz', nullable: true, comment: 'Último intento de envío de invitación (edge send-invitation)' })
	last_invitation_sent_at?: Date;

	@Column({ type: 'text', nullable: true, comment: 'ID del email en Resend del último envío' })
	last_invitation_email_id?: string;

	@Column({ type: 'text', nullable: true, comment: 'sent | failed (según respuesta de Resend)' })
	last_invitation_status?: string;
}
