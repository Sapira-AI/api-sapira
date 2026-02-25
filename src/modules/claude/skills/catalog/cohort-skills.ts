import { SkillDefinition } from '../skill-definition.interface';

// ---------------------------------------------------------------------------
// Skill 1: Ciclo operativo booking → primera factura emitida
// Responde: ¿Cuánto tarda desde que se cierra un contrato hasta emitir la
// primera factura? Agrupado por cohort mensual y por tramos de días.
// ---------------------------------------------------------------------------
export const GET_COHORT_BOOKING_TO_INVOICE: SkillDefinition = {
	name: 'get_cohort_booking_to_invoice',
	description: `Analiza el tiempo que pasa desde la fecha de cierre de un contrato (booking_date)
hasta que se emite la primera factura asociada a ese contrato.

Agrupa los contratos por mes de booking (cohort) y muestra la distribución
por tramos de días (0-15, 16-30, 31-60, >60 días).

Usar esta skill cuando el usuario pregunte por:
- "Ciclo booking a factura", "tiempo desde contrato a factura"
- "Cuánto tarda en emitirse la primera factura"
- "Demora operativa de facturación", "días entre firma y factura"
- "Cohort booking to invoice", "análisis de ciclo operativo"
- "Tiempo medio desde contrato hasta facturación"`,

	emptyMessage: 'No hay contratos con facturas asociadas en los últimos 24 meses.',

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
		tables: ['contracts', 'invoices'],
		baseQuery: `
			SELECT
				TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM') AS cohort_month,
				COUNT(DISTINCT c.id)                                       AS total_contracts,
				ROUND(AVG(first_invoice.days_to_invoice), 1)              AS avg_days,
				ROUND(MIN(first_invoice.days_to_invoice), 0)              AS min_days,
				ROUND(MAX(first_invoice.days_to_invoice), 0)              AS max_days,
				COUNT(DISTINCT CASE WHEN first_invoice.days_to_invoice BETWEEN 0 AND 15   THEN c.id END) AS tramo_0_15,
				COUNT(DISTINCT CASE WHEN first_invoice.days_to_invoice BETWEEN 16 AND 30  THEN c.id END) AS tramo_16_30,
				COUNT(DISTINCT CASE WHEN first_invoice.days_to_invoice BETWEEN 31 AND 60  THEN c.id END) AS tramo_31_60,
				COUNT(DISTINCT CASE WHEN first_invoice.days_to_invoice > 60              THEN c.id END) AS tramo_mas_60
			FROM contracts c
			JOIN (
				SELECT
					i.contract_id,
					MIN(i.issue_date - c2.booking_date) AS days_to_invoice
				FROM invoices i
				JOIN contracts c2 ON c2.id = i.contract_id
				WHERE c2.holding_id = $1
					AND c2.booking_date IS NOT NULL
					AND i.issue_date IS NOT NULL
					AND i.issue_date >= c2.booking_date
				GROUP BY i.contract_id
			) first_invoice ON first_invoice.contract_id = c.id
			WHERE {{WHERE_CLAUSE}}
				AND c.booking_date IS NOT NULL
				AND c.booking_date >= CURRENT_DATE - INTERVAL '24 months'
				AND c.status IN ('Activo', 'Firmado', 'Completado')
		`,
		filters: {},
		groupBy: ["TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM')"],
		orderBy: ["TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM') ASC"],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Ciclo Booking → Factura por Cohort Mensual',
			columns: ['cohort_month', 'total_contracts', 'avg_days', 'min_days', 'max_days', 'tramo_0_15', 'tramo_16_30', 'tramo_31_60', 'tramo_mas_60'],
			columnLabels: {
				cohort_month: 'Cohort',
				total_contracts: 'Contratos',
				avg_days: 'Prom. días',
				min_days: 'Mín',
				max_days: 'Máx',
				tramo_0_15: '0-15d',
				tramo_16_30: '16-30d',
				tramo_31_60: '31-60d',
				tramo_mas_60: '>60d',
			},
			format: {
				avg_days: 'number',
				min_days: 'number',
				max_days: 'number',
			},
		},
	},
};

