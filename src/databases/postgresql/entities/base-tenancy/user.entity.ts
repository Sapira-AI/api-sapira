import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { Role } from '@/databases/postgresql/entities/base-tenancy/role.entity';

@Unique('users_email_key', ['email'])
@Check('users_status_check', `((status = ANY (ARRAY['Pendiente'::text, 'Activo'::text, 'Inactivo'::text])))`)
@Check('users_avatar_one_kind_check', `avatar_preset IS NULL OR avatar_path IS NULL`)
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

	// Mi perfil (migración 1791050000000): avatar elegido (preset) o foto subida (ruta en el bucket público `user-avatars`). Ambas NULL =
	// iniciales. Nunca las dos (CHECK). Se guarda la ruta, no la URL.
	@Column({ type: 'text', nullable: true, comment: 'Avatar elegido de la lista fija de Mi perfil (preset-01…preset-12); NULL = iniciales o foto' })
	avatar_preset?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Ruta de la foto de perfil en el bucket user-avatars (users/<id>/<uuid>.<ext>)' })
	avatar_path?: string | null;

	@ManyToOne(() => Role)
	@JoinColumn({ name: 'role_id', referencedColumnName: 'id', foreignKeyConstraintName: 'users_role_id_fkey' })
	role?: Role;
}
