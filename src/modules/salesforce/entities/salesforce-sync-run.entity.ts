import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SalesforceSyncRunType = 'update_staging' | 'process_final' | 'retry_full';
export type SalesforceSyncRunStatus = 'queued' | 'running' | 'cancellation_requested' | 'cancelled' | 'completed' | 'failed';

@Entity('salesforce_sync_runs')
export class SalesforceSyncRun {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	type!: SalesforceSyncRunType;

	@Column({ type: 'text', default: 'queued' })
	status!: SalesforceSyncRunStatus;

	@Column({ type: 'date', nullable: true })
	date_from?: string | null;

	@Column({ type: 'date', nullable: true })
	date_to?: string | null;

	@Column({ type: 'integer', default: 0 })
	total_items!: number;

	@Column({ type: 'integer', default: 0 })
	completed_items!: number;

	@Column({ type: 'integer', default: 0 })
	failed_items!: number;

	@Column({ type: 'timestamp', nullable: true })
	started_at?: Date | null;

	@Column({ type: 'timestamp', nullable: true })
	finished_at?: Date | null;

	@Column({ type: 'timestamp', nullable: true })
	locked_until?: Date | null;

	@Column({ type: 'text', nullable: true })
	error_message?: string | null;

	@CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;
}
