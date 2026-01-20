import { SkillDefinition } from '../skill-definition.interface';

import { MRR_SKILLS } from './mrr-skills';

export const SKILLS_CATALOG: SkillDefinition[] = [...MRR_SKILLS];

export function getSkillByName(name: string): SkillDefinition | undefined {
	return SKILLS_CATALOG.find((skill) => skill.name === name);
}

export function getAllSkills(): SkillDefinition[] {
	return SKILLS_CATALOG;
}
