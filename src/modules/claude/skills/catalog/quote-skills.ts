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
		tables: ['quotes', 'quote_stages', 'clients', 'companies'],
		baseQuery: `
			SELECT
				q.id as quote_id,
				q.quote_number,
				qs.name as stage_name,
				q.quote_date,
				q.total_amount,
				q.currency as quote_currency,
				q.client_id,
				cl.name_commercial as client_name,
				co.legal_name as company_name
			FROM quotes q
			JOIN quote_stages qs ON qs.id = q.quote_stage_id
			LEFT JOIN clients cl ON cl.id = q.client_id
			LEFT JOIN companies co ON co.id = q.company_id
			WHERE {{WHERE_CLAUSE}}
		`,
		filters: {
			company_id: {
				column: 'co.id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: [],
		orderBy: ['q.total_amount DESC NULLS LAST'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Pipeline de Cotizaciones',
			columns: ['quote_number', 'client_name', 'company_name', 'stage_name', 'quote_date', 'total_amount'],
			columnLabels: {
				quote_number: 'N° Cotización',
				client_name: 'Cliente',
				company_name: 'Compañía',
				stage_name: 'Estado',
				quote_date: 'Fecha',
				total_amount: 'Valor',
			},
			format: {
				total_amount: 'currency',
				quote_date: 'date',
			},
		},
	},
};

export const QUOTE_SKILLS = [GET_QUOTES_PIPELINE];
