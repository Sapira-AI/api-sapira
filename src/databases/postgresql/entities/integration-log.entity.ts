import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('integration_logs')
export class IntegrationLog {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	integration_type: string;

	@Column({ type: 'text', nullable: true })
	operation?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;

	@Column({ type: 'jsonb', nullable: true })
	request_data?: any;

	@Column({ type: 'jsonb', nullable: true })
	response_data?: any;

	@Column({ type: 'text', nullable: true })
	error_message?: string;

	@Column({ type: 'integer', nullable: true })
	duration_ms?: number;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	user_id?: string;

	@Column({ type: 'text', nullable: true })
	external_id?: string;

	@Column({ type: 'text', nullable: true })
	source_table?: string;

	@Column({ type: 'text', nullable: true })
	target_table?: string;

	@Column({ type: 'integer', nullable: true, default: 0 })
	records_processed?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	records_success?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	records_failed?: number;

	@Column({ type: 'integer', nullable: true, default: 0 })
	progress_total?: number;

	@Column({ type: 'timestamp with time zone', nullable: true })
	started_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	completed_at?: Date;

	@Column({ type: 'integer', nullable: true })
	execution_time_ms?: number;

	@Column({ type: 'jsonb', nullable: true })
	error_details?: any;

	@Column({ type: 'uuid', nullable: true })
	connection_id?: string;

	@Column({ type: 'jsonb', nullable: true })
	metadata?: any;
}
