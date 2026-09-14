import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { SalesforceOpportunitiesStg } from '@/databases/postgresql/entities/integraciones/salesforce/salesforce-opportunities-stg.entity';

@Unique('salesforce_line_items_stg_unique', ['holding_id', 'salesforce_id'])
@Check(
	'salesforce_line_items_stg_status_check',
	`(((processing_status IS NULL) OR (processing_status = ANY (ARRAY['create'::text, 'update'::text, 'processed'::text, 'error'::text]))))`
)
@Index('idx_salesforce_line_items_stg_holding_status', ['holding_id', 'processing_status'])
@Index('idx_salesforce_line_items_stg_opportunity', ['holding_id', 'salesforce_opportunity_id'])
@Index('idx_salesforce_line_items_stg_product', ['holding_id', 'salesforce_product_id'])
@Entity('salesforce_line_items_stg')
export class SalesforceLineItemsStg {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_line_items_stg_pkey' })
	id!: string;

	@Column({ type: 'uuid' })
	holding_id!: string;

	@Column({ type: 'uuid', nullable: true })
	opportunity_staging_id?: string | null;

	@Column({ type: 'text' })
	salesforce_id!: string;

	@Column({ type: 'text', nullable: true })
	salesforce_opportunity_id?: string | null;

	@Column({ type: 'text', nullable: true })
	salesforce_product_id?: string | null;

	@Column({ type: 'text', nullable: true })
	salesforce_name?: string | null;

	@Column({ type: 'jsonb' })
	raw_data!: Record<string, any>;

	@Column({ type: 'text', nullable: true, default: 'create' })
	processing_status?: string | null;

	@Column({ type: 'text', nullable: true })
	source_hash?: string | null;

	@Column({ type: 'text', nullable: true })
	error_message?: string | null;

	@Column({ type: 'text', nullable: true })
	integration_notes?: string | null;

	@Column({ type: 'uuid', nullable: true })
	batch_id?: string | null;

	@Column({ type: 'uuid', nullable: true })
	sync_session_id?: string | null;

	@Column({ type: 'timestamptz', nullable: true })
	processed_at?: Date | null;

	@Column({ type: 'timestamptz', nullable: true })
	last_integrated_at?: Date | null;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at!: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at!: Date;

	@ManyToOne(() => SalesforceOpportunitiesStg, { onDelete: 'SET NULL' })
	@JoinColumn({
		name: 'opportunity_staging_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'salesforce_line_items_stg_opportunity_staging_id_fkey',
	})
	opportunityStaging?: SalesforceOpportunitiesStg;
}
