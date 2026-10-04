import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * Auditoría de acceso de usuarios (Configuración v2, contrato §10, migración M15 `1790860000000-UserAccessEvents`): invitar, reenviar,
 * desactivar, reactivar y eliminar invitación; y eventos de la cuenta desde Mi perfil (`password_changed`, `sessions_revoked`, con
 * `holding_id` NULL: no son de un holding; migración 1791050000000). La escribe solo la API (`SettingsUserAccessService`, `MeService`);
 * RLS activo **sin policies**.
 * También es la fuente del límite de reenvíos (60 s entre envíos, 5 en 24 h). `user_id` y `actor_user_id` quedan en NULL si se borra la
 * persona (el correo queda en `details`).
 */
@Entity({
	name: 'user_access_events',
	comment:
		'Auditoría de acceso de usuarios por holding (invitar, reenviar, desactivar, reactivar, eliminar invitación) y de la cuenta (cambio de contraseña, cierre de sesiones; holding_id NULL). Solo la API',
})
@Check(
	'user_access_events_action_check',
	`"action" = ANY (ARRAY['invited'::text, 'invitation_resent'::text, 'deactivated'::text, 'reactivated'::text, 'invitation_deleted'::text, 'password_changed'::text, 'sessions_revoked'::text])`
)
@Index('user_access_events_user_idx', ['user_id', 'action', 'created_at'])
@Index('user_access_events_holding_idx', ['holding_id', 'created_at'])
export class UserAccessEvent {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'user_access_events_pkey' })
	id!: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id!: string | null;

	@Column({ type: 'uuid', nullable: true })
	user_id!: string | null;

	@Column({ type: 'uuid', nullable: true })
	actor_user_id!: string | null;

	@Column({ type: 'text', nullable: false })
	action!: string;

	@Column({ type: 'jsonb', nullable: false, default: () => `'{}'::jsonb` })
	details!: any;

	@CreateDateColumn({ type: 'timestamp with time zone', nullable: false, default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_access_events_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_access_events_user_id_fkey' })
	user?: User | null;

	@ManyToOne(() => User, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'actor_user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_access_events_actor_user_id_fkey' })
	actor?: User | null;
}
