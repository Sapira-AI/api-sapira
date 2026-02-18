export interface StripeInvoice {
	id: string;
	object: string;
	amount_due: number;
	amount_paid: number;
	amount_remaining: number;
	currency: string;
	customer: string;
	customer_email?: string;
	customer_name?: string;
	description?: string;
	hosted_invoice_url?: string;
	invoice_pdf?: string;
	number?: string;
	status: string;
	created: number;
	due_date?: number;
	period_start: number;
	period_end: number;
	lines: {
		data: StripeInvoiceLineItem[];
	};
}

export interface StripeInvoiceLineItem {
	id: string;
	amount: number;
	currency: string;
	description?: string;
	quantity?: number;
	price?: {
		id: string;
		unit_amount: number;
		currency: string;
	};
}

export interface StripeInvoiceListResponse {
	object: string;
	data: StripeInvoice[];
	has_more: boolean;
	url: string;
}
