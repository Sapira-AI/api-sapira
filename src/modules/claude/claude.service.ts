import Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DataSource } from 'typeorm';

import { ClaudeMessage, ConversationContext } from './interfaces/claude-response.interface';
import { Skill, SkillExecutionContext, SkillExecutionResult, Widget } from './interfaces/skill.interface';
import { monthStartStr, parseMonthRange } from './utils/date-parser.util';

@Injectable()
export class ClaudeService {
	private readonly logger = new Logger(ClaudeService.name);
	private readonly client: Anthropic;
	private readonly model = 'claude-sonnet-4-20250514';

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource,
		@Inject('SUPABASE_CLIENT') private readonly supabaseClient: SupabaseClient
	) {
		const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
		if (!apiKey) {
			this.logger.warn('ANTHROPIC_API_KEY no está configurada');
		}
		this.client = new Anthropic({
			apiKey: apiKey || '',
		});
	}

	async sendMessage(
		message: string,
		holdingId: string,
		context?: ConversationContext,
		useSkills: boolean = true,
		accessToken?: string
	): Promise<{ response: string; conversation_id?: string; usage: any; widgets?: Widget[] }> {
		try {
			const messages: ClaudeMessage[] = context?.messages || [];
			messages.push({
				role: 'user',
				content: message,
			});

			const skills = useSkills ? await this.getActiveSkills(holdingId) : [];
			const allWidgets: Widget[] = [];

			const requestParams: any = {
				model: this.model,
				max_tokens: 4096,
				messages: messages,
			};

			if (context?.system_prompt) {
				requestParams.system = context.system_prompt;
			}

			if (skills.length > 0) {
				requestParams.tools = skills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					input_schema: skill.input_schema,
				}));
			}

			let response = await this.client.messages.create(requestParams);

			while (response.stop_reason === 'tool_use') {
				const toolUseBlocks = response.content.filter((block: any) => block.type === 'tool_use');

				const toolResults = [];
				for (const toolUse of toolUseBlocks) {
					const result = await this.executeSkill({
						skill_name: (toolUse as any).name,
						parameters: (toolUse as any).input,
						holding_id: holdingId,
						access_token: accessToken,
					});

					if (result.success && result.data?.widgets) {
						allWidgets.push(...result.data.widgets);
					}

					toolResults.push({
						type: 'tool_result',
						tool_use_id: (toolUse as any).id,
						content: JSON.stringify(result),
					});
				}

				messages.push({
					role: 'assistant',
					content: response.content.map((block) => {
						if (block.type === 'text') {
							return {
								type: 'text',
								text: (block as any).text,
							};
						} else if (block.type === 'tool_use') {
							return {
								type: 'tool_use',
								id: (block as any).id,
								name: (block as any).name,
								input: (block as any).input,
							};
						}
						return block;
					}) as any,
				});

				messages.push({
					role: 'user',
					content: toolResults,
				});

				response = await this.client.messages.create({
					...requestParams,
					messages: messages,
				});
			}

			const textContent = response.content.find((block: any) => block.type === 'text');
			const responseText = (textContent as any)?.text || '';

			return {
				response: responseText,
				conversation_id: context?.conversation_id,
				usage: response.usage,
				widgets: allWidgets.length > 0 ? allWidgets : undefined,
			};
		} catch (error) {
			this.logger.error('Error al enviar mensaje a Claude:', error);
			throw new BadRequestException(`Error al comunicarse con Claude: ${error.message}`);
		}
	}

	async createSkill(name: string, description: string, inputSchema: any, holdingId: string): Promise<Skill> {
		const existing = await this.dataSource.query(
			`SELECT id FROM claude_skills WHERE name = $1 AND (holding_id = $2 OR holding_id IS NULL) LIMIT 1`,
			[name, holdingId]
		);

		if (existing && existing.length > 0) {
			throw new BadRequestException('Ya existe una skill con ese nombre');
		}

		const result = await this.dataSource.query(
			`INSERT INTO claude_skills (name, description, input_schema, holding_id, is_active, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
			 RETURNING *`,
			[name, description, JSON.stringify(inputSchema), holdingId, true]
		);

		return this.mapSkillFromDb(result[0]);
	}

	async updateSkill(skillId: string, updates: { description?: string; input_schema?: any }, holdingId: string): Promise<Skill> {
		const skill = await this.getSkillById(skillId, holdingId);

		const updateFields: string[] = [];
		const updateValues: any[] = [];
		let paramIndex = 1;

		if (updates.description !== undefined) {
			updateFields.push(`description = $${paramIndex}`);
			updateValues.push(updates.description);
			paramIndex++;
		}

		if (updates.input_schema !== undefined) {
			updateFields.push(`input_schema = $${paramIndex}`);
			updateValues.push(JSON.stringify(updates.input_schema));
			paramIndex++;
		}

		if (updateFields.length === 0) {
			return skill;
		}

		updateFields.push(`updated_at = NOW()`);
		updateValues.push(skillId);

		const query = `UPDATE claude_skills SET ${updateFields.join(', ')} WHERE id = $${paramIndex} AND holding_id = $${paramIndex + 1}`;
		const params = [...updateValues, holdingId];

		await this.dataSource.query(query, params);

		return this.getSkillById(skillId, holdingId);
	}

	async deleteSkill(skillId: string, holdingId: string): Promise<void> {
		await this.getSkillById(skillId, holdingId);

		const query = `DELETE FROM claude_skills WHERE id = $1 AND holding_id = $2`;
		const params: any[] = [skillId, holdingId];

		await this.dataSource.query(query, params);
	}

	async getSkillById(skillId: string, holdingId: string): Promise<Skill> {
		const query = `SELECT * FROM claude_skills WHERE id = $1 AND holding_id = $2 LIMIT 1`;
		const params: any[] = [skillId, holdingId];

		const result = await this.dataSource.query(query, params);

		if (!result || result.length === 0) {
			throw new NotFoundException('Skill no encontrada');
		}

		return this.mapSkillFromDb(result[0]);
	}

	async listSkills(holdingId: string): Promise<Skill[]> {
		const query = `SELECT * FROM claude_skills WHERE (holding_id = $1 OR holding_id IS NULL) ORDER BY name`;
		const params: any[] = [holdingId];

		const results = await this.dataSource.query(query, params);

		return results.map((row: any) => this.mapSkillFromDb(row));
	}

	async getActiveSkills(holdingId: string): Promise<Skill[]> {
		const query = `SELECT * FROM claude_skills WHERE is_active = true AND (holding_id = $1 OR holding_id IS NULL) ORDER BY name, created_at DESC`;
		const params: any[] = [holdingId];

		const results = await this.dataSource.query(query, params);
		const skills = results.map((row: any) => this.mapSkillFromDb(row));

		// Filtrar duplicados: mantener solo la primera ocurrencia de cada nombre
		const uniqueSkills = skills.filter((skill, index, self) => index === self.findIndex((s) => s.name === skill.name));

		return uniqueSkills;
	}

	async toggleSkill(skillId: string, isActive: boolean, holdingId: string): Promise<Skill> {
		await this.getSkillById(skillId, holdingId);

		const query = `UPDATE claude_skills SET is_active = $1, updated_at = NOW() WHERE id = $2 AND holding_id = $3`;
		const params: any[] = [isActive, skillId, holdingId];

		await this.dataSource.query(query, params);

		return this.getSkillById(skillId, holdingId);
	}

	private async executeSkill(context: SkillExecutionContext): Promise<SkillExecutionResult> {
		try {
			this.logger.log(`Ejecutando skill: ${context.skill_name}`);

			switch (context.skill_name) {
				case 'get_mrr_series':
					return await this.executeMrrSeries(context);

				case 'get_mrr_by_company':
					return await this.executeMrrByCompany(context);

				default:
					return {
						success: false,
						error: `Skill '${context.skill_name}' no implementada`,
					};
			}
		} catch (error) {
			this.logger.error(`Error ejecutando skill ${context.skill_name}:`, error);
			return {
				success: false,
				error: error.message,
			};
		}
	}

	private async executeMrrSeries(context: SkillExecutionContext): Promise<SkillExecutionResult> {
		const { question, months_back, include_widgets, mode } = context.parameters;
		const holdingId = context.holding_id;
		const supabase = this.getSupabaseClientForRls(context.access_token);

		const q = typeof question === 'string' ? question.toLowerCase() : '';
		const wantsWidgetsFromQuestion =
			q.includes('gener') ||
			q.includes('arm') ||
			q.includes('crea') ||
			q.includes('haz') ||
			q.includes('muestra') ||
			q.includes('gráfico') ||
			q.includes('grafico') ||
			q.includes('chart') ||
			q.includes('tabla') ||
			q.includes('table') ||
			q.includes('widget') ||
			q.includes('visual') ||
			q.includes('muéstr') ||
			q.includes('muestr');
		const wantsOnlyNumberFromQuestion = q.includes('solo') || q.includes('únicamente') || q.includes('unicamente');

		const includeWidgets: boolean =
			typeof include_widgets === 'boolean' ? include_widgets : wantsWidgetsFromQuestion && !wantsOnlyNumberFromQuestion;

		const isSnapshotRequested =
			mode === 'snapshot' ||
			q.includes('actual') ||
			q.includes('este mes') ||
			q.includes('mes actual') ||
			q.includes('último mes') ||
			q.includes('ultimo mes') ||
			q.includes('mrr actual');

		let dateFrom: string;
		let dateTo: string;
		let monthsBackValue: number;

		if (question && typeof question === 'string') {
			const parsed = parseMonthRange(question);
			dateFrom = parsed.fromMonth;
			dateTo = parsed.toMonth;
			monthsBackValue = parsed.monthsBack;
		} else if (months_back && typeof months_back === 'number') {
			monthsBackValue = months_back;
			const today = new Date();
			const toMonth = new Date(today);
			const fromMonth = new Date(toMonth);
			fromMonth.setMonth(fromMonth.getMonth() - (monthsBackValue - 1));
			dateFrom = monthStartStr(fromMonth);
			dateTo = monthStartStr(toMonth);
		} else {
			monthsBackValue = 6;
			const today = new Date();
			const toMonth = new Date(today);
			const fromMonth = new Date(toMonth);
			fromMonth.setMonth(fromMonth.getMonth() - (monthsBackValue - 1));
			dateFrom = monthStartStr(fromMonth);
			dateTo = monthStartStr(toMonth);
		}

		try {
			let rsmRows: any[] = [];
			let currency = 'SYSTEM';
			let rsmIncluded = false;

			const { data: rsmData, error: rsmError } = await supabase.rpc('rsm_metrics', {
				date_from: dateFrom,
				date_to: dateTo,
				metric: 'mrr',
				currency_mode: 'system',
				group_by: ['period_month'],
				filters: {},
			});
			if (rsmError) {
				const msg = String((rsmError as any)?.message || rsmError);
				if (msg.toLowerCase().includes('no holding_id for current user')) {
					this.logger.warn(
						`executeMrrSeries: rsm_metrics sin contexto de usuario (sin JWT). Continuando solo con mrr_legacy. Motivo: ${msg}`
					);
				} else {
					throw rsmError;
				}
			} else {
				rsmRows = Array.isArray(rsmData) ? (rsmData as any[]) : [];
				currency = (rsmRows[0] as any)?.currency || currency;
				rsmIncluded = true;
			}

			const { data: legacyData, error: legacyError } = await supabase
				.from('mrr_legacy')
				.select('period_month, mrr_legacy_system_currency')
				.eq('holding_id', holdingId)
				.eq('is_recurring', true)
				.gte('period_month', dateFrom)
				.lte('period_month', dateTo)
				.order('period_month');
			if (legacyError) throw legacyError;
			const monthKeyFromPeriod = (period: any): string => {
				const s = String(period || '');
				return `${s.slice(0, 7)}-01`;
			};

			const monthlyMrr = new Map<string, number>();

			if (rsmRows.length > 0) {
				rsmRows.forEach((r: any) => {
					const monthKey = monthKeyFromPeriod(r.period_month);
					monthlyMrr.set(monthKey, (monthlyMrr.get(monthKey) || 0) + (r.value || 0));
				});
			}

			(legacyData || []).forEach((r: any) => {
				const monthKey = monthKeyFromPeriod(r.period_month);
				monthlyMrr.set(monthKey, (monthlyMrr.get(monthKey) || 0) + (r.mrr_legacy_system_currency || 0));
			});

			const seriesData: Array<{ month: string; mrr: number }> = [];
			let y = Number(dateFrom.slice(0, 4));
			let m = Number(dateFrom.slice(5, 7));
			for (let i = 0; i < monthsBackValue; i++) {
				const mm = String(m).padStart(2, '0');
				const monthKey = `${y}-${mm}-01`;
				seriesData.push({
					month: `${y}-${mm}`,
					mrr: monthlyMrr.get(monthKey) || 0,
				});

				m += 1;
				if (m === 13) {
					m = 1;
					y += 1;
				}
			}

			const hasAnyValue = seriesData.some((r) => typeof r.mrr === 'number' && r.mrr !== 0);
			const handlerSummaryBase = `HANDLER: QA-01. ${rsmIncluded ? 'Incluye datos RSM y Legacy.' : 'Incluye solo Legacy (sin JWT para RSM).'} `;

			if (isSnapshotRequested) {
				const last = seriesData[seriesData.length - 1];
				const snapshotMonth = last?.month || dateTo.slice(0, 7);
				const snapshotMrr = last?.mrr ?? 0;

				const data: any = {
					month: snapshotMonth,
					mrr: snapshotMrr,
					currency,
					has_data: typeof snapshotMrr === 'number' && snapshotMrr !== 0,
					summary:
						typeof snapshotMrr === 'number' && snapshotMrr !== 0
							? `${handlerSummaryBase}MRR ${snapshotMonth}: ${snapshotMrr.toFixed(2)} ${currency}.`
							: `${handlerSummaryBase}No encontré MRR para ${snapshotMonth}.`,
				};

				if (includeWidgets) {
					data.widgets = [
						{
							type: 'kpi',
							title: `MRR ${snapshotMonth} (${currency})`,
							value: Number(snapshotMrr.toFixed(2)).toString(),
						},
					] as Widget[];
				}

				return {
					success: true,
					data,
				};
			}

			const data: any = {
				series: seriesData,
				currency,
				has_data: hasAnyValue,
				summary: hasAnyValue
					? `HANDLER: QA-01. MRR serie desde ${dateFrom} hasta ${dateTo}. ${handlerSummaryBase}`
					: `HANDLER: QA-01. No encontré datos de MRR para tu holding en el rango ${dateFrom}→${dateTo}. ${handlerSummaryBase}`,
			};

			if (includeWidgets) {
				data.widgets = [
					{
						type: 'chart_line',
						title: `MRR últimos ${monthsBackValue} meses (${currency})`,
						xKey: 'month',
						series: [{ key: 'mrr', name: 'MRR', color: '#3B82F6' }],
						data: seriesData,
					},
					{
						type: 'table',
						title: 'Detalle MRR por mes',
						columns: ['Mes', `MRR (${currency})`],
						rows: seriesData.map((r) => [r.month, Number(r.mrr.toFixed(2))]),
					},
				] as Widget[];
			}

			return {
				success: true,
				data,
			};
		} catch (error) {
			this.logger.error('Error en executeMrrSeries:', error);
			return {
				success: false,
				error: `HANDLER: QA-01. No pude consultar MRR en vivo (error en Live Data). Motivo: ${error.message}`,
			};
		}
	}

	private async executeMrrByCompany(context: SkillExecutionContext): Promise<SkillExecutionResult> {
		const { target_month } = context.parameters;
		const holdingId = context.holding_id;
		const supabase = this.getSupabaseClientForRls(context.access_token);

		const targetMonth = target_month || new Date().toISOString().slice(0, 10);

		try {
			const { data: rsmData, error: rsmError } = await supabase.rpc('rsm_metrics', {
				date_from: targetMonth,
				date_to: targetMonth,
				metric: 'mrr',
				currency_mode: 'system',
				group_by: ['company_id'],
				filters: { is_total_row: false },
			});
			if (rsmError) throw rsmError;

			const { data: legacyData, error: legacyError } = await supabase
				.from('mrr_legacy')
				.select('company_id, mrr_legacy_system_currency')
				.eq('holding_id', holdingId)
				.eq('is_recurring', true)
				.eq('period_month', targetMonth);
			if (legacyError) throw legacyError;

			const { data: companiesData, error: companiesError } = await supabase
				.from('companies')
				.select('id, legal_name')
				.eq('holding_id', holdingId);
			if (companiesError) throw companiesError;

			const companiesMap = new Map((companiesData || []).map((c: any) => [c.id, c.legal_name]));
			const companyMrr = new Map<string, number>();
			const currency = (rsmData?.[0] as any)?.currency || 'USD';

			(rsmData || []).forEach((r: any) => {
				if (r.company_id) {
					companyMrr.set(r.company_id, (companyMrr.get(r.company_id) || 0) + (r.value || 0));
				}
			});

			(legacyData || []).forEach((r: any) => {
				if (r.company_id) {
					companyMrr.set(r.company_id, (companyMrr.get(r.company_id) || 0) + (r.mrr_legacy_system_currency || 0));
				}
			});

			const chartData = Array.from(companyMrr.entries())
				.map(([companyId, mrr]) => ({
					company_name: companiesMap.get(companyId) || companyId,
					mrr: Number(mrr.toFixed(2)),
				}))
				.sort((a, b) => b.mrr - a.mrr);

			if (chartData.length === 0) {
				return {
					success: true,
					data: {
						companies: [],
						currency,
						has_data: false,
						widgets: [],
						summary: `No encontré datos de MRR por compañía para ${targetMonth.slice(0, 7)}.`,
					},
				};
			}

			const widgets: Widget[] = [
				{
					type: 'chart_bar',
					title: `MRR por Compañía (${targetMonth.slice(0, 7)})`,
					xKey: 'company_name',
					series: [{ key: 'mrr', name: 'MRR', color: '#10B981' }],
					data: chartData,
				},
				{
					type: 'table',
					title: 'Detalle MRR por compañía',
					columns: ['Compañía', `MRR (${currency})`],
					rows: chartData.map((r) => [r.company_name, r.mrr]),
				},
			];

			return {
				success: true,
				data: {
					companies: chartData,
					currency,
					has_data: true,
					widgets,
					summary: `MRR por compañía para ${targetMonth.slice(0, 7)}. ${chartData.length} compañías encontradas. Incluye datos de contratos activos y legacy.`,
				},
			};
		} catch (error) {
			return {
				success: false,
				error: `Error consultando MRR por compañía: ${error.message}`,
			};
		}
	}

	private mapSkillFromDb(row: any): Skill {
		return {
			name: row.name,
			description: row.description,
			input_schema: row.input_schema,
		};
	}

	async resolveUserHoldings(accessToken: string): Promise<string[]> {
		const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
		const anonKey = this.configService.get<string>('SUPABASE_ANON_KEY');
		if (!supabaseUrl || !anonKey) {
			throw new BadRequestException('Falta configuración de Supabase (SUPABASE_URL / SUPABASE_ANON_KEY).');
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

		const { data, error } = await rlsClient.from('user_holdings').select('holding_id');
		if (error) {
			this.logger.warn(`resolveUserHoldings error: ${error.message}`);
			return [];
		}

		return (data || []).map((row: any) => row.holding_id).filter(Boolean);
	}

	async validateUserHasAccessToHolding(accessToken: string, holdingId: string): Promise<boolean> {
		const userHoldings = await this.resolveUserHoldings(accessToken);
		return userHoldings.includes(holdingId);
	}

	private getSupabaseClientForRls(accessToken?: string): SupabaseClient {
		if (!accessToken) {
			return this.supabaseClient;
		}
		const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
		const anonKey = this.configService.get<string>('SUPABASE_ANON_KEY');
		if (!supabaseUrl || !anonKey) {
			return this.supabaseClient;
		}
		return createClient(supabaseUrl, anonKey, {
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
	}
}
