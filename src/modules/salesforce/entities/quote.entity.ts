import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('quotes')
export class Quote {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'uuid' })
	client_id: string;

	@Column({ type: 'uuid', nullable: true })
	client_contact_id: string;

	@Column({ type: 'uuid', nullable: true })
	seller_id: string;

	@Column({ type: 'date', nullable: true })
	quote_date: Date;

	@Column({ type: 'text', nullable: true })
	payment_terms: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicompany: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicurrency: boolean;

	@Column({ type: 'text', nullable: true })
	currency: string;

	@Column({ type: 'numeric', nullable: true })
	total_amount: number;

	@Column({ type: 'text', nullable: true })
	notes: string;

	@Column({ type: 'timestamp', nullable: true, default: () => 'CURRENT_TIMESTAMP' })
	created_at: Date;

	@Column({ type: 'uuid' })
	quote_stage_id: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_references_for_billing: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_contract_document: boolean;

	@Column({ type: 'text', nullable: true })
	quote_number: string;

	@Column({ type: 'text', nullable: true })
	quote_type: string;

	@Column({ type: 'date', nullable: true })
	booking_date: Date;

	@Column({ type: 'text', nullable: true })
	salesforce_opportunity_id: string;

	@UpdateDateColumn({ type: 'timestamptz' })
	updated_at: Date;
}
