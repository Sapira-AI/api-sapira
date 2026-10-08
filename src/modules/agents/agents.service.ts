import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { rowsOf } from '@/core/utils/query-rows';

import { EmailsService } from '../emails/emails.service';

import { ListRunsQueryDto } from './dtos/list-runs.dto';
import { stripHtml } from './helpers/template.helper';
import { ApproveResponse, RunResponse } from './interfaces/run-response.interface';
import { CollectionsProcessor } from './processors/collections.processor';
import { ProformaProcessor } from './processors/proforma.processor';

@Injectable()
export class AgentsService {
	private readonly logger = new Logger(AgentsService.name);

	constructor(
		private readonly dataSource: DataSource,
		private readonly proformaProcessor: ProformaProcessor,
		private readonly collectionsProcessor: CollectionsProcessor,
		private readonly emailsService: EmailsService
	) {}

	async runAgent(agentId: string, mode: 'preview' | 'execute', holdingId: string): Promise<RunResponse> {
		const agent = await this.getAgent(agentId, holdingId);

		if (!agent.is_enabled) {
			throw new BadRequestException('El agente está deshabilitado');
		}

		const run = await this.createRun(agentId, holdingId);
		const globalConfig = await this.getAgentConfigs(agentId);

		let messages = [];
		let stats = {
			messages_created: 0,
			clients_processed: 0,
			clients_skipped: 0,
			errors: 0,
		};

		try {
			if (agent.type === 'proforma') {
				const result = await this.proformaProcessor.process(agent, globalConfig, run.id, holdingId, mode);
				messages = result.messages;
				stats = result.stats;
			} else if (agent.type === 'collections') {
				const result = await this.collectionsProcessor.process(agent, globalConfig, run.id, holdingId, mode);
				messages = result.messages;
				stats = result.stats;
			}
		} catch (error) {
			await this.updateRunStatus(run.id, 'error', { error: error.message });
			throw error;
		}

		// Preview no guarda mensajes: el run queda `cancelled` (con `mode: 'preview'`) para que nadie apruebe un run vacío.
		const status = mode === 'preview' ? 'cancelled' : agent.require_approval ? 'queued' : 'sent';

		if (status === 'sent') await this.sendMessages(run.id, messages);
		await this.updateRunStatus(run.id, status, mode === 'preview' ? { ...stats, mode } : stats);

		return {
			run_id: run.id,
			status,
			stats,
			messages: messages.map((m) => ({
				id: m.id,
				to: m.to,
				subject: m.subject,
				preview: m.body.substring(0, 100) + '...',
				client_id: m.meta_json.client_id,
				client_name: m.meta_json.client_name,
			})),
		};
	}

	/**
	 * Aprueba y envía un run `queued`. El paso a `approved` es atómico (`WHERE status = 'queued'`): dos aprobaciones simultáneas no
	 * envían dos veces. Guarda quién aprobó y conserva las estadísticas de la generación.
	 */
	async approveRun(runId: string, holdingId: string, approverUserId?: string | null): Promise<ApproveResponse> {
		const run = await this.getRun(runId, holdingId);

		if (run.status !== 'queued') {
			throw new ConflictException('Solo se puede aprobar una ejecución pendiente de aprobación');
		}

		const messages = await this.getRunMessages(runId);

		if (messages.length === 0) {
			throw new ConflictException('La ejecución no tiene mensajes para enviar');
		}

		const claimed = rowsOf(
			await this.dataSource.query(
				`UPDATE ai_runs SET status = 'approved', approver_user_id = $3 WHERE id = $1 AND holding_id = $2 AND status = 'queued' RETURNING id`,
				[runId, holdingId, approverUserId ?? null]
			)
		);

		if (!claimed.length) {
			throw new ConflictException('Solo se puede aprobar una ejecución pendiente de aprobación');
		}

		const results = await this.sendMessages(runId, messages);
		const status = results.success === 0 ? 'error' : 'sent';

		await this.updateRunStatus(runId, status, {
			...(run.stats_json ?? {}),
			messages_sent: results.success,
			send_errors: results.errors,
		});

		return {
			run_id: runId,
			status,
			messages_sent: results.success,
			messages_error: results.errors.length,
			total_messages: messages.length,
		};
	}

