import { CollectionsProcessor } from './collections.processor';

const HOLDING = 'h-1';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Rule = [RegExp, unknown];

function build(rules: Rule[]) {
	const dataSource = {
		query: jest.fn(async (sql: string) => rules.find(([pattern]) => pattern.test(sql))?.[1] ?? []),
	};

	return { processor: new CollectionsProcessor(dataSource as never), dataSource };
}

const LEVELS = [
	{ level: 1, days_overdue: 30, frequency_hours: 168, custom_subject: 'Nivel 1 {{client_name}}' },
	{ level: 2, days_overdue: 60, frequency_hours: 24, custom_subject: 'Nivel 2 {{client_name}}' },
];

const invoice = (id: string, overdueDays: number) => ({
	id,
	client_id: 'c1',
	client_name: 'ACME',
	due_date: daysAgo(overdueDays),
	total_invoice_currency: '1000',
	invoice_currency: 'CLP',
});

describe('CollectionsProcessor', () => {
	it('envía un solo correo por cliente con el nivel más alto que corresponde', async () => {
		const { processor } = build([
			[/FROM invoices i/, [invoice('i-1', 35), invoice('i-2', 65)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				[{ client_id: 'c1', is_enabled: true, config_json: { reminder_levels: LEVELS } }],
			],
			[/FROM client_contacts/, [{ email: 'pagos@acme.cl', name: 'Ana' }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].subject).toBe('Nivel 2 ACME');
		expect(result.messages[0].meta_json).toMatchObject({ reminder_level: 2, invoice_count: 2 });
	});

	it('respeta la frecuencia: con un envío reciente del nivel no genera mensaje en execute', async () => {
		const { processor } = build([
			[/FROM invoices i/, [invoice('i-1', 35)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				[{ client_id: 'c1', is_enabled: true, config_json: { reminder_levels: LEVELS } }],
			],
			[/FROM ai_messages m/, [{ created_at: new Date().toISOString() }]],
			[/FROM client_contacts/, [{ email: 'pagos@acme.cl', name: 'Ana' }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'execute');

		expect(result.messages).toHaveLength(0);
	});

	it('la frecuencia ignora los mensajes de ejecuciones descartadas', async () => {
		const { processor, dataSource } = build([
			[/FROM invoices i/, [invoice('i-1', 35)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				[{ client_id: 'c1', is_enabled: true, config_json: { reminder_levels: LEVELS } }],
			],
			[/FROM client_contacts/, [{ email: 'pagos@acme.cl', name: 'Ana' }]],
		]);

		await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		const frequencySql = dataSource.query.mock.calls.map(([sql]) => sql).find((sql) => /FROM ai_messages m/.test(sql));

		expect(frequencySql).toContain("r.status <> 'cancelled'");
	});

	it('remitente por defecto con el JOIN correcto', async () => {
		const { processor, dataSource } = build([
			[/FROM invoices i/, [invoice('i-1', 35)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				[{ client_id: null, is_enabled: true, config_json: { reminder_levels: LEVELS } }],
			],
			[/FROM email_sender_addresses esa/, [{ from_name: 'ACME', from_email: 'cobranza@acme.cl' }]],
			[/FROM client_contacts/, [{ email: 'pagos@acme.cl', name: 'Ana' }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		expect(result.stats.errors).toBe(0);
		expect(result.messages[0].meta_json.from_email).toBe('cobranza@acme.cl');
		expect(dataSource.query.mock.calls.map(([sql]) => sql).join('\n')).not.toContain('hess.email_sender_address_id');
	});

	it('sin contacto de cobranza no genera mensaje', async () => {
		const { processor } = build([
			[/FROM invoices i/, [invoice('i-1', 35)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				[{ client_id: 'c1', is_enabled: true, config_json: { reminder_levels: LEVELS } }],
			],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		expect(result.messages).toHaveLength(0);
		expect(result.stats.clients_processed).toBe(1);
	});
});
