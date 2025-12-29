export interface BigQueryResult {
	rows: any[];
	totalRows: number;
	schema?: any[];
}

export interface BigQueryJobInfo {
	jobId: string;
	status: string;
	creationTime: string;
	totalBytesProcessed?: string;
	totalSlotMs?: string;
}
