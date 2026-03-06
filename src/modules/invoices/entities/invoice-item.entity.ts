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

	@CreateDateColumn({ type: 'timestamp', default: () => 'now()' })
	created_at: Date;

	@UpdateDateColumn({ type: 'timestamp', default: () => 'now()' })
	updated_at: Date;
}
