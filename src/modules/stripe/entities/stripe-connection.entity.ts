import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('stripe_connections')
export class StripeConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'uuid', nullable: false })
	user_id: string;

	@Column({ type: 'text', nullable: false })
	name: string;

	@Column({ type: 'text', nullable: false })
	secret_key: string;

	@Column({ type: 'text', nullable: true })
	publishable_key?: string;

	@Column({ type: 'text', nullable: false, default: 'test' })
	mode: string; // 'test' o 'live'

	@Column({ type: 'boolean', nullable: true, default: true })
	is_active?: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_sync_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;
}
