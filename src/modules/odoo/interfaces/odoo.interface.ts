export interface OdooConnectionConfig {
	id: string;
	url: string;
	database_name: string;
	username: string;
	api_key: string;
	holding_id: string;
}

export interface SyncResult {
	success: boolean;
	message: string;
	invoices_synced: number;
	lines_synced: number;
	partners_synced: number;
	errors: number;
	batch_id: string;
	total_processed: number;
	stats: {
		saved_invoices: number;
		saved_lines: number;
		saved_partners: number;
		errors: number;
	};
}

export interface EstimateResult {
	success: boolean;
	total_lines: number;
	total_invoices: number;
	total_partners: number;
	total_invoices_without_product_lines: number;
	invoices_without_product_lines_names: string[];
	message: string;
}

export interface XmlRpcResponse {
	methodResponse?: {
		fault?: {
			value: any;
		};
		params?: {
			param?: {
				value: any;
			};
		};
	};
}

export interface OdooInvoice {
	id: number;
	name: string;
	display_name: string;
	move_type: string;
	state: string;
	partner_id: [number, string];
	commercial_partner_id: [number, string];
	invoice_date: string;
	invoice_date_due: string;
	date: string;
	amount_untaxed: number;
	amount_tax: number;
	amount_total: number;
	amount_residual: number;
	currency_id: [number, string];
	company_currency_id: [number, string];
	invoice_origin: string;
	ref: string;
	narration: string;
	payment_reference: string;
	invoice_line_ids: number[];
	line_ids: number[];
	journal_id: [number, string];
	company_id: [number, string];
	create_date: string;
	write_date: string;
	create_uid: [number, string];
	write_uid: [number, string];
	invoice_user_id: [number, string];
	user_id: [number, string];
	team_id: [number, string];
	invoice_payment_term_id: [number, string];
	fiscal_position_id: [number, string];
	payment_state: string;
	invoice_payments_widget: any;
}

export interface OdooInvoiceLine {
	id: number;
	move_id: [number, string];
	name: string;
	display_name: string;
	sequence: number;
	product_id: [number, string];
	product_uom_id: [number, string];
	quantity: number;
	price_unit: number;
	price_subtotal: number;
	price_total: number;
	discount: number;
	tax_base_amount: number;
	account_id: [number, string];
	tax_ids: number[];
	tax_line_id: [number, string];
	partner_id: [number, string];
	currency_id: [number, string];
	create_date: string;
	write_date: string;
	display_type: string;
}

export interface OdooPartner {
	id: number;
	name: string;
	display_name: string;
	ref: string;
	active: boolean;
	email: string;
	phone: string;
	mobile: string;
	website: string;
	email_normalized: string;
	phone_sanitized: string;
	street: string;
	street2: string;
	city: string;
	zip: string;
	state_id: [number, string];
	country_id: [number, string];
	contact_address_complete: string;
	vat: string;
	commercial_partner_id: [number, string];
	is_company: boolean;
	company_type: string;
	category_id: number[];
	industry_id: [number, string];
	function: string;
	title: [number, string];
	create_date: string;
	write_date: string;
	create_uid: [number, string];
	write_uid: [number, string];
	supplier_rank: number;
	customer_rank: number;
	user_id: [number, string];
	team_id: [number, string];
	property_payment_term_id: [number, string];
	l10n_cl_activity_description: string;
	lang: string;
	tz: string;
}

export interface OdooCompany {
	id: number;
	name: string;
	display_name: string;
	vat: string;
	country_id: [number, string] | false;
	currency_id: [number, string] | false;
	email: string;
	phone: string;
	website: string;
	street: string;
	city: string;
	state_id: [number, string] | false;
	zip: string;
	partner_id: [number, string];
	account_sale_tax_id: [number, string] | false;
	account_purchase_tax_id: [number, string] | false;
	account_fiscal_country_id: [number, string] | false;
	tax_calculation_rounding_method: 'round_per_line' | 'round_globally';
	tax_exigibility: boolean;
}

export interface SapiraCompany {
	id: string;
	holding_name: string;
	legal_name: string;
	odoo_integration_id: number | null;
	holding_id: string;
}

export interface CompaniesResult {
	success: boolean;
	message: string;
	odoo_companies: OdooCompanyFormatted[];
	sapira_companies: SapiraCompany[];
	connection_info: {
		id: string;
		server_url: string;
		database_name: string;
		holding_id: string;
	};
}

export interface OdooCompanyFormatted {
	id: number;
	name: string;
	display_name: string;
	vat: string;
	country: string | null;
	currency: string | null;
	email: string;
	phone: string;
	website: string;
	address: string;
	state: string | null;
	partner_id: [number, string];
	default_sale_tax_id: number | false;
	default_sale_tax_name: string | null;
	default_purchase_tax_id: number | false;
	default_purchase_tax_name: string | null;
	fiscal_country_id: number | false;
	fiscal_country_name: string | null;
	tax_calculation_rounding: 'round_per_line' | 'round_globally';
	use_cash_basis: boolean;
}

export interface OdooProduct {
	id: number;
	name: string;
	display_name: string;
	default_code: string | false;
	barcode: string | false;
	list_price: number;
	standard_price: number;
	uom_id: [number, string];
	uom_po_id: [number, string];
	categ_id: [number, string];
	type: string;
	sale_ok: boolean;
	purchase_ok: boolean;
	active: boolean;
	taxes_id: number[];
	supplier_taxes_id: number[];
	description: string | false;
	description_sale: string | false;
	description_purchase: string | false;
}

export interface SapiraProduct {
	id: string;
	holding_id: string | null;
	product_code: string | null;
	name: string | null;
	is_recurring: boolean | null;
	default_currency: string | null;
	default_price: number | null;
	created_at: Date;
	salesforce_product_id: string | null;
	odoo_product_id: number | null;
	odoo_tax_id: string | null;
}

export interface ProductsResult {
	success: boolean;
	message: string;
	odoo_products: OdooProductFormatted[];
	sapira_products: SapiraProduct[];
	connection_info: {
		id: string;
		server_url: string;
		database_name: string;
		holding_id: string;
	};
}

export interface OdooTax {
	id: number;
	name: string;
	description: string | false;
	amount: number;
	amount_type: string;
	type_tax_use: string;
	active: boolean;
}

export interface OdooTaxFormatted {
	id: number;
	name: string;
	description: string | null;
	amount: number;
	amount_type: string;
	tax_use: string;
	is_active: boolean;
}

export interface OdooProductFormatted {
	id: number;
	name: string;
	display_name: string;
	product_code: string | null;
	barcode: string | null;
	list_price: number;
	standard_price: number;
	unit_of_measure: string | null;
	purchase_unit: string | null;
	category: string | null;
	product_type: string;
	can_be_sold: boolean;
	can_be_purchased: boolean;
	is_active: boolean;
	tax_ids: number[];
	supplier_tax_ids: number[];
	tax_details: OdooTaxFormatted[];
	supplier_tax_details: OdooTaxFormatted[];
	description: string | null;
	sales_description: string | null;
	purchase_description: string | null;
}
