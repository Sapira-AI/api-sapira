import { SkillDefinition } from '../skill-definition.interface';

export const GET_CONTRACTS_EXPIRING: SkillDefinition = {
	name: 'get_contracts_expiring',
	description: `Obtiene los contratos que están próximos a vencer en los próximos 12 meses.
	
Usar esta skill cuando el usuario pregunte por:
- "Contratos por vencer"
- "Contratos que vencen pronto"
- "Contratos próximos a expirar"
- "Cuáles contratos están por terminar"

Busca contratos que vencen en los próximos 365 días (12 meses).`,

	parameters: {
		required: [],
		optional: ['include_widgets'],
		schema: {
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['contracts'],
		baseQuery: `
			SELECT 
				c.contract_number,
				c.status,
				c.contract_end_date,
				c.booking_date,
				c.total_value_system_currency,
				c.contract_currency,
				c.client_id,
				c.company_id,
				c.legal_client_name,
				c.client_name_commercial,
				EXTRACT(DAY FROM (c.contract_end_date - CURRENT_DATE)) as days_until_expiry
			FROM contracts c
			WHERE {{WHERE_CLAUSE}}
				AND c.status IN ('Activo', 'Firmado')
				AND c.contract_end_date IS NOT NULL
				AND c.contract_end_date >= CURRENT_DATE
				AND c.contract_end_date <= CURRENT_DATE + INTERVAL '365 days'
		`,
		filters: {},
		groupBy: [],
		orderBy: ['c.contract_end_date ASC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Contratos por Vencer',
			columns: ['contract_number', 'legal_client_name', 'status', 'contract_end_date', 'days_until_expiry', 'total_value_system_currency'],
			format: {
				total_value_system_currency: 'currency',
				contract_end_date: 'date',
			},
		},
	},
};

export const GET_CONTRACTS_NEW: SkillDefinition = {
	name: 'get_contracts_new',
	description: `Obtiene los contratos nuevos para un período específico o rango de meses.

Esta skill es ideal para analizar la adquisición de nuevos contratos y su evolución temporal.
Permite consultar por mes específico o por un rango de meses hacia atrás desde hoy.

Usar esta skill cuando el usuario pregunte por:
- "Contratos nuevos este mes"
- "Contratos firmados este mes"
- "Nuevos contratos"
- "Contratos recientes"
- "Contratos nuevos últimos X meses"
- "Contratos firmados en los últimos 3 meses"
- "Nuevos contratos del trimestre"
- "Contratos nuevos del año"
- "Muéstrame los contratos que se firmaron recientemente"
- "¿Cuántos contratos nuevos tenemos?"
- "Contratos nuevos de octubre a diciembre"
- "Contratos del último semestre"

Ejemplos de uso:
- Para el mes actual: no especificar parámetros
- Para últimos 3 meses: months_back=3
- Para últimos 6 meses: months_back=6
- Para último año: months_back=12
- Para un rango específico: date_from="2025-10-01", date_to="2025-12-31"`,

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description:
					'Cantidad de meses hacia atrás desde hoy para consultar contratos nuevos. Por ejemplo: 3 para últimos 3 meses, 6 para últimos 6 meses, 12 para último año',
			},
			date_from: {
				type: 'string',
				description: 'Fecha inicio en formato YYYY-MM-DD (opcional, sobrescribe months_back)',
			},
			date_to: {
				type: 'string',
				description: 'Fecha fin en formato YYYY-MM-DD (opcional, por defecto hoy)',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['contracts'],
		baseQuery: `
			SELECT 
				c.contract_number,
				c.status,
				COALESCE(c.booking_date, c.created_at::date) as effective_booking_date,
				c.booking_date,
				c.created_at,
				c.total_value_system_currency,
				c.contract_currency,
				c.client_id,
				c.company_id,
				c.legal_client_name,
				c.client_name_commercial,
				c.type,
				TO_CHAR(COALESCE(c.booking_date, c.created_at::date), 'YYYY-MM') as period_month
			FROM contracts c
			WHERE {{WHERE_CLAUSE}}
		`,
		filters: {
			date_from: {
				column: 'COALESCE(c.booking_date, c.created_at::date)',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'COALESCE(c.booking_date, c.created_at::date)',
				operator: '<=',
				parameterName: 'date_to',
			},
		},
		groupBy: [],
		orderBy: ['COALESCE(c.booking_date, c.created_at::date) DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Contratos Nuevos',
			columns: [
				'contract_number',
				'legal_client_name',
				'status',
				'effective_booking_date',
				'type',
				'total_value_system_currency',
				'contract_currency',
			],
			format: {
				total_value_system_currency: 'currency',
				effective_booking_date: 'date',
			},
		},
	},
};

