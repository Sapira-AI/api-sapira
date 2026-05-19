import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('integration_salesforce_sync_runs')
export class IntegrationSalesforceSyncRun {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	connection_id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid', nullable: true })
	company_id: string;

	@Column({ type: 'varchar', length: 50 })
	sync_type: string;

	@Column({ type: 'varchar', length: 50, default: 'pending' })
	status: string;

	@Column({ type: 'varchar', length: 50 })
	mode: string;

	@Column({ type: 'varchar', length: 50 })
	direction: string;

	@Column({ type: 'timestamp', nullable: true })
	started_at: Date;

	@Column({ type: 'timestamp', nullable: true })
	completed_at: Date;

	@Column({ type: 'int', default: 0 })
	records_processed: number;

	@Column({ type: 'int', default: 0 })
	records_success: number;

	@Column({ type: 'int', default: 0 })
	records_failed: number;

	@Column({ type: 'text', nullable: true })
	error_message: string;

	@Column({ type: 'jsonb', nullable: true })
	metadata: any;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