	async getClientConfig(clientId: string, agentType: string, holdingId: string) {
		const result = await this.dataSource.query(
			`
			SELECT 
				cac.*,
				c.name_commercial as client_name,
				esa.id as email_sender_id,
				esa.from_name as email_sender_from_name,
				esa.from_email as email_sender_from_email
			FROM client_agent_configs cac
			INNER JOIN clients c ON cac.client_id = c.id
			LEFT JOIN email_sender_addresses esa ON (cac.config_json->>'email_sender_address_id')::uuid = esa.id
			WHERE cac.client_id = $1 
			AND cac.agent_type = $2 
			AND cac.holding_id = $3
			LIMIT 1
		`,
			[clientId, agentType, holdingId]
		);

		if (result && result.length > 0) {
			const config = result[0];

			return {
				id: config.id,
				client_id: config.client_id,
				client_name: config.client_name,
				agent_type: config.agent_type,
				is_enabled: config.is_enabled,
				config_json: config.config_json,
				source: 'client' as const,
				email_sender: config.email_sender_id
					? {
							id: config.email_sender_id,
							from_name: config.email_sender_from_name,
							from_email: config.email_sender_from_email,
						}
					: null,
				created_at: config.created_at,
				updated_at: config.updated_at,
			};
		}

		const client = await this.assertClientInHolding(clientId, holdingId);
		const holdingConfig = await this.getHoldingConfig(holdingId, agentType);

		if (holdingConfig) {
			return {
				...holdingConfig,
				client_id: clientId,
				client_name: client.name_commercial ?? null,
			};
		}

		return null;
	}

	async updateClientConfig(
		clientId: string,
		agentType: string,
		holdingId: string,
		updates: { is_enabled?: boolean; config_json?: Record<string, any> }
	) {
		await this.assertClientInHolding(clientId, holdingId);

		if (updates.config_json?.email_sender_address_id) {
			await this.validateEmailSender(updates.config_json.email_sender_address_id, holdingId);
		}

		const existing = await this.dataSource.query(
			`SELECT id FROM client_agent_configs WHERE client_id = $1 AND agent_type = $2 AND holding_id = $3`,
			[clientId, agentType, holdingId]
		);

		if (existing && existing.length > 0) {
			await this.dataSource.query(
				`
				UPDATE client_agent_configs 
				SET 
					is_enabled = COALESCE($1, is_enabled),
					config_json = COALESCE($2, config_json),
					updated_at = NOW()
				WHERE client_id = $3 AND agent_type = $4 AND holding_id = $5
			`,
				[updates.is_enabled, updates.config_json ? JSON.stringify(updates.config_json) : null, clientId, agentType, holdingId]
			);
		} else {
			await this.dataSource.query(
				`
				INSERT INTO client_agent_configs (client_id, agent_type, holding_id, is_enabled, config_json)
				VALUES ($1, $2, $3, $4, $5)
			`,
				[clientId, agentType, holdingId, updates.is_enabled ?? true, JSON.stringify(updates.config_json ?? {})]
			);
		}

		return this.getClientConfig(clientId, agentType, holdingId);
	}

	async listClientConfigs(holdingId: string, agentType?: string) {
		let query = `
			SELECT 
				cac.*,
				c.name_commercial as client_name,
				esa.id as email_sender_id,
				esa.from_name as email_sender_from_name,
				esa.from_email as email_sender_from_email
			FROM client_agent_configs cac
			INNER JOIN clients c ON cac.client_id = c.id
			LEFT JOIN email_sender_addresses esa ON (cac.config_json->>'email_sender_address_id')::uuid = esa.id
			WHERE cac.holding_id = $1
		`;

		const params: any[] = [holdingId];

		if (agentType) {
			query += ` AND cac.agent_type = $2`;
			params.push(agentType);
		}

		query += ` ORDER BY c.name_commercial`;

		const results = await this.dataSource.query(query, params);

		return results.map((config: any) => ({
			id: config.id,
			client_id: config.client_id,
			client_name: config.client_name,
			agent_type: config.agent_type,
			is_enabled: config.is_enabled,
			config_json: config.config_json,
			source: 'client' as const,
			email_sender: config.email_sender_id
				? {
						id: config.email_sender_id,
						from_name: config.email_sender_from_name,
						from_email: config.email_sender_from_email,
					}
				: null,
			created_at: config.created_at,
			updated_at: config.updated_at,
		}));
	}

	async renderEmail(agentType: string, template: string, variables: Record<string, any>) {
		const { renderTemplate } = await import('./helpers/template.helper');
		const rendered_html = renderTemplate(template, variables);
		const rendered_text = stripHtml(rendered_html);

		return {
			rendered_html,
			rendered_text,
		};
	}

