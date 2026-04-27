import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('field_mappings')
export class FieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	source_system: string;

	@Column({ type: 'text', nullable: true })
	source_model?: string;

	@Column({ type: 'text' })
	source_field: string;

	@Column({ type: 'text' })
	target_field: string;

	@Column({ type: 'text', nullable: true })
	target_table?: string;

	@Column({ type: 'text', nullable: true })
	mapping_name?: string;

	@Column({ type: 'text', nullable: true })
	mapping_type?: string;

	@Column({ type: 'jsonb', nullable: true })
	mapping_config?: any;

	@Column({ type: 'text', nullable: true })
	transformation_rule?: string;

	@Column({ type: 'text', nullable: true })
	default_value?: string;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	updated_at?: Date;

	@Column({ type: 'jsonb', nullable: true })
	metadata?: any;
}
