import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export type SalesforceFieldMappingObjectType = 'client' | 'client_entity' | 'opportunity' | 'line_item' | 'product' | 'contact';
export type SalesforceFieldTransformationKey =
	| 'direct'
	| 'client_number_fallback'
	| 'country_name'
	| 'legal_address_concat'
	| 'quote_type_mapping'
	| 'salesforce_date'
	| 'quote_date_with_close_fallback'
	| 'salesforce_boolean'
	| 'recurring_flag'
	| 'billing_method'
	| 'billing_frequency'
	| 'custom_fields_bundle'
	| 'tax_id_normalized';

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

	@Column({ type: 'text', nullable: true })
	transformation_key?: SalesforceFieldTransformationKey | null;

	@Column({ type: 'jsonb', nullable: true })
	transformation_config?: Record<string, unknown> | null;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at!: Date;
}
