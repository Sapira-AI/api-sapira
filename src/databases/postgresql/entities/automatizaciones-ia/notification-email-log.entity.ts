import { Check, Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

export type NotificationEmailKind = 'alert' | 'digest';
export type NotificationEmailStatus = 'pending' | 'sent' | 'failed';

/**
 * Correos de notificación (Notificaciones v2 fase 2, N6 `1790900000000-NotificationsPhase2`): una fila por usuario y `dedup_key`.
 * - Alerta inmediata: `alert:<id>:<gravedad>:<escalón>` (o `alert-group:<grupo>` para alertas que llegan a varios holdings): no se reenvía
 *   por la misma alerta salvo escalamiento.
 * - Resumen semanal: `digest:<holding>:<lunes>`: idempotente por semana; la fila se reserva (`pending`) **antes** de enviar, así dos réplicas
 *   no duplican.
 * La escribe solo la API; RLS activo **sin policies**.
 */
@Entity({
	name: 'notification_email_log',
	comment: 'Correos de notificación enviados (alerta inmediata y resumen semanal): deduplicación por usuario y clave. Solo la API',
})
@Unique('notification_email_log_user_dedup_key', ['user_id', 'dedup_key'])
@Check('notification_email_log_kind_check', `(kind = ANY (ARRAY['alert'::text, 'digest'::text]))`)
@Check('notification_email_log_status_check', `(status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text]))`)
export class NotificationEmailLog {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'notification_email_log_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid' })
	user_id!: string;

	@Column({ type: 'text' })
	kind!: NotificationEmailKind;

	@Column({ type: 'text' })
	dedup_key!: string;

	@Column({ type: 'uuid', nullable: true })
	notification_id?: string | null;

	@Column({ type: 'text', default: 'pending' })
	status!: NotificationEmailStatus;

	@Column({ type: 'text', nullable: true })
	provider_id?: string | null;

	@Column({ type: 'text', nullable: true })
	error?: string | null;

	@Column({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	sent_at?: Date | null;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'notification_email_log_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'user_id', referencedColumnName: 'id', foreignKeyConstraintName: 'notification_email_log_user_id_fkey' })
	user?: User;

	@ManyToOne(() => AppNotification, { onDelete: 'SET NULL' })
	@JoinColumn({ name: 'notification_id', referencedColumnName: 'id', foreignKeyConstraintName: 'notification_email_log_notification_id_fkey' })
	notification?: AppNotification | null;
}
