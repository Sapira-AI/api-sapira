import { SkillDefinition } from '../skill-definition.interface';

export const GET_MRR_SKILL: SkillDefinition = {
	name: 'get_mrr',
	description: `Obtiene el MRR (Monthly Recurring Revenue) para uno o múltiples períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Cada fila representa el MRR de ese período. Nunca sumar MRR de distintos meses.

Usar esta skill cuando el usuario pregunte por:
- "MRR de este mes" o "MRR actual" (usar mode=snapshot)
- "MRR últimos X meses" (usar mode=series con months_back=X)
- "MRR en moneda del sistema" (usar currency_mode=system)
- "MRR por moneda de contrato" (usar currency_mode=contract)

Para desglose por compañía usar get_mrr_by_company. Para desglose por cliente usar get_mrr_by_client. Para desglose por moneda usar get_mrr_by_currency.

El MRR se calcula sumando valores de mrr_legacy y revenue_schedule_monthly para cada período.`,

	emptyMessage: 'No se encontraron datos de MRR para el período indicado. Verifica que el holding tenga contratos activos con facturación recurrente.',

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'client_id', 'include_widgets'],
		schema: {
			mode: {
				type: 'string',
				description: 'Modo de consulta: "snapshot" para último período, "series" para histórico',
				enum: ['snapshot', 'series'],
			},
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (para obtener una serie temporal)',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto mes actual)',
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

				-- Revenue Schedule Monthly (JOIN con contracts para obtener client_id)
				SELECT
					rsm.period_month,
					rsm.company_id::text,
					c.client_id::text,
					rsm.contract_currency as currency,
					rsm.product_name,
					rsm.momentum,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
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
			type: 'bar',
			title: 'Evolución de MRR (Moneda del Sistema)',
			xAxis: 'period_month',
			yAxis: 'mrr',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_COMPANY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_company',
	description: `Obtiene el MRR agrupado por compañía para un período específico o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Cada fila representa el MRR de esa compañía en ese mes. Nunca sumar MRR de distintos meses para una misma compañía. Mostrar cada período de forma independiente.

Usar cuando el usuario pregunte por:
- "MRR por compañía este mes"
- "MRR por compañía últimos X meses"
- "Desglose de MRR por empresa"`,

	emptyMessage: 'No se encontraron datos de MRR por compañía para el período indicado. Intenta ampliar el rango de fechas.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (por ejemplo 6 para los últimos 6 meses)',
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
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Compañía',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'company_name',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_CURRENCY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_currency',
	description: `Obtiene el MRR agrupado por moneda de contrato.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

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
			columnLabels: {
				currency: 'Moneda',
				period_month: 'Período',
				mrr_contract_currency: 'MRR (Moneda Contrato)',
				mrr_system_currency: 'MRR (USD)',
			},
			format: {
				mrr_contract_currency: 'currency',
				mrr_system_currency: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_CLIENT_SKILL: SkillDefinition = {
	name: 'get_mrr_by_client',
	description: `Obtiene el MRR agrupado por cliente para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Cada fila representa el MRR de ese cliente en ese mes. Nunca sumar MRR de distintos meses para un mismo cliente. Mostrar cada período de forma independiente.

Usar cuando el usuario pregunte por:
- "MRR por cliente este mes"
- "MRR por cliente últimos X meses"
- "Desglose de MRR por cliente"
- "Qué clientes generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por cliente para el período indicado. Intenta ampliar el rango de fechas.',

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
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'clients'],
		baseQuery: `
			SELECT
				cl.name_commercial as client_name,
				cl.id as client_id,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					client_id,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					rsm.period_month,
					c.client_id,
					rsm.company_id,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
			) combined_mrr
			LEFT JOIN clients cl ON cl.id = combined_mrr.client_id
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
				column: 'combined_mrr.company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['cl.name_commercial', 'cl.id', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Cliente',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'client_name',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_ARR_SKILL: SkillDefinition = {
	name: 'get_arr',
	description: `Obtiene el ARR (Annual Recurring Revenue = MRR × 12) para uno o múltiples períodos.

