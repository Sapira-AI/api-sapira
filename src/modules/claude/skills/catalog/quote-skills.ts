import { SkillDefinition } from '../skill-definition.interface';

export const GET_QUOTES_PIPELINE: SkillDefinition = {
	name: 'get_quotes_pipeline',
	description: `Obtiene el pipeline de cotizaciones activas (quotes) con su estado y valor potencial.

Usar cuando el usuario pregunte por:
- "Pipeline de ventas"
- "Cotizaciones activas"
- "Quotes pendientes"
- "Oportunidades en curso"
- "Cuánto tenemos en el pipeline"
- "Propuestas enviadas"`,

	emptyMessage: 'No hay cotizaciones activas en el pipeline en este momento.',

	parameters: {
		required: [],
		optional: ['company_id', 'include_widgets'],
		schema: {
			company_id: {
				type: 'string',
				description: 'Filtrar por ID de compañía específica',
			},
			include_widgets: {
				type: 'boolean',
				description: 'Si debe generar gráficos/tablas visuales',
				default: true,
			},
		},
	},

	database: {
		tables: ['quotes', 'clients', 'companies'],
		baseQuery: `
			SELECT
				q.id as quote_id,
				q.quote_number,
				q.status,
				q.created_at::date as quote_date,
				q.valid_until,
				q.total_system_currency,
				q.quote_currency,
				q.client_id,
				q.company_id,
				cl.legal_name as client_name,
				co.legal_name as company_name
			FROM quotes q
			LEFT JOIN clients cl ON cl.id = q.client_id
			LEFT JOIN companies co ON co.id = q.company_id
			WHERE {{WHERE_CLAUSE}}
				AND q.status NOT IN ('Rechazada', 'Cancelada', 'Expirada')
		`,
		filters: {
			company_id: {
				column: 'q.company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: [],
		orderBy: ['q.total_system_currency DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Pipeline de Cotizaciones',
			columns: ['quote_number', 'client_name', 'company_name', 'status', 'quote_date', 'valid_until', 'total_system_currency'],
			columnLabels: {
				quote_number: 'N° Cotización',
				client_name: 'Cliente',
				company_name: 'Compañía',
				status: 'Estado',
				quote_date: 'Fecha',
				valid_until: 'Válida Hasta',
				total_system_currency: 'Valor',
			},
			format: {
				total_system_currency: 'currency',
				quote_date: 'date',
				valid_until: 'date',
			},
		},
	},
};

export const QUOTE_SKILLS = [GET_QUOTES_PIPELINE];
