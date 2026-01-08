export interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	status?: string;
}

export interface EmailSenderConfig {
	id: string;
	holding_id: string;
	sender_domain: string;
	from_name: string;
	from_email: string;
	resend_domain_id: string | null;
	domain_status: 'pending' | 'verified' | 'failed';
	domain_dns_records: DnsRecord[] | null;
	domain_verified_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface ResendDomainResponse {
	id: string;
	name: string;
	status: 'pending' | 'verified' | 'failed';
	records: DnsRecord[];
	region?: string;
	created_at?: string;
}

export interface ResendDomainStatusResponse {
	id: string;
	name: string;
	status: 'pending' | 'verified' | 'failed';
	records: DnsRecord[];
}
