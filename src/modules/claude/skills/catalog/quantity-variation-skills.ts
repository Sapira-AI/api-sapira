import { SkillDefinition } from '../skill-definition.interface';

export const GET_QUANTITY_VARIATION_AVG: SkillDefinition = {
	name: 'quantity_variation_avg',
	description: `Obtiene la variación promedio de cantidades comparando con el mes anterior (baseline).
	
Usar esta skill cuando el usuario pregunte por:
- "Variación promedio de cantidades"
- "Variación de cantidades respecto al mes anterior"
- "Cambio promedio en las cantidades"
- "Cuánto variaron las cantidades en promedio"
- "Diferencia de cantidades mes a mes"

Calcula la variación porcentual y absoluta comparando cada período con el período anterior.`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy para analizar variaciones',
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
				default: true,
			},
		},
	},

	database: {
		tables: ['quantities', 'contract_items'],
		baseQuery: `
			WITH quantity_with_previous AS (
				SELECT 
					q.id,
					q.contract_item_id,
					q.period,
					q.quantity,
					q.unit_price,
					q.unit_of_measure,
					ci.product_name,
					ci.unit_price as contract_unit_price,
					ci.quantity as contract_quantity,
					LAG(q.quantity) OVER (PARTITION BY q.contract_item_id ORDER BY q.period) as previous_quantity,
					LAG(q.period) OVER (PARTITION BY q.contract_item_id ORDER BY q.period) as previous_period
				FROM quantities q
				INNER JOIN contract_items ci ON q.contract_item_id = ci.id
				WHERE {{WHERE_CLAUSE}}
			),
			variations AS (
				SELECT 
					period,
					contract_item_id,
					product_name,
					quantity,
					previous_quantity,
					previous_period,
					unit_price,
					unit_of_measure,
					CASE 
						WHEN previous_quantity IS NOT NULL AND previous_quantity != 0 
						THEN ((quantity - previous_quantity) / previous_quantity) * 100
						ELSE NULL
					END as variation_percentage,
					CASE 
						WHEN previous_quantity IS NOT NULL 
						THEN quantity - previous_quantity
						ELSE NULL
					END as variation_absolute,
					CASE 
						WHEN previous_quantity IS NOT NULL 
						THEN (quantity - previous_quantity) * COALESCE(unit_price, contract_unit_price)
						ELSE NULL
					END as variation_value
				FROM quantity_with_previous
			)
			SELECT 
				period,
				COUNT(*) as items_count,
				AVG(variation_percentage) as avg_variation_percentage,
				AVG(variation_absolute) as avg_variation_absolute,
				SUM(variation_value) as total_variation_value,
				MIN(variation_percentage) as min_variation_percentage,
				MAX(variation_percentage) as max_variation_percentage
			FROM variations
			WHERE variation_percentage IS NOT NULL
		`,
		filters: {
			date_from: {
				column: 'q.period',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'q.period',
				operator: '<=',
				parameterName: 'date_to',
			},
		},
		groupBy: ['period'],
		orderBy: ['period ASC'],
	},

	response: {
		type: 'kpi',
		widgetConfig: {
			type: 'kpi',
			title: 'Variación Promedio de Cantidades',
			yAxis: 'avg_variation_percentage',
			format: {
				avg_variation_percentage: 'percentage',
				avg_variation_absolute: 'number',
				total_variation_value: 'currency',
			},
		},
	},
};

export const GET_QUANTITY_VARIATION_CONTRACT: SkillDefinition = {
	name: 'quantity_variation_contract',
	description: `Obtiene la serie temporal de variaciones de cantidades para un contrato específico.
	
Usar esta skill cuando el usuario pregunte por:
- "Variaciones del contrato X"
- "Variaciones de cantidades del contrato"
- "Historial de variaciones del contrato"
- "Evolución de cantidades del contrato X"
- "Cambios en las cantidades del contrato"

Muestra la evolución de cantidades, precios unitarios y valores totales período a período.`,

	parameters: {
		required: ['contract_item_id'],
		optional: ['date_from', 'date_to', 'include_widgets'],
		schema: {
			contract_item_id: {
				type: 'string',
				description: 'ID del item de contrato para consultar variaciones',
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
				default: true,
			},
		},
	},

	database: {
		tables: ['quantities', 'contract_items'],
		baseQuery: `
			WITH quantity_series AS (
				SELECT 
					q.id,
					q.contract_item_id,
					q.period,
					q.quantity,
					q.unit_price,
					q.unit_of_measure,
					q.quantity * COALESCE(q.unit_price, ci.unit_price) as period_value,
					ci.product_name,
					ci.unit_price as contract_unit_price,
					LAG(q.quantity) OVER (ORDER BY q.period) as previous_quantity,
					LAG(q.unit_price) OVER (ORDER BY q.period) as previous_unit_price,
					LAG(q.period) OVER (ORDER BY q.period) as previous_period
				FROM quantities q
				INNER JOIN contract_items ci ON q.contract_item_id = ci.id
				WHERE {{WHERE_CLAUSE}}
			)
			SELECT 
				period,
				product_name,
				quantity,
				unit_price,
				unit_of_measure,
				period_value,
				previous_quantity,
				previous_period,
				CASE 
					WHEN previous_quantity IS NOT NULL AND previous_quantity != 0 
					THEN ((quantity - previous_quantity) / previous_quantity) * 100
					ELSE NULL
				END as variation_percentage,
				CASE 
					WHEN previous_quantity IS NOT NULL 
					THEN quantity - previous_quantity
					ELSE NULL
				END as variation_absolute,
				CASE 
					WHEN previous_unit_price IS NOT NULL AND previous_unit_price != 0 
					THEN ((unit_price - previous_unit_price) / previous_unit_price) * 100
					ELSE NULL
				END as price_variation_percentage
			FROM quantity_series
		`,
		filters: {
			contract_item_id: {
				column: 'q.contract_item_id',
				operator: '=',
				parameterName: 'contract_item_id',
			},
			date_from: {
				column: 'q.period',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'q.period',
				operator: '<=',
				parameterName: 'date_to',
			},
		},
		groupBy: [],
		orderBy: ['period ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'line',
			title: 'Variaciones de Cantidades por Contrato',
			xAxis: 'period',
			yAxis: 'quantity',
			format: {
				quantity: 'number',
				unit_price: 'currency',
				period_value: 'currency',
				variation_percentage: 'percentage',
				price_variation_percentage: 'percentage',
			},
		},
	},
};

export const QUANTITY_VARIATION_SKILLS = [GET_QUANTITY_VARIATION_AVG, GET_QUANTITY_VARIATION_CONTRACT];
