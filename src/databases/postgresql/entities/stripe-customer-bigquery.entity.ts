import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('stripe_customers_bigquery')
@Index('idx_stripe_customers_bigquery_holding_id', ['holding_id'])
@Index('idx_stripe_customers_bigquery_salesforce_account_id', ['salesforce_account_id'])
@Index('idx_stripe_customers_bigquery_stripe_customer_id', ['stripe_customer_id'])
@Index('unique_stripe_customer_per_holding', ['holding_id', 'salesforce_account_id', 'stripe_customer_id'], { unique: true })
export class StripeCustomerBigQuery {
	@PrimaryGeneratedColumn('uuid')
	id!: string;

	@Column({ type: 'uuid', nullable: false })
	holding_id!: string;

	@Column({ type: 'text', nullable: false })
	salesforce_account_id!: string;

	@Column({ type: 'text', nullable: false })
	stripe_customer_id!: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_country?: string;

	@Column({ type: 'text', nullable: true })
	client_name?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_segment?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_industry?: string;

	@CreateDateColumn({ type: 'timestamptz' })
	created_at!: Date;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at!: Date;
}
