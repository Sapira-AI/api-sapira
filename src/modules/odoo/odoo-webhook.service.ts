import { Inject, Injectable, Logger } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { DataSource } from 'typeorm';

import { Invoice } from '../invoices/entities/invoice.entity';

import { OdooWebhookLog, OdooWebhookLogSchema } from './schemas/odoo-webhook.schema';

@Injectable()
export class OdooWebhookService {
	private readonly logger = new Logger(OdooWebhookService.name);
	private webhookLogModel: Model<any>;

	constructor(
		@Inject('DbConnectionToken') private connection: Connection,
		private readonly dataSource: DataSource
	) {
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

	/**
	 * Procesa actualización de estado de factura cuando Odoo notifica que fue posted
	 * Si el webhook contiene x_sapira_invoice_id y state = 'posted',
	 * actualiza el estado de la factura en PostgreSQL a 'Emitida'
	 */
	async processInvoiceStatusUpdate(payload: any): Promise<{ updated: boolean; invoiceId?: string; message?: string }> {
		try {
			// Validar que sea una factura (account.move)
			if (payload.model !== 'account.move' && payload._model !== 'account.move') {
				return { updated: false, message: 'No es una factura de Odoo' };
			}

			// Extraer datos del payload (puede venir en diferentes estructuras)
			const invoiceData = payload.payload || payload;
			const sapiraInvoiceId = invoiceData.x_sapira_invoice_id;
			const odooState = invoiceData.state;
			const odooInvoiceId = invoiceData.id || invoiceData._id;

			// Validar que tenga x_sapira_invoice_id y state = 'posted'
			if (!sapiraInvoiceId) {
				return { updated: false, message: 'No tiene x_sapira_invoice_id' };
			}

			if (odooState !== 'posted') {
				return { updated: false, message: `Estado en Odoo es '${odooState}', no 'posted'` };
			}

			// Obtener repositorio de Invoice
			const invoiceRepository = this.dataSource.getRepository(Invoice);

			// Buscar la factura en PostgreSQL
			const invoice = await invoiceRepository.findOne({
				where: { id: sapiraInvoiceId },
			});

			if (!invoice) {
				this.logger.warn(`Factura con ID ${sapiraInvoiceId} no encontrada en PostgreSQL`);
				return { updated: false, message: `Factura ${sapiraInvoiceId} no encontrada` };
			}

			// Actualizar estado a 'Emitida'
			await invoiceRepository.update(sapiraInvoiceId, {
				status: 'Emitida',
				odoo_invoice_id: odooInvoiceId,
			});

			this.logger.log(
				`✓ Factura ${invoice.invoice_number || sapiraInvoiceId} actualizada a estado 'Emitida' ` +
					`desde webhook de Odoo (Odoo ID: ${odooInvoiceId})`
			);

			return {
				updated: true,
				invoiceId: sapiraInvoiceId,
				message: `Factura actualizada a 'Emitida'`,
			};
		} catch (error) {
			this.logger.error(`Error procesando actualización de estado de factura:`, error);
			return {
				updated: false,
				message: `Error: ${error.message}`,
			};
		}
	}
}
