import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

	async sendMessage(message: string, holdingId: string, context?: CopilotContext): Promise<CopilotResponse> {
		try {
			const messages: CopilotMessage[] = context?.messages || []; // No se deben realizar tantas transformaciones de los mensjaes de contexto podemos podirle al front que los envie directamente en el formato que se requieren
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

			const result = await this.claudeService.sendMessage(message, holdingId, claudeContext, true);

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

REGLAS IMPORTANTES:

1. SIEMPRE usa las skills disponibles para obtener datos. NO inventes números ni cifras.

2. WIDGETS (Gráficos y Tablas):
   - SIEMPRE pasa include_widgets=true cuando el usuario pida:
     * Datos históricos o series temporales (ej: "MRR últimos 12 meses", "evolución de...", "tendencia de...")
     * Comparaciones o desgloses (ej: "MRR por compañía", "por cliente", "por segmento")
     * Cualquier pregunta que mencione "gráfico", "tabla", "chart", "visualización", "muéstrame"
   - SOLO omite widgets (include_widgets=false o sin especificar) para:
     * Preguntas puntuales de un solo valor (ej: "MRR actual", "cuánto es el MRR de este mes")
     * Preguntas conceptuales o de definición

3. Para MRR específicamente:
   - "MRR actual" o "MRR este mes" → get_mrr con mode="snapshot", include_widgets=false
   - "MRR últimos X meses" → get_mrr con mode="series", months_back=X, include_widgets=true
   - "MRR por [dimensión]" → skill correspondiente con include_widgets=true

4. Si el usuario pide explícitamente ver algo en gráfico/tabla DESPUÉS de ya haber mostrado datos en texto:
   - Llama la MISMA skill nuevamente con include_widgets=true
   - NO describas el gráfico, simplemente genera el widget

Genera respuestas concisas en lenguaje natural que acompañen los widgets cuando los generes.`;

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