IMPORTANTE: El ARR es un KPI de saldo anualizado (stock), NO se acumula entre períodos. Cada valor representa el ARR anualizado del período indicado.

Usar cuando el usuario pregunte por:
- "ARR actual" o "ARR de este mes"
- "ARR histórico" o "ARR últimos X meses"
- "Revenue anual recurrente"`,

	emptyMessage: 'No se encontraron datos de ARR para el período indicado.',

	parameters: {
		required: [],
		optional: ['mode', 'months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			mode: {
				type: 'string',
				description: 'Modo de consulta: "snapshot" para último período, "series" para histórico',
				enum: ['snapshot', 'series'],
			},
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
				description: 'Moneda para el reporte: system (USD), contract (moneda del contrato)',
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
		tables: ['mrr_legacy', 'revenue_schedule_monthly'],
		baseQuery: `
			SELECT
				period_month,
				SUM(mrr_value) as mrr,
				SUM(mrr_value) * 12 as arr
			FROM (
				SELECT
					period_month,
					company_id::text,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					period_month,
					company_id::text,
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
		},
		groupBy: ['period_month'],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'kpi',
		widgetConfig: {
			type: 'kpi',
			title: 'ARR (Annual Recurring Revenue)',
			columns: ['arr', 'mrr', 'period_month'],
			columnLabels: {
				arr: 'ARR',
				mrr: 'MRR',
				period_month: 'Período',
			},
			format: {
				arr: 'currency',
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_PRODUCT_SKILL: SkillDefinition = {
	name: 'get_mrr_by_product',
	description: `Obtiene el MRR agrupado por producto para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Cada fila representa el MRR de ese producto en ese mes. Nunca sumar MRR de distintos meses para un mismo producto.

Usar cuando el usuario pregunte por:
- "MRR por producto este mes"
- "MRR por producto últimos X meses"
- "Desglose de MRR por producto"
- "Qué productos generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por producto para el período indicado. Intenta ampliar el rango de fechas.',

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
		tables: ['mrr_legacy', 'revenue_schedule_monthly'],
		baseQuery: `
			SELECT
				COALESCE(product_name, 'Sin producto') as product_name,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					company_id,
					product_name,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					period_month,
					company_id,
					product_name,
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
		},
		groupBy: ['product_name', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Producto',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'product_name',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_ITEM_TYPE_SKILL: SkillDefinition = {
	name: 'get_mrr_by_item_type',
	description: `Obtiene el MRR agrupado por tipo de item (item_type) para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Solo incluye datos de revenue_schedule_monthly (mrr_legacy no tiene item_type).

Usar cuando el usuario pregunte por:
- "MRR por tipo de item"
- "MRR por item_type"
- "Desglose de MRR por tipo"`,

	emptyMessage: 'No se encontraron datos de MRR por tipo de item para el período indicado.',

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
		tables: ['revenue_schedule_monthly', 'contract_items'],
		baseQuery: `
			SELECT
				COALESCE(ci.item_type, 'Sin tipo') as item_type,
				rsm.period_month,
				SUM(rsm.{{MRR_COLUMN_RSM}}) as mrr
			FROM revenue_schedule_monthly rsm
			LEFT JOIN contract_items ci ON ci.id = rsm.contract_item_id
			WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
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
		groupBy: ['ci.item_type', 'rsm.period_month'],
		orderBy: ['rsm.period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Tipo de Item',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'item_type',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_MOMENTUM_SKILL: SkillDefinition = {
	name: 'get_mrr_by_momentum',
	description: `Obtiene el MRR agrupado por momentum (tipo de movimiento) para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos. Solo incluye datos de revenue_schedule_monthly (mrr_legacy siempre es EOP).

Valores de momentum: NEW, REACTIVATION, UPSELL, CROSS-SELL, DOWNSELL, CHURN, RENEWAL, BOP (Beginning of Period), EOP (End of Period).

Usar cuando el usuario pregunte por:
- "MRR por momentum"
- "MRR por tipo de movimiento"
- "Desglose de MRR por categoría de movimiento"
- "MRR nuevo vs upsell vs churn"`,

	emptyMessage: 'No se encontraron datos de MRR por momentum para el período indicado.',

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
				COALESCE(momentum, 'Sin momentum') as momentum,
				period_month,
				SUM({{MRR_COLUMN_RSM}}) as mrr
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
		groupBy: ['momentum', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Momentum',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'momentum',
			format: {
				mrr: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_MRR_BY_SEGMENT_SKILL: SkillDefinition = {
	name: 'get_mrr_by_segment',
	description: `Obtiene el MRR agrupado por segmento de cliente para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

Usar cuando el usuario pregunte por:
- "MRR por segmento"
- "MRR por segmento de cliente"
- "Desglose de MRR por segmento"
- "Qué segmentos generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por segmento para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: { type: 'integer', description: 'Cantidad de meses hacia atrás desde hoy' },
			date_from: { type: 'string', description: 'Fecha inicio en formato YYYY-MM-DD' },
			date_to: { type: 'string', description: 'Fecha fin en formato YYYY-MM-DD' },
			currency_mode: { type: 'string', description: 'Moneda: system (USD), contract, company', enum: ['system', 'contract', 'company'] },
			company_id: { type: 'string', description: 'Filtrar por ID de compañía específica' },
			include_widgets: { type: 'boolean', description: 'Si debe generar gráficos/tablas visuales' },
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'contracts', 'clients'],
		baseQuery: `
			SELECT
				COALESCE(cl.segment, 'Sin segmento') as segment,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					client_id,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					rsm.period_month,
					c.client_id,
					rsm.company_id,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
			) combined_mrr
			LEFT JOIN clients cl ON cl.id = combined_mrr.client_id
		`,
		filters: {
			date_from: { column: 'period_month', operator: '>=', parameterName: 'date_from' },
			date_to: { column: 'period_month', operator: '<=', parameterName: 'date_to' },
			company_id: { column: 'combined_mrr.company_id', operator: '=', parameterName: 'company_id' },
		},
		groupBy: ['cl.segment', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Segmento',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'segment',
			format: { mrr: 'currency', period_month: 'month-year' },
		},
	},
};

