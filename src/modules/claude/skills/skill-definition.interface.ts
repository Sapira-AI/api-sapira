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
	type: 'line' | 'bar' | 'bar_stacked' | 'bar_horizontal' | 'bar_grouped' | 'pie' | 'table' | 'kpi' | 'area' | 'cohort_heatmap';
	title?: string;
	xAxis?: string;
	yAxis?: string;
	seriesKey?: string; // columna que define las series en bar_stacked/bar_grouped (e.g. 'company_name')
	columns?: string[];
	columnLabels?: { [key: string]: string };
	format?: {
		[key: string]: 'currency' | 'number' | 'percentage' | 'date' | 'month-year';
	};
}

export interface SkillResponse {
	type: 'chart' | 'table' | 'kpi' | 'text';
	widgetConfig?: WidgetConfig;
}

export interface SkillDefinition {
	name: string;
	description: string;
	emptyMessage?: string; // mensaje cuando la query retorna 0 resultados
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
