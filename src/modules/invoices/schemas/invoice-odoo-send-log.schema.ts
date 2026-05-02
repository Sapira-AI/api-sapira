import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type InvoiceOdooSendLogDocument = InvoiceOdooSendLog & Document;

@Schema({
	timestamps: true,
	collection: 'invoice_odoo_send_logs',
})
export class InvoiceOdooSendLog {
	@Prop({ required: true, index: true })
	holding_id: string;

	@Prop({ required: true, index: true })
	invoice_id: string;

	@Prop({ required: true })
	invoice_number: string;

	@Prop({ type: Number })
	odoo_invoice_id?: number;

	@Prop({ required: true, enum: ['create_draft', 'post_invoice'], index: true })
	operation: string;

	@Prop({ required: true, enum: ['success', 'error', 'skipped'], index: true })
	status: string;

	@Prop({ required: true })
	client_name: string;

	@Prop({ required: true })
	company_name: string;

	@Prop()
	invoice_currency?: string;

	@Prop({ type: Number })
	invoice_amount?: number;

	@Prop({ type: Object })
	request_data?: any;

	@Prop({ type: Object })
	response_data?: any;

	@Prop()
	error_message?: string;

	@Prop()
	error_type?: string;

	@Prop({ type: Object })
	error_details?: any;

	@Prop({ type: Number })
	duration_ms?: number;
}

export const InvoiceOdooSendLogSchema = SchemaFactory.createForClass(InvoiceOdooSendLog);

// Índices compuestos para consultas comunes
InvoiceOdooSendLogSchema.index({ holding_id: 1, createdAt: -1 });
InvoiceOdooSendLogSchema.index({ invoice_id: 1, createdAt: -1 });
InvoiceOdooSendLogSchema.index({ status: 1, createdAt: -1 });
InvoiceOdooSendLogSchema.index({ holding_id: 1, status: 1, createdAt: -1 });
InvoiceOdooSendLogSchema.index({ operation: 1, status: 1 });
InvoiceOdooSendLogSchema.index({ createdAt: -1 });
