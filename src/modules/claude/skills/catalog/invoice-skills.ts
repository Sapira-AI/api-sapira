import { SkillDefinition } from '../skill-definition.interface';

export const GET_BILLED_BY_PRODUCT_MONTH: SkillDefinition = {
	name: 'get_billed_by_product_month',
	description: `Obtiene la facturación agrupada por producto para el mes actual o un mes específico.

Usar esta skill cuando el usuario pregunte por:
- "Facturación por producto mes actual"
- "Facturación por producto este mes"
- "Cuánto se facturó por producto"
- "Desglose de facturación por producto"`,

	parameters: {
		required: [],
		optional: ['month', 'year', 'currency_mode', 'include_widgets'],
		schema: {
			month: {
				type: 'integer',
				description: 'Mes a consultar (1-12). Por defecto mes actual',
			},
			year: {
				type: 'integer',
				description: 'Año a consultar. Por defecto año actual',
			},
			currency_mode: {
				type: 'string',
				description: 'Moneda para el reporte: system (USD), invoice (moneda de facturación), contract (moneda del contrato)',
				enum: ['system', 'invoice', 'contract'],
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
		tables: ['invoice_items', 'invoices', 'products'],
		baseQuery: `
			SELECT
				COALESCE(p.name, ii.description) as product_name,
				p.product_code,
				COUNT(DISTINCT i.id) as invoice_count,
				SUM(ii.quantity) as total_quantity,
				SUM(CASE
					WHEN '{{CURRENCY_MODE}}' = 'system' THEN ii.total_system_currency
					WHEN '{{CURRENCY_MODE}}' = 'invoice' THEN ii.total_invoice_currency
					WHEN '{{CURRENCY_MODE}}' = 'contract' THEN ii.total_contract_currency
					ELSE ii.total_system_currency
				END) as total_amount
			FROM invoice_items ii
			INNER JOIN invoices i ON ii.invoice_id = i.id
			LEFT JOIN products p ON ii.product_id = p.id
			WHERE {{WHERE_CLAUSE}}
				AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
		`,
		filters: {
			month: {
				column: 'EXTRACT(MONTH FROM i.issue_date)',
				operator: '=',
				parameterName: 'month',
			},
			year: {
				column: 'EXTRACT(YEAR FROM i.issue_date)',
				operator: '=',
				parameterName: 'year',
			},
		},
		groupBy: ['COALESCE(p.name, ii.description)', 'p.product_code'],
		orderBy: ['total_amount DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar',
			title: 'Facturación por Producto',
			xAxis: 'product_name',
			yAxis: 'total_amount',
			format: {
				total_amount: 'currency',
			},
		},
	},
};

export const GET_INVOICES_OVERDUE: SkillDefinition = {
	name: 'get_invoices_overdue',
	description: `Obtiene la lista de facturas vencidas.

Usar esta skill cuando el usuario pregunte por:
- "Facturas vencidas"
- "Facturas atrasadas"
- "Facturas pendientes de pago vencidas"
- "Cuáles facturas están vencidas"`,

	emptyMessage: 'No hay facturas vencidas en este momento. ¡Buenas noticias!',

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
		tables: ['invoices'],
		baseQuery: `
			SELECT
				i.invoice_number,
				i.status,
				i.issue_date,
				i.due_date,
				i.total_system_currency,
				i.total_invoice_currency,
				i.invoice_currency,
				i.client_id,
				i.company_id,
				i.legal_client_name,
				CURRENT_DATE - i.due_date as days_overdue
			FROM invoices i
			WHERE {{WHERE_CLAUSE}}
				AND (
					i.status = 'Vencida'
					OR (i.status IN ('Emitida', 'Enviada') AND i.due_date < CURRENT_DATE)
				)
		`,
		filters: {},
		groupBy: [],
		orderBy: ['days_overdue DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Facturas Vencidas',
			columns: ['invoice_number', 'legal_client_name', 'due_date', 'days_overdue', 'total_system_currency'],
			columnLabels: {
				invoice_number: 'Número de Factura',
				legal_client_name: 'Cliente',
				due_date: 'Fecha de Vencimiento',
				days_overdue: 'Días Vencidos',
				total_system_currency: 'Monto',
			},
			format: {
				total_system_currency: 'currency',
				due_date: 'date',
			},
		},
	},
};

export const GET_INVOICES_TO_ISSUE: SkillDefinition = {
	name: 'get_invoices_to_issue',
	description: `Obtiene la lista de facturas pendientes por emitir, ordenadas por las más atrasadas primero.

Usar esta skill cuando el usuario pregunte por:
- "Facturas por emitir"
- "Facturas pendientes de emisión"
- "Facturas programadas"
- "Cuáles facturas faltan emitir"`,

	emptyMessage: 'No hay facturas pendientes por emitir en este momento.',

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
		tables: ['invoices'],
		baseQuery: `
			WITH invoice_stats AS (
				SELECT
					COUNT(*) as total_count,
					SUM(total_system_currency) as total_amount
				FROM invoices
				WHERE {{WHERE_CLAUSE}}
					AND status = 'Por Emitir'
			)
			SELECT
				i.scheduled_at,
				i.total_system_currency,
				i.total_invoice_currency,
				i.invoice_currency,
				i.client_id,
				i.legal_client_name,
				i.company_id,
				i.status,
				CURRENT_DATE - i.scheduled_at as days_delayed,
				s.total_count,
				s.total_amount
			FROM invoices i
			CROSS JOIN invoice_stats s
			WHERE {{WHERE_CLAUSE}}
				AND i.status = 'Por Emitir'
			ORDER BY days_delayed DESC
			LIMIT 10
		`,
		filters: {},
		groupBy: [],
		orderBy: [],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Facturas por Emitir',
			columns: ['legal_client_name', 'scheduled_at', 'days_delayed', 'total_system_currency'],
			columnLabels: {
				legal_client_name: 'Cliente',
				scheduled_at: 'Fecha Programada',
				days_delayed: 'Días de Retraso',
				total_system_currency: 'Monto',
			},
			format: {
				total_system_currency: 'currency',
				scheduled_at: 'date',
			},
		},
	},
};

