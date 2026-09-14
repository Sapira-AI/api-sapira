import { Check, Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type SalesforceSyncRunType = 'update_staging' | 'process_final' | 'retry_full';
export type SalesforceSyncRunStatus = 'queued' | 'running' | 'cancellation_requested' | 'cancelled' | 'completed' | 'failed';

@Check(
	'salesforce_sync_runs_status_check',
	`((status = ANY (ARRAY['queued'::text, 'running'::text, 'cancellation_requested'::text, 'cancelled'::text, 'completed'::text, 'failed'::text])))`
)
@Check('salesforce_sync_runs_type_check', `((type = ANY (ARRAY['update_staging'::text, 'process_final'::text, 'retry_full'::text])))`)
@Index('idx_salesforce_sync_runs_holding_status', ['holding_id', 'status'])
@Entity('salesforce_sync_runs')
export class SalesforceSyncRun {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_sync_runs_pkey' })
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

	@Column({ type: 'timestamp', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp', default: () => 'now()' })
	updated_at!: Date;
}
