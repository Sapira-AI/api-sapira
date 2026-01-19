import { SkillExecutionContext, SkillExecutionResult } from '../interfaces/skill.interface';

export class SkillExecutor {
	static async execute(context: SkillExecutionContext): Promise<SkillExecutionResult> {
		try {
			switch (context.skill_name) {
				default:
					return {
						success: false,
						error: `Skill '${context.skill_name}' no tiene implementación`,
					};
			}
		} catch (error) {
			return {
				success: false,
				error: error.message,
			};
		}
	}
}
