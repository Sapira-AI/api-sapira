import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('bigquery_connections')
export class BigQueryConnection {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	user_id: string;

	@Column({ type: 'text' })
	name: string;

	@Column({ type: 'text' })
	project_id: string;

	@Column({ type: 'text' })
	credentials: string;

	@Column({ type: 'text', nullable: true })
	dataset_id?: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'timestamp with time zone', nullable: true })
	last_sync_at?: Date;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp with time zone' })
	updated_at: Date;
}
