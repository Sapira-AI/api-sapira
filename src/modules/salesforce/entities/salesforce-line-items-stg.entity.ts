import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_line_items_stg')
export class SalesforceLineItemsStg {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid', nullable: true })
	opportunity_staging_id?: string | null;

	@Column({ type: 'text' })
	salesforce_id!: string;

	@Column({ type: 'text', nullable: true })
	salesforce_opportunity_id?: string | null;

	@Column({ type: 'text', nullable: true })
	salesforce_product_id?: string | null;

	@Column({ type: 'text', nullable: true })
	salesforce_name?: string | null;

	@Column({ type: 'jsonb' })
	raw_data!: Record<string, any>;

	@Column({ type: 'text', nullable: true, default: 'create' })
	processing_status?: string | null;

	@Column({ type: 'text', nullable: true })
	source_hash?: string | null;

	@Column({ type: 'text', nullable: true })
	error_message?: string | null;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string | null;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	sync_session_id?: string | null;

	@Column({ type: 'timestamp', nullable: true })
	processed_at?: Date | null;

	@Column({ type: 'timestamp', nullable: true })
	last_integrated_at?: Date | null;

	@CreateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;
}
