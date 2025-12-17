import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('field_mappings')
@Index('idx_field_mappings_source_table', ['source_table'])
@Index('idx_field_mappings_target_table', ['target_table'])
@Index('idx_field_mappings_created_at', ['created_at'])
export class FieldMapping {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'varchar', length: 255 })
	name!: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'varchar', length: 255 })
	source_table!: string;

	@Column({ type: 'varchar', length: 255 })
	target_table!: string;

	@Column({ type: 'jsonb' })
	field_mappings!: Record<string, any>;

	@Column({ type: 'jsonb', nullable: true })
	transformation_rules?: Record<string, any>;

	@Column({ type: 'boolean', default: true })
	is_active?: boolean;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	created_at!: Date;

	@Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
	updated_at!: Date;

	@Column({ type: 'uuid', nullable: true })
	created_by?: string;

	// Relaciones - Comentadas porque las relaciones están comentadas en IntegrationLog
	// @OneToMany(() => IntegrationLog, (integrationLog) => integrationLog.mapping)
	// integration_logs?: IntegrationLog[];
}
