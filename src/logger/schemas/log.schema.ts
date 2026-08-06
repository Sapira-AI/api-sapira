import { Schema } from 'mongoose';

export const LogSchema = new Schema(
	{
		level: String,
		time: Date,
		type: String,
		environment: String,
		message: String,
		context: String,
		metadata: Object,
		trace: String,
		// Campos específicos para logs de API
		method: String,
		url: String,
		statusCode: Number,
		responseTime: Number,
		userAgent: String,
		ip: String,
		// Campos para auditoría
		userId: String,
		action: String,
		details: Object,
		// Campo para TTL index
		expiresAt: {
			type: Date,
			default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 días
			index: { expires: 0 },
		},
	},
	{
		timestamps: true,
		expires: 604800, // 7 días en segundos (7*24*60*60)
	}
);

// Crear índices para mejor rendimiento
LogSchema.index({ level: 1, time: 1 });
LogSchema.index({ type: 1 });
LogSchema.index({ 'metadata.userId': 1 });
