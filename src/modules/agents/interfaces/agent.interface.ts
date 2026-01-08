export interface Agent {
	id: string;
	holding_id: string;
	type: 'proforma' | 'collections';
	name: string;
	description?: string;
	is_enabled: boolean;
	created_at: string;
	updated_at: string;
}

export interface AgentConfig {
	id: string;
	agent_id: string;
	key: string;
	value_json: any;
	created_at: string;
	updated_at: string;
}

export interface AgentRun {
	id: string;
	agent_id: string;
	holding_id: string;
	status: 'queued' | 'approved' | 'sent' | 'error';
	stats_json?: any;
	started_at: string;
	ended_at?: string;
}

export interface AgentMessage {
	id: string;
	run_id: string;
	direction: 'in' | 'out';
	channel: 'email' | 'sms' | 'whatsapp';
	to: string;
	subject?: string;
	body: string;
	meta_json?: any;
	sent_at?: string;
	created_at: string;
}

export interface ClientAgentConfig {
	id: string;
	client_id: string;
	agent_type: 'proforma' | 'collections';
	holding_id: string;
	is_enabled: boolean;
	config_json: Record<string, any>;
	created_at: string;
	updated_at: string;
}
