import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { DataSource } from 'typeorm';

import { ClaudeService } from '@/modules/claude/claude.service';

import { CopilotContext, CopilotMessage, CopilotResponse, CopilotSession } from './interfaces/copilot-message.interface';

@Injectable()
export class SapiraCopilotService {
	private readonly logger = new Logger(SapiraCopilotService.name);

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource,
		private readonly claudeService: ClaudeService
	) {}

	async sendMessage(message: string, holdingId: string, context?: CopilotContext, accessToken?: string): Promise<CopilotResponse> {
		try {
			const messages: CopilotMessage[] = context?.messages || [];
			messages.push({
				role: 'user',
				content: message,
				timestamp: new Date(),
			});

			const systemPrompt = this.buildSystemPrompt(context?.context);

			const claudeContext = {
				conversation_id: context?.session_id,
				messages: messages.map((msg) => ({
					role: msg.role,
					content: msg.content,
				})),
				system_prompt: systemPrompt,
			};

			const result = await this.claudeService.sendMessage(message, holdingId, claudeContext, true, accessToken);

			const widgets = (result as any).widgets || [];

			return {
				response: result.response,
				session_id: context?.session_id,
				usage: result.usage,
				widgets,
			};
		} catch (error) {
			this.logger.error('Error al enviar mensaje al copilot:', error);
			throw new BadRequestException(`Error al comunicarse con el copilot: ${error.message}`);
		}
	}

	async resolveHoldingId(accessToken: string): Promise<string | undefined> {
		const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
		const anonKey = this.configService.get<string>('SUPABASE_ANON_KEY');
		if (!supabaseUrl || !anonKey) {
			throw new BadRequestException('Falta configuración de Supabase para aplicar RLS (SUPABASE_URL / SUPABASE_ANON_KEY).');
		}

		const rlsClient = createClient(supabaseUrl, anonKey, {
			global: {
				headers: {
					Authorization: `Bearer ${accessToken}`,
				},
			},
			auth: {
				persistSession: false,
				autoRefreshToken: false,
				detectSessionInUrl: false,
			},
		});

		const { data, error } = await rlsClient.from('user_holdings').select('holding_id').limit(1).single();
		if (error) {
			this.logger.warn(`resolveHoldingId: no pude leer user_holdings con RLS. Motivo: ${String((error as any)?.message || error)}`);
			return undefined;
		}

		return (data as any)?.holding_id;
	}

	async createSession(name: string, holdingId: string, description?: string): Promise<CopilotSession> {
		try {
			const result = await this.dataSource.query(
				`INSERT INTO copilot_sessions (name, description, holding_id, created_at, updated_at)
				 VALUES ($1, $2, $3, NOW(), NOW())
				 RETURNING *`,
				[name, description, holdingId]
			);

			return this.mapSessionFromDb(result[0]);
		} catch (error) {
			this.logger.error('Error al crear sesión de copilot:', error);
			throw new BadRequestException(`Error al crear sesión: ${error.message}`);
		}
	}

	async getSessionById(sessionId: string, holdingId: string): Promise<CopilotSession> {
		const query = `SELECT * FROM copilot_sessions WHERE session_id = $1 AND holding_id = $2 LIMIT 1`;
		const params: any[] = [sessionId, holdingId];

		const result = await this.dataSource.query(query, params);

		if (!result || result.length === 0) {
			throw new NotFoundException('Sesión no encontrada');
		}

		return this.mapSessionFromDb(result[0]);
	}

	async listSessions(holdingId: string): Promise<CopilotSession[]> {
		const query = `SELECT * FROM copilot_sessions WHERE holding_id = $1 ORDER BY updated_at DESC`;
		const params: any[] = [holdingId];

		const results = await this.dataSource.query(query, params);

		return results.map((row: any) => this.mapSessionFromDb(row));
	}

	async updateSession(sessionId: string, updates: { name?: string; description?: string }, holdingId: string): Promise<CopilotSession> {
		await this.getSessionById(sessionId, holdingId);

		const updateFields: string[] = [];
		const updateValues: any[] = [];
		let paramIndex = 1;

		if (updates.name !== undefined) {
			updateFields.push(`name = $${paramIndex}`);
			updateValues.push(updates.name);
			paramIndex++;
		}

		if (updates.description !== undefined) {
			updateFields.push(`description = $${paramIndex}`);
			updateValues.push(updates.description);
			paramIndex++;
		}

		if (updateFields.length === 0) {
			return this.getSessionById(sessionId, holdingId);
		}

		updateFields.push(`updated_at = NOW()`);
		updateValues.push(sessionId);

		const query = `UPDATE copilot_sessions SET ${updateFields.join(', ')} WHERE session_id = $${paramIndex} AND holding_id = $${paramIndex + 1}`;
		const params = [...updateValues, holdingId];

		await this.dataSource.query(query, params);

		return this.getSessionById(sessionId, holdingId);
	}

	async deleteSession(sessionId: string, holdingId: string): Promise<void> {
		await this.getSessionById(sessionId, holdingId);

		const query = `DELETE FROM copilot_sessions WHERE session_id = $1 AND holding_id = $2`;
		const params: any[] = [sessionId, holdingId];

		await this.dataSource.query(query, params);
	}

	private buildSystemPrompt(context?: string): string {
		let prompt = `Eres Sapira Copilot, un asistente financiero especializado en métricas SaaS y análisis de ingresos recurrentes.

Tu objetivo es ayudar a usuarios a consultar y analizar:
- MRR (Monthly Recurring Revenue) y ARR (Annual Recurring Revenue)
- Métricas SaaS: Churn, NDR, Growth Rate, Quick Ratio
- Facturas, contratos, clientes y cotizaciones
- Ingresos reconocidos, diferidos y por facturar

Cuando el usuario pida datos numéricos, históricos o métricas, DEBES usar las skills disponibles.
NO inventes números ni cifras. Si no tienes una skill para responder, indícalo claramente.

Genera respuestas en lenguaje natural, concisas y accionables.
Solo solicita/genera widgets (tablas, gráficos o KPIs) si el usuario lo pide explícitamente.
Si el usuario pide gráficos/tablas/widgets, NO los describas: DEBES llamar una skill y devolver widgets reales.
Para MRR:
- Si el usuario pide "MRR actual", "MRR este mes" o "MRR del último mes", llama get_mrr_series con mode="snapshot".
- Si el usuario pide "MRR últimos X meses" o un rango, llama get_mrr_series con mode="series".
Cuando el usuario pida widgets (ej: "genéralos", "genera los gráficos", "arma la tabla", "muéstrame el gráfico"), debes llamar la misma skill nuevamente con include_widgets=true.`;

		if (context) {
			prompt += `\n\nContexto adicional:\n${context}`;
		}

		return prompt;
	}

	private mapSessionFromDb(row: any): CopilotSession {
		return {
			session_id: row.session_id,
			name: row.name,
			description: row.description,
			holding_id: row.holding_id,
			created_at: row.created_at,
			updated_at: row.updated_at,
		};
	}
}
