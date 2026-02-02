import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('field_mappings')
@Index('idx_field_mappings_source_model', ['source_model'])
@Index('idx_field_mappings_target_table', ['target_table'])
@Index('idx_field_mappings_holding_id', ['holding_id'])
@Index('idx_field_mappings_mapping_type', ['mapping_type'])
@Index('idx_field_mappings_active', ['is_active'], { where: 'is_active = true' })
@Index('idx_field_mappings_hierarchical', ['holding_id', 'source_model', 'secondary_source_model', 'is_active'], {
	where: "mapping_type = 'hierarchical'",
})
@Index('unique_field_mapping', ['holding_id', 'mapping_type', 'source_model', 'target_table'], { unique: true })
export class FieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'text', nullable: false })
	source_model!: string;

	@Column({ type: 'text', nullable: false })
	target_table!: string;

	@Column({ type: 'text', nullable: true })
	mapping_name?: string;

	@Column({ type: 'jsonb', nullable: false })
	mapping_config!: Record<string, any>;

	@Column({ type: 'boolean', default: true })
	is_active?: boolean;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@Column({ type: 'timestamp', default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamp', default: () => 'now()' })
	updated_at!: Date;

	@Column({ type: 'text', nullable: true, default: "'simple'" })
	mapping_type?: string;

	@Column({ type: 'text', nullable: true })
	secondary_source_model?: string;

	@Column({ type: 'text', nullable: true })
	secondary_target_table?: string;

	@Column({ type: 'text', nullable: true })
	transformation_type?: string;

	@Column({ type: 'jsonb', nullable: true })
	transformation_config?: Record<string, any>;
}
