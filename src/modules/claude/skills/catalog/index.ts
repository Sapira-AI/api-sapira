import { SkillDefinition } from '../skill-definition.interface';

import { CMRR_MOMENTUM_SKILLS } from './cmrr-momentum-skills';
import { CONTRACT_SKILLS } from './contract-skills';
import { INVOICE_SKILLS } from './invoice-skills';
import { MRR_SKILLS } from './mrr-skills';
import { QUANTITY_VARIATION_SKILLS } from './quantity-variation-skills';
import { REVENUE_SKILLS } from './revenue-skills';

export const SKILLS_CATALOG: SkillDefinition[] = [
	...MRR_SKILLS,
	...INVOICE_SKILLS,
	...CONTRACT_SKILLS,
	...CMRR_MOMENTUM_SKILLS,
	...REVENUE_SKILLS,
	...QUANTITY_VARIATION_SKILLS,
];

export function getSkillByName(name: string): SkillDefinition | undefined {
	return SKILLS_CATALOG.find((skill) => skill.name === name);
}

export function getAllSkills(): SkillDefinition[] {
	return SKILLS_CATALOG;
}
