import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_object_mappings')
export class SalesforceObjectMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	salesforce_object_id: string;

	@Column({ type: 'text' })
	salesforce_object_type: string;

	@Column({ type: 'text' })
	sapira_table_name: string;

	@Column({ type: 'uuid' })
	sapira_record_id: string;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;

	@Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
	last_synced_at: Date;
}
