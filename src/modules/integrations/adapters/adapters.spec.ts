jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException } from '@nestjs/common';

import { CrmAdapter } from './crm.adapter';
import { DatosAdapter } from './datos.adapter';
import { ErpAdapter } from './erp.adapter';
import { StripeAdapter } from './stripe.adapter';

const HOLDING = 'h-1';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const config = { get: jest.fn(() => undefined) };
const lean = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });
const chain = (value: unknown) => ({ sort: () => ({ limit: () => lean(value) }) });

describe('ErpAdapter', () => {
	const connection = {
		id: 'c-1',
		holding_id: HOLDING,
		name: 'Odoo',
		url: 'https://acme.odoo.com',
		database_name: 'db',
		username: 'api',
		api_key: 'abcdef1234567890',
		is_active: true,
	};
	const make = (overrides: Record<string, unknown> = {}) => {
		const deps = {
			dataSource: { query: jest.fn(async () => []) },
			connections: { find: jest.fn(async () => [connection]) },
			odooConnectionService: { create: jest.fn(async (data) => ({ ...data, id: 'new' })), update: jest.fn() },
			invoiceScheduler: { startSchedulerJob: jest.fn(async () => 'job-1') },
			schedulerJobs: { findOne: jest.fn(() => lean(null)), find: jest.fn(() => chain([])) },
			...overrides,
		};
		const adapter = new ErpAdapter(
			deps.dataSource as never,
			deps.connections as never,
			deps.odooConnectionService as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			deps.invoiceScheduler as never,
			deps.schedulerJobs as never,
			config as never
		);

		return { adapter, deps };
	};

	it('la conexión nunca devuelve la clave', async () => {
		const { adapter } = make();
		const view = await adapter.getConnection(HOLDING);

		expect(JSON.stringify(view)).not.toContain('abcdef1234567890');
		expect(view.secrets.api_key).toEqual({ has_secret: true, secret_last4: '7890' });
	});

	it('alta sin clave → 400', async () => {
		const { adapter } = make({ connections: { find: jest.fn(async () => []) } });

		await expect(
			adapter.saveConnection(HOLDING, { name: 'x', url: 'https://x.odoo.com', database_name: 'db', username: 'u' }, ACTOR)
		).rejects.toMatchObject({ status: 400 });
	});

	it('sincronizar: 409 si hay un envío en curso; si no, envía las facturas del holding (real)', async () => {
		const busy = make({ schedulerJobs: { findOne: jest.fn(() => lean({ jobId: 'x' })), find: jest.fn() } });

		await expect(busy.adapter.sync(HOLDING, ACTOR)).rejects.toBeInstanceOf(ConflictException);
		const { adapter, deps } = make();

		await expect(adapter.sync(HOLDING, ACTOR)).resolves.toEqual(expect.objectContaining({ run_id: 'erp-send:job-1' }));
		expect(deps.invoiceScheduler.startSchedulerJob).toHaveBeenCalledWith({ dryRun: false, holdingId: HOLDING, userId: 'auth-1' });
	});

	it('historial: de una corrida global solo cuenta las facturas del holding (A7)', async () => {
		const job = {
			jobId: 'j-all',
			holdingId: 'all',
			status: 'completed',
			executionSource: 'automatic',
			startedAt: new Date('2026-10-03T12:00:00Z'),
			completedAt: new Date('2026-10-03T12:01:00Z'),
			progress: { total: 3, sent: 2, errors: 1, skipped: 0 },
			result: {
				results: [
					{ invoiceId: 'i-1', holdingId: HOLDING, invoiceNumber: '10', status: 'sent', odooInvoiceId: 5 },
					{ invoiceId: 'i-2', holdingId: HOLDING, invoiceNumber: '11', status: 'error', error: 'Producto sin mapeo' },
					{ invoiceId: 'i-3', holdingId: 'otro', invoiceNumber: '12', status: 'sent' },
				],
			},
		};
		const { adapter } = make({ schedulerJobs: { findOne: jest.fn(() => lean(job)), find: jest.fn(() => chain([job])) } });
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data[0]).toEqual(
			expect.objectContaining({
				id: 'erp-send:j-all',
				trigger: 'automatic',
				status: 'partial',
				totals: { total: 2, ok: 1, unchanged: 0, errors: 1, skipped: 0 },
			})
		);
		const detail = await adapter.getRun(HOLDING, 'erp-send:j-all');

		expect(detail.records.map((record) => record.sapira_id)).toEqual(['i-1', 'i-2']);
		expect(detail.errors_summary).toEqual([{ message: 'Producto sin mapeo', count: 1 }]);
	});

	it('las facturas del ERP nacidas en Sapira se filtran según la regla', () => {
		const { adapter } = make();
		const withRule = adapter.recordSources({ exclude_sapira_invoices: true }).find((source) => source.object === 'erp_invoice');
		const without = adapter.recordSources({ exclude_sapira_invoices: false }).find((source) => source.object === 'erp_invoice');

		expect(withRule?.sql).toContain('si.odoo_invoice_id = s.odoo_id');
		expect(without?.sql).not.toContain('si.odoo_invoice_id');
	});
});

