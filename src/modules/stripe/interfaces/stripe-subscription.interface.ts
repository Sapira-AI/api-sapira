export interface StripeSubscription {
	id: string;
	object: string;
	application?: string;
	application_fee_percent?: number;
	automatic_tax?: {
		enabled: boolean;
	};
	billing_cycle_anchor: number;
	billing_thresholds?: any;
	cancel_at?: number;
	cancel_at_period_end: boolean;
	canceled_at?: number;
	collection_method: string;
	created: number;
	currency: string;
	current_period_end: number;
	current_period_start: number;
	customer: string;
	days_until_due?: number;
	default_payment_method?: string;
	default_source?: string;
	default_tax_rates?: any[];
	description?: string;
	discount?: any;
	ended_at?: number;
	items: {
		object: string;
		data: StripeSubscriptionItem[];
		has_more: boolean;
		url: string;
	};
	latest_invoice?: string;
	livemode: boolean;
	metadata: Record<string, string>;
	next_pending_invoice_item_invoice?: number;
	pause_collection?: any;
	payment_settings?: {
		payment_method_options?: any;
		payment_method_types?: string[];
		save_default_payment_method?: string;
	};
	pending_invoice_item_interval?: any;
	pending_setup_intent?: string;
	pending_update?: any;
	schedule?: string;
	start_date: number;
	status: string;
	test_clock?: string;
	transfer_data?: any;
	trial_end?: number;
	trial_start?: number;
}

export interface StripeSubscriptionItem {
	id: string;
	object: string;
	billing_thresholds?: any;
	created: number;
	metadata: Record<string, string>;
	price: {
		id: string;
		object: string;
		active: boolean;
		billing_scheme: string;
		created: number;
		currency: string;
		custom_unit_amount?: any;
		livemode: boolean;
		lookup_key?: string;
		metadata: Record<string, string>;
		nickname?: string;
		product: string;
		recurring?: {
			aggregate_usage?: string;
			interval: string;
			interval_count: number;
			usage_type: string;
		};
		tax_behavior?: string;
		tiers_mode?: string;
		transform_quantity?: any;
		type: string;
		unit_amount?: number;
		unit_amount_decimal?: string;
	};
	quantity?: number;
	subscription: string;
	tax_rates?: any[];
}

export interface StripeSubscriptionListResponse {
	object: string;
	data: StripeSubscription[];
	has_more: boolean;
	url: string;
}
