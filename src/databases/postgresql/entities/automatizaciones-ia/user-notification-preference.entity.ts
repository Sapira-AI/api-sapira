import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

/**
 * Preferencias de notificación por usuario y holding (Notificaciones v2, N2 `1790890000000-UserNotificationPreferences`): una fila por tipo
 * del catálogo con `in_app` (campana y centro) y `email` (correo inmediato, fase 2). Sin fila = valores por defecto (`in_app` true, `email`
 * false). El **resumen semanal** es la fila reservada `notification_type = 'weekly_digest'` (usa `email`). La escribe solo la API; RLS
 * activo **sin policies**. "Mis compañías" es la fila reservada `my_companies` (columna `company_ids`, fase 2).
 */
@Entity({
	name: 'user_notification_preferences',
	comment: 'Preferencias de notificación por usuario, holding y tipo (y resumen semanal). Solo la API',
})
@Unique('user_notification_preferences_user_holding_type_key', ['user_id', 'holding_id', 'notification_type'])
export class UserNotificationPreference {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'user_notification_preferences_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	user_id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	notification_type!: string;

	@Column({ type: 'boolean', default: true })
	in_app!: boolean;

	@Column({ type: 'boolean', default: false })
	email!: boolean;

	/** Solo en la fila reservada `notification_type = 'my_companies'` (N5): compañías que ve el usuario. NULL o vacío = todas. */
	@Column({ type: 'uuid', array: true, nullable: true })
	company_ids?: string[] | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_notification_preferences_user_id_fkey' })
	user?: User;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'user_notification_preferences_holding_id_fkey' })
	holding?: CompanyHolding;
}