describe('CrmAdapter', () => {
	const make = (query: jest.Mock, overrides: Record<string, unknown> = {}) =>
		new CrmAdapter(
			{ query, transaction: jest.fn(async (work) => work({ query })) } as never,
			{
				findOne: jest.fn(async () => ({
					id: 'sf',
					holding_id: HOLDING,
					is_active: true,
					auth_type: 'client_credentials',
					client_secret: 'secretsecret123',
				})),
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{ createRun: jest.fn() } as never,
			{} as never,
			{ getQuoteTypeMappings: jest.fn(async () => []), createQuoteTypeMapping: jest.fn() } as never,
			(overrides.schedulerJobs ?? { findOne: jest.fn(() => lean(null)), create: jest.fn() }) as never,
			{} as never,
			config as never
		);

	it('sincronizar: 409 si la corrida diaria o una ejecución está en curso', async () => {
		const adapter = make(jest.fn(async () => [{ id: 'run' }]));

		await expect(adapter.sync(HOLDING)).rejects.toBeInstanceOf(ConflictException);
	});

	it('vendedores por origen: una fila por dueño del CRM; sugiere el vendedor por el correo técnico sf_<id>@salesforce.local', async () => {
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('count(*)::int AS n')) return [{ id: '005RO000005YZLRYA4', n: 7 }];
			if (sql.includes("raw_data->>'OwnerId' AS id")) return [{ id: '005RO000005YZLRYA4', name: 'Rafael Salas', email: null }];
			if (sql.includes('FROM sellers s'))
				return [
					{ id: 's-1', name: 'Rafael Salas', email: 'sf_005ro000005yzlrya4@salesforce.local', crm_owner_id: null },
					// Vendedor de Sapira sin dueño del CRM: no aparece ni cuenta como sin mapear.
					{ id: 's-2', name: 'Vendedora interna', email: 'ana@acme.com', crm_owner_id: null },
				];

			return [];
		});
		const view = await make(query).getMapping(HOLDING, 'owners', {});

		expect(view.anchor).toBe('external');
		expect(view.counts).toEqual({ total: 1, mapped: 0, unmapped: 0, suggested: 1 });
		expect(view.data[0]).toEqual(
			expect.objectContaining({
				key: '005RO000005YZLRYA4',
				status: 'suggested',
				suggestion: expect.objectContaining({ id: 's-1' }),
				usage: { opportunities: 7 },
			})
		);
	});

	it('vendedores: un dueño del CRM no puede ir con dos vendedores; tipos de cotización con código válido', async () => {
		const query = jest.fn(async () => [{ id: 's-1' }, { id: 's-2' }]);
		const adapter = make(query);

		await expect(
			adapter.putMapping(HOLDING, 'owners', [
				{ sapira_id: 's-1', external_id: '005A' },
				{ sapira_id: 's-2', external_id: '005A' },
			])
		).rejects.toMatchObject({ status: 400 });
		await expect(adapter.putMapping(HOLDING, 'quote_types', [{ sapira_id: 'Upselling', external_id: 'Upselling' }])).rejects.toMatchObject({
			status: 400,
		});
	});

	it('historial: 34 oportunidades, 0 cotizaciones nuevas, 1 error = Con errores con 33 sin cambios (no Falló)', async () => {
		const job = {
			jobId: 'salesforce-daily-sync:production:2026-10-03',
			status: 'completed',
			startedAt: new Date('2026-10-03T11:30:00Z'),
			completedAt: new Date('2026-10-03T11:31:00Z'),
			holdingResults: [{ holding_id: HOLDING, success: true, opportunities: 34, quotesCreated: 0, quotesUpdated: 0 }],
		};
		const adapter = new CrmAdapter(
			{ query: jest.fn(async () => []) } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ find: jest.fn(() => chain([job])) } as never,
			{ aggregate: jest.fn(() => ({ exec: async () => [{ _id: job.jobId, count: 1 }] })) } as never,
			config as never
		);
		const [run] = (await adapter.listRuns(HOLDING, { page: 1, limit: 20 })).data;

		expect(run).toEqual(expect.objectContaining({ status: 'partial', totals: { total: 34, ok: 0, unchanged: 33, errors: 1, skipped: 33 } }));
		expect((await adapter.listRuns(HOLDING, { page: 1, limit: 20, status: ['failed', 'partial'] })).total).toBe(1);
		expect((await adapter.listRuns(HOLDING, { page: 1, limit: 20, status: ['failed'] })).total).toBe(0);
	});

	it('la conexión no devuelve secretos ni la contraseña cifrada', async () => {
		const view = await make(jest.fn()).getConnection(HOLDING);

		expect(JSON.stringify(view)).not.toContain('secretsecret123');
		expect(view.secrets.client_secret).toEqual({ has_secret: true, secret_last4: 't123' });
	});
});

