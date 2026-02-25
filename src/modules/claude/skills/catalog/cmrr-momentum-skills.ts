import { SkillDefinition } from '../skill-definition.interface';

export const GET_CMRR_SKILL: SkillDefinition = {
	name: 'get_cmrr',
	description: `Obtiene el CMRR (Committed Monthly Recurring Revenue) para uno o múltiples períodos.
	
INTENT: Consultar el MRR basado en fecha de booking (firma del contrato).
DIMENSIONES: período, compañía (opcional), producto (opcional).
WIDGET: Gráfico de barras (eje X = período MM/YYYY, eje Y = CMRR).

Usar esta skill cuando el usuario pregunte por:
- "CMRR de este mes" o "CMRR actual" (usar mode=snapshot)
- "CMRR últimos X meses" (usar mode=series con months_back=X)
- "CMRR por compañía" (agregar group_by=company)
- "CMRR por producto" (agregar group_by=product)
- "CMRR en moneda del sistema" (usar currency_mode=system)
- "CMRR por moneda de contrato" (usar currency_mode=contract)

El CMRR ya viene calculado en la tabla revenue_schedule_monthly.
NOTA: Si no hay datos de CMRR, puede ser que el holding no tenga contratos con fecha de booking configurada.`,

	emptyMessage: 'No hay datos de CMRR disponibles para el período solicitado. Esto puede ocurrir si el holding no tiene contratos con fecha de booking configurada, o si no hay datos de revenue_schedule_monthly cargados. Puedes intentar consultar el MRR en su lugar, que usa la fecha de inicio de servicio.',

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
				description: 'Agrupar por: company, product, currency',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'product', 'currency'],
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
				SUM({{CMRR_COLUMN}}) as cmrr
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
			type: 'bar',
			title: 'Evolución de CMRR (Moneda del Sistema)',
			xAxis: 'period_month',
			yAxis: 'cmrr',
			format: {
				cmrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_CMRR_BY_COMPANY_SKILL: SkillDefinition = {
	name: 'get_cmrr_by_company',
	description: `Obtiene el CMRR (Committed Monthly Recurring Revenue) desglosado por compañía.
	
INTENT: Ver distribución del CMRR por compañía.
DIMENSIONES: período, compañía.
WIDGET: Gráfico de barras apiladas (eje X = período, series = compañías).

Usar esta skill cuando el usuario pregunte por:
- "CMRR por compañía"
- "CMRR por empresa"
- "Distribución del CMRR por compañía"
- "Cuánto aporta cada compañía al CMRR"

NOTA: Si no hay datos de CMRR, puede ser que el holding no tenga contratos con fecha de booking configurada.`,

	emptyMessage: 'No hay datos de CMRR por compañía disponibles. Esto puede ocurrir si el holding no tiene contratos con fecha de booking configurada.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy',
				default: 6,
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
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
				enum: ['system', 'contract', 'company'],
				default: 'system',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['revenue_schedule_monthly', 'companies'],
		baseQuery: `
			SELECT 
				c.legal_name as company_name,
				rsm.period_month,
				SUM(rsm.cmrr_period_system_ccy) as cmrr
			FROM revenue_schedule_monthly rsm
			JOIN companies c ON c.id = rsm.company_id
			WHERE {{WHERE_CLAUSE}} AND rsm.is_total_row = false
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
		},
		groupBy: ['c.legal_name', 'rsm.period_month'],
		orderBy: ['rsm.period_month ASC', 'cmrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'CMRR por Compañía (Moneda del Sistema)',
			xAxis: 'period_month',
			yAxis: 'cmrr',
			seriesKey: 'company_name',
			format: {
				cmrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_MOMENTUM_SKILL: SkillDefinition = {
	name: 'get_mrr_momentum',
	description: `Obtiene los movimientos de MRR (momentum) para uno o múltiples períodos.
	
Usar esta skill cuando el usuario pregunte por:
- "MRR nuevo últimos X meses" (agregar momentum_type=NEW)
- "Upsell últimos X meses" (agregar momentum_type=UPSELL)
- "Cross-sell últimos X meses" (agregar momentum_type=CROSS-SELL)
- "Downsell últimos X meses" (agregar momentum_type=DOWNSELL)
- "Churn últimos X meses" (agregar momentum_type=CHURN)
- "Renewal últimos X meses" (agregar momentum_type=RENEWAL)
- "Reactivation últimos X meses" (agregar momentum_type=REACTIVATION)
- "Movimientos de MRR por producto" (agregar group_by=product)

Los valores de momentum disponibles son: NEW, UPSELL, CROSS-SELL, DOWNSELL, CHURN, RENEWAL, REACTIVATION, BOP.`,

	emptyMessage: 'No hay datos de momentum disponibles para el período solicitado. Esto puede ocurrir si el holding no tiene movimientos de MRR registrados en ese período.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'momentum_type', 'group_by', 'currency_mode', 'company_id', 'include_widgets'],
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
			momentum_type: {
				type: 'string',
				description: 'Tipo de momentum a filtrar',
				enum: ['NEW', 'UPSELL', 'CROSS-SELL', 'DOWNSELL', 'CHURN', 'RENEWAL', 'REACTIVATION', 'BOP'],
			},
			group_by: {
				type: 'array',
				description: 'Agrupar por: company, product, momentum',
				items: {
					type: 'string',
					description: 'Campo de agrupación',
					enum: ['company', 'product', 'momentum'],
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
				momentum,
				{{GROUP_BY_COLUMNS}}
				SUM({{MRR_COLUMN}}) as mrr
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} 
				AND is_total_row = false
				AND momentum IN ('NEW', 'UPSELL', 'CROSS-SELL', 'DOWNSELL', 'CHURN', 'RENEWAL', 'REACTIVATION')
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
			momentum_type: {
				column: 'momentum',
				operator: '=',
				parameterName: 'momentum_type',
			},
			company_id: {
				column: 'company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['period_month', 'momentum'],
		orderBy: ['period_month ASC', 'momentum ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar',
			title: 'Movimientos de MRR (Momentum)',
			xAxis: 'period_month',
			yAxis: 'mrr',
			format: {
				mrr: 'currency',
			},
		},
	},
};

export const GET_MRR_MOMENTUM_BY_PRODUCT_SKILL: SkillDefinition = {
	name: 'get_mrr_momentum_by_product',
	description: `Obtiene los movimientos de MRR (momentum) agrupados por producto.
	
Usar esta skill cuando el usuario pregunte por:
- "Upsell por producto últimos X meses"
- "Cross-sell por producto"
- "Downsell por producto"
- "Churn por producto"
- "Movimientos por producto"

Muestra el desglose de momentum (NEW, UPSELL, CROSS-SELL, DOWNSELL, CHURN, RENEWAL, REACTIVATION) por producto.`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'momentum_type', 'currency_mode', 'company_id', 'include_widgets'],
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
			momentum_type: {
				type: 'string',
				description: 'Tipo de momentum a filtrar (opcional, si no se especifica muestra todos)',
				enum: ['NEW', 'UPSELL', 'CROSS-SELL', 'DOWNSELL', 'CHURN', 'RENEWAL', 'REACTIVATION'],
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
				product_name,
				momentum,
				period_month,
				SUM({{MRR_COLUMN}}) as mrr
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} 
				AND is_total_row = false
				AND momentum IN ('NEW', 'UPSELL', 'CROSS-SELL', 'DOWNSELL', 'CHURN', 'RENEWAL', 'REACTIVATION')
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
			momentum_type: {
				column: 'momentum',
				operator: '=',
				parameterName: 'momentum_type',
			},
			company_id: {
				column: 'company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['product_name', 'momentum', 'period_month'],
		orderBy: ['period_month ASC', 'product_name ASC', 'momentum ASC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Movimientos de MRR por Producto',
			columns: ['product_name', 'momentum', 'period_month', 'mrr'],
			format: {
				mrr: 'currency',
				period_month: 'date',
			},
		},
	},
};

export const CMRR_MOMENTUM_SKILLS = [
	GET_CMRR_SKILL,
	GET_CMRR_BY_COMPANY_SKILL,
	GET_MRR_MOMENTUM_SKILL,
	GET_MRR_MOMENTUM_BY_PRODUCT_SKILL,
];
