export interface CopilotMessage {
	role: 'user' | 'assistant';
	content: string;
	timestamp?: Date;
}

export interface CopilotSession {
	session_id: string;
	name: string;
	description?: string;
	holding_id?: string;
	created_at: Date;
	updated_at: Date;
}

export interface CopilotContext {
	session_id?: string;
	messages: CopilotMessage[];
	context?: string;
}

export interface CopilotResponse {
	response: string;
	session_id?: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
	widgets?: any[];
}