describe('StripeAdapter (varias cuentas)', () => {
	const accounts = [
		{ id: 'a-1', holding_id: HOLDING, name: 'Chile', mode: 'live', secret_key: 'sk_live_aaaaaaaa1111', is_active: true },
		{ id: 'a-2', holding_id: HOLDING, name: 'México', mode: 'live', secret_key: 'sk_live_bbbbbbbb2222', is_active: true },
	];
	const make = (rows = accounts) => {
		const adapter = new StripeAdapter(
			{ query: jest.fn(async () => []) } as never,
			{ find: jest.fn(async () => rows), findOne: jest.fn(async ({ where }) => rows.find((row) => row.id === where.id) ?? null) } as never,
			{ create: jest.fn(), update: jest.fn() } as never,
			{} as never,
			{ syncAll: jest.fn(async () => ({ batch_id: 'b-1' })) } as never,
			{} as never,
			{ findOne: jest.fn(() => lean(null)), updateMany: jest.fn(() => ({ exec: async () => ({}) })) } as never,
			config as never
		);

		jest.spyOn(adapter as unknown as { stripeClient: () => unknown }, 'stripeClient').mockImplementation(
			() =>
				({
					products: { list: jest.fn(async () => ({ data: [{ id: 'prod_1', name: 'Plan', description: null }] })) },
					balance: { retrieve: jest.fn(async () => ({ livemode: true, available: [{ currency: 'clp' }] })) },
				}) as never
		);

		return adapter;
	};

	it('lista las cuentas enmascaradas', async () => {
		const { data } = await make().listConnections(HOLDING);

		expect(data.map((view) => view.secrets.secret_key.secret_last4)).toEqual(['1111', '2222']);
		expect(JSON.stringify(data)).not.toContain('sk_live_aaaaaaaa1111');
	});

	it('la clave debe corresponder al modo', async () => {
		await expect(make().saveConnection(HOLDING, { name: 'Perú', mode: 'live', secret_key: 'sk_test_x' }, ACTOR)).rejects.toMatchObject({
			status: 400,
		});
		await expect(make().saveConnection(HOLDING, { name: 'chile', mode: 'live', secret_key: 'sk_live_x' }, ACTOR)).rejects.toMatchObject({
			status: 400,
		});
	});

	it('con varias cuentas activas, sincronizar exige connection_id', async () => {
		await expect(make().sync(HOLDING, ACTOR, {})).rejects.toMatchObject({ status: 400 });
		await expect(make().sync(HOLDING, ACTOR, { connection_id: 'a-2' })).resolves.toEqual(
			expect.objectContaining({ run_id: 'stripe-ingest:b-1' })
		);
	});

	it('prueba real por cuenta con balance.retrieve (mockeado)', async () => {
		await expect(make().testConnection(HOLDING, 'a-1')).resolves.toEqual(
			expect.objectContaining({ ok: true, details: { livemode: true, currencies: ['CLP'] } })
		);
	});

	it('mapeo por origen: una fila por producto de Stripe usado o mapeado; los de Sapira sin contraparte no cuentan', async () => {
		const query = jest.fn(async (sql: string) => {
			if (sql.includes('WITH u AS'))
				return [
					{ id: 'prod_1', subscriptions: 4, invoices: 10, account_id: 'a-1' },
					{ id: 'prod_9', subscriptions: 0, invoices: 2, account_id: 'a-2' },
				];
			if (sql.includes('FROM stripe_product_mappings')) return [{ sapira_product_id: 'p-1', stripe_product_id: 'prod_1' }];
			if (sql.includes('FROM products p'))
				return [
					{ id: 'p-1', name: 'Plan', product_code: null },
					{ id: 'p-2', name: 'Solo en Sapira', product_code: null },
					{ id: 'p-3', name: 'Otro de Sapira', product_code: null },
				];

			return [];
		});
		const adapter = new StripeAdapter(
			{ query } as never,
			{ find: jest.fn(async () => accounts) } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			config as never
		);

		jest.spyOn(adapter as unknown as { stripeClient: () => unknown }, 'stripeClient').mockImplementation(
			() => ({ products: { list: jest.fn(async () => ({ data: [{ id: 'prod_1', name: 'Plan', description: null }] })) } }) as never
		);
		const view = await adapter.getMapping(HOLDING, 'products', {});

		expect(view.anchor).toBe('external');
		expect(view.counts).toEqual({ total: 2, mapped: 1, unmapped: 1, suggested: 0 });
		expect(view.data.map((row) => [row.key, row.status, row.usage])).toEqual([
			['prod_9', 'unmapped', { subscriptions: 0, invoices: 2 }],
			['prod_1:p-1', 'mapped', { subscriptions: 4, invoices: 10 }],
		]);
		expect(view.data[0].external?.meta).toEqual({ account_id: 'a-2', account_name: 'México' });
		await expect(adapter.pendingMapping(HOLDING)).resolves.toBe(1);
	});

	it('los registros traen la cuenta de origen', () => {
		const [customers] = make().recordSources();

		expect(customers.hasAccount).toBe(true);
		expect(customers.sql).toContain('c.name AS account_name');
	});
});

