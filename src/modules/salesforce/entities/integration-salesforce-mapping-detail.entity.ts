import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('integration_salesforce_mapping_details')
export class IntegrationSalesforceMappingDetail {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	field_mapping_id: string;

	@Column({ type: 'varchar', length: 500 })
	salesforce_value: string;

	@Column({ type: 'varchar', length: 500 })
	sapira_value: string;

	@Column({ type: 'varchar', length: 255, nullable: true })
	transform: string;

	@Column({ type: 'text', nullable: true })
	notes: string;

	@CreateDateColumn()
	created_at: Date;

	@UpdateDateColumn()
	updated_at: Date;
}