export const GET_MRR_BY_MARKET_SKILL: SkillDefinition = {
	name: 'get_mrr_by_market',
	description: `Obtiene el MRR agrupado por mercado del cliente para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

Usar cuando el usuario pregunte por:
- "MRR por mercado"
- "MRR por market"
- "Desglose de MRR por mercado"
- "Qué mercados generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por mercado para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: { type: 'integer', description: 'Cantidad de meses hacia atrás desde hoy' },
			date_from: { type: 'string', description: 'Fecha inicio en formato YYYY-MM-DD' },
			date_to: { type: 'string', description: 'Fecha fin en formato YYYY-MM-DD' },
			currency_mode: { type: 'string', description: 'Moneda: system (USD), contract, company', enum: ['system', 'contract', 'company'] },
			company_id: { type: 'string', description: 'Filtrar por ID de compañía específica' },
			include_widgets: { type: 'boolean', description: 'Si debe generar gráficos/tablas visuales' },
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'contracts', 'clients'],
		baseQuery: `
			SELECT
				COALESCE(cl.market, 'Sin mercado') as market,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					client_id,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					rsm.period_month,
					c.client_id,
					rsm.company_id,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
			) combined_mrr
			LEFT JOIN clients cl ON cl.id = combined_mrr.client_id
		`,
		filters: {
			date_from: { column: 'period_month', operator: '>=', parameterName: 'date_from' },
			date_to: { column: 'period_month', operator: '<=', parameterName: 'date_to' },
			company_id: { column: 'combined_mrr.company_id', operator: '=', parameterName: 'company_id' },
		},
		groupBy: ['cl.market', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Mercado',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'market',
			format: { mrr: 'currency', period_month: 'month-year' },
		},
	},
};

export const GET_MRR_BY_INDUSTRY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_industry',
	description: `Obtiene el MRR agrupado por industria del cliente para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

