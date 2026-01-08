import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { renderTemplate } from '../helpers/template.helper';
import { ProcessorResult } from '../interfaces/run-response.interface';

@Injectable()
export class ProformaProcessor {
	private readonly logger = new Logger(ProformaProcessor.name);

	constructor(private readonly dataSource: DataSource) {}

	async process(
		agent: any,
		globalConfig: Record<string, any>,
		runId: string,
		holdingId: string,
		mode: 'preview' | 'execute'
	): Promise<ProcessorResult> {
		const messages = [];
		const stats = {
			messages_created: 0,
			clients_processed: 0,
			clients_skipped: 0,
			errors: 0,
		};

		try {
			const daysBefore = globalConfig.days_before_issue || 10;
			const today = new Date();
			const futureDate = new Date();
			futureDate.setDate(today.getDate() + daysBefore);

			const invoices = await this.dataSource.query(
				`
				SELECT 
					i.*,
					c.id as contract_id,
					c.client_id,
					cl.name_commercial as client_name
				FROM invoices i
				INNER JOIN contracts c ON i.contract_id = c.id
				INNER JOIN clients cl ON c.client_id = cl.id
				WHERE i.status = 'Por Emitir'
				AND i.requires_references_for_billing = true
				AND i.scheduled_at >= $1
				AND i.scheduled_at <= $2
				AND i.holding_id = $3
				ORDER BY cl.name_commercial, i.scheduled_at
			`,
				[today.toISOString(), futureDate.toISOString(), holdingId]
			);

			const invoicesByClient = this.groupByClient(invoices);

			for (const [clientId, clientInvoices] of Object.entries(invoicesByClient)) {
				try {
					const effectiveConfig = await this.getEffectiveConfigForClient(clientId, 'proforma', holdingId);

					if (!effectiveConfig) {
						stats.clients_skipped++;
						continue;
					}

					const emailSender = await this.getEffectiveEmailSender(effectiveConfig, holdingId);

					for (const invoice of clientInvoices as any[]) {
						const existingRequest = await this.dataSource.query(`SELECT id FROM reference_requests WHERE invoice_id = $1 LIMIT 1`, [
							invoice.id,
						]);

						if (existingRequest && existingRequest.length > 0) {
							continue;
						}

						// Filtrar solo contactos de tipo 'proforma'
						const contacts = await this.dataSource.query(`SELECT * FROM client_contacts WHERE client_id = $1 AND contact_type = $2`, [
							clientId,
							'Proforma',
						]);

						// Enviar mensaje solo a contactos de tipo proforma
						if (contacts && contacts.length > 0) {
							for (const contact of contacts) {
								const message = await this.generateMessage(invoice, contact, effectiveConfig, emailSender, runId, mode);
								messages.push(message);
								stats.messages_created++;
							}
						} else {
							this.logger.warn(`Cliente ${clientId} no tiene contacto de tipo 'proforma' para factura ${invoice.id}`);
						}

						if (mode === 'execute') {
							await this.dataSource.query(
								`INSERT INTO reference_requests (contract_id, invoice_id, reference_type, status, requested_at) VALUES ($1, $2, $3, $4, $5)`,
								[invoice.contract_id, invoice.id, 'OC', 'requested', new Date().toISOString()]
							);
						}
					}

					stats.clients_processed++;
				} catch (error) {
					stats.errors++;
					this.logger.error(`Error procesando cliente ${clientId}:`, error);
				}
			}
		} catch (error) {
			this.logger.error('Error en ProformaProcessor:', error);
			throw error;
		}

		return { messages, stats };
	}

	private groupByClient(invoices: any[]): Record<string, any[]> {
		const grouped: Record<string, any[]> = {};

		for (const invoice of invoices) {
			const clientId = invoice.client_id;
			if (!grouped[clientId]) {
				grouped[clientId] = [];
			}
			grouped[clientId].push(invoice);
		}

		return grouped;
	}

