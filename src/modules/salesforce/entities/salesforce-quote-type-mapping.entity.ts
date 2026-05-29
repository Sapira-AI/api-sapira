import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('salesforce_quote_type_mappings')
export class SalesforceQuoteTypeMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	salesforce_type: string;

	@Column({ type: 'text' })
	sapira_quote_type: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;
}
