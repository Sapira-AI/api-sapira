import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OdooInvoiceUpdateLogDocument = OdooInvoiceUpdateLog & Document;

@Schema({ timestamps: true })
export class OdooInvoiceUpdateLog {
	@Prop({ required: true })
	sapira_invoice_id: string;

	@Prop({ required: true })
	odoo_invoice_id: number;

	@Prop()
	holding_id?: string;

	@Prop({ type: Object, required: true })
	webhook_payload: any;

	@Prop({ type: [String] })
	fields_changed?: string[];

	@Prop({ type: Object })
	old_values?: any;

	@Prop({ type: Object })
	new_values?: any;

	@Prop({ default: true })
	was_updated: boolean;

	@Prop()
	skip_reason?: string;
}

export const OdooInvoiceUpdateLogSchema = SchemaFactory.createForClass(OdooInvoiceUpdateLog);

OdooInvoiceUpdateLogSchema.index({ sapira_invoice_id: 1 });
OdooInvoiceUpdateLogSchema.index({ odoo_invoice_id: 1 });
OdooInvoiceUpdateLogSchema.index({ holding_id: 1 });
OdooInvoiceUpdateLogSchema.index({ createdAt: -1 });
