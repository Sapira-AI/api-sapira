import { Check, Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

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

@Unique('salesforce_field_mappings_holding_id_object_type_sapira_fie_key', ['holding_id', 'object_type', 'sapira_field'])
@Check(
	'salesforce_field_mappings_object_type_check',
	`((object_type = ANY (ARRAY['client'::text, 'client_entity'::text, 'opportunity'::text, 'line_item'::text, 'product'::text, 'contact'::text])))`
)
@Index('idx_salesforce_field_mappings_holding_id', ['holding_id'])
@Index('idx_salesforce_field_mappings_object_type', ['object_type'])
@Entity({
	name: 'salesforce_field_mappings',
	comment: 'Configuración de mapeo de campos entre Salesforce y Sapira',
})
export class SalesforceFieldMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_field_mappings_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'text', comment: 'Tipo de objeto: client, client_entity, opportunity, line_item, product, contact' })
	object_type!: SalesforceFieldMappingObjectType;

	@Column({ type: 'text', comment: 'Nombre del campo en Sapira' })
	sapira_field!: string;

	@Column({ type: 'text', comment: 'Nombre del campo en Salesforce' })
	salesforce_field!: string;

	@Column({ type: 'boolean', default: false, nullable: true })
	is_required!: boolean;

	@Column({ type: 'boolean', default: true, nullable: true })
	is_active!: boolean;

	@Column({ type: 'text', nullable: true })
	data_type?: string | null;

	@Column({ type: 'text', nullable: true })
	default_value?: string | null;

	@Column({ type: 'text', nullable: true, comment: 'Transformación configurable aplicada al valor origen antes de escribir en Sapira' })
	transformation_key?: SalesforceFieldTransformationKey | null;

	@Column({ type: 'jsonb', nullable: true, comment: 'Configuración JSON opcional para la transformación del mapping' })
	transformation_config?: Record<string, unknown> | null;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at!: Date;
}
