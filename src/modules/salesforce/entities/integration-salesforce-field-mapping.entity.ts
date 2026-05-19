import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('integration_salesforce_field_mappings')
export class IntegrationSalesforceFieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	connection_id: string;

	@Column({ type: 'varchar', length: 255 })
	salesforce_object: string;

	@Column({ type: 'varchar', length: 255 })
	salesforce_field: string;

	@Column({ type: 'varchar', length: 255 })
	sapira_table: string;

	@Column({ type: 'varchar', length: 255 })
	sapira_field: string;

	@Column({ type: 'varchar', length: 50, default: 'import' })
	direction: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'jsonb', nullable: true })
	metadata: any;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
