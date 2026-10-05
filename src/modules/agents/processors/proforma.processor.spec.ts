import { ProformaProcessor } from './proforma.processor';

const HOLDING = 'h-1';
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

type Rule = [RegExp, unknown | ((sql: string, params: unknown[]) => unknown)];

function build(rules: Rule[]) {
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			const rule = rules.find(([pattern]) => pattern.test(sql));

			if (!rule) return [];

			return typeof rule[1] === 'function' ? (rule[1] as (s: string, p: unknown[]) => unknown)(sql, params) : rule[1];
		}),
	};

	return { processor: new ProformaProcessor(dataSource as never), dataSource };
}

const invoice = (id: string, clientId: string, days: number) => ({
	id,
	contract_id: `ct-${id}`,
	client_id: clientId,
	client_name: `Cliente ${clientId}`,
	scheduled_at: inDays(days),
});

describe('ProformaProcessor', () => {
	it('usa el days_before_issue del cliente: la ventana es el máximo y cada cliente filtra con el suyo', async () => {
		const { processor, dataSource } = build([
			[/MAX\(\(config_json->>'days_before_issue'\)::int\)/, [{ max_days: 30 }]],
			[/FROM invoices i/, [invoice('i-near', 'c1', 5), invoice('i-far', 'c1', 25), invoice('i-c2', 'c2', 25)]],
			[
				/FROM client_agent_configs\s+WHERE holding_id = \$1 AND agent_type = \$2/,
				(_sql: string, params: unknown[]) =>
					params[2] === 'c1'
						? [{ client_id: 'c1', is_enabled: true, config_json: {} }]
						: [{ client_id: 'c2', is_enabled: true, config_json: { days_before_issue: 30 } }],
			],
			[/FROM client_contacts/, [{ email: 'oc@cliente.cl', name: 'Ana' }]],
		]);

		const result = await processor.process({}, { days_before_issue: 10 }, 'run-1', HOLDING, 'preview');

		// c1 usa el del agente (10 días): solo i-near. c2 tiene 30: entra i-c2.
		expect(result.messages.map((m) => m.meta_json.invoice_id).sort()).toEqual(['i-c2', 'i-near']);
		const [, params] = dataSource.query.mock.calls.find(([sql]) => /FROM invoices i/.test(sql)) as [string, string[]];
		const windowDays = Math.round((new Date(params[1]).getTime() - Date.now()) / DAY);

		expect(windowDays).toBe(30);
	});

	it('el insert de reference_requests lleva holding_id (NOT NULL)', async () => {
		const { processor, dataSource } = build([
			[/MAX\(/, [{ max_days: null }]],
			[/FROM invoices i/, [invoice('i-1', 'c1', 3)]],
			[/FROM client_agent_configs/, [{ client_id: null, is_enabled: true, config_json: {} }]],
			[/FROM client_contacts/, [{ email: 'oc@cliente.cl', name: 'Ana' }]],
			[/INSERT INTO ai_messages/, [{ id: 'm-1', meta_json: {} }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'execute');

		expect(result.stats.errors).toBe(0);
		const insert = dataSource.query.mock.calls.find(([sql]) => /INSERT INTO reference_requests/.test(sql)) as [string, unknown[]];

		expect(insert[0]).toContain('holding_id');
		expect(insert[1][0]).toBe(HOLDING);
	});

	it('remitente por defecto: une email_sender_addresses por domain_config_id y no revienta', async () => {
		const { processor, dataSource } = build([
			[/MAX\(/, [{ max_days: null }]],
			[/FROM invoices i/, [invoice('i-1', 'c1', 3)]],
			[/FROM client_agent_configs/, [{ client_id: 'c1', is_enabled: true, config_json: {} }]],
			[/FROM email_sender_addresses esa/, [{ from_name: 'Cobranzas ACME', from_email: 'cobranza@acme.cl' }]],
			[/FROM client_contacts/, [{ email: 'oc@cliente.cl', name: 'Ana' }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		expect(result.stats.errors).toBe(0);
		expect(result.messages[0].meta_json.from_email).toBe('cobranza@acme.cl');
		const senderSql = dataSource.query.mock.calls.map(([sql]) => sql).find((sql) => /FROM email_sender_addresses esa/.test(sql));

		expect(senderSql).toContain('esa.domain_config_id = hess.id');
		expect(senderSql).not.toContain('hess.email_sender_address_id');
	});

	it('un cliente con la configuración deshabilitada se omite', async () => {
		const { processor } = build([
			[/MAX\(/, [{ max_days: null }]],
			[/FROM invoices i/, [invoice('i-1', 'c1', 3)]],
			[/FROM client_agent_configs/, [{ client_id: 'c1', is_enabled: false, config_json: {} }]],
		]);

		const result = await processor.process({}, {}, 'run-1', HOLDING, 'preview');

		expect(result.stats).toMatchObject({ clients_skipped: 1, messages_created: 0 });
	});
});
