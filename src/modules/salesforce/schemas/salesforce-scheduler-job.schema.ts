import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesforceSchedulerJobDocument = SalesforceSchedulerJob & Document;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HoldingResult {
	holding_id: string;
	success: boolean;
	opportunities: number;
	clientsCreated: number;
	clientsUpdated: number;
	quotesCreated: number;
	quotesUpdated: number;
	sellersCreated: number;
	error?: string;
	durationSeconds: number;
}

export interface JobSummary {
	totalHoldings: number;
	successfulHoldings: number;
	failedHoldings: number;
	totalOpportunities: number;
	totalClients: number;
	totalQuotes: number;
	totalSellers: number;
}

@Schema({ timestamps: true, collection: 'salesforce_scheduler_jobs' })
export class SalesforceSchedulerJob {
	@Prop({ required: true, unique: true })
	jobId: string;

	@Prop({ required: true, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending' })
	status: JobStatus;

	@Prop({ required: true })
	startedAt: Date;

	@Prop({ required: false })
	completedAt?: Date;

	@Prop({ required: false })
	durationSeconds?: number;

	@Prop({
		type: Object,
		default: {
			totalHoldings: 0,
			successfulHoldings: 0,
			failedHoldings: 0,
			totalOpportunities: 0,
			totalClients: 0,
			totalQuotes: 0,
			totalSellers: 0,
		},
	})
	summary: JobSummary;

	@Prop({ type: Array, default: [] })
	holdingResults: HoldingResult[];

	@Prop({ required: false })
	error?: string;

	@Prop({
		type: Date,
		default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
		index: { expires: 0 },
	})
	expiresAt: Date;
}

export const SalesforceSchedulerJobSchema = SchemaFactory.createForClass(SalesforceSchedulerJob);

SalesforceSchedulerJobSchema.index({ jobId: 1 });
SalesforceSchedulerJobSchema.index({ status: 1, createdAt: -1 });
SalesforceSchedulerJobSchema.index({ createdAt: -1 });
