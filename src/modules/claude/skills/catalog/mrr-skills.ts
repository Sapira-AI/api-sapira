import { SkillDefinition } from '../skill-definition.interface';

export const GET_MRR_SKILL: SkillDefinition = {
	name: 'get_mrr',
	description: `Obtiene el MRR (Monthly Recurring Revenue) para uno o múltiples períodos.
	
Usar esta skill cuando el usuario pregunte por:
- "MRR de este mes" o "MRR actual" (usar mode=snapshot)
- "MRR últimos X meses" (usar mode=series con months_back=X)
- "MRR por compañía" (agregar group_by=company)
- "MRR por moneda" (agregar group_by=currency)
- "MRR por cliente" (agregar group_by=client)
- "MRR en moneda del sistema" (usar currency_mode=system)
- "MRR por moneda de contrato" (usar currency_mode=contract)

El MRR se calcula sumando valores de mrr_legacy y revenue_schedule_monthly para cada período.`,

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'group_by', 'currency_mode', 'company_id', 'client_id', 'include_widgets'],
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
				description: 'Agrupar por: company, client, currency, product, momentum',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'client', 'currency', 'product', 'momentum'],
				},
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato), company (moneda de la compañía)',
				enum: ['system', 'contract', 'company'],
			},
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			client_id: {
				type: 'string',
				description: 'Filtrar por ID de cliente específico',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly'],
		baseQuery: `
			SELECT 
				period_month,
				{{GROUP_BY_COLUMNS}}
				SUM(mrr_value) as mrr
			FROM (
				-- MRR Legacy
				SELECT 
					period_month,
					company_id::text,
					client_id::text,
					contract_currency as currency,
					product_name,
					momentum,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true
				
				UNION ALL
				
				-- Revenue Schedule Monthly
				SELECT 
					period_month,
					company_id::text,
					contract_id::text as client_id,
					contract_currency as currency,
					product_name,
					momentum,
					{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly
				WHERE {{WHERE_CLAUSE}} AND is_total_row = false
			) combined_mrr
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
			client_id: {
				column: 'client_id',
				operator: '=',
				parameterName: 'client_id',
			},
		},
		groupBy: ['period_month'],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'line',
			title: 'Evolución de MRR',
			xAxis: 'period_month',
			yAxis: 'mrr',
			format: {
				mrr: 'currency',
			},
		},
	},
};

export const GET_MRR_BY_COMPANY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_company',
	description: `Obtiene el MRR agrupado por compañía para un período específico o rango de períodos.
	
Usar cuando el usuario pregunte por:
- "MRR por compañía este mes"
- "MRR por compañía últimos X meses"
- "Desglose de MRR por empresa"`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD',
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte',
				enum: ['system', 'contract', 'company'],
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'companies'],
		baseQuery: `
			SELECT 
				c.legal_name as company_name,
				c.id as company_id,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT 
					period_month,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true
				
				UNION ALL
				
				SELECT 
					period_month,
					company_id,
					{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly
				WHERE {{WHERE_CLAUSE}} AND is_total_row = false
			) combined_mrr
			JOIN companies c ON c.id = combined_mrr.company_id
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
		},
		groupBy: ['c.legal_name', 'c.id', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'MRR por Compañía',
			columns: ['company_name', 'period_month', 'mrr'],
			format: {
				mrr: 'currency',
				period_month: 'date',
			},
		},
	},
};

export const GET_MRR_BY_CURRENCY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_currency',
	description: `Obtiene el MRR agrupado por moneda de contrato.
	
Usar cuando el usuario pregunte por:
- "MRR por moneda"
- "MRR este mes por moneda de contrato"
- "Desglose de MRR por divisa"`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
			},
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly'],
		baseQuery: `
			SELECT 
				contract_currency as currency,
				period_month,
				SUM(mrr_value) as mrr_contract_currency,
				SUM(mrr_value_system) as mrr_system_currency
			FROM (
				SELECT 
					period_month,
					contract_currency,
					mrr_legacy as mrr_value,
					mrr_legacy_system_currency as mrr_value_system
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true
				
				UNION ALL
				
				SELECT 
					period_month,
					contract_currency,
					mrr_period_contract_ccy as mrr_value,
					mrr_period_system_ccy as mrr_value_system
				FROM revenue_schedule_monthly
				WHERE {{WHERE_CLAUSE}} AND is_total_row = false
			) combined_mrr
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
		},
		groupBy: ['contract_currency', 'period_month'],
		orderBy: ['period_month ASC', 'mrr_contract_currency DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'MRR por Moneda',
			columns: ['currency', 'period_month', 'mrr_contract_currency', 'mrr_system_currency'],
			format: {
				mrr_contract_currency: 'currency',
				mrr_system_currency: 'currency',
				period_month: 'date',
			},
		},
	},
};

export const MRR_SKILLS = [GET_MRR_SKILL, GET_MRR_BY_COMPANY_SKILL, GET_MRR_BY_CURRENCY_SKILL];
