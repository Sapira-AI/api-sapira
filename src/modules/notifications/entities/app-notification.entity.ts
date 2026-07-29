import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { AppNotificationRecipient } from './app-notification-recipient.entity';

export type AppNotificationSeverity = 'info' | 'warning' | 'error';
export type AppNotificationStatus = 'open' | 'resolved';

@Entity('app_notifications')
export class AppNotification {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	source!: string;

	@Column({ type: 'text' })
	type!: string;

	@Column({ type: 'text', default: 'error' })
	severity!: AppNotificationSeverity;

	@Column({ type: 'text' })
	title!: string;

	@Column({ type: 'text' })
	message!: string;

	@Column({ type: 'text', nullable: true })
	recommendation?: string | null;

	@Column({ type: 'text', nullable: true })
	action_type?: string | null;

	@Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
	action_payload!: Record<string, unknown>;

	@Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
	metadata!: Record<string, unknown>;

	@Column({ type: 'text', nullable: true })
	deduplication_key?: string | null;

	@Column({ type: 'text', default: 'open' })
	status!: AppNotificationStatus;

	@Column({ type: 'timestamp with time zone', nullable: true })
	resolved_at?: Date | null;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;

	@OneToMany(() => AppNotificationRecipient, (recipient) => recipient.notification)
	recipients!: AppNotificationRecipient[];
}
