export interface StripeCustomer {
	id: string;
	object: string;
	address?: {
		city?: string;
		country?: string;
		line1?: string;
		line2?: string;
		postal_code?: string;
		state?: string;
	};
	balance: number;
	created: number;
	currency?: string;
	default_source?: string;
	delinquent: boolean;
	description?: string;
	discount?: any;
	email?: string;
	invoice_prefix?: string;
	invoice_settings?: {
		custom_fields?: any;
		default_payment_method?: string;
		footer?: string;
	};
	livemode: boolean;
	metadata: Record<string, string>;
	name?: string;
	phone?: string;
	preferred_locales?: string[];
	shipping?: {
		address?: {
			city?: string;
			country?: string;
			line1?: string;
			line2?: string;
			postal_code?: string;
			state?: string;
		};
		name?: string;
		phone?: string;
	};
	tax_exempt?: string;
}

export interface StripeCustomerListResponse {
	object: string;
	data: StripeCustomer[];
	has_more: boolean;
	url: string;
}