	async listEmailSenders(holdingId: string) {
		const results = await this.dataSource.query(
			`
			SELECT 
				esa.id,
				esa.from_name,
				esa.from_email,
				esa.reply_to_email,
				esa.is_default,
				esa.is_active,
				hess.sender_domain,
				hess.domain_status
			FROM email_sender_addresses esa
			INNER JOIN holding_email_sender_settings hess ON esa.domain_config_id = hess.id
			WHERE hess.holding_id = $1 
			AND esa.is_active = true
			AND hess.is_active = true
			ORDER BY esa.is_default DESC, esa.from_name
		`,
			[holdingId]
		);

		return results.map((sender: any) => ({
			id: sender.id,
			from_name: sender.from_name,
			from_email: sender.from_email,
			reply_to_email: sender.reply_to_email,
			is_default: sender.is_default,
			is_active: sender.is_active,
			sender_domain: sender.sender_domain,
			domain_status: sender.domain_status,
		}));
	}

	async getHoldingConfig(holdingId: string, agentType: string) {
		const result = await this.dataSource.query(
			`
			SELECT 
				cac.*
			FROM client_agent_configs cac
			WHERE cac.holding_id = $1 
			AND cac.agent_type = $2 
			AND cac.client_id IS NULL
			LIMIT 1
		`,
			[holdingId, agentType]
		);

		if (!result || result.length === 0) {
			return null;
		}

		const config = result[0];

		return {
			id: config.id,
			holding_id: config.holding_id,
			client_id: null,
			agent_type: config.agent_type,
			is_enabled: config.is_enabled,
			config_json: config.config_json,
			source: 'global' as const,
			created_at: config.created_at,
			updated_at: config.updated_at,
		};
	}

	async updateHoldingConfig(holdingId: string, agentType: string, updates: { is_enabled?: boolean; config_json?: Record<string, any> }) {
		if (updates.config_json?.email_sender_address_id) {
			await this.validateEmailSender(updates.config_json.email_sender_address_id, holdingId);
		}

		const existing = await this.dataSource.query(
			`SELECT id FROM client_agent_configs WHERE holding_id = $1 AND agent_type = $2 AND client_id IS NULL`,
			[holdingId, agentType]
		);

		if (existing && existing.length > 0) {
			await this.dataSource.query(
				`
				UPDATE client_agent_configs 
				SET 
					is_enabled = COALESCE($1, is_enabled),
					config_json = COALESCE($2, config_json),
					updated_at = NOW()
				WHERE holding_id = $3 AND agent_type = $4 AND client_id IS NULL
			`,
				[updates.is_enabled, updates.config_json ? JSON.stringify(updates.config_json) : null, holdingId, agentType]
			);
		} else {
			await this.dataSource.query(
				`
				INSERT INTO client_agent_configs (holding_id, agent_type, client_id, is_enabled, config_json)
				VALUES ($1, $2, NULL, $3, $4)
			`,
				[holdingId, agentType, updates.is_enabled ?? true, JSON.stringify(updates.config_json ?? {})]
			);
		}

		return this.getHoldingConfig(holdingId, agentType);
	}

	async updateAgentConfig(agentId: string, holdingId: string, updates: { schedule?: string; auto_execute?: boolean; require_approval?: boolean }) {
		const agent = await this.getAgent(agentId, holdingId);

		const updateFields: string[] = [];
		const updateValues: any[] = [];
		let paramIndex = 1;

		if (updates.schedule !== undefined) {
			updateFields.push(`schedule = $${paramIndex}`);
			updateValues.push(updates.schedule);
			paramIndex++;
		}

		if (updates.auto_execute !== undefined) {
			updateFields.push(`auto_execute = $${paramIndex}`);
			updateValues.push(updates.auto_execute);
			paramIndex++;
		}

		if (updates.require_approval !== undefined) {
			updateFields.push(`require_approval = $${paramIndex}`);
			updateValues.push(updates.require_approval);
			paramIndex++;
		}

		if (updateFields.length === 0) {
			return agent;
		}

		updateFields.push(`updated_at = NOW()`);
		updateValues.push(agentId, holdingId);

		await this.dataSource.query(
			`
			UPDATE ai_agents 
			SET ${updateFields.join(', ')}
			WHERE id = $${paramIndex} AND holding_id = $${paramIndex + 1}
		`,
			updateValues
		);

		return this.getAgent(agentId, holdingId);
	}

