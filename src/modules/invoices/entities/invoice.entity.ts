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

	@Column({ type: 'text', nullable: true })
	stripe_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	sent_to_odoo_at?: Date;

	@Column({ type: 'boolean', default: false, nullable: true })
	auto_invoice?: boolean;

	@CreateDateColumn({ type: 'timestamp without time zone', default: () => 'now()' })
	created_at: Date;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'numeric', nullable: true })
	amount_system_currency?: number;

	@Column({ type: 'numeric', nullable: true })
	total_system_currency?: number;

	@Column({ type: 'text', nullable: true })
	pdf_url?: string;

	@Column({ type: 'text', nullable: true, default: 'FAC' })
	invoice_series?: string;

	@Column({ type: 'text', nullable: true })
	issuer_tax_id?: string;

	@Column({ type: 'text', nullable: true })
	issuer_legal_name?: string;

	@Column({ type: 'text', nullable: true })
	issuer_address?: string;

	@Column({ type: 'text', nullable: true })
	client_tax_id?: string;

	@Column({ type: 'text', nullable: true, default: 'CREDITO' })
	payment_method?: string;

	@Column({ type: 'text', nullable: true })
	fiscal_regime?: string;

	@Column({ type: 'integer', nullable: true, default: 0 })
	export_type?: number;

	@Column({ type: 'text', nullable: true })
	folio_fiscal_prev?: string;

	@Column({ type: 'jsonb', nullable: true })
	attachments?: object;

	@Column({ type: 'timestamp with time zone', nullable: true })
	sent_at?: Date;

	@Column({ type: 'date' })
	scheduled_at: Date;

	@Column({ type: 'date' })
	original_issue_date: Date;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	fx_contract_to_system?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_legacy?: boolean;

	@Column({ type: 'uuid', nullable: true })
	legacy_invoice_id?: string;

	@Column({ type: 'text', nullable: true })
	legacy_source_system?: string;

	@Column({ type: 'jsonb', nullable: true })
	custom_fields?: object;

	@Column({ type: 'uuid', nullable: true })
	related_invoice_id?: string;

	@Column({ type: 'uuid', nullable: true })
	invoice_group_id?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_references_for_billing?: boolean;

	@Column({ type: 'numeric', nullable: true })
	tax_rate?: number;

	@Column({ type: 'boolean', default: true })
	is_active: boolean;

	@Column({ type: 'uuid', nullable: true })
	consolidated_into_invoice_id?: string;

	@Column({ type: 'uuid', nullable: true })
	split_from_invoice_id?: string;

	@Column({ type: 'text', nullable: true })
	split_reason?: string;

	@Column({ type: 'uuid', nullable: true })
	subscription_id?: string;

	@Column({ type: 'text', nullable: true })
	invoice_terms_and_conditions?: string;
}
