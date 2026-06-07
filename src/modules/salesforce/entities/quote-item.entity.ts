import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('quote_items')
export class QuoteItem {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid', nullable: true })
	quote_id: string;

	@Column({ type: 'uuid', nullable: true })
	product_id: string;

	@Column({ type: 'text' })
	product_name: string;

	@Column({ type: 'integer', nullable: true })
	term_months: number;

	@Column({ type: 'text', nullable: true })
	currency: string;

	@Column({ type: 'numeric', nullable: true })
	price: number;

	@Column({ type: 'text', nullable: true })
	discount_type: string;

	@Column({ type: 'numeric', nullable: true })
	discount_value: number;

	@Column({ type: 'numeric', nullable: true })
	final_price: number;

	@Column({ type: 'text', nullable: true })
	billing_method: string;

	@Column({ type: 'text', nullable: true })
	billing_frequency: string;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'date', nullable: true })
	start_date: Date;

	@Column({ type: 'date', nullable: true })
	end_date: Date;

	@Column({ type: 'boolean', default: true })
	is_recurring: boolean;

	@Column({ type: 'varchar', length: 64, nullable: true })
	item_type: string;

	@Column({ type: 'varchar', length: 32, nullable: true })
	unit_of_measure: string;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	unit_price: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	quantity: number;

	@Column({ type: 'varchar', length: 128, nullable: true })
	account: string;

	@Column({ type: 'jsonb', nullable: true, default: {} })
	custom_fields: any;

	@Column({ type: 'text', nullable: true })
	quote_item_number: string;

	@Column({ type: 'text', nullable: true })
	data_source: string;

	@Column({ type: 'text', nullable: true })
	salesforce_product_id: string;

	@Column({ type: 'text', nullable: true })
	salesforce_line_item_id: string;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	monthly_price: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	billing_period_price: number;

	@Column({ type: 'boolean', default: false })
	auto_renew: boolean;

	@Column({ type: 'integer', nullable: true })
	auto_renew_term_months: number;

	@Column({ type: 'numeric', precision: 18, scale: 6, nullable: true })
	annual_unit_price: number;

	@Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
	annual_price: number;

	@Column({ type: 'text', nullable: true, default: 'monthly' })
	price_entry_mode: string;
}
