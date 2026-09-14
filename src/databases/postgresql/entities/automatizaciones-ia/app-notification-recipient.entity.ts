import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { AppNotification } from '@/databases/postgresql/entities/automatizaciones-ia/app-notification.entity';
import { User } from '@/databases/postgresql/entities/base-tenancy/user.entity';

@Unique('app_notification_recipients_notification_id_user_id_key', ['notification_id', 'user_id'])
@Entity('app_notification_recipients')
export class AppNotificationRecipient {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'app_notification_recipients_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	notification_id!: string;

	@Column({ type: 'uuid' })
	user_id!: string;

	@Column({ type: 'boolean', default: false })
	is_read!: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	read_at?: Date | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@ManyToOne(() => AppNotification, (notification) => notification.recipients, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'notification_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'app_notification_recipients_notification_id_fkey',
	})
	notification!: AppNotification;

	@ManyToOne(() => User, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'user_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'app_notification_recipients_user_id_fkey',
	})
	user?: User;
}