Usar cuando el usuario pregunte por:
- "MRR por industria"
- "MRR por sector"
- "Desglose de MRR por industria"
- "Qué industrias generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por industria para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: { type: 'integer', description: 'Cantidad de meses hacia atrás desde hoy' },
			date_from: { type: 'string', description: 'Fecha inicio en formato YYYY-MM-DD' },
			date_to: { type: 'string', description: 'Fecha fin en formato YYYY-MM-DD' },
			currency_mode: { type: 'string', description: 'Moneda: system (USD), contract, company', enum: ['system', 'contract', 'company'] },
			company_id: { type: 'string', description: 'Filtrar por ID de compañía específica' },
			include_widgets: { type: 'boolean', description: 'Si debe generar gráficos/tablas visuales' },
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'contracts', 'clients'],
		baseQuery: `
			SELECT
				COALESCE(cl.industry, 'Sin industria') as industry,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					client_id,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					rsm.period_month,
					c.client_id,
					rsm.company_id,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
			) combined_mrr
			LEFT JOIN clients cl ON cl.id = combined_mrr.client_id
		`,
		filters: {
			date_from: { column: 'period_month', operator: '>=', parameterName: 'date_from' },
			date_to: { column: 'period_month', operator: '<=', parameterName: 'date_to' },
			company_id: { column: 'combined_mrr.company_id', operator: '=', parameterName: 'company_id' },
		},
		groupBy: ['cl.industry', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Industria',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'industry',
			format: { mrr: 'currency', period_month: 'month-year' },
		},
	},
};

export const GET_MRR_BY_COUNTRY_SKILL: SkillDefinition = {
	name: 'get_mrr_by_country',
	description: `Obtiene el MRR agrupado por país del cliente para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

Usar cuando el usuario pregunte por:
- "MRR por país"
- "MRR por country"
- "Desglose de MRR por país"
- "Qué países generan más MRR"`,

	emptyMessage: 'No se encontraron datos de MRR por país para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: { type: 'integer', description: 'Cantidad de meses hacia atrás desde hoy' },
			date_from: { type: 'string', description: 'Fecha inicio en formato YYYY-MM-DD' },
			date_to: { type: 'string', description: 'Fecha fin en formato YYYY-MM-DD' },
			currency_mode: { type: 'string', description: 'Moneda: system (USD), contract, company', enum: ['system', 'contract', 'company'] },
			company_id: { type: 'string', description: 'Filtrar por ID de compañía específica' },
			include_widgets: { type: 'boolean', description: 'Si debe generar gráficos/tablas visuales' },
		},
	},

	database: {
		tables: ['mrr_legacy', 'revenue_schedule_monthly', 'contracts', 'clients'],
		baseQuery: `
			SELECT
				COALESCE(cl.country, 'Sin país') as country,
				period_month,
				SUM(mrr_value) as mrr
			FROM (
				SELECT
					period_month,
					client_id,
					company_id,
					{{MRR_COLUMN_LEGACY}} as mrr_value
				FROM mrr_legacy
				WHERE {{WHERE_CLAUSE}} AND is_recurring = true

				UNION ALL

				SELECT
					rsm.period_month,
					c.client_id,
					rsm.company_id,
					rsm.{{MRR_COLUMN_RSM}} as mrr_value
				FROM revenue_schedule_monthly rsm
				JOIN contracts c ON c.id = rsm.contract_id
				WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
			) combined_mrr
			LEFT JOIN clients cl ON cl.id = combined_mrr.client_id
		`,
		filters: {
			date_from: { column: 'period_month', operator: '>=', parameterName: 'date_from' },
			date_to: { column: 'period_month', operator: '<=', parameterName: 'date_to' },
			company_id: { column: 'combined_mrr.company_id', operator: '=', parameterName: 'company_id' },
		},
		groupBy: ['cl.country', 'period_month'],
		orderBy: ['period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por País',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'country',
			format: { mrr: 'currency', period_month: 'month-year' },
		},
	},
};