export const GET_CONTRACTS_EXPIRING_6_MONTHS: SkillDefinition = {
	name: 'get_contracts_expiring_6_months',
	description: `Obtiene los contratos que vencen en los próximos 6 meses (180 días).
	
Usar esta skill cuando el usuario pregunte por:
- "Contratos que vencen en 6 meses"
- "Contratos próximos a vencer en medio año"
- "Contratos por renovar en el semestre"`,

	parameters: {
		required: [],
		optional: ['include_widgets'],
		schema: {
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['contracts'],
		baseQuery: `
			SELECT 
				c.contract_number,
				c.status,
				c.contract_end_date,
				c.booking_date,
				c.total_value_system_currency,
				c.contract_currency,
				c.client_id,
				c.company_id,
				c.legal_client_name,
				c.client_name_commercial,
				EXTRACT(DAY FROM (c.contract_end_date - CURRENT_DATE)) as days_until_expiry
			FROM contracts c
			WHERE {{WHERE_CLAUSE}}
				AND c.status IN ('Activo', 'Firmado')
				AND c.contract_end_date IS NOT NULL
				AND c.contract_end_date >= CURRENT_DATE
				AND c.contract_end_date <= CURRENT_DATE + INTERVAL '180 days'
		`,
		filters: {},
		groupBy: [],
		orderBy: ['c.contract_end_date ASC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Contratos por Vencer (6 Meses)',
			columns: ['contract_number', 'legal_client_name', 'status', 'contract_end_date', 'days_until_expiry', 'total_value_system_currency'],
			format: {
				total_value_system_currency: 'currency',
				contract_end_date: 'date',
			},
		},
	},
};

export const GET_CHURN_REASONS: SkillDefinition = {
	name: 'get_churn_reasons',
	description: `Obtiene las razones de churn (cancelación) de contratos agrupadas y analizadas.
	
Usar esta skill cuando el usuario pregunte por:
- "Razones de churn"
- "Por qué se cancelan contratos"
- "Motivos de cancelación"
- "Análisis de churn"`,

	parameters: {
		required: [],
		optional: ['date_from', 'date_to', 'include_widgets'],
		schema: {
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
		tables: ['contracts'],
		baseQuery: `
			SELECT 
				c.churn_reason,
				COUNT(*) as contract_count,
				SUM(c.total_value_system_currency) as total_value_lost,
				MIN(c.churn_date) as first_churn_date,
				MAX(c.churn_date) as last_churn_date,
				c.company_id
			FROM contracts c
			WHERE {{WHERE_CLAUSE}}
				AND c.churn_reason IS NOT NULL
				AND c.churn_date IS NOT NULL
		`,
		filters: {
			date_from: {
				column: 'c.churn_date',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'c.churn_date',
				operator: '<=',
				parameterName: 'date_to',
			},
		},
		groupBy: ['c.churn_reason', 'c.company_id'],
		orderBy: ['contract_count DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar',
			title: 'Razones de Churn',
			xAxis: 'churn_reason',
			yAxis: 'contract_count',
			format: {
				total_value_lost: 'currency',
			},
		},
	},
};

export const CONTRACT_SKILLS = [GET_CONTRACTS_EXPIRING, GET_CONTRACTS_EXPIRING_6_MONTHS, GET_CONTRACTS_NEW, GET_CHURN_REASONS];
