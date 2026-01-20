import Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { ClaudeMessage, ConversationContext } from './interfaces/claude-response.interface';
import { SkillExecutionContext, SkillExecutionResult, Widget } from './interfaces/skill.interface';
import { getAllSkills, getSkillByName } from './skills/catalog';
import { DynamicQueryBuilder } from './skills/query-builder';
import { SkillDefinition } from './skills/skill-definition.interface';
import { SkillExecutor } from './skills/skill-executor';

@Injectable()
export class ClaudeService {
	private readonly logger = new Logger(ClaudeService.name);
	private readonly client: Anthropic;
	private readonly model = 'claude-sonnet-4-20250514';

	constructor(
		private readonly configService: ConfigService,
		private readonly dataSource: DataSource,
		private readonly queryBuilder: DynamicQueryBuilder,
		private readonly skillExecutor: SkillExecutor
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

			const skills = useSkills ? this.getActiveSkills() : [];
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
					input_schema: {
						type: 'object',
						properties: skill.parameters.schema,
						required: skill.parameters.required,
					},
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

					console.log('🔧 ClaudeService - Skill ejecutada:', (toolUse as any).name);
					console.log('🔧 ClaudeService - Parámetros:', (toolUse as any).input);
					console.log('🔧 ClaudeService - Resultado:', result);
					console.log('🔧 ClaudeService - Widgets en resultado:', (result as any).widgets);

					if ((result as any).success && (result as any).widgets) {
						console.log('✅ ClaudeService - Agregando widgets:', (result as any).widgets);
						allWidgets.push(...(result as any).widgets);
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

	private getActiveSkills(): SkillDefinition[] {
		return getAllSkills();
	}

	private async executeSkill(context: SkillExecutionContext): Promise<SkillExecutionResult> {
		const skill = getSkillByName(context.skill_name);

		if (!skill) {
			return {
				success: false,
				error: `Skill '${context.skill_name}' no encontrada`,
			};
		}

		return await this.skillExecutor.executeSkill(skill, {
			skillName: context.skill_name,
			parameters: context.parameters,
			holdingId: context.holding_id,
		});
	}
}
