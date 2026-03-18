import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('stripe_subscriptions_stg')
export class StripeSubscriptionsStg {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false })
	stripe_id: string;

	@Column({ type: 'jsonb', nullable: false })
	raw_data: any;

	@Column({ type: 'uuid', nullable: true })
	sync_batch_id?: string;

	@Column({ type: 'text', nullable: true, default: 'pending' })
	processing_status?: string;

	@Column({ type: 'uuid', nullable: true })
	integration_batch_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_integrated_at?: Date;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid', nullable: true })
	connection_id?: string;
}