	private async getEffectiveConfigForClient(clientId: string, agentType: string, holdingId: string): Promise<Record<string, any> | null> {
		const clientConfig = await this.dataSource.query(
			`SELECT * FROM client_agent_configs WHERE client_id = $1 AND agent_type = $2 AND holding_id = $3 LIMIT 1`,
			[clientId, agentType, holdingId]
		);

		if (clientConfig && clientConfig.length > 0) {
			if (!clientConfig[0].is_enabled) {
				return null;
			}
			return clientConfig[0].config_json;
		}

		const holdingConfig = await this.dataSource.query(
			`SELECT * FROM client_agent_configs WHERE client_id IS NULL AND agent_type = $1 AND holding_id = $2 LIMIT 1`,
			[agentType, holdingId]
		);

		if (holdingConfig && holdingConfig.length > 0) {
			if (!holdingConfig[0].is_enabled) {
				return null;
			}
			return holdingConfig[0].config_json;
		}

		return null;
	}

	private async getEffectiveEmailSender(config: Record<string, any>, holdingId: string): Promise<any> {
		if (config.email_sender_address_id) {
			const sender = await this.dataSource.query(`SELECT from_name, from_email, reply_to_email FROM email_sender_addresses WHERE id = $1`, [
				config.email_sender_address_id,
			]);

			if (sender && sender.length > 0) {
				return sender[0];
			}
		}

		const defaultSender = await this.dataSource.query(
			`
			SELECT esa.from_name, esa.from_email, esa.reply_to_email
			FROM email_sender_addresses esa
			INNER JOIN holding_email_sender_settings hess ON esa.id = hess.email_sender_address_id
			WHERE hess.holding_id = $1 AND hess.is_default = true AND esa.is_active = true
			LIMIT 1
		`,
			[holdingId]
		);

		return defaultSender && defaultSender.length > 0 ? defaultSender[0] : { from_name: 'Sapira', from_email: 'noreply@sapira.cl' };
	}

	private async generateMessage(invoice: any, contact: any, config: Record<string, any>, emailSender: any, runId: string, mode: string) {
		const variables = {
			client_name: invoice.client_name || 'Cliente',
			contact_name: contact.name || 'Estimado/a',
			invoice_number: invoice.invoice_number || invoice.folio || 'Por asignar',
			formatted_date: new Date(invoice.scheduled_at).toLocaleDateString('es-CL'),
			contract_number: invoice.contract_id || 'N/A',
			holding_name: emailSender.from_name || 'Sapira',
		};

		const subject = renderTemplate(
			config.custom_email_subject || config.email_subject_template || 'Solicitud de referencia - {{client_name}}',
			variables
		);

		const body = renderTemplate(config.custom_email_body || config.email_body_template || this.getDefaultTemplate(), variables);

		const messageData = {
			run_id: runId,
			direction: 'out',
			channel: 'email',
			to: contact.email,
			subject,
			body,
			meta_json: JSON.stringify({
				from_name: emailSender.from_name,
				from_email: emailSender.from_email,
				reply_to_email: emailSender.reply_to_email,
				invoice_id: invoice.id,
				client_id: invoice.client_id,
				client_name: invoice.client_name,
			}),
		};

		if (mode === 'execute') {
			const result = await this.dataSource.query(
				`INSERT INTO ai_messages (run_id, direction, channel, "to", subject, body, meta_json) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
				[
					messageData.run_id,
					messageData.direction,
					messageData.channel,
					messageData.to,
					messageData.subject,
					messageData.body,
					messageData.meta_json,
				]
			);

			return result[0];
		}

		return {
			id: 'preview-' + Math.random(),
			...messageData,
			meta_json: JSON.parse(messageData.meta_json),
		};
	}

	private getDefaultTemplate(): string {
		return `
			<p>Estimado/a {{contact_name}},</p>
			<p>Le enviamos la proforma de {{client_name}} correspondiente a la factura programada para el {{formatted_date}}.</p>
			<p>Por favor, envíenos la orden de compra o referencia correspondiente para proceder con la emisión.</p>
			<p>Saludos cordiales</p>
		`;
	}
}