	/** Agentes del holding (uno por tipo; los crea el trigger `create_standard_agents_for_holding`). */
	async listAgents(holdingId: string) {
		return this.dataSource.query(
			`SELECT id, type, name, is_enabled, schedule, auto_execute, require_approval, created_at, updated_at
			FROM ai_agents
			WHERE holding_id = $1 AND type IN ('proforma', 'collections')
			ORDER BY type DESC, created_at`,
			[holdingId]
		);
	}

	/** Historial de ejecuciones, paginado (`{ data, total, currentPage, pages, limit }`), con el nombre y tipo del agente. */
	async listRuns(holdingId: string, query: ListRunsQueryDto) {
		const page = query.page ?? 1;
		const limit = query.limit ?? 20;
		const params: unknown[] = [holdingId];
		const where = ['r.holding_id = $1'];

		if (query.agent_id) {
			params.push(query.agent_id);
			where.push(`r.agent_id = $${params.length}`);
		}
		if (query.type) {
			params.push(query.type);
			where.push(`a.type = $${params.length}`);
		}
		if (query.status) {
			params.push(query.status);
			where.push(`r.status = $${params.length}`);
		}

		const from = `FROM ai_runs r INNER JOIN ai_agents a ON a.id = r.agent_id WHERE ${where.join(' AND ')}`;
		const [{ total }] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, params);
		const data = await this.dataSource.query(
			`SELECT r.id, r.agent_id, a.name AS agent_name, a.type AS agent_type, r.status, r.started_at, r.ended_at, r.stats_json,
				r.error_message, r.approver_user_id, r.created_at
			${from}
			ORDER BY r.started_at DESC NULLS LAST, r.created_at DESC
			LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
			[...params, limit, (page - 1) * limit]
		);

		return { data, total, currentPage: page, pages: Math.max(1, Math.ceil(total / limit)), limit };
	}

	/** Detalle de una ejecución del holding (404 si es de otro), con el nombre de quien aprobó. */
	async getRunDetail(runId: string, holdingId: string) {
		const rows = await this.dataSource.query(
			`SELECT r.id, r.agent_id, a.name AS agent_name, a.type AS agent_type, r.status, r.started_at, r.ended_at, r.stats_json,
				r.error_message, r.approver_user_id, u.name AS approver_name, r.created_at,
				(SELECT COUNT(*)::int FROM ai_messages m WHERE m.run_id = r.id) AS message_count
			FROM ai_runs r
			INNER JOIN ai_agents a ON a.id = r.agent_id
			LEFT JOIN users u ON u.id = r.approver_user_id
			WHERE r.id = $1 AND r.holding_id = $2
			LIMIT 1`,
			[runId, holdingId]
		);

		if (!rows?.length) throw new NotFoundException('Ejecución no encontrada');

		return rows[0];
	}

	/** Mensajes (salientes y entrantes) de una ejecución del holding. */
	async listRunMessages(runId: string, holdingId: string) {
		await this.getRun(runId, holdingId);

		return this.dataSource.query(
			`SELECT id, run_id, direction, channel, "to", subject, body, meta_json, created_at FROM ai_messages WHERE run_id = $1 ORDER BY created_at`,
			[runId]
		);
	}

	/** Descarta una ejecución pendiente de aprobación: no envía nada y sus mensajes no cuentan para la frecuencia de cobranza. */
	async cancelRun(runId: string, holdingId: string, userId?: string | null) {
		const rows = rowsOf(
			await this.dataSource.query(
				`UPDATE ai_runs SET status = 'cancelled', approver_user_id = $3, ended_at = NOW()
				WHERE id = $1 AND holding_id = $2 AND status = 'queued'
				RETURNING id, status`,
				[runId, holdingId, userId ?? null]
			)
		);

		if (rows.length) return rows[0];

		await this.getRun(runId, holdingId);
		throw new ConflictException('Solo se puede descartar una ejecución pendiente de aprobación');
	}

	/** Borra la configuración propia del cliente: desde ahí usa la configuración global del holding. */
	async deleteClientConfig(clientId: string, agentType: string, holdingId: string) {
		const rows = rowsOf(
			await this.dataSource.query(
				`DELETE FROM client_agent_configs WHERE client_id = $1 AND agent_type = $2 AND holding_id = $3 RETURNING id`,
				[clientId, agentType, holdingId]
			)
		);

		if (!rows.length) throw new NotFoundException('El cliente no tiene configuración propia para este agente');
	}

	/** Cuántos clientes tienen configuración propia (y cuántas habilitadas) por tipo, y qué clientes la tienen. */
	async clientConfigsSummary(holdingId: string) {
		const rows: Array<{ client_id: string; agent_type: 'proforma' | 'collections'; is_enabled: boolean }> = await this.dataSource.query(
			`SELECT client_id, agent_type, is_enabled FROM client_agent_configs WHERE holding_id = $1 AND client_id IS NOT NULL`,
			[holdingId]
		);
		const count = (type: string) => {
			const ofType = rows.filter((row) => row.agent_type === type);

			return { total: ofType.length, enabled: ofType.filter((row) => row.is_enabled).length };
		};

		return {
			proforma: count('proforma'),
			collections: count('collections'),
			client_ids: [...new Set(rows.map((row) => row.client_id))],
		};
	}

	private async assertClientInHolding(clientId: string, holdingId: string): Promise<{ id: string; name_commercial: string | null }> {
		const rows = await this.dataSource.query(`SELECT id, name_commercial FROM clients WHERE id = $1 AND holding_id = $2 LIMIT 1`, [
			clientId,
			holdingId,
		]);

		if (!rows?.length) throw new NotFoundException('Cliente no encontrado');

		return rows[0];
	}

	private async validateEmailSender(senderId: string, holdingId: string) {
		const result = await this.dataSource.query(
			`
			SELECT esa.id
			FROM email_sender_addresses esa
			INNER JOIN holding_email_sender_settings hess ON esa.domain_config_id = hess.id
			WHERE esa.id = $1 AND hess.holding_id = $2
			LIMIT 1
		`,
			[senderId, holdingId]
		);

		if (!result || result.length === 0) {
			throw new BadRequestException('Email sender address inválido');
		}
	}

	private async getAgent(agentId: string, holdingId: string) {
		const result = await this.dataSource.query(`SELECT * FROM ai_agents WHERE id = $1 AND holding_id = $2 LIMIT 1`, [agentId, holdingId]);

		if (!result || result.length === 0) {
			throw new NotFoundException('Agente no encontrado');
		}

		return result[0];
	}

	private async getAgentConfigs(agentId: string): Promise<Record<string, any>> {
		const results = await this.dataSource.query(`SELECT key, value_json FROM ai_agent_configs WHERE agent_id = $1`, [agentId]);

		const config: Record<string, any> = {};
		results?.forEach((c: any) => {
			config[c.key] = c.value_json;
		});

		return config;
	}

	private async createRun(agentId: string, holdingId: string) {
		const result = await this.dataSource.query(
			`INSERT INTO ai_runs (agent_id, holding_id, status, started_at) VALUES ($1, $2, $3, $4) RETURNING *`,
			[agentId, holdingId, 'queued', new Date().toISOString()]
		);

		return result[0];
	}

	private async sendMessages(runId: string, messages: any[]) {
		const results = { success: 0, errors: [] as any[] };

		for (const message of messages) {
			try {
				this.logger.log(`Enviando email a ${message.to} - ${message.subject}`);

				await this.emailsService.send({
					to: message.to,
					subject: message.subject,
					html: message.body,
					from: message.meta_json.from_email,
					fromName: message.meta_json.from_name,
					replyTo: message.meta_json.reply_to_email,
				});

				results.success++;
			} catch (error) {
				this.logger.error(`Error enviando email a ${message.to}:`, error);
				results.errors.push({
					message_id: message.id,
					error: error.message,
				});
			}
		}

		return results;
	}

	private async updateRunStatus(runId: string, status: string, stats: any) {
		await this.dataSource.query(`UPDATE ai_runs SET status = $1, stats_json = $2, ended_at = $3 WHERE id = $4`, [
			status,
			JSON.stringify(stats),
			new Date().toISOString(),
			runId,
		]);
	}

	private async getRun(runId: string, holdingId: string) {
		const result = await this.dataSource.query(`SELECT * FROM ai_runs WHERE id = $1 AND holding_id = $2 LIMIT 1`, [runId, holdingId]);

		if (!result || result.length === 0) {
			throw new NotFoundException('Run no encontrado');
		}

		return result[0];
	}

	private async getRunMessages(runId: string) {
		return await this.dataSource.query(`SELECT * FROM ai_messages WHERE run_id = $1 AND direction = 'out' ORDER BY created_at`, [runId]);
	}
}
