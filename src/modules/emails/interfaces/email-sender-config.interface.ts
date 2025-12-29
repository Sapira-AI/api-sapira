export interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	status?: string;
	host?: string;
	data?: string;
}

export interface EmailSenderConfig {
	id: string;
	holding_id: string;
	sender_domain: string;
	resend_domain_id: string | null;
	domain_status: 'pending' | 'verified' | 'failed';
	domain_dns_records: DnsRecord[] | null;
	domain_verified_at: string | null;
	is_default: boolean;
	is_active: boolean;
	display_name: string | null;
	created_at: string;
	updated_at: string;
	created_by: string | null;
}

export interface SendGridDnsRecord {
	host: string;
	type: string;
	data: string;
	valid: boolean;
}

export interface SendGridDomainResponse {
	id: number;
	domain: string;
	subdomain: string;
	username: string;
	user_id: number;
	ips: string[];
	custom_spf: boolean;
	default: boolean;
	legacy: boolean;
	automatic_security: boolean;
	valid: boolean;
	dns: {
		mail_cname: SendGridDnsRecord;
		dkim1: SendGridDnsRecord;
		dkim2: SendGridDnsRecord;
		dmarc?: SendGridDnsRecord;
	};
}

export interface SendGridDomainValidationResponse {
	id: number;
	valid: boolean;
	validation_results: {
		mail_cname: {
			valid: boolean;
			reason: string | null;
		};
		dkim1: {
			valid: boolean;
			reason: string | null;
		};
		dkim2: {
			valid: boolean;
			reason: string | null;
		};
	};
}

export interface EmailSenderAddress {
	id: string;
	domain_config_id: string;
	from_name: string;
	from_email: string;
	reply_to_email: string | null;
	is_default: boolean;
	is_active: boolean;
	purpose: string | null;
	created_at: string;
	updated_at: string;
	created_by: string | null;
}

export interface DomainWithSenders extends EmailSenderConfig {
	email_sender_addresses?: EmailSenderAddress[];
}
