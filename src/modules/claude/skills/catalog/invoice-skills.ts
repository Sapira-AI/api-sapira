import { SkillDefinition } from '../skill-definition.interface';

export const GET_BILLED_BY_PRODUCT_MONTH: SkillDefinition = {
	name: 'get_billed_by_product_month',
	description: `Obtiene la facturación agrupada por producto para el mes actual o un rango de meses.

INTENT: Distribución de facturación por producto en un período específico.
DIMENSIONES: producto (product_name), monto facturado.
WIDGET: Gráfico de barras verticales (eje X = producto, eje Y = monto).

Usar esta skill cuando el usuario pregunte por:
- "Facturación por producto mes actual"
- "Facturación por producto este mes"
- "Cuánto se facturó por producto"
- "Desglose de facturación por producto"
- "Top productos facturados"

NOTA: Usa datos de revenue_schedule_monthly (RSM) que tiene la facturación consolidada por producto.`,

	emptyMessage: 'No hay datos de facturación disponibles para el período solicitado. Esto puede ocurrir si no hay contratos con facturación registrada en ese mes.',

	parameters: {
		required: [],
		optional: ['months_back', 'date_from', 'date_to', 'currency_mode', 'include_widgets'],
		schema: {
			months_back: {
				type: 'integer',
				description: 'Cantidad de meses hacia atrás desde hoy. Por defecto 1 (mes actual)',
				default: 1,
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
		tables: ['revenue_schedule_monthly'],
		baseQuery: `
			SELECT
				product_name,
				SUM(CASE
					WHEN '{{CURRENCY_MODE}}' = 'system' THEN billed_period_system_ccy
					WHEN '{{CURRENCY_MODE}}' = 'contract' THEN billed_period_contract_ccy
					WHEN '{{CURRENCY_MODE}}' = 'company' THEN billed_period_ccy
					ELSE billed_period_system_ccy
				END) as total_amount
			FROM revenue_schedule_monthly
			WHERE {{WHERE_CLAUSE}} AND is_total_row = false AND product_name IS NOT NULL
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
		groupBy: ['product_name'],
		orderBy: ['total_amount DESC'],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'bar',
			title: 'Facturación por Producto (Moneda del Sistema)',
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
	description: `Obtiene la lista de facturas vencidas (due_date < hoy y no pagadas).

INTENT: Listar facturas que ya pasaron su fecha de vencimiento sin ser pagadas.
DIMENSIONES: número de factura, cliente, fecha vencimiento, días vencidos, monto.
WIDGET: Tabla ordenada por días vencidos (más atrasadas primero).

Usar esta skill cuando el usuario pregunte por:
- "Facturas vencidas"
- "Facturas atrasadas"
- "Facturas overdue"
- "Facturas pendientes de pago vencidas"
- "Cuáles facturas están vencidas"
- "Cuánto nos deben en facturas vencidas"

NOTA: Solo incluye facturas activas (is_active=true). Excluye facturas consolidadas.`,

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
		tables: ['invoices', 'clients'],
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
				cl.name_commercial as client_name,
				CURRENT_DATE - i.due_date::date as days_overdue
			FROM invoices i
			LEFT JOIN clients cl ON cl.id = i.client_id
			WHERE {{WHERE_CLAUSE}}
				AND i.is_active = true
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
			columns: ['invoice_number', 'client_name', 'due_date', 'days_overdue', 'total_system_currency'],
			columnLabels: {
				invoice_number: 'Número de Factura',
				client_name: 'Cliente',
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
	description: `Obtiene la lista de facturas pendientes por emitir (status='Por Emitir'), ordenadas por las más atrasadas primero.

INTENT: Listar facturas programadas que aún no han sido emitidas.
DIMENSIONES: cliente, fecha programada, días de retraso, monto.
WIDGET: Tabla con KPI de totales (cantidad y monto total pendiente).

Usar esta skill cuando el usuario pregunte por:
- "Facturas por emitir"
- "Facturas pendientes de emisión"
- "Facturas programadas"
- "Cuáles facturas faltan emitir"
- "Facturas atrasadas de emisión"

NOTA: Solo incluye facturas activas (is_active=true). Muestra las 10 más atrasadas.`,

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
		tables: ['invoices', 'clients'],
		baseQuery: `
			WITH invoice_stats AS (
				SELECT
					COUNT(*) as total_count,
					SUM(total_system_currency) as total_amount
				FROM invoices
				WHERE {{WHERE_CLAUSE}}
					AND is_active = true
					AND status = 'Por Emitir'
			)
			SELECT
				i.scheduled_at,
				i.total_system_currency,
				i.total_invoice_currency,
				i.invoice_currency,
				i.client_id,
				cl.name_commercial as client_name,
				i.company_id,
				i.status,
				GREATEST(0, CURRENT_DATE - i.scheduled_at::date) as days_delayed,
				s.total_count,
				s.total_amount
			FROM invoices i
			LEFT JOIN clients cl ON cl.id = i.client_id
			CROSS JOIN invoice_stats s
			WHERE {{WHERE_CLAUSE}}
				AND i.is_active = true
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
			columns: ['client_name', 'scheduled_at', 'days_delayed', 'total_system_currency'],
			columnLabels: {
				client_name: 'Cliente',
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
		tables: ['invoices', 'clients'],
		baseQuery: `
			SELECT
				i.invoice_number,
				i.issue_date,
				i.status,
				cl.name_commercial as client_name,
				i.total_system_currency,
				i.total_invoice_currency,
				i.invoice_currency,
				i.client_id,
				i.company_id
			FROM invoices i
			LEFT JOIN clients cl ON cl.id = i.client_id
			WHERE {{WHERE_CLAUSE}}
				AND i.is_active = true
				AND i.status IN ('Emitida', 'Enviada', 'Pagada', 'Vencida')
		`,
		filters: {
			month: {
				column: 'EXTRACT(MONTH FROM i.issue_date::date)',
				operator: '=',
				parameterName: 'month',
			},
			year: {
				column: 'EXTRACT(YEAR FROM i.issue_date::date)',
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

INTENT: Serie temporal de facturación mensual.
DIMENSIONES: período (mes), cantidad de facturas, monto total.
WIDGET: Gráfico de barras (eje X = período MM/YYYY, eje Y = monto facturado).

Usar cuando el usuario pregunte por:
- "Facturación de los últimos X meses" → usar months_back=X
- "Histórico de facturación"
- "Evolución de facturación mensual"
- "Cuánto facturamos por mes"
- "Facturación del año" → usar months_back=12
- "Tendencia de facturación"

DIFERENCIA CON MRR: La facturación SÍ se puede sumar entre períodos (es un flujo). El MRR NO se suma (es un snapshot).

NOTA: Solo incluye facturas activas (is_active=true) con status Emitida, Enviada, Pagada o Vencida.`,

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
				AND i.is_active = true
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

INTENT: Balance de cuentas por cobrar (AR - Accounts Receivable).
DIMENSIONES: número de factura, cliente, fecha vencimiento, días vencidos, estado, monto.
WIDGET: Tabla ordenada por fecha de vencimiento.

Incluye facturas en estado Emitida, Enviada y Vencida. El monto total representa el dinero que se le debe a la empresa.

Usar cuando el usuario pregunte por:
- "Cuentas por cobrar"
- "AR" o "Accounts Receivable"
- "Cuánto nos deben"
- "Facturas pendientes de pago"
- "Saldo por cobrar"
- "Cartera de clientes"

NOTA: Solo incluye facturas activas (is_active=true). Excluye facturas consolidadas y canceladas.`,

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
		tables: ['invoices', 'clients'],
		baseQuery: `
			SELECT
				i.invoice_number,
				cl.name_commercial as client_name,
				i.issue_date,
				i.due_date,
				i.status,
				i.total_system_currency,
				i.invoice_currency,
				i.total_invoice_currency,
				CASE
					WHEN i.due_date::date < CURRENT_DATE THEN CURRENT_DATE - i.due_date::date
					ELSE 0
				END as days_overdue
			FROM invoices i
			LEFT JOIN clients cl ON cl.id = i.client_id
			WHERE {{WHERE_CLAUSE}}
				AND i.is_active = true
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
			columns: ['invoice_number', 'client_name', 'due_date', 'days_overdue', 'status', 'total_system_currency'],
			columnLabels: {
				invoice_number: 'Número de Factura',
				client_name: 'Cliente',
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
