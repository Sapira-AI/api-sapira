import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/modules/holdings/entities/company-holding.entity';
import { User } from '@/modules/users/entities/user.entity';

@Unique('field_mappings_holding_id_source_model_target_table_is_acti_key', ['holding_id', 'source_model', 'target_table', 'is_active'])
@Check('field_mappings_mapping_type_check', `((mapping_type = ANY (ARRAY['simple'::text, 'hierarchical'::text])))`)
@Unique('unique_field_mapping', ['holding_id', 'mapping_type', 'source_model', 'target_table'])
@Index('idx_field_mappings_active', ['is_active'], { where: `(is_active = true)` })
@Index('idx_field_mappings_hierarchical', ['holding_id', 'source_model', 'secondary_source_model', 'is_active'], {
	where: `(mapping_type = 'hierarchical'::text)`,
})
@Index('idx_field_mappings_holding_id', ['holding_id'])
@Index('idx_field_mappings_mapping_type', ['mapping_type'])
@Index('idx_field_mappings_source_model', ['source_model'])
@Index('idx_field_mappings_target_table', ['target_table'])
@Entity({
	name: 'field_mappings',
	comment: 'Configuraciones de mapeo de campos entre Odoo y Sapira',
})
export class FieldMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'field_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	source_model: string;

	@Column({ type: 'text' })
	target_table: string;

	@Column({ type: 'text', nullable: true })
	mapping_name?: string;

	@Column({ type: 'jsonb', comment: 'JSON con la configuración del mapeo de campos y transformaciones' })
	mapping_config: any;

	@Column({ type: 'boolean', default: true, nullable: true })
	is_active: boolean;

	@Column({ type: 'uuid', nullable: true, comment: 'ID del usuario que creó el mapeo (opcional). Referencia a public.users.id' })
	created_by?: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamp', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'text', nullable: true, default: 'simple', comment: 'Tipo de mapeo: simple (una tabla) o hierarchical (padre-hijo)' })
	mapping_type?: string;

	@Column({ type: 'text', nullable: true, comment: 'Modelo fuente secundario para mapeos jerárquicos (ej: account.move.line)' })
	secondary_source_model?: string;

	@Column({ type: 'text', nullable: true, comment: 'Tabla destino secundaria para mapeos jerárquicos (ej: invoice_items_legacy)' })
	secondary_target_table?: string;

	@Column({
		type: 'enum',
		enum: ['direct', 'lookup_table', 'company_mapping', 'partner_mapping', 'custom_function', 'value_mapping'],
		enumName: 'transformation_type_enum',
		nullable: true,
		comment: 'Tipo de transformación a aplicar al valor del campo durante la integración',
	})
	transformation_type?: string;

	@Column({ type: 'jsonb', nullable: true, comment: 'Configuración JSON para la transformación (tabla, columnas, filtros, etc.)' })
	transformation_config?: any;

	@ManyToOne(() => CompanyHolding)
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'field_mappings_holding_id_fkey' })
	holding?: CompanyHolding;

	@ManyToOne(() => User)
	@JoinColumn({ name: 'created_by', referencedColumnName: 'id', foreignKeyConstraintName: 'field_mappings_created_by_fkey' })
	createdBy?: User;
}
