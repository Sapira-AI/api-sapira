import { SkillDefinition } from '../skill-definition.interface';

export const GET_RECOGNIZED_REVENUE_SKILL: SkillDefinition = {
	name: 'get_recognized_revenue',
	description: `Obtiene el revenue reconocido (recognized) para uno o múltiples períodos.
	
Usar esta skill cuando el usuario pregunte por:
- "Revenue reconocido este mes" o "Revenue actual"
- "Revenue reconocido últimos X meses"
- "Revenue por compañía"
- "Revenue por producto"
- "Ingresos reconocidos"

El revenue reconocido incluye tanto recurrente como no recurrente.`,

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'group_by', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			mode: {
				type: 'string',
				description: 'Modo de consulta: "snapshot" para último período, "series" para histórico',
				enum: ['snapshot', 'series'],
			},
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (solo para mode=series)',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto hoy)',
			},
			group_by: {
				type: 'array',
				description: 'Agrupar por: company, product',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'product'],
				},
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
				enum: ['system', 'contract'],
			},
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['revenue_schedule_monthly'],
		baseQuery: `
			SELECT 
				period_month,
				{{GROUP_BY_COLUMNS}}
				SUM({{RECOGNIZED_COLUMN}}) as recognized_revenue
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} AND is_total_row = false
		`,
		filters: {
			date_from: {
				column: 'period_month',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'period_month',
				operator: '<=',
				parameterName: 'date_to',
			},
			company_id: {
				column: 'company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['period_month'],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'line',
			title: 'Revenue Reconocido',
			xAxis: 'period_month',
			yAxis: 'recognized_revenue',
			format: {
				recognized_revenue: 'currency',
			},
		},
	},
};

export const GET_RECOGNIZED_NON_RECURRING_BY_CLIENT_SKILL: SkillDefinition = {
	name: 'get_recognized_non_recurring_by_client',
	description: `Obtiene el revenue reconocido no recurrente agrupado por cliente.
	
Usar esta skill cuando el usuario pregunte por:
- "Revenue no recurrente por cliente"
- "Ingresos no recurrentes por cliente"
- "Revenue one-time por cliente"

Filtra solo los items no recurrentes (is_recurring=false) y agrupa por cliente.`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto hoy)',
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
				enum: ['system', 'contract'],
			},
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['revenue_schedule_monthly', 'contract_items', 'contracts', 'clients'],
		baseQuery: `
			SELECT 
				cl.name_commercial as client_name,
				cl.id as client_id,
				period_month,
				SUM({{RECOGNIZED_COLUMN}}) as recognized_revenue
			FROM revenue_schedule_monthly rsm
			LEFT JOIN contract_items ci ON rsm.contract_item_id = ci.id
			LEFT JOIN contracts c ON rsm.contract_id = c.id
			LEFT JOIN clients cl ON c.client_id = cl.id
			WHERE {{WHERE_CLAUSE}} 
				AND rsm.is_total_row = false
				AND (ci.is_recurring = false OR ci.id IS NULL)
		`,
		filters: {
			date_from: {
				column: 'rsm.period_month',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'rsm.period_month',
				operator: '<=',
				parameterName: 'date_to',
			},
			company_id: {
				column: 'rsm.company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['cl.name_commercial', 'cl.id', 'period_month'],
		orderBy: ['period_month ASC', 'recognized_revenue DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Revenue No Recurrente por Cliente',
			columns: ['client_name', 'period_month', 'recognized_revenue'],
			format: {
				recognized_revenue: 'currency',
				period_month: 'date',
			},
		},
	},
};

export const GET_DEFERRED_BALANCE_SKILL: SkillDefinition = {
	name: 'get_deferred_balance',
	description: `Obtiene el balance diferido (deferred balance) al final del mes.
	
Usar esta skill cuando el usuario pregunte por:
- "Deferred balance fin de mes"
- "Balance diferido"
- "Ingresos diferidos"
- "Deferred revenue"

Muestra el saldo de ingresos diferidos al cierre de cada período.`,

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'group_by', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			mode: {
				type: 'string',
				description: 'Modo de consulta: "snapshot" para último período, "series" para histórico',
				enum: ['snapshot', 'series'],
			},
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (solo para mode=series)',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto hoy)',
			},
			group_by: {
				type: 'array',
				description: 'Agrupar por: company, product',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'product'],
				},
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
				enum: ['system', 'contract'],
			},
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['revenue_schedule_monthly'],
		baseQuery: `
			SELECT 
				period_month,
				{{GROUP_BY_COLUMNS}}
				SUM({{DEFERRED_COLUMN}}) as deferred_balance
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} AND is_total_row = false
		`,
		filters: {
			date_from: {
				column: 'period_month',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'period_month',
				operator: '<=',
				parameterName: 'date_to',
			},
			company_id: {
				column: 'company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['period_month'],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'line',
			title: 'Balance Diferido (Fin de Mes)',
			xAxis: 'period_month',
			yAxis: 'deferred_balance',
			format: {
				deferred_balance: 'currency',
			},
		},
	},
};

export const GET_UNBILLED_BALANCE_SKILL: SkillDefinition = {
	name: 'get_unbilled_balance',
	description: `Obtiene el balance no facturado (unbilled balance) al final del mes.
	
Usar esta skill cuando el usuario pregunte por:
- "Unbilled balance fin de mes"
- "Balance no facturado"
- "Ingresos por facturar"
- "Revenue pendiente de facturación"

Muestra el saldo de ingresos pendientes de facturar al cierre de cada período.`,

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'group_by', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			mode: {
				type: 'string',
				description: 'Modo de consulta: "snapshot" para último período, "series" para histórico',
				enum: ['snapshot', 'series'],
			},
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (solo para mode=series)',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto hoy)',
			},
			group_by: {
				type: 'array',
				description: 'Agrupar por: company, product',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'product'],
				},
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
				enum: ['system', 'contract'],
			},
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['revenue_schedule_monthly'],
		baseQuery: `
			SELECT 
				period_month,
				{{GROUP_BY_COLUMNS}}
				SUM({{UNBILLED_COLUMN}}) as unbilled_balance
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} AND is_total_row = false
		`,
		filters: {
			date_from: {
				column: 'period_month',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'period_month',
				operator: '<=',
				parameterName: 'date_to',
			},
			company_id: {
				column: 'company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['period_month'],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'line',
			title: 'Balance No Facturado (Fin de Mes)',
			xAxis: 'period_month',
			yAxis: 'unbilled_balance',
			format: {
				unbilled_balance: 'currency',
			},
		},
	},
};

export const REVENUE_SKILLS = [
	GET_RECOGNIZED_REVENUE_SKILL,
	GET_RECOGNIZED_NON_RECURRING_BY_CLIENT_SKILL,
	GET_DEFERRED_BALANCE_SKILL,
	GET_UNBILLED_BALANCE_SKILL,
];
