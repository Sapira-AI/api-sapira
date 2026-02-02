import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

import { DeviceInfoDto } from '@/core/dto/device-info.dto';

export type DeviceDocument = Device & Document;

@Schema({ timestamps: true })
export class Device {
	@Prop({ required: true, unique: true })
	deviceId: string;

	@Prop({ type: MongooseSchema.Types.Mixed, required: true })
	deviceInfo: DeviceInfoDto;

	@Prop({ type: Types.ObjectId, ref: 'User', default: null })
	userId: Types.ObjectId | null;

	@Prop({ default: false })
	isBlocked: boolean;

	@Prop()
	blockReason?: string;

	@Prop({ default: Date.now })
	lastAccessAt: Date;

	@Prop({ default: 0 })
	accessCount: number;

	@Prop({ type: [String], default: [] })
	accessHistory: string[];
}

export const DeviceSchema = SchemaFactory.createForClass(Device);
