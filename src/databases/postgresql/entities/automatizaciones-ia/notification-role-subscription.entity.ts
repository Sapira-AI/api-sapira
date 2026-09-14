import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';
import { Role } from '@/databases/postgresql/entities/base-tenancy/role.entity';

@Unique('notification_role_subscriptio_holding_id_role_id_notificati_key', ['holding_id', 'role_id', 'notification_type'])
@Index('notification_role_subscriptions_holding_type_idx', ['holding_id', 'notification_type'], { where: `is_enabled` })
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

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'notification_role_subscriptions_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => Role, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'role_id', referencedColumnName: 'id', foreignKeyConstraintName: 'notification_role_subscriptions_role_id_fkey' })
	role?: Role;
}
