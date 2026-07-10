import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SalesforceFieldMappingObjectType = 'client' | 'client_entity' | 'opportunity' | 'line_item' | 'product' | 'contact';

@Entity('salesforce_field_mappings')
export class SalesforceFieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text' })
	object_type!: SalesforceFieldMappingObjectType;

	@Column({ type: 'text' })
	sapira_field!: string;

	@Column({ type: 'text' })
	salesforce_field!: string;

	@Column({ type: 'boolean', default: false })
	is_required!: boolean;

	@Column({ type: 'boolean', default: true })
	is_active!: boolean;

	@Column({ type: 'text', nullable: true })
	data_type?: string | null;

	@Column({ type: 'text', nullable: true })
	default_value?: string | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at!: Date;
}
