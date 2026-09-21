import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Unique('unique_salesforce_type_per_holding', ['holding_id', 'salesforce_type'])
@Index('idx_sf_quote_type_mappings_active', ['holding_id', 'is_active'])
@Index('idx_sf_quote_type_mappings_holding', ['holding_id'])
@Entity({
	name: 'salesforce_quote_type_mappings',
	comment: 'Mapeo configurable de tipos de oportunidad Salesforce a quote_type de Sapira',
})
export class SalesforceQuoteTypeMapping {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'salesforce_quote_type_mappings_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'Valor del campo Type en Salesforce Opportunity' })
	salesforce_type: string;

	@Column({ type: 'text', comment: 'Valor del campo quote_type en tabla quotes de Sapira' })
	sapira_quote_type: string;

	@Column({ type: 'boolean', default: true, nullable: true })
	is_active: boolean;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({ name: 'holding_id', referencedColumnName: 'id', foreignKeyConstraintName: 'salesforce_quote_type_mappings_holding_id_fkey' })
	holding?: CompanyHolding;
}
