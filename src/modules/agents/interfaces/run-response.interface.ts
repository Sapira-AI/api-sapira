export interface RunResponse {
	run_id: string;
	status: 'queued' | 'approved' | 'sent';
	stats: {
		messages_created: number;
		clients_processed: number;
		clients_skipped: number;
		errors: number;
	};
	messages: Array<{
		id: string;
		to: string;
		subject: string;
		preview: string;
		client_id: string;
		client_name: string;
	}>;
}

export interface ApproveResponse {
	run_id: string;
	status: string;
	messages_sent: number;
	messages_error: number;
	total_messages: number;
}

export interface ProcessorResult {
	messages: any[];
	stats: {
		messages_created: number;
		clients_processed: number;
		clients_skipped: number;
		errors: number;
	};
}
