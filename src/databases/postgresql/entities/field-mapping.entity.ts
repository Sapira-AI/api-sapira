import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('field_mappings')
export class FieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	source_model: string;

	@Column({ type: 'text' })
	target_table: string;

	@Column({ type: 'text', nullable: true })
	mapping_name?: string;

	@Column({ type: 'jsonb' })
	mapping_config: any;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	@CreateDateColumn({ type: 'timestamp without time zone' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp without time zone' })
	updated_at: Date;

	@Column({ type: 'text', nullable: true, default: 'simple' })
	mapping_type?: string;

	@Column({ type: 'text', nullable: true })
	secondary_source_model?: string;

	@Column({ type: 'text', nullable: true })
	secondary_target_table?: string;

	@Column({ type: 'text', nullable: true })
	transformation_type?: string;

	@Column({ type: 'jsonb', nullable: true })
	transformation_config?: any;
}
