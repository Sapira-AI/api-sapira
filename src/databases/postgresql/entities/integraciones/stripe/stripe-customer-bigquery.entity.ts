import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { CompanyHolding } from '@/databases/postgresql/entities/base-tenancy/company-holding.entity';

@Index('idx_stripe_customers_bigquery_holding_id', ['holding_id'])
@Index('idx_stripe_customers_bigquery_salesforce_account_id', ['salesforce_account_id'])
@Index('idx_stripe_customers_bigquery_stripe_customer_id', ['stripe_customer_id'])
@Entity({ name: 'stripe_customers_bigquery', comment: 'Tabla de clientes Stripe sincronizados desde BigQuery' })
export class StripeCustomerBigQuery {
	@PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'stripe_customers_bigquery_pkey' })
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', comment: 'ID de la cuenta en Salesforce' })
	salesforce_account_id: string;

	@Column({ type: 'text', comment: 'ID del cliente en Stripe' })
	stripe_customer_id: string;

	@Column({ type: 'text', nullable: true, comment: 'País de la cuenta en Salesforce' })
	salesforce_account_country?: string;

	@Column({ type: 'text', nullable: true, comment: 'Nombre del cliente' })
	client_name?: string;

	@Column({ type: 'text', nullable: true, comment: 'Segmento de la cuenta en Salesforce' })
	salesforce_account_segment?: string;

	@Column({ type: 'text', nullable: true, comment: 'Industria de la cuenta en Salesforce' })
	salesforce_account_industry?: string;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'timestamptz', nullable: true, default: () => 'now()' })
	updated_at?: Date;

	@ManyToOne(() => CompanyHolding, { onDelete: 'CASCADE' })
	@JoinColumn({
		name: 'holding_id',
		referencedColumnName: 'id',
		foreignKeyConstraintName: 'stripe_customers_bigquery_holding_id_fkey',
	})
	holding?: CompanyHolding;
}
