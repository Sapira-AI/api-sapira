import { Inject, Injectable } from '@nestjs/common';
import { Connection, Model } from 'mongoose';

import { OdooWebhookLog, OdooWebhookLogSchema } from './schemas/odoo-webhook.schema';

@Injectable()
export class OdooWebhookService {
	private webhookLogModel: Model<any>;

	constructor(@Inject('DbConnectionToken') private connection: Connection) {
		this.webhookLogModel = this.connection.model(OdooWebhookLog.name, OdooWebhookLogSchema);
	}

	/**
	 * Guarda el payload del webhook en MongoDB para análisis
	 */
	async saveWebhookLog(data: {
		event_type: string;
		model: string;
		payload: any;
		headers?: any;
		odoo_id?: number;
		holding_id?: string;
		connection_id?: string;
	}): Promise<any> {
		const webhookLog = new this.webhookLogModel({
			event_type: data.event_type,
			model: data.model,
			payload: data.payload,
			headers: data.headers,
			odoo_id: data.odoo_id,
			holding_id: data.holding_id,
			connection_id: data.connection_id,
			status: 'received',
		});

		return await webhookLog.save();
	}

	/**
	 * Obtiene los logs de webhooks recibidos
	 */
	async getWebhookLogs(filters?: { event_type?: string; model?: string; holding_id?: string; status?: string; limit?: number }): Promise<any[]> {
		const query: any = {};

		if (filters?.event_type) {
			query.event_type = filters.event_type;
		}
		if (filters?.model) {
			query.model = filters.model;
		}
		if (filters?.holding_id) {
			query.holding_id = filters.holding_id;
		}
		if (filters?.status) {
			query.status = filters.status;
		}

		return await this.webhookLogModel
			.find(query)
			.sort({ createdAt: -1 })
			.limit(filters?.limit || 100)
			.exec();
	}

	/**
	 * Marca un webhook como procesado
	 */
	async markAsProcessed(webhookId: string): Promise<any> {
		return await this.webhookLogModel
			.findByIdAndUpdate(
				webhookId,
				{
					status: 'processed',
					processed_at: new Date(),
				},
				{ new: true }
			)
			.exec();
	}

	/**
	 * Marca un webhook con error
	 */
	async markAsError(webhookId: string, errorMessage: string): Promise<any> {
		return await this.webhookLogModel
			.findByIdAndUpdate(
				webhookId,
				{
					status: 'error',
					error_message: errorMessage,
					processed_at: new Date(),
				},
				{ new: true }
			)
			.exec();
	}
}
