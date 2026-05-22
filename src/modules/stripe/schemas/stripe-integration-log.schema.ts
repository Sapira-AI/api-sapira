import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StripeIntegrationLogDocument = StripeIntegrationLog & Document;

@Schema({ timestamps: true })
export class StripeIntegrationLog {
	@Prop({ required: true, index: true })
	holding_id: string;

	@Prop({ required: true, index: true })
	integration_type: string;

	@Prop()
	operation?: string;

	@Prop({ required: true, index: true, default: 'running' })
	status: string;

	@Prop({ required: true })
	source_table: string;

	@Prop({ required: true })
	target_table: string;

	@Prop({ default: 0 })
	records_processed: number;

	@Prop({ default: 0 })
	records_success: number;

	@Prop({ default: 0 })
	records_failed: number;

	@Prop({ default: 0 })
	progress_total: number;

	@Prop({ required: true, default: () => new Date() })
	started_at: Date;

	@Prop()
	completed_at?: Date;

	@Prop()
	execution_time_ms?: number;

	@Prop({ type: Object })
	error_details?: any;

	@Prop({ index: true })
	connection_id?: string;

	@Prop({ type: Object })
	metadata?: any;

	@Prop()
	user_id?: string;

	@Prop()
	external_id?: string;

	@Prop({ required: true, unique: true, index: true })
	batch_uuid: string;
}

export const StripeIntegrationLogSchema = SchemaFactory.createForClass(StripeIntegrationLog);

StripeIntegrationLogSchema.index({ holding_id: 1, status: 1 });

StripeIntegrationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 31536000 });

StripeIntegrationLogSchema.index({ batch_uuid: 1 }, { unique: true });