export const GET_INVOICES_ISSUED_MONTH: SkillDefinition = {
	name: 'get_invoices_issued_month',
	description: `Obtiene las facturas emitidas en el mes actual o un mes específico.

Usar esta skill cuando el usuario pregunte por:
- "Facturas emitidas este mes"
- "Facturas emitidas en el mes actual"
- "Cuántas facturas se emitieron este mes"
- "Total facturado este mes"`,

	parameters: {
		required: [],
		optional: ['month', 'year', 'include_widgets'],
		schema: {
			month: {
				type: 'integer',
				description: 'Mes a consultar (1-12). Por defecto mes actual',
			},
			year: {
				type: 'integer',
				description: 'Año a consultar. Por defecto año actual',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['invoices'],
		baseQuery: `
			SELECT
				i.invoice_number,
				i.issue_date,
				i.status,
				i.legal_client_name,
				i.total_system_currency,
				i.total_invoice_currency,
				i.invoice_currency,
				i.client_id,
				i.company_id
			FROM invoices i
			WHERE {{WHERE_CLAUSE}}
				AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
		`,
		filters: {
			month: {
				column: 'EXTRACT(MONTH FROM i.issue_date)',
				operator: '=',
				parameterName: 'month',
			},
			year: {
				column: 'EXTRACT(YEAR FROM i.issue_date)',
				operator: '=',
				parameterName: 'year',
			},
		},
		groupBy: [],
		orderBy: ['i.issue_date DESC'],
	},

	response: {
		type: 'kpi',
		widgetConfig: {
			type: 'kpi',
			title: 'Facturas Emitidas del Mes',
			yAxis: 'total_system_currency',
			format: {
				total_system_currency: 'currency',
			},
		},
	},
};

export const GET_BILLING_SUMMARY: SkillDefinition = {
	name: 'get_billing_summary',
	description: `Obtiene la evolución histórica de facturación mensual (facturas emitidas agrupadas por mes).

Usar cuando el usuario pregunte por:
- "Facturación de los últimos X meses"
- "Histórico de facturación"
- "Evolución de facturación mensual"
- "Cuánto facturamos por mes"
- "Facturación del año"`,

	emptyMessage: 'No se encontraron datos de facturación para el período indicado.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy (por ejemplo 12 para el último año)',
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
		tables: ['invoices'],
		baseQuery: `
			SELECT
				TO_CHAR(i.issue_date, 'YYYY-MM-01')::date as period_month,
				COUNT(i.id) as invoice_count,
				SUM(i.total_system_currency) as total_billed
			FROM invoices i
			WHERE {{WHERE_CLAUSE}}
				AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
		`,
		filters: {
			date_from: {
				column: 'i.issue_date',
				operator: '>=',
				parameterName: 'date_from',
			},
			date_to: {
				column: 'i.issue_date',
				operator: '<=',
				parameterName: 'date_to',
			},
		},
		groupBy: ["TO_CHAR(i.issue_date, 'YYYY-MM-01')::date"],
		orderBy: ['period_month ASC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar',
			title: 'Facturación Mensual',
			xAxis: 'period_month',
			yAxis: 'total_billed',
			format: {
				total_billed: 'currency',
				period_month: 'month-year',
			},
		},
	},
};

export const GET_ACCOUNTS_RECEIVABLE: SkillDefinition = {
	name: 'get_accounts_receivable',
	description: `Obtiene el total de cuentas por cobrar: facturas emitidas que aún no han sido pagadas.

Incluye facturas en estado Emitida, Enviada y Vencida. El monto total representa el dinero que se le debe a la empresa.

Usar cuando el usuario pregunte por:
- "Cuentas por cobrar"
- "AR" o "Accounts Receivable"
- "Cuánto nos deben"
- "Facturas pendientes de pago"
- "Saldo por cobrar"`,

	emptyMessage: 'No hay cuentas por cobrar pendientes en este momento.',

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
		tables: ['invoices'],
		baseQuery: `
			SELECT
				i.invoice_number,
				i.legal_client_name,
				i.issue_date,
				i.due_date,
				i.status,
				i.total_system_currency,
				i.invoice_currency,
				i.total_invoice_currency,
				CASE
					WHEN i.due_date < CURRENT_DATE THEN CURRENT_DATE - i.due_date
					ELSE 0
				END as days_overdue
			FROM invoices i
			WHERE {{WHERE_CLAUSE}}
				AND i.status IN ('Emitida', 'Enviada', 'Vencida')
		`,
		filters: {},
		groupBy: [],
		orderBy: ['i.due_date ASC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Cuentas por Cobrar (AR)',
			columns: ['invoice_number', 'legal_client_name', 'due_date', 'days_overdue', 'status', 'total_system_currency'],
			columnLabels: {
				invoice_number: 'Número de Factura',
				legal_client_name: 'Cliente',
				due_date: 'Vencimiento',
				days_overdue: 'Días Vencidos',
				status: 'Estado',
				total_system_currency: 'Monto',
			},
			format: {
				total_system_currency: 'currency',
				due_date: 'date',
			},
		},
	},
};

export const INVOICE_SKILLS = [
	GET_BILLED_BY_PRODUCT_MONTH,
	GET_INVOICES_OVERDUE,
	GET_INVOICES_TO_ISSUE,
	GET_INVOICES_ISSUED_MONTH,
	GET_BILLING_SUMMARY,
	GET_ACCOUNTS_RECEIVABLE,
];
