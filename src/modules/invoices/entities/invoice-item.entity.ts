import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('invoice_items')
export class InvoiceItem {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	invoice_id: string;

	@Column({ type: 'text', nullable: true })
	description?: string;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	quantity?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2 })
	unit_price_contract_currency: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	unit_price_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2 })
	subtotal_contract_currency: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	subtotal_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	tax_amount_contract_currency?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	tax_amount_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2 })
	total_contract_currency: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	total_invoice_currency?: number;

	@Column({ type: 'text', nullable: true })
	invoice_currency?: string;

	@Column({ type: 'numeric', precision: 20, scale: 8, nullable: true })
	fx_contract_to_invoice?: number;

	@Column({ type: 'uuid', nullable: true })
	product_id?: string;

	@Column({ type: 'text', nullable: true })
	tax_code?: string;

	@Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, default: 0 })
	discount_pct?: number;

	@Column({ type: 'integer', nullable: true })
	odoo_tax_id?: number;

	@CreateDateColumn({ type: 'timestamp', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'now()' })
	updated_at: Date;

	@Column({ type: 'uuid' })
	holding_id: string;

	@Column({ type: 'text', nullable: true, default: 'UND' })
	unit_of_measure?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	contract_id?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;

	@Column({ type: 'date', nullable: true })
	issue_date?: Date;

	@Column({ type: 'uuid', nullable: true })
	legacy_item_id?: string;

	@Column({ type: 'uuid', nullable: true })
	legacy_match_id?: string;

	@Column({ type: 'jsonb', nullable: true })
	custom_fields?: object;

	@Column({ type: 'text', nullable: true })
	fx_rate_source?: string;

	@Column({ type: 'date', nullable: true })
	fx_rate_date?: Date;

	@Column({ type: 'text', nullable: true })
	contract_currency?: string;

	@Column({ type: 'date', nullable: true })
	billing_period_start?: Date;

	@Column({ type: 'date', nullable: true })
	billing_period_end?: Date;

	@Column({ type: 'uuid', nullable: true })
	subscription_item_id?: string;
}
