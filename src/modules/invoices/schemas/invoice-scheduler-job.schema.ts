import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { ProcessInvoicesResponseDto } from '../dtos/send-invoices.dto';

export type InvoiceSchedulerJobDocument = InvoiceSchedulerJob & Document;

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

@Schema({ timestamps: true, collection: 'invoice_scheduler_jobs' })
export class InvoiceSchedulerJob {
	@Prop({ required: true, unique: true })
	jobId: string;

	@Prop({ required: true })
	holdingId: string;

	@Prop({ required: false })
	contractId?: string;

	@Prop({ required: true })
	dryRun: boolean;

	@Prop({ required: true, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending' })
	status: JobStatus;

	@Prop({ type: Object, default: { total: 0, sent: 0, errors: 0, skipped: 0, current: 0 } })
	progress: {
		total: number;
		sent: number;
		errors: number;
		skipped: number;
		current: number;
	};

	@Prop({ type: Object, required: false })
	result?: ProcessInvoicesResponseDto;

	@Prop({ required: false })
	error?: string;

	@Prop({ required: true })
	userId: string;

	@Prop({ required: true })
	startedAt: Date;

	@Prop({ required: false })
	completedAt?: Date;
}

export const InvoiceSchedulerJobSchema = SchemaFactory.createForClass(InvoiceSchedulerJob);

InvoiceSchedulerJobSchema.index({ jobId: 1 });
InvoiceSchedulerJobSchema.index({ holdingId: 1, createdAt: -1 });
InvoiceSchedulerJobSchema.index({ userId: 1, createdAt: -1 });
InvoiceSchedulerJobSchema.index({ status: 1, createdAt: -1 });
