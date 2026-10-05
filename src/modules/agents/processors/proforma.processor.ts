import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { resolveEffectiveConfig, resolveEmailSender } from '../helpers/agent-config.helper';
import { renderTemplate } from '../helpers/template.helper';
import { ProcessorResult } from '../interfaces/run-response.interface';

const DEFAULT_DAYS_BEFORE_ISSUE = 10;

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
			const defaultDays = Number(globalConfig.days_before_issue) || DEFAULT_DAYS_BEFORE_ISSUE;
			const maxDays = await this.getMaxDaysBeforeIssue(holdingId, defaultDays);
			const today = new Date();
			const futureDate = new Date();
			futureDate.setDate(today.getDate() + maxDays);

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
					const effectiveConfig = await resolveEffectiveConfig(this.dataSource, clientId, 'proforma', holdingId);

					if (!effectiveConfig) {
						stats.clients_skipped++;
						continue;
					}

					const emailSender = await resolveEmailSender(this.dataSource, effectiveConfig, holdingId);
					const clientLimit = new Date(today);
					clientLimit.setDate(today.getDate() + (Number(effectiveConfig.days_before_issue) || defaultDays));

					for (const invoice of (clientInvoices as any[]).filter((inv) => new Date(inv.scheduled_at) <= clientLimit)) {
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
								`INSERT INTO reference_requests (holding_id, contract_id, invoice_id, reference_type, status, requested_at) VALUES ($1, $2, $3, $4, $5, $6)`,
								[holdingId, invoice.contract_id, invoice.id, 'OC', 'requested', new Date().toISOString()]
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

	/**
	 * Ventana de la consulta: el mayor `days_before_issue` entre las configuraciones habilitadas del holding (propias y global) y
	 * el del agente. Cada cliente se filtra después con el suyo: antes solo contaba el del agente y lo que se guardaba por cliente
	 * no tenía efecto.
	 */
	private async getMaxDaysBeforeIssue(holdingId: string, defaultDays: number): Promise<number> {
		const rows = await this.dataSource.query(
			`SELECT MAX((config_json->>'days_before_issue')::int) AS max_days
			FROM client_agent_configs
			WHERE holding_id = $1 AND agent_type = 'proforma' AND is_enabled = true AND config_json->>'days_before_issue' ~ '^[0-9]+$'`,
			[holdingId]
		);

		return Math.max(defaultDays, Number(rows?.[0]?.max_days) || 0);
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
