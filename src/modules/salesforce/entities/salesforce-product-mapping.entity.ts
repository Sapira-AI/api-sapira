import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_product_mappings')
export class SalesforceProductMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	salesforce_product_id: string;

	@Column({ type: 'text', nullable: true })
	salesforce_product_name: string;

	@Column({ type: 'text', nullable: true })
	salesforce_family: string;

	@Column({ type: 'text', nullable: true })
	salesforce_product_code: string;

	@Column({ type: 'uuid' })
	sapira_product_id: string;

	@Column({ type: 'text', nullable: true })
	sapira_product_code: string;

	@Column({ type: 'text', nullable: true })
	sapira_product_name: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;
}
