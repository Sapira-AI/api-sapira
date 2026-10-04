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
			entityErp: { link: jest.fn(async () => ({})), unlink: jest.fn(async () => ({})), searchForNew: jest.fn() },
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
			config as never,
			deps.entityErp as never
		);

		return { adapter, deps };
	};

	it('envío "en curso" huérfano (la API se reinició o pasó la ventana) → Interrumpida y no bloquea un envío nuevo', async () => {
		const orphan = {
			jobId: 'old',
			status: 'running',
			holdingId: HOLDING,
			// Mismo entorno que este proceso (NODE_ENV=test → unknown) e iniciado antes de que arrancara.
			executionEnvironment: 'unknown',
			startedAt: new Date(Date.now() - 60 * 60 * 1000),
			progress: { total: 10, sent: 3, errors: 0, skipped: 0 },
		};
		const { adapter, deps } = make({
			schedulerJobs: { find: jest.fn((filter: Record<string, unknown>) => ('$or' in filter ? chain([orphan]) : lean([orphan]))) },
		});

		await expect(adapter.sync(HOLDING, ACTOR)).resolves.toEqual(expect.objectContaining({ run_id: 'erp-send:job-1' }));
		expect(deps.invoiceScheduler.startSchedulerJob).toHaveBeenCalled();
		const [run] = (await adapter.listRuns(HOLDING, { page: 1, limit: 20 })).data;

		expect(run).toEqual(
			expect.objectContaining({ status: 'interrupted', error: 'La sincronización se interrumpió (la API se reinició). Vuelve a sincronizar.' })
		);
	});

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
		// En curso en otro entorno (no lo puede haber cortado el reinicio de este proceso) y dentro de la ventana → 409.
		const busy = make({
			schedulerJobs: {
				find: jest.fn(() => lean([{ jobId: 'x', status: 'running', startedAt: new Date(), executionEnvironment: 'production' }])),
			},
		});

		await expect(busy.adapter.sync(HOLDING, ACTOR)).rejects.toBeInstanceOf(ConflictException);
		const { adapter, deps } = make({ schedulerJobs: { find: jest.fn(() => lean([])) } });

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

	it('factura enviada: solo lo ejecutado (enviadas o con intento fallido), nombre legible y subestados', () => {
		const { adapter } = make();
		const invoice = adapter.recordSources({}).find((source) => source.object === 'invoice');

		expect(invoice).toEqual(expect.objectContaining({ hasSapiraLabel: true, hasDetail: true }));
		// Las Por Emitir que nunca se intentaron enviar se siguen en Facturación.
		expect(invoice?.sql).toContain('AND ((i.odoo_invoice_id IS NOT NULL OR i.sent_to_odoo_at IS NOT NULL) OR n.id IS NOT NULL)) x');
		expect(invoice?.sql).not.toContain('missing_customer');
		expect(invoice?.sql).not.toContain("'scheduled'");
		expect(invoice?.sql).toContain("WHEN 'send_error' THEN 'error' WHEN 'erp_draft' THEN 'pending' ELSE 'synced'");
		expect(invoice?.sql).not.toContain('erp_draft_stale');
		expect(invoice?.sql).toContain("'Enviada al ERP como borrador el ' || to_char(x.last_sync_at AT TIME ZONE");
		expect(invoice?.sql).toContain('COALESCE(i.sent_to_odoo_at, n.updated_at, i.created_at) AS last_sync_at');
		expect(invoice?.sql).toContain('ct.contract_number');
		expect(invoice?.sql).toContain("WHEN 'FACTURA' THEN 'Factura'");
		expect(adapter.recordSources({}).find((source) => source.object === 'customer')?.hasSapiraLabel).toBe(true);
	});

	it('compañías: todas las del holding; las que no facturan ni tienen contratos activos van Sin uso (sin sugerencia)', async () => {
		const companies = [
			{ id: 'c-1', legal_name: 'Simplit SpA', odoo_integration_id: 1, invoices: '10', contracts: '2', invoices_pending: '1' },
			{ id: 'c-2', legal_name: 'SimpliRoute S.A.S', odoo_integration_id: null, invoices: '0', contracts: '0', invoices_pending: '0' },
			{ id: 'c-3', legal_name: 'SimpliRoute INC', odoo_integration_id: null, invoices: '5', contracts: '0', invoices_pending: '0' },
		];
		const query = jest.fn(async () => companies);
		const { adapter } = make({ dataSource: { query } });

		(adapter as unknown as { odooService: unknown }).odooService = {
			getCompanies: jest.fn(async () => ({
				odoo_companies: [
					{ id: 1, name: 'Simplit' },
					{ id: 9, name: 'SimpliRoute S.A.S' },
				],
			})),
		};
		const view = await adapter.getMapping(HOLDING, 'companies', {});

		expect(String((query.mock.calls[0] as unknown[])[0])).not.toContain('EXISTS');
		expect(view.data.map((row) => [row.key, row.status])).toEqual([
			['c-1', 'mapped'],
			['c-2', 'unused'],
			['c-3', 'unmapped'],
		]);
		expect(view.counts).toEqual({ total: 3, mapped: 1, unmapped: 1, suggested: 0, unused: 1, not_applicable: 0 });
	});

	it('pendientes de mapeo: excluye las keys marcadas No aplica', async () => {
		const query = jest.fn(async () => [{ pending: '3' }]);
		const { adapter } = make({ dataSource: { query } });

		await expect(adapter.pendingMapping(HOLDING, { customers: ['e-9'], companies: ['c-2'] })).resolves.toBe(3);
		expect(query).toHaveBeenCalledWith(expect.stringContaining('ce.id::text <> ALL($4::text[])'), [HOLDING, [], ['c-2'], ['e-9']]);
	});

	describe('mapeo de clientes (razón social → cliente del ERP)', () => {
		const rows = [
			{
				id: 'e-1',
				legal_name: 'Acme SpA',
				tax_id: '76.397.190-2',
				odoo_partner_id: 55,
				partner_name: 'ACME SPA',
				partner_vat: '76397190-2',
				invoices_pending: '2',
				invoices: '9',
				contracts: '1',
			},
			{
				id: 'e-2',
				legal_name: 'Beta Ltda',
				tax_id: '77.000.111-K',
				odoo_partner_id: null,
				suggestion_count: '1',
				suggestion_id: 70,
				suggestion_name: 'BETA LTDA',
				suggestion_vat: '77000111-K',
				invoices_pending: '1',
				invoices: '1',
				contracts: '0',
			},
			{
				id: 'e-3',
				legal_name: 'Gamma SA',
				tax_id: '99.999.999-9',
				odoo_partner_id: null,
				suggestion_count: '2',
				invoices_pending: '0',
				invoices: '0',
				contracts: '2',
			},
		];
		const customers = () => {
			const query = jest.fn(async (sql: string) =>
				sql.includes('odoo_partners_stg') && sql.includes('WITH p AS') ? rows : [{ id: 'e-1' }, { id: 'e-2' }]
			);

			return make({ dataSource: { query } });
		};

		it('vinculada, sugerida por RUT (un solo candidato) o sin vincular; uso = facturas y contratos', async () => {
			const { adapter } = customers();
			const view = await adapter.getMapping(HOLDING, 'customers', {});

			expect(adapter.mappingObjects).toContain('customers');
			expect(view).toEqual(
				expect.objectContaining({
					object_label: 'Clientes',
					anchor: 'sapira',
					counts: { total: 3, mapped: 1, unmapped: 1, suggested: 1, unused: 0, not_applicable: 0 },
				})
			);
			expect(view.data[0]).toEqual(
				expect.objectContaining({
					status: 'mapped',
					external: { id: '55', label: 'ACME SPA', meta: { vat: '76397190-2' } },
					usage: { invoices_pending: 2, invoices: 9, contracts: 1 },
				})
			);
			expect(view.data[1]).toEqual(
				expect.objectContaining({ status: 'suggested', suggestion: expect.objectContaining({ id: '70', label: 'BETA LTDA' }) })
			);
			expect(view.data[2]).toEqual(expect.objectContaining({ status: 'unmapped', suggestion: null, meta: { candidates: 2 } }));
		});

		it('PUT vincula con las validaciones de la Razón social 360; las que fallan vuelven por fila', async () => {
			const { adapter, deps } = customers();

			deps.entityErp.link.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('El cliente #71 no existe o está archivado en el ERP'));
			await expect(
				adapter.putMapping(
					HOLDING,
					'customers',
					[
						{ sapira_id: 'e-1', external_id: '55' },
						{ sapira_id: 'e-2', external_id: '71' },
					],
					ACTOR
				)
			).rejects.toMatchObject({ status: 400 });
			expect(deps.entityErp.link).toHaveBeenNthCalledWith(1, HOLDING, 'e-1', 55);
			expect(deps.entityErp.link).toHaveBeenNthCalledWith(2, HOLDING, 'e-2', 71);
		});

		it('DELETE: 409 con impacto si hay facturas por enviar; con confirm desvincula', async () => {
			const { adapter, deps } = customers();

			await expect(adapter.deleteMapping(HOLDING, 'customers', 'e-1', '55', false)).rejects.toBeInstanceOf(ConflictException);
			expect(deps.entityErp.unlink).not.toHaveBeenCalled();
			await adapter.deleteMapping(HOLDING, 'customers', 'e-1', '55', true);
			expect(deps.entityErp.unlink).toHaveBeenCalledWith(HOLDING, 'e-1');
		});
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
			(overrides.syncComplete ?? {}) as never,
			(overrides.syncRuns ?? { createRun: jest.fn() }) as never,
			(overrides.staging ?? {}) as never,
			{ getQuoteTypeMappings: jest.fn(async () => []), createQuoteTypeMapping: jest.fn() } as never,
			(overrides.schedulerJobs ?? { findOne: jest.fn(() => lean(null)), find: jest.fn(() => lean([])), create: jest.fn() }) as never,
			{} as never,
			config as never
		);

	it('sincronizar: 409 si la corrida diaria o una ejecución está en curso', async () => {
		const adapter = make(jest.fn(async () => [{ id: 'run' }]));

		await expect(adapter.sync(HOLDING)).rejects.toBeInstanceOf(ConflictException);
	});

	it('"Sincronizar ahora" que quedó en curso al reiniciarse la API → Interrumpida y no bloquea; uno vivo de otro entorno sí bloquea', async () => {
		const orphan = {
			jobId: `salesforce-holding-sync:development:${HOLDING}:abc`,
			status: 'running',
			startedAt: new Date(Date.now() - 2 * 60 * 1000),
			executionEnvironment: 'development',
			holdingResults: [],
		};
		const create = jest.fn();
		const syncComplete = { syncDailyModifiedOpportunities: jest.fn(() => new Promise(() => undefined)) };
		const adapter = make(
			jest.fn(async () => []),
			{
				schedulerJobs: { find: jest.fn(() => lean([orphan])), create },
				syncComplete,
			}
		);

		await expect(adapter.sync(HOLDING)).resolves.toEqual(expect.objectContaining({ status: 'running' }));
		expect(create).toHaveBeenCalled();
		const elsewhere = make(
			jest.fn(async () => []),
			{
				schedulerJobs: { find: jest.fn(() => lean([{ ...orphan, executionEnvironment: 'production' }])), create },
			}
		);

		await expect(elsewhere.sync(HOLDING)).rejects.toBeInstanceOf(ConflictException);
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
		expect(view.counts).toEqual({ total: 1, mapped: 0, unmapped: 0, suggested: 1, unused: 0, not_applicable: 0 });
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

	it('recordHistory: logs de corridas diarias (Mongo) + ítems de ejecuciones (Postgres), filtrados por clave y en una lectura cada uno', async () => {
		const find = jest.fn(() => ({
			lean: () => ({
				exec: async () => [
					{
						jobId: 'salesforce-daily-sync:production:2026-09-26',
						level: 'error',
						occurredAt: new Date('2026-09-26T11:33:00Z'),
						salesforceOpportunityId: '006G',
						errorMessage: 'Productos Salesforce sin mapping activo: Bundle TMS-ADA (01tRO00000N9nnTYAR).',
					},
				],
			}),
		}));
		const query = jest.fn(async () => [
			{
				run_id: 'r-1',
				type: 'retry_full',
				at: new Date('2026-10-02T16:31:00Z'),
				salesforce_opportunity_id: '006G',
				status: 'completed',
				error_message: null,
			},
		]);
		const adapter = new CrmAdapter(
			{ query } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ find } as never,
			config as never
		);
		const since = new Date('2026-09-03T00:00:00Z');
		const history = await adapter.recordHistory(HOLDING, { since, keys: ['006G'] });

		expect(history).toEqual([
			expect.objectContaining({
				run_id: 'crm-job:salesforce-daily-sync:production:2026-09-26',
				kind: 'crm_daily',
				record_key: '006G',
				status: 'error',
			}),
			expect.objectContaining({ run_id: 'crm-run:r-1', kind: 'crm_retry', record_key: '006G', status: 'ok' }),
		]);
		expect(find).toHaveBeenCalledWith(
			expect.objectContaining({ holdingId: HOLDING, stage: 'opportunity', salesforceOpportunityId: { $in: ['006G'] } }),
			expect.anything()
		);
		expect(query).toHaveBeenCalledTimes(1);
		expect((query.mock.calls[0] as unknown[])[1]).toEqual([HOLDING, since, expect.any(Date), ['006G']]);
	});

	it('"En Sapira" legible: cuenta = nombre comercial del cliente; oportunidad = número de cotización · cliente', () => {
		const sources = make(jest.fn()).recordSources();
		const account = sources.find((item) => item.object === 'account');
		const opportunity = sources.find((item) => item.object === 'opportunity');

		expect(account).toEqual(expect.objectContaining({ hasSapiraLabel: true }));
		expect(account?.sql).toContain('c.name_commercial AS sapira_label');
		expect(opportunity).toEqual(expect.objectContaining({ hasSapiraLabel: true }));
		expect(opportunity?.sql).toContain("concat_ws(' · ', k.quote_number, cl.name_commercial)");
	});

	it('cuentas: change_kind nuevo/cambio y sapira_id del cliente vinculado', () => {
		const account = make(jest.fn())
			.recordSources()
			.find((item) => item.object === 'account');

		expect(account?.hasChangeKind).toBe(true);
		expect(account?.sql).toContain("WHEN s.processing_status IN ('update','to_update') THEN 'update'");
		expect(account?.sql).toContain('salesforce_account_id = s.salesforce_id');
	});

	it('diferencias de una cuenta: nombres legibles, sin el vínculo técnico, con lo que importar no pisa', async () => {
		const previewAccountChanges = jest.fn(async (_holding: string, id: string) =>
			id === 'nope'
				? null
				: {
						salesforce_id: id,
						processing_status: 'update',
						client_id: 'client-1',
						client_name: 'Acme',
						client_entity_id: 'entity-1',
						changes: [
							{ target: 'client', field: 'industry', current: 'Retail', incoming: 'Logística', applies: true },
							{ target: 'client', field: 'salesforce_account_id', current: null, incoming: id, applies: true },
							{ target: 'client_entity', field: 'legal_name', current: 'Acme SpA', incoming: 'Acme S.A.', applies: false },
							{ target: 'client_entity', field: 'odd_field', current: null, incoming: 'x', applies: true },
						],
					}
		);
		const adapter = make(
			jest.fn(async () => [{ label: 'Acme' }]),
			{ syncComplete: { previewAccountChanges } }
		);

		await expect(adapter.recordChanges(HOLDING, 'contact', '003')).resolves.toBeUndefined();
		await expect(adapter.recordChanges(HOLDING, 'account', 'nope')).resolves.toBeNull();
		const result = await adapter.recordChanges(HOLDING, 'account', '001A');

		expect(result).toEqual(
			expect.objectContaining({
				label: 'Acme',
				change_kind: 'update',
				sapira_id: 'client-1',
				sapira_label: 'Acme',
				available: true,
				message: null,
			})
		);
		expect(result?.changes).toEqual([
			{
				field: 'client.industry',
				label: 'Industria',
				target: 'client',
				target_label: 'Cliente',
				current: 'Retail',
				incoming: 'Logística',
				applies: true,
			},
			{
				field: 'client_entity.legal_name',
				label: 'Razón social',
				target: 'client_entity',
				target_label: 'Razón social',
				current: 'Acme SpA',
				incoming: 'Acme S.A.',
				applies: false,
			},
			expect.objectContaining({ field: 'client_entity.odd_field', label: 'Odd field' }),
		]);
	});

	describe('cotizaciones protegidas (Domi 03-10)', () => {
		const preview = (overrides: Record<string, unknown> = {}) => ({
			salesforce_id: '006A',
			label: 'Renovación Acme',
			processing_status: 'update',
			quote_id: 'quote-1',
			quote_label: 'COT-2026-0001 · Acme',
			protection: null,
			has_snapshot: true,
			last_imported_at: new Date('2026-09-01T00:00:00Z'),
			changes: [
				{
					scope: 'quote',
					field: 'quote.total_amount',
					label: 'Total',
					item_key: null,
					item_label: null,
					item_action: null,
					before: 100,
					after: 120,
				},
				{
					scope: 'quote_item',
					field: 'quote_item.00k1.quantity',
					label: 'Cantidad',
					item_key: '00k1',
					item_label: 'Plan Pro',
					item_action: 'changed',
					before: 1,
					after: 2,
				},
				{
					scope: 'quote_item',
					field: 'quote_item.00k2.product_id',
					label: 'Producto',
					item_key: '00k2',
					item_label: 'Soporte',
					item_action: 'added',
					before: null,
					after: 'p-2',
				},
			],
			...overrides,
		});

		it('diferencias de una oportunidad: CRM en la última importación → CRM ahora, aplicables con confirmación', async () => {
			const previewOpportunityChanges = jest.fn(async (_holding: string, id: string) => (id === 'nope' ? null : preview()));
			const adapter = make(jest.fn(), { syncComplete: { previewOpportunityChanges } });

			await expect(adapter.recordChanges(HOLDING, 'opportunity', 'nope')).resolves.toBeNull();
			const result = await adapter.recordChanges(HOLDING, 'opportunity', '006A');

			expect(previewOpportunityChanges).toHaveBeenCalledWith(HOLDING, '006A');
			expect(result).toEqual(
				expect.objectContaining({
					label: 'Renovación Acme',
					change_kind: 'update',
					sapira_id: 'quote-1',
					sapira_label: 'COT-2026-0001 · Acme',
					available: true,
					message: expect.stringContaining('solo si confirmas'),
				})
			);
			expect(result?.changes).toEqual([
				{
					field: 'quote.total_amount',
					label: 'Total',
					target: 'quote',
					target_label: 'Cotización',
					current: 100,
					incoming: 120,
					applies: true,
				},
				expect.objectContaining({ field: 'quote_item.00k1.quantity', target: 'quote_item', target_label: 'Ítem: Plan Pro', applies: true }),
				expect.objectContaining({ target_label: 'Ítem: Soporte (nuevo en el CRM)', current: null, incoming: 'p-2' }),
			]);
		});

		it('diferencias de una oportunidad con contrato: sin change_kind, nada aplicable y el motivo', async () => {
			const adapter = make(jest.fn(), {
				syncComplete: { previewOpportunityChanges: jest.fn(async () => preview({ protection: 'contract' })) },
			});
			const result = await adapter.recordChanges(HOLDING, 'opportunity', '006A');

			expect(result).toEqual(expect.objectContaining({ change_kind: null, message: 'La cotización ya tiene contrato: no se actualiza' }));
			expect(result?.changes.every((change) => change.applies === false)).toBe(true);
		});

		it('sin snapshot previo: sin diferencias y la cotización no cambia', async () => {
			const adapter = make(jest.fn(), {
				syncComplete: {
					previewOpportunityChanges: jest.fn(async () => preview({ has_snapshot: false, processing_status: 'processed', changes: [] })),
				},
			});

			await expect(adapter.recordChanges(HOLDING, 'opportunity', '006A')).resolves.toEqual(
				expect.objectContaining({ change_kind: null, changes: [], message: expect.stringContaining('la cotización no cambia') })
			);
		});

		it('/records: protegida → importada con su rótulo y sin change_kind; cambio del CRM → crm_changed', () => {
			const opportunity = make(jest.fn())
				.recordSources()
				.find((item) => item.object === 'opportunity');

			expect(opportunity).toEqual(expect.objectContaining({ hasChangeKind: true, hasDetail: true, hasStatusLabel: true }));
			expect(opportunity?.sql).toContain('CASE WHEN q.protection IS NOT NULL THEN NULL');
			expect(opportunity?.sql).toContain("'Cotización con contrato: no se actualiza'");
			expect(opportunity?.sql).toContain("'Procesada previamente: no se actualiza'");
			expect(opportunity?.sql).toContain("THEN 'crm_changed'");
			expect(opportunity?.sql).toContain('ci.quote_item_id = qi.id');
			expect(opportunity?.sql).toContain("qs.kind = 'contract_created'");
			expect(opportunity?.sql).toContain("- 'last_imported_snapshot'");
		});

		it('importar por ids con confirm_updates deja quién confirmó; con all solo lo nuevo y sin confirmación', async () => {
			const createRun = jest.fn(async (_holding: string, _type: string, ids: string[]) => ({ id: 'run-1', total_items: ids.length }));
			const getEligibleOpportunityIdsForProcessing = jest.fn(async () => ['006N']);
			const adapter = make(jest.fn(), { syncRuns: { createRun }, staging: { getEligibleOpportunityIdsForProcessing } });
			const actor = { authId: 'auth-1', userId: 'user-1' };

			const confirmed = await adapter.importRecords(HOLDING, { object: 'opportunity', ids: ['006A'], confirm_updates: true }, actor, new Set());
			expect(createRun).toHaveBeenLastCalledWith(HOLDING, 'process_final', ['006A'], { confirmedBy: 'user-1' });
			expect(confirmed.message).toContain('cambios confirmados');

			await adapter.importRecords(HOLDING, { object: 'opportunity', ids: ['006A'] }, actor, new Set());
			expect(createRun).toHaveBeenLastCalledWith(HOLDING, 'process_final', ['006A'], { confirmedBy: null });

			await adapter.importRecords(HOLDING, { object: 'opportunity', all: true, confirm_updates: true }, actor, new Set());
			expect(getEligibleOpportunityIdsForProcessing).toHaveBeenCalledWith(HOLDING, ['create']);
			expect(createRun).toHaveBeenLastCalledWith(HOLDING, 'process_final', ['006N'], { confirmedBy: null });

			await expect(
				adapter.importRecords(
					HOLDING,
					{ object: 'opportunity', ids: ['006A'], confirm_updates: true },
					{ authId: 'a', userId: null },
					new Set()
				)
			).rejects.toMatchObject({ status: 400 });
		});
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
		expect(view.counts).toEqual({ total: 2, mapped: 1, unmapped: 1, suggested: 0, unused: 0, not_applicable: 0 });
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

	it('"En Sapira" legible: cliente (nombre comercial), suscripción (cliente) e invoice (número · cliente)', () => {
		const [customers, subscriptions, invoices] = make().recordSources();

		for (const source of [customers, subscriptions, invoices]) expect(source.hasSapiraLabel).toBe(true);
		expect(customers.sql).toContain('k.stripe_customer_id = s.stripe_id');
		expect(subscriptions.sql).toContain('k.external_id = s.stripe_id');
		expect(invoices.sql).toContain("concat_ws(' · ', k.invoice_number, cl.name_commercial)");
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
