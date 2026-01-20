export interface Skill {
	name: string;
	description: string;
	input_schema: {
		type: 'object';
		properties: Record<string, any>;
		required?: string[];
	};
}

export interface SkillExecutionContext {
	skill_name: string;
	parameters: Record<string, any>;
	user_id?: string;
	holding_id: string;
	access_token?: string;
}

export type Widget =
	| { type: 'kpi'; title: string; value: string; subtitle?: string }
	| { type: 'image'; title: string; url: string; alt?: string }
	| { type: 'table'; title: string; columns: string[]; rows: Array<Array<string | number | null>> }
	| {
			type: 'chart_line';
			title: string;
			xKey: string;
			series: Array<{ key: string; name: string; color?: string }>;
			data: Array<Record<string, string | number | null>>;
	  }
	| {
			type: 'chart_bar';
			title: string;
			xKey: string;
			series: Array<{ key: string; name: string; color?: string }>;
			data: Array<Record<string, string | number | null>>;
	  };

export interface SkillExecutionResult {
	success: boolean;
	data?: {
		widgets?: Widget[];
		summary?: string;
		[key: string]: any;
	};
	error?: string;
}
