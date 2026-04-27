import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('contracts')
export class Contract {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	@Column({ type: 'text', nullable: true })
	invoice_terms_and_conditions?: string;

	@Column({ type: 'uuid', nullable: true })
	holding_id?: string;

	@Column({ type: 'text', nullable: true })
	contract_number?: string;

	@Column({ type: 'text', nullable: true })
	status?: string;

	@Column({ type: 'boolean', nullable: true })
	auto_send_to_odoo?: boolean;

	@Column({ type: 'uuid', nullable: true })
	client_id?: string;

	@Column({ type: 'uuid', nullable: true })
	company_id?: string;

	@Column({ type: 'uuid', nullable: true })
	quote_id?: string;

	@Column({ type: 'text', nullable: true })
	type?: string;

	@Column({ type: 'numeric', nullable: true })
	total_value?: number;

	@Column({ type: 'text', nullable: true })
	legal_client_name?: string;

	@Column({ type: 'text', nullable: true })
	legal_representative_name?: string;

	@Column({ type: 'text', nullable: true })
	legal_representative_id?: string;

	@Column({ type: 'text', nullable: true })
	client_name_commercial?: string;

	@Column({ type: 'text', nullable: true })
	notes?: string;

	@Column({ type: 'timestamp without time zone', nullable: true })
	created_at?: Date;

	@Column({ type: 'uuid', nullable: true })
	client_entity_id?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	from_bulk_import?: boolean;

	@Column({ type: 'uuid', nullable: true })
	current_step_id?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	workflow_started_at?: Date;

	@Column({ type: 'timestamp with time zone', nullable: true })
	workflow_completed_at?: Date;

	@Column({ type: 'date', nullable: true })
	booking_date?: Date;

	@Column({ type: 'date', nullable: true })
	contract_end_date?: Date;

	@Column({ type: 'uuid', nullable: true })
	renewed_from_contract_id?: string;

	@Column({ type: 'uuid', nullable: true })
	renewed_to_contract_id?: string;

	@Column({ type: 'date', nullable: true })
	churn_date?: Date;

	@Column({ type: 'text', default: 'USD' })
	contract_currency: string;

	@Column({ type: 'numeric', nullable: true })
	total_value_system_currency?: number;

	@Column({ type: 'text', nullable: true, default: 'USD' })
	system_currency?: string;

	@Column({ type: 'numeric', nullable: true })
	fx_rate_to_system?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicompany_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_multicurrency_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_references_for_billing?: boolean;

	@Column({ type: 'boolean', nullable: true, default: false })
	requires_contract_document?: boolean;

	@Column({ type: 'text', nullable: true })
	fx_company_policy?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	fx_company_confirmed_at?: Date;

	@Column({ type: 'text', nullable: true })
	fx_invoice_policy?: string;

	@Column({ type: 'timestamp with time zone', nullable: true })
	fx_invoice_confirmed_at?: Date;

	@Column({ type: 'text', nullable: true })
	company_currency?: string;

	@Column({ type: 'boolean', nullable: true, default: false })
	is_legacy?: boolean;

	@Column({ type: 'date', nullable: true })
	legacy_cutoff_date?: Date;

	@Column({ type: 'text', nullable: true })
	legacy_status?: string;

	@Column({ type: 'numeric', nullable: true, default: 0 })
	legacy_reconciliation_pct?: number;

	@Column({ type: 'jsonb', nullable: true })
	custom_fields?: object;

	@Column({ type: 'text', nullable: true })
	churn_reason?: string;

	@Column({ type: 'integer', nullable: true })
	term?: number;

	@Column({ type: 'boolean', nullable: true, default: false })
	auto_invoice?: boolean;

	@Column({ type: 'text', nullable: true })
	salesforce_opportunity_id?: string;

	@Column({ type: 'boolean', default: true })
	group_invoices_by_period: boolean;

	@Column({ type: 'text', nullable: true })
	invoice_currency?: string;

	@Column({ type: 'uuid', nullable: true })
	churn_reason_id?: string;
}
