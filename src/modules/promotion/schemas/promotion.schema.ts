import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

import { RepublishOptions } from './republish-options.schema';

@Schema({ collection: 'promotion', read: 'nearest' })
export class Promotion extends Document {
	@Prop({ type: String, required: false })
	code?: string;

	@Prop({ type: String, required: false })
	title?: string;

	@Prop({ type: String, required: false })
	subtitle?: string;

	@Prop({ type: String, required: false })
	price?: string;

	@Prop({ type: Number, required: false })
	amount?: number;

	@Prop({ type: Boolean, required: false })
	featured?: boolean;

	@Prop({ type: [String], required: false })
	features?: string[];

	@Prop({ type: [RepublishOptions], required: false })
	republishOptions?: RepublishOptions[];

	@Prop({ type: Boolean, required: false })
	selected?: boolean;

	@Prop({ type: Boolean, required: false })
	default?: boolean;
}

export const PromotionSchema = SchemaFactory.createForClass(Promotion);
