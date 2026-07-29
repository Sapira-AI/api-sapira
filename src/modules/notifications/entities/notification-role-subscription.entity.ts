import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('notification_role_subscriptions')
export class NotificationRoleSubscription {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid', nullable: true })
	role_id?: string | null;

	@Column({ type: 'text' })
	notification_type!: string;

	@Column({ type: 'boolean', default: true })
	is_enabled!: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at!: Date;
}
