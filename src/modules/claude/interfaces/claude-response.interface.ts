export interface ClaudeMessage {
	role: 'user' | 'assistant';
	content: string | Array<{ type: string; text?: string; tool_use_id?: string; content?: string }>;
}

export interface ClaudeResponse {
	id: string;
	type: string;
	role: string;
	content: Array<{
		type: string;
		text?: string;
		id?: string;
		name?: string;
		input?: Record<string, any>;
	}>;
	model: string;
	stop_reason: string;
	usage: {
		input_tokens: number;
		output_tokens: number;
	};
}

export interface ConversationContext {
	conversation_id?: string;
	messages: ClaudeMessage[];
	system_prompt?: string;
}
