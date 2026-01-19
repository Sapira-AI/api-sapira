import { Injectable, Logger } from '@nestjs/common';

import { SkillDefinition } from './skill-definition.interface';

@Injectable()
export class DynamicQueryBuilder {
	private readonly logger = new Logger(DynamicQueryBuilder.name);

	buildQuery(
		skill: SkillDefinition,
		params: any,
		holdingId: string
	): {
		query: string;
		values: any[];
	} {
		const { baseQuery, filters, groupBy, orderBy } = skill.database;

		const whereClauses: string[] = [`holding_id = $1`];
		const values: any[] = [holdingId];
		let paramIndex = 2;

		for (const [paramName, filterConfig] of Object.entries(filters)) {
			const paramValue = params[paramName];

			if (paramValue === undefined || paramValue === null) {
				continue;
			}

			const { column, operator } = filterConfig;

			if (operator === 'IN' || operator === 'NOT IN') {
				if (Array.isArray(paramValue) && paramValue.length > 0) {
					const placeholders = paramValue.map((_, idx) => `$${paramIndex + idx}`).join(', ');
					whereClauses.push(`${column} ${operator} (${placeholders})`);
					values.push(...paramValue);
					paramIndex += paramValue.length;
				}
			} else if (operator === 'IS NULL' || operator === 'IS NOT NULL') {
				if (paramValue === true) {
					whereClauses.push(`${column} ${operator}`);
				}
			} else {
				whereClauses.push(`${column} ${operator} $${paramIndex}`);
				values.push(paramValue);
				paramIndex++;
			}
		}

		let finalQuery = baseQuery.replaceAll('{{WHERE_CLAUSE}}', whereClauses.join(' AND '));

		if (groupBy && groupBy.length > 0) {
			finalQuery += ` GROUP BY ${groupBy.join(', ')}`;
		}

		if (orderBy && orderBy.length > 0) {
			finalQuery += ` ORDER BY ${orderBy.join(', ')}`;
		}

		this.logger.debug(`Query construida: ${finalQuery}`);
		this.logger.debug(`Valores: ${JSON.stringify(values)}`);

		return { query: finalQuery, values };
	}

	buildUnionQuery(queries: Array<{ query: string; values: any[] }>): { query: string; values: any[] } {
		const unionQuery = queries.map((q) => `(${q.query})`).join(' UNION ALL ');
		const allValues = queries.flatMap((q) => q.values);

		return { query: unionQuery, values: allValues };
	}
}
