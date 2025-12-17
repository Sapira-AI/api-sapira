import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('integration_logs')
@Index('idx_integration_logs_holding_id', ['holding_id'])
@Index('idx_integration_logs_status', ['status'])
@Index('idx_integration_logs_started_at', ['started_at'])
@Index('idx_integration_logs_batch_id', ['batch_id'])
@Index('idx_integration_logs_integration_type', ['integration_type'])
@Index('idx_integration_logs_connection_id', ['connection_id'])
export class IntegrationLog {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	source_table!: string;

	@Column({ type: 'text' })
	target_table!: string;

	@Column({ type: 'uuid', nullable: true })
	mapping_id?: string;

	@Column({ type: 'integer', default: 0 })
	records_processed?: number;

	@Column({ type: 'integer', default: 0 })
	records_success?: number;

	@Column({ type: 'integer', default: 0 })
	records_failed?: number;

	@Column({ type: 'jsonb', nullable: true })
	error_details?: any;

	@Column({ type: 'integer', nullable: true })
	execution_time_ms?: number;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	started_at!: Date;

	@Column({ type: 'timestamp', nullable: true })
	completed_at?: Date;

	@Column({ type: 'text', default: 'running' })
	status!: string;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string;

	@Column({ type: 'varchar', length: 100, nullable: true })
	integration_type?: string;

	@Column({ type: 'integer', default: 0 })
	progress_total?: number;

	@Column({ type: 'jsonb', nullable: true })
	result?: Record<string, any>;

	@Column({ type: 'jsonb', default: () => "'{}'" })
	metadata?: Record<string, any>;

	@Column({ type: 'uuid', nullable: true })
	connection_id?: string;

	// Relaciones (llaves foráneas) - Comentadas para evitar dependencias en cascada
	// Las FK se mantienen a nivel de BD, pero sin relaciones TypeORM
	// @ManyToOne(() => CompanyHolding)
	// @JoinColumn({ name: 'holding_id' })
	// holding?: CompanyHolding;

	// @ManyToOne(() => FieldMapping)
	// @JoinColumn({ name: 'mapping_id' })
	// mapping?: FieldMapping;
}
