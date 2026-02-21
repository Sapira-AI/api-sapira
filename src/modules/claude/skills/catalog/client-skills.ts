import { SkillDefinition } from '../skill-definition.interface';

export const GET_ACTIVE_CLIENTS: SkillDefinition = {
	name: 'get_active_clients',
	description: `Obtiene la lista de clientes activos (con al menos un contrato activo o firmado).

Usar cuando el usuario pregunte por:
- "Clientes activos"
- "Cuántos clientes tenemos"
- "Lista de clientes"
- "Qué clientes están activos"
- "Total de clientes activos"`,

	emptyMessage: 'No se encontraron clientes activos para el holding indicado.',

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
		tables: ['clients', 'contracts'],
		baseQuery: `
			SELECT
				cl.id as client_id,
				cl.legal_name as client_name,
				cl.email,
				cl.company_id,
				COUNT(c.id) as active_contract_count,
				SUM(c.total_value_system_currency) as total_contract_value,
				MIN(c.contract_end_date) as nearest_expiry
			FROM clients cl
			INNER JOIN contracts c ON c.client_id = cl.id
			WHERE {{WHERE_CLAUSE}}
				AND c.status IN ('Activo', 'Firmado')
		`,
		filters: {
			company_id: {
				column: 'cl.company_id',
				operator: '=',
				parameterName: 'company_id',
			},
		},
		groupBy: ['cl.id', 'cl.legal_name', 'cl.email', 'cl.company_id'],
		orderBy: ['total_contract_value DESC'],
	},

	response: {
		type: 'table',
		widgetConfig: {
			type: 'table',
			title: 'Clientes Activos',
			columns: ['client_name', 'email', 'active_contract_count', 'total_contract_value', 'nearest_expiry'],
			columnLabels: {
				client_name: 'Cliente',
				email: 'Email',
				active_contract_count: 'Contratos Activos',
				total_contract_value: 'Valor Total',
				nearest_expiry: 'Próximo Vencimiento',
			},
			format: {
				total_contract_value: 'currency',
				nearest_expiry: 'date',
			},
		},
	},
};

export const CLIENT_SKILLS = [GET_ACTIVE_CLIENTS];