// ---------------------------------------------------------------------------
// Skill 2: Retención mensual de clientes por cohort
// Responde: De los clientes cuyo primer contrato se firmó en mes X,
// ¿cuántos siguen con contratos activos en los meses siguientes?
// ---------------------------------------------------------------------------
export const GET_COHORT_RETENTION: SkillDefinition = {
	name: 'get_cohort_retention',
	description: `Análisis de retención de clientes por cohort mensual.
Agrupa los clientes según el mes en que firmaron su primer contrato (cohort de adquisición)
y muestra cuántos siguen activos (con contratos activos) en los meses posteriores.

Calcula la tasa de retención como porcentaje del tamaño inicial del cohort.

Usar esta skill cuando el usuario pregunte por:
- "Retención de clientes por cohort", "cohort retention"
- "Análisis de cohorte de clientes", "cohort analysis"
- "Tasa de retención por mes de adquisición"
- "Cuántos clientes retienen mes a mes"
- "Churn por cohort", "retención mensual"
- "Clientes que siguen activos por cohort"`,

	emptyMessage: 'No hay suficientes datos de contratos para calcular retención por cohort.',

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
			WITH first_contract AS (
				SELECT
					c.client_id,
					DATE_TRUNC('month', MIN(COALESCE(c.booking_date, c.created_at::date))) AS cohort_month
				FROM contracts c
				WHERE c.holding_id = $1
					AND c.status IN ('Activo', 'Firmado', 'Completado')
					AND COALESCE(c.booking_date, c.created_at::date) >= CURRENT_DATE - INTERVAL '24 months'
				GROUP BY c.client_id
			),
			cohort_sizes AS (
				SELECT
					cohort_month,
					COUNT(DISTINCT client_id) AS cohort_size
				FROM first_contract
				GROUP BY cohort_month
			),
			active_by_month AS (
				SELECT
					fc.cohort_month,
					DATE_TRUNC('month', COALESCE(c.booking_date, c.created_at::date)) AS active_month,
					COUNT(DISTINCT fc.client_id) AS active_clients
				FROM first_contract fc
				JOIN contracts c ON c.client_id = fc.client_id
				WHERE c.holding_id = $1
					AND c.status IN ('Activo', 'Firmado', 'Completado')
				GROUP BY fc.cohort_month, DATE_TRUNC('month', COALESCE(c.booking_date, c.created_at::date))
			)
			SELECT
				TO_CHAR(abm.cohort_month, 'YYYY-MM')    AS cohort_month,
				TO_CHAR(abm.active_month, 'YYYY-MM')    AS active_month,
				cs.cohort_size,
				abm.active_clients,
				ROUND((abm.active_clients::numeric / NULLIF(cs.cohort_size, 0)) * 100, 1) AS retention_pct,
				(DATE_PART('year', abm.active_month) - DATE_PART('year', abm.cohort_month)) * 12
					+ (DATE_PART('month', abm.active_month) - DATE_PART('month', abm.cohort_month)) AS months_since_cohort
			FROM active_by_month abm
			JOIN cohort_sizes cs ON cs.cohort_month = abm.cohort_month
			WHERE 1=1
				AND abm.active_month >= abm.cohort_month
			ORDER BY abm.cohort_month ASC, abm.active_month ASC
		`,
		filters: {},
		groupBy: [],
		orderBy: [],
	},

	response: {
		type: 'chart',
		widgetConfig: {
			type: 'cohort_heatmap',
			title: 'Retención de Clientes por Cohort',
			xAxis: 'cohort_month',
			yAxis: 'retention_pct',
			seriesKey: 'months_since_cohort',
		},
	},
};

// ---------------------------------------------------------------------------
// Skill 3: Ciclo completo booking → primer pago recibido
// Responde: ¿Cuánto tiempo pasa desde el cierre del contrato hasta recibir
// el primer pago confirmado? Join chain: contracts → invoices → invoice_payments
// ---------------------------------------------------------------------------
export const GET_COHORT_BOOKING_TO_PAYMENT: SkillDefinition = {
	name: 'get_cohort_booking_to_payment',
	description: `Analiza el ciclo completo desde el cierre de un contrato (booking_date)
hasta recibir el primer pago confirmado en invoice_payments.

Recorre el flujo: booking_date → invoice.issue_date → invoice_payments.payment_date.
Agrupa por cohort mensual y por tramos de días hasta el primer pago.

Usar esta skill cuando el usuario pregunte por:
- "Ciclo booking a pago", "tiempo desde contrato a cobro"
- "Cuánto tarda en recibirse el primer pago"
- "Días desde firma hasta pago", "tiempo de cobro"
- "Cohort booking to payment", "ciclo completo de cobro"
- "Flujo booking → factura → pago"
- "Días para recibir el dinero desde que se firma"`,

	emptyMessage: 'No hay contratos con pagos registrados en los últimos 24 meses.',

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
		tables: ['contracts', 'invoices', 'invoice_payments'],
		baseQuery: `
			SELECT
				TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM') AS cohort_month,
				COUNT(DISTINCT c.id)                                       AS total_contracts,
				ROUND(AVG(first_payment.days_to_payment), 1)              AS avg_days_to_payment,
				ROUND(MIN(first_payment.days_to_payment), 0)              AS min_days,
				ROUND(MAX(first_payment.days_to_payment), 0)              AS max_days,
				COUNT(DISTINCT CASE WHEN first_payment.days_to_payment BETWEEN 0 AND 30  THEN c.id END) AS tramo_0_30,
				COUNT(DISTINCT CASE WHEN first_payment.days_to_payment BETWEEN 31 AND 60 THEN c.id END) AS tramo_31_60,
				COUNT(DISTINCT CASE WHEN first_payment.days_to_payment BETWEEN 61 AND 90 THEN c.id END) AS tramo_61_90,
				COUNT(DISTINCT CASE WHEN first_payment.days_to_payment > 90             THEN c.id END) AS tramo_mas_90
			FROM contracts c
			JOIN (
				SELECT
					i.contract_id,
					MIN(ip.payment_date - c2.booking_date) AS days_to_payment
				FROM invoices i
				JOIN invoice_payments ip ON ip.invoice_id = i.id
				JOIN contracts c2 ON c2.id = i.contract_id
				WHERE c2.holding_id = $1
					AND c2.booking_date IS NOT NULL
					AND ip.payment_date IS NOT NULL
					AND ip.confirmed = true
					AND ip.payment_date >= c2.booking_date
				GROUP BY i.contract_id
			) first_payment ON first_payment.contract_id = c.id
			WHERE {{WHERE_CLAUSE}}
				AND c.booking_date IS NOT NULL
				AND c.booking_date >= CURRENT_DATE - INTERVAL '24 months'
				AND c.status IN ('Activo', 'Firmado', 'Completado')
		`,
		filters: {},
		groupBy: ["TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM')"],
		orderBy: ["TO_CHAR(DATE_TRUNC('month', c.booking_date), 'YYYY-MM') ASC"],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Ciclo Booking → Pago por Cohort Mensual',
			columns: ['cohort_month', 'total_contracts', 'avg_days_to_payment', 'min_days', 'max_days', 'tramo_0_30', 'tramo_31_60', 'tramo_61_90', 'tramo_mas_90'],
			columnLabels: {
				cohort_month: 'Cohort',
				total_contracts: 'Contratos',
				avg_days_to_payment: 'Prom. días',
				min_days: 'Mín',
				max_days: 'Máx',
				tramo_0_30: '0-30d',
				tramo_31_60: '31-60d',
				tramo_61_90: '61-90d',
				tramo_mas_90: '>90d',
			},
			format: {
				avg_days_to_payment: 'number',
				min_days: 'number',
				max_days: 'number',
			},
		},
	},
};

export const COHORT_SKILLS: SkillDefinition[] = [
	GET_COHORT_BOOKING_TO_INVOICE,
	GET_COHORT_RETENTION,
	GET_COHORT_BOOKING_TO_PAYMENT,
];
