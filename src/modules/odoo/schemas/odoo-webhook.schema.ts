import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OdooWebhookLogDocument = OdooWebhookLog & Document;

@Schema({ timestamps: true })
export class OdooWebhookLog {
	@Prop({ required: true })
	event_type: string;

	@Prop({ required: true })
	model: string;

	@Prop({ type: Object, required: true })
	payload: any;

	@Prop({ type: Object })
	headers: any;

	@Prop()
	odoo_id?: number;

	@Prop()
	holding_id?: string;

	@Prop()
	connection_id?: string;

	@Prop({ default: 'received' })
	status: string;

	@Prop()
	processed_at?: Date;

	@Prop()
	error_message?: string;
}

export const OdooWebhookLogSchema = SchemaFactory.createForClass(OdooWebhookLog);
