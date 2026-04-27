import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('stripe_customers_bigquery')
export class StripeCustomerBigQuery {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text' })
	stripe_customer_id: string;

	@Column({ type: 'text', nullable: true })
	email?: string;

	@Column({ type: 'text', nullable: true })
	name?: string;

	@Column({ type: 'text', nullable: true })
	client_name?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_id?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_country?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_segment?: string;

	@Column({ type: 'text', nullable: true })
	salesforce_account_industry?: string;

	@Column({ type: 'jsonb', nullable: true })
	metadata?: any;

	@CreateDateColumn({ type: 'timestamp with time zone' })
	created_at: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	updated_at?: Date;
}
