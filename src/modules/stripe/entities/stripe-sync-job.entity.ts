import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('stripe_sync_jobs')
export class StripeSyncJob {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id: string;

	@Column({ type: 'text', nullable: false, default: 'running' })
	status: string;

	@Column({ type: 'jsonb', nullable: true })
	progress: any;

	@Column({ type: 'jsonb', nullable: true })
	stats: any;

	@Column({ type: 'jsonb', nullable: true })
	errors: any;

	@Column({ type: 'text', nullable: true })
	error_message: string;

	@CreateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	completed_at: Date;
}
