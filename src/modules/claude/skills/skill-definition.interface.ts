export interface SkillParameter {
	type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
	description: string;
	default?: any;
	enum?: string[] | number[];
	items?: SkillParameter;
	properties?: SkillParametersSchema;
}

export interface SkillParametersSchema {
	[key: string]: SkillParameter;
}

export interface DatabaseFilter {
	column: string;
	operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'IN' | 'NOT IN' | 'LIKE' | 'ILIKE' | 'IS NULL' | 'IS NOT NULL';
	parameterName: string;
}

export interface SkillDatabase {
	tables: string[];
	baseQuery: string;
	filters: {
		[parameterName: string]: DatabaseFilter;
	};
	groupBy?: string[];
	orderBy?: string[];
}

export interface WidgetConfig {
	type: 'line' | 'bar' | 'pie' | 'table' | 'kpi' | 'area';
	title?: string;
	xAxis?: string;
	yAxis?: string;
	columns?: string[];
	format?: {
		[key: string]: 'currency' | 'number' | 'percentage' | 'date';
	};
}

export interface SkillResponse {
	type: 'chart' | 'table' | 'kpi' | 'text';
	widgetConfig?: WidgetConfig;
}

export interface SkillDefinition {
	name: string;
	description: string;
	parameters: {
		required: string[];
		optional: string[];
		schema: SkillParametersSchema;
	};
	database: SkillDatabase;
	response: SkillResponse;
}

export interface SkillExecutionContext {
	skillName: string;
	parameters: any;
	holdingId: string;
}

export interface SkillExecutionResult {
	success: boolean;
	data?: any;
	widgets?: any[];
	message?: string;
	error?: string;
}
