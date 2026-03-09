import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('invoices')
export class Invoice {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'uuid' })
	contract_id: string;

	@Column({ type: 'text', nullable: true })
	invoice_number?: string;

	@Column({ type: 'date', nullable: true })
	issue_date?: Date;

	@Column({ type: 'date', nullable: true })
	due_date?: Date;

	@Column({ type: 'numeric', precision: 20, scale: 2 })
	amount_contract_currency: number;

	@Column({ type: 'text' })
	contract_currency: string;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	amount_invoice_currency?: number;

	@Column({ type: 'text', nullable: true })
	invoice_currency?: string;

	@Column({ type: 'numeric', precision: 20, scale: 8, nullable: true })
	fx_contract_to_invoice?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	total_invoice_currency?: number;

	@Column({ type: 'numeric', precision: 20, scale: 2, nullable: true })
	vat?: number;

	@Column({ type: 'text' })
	status: string;

	@Column({ type: 'text', nullable: true })
	invoice_type?: string;

	@Column({ type: 'text', nullable: true })
	document_type?: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'uuid', nullable: true })
	client_entity_id?: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'integer', nullable: true })
	odoo_invoice_id?: number;

	@Column({ type: 'timestamp with time zone', nullable: true })
	sent_to_odoo_at?: Date;

	@CreateDateColumn({ type: 'timestamp without time zone', default: () => 'now()' })
	created_at: Date;
}
