export interface ReminderLevel {
	level: number;
	days_before_due?: number;
	days_overdue: number;
	frequency_hours: number;
	is_enabled?: boolean;
	custom_subject?: string;
	custom_body?: string;
}

export interface CollectionsConfig {
	email_sender_address_id?: string;
	reminder_levels: ReminderLevel[];
}
