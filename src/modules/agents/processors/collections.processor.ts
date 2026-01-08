import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { calculateDaysOverdue, formatCurrency, renderTemplate } from '../helpers/template.helper';
import { CollectionsConfig, ReminderLevel } from '../interfaces/collections-config.interface';
import { ProcessorResult } from '../interfaces/run-response.interface';

@Injectable()
export class CollectionsProcessor {
	private readonly logger = new Logger(CollectionsProcessor.name);

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
			const maxDaysBeforeDue = await this.getMaxDaysBeforeDue(holdingId);
			const futureDate = new Date();
			futureDate.setDate(futureDate.getDate() + maxDaysBeforeDue);

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
				WHERE i.status IN ('Emitida', 'Vencida')
				AND i.due_date <= $1
				AND i.holding_id = $2
				ORDER BY cl.name_commercial, i.due_date
			`,
				[futureDate.toISOString(), holdingId]
			);

			const invoicesByClient = this.groupByClient(invoices);

			for (const [clientId, clientInvoices] of Object.entries(invoicesByClient)) {
				try {
					const effectiveConfig = await this.getEffectiveConfigForClient(clientId, 'collections', holdingId);

					if (!effectiveConfig || !effectiveConfig.reminder_levels) {
						stats.clients_skipped++;
						continue;
					}

					const sortedLevels = [...effectiveConfig.reminder_levels]
						.filter((level) => level.is_enabled !== false)
						.sort((a, b) => b.days_overdue - a.days_overdue);

					if (sortedLevels.length === 0) {
						stats.clients_skipped++;
						continue;
					}

					let levelToProcess: ReminderLevel | null = null;
					const invoicesForLevel: any[] = [];

					for (const invoice of clientInvoices as any[]) {
						const daysOverdue = calculateDaysOverdue(invoice.due_date);
						const dueDate = new Date(invoice.due_date);
						const now = new Date();
						const daysUntilDue = Math.ceil((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

						for (const level of sortedLevels) {
							let shouldApplyLevel = false;

							if (level.days_before_due && level.days_before_due > 0 && daysUntilDue > 0) {
								if (daysUntilDue <= level.days_before_due) {
									shouldApplyLevel = true;
								}
							} else if (daysOverdue >= level.days_overdue) {
								shouldApplyLevel = true;
							}

							if (shouldApplyLevel) {
								if (!levelToProcess || this.compareLevels(level, levelToProcess, daysOverdue) > 0) {
									levelToProcess = level;
								}
								invoicesForLevel.push(invoice);
								break;
							}
						}
					}

					if (levelToProcess && invoicesForLevel.length > 0) {
						const result = await this.processLevel(clientId, invoicesForLevel, levelToProcess, effectiveConfig, runId, holdingId, mode);
						messages.push(...result.messages);
						stats.messages_created += result.messages.length;
					}

					stats.clients_processed++;
				} catch (error) {
					stats.errors++;
					this.logger.error(`Error procesando cliente ${clientId}:`, error);
				}
			}
		} catch (error) {
			this.logger.error('Error en CollectionsProcessor:', error);
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

	private async processLevel(
		clientId: string,
		invoices: any[],
		level: ReminderLevel,
		config: CollectionsConfig,
		runId: string,
		holdingId: string,
		mode: string
	) {
		const messages = [];

		const shouldSend = await this.checkFrequency(clientId, level.level, level.frequency_hours);

		if (!shouldSend && mode === 'execute') {
			return { messages };
		}

		const emailSender = await this.getEffectiveEmailSender(config, holdingId);
		// Filtrar solo contactos de tipo 'cobranza'
		const contacts = await this.dataSource.query(`SELECT * FROM client_contacts WHERE client_id = $1 AND contact_type = $2`, [
			clientId,
			'Cobranza',
		]);

		// Enviar UN SOLO mensaje por cliente al contacto de cobranza
		if (contacts && contacts.length > 0) {
			const collectionContact = contacts[0]; // Usar el primer contacto de cobranza
			const message = await this.generateMessage(invoices, collectionContact, level, config, emailSender, runId, mode);
			messages.push(message);
		} else {
			// Si no hay contacto de cobranza, no enviar mensaje
			this.logger.warn(`Cliente ${clientId} no tiene contacto de tipo 'cobranza'. No se enviará mensaje.`);
		}

		return { messages };
	}

	private async checkFrequency(clientId: string, levelNumber: number, frequencyHours: number): Promise<boolean> {
		const lastMessage = await this.dataSource.query(
			`
			SELECT created_at 
			FROM ai_messages 
			WHERE meta_json->>'client_id' = $1 
			AND meta_json->>'reminder_level' = $2
			ORDER BY created_at DESC
			LIMIT 1
		`,
			[clientId, String(levelNumber)]
		);

		if (!lastMessage || lastMessage.length === 0) {
			return true;
		}

		const lastSent = new Date(lastMessage[0].created_at);
		const now = new Date();
		const hoursSince = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60);

		return hoursSince >= frequencyHours;
	}

	private compareLevels(level1: ReminderLevel, level2: ReminderLevel, daysOverdue: number): number {
		if (daysOverdue > 0) {
			return level1.days_overdue - level2.days_overdue;
		}

		if (level1.days_before_due && level2.days_before_due) {
			return level2.days_before_due - level1.days_before_due;
		}

		if (level1.days_before_due) return 1;
		if (level2.days_before_due) return -1;

		return 0;
	}

	private async getMaxDaysBeforeDue(holdingId: string): Promise<number> {
		const configs = await this.dataSource.query(
			`SELECT config_json FROM client_agent_configs WHERE agent_type = 'collections' AND holding_id = $1 AND is_enabled = true`,
			[holdingId]
		);

		let maxDays = 0;

		for (const config of configs) {
			const reminderLevels = config.config_json?.reminder_levels || [];
			for (const level of reminderLevels) {
				if (level.days_before_due && level.days_before_due > maxDays) {
					maxDays = level.days_before_due;
				}
			}
		}

		return maxDays;
	}

	private async getEffectiveConfigForClient(clientId: string, agentType: string, holdingId: string): Promise<CollectionsConfig | null> {
		const clientConfig = await this.dataSource.query(
			`SELECT * FROM client_agent_configs WHERE client_id = $1 AND agent_type = $2 AND holding_id = $3 LIMIT 1`,
			[clientId, agentType, holdingId]
		);

		if (clientConfig && clientConfig.length > 0) {
			if (!clientConfig[0].is_enabled) {
				return null;
			}
			return this.normalizeConfig(clientConfig[0].config_json);
		}

		const holdingConfig = await this.dataSource.query(
			`SELECT * FROM client_agent_configs WHERE client_id IS NULL AND agent_type = $1 AND holding_id = $2 LIMIT 1`,
			[agentType, holdingId]
		);

		if (holdingConfig && holdingConfig.length > 0) {
			if (!holdingConfig[0].is_enabled) {
				return null;
			}
			return this.normalizeConfig(holdingConfig[0].config_json);
		}

		return null;
	}

	private normalizeConfig(config: any): CollectionsConfig {
		if (!config.reminder_levels || !Array.isArray(config.reminder_levels) || config.reminder_levels.length === 0) {
			return {
				email_sender_address_id: config.email_sender_address_id,
				reminder_levels: [
					{
						level: 1,
						days_overdue: 30,
						frequency_hours: 168,
						is_enabled: true,
					},
					{
						level: 2,
						days_overdue: 60,
						frequency_hours: 168,
						is_enabled: true,
					},
				],
			};
		}

		return config as CollectionsConfig;
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

	private async generateMessage(
		invoices: any[],
		contact: any,
		level: ReminderLevel,
		config: CollectionsConfig,
		emailSender: any,
		runId: string,
		mode: string
	) {
		// Calcular total asegurando que sea un número válido
		const totalAmount = invoices.reduce((sum, inv) => {
			const amount = parseFloat(inv.total_invoice_currency) || 0;
			return sum + amount;
		}, 0);

		const firstInvoice = invoices[0];
		const daysOverdue = calculateDaysOverdue(firstInvoice.due_date);

		const variables = {
			client_name: firstInvoice.client_name || 'Cliente',
			contact_name: contact.name || 'Estimado/a',
			invoice_count: invoices.length.toString(),
			total_amount: formatCurrency(totalAmount, firstInvoice.invoice_currency || 'CLP'),
			invoices_table: this.generateInvoicesTable(invoices),
			// Variables adicionales para compatibilidad con templates personalizados
			invoice_number: firstInvoice.invoice_number || firstInvoice.folio || 'Sin número',
			amount: formatCurrency(parseFloat(firstInvoice.total_invoice_currency) || 0, firstInvoice.invoice_currency || 'CLP'),
			due_date: new Date(firstInvoice.due_date).toLocaleDateString('es-CL'),
			days_overdue: daysOverdue.toString(),
			holding_name: emailSender.from_name || 'Sapira',
		};

		const subject = renderTemplate(level.custom_subject || `Recordatorio de pago - {{client_name}}`, variables);

		const body = renderTemplate(level.custom_body || this.getDefaultTemplate(level.level), variables);

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
				client_id: invoices[0].client_id,
				client_name: invoices[0].client_name,
				reminder_level: level.level,
				days_overdue_threshold: level.days_overdue,
				days_before_due: level.days_before_due,
				invoice_count: invoices.length,
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

	private generateInvoicesTable(invoices: any[]): string {
		let table = '<table style="width:100%; border-collapse: collapse;">';
		table += '<thead><tr>';
		table += '<th style="border: 1px solid #ddd; padding: 8px;">Factura</th>';
		table += '<th style="border: 1px solid #ddd; padding: 8px;">Vencimiento</th>';
		table += '<th style="border: 1px solid #ddd; padding: 8px;">Días</th>';
		table += '<th style="border: 1px solid #ddd; padding: 8px;">Monto</th>';
		table += '</tr></thead><tbody>';

		for (const inv of invoices) {
			const daysOverdue = calculateDaysOverdue(inv.due_date);
			const invoiceNumber = inv.invoice_number || inv.folio || 'Sin número';
			const amount = parseFloat(inv.total_invoice_currency) || 0;

			table += '<tr>';
			table += `<td style="border: 1px solid #ddd; padding: 8px;">${invoiceNumber}</td>`;
			table += `<td style="border: 1px solid #ddd; padding: 8px;">${new Date(inv.due_date).toLocaleDateString('es-CL')}</td>`;
			table += `<td style="border: 1px solid #ddd; padding: 8px;">${daysOverdue}</td>`;
			table += `<td style="border: 1px solid #ddd; padding: 8px;">${formatCurrency(amount, inv.invoice_currency || 'CLP')}</td>`;
			table += '</tr>';
		}

		table += '</tbody></table>';
		return table;
	}

	private getDefaultTemplate(bucketLevel: number): string {
		if (bucketLevel === 1) {
			return `
				<p>Estimado/a {{contact_name}},</p>
				<p>Le recordamos que {{client_name}} tiene {{invoice_count}} factura(s) pendiente(s) de pago por un total de {{total_amount}}.</p>
				{{invoices_table}}
				<p>Agradecemos su pronta atención a este asunto.</p>
				<p>Saludos cordiales</p>
			`;
		} else {
			return `
				<p>Estimado/a {{contact_name}},</p>
				<p><strong>AVISO IMPORTANTE:</strong> {{client_name}} tiene {{invoice_count}} factura(s) con vencimiento considerable por un total de {{total_amount}}.</p>
				{{invoices_table}}
				<p>Le solicitamos regularizar esta situación a la brevedad posible.</p>
				<p>Atentamente</p>
			`;
		}
	}
}