export const GET_MRR_BY_CONTRACT_TYPE_SKILL: SkillDefinition = {
	name: 'get_mrr_by_contract_type',
	description: `Obtiene el MRR agrupado por tipo de contrato para un período o rango de períodos.

IMPORTANTE: El MRR es un KPI de saldo mensual (stock), NO se acumula entre períodos.

Usar cuando el usuario pregunte por:
- "MRR por tipo de contrato"
- "MRR por tipo"
- "Desglose de MRR por tipo de contrato"`,

	emptyMessage: 'No se encontraron datos de MRR por tipo de contrato para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'company_id', 'include_widgets'],
		schema: {
			months_back: { type: 'integer', description: 'Cantidad de meses hacia atrás desde hoy' },
			date_from: { type: 'string', description: 'Fecha inicio en formato YYYY-MM-DD' },
			date_to: { type: 'string', description: 'Fecha fin en formato YYYY-MM-DD' },
			currency_mode: { type: 'string', description: 'Moneda: system (USD), contract, company', enum: ['system', 'contract', 'company'] },
			company_id: { type: 'string', description: 'Filtrar por ID de compañía específica' },
			include_widgets: { type: 'boolean', description: 'Si debe generar gráficos/tablas visuales' },
		},
	},

	database: {
		tables: ['revenue_schedule_monthly', 'contracts'],
		baseQuery: `
			SELECT
				COALESCE(c.type, 'Sin tipo') as contract_type,
				rsm.period_month,
				SUM(rsm.{{MRR_COLUMN_RSM}}) as mrr
			FROM revenue_schedule_monthly rsm
			LEFT JOIN contracts c ON c.id = rsm.contract_id
			WHERE rsm.{{WHERE_CLAUSE}} AND rsm.is_total_row = false
		`,
		filters: {
			date_from: { column: 'rsm.period_month', operator: '>=', parameterName: 'date_from' },
			date_to: { column: 'rsm.period_month', operator: '<=', parameterName: 'date_to' },
			company_id: { column: 'rsm.company_id', operator: '=', parameterName: 'company_id' },
		},
		groupBy: ['c.type', 'rsm.period_month'],
		orderBy: ['rsm.period_month ASC', 'mrr DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar_stacked',
			title: 'MRR por Tipo de Contrato',
			xAxis: 'period_month',
			yAxis: 'mrr',
			seriesKey: 'contract_type',
			format: { mrr: 'currency', period_month: 'month-year' },
		},
	},
};

export const MRR_SKILLS = [
	GET_MRR_SKILL,
	GET_MRR_BY_COMPANY_SKILL,
	GET_MRR_BY_CURRENCY_SKILL,
	GET_MRR_BY_CLIENT_SKILL,
	GET_ARR_SKILL,
	GET_MRR_BY_PRODUCT_SKILL,
	GET_MRR_BY_ITEM_TYPE_SKILL,
	GET_MRR_BY_MOMENTUM_SKILL,
	GET_MRR_BY_SEGMENT_SKILL,
	GET_MRR_BY_MARKET_SKILL,
	GET_MRR_BY_INDUSTRY_SKILL,
	GET_MRR_BY_COUNTRY_SKILL,
	GET_MRR_BY_CONTRACT_TYPE_SKILL,
];
