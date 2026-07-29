import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { AppNotification } from './app-notification.entity';

@Entity('app_notification_recipients')
export class AppNotificationRecipient {
	@PrimaryGeneratedColumn('uuid')
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
	@JoinColumn({ name: 'notification_id' })
	notification!: AppNotification;
}
