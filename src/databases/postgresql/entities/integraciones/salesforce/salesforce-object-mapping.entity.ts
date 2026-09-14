import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('unique_salesforce_object_per_holding', ['holding_id', 'salesforce_object_type', 'salesforce_object_id'])
@Index('idx_salesforce_mappings_holding', ['holding_id'])
@Index('idx_salesforce_mappings_salesforce_lookup', ['holding_id', 'salesforce_object_type', 'salesforce_object_id'])
@Index('idx_salesforce_mappings_sapira_lookup', ['holding_id', 'sapira_table_name', 'sapira_record_id'])
@Entity('salesforce_object_mappings')
export class SalesforceObjectMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_object_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	salesforce_object_id: string;

	@Column({ type: 'text' })
	salesforce_object_type: string;

	@Column({ type: 'text' })
	sapira_table_name: string;

	@Column({ type: 'uuid' })
	sapira_record_id: string;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
	last_synced_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_object_mappings_holding_id_fkey' })
	holding?: CompanyHolding;
}