describe('DatosAdapter', () => {
	const make = (query: jest.Mock = jest.fn(async () => [])) =>
		new DatosAdapter(
			{ query } as never,
			{
				find: jest.fn(async () => [
					{
						id: 'bq',
						holding_id: HOLDING,
						name: 'DWH',
						project_id: 'p',
						credentials: JSON.stringify({ client_email: 'sa@p.iam', private_key: 'k', private_key_id: 'abcdef123456' }),
						is_active: true,
					},
				]),
			} as never,
			{} as never,
			config as never
		);

	it('enmascara las credenciales (últimos 4 del private_key_id) y muestra el client_email', async () => {
		const view = await make().getConnection(HOLDING);

		expect(view.fields.client_email).toBe('sa@p.iam');
		expect(view.secrets.credentials).toEqual({ has_secret: true, secret_last4: '3456' });
		expect(JSON.stringify(view)).not.toContain('private_key"');
	});

	it('credenciales que no son de una cuenta de servicio → 400', async () => {
		await expect(make().saveConnection(HOLDING, { name: 'DWH', project_id: 'p', credentials: '{"a":1}' }, ACTOR)).rejects.toMatchObject({
			status: 400,
		});
	});

	it('cargas (A6): período, filas, nuevas y cambiadas respecto de la carga anterior', async () => {
		const query = jest.fn(async () => [
			{
				bucket: '2026-10-03T12:00:00Z',
				started: '2026-10-03T12:00:05Z',
				finished: '2026-10-03T12:02:00Z',
				periods: ['2026-10'],
				rows: 10,
				new_rows: 8,
				changed_rows: 2,
				changed_after_import: 1,
				unmapped: 3,
				errors: 4,
				integrated: 6,
			},
		]);
		const runs = await make(query).listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data[0]).toEqual(
			expect.objectContaining({
				id: 'datos-load:2026-10-03T12:00:00.000Z',
				kind: 'datos_load',
				status: 'partial',
				metrics: { periods: ['2026-10'], rows: 10, new_rows: 8, changed_rows: 2, changed_after_import: 1, unmapped: 3, errors: 4 },
			})
		);
	});

	it('importar consumos es por período, no por ids', async () => {
		await expect(make().importRecords(HOLDING, { object: 'consumption', ids: ['x'] })).rejects.toMatchObject({ status: 400 });
	});
});
