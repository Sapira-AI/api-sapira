/**
 * "Sincronizar ahora" e "Importar" de punta a punta: cada adaptador con el **servicio real** de su módulo (Stripe, Salesforce, envío
 * al ERP, importación del ERP, BigQuery). Solo se reemplaza la frontera externa (SDK de Stripe, consulta a Salesforce, cliente de
 * BigQuery) y el almacenamiento (Mongo/Postgres en memoria). Se verifica: holding del header, parámetros que llegan al sistema, 409
 * con una corrida en curso, `run_id` que el front puede seguir y que `runs` muestra esa corrida.
 */
const stripeInvoicesList = jest.fn();
const bigQueryQuery = jest.fn();

jest.mock('stripe', () => ({
	__esModule: true,
	default: jest.fn().mockImplementation(() => ({ invoices: { list: stripeInvoicesList } })),
}));
jest.mock('uuid', () => ({ v4: () => jest.requireActual<typeof import('crypto')>('crypto').randomUUID() }));
jest.mock('@google-cloud/bigquery', () => ({ BigQuery: jest.fn().mockImplementation(() => ({ query: bigQueryQuery })) }));

import { ConflictException } from '@nestjs/common';

import { BigQueryService } from '@/modules/bigquery/bigquery.service';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';
import { InvoiceProcessingService } from '@/modules/odoo/invoice-processing.service';
import { SalesforceSyncCompleteService } from '@/modules/salesforce/services/salesforce-sync-complete.service';
import { SalesforceSyncRunService } from '@/modules/salesforce/services/salesforce-sync-run.service';
import { StripeIntegrationLogService } from '@/modules/stripe/services/stripe-integration-log.service';
import { StripeSyncService } from '@/modules/stripe/services/stripe-sync.service';
import { StripeIngestionService } from '@/modules/stripe/stripe-ingestion.service';

import { CrmAdapter } from './adapters/crm.adapter';
import { DatosAdapter } from './adapters/datos.adapter';
import { ErpAdapter } from './adapters/erp.adapter';
import { StripeAdapter } from './adapters/stripe.adapter';

type Doc = Record<string, unknown>;

const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const config = { get: jest.fn(() => undefined) };
const flush = async (times = 5) => {
	for (let index = 0; index < times; index++) await new Promise((resolve) => setImmediate(resolve));
};

// ── Mongo en memoria (lo justo que usan los servicios y adaptadores) ─────────────────────────────────────────────────────────

const valueAt = (doc: Doc, path: string): unknown => path.split('.').reduce<unknown>((value, key) => (value as Doc | undefined)?.[key], doc);

function matches(doc: Doc, filter: Doc): boolean {
	return Object.entries(filter).every(([key, condition]) => {
		if (key === '$or') return (condition as Doc[]).some((item) => matches(doc, item));
		const value = valueAt(doc, key);
		const values = Array.isArray(value) ? value : [value];

		if (condition instanceof RegExp) return values.some((item) => typeof item === 'string' && condition.test(item));
		if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
			const ops = condition as Doc;

			return (
				(!('$in' in ops) || values.some((item) => (ops.$in as unknown[]).includes(item))) &&
				(!('$gte' in ops) || (value instanceof Date && value >= (ops.$gte as Date)))
			);
		}
		if (key.includes('.') && Array.isArray(valueAt(doc, key.split('.')[0])))
			return (valueAt(doc, key.split('.')[0]) as Doc[]).some((item) => item[key.split('.')[1]] === condition);

		return values.includes(condition);
	});
}

function memoryModel() {
	const docs: Doc[] = [];
	const query = (result: () => unknown) => {
		const chain = {
			sort: () => chain,
			limit: () => chain,
			lean: () => chain,
			exec: async () => result(),
			then: (ok: (v: unknown) => void) => ok(result()),
		};

		return chain;
	};
	const apply = (doc: Doc, update: Doc) => Object.assign(doc, (update.$set as Doc) ?? update);
	const Model = function (this: Doc, data: Doc) {
		Object.assign(this, data);
		(this as { save: () => Promise<Doc> }).save = async () => {
			const plain = Object.fromEntries(Object.entries(this as Doc).filter(([key]) => key !== 'save'));

			docs.push(plain);

			return plain;
		};
	} as unknown as {
		new (data: Doc): Doc;
		docs: Doc[];
		find: (filter: Doc) => ReturnType<typeof query>;
		findOne: (filter: Doc) => ReturnType<typeof query>;
		create: (data: Doc) => Promise<Doc>;
		updateOne: (filter: Doc, update: Doc) => ReturnType<typeof query>;
		updateMany: (filter: Doc, update: Doc) => ReturnType<typeof query>;
		findOneAndUpdate: (filter: Doc, update: Doc) => ReturnType<typeof query>;
		aggregate: () => ReturnType<typeof query>;
	};

	Model.docs = docs;
	Model.find = (filter) => query(() => docs.filter((doc) => matches(doc, filter)));
	Model.findOne = (filter) => query(() => docs.find((doc) => matches(doc, filter)) ?? null);
	Model.create = async (data) => {
		docs.push({ ...data });

		return data;
	};
	Model.updateOne = (filter, update) =>
		query(() => {
			const doc = docs.find((item) => matches(item, filter));

			if (doc) apply(doc, update);

			return { modifiedCount: doc ? 1 : 0 };
		});
	Model.updateMany = (filter, update) =>
		query(() => {
			const found = docs.filter((item) => matches(item, filter));

			found.forEach((doc) => apply(doc, update));

			return { modifiedCount: found.length };
		});
	Model.findOneAndUpdate = (filter, update) =>
		query(() => {
			const doc = docs.find((item) => matches(item, filter));

			if (doc) apply(doc, update);

			return doc ?? null;
		});
	Model.aggregate = () => query(() => []);

	return Model;
}

// ── Stripe ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Stripe · Sincronizar ahora e Importar (servicios reales, SDK de Stripe mockeado)', () => {
	const accounts = [
		{ id: 'a-1', holding_id: HOLDING, name: 'Chile', mode: 'live', secret_key: 'sk_live_chile', is_active: true },
		{ id: 'a-2', holding_id: HOLDING, name: 'México', mode: 'live', secret_key: 'sk_live_mexico', is_active: true },
	];
	const setup = () => {
		const logs = memoryModel();
		const jobs: Doc[] = [];
		const connectionService = {
			findOne: jest.fn(async (id: string, holdingId: string) => accounts.find((row) => row.id === id && row.holding_id === holdingId)),
			updateLastSyncAt: jest.fn(async () => undefined),
		};
		const ingestion = new StripeIngestionService(
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			connectionService as never,
			new StripeIntegrationLogService(logs as never)
		);
		const failingQuery = () => {
			throw new Error('sin datos en el test');
		};
		const stripeSync = new StripeSyncService(
			{ createQueryBuilder: failingQuery } as never,
			{ createQueryBuilder: failingQuery } as never,
			{ createQueryBuilder: failingQuery } as never,
			{
				save: jest.fn(async (job: Doc) => {
					const saved = { ...job, id: `job-${jobs.length + 1}`, created_at: new Date() };

					jobs.push(saved);

					return saved;
				}),
				update: jest.fn(async (id: string, values: Doc) => Object.assign(jobs.find((job) => job.id === id) ?? {}, values)),
			} as never
		);
		const dataSource = {
			query: jest.fn(async (sql: string, params: unknown[]) => {
				if (sql.includes('FROM stripe_sync_jobs WHERE holding_id = $1 AND status')) {
					return jobs.filter((job) => job.holding_id === params[0] && job.status === 'running');
				}
				if (sql.includes('FROM stripe_sync_jobs WHERE id::text'))
					return jobs.filter((job) => job.id === params[0] && job.holding_id === params[1]);
				if (sql.includes('FROM stripe_sync_jobs')) return jobs.filter((job) => job.holding_id === params[0]);

				return [];
			}),
		};
		const adapter = new StripeAdapter(
			dataSource as never,
			{
				find: jest.fn(async ({ where }) => accounts.filter((row) => row.holding_id === where.holding_id)),
				findOne: jest.fn(async ({ where }) => accounts.find((row) => row.id === where.id && row.holding_id === where.holding_id) ?? null),
			} as never,
			{} as never,
			{} as never,
			ingestion,
			stripeSync,
			logs as never,
			config as never
		);

		return { adapter, logs, jobs, connectionService };
	};

	beforeEach(() => {
		stripeInvoicesList.mockReset();
		stripeInvoicesList.mockResolvedValue({ data: [], has_more: false });
	});

	it('sincroniza la cuenta elegida del holding con fechas inclusivas, queda en runs como manual y bloquea otra en curso', async () => {
		const { adapter, logs, connectionService } = setup();

		await expect(adapter.sync(HOLDING, ACTOR, {})).rejects.toMatchObject({ status: 400 });
		await expect(adapter.sync(OTHER, ACTOR, { connection_id: 'a-2' })).rejects.toMatchObject({ status: 404 });
		const started = await adapter.sync(HOLDING, ACTOR, { connection_id: 'a-2', date_from: '2026-10-01', date_to: '2026-10-03' });

		expect(started.run_id).toMatch(/^stripe-ingest:/);
		expect(logs.docs).toHaveLength(3);
		expect(logs.docs.every((doc) => doc.holding_id === HOLDING && doc.connection_id === 'a-2' && doc.user_id === 'auth-1')).toBe(true);
		// Mientras corre, otra sincronización de esa cuenta → 409.
		await expect(adapter.sync(HOLDING, ACTOR, { connection_id: 'a-2' })).rejects.toBeInstanceOf(ConflictException);
		await flush(20);

		expect(connectionService.findOne).toHaveBeenCalledWith('a-2', HOLDING);
		expect(stripeInvoicesList).toHaveBeenCalledWith(
			expect.objectContaining({
				created: {
					gte: Date.parse('2026-10-01T00:00:00.000Z') / 1000,
					lte: Math.floor(Date.parse('2026-10-03T23:59:59.999Z') / 1000),
				},
			})
		);
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(logs.docs.map((doc) => doc.error_details)).toEqual([undefined, undefined, undefined]);
		expect(runs.data).toEqual([
			expect.objectContaining({
				id: started.run_id,
				kind: 'stripe_ingest',
				trigger: 'manual',
				status: 'completed',
				metrics: expect.objectContaining({ account_id: 'a-2', account_name: 'México' }),
			}),
		]);
		await expect(adapter.getRun(HOLDING, started.run_id as string)).resolves.toEqual(expect.objectContaining({ id: started.run_id }));
	});

	it('importar a Sapira crea el trabajo del holding, sale en runs y 409 mientras corre', async () => {
		const { adapter, jobs } = setup();
		const started = await adapter.importRecords(HOLDING, { object: 'invoice', all: true });

		expect(started).toEqual(expect.objectContaining({ run_id: 'stripe-import:job-1', status: 'running' }));
		expect(jobs[0]).toEqual(expect.objectContaining({ holding_id: HOLDING }));
		// El trabajo real falla (sin tablas en el test) y queda registrado; uno en curso bloquea el siguiente.
		jobs.push({ id: 'job-x', holding_id: HOLDING, status: 'running', created_at: new Date() });
		await expect(adapter.importRecords(HOLDING, { object: 'invoice', all: true })).rejects.toBeInstanceOf(ConflictException);
		await flush();
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data.map((run) => run.id)).toEqual(expect.arrayContaining(['stripe-import:job-1']));
		const detail = await adapter.getRun(HOLDING, 'stripe-import:job-1');

		expect(detail.status).toBe('failed');
		expect(detail.records[0]).toEqual(expect.objectContaining({ status: 'error', message: 'sin datos en el test' }));
	});
});

// ── CRM (Salesforce) ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('CRM · Sincronizar ahora e Importar (servicios reales, consulta a Salesforce mockeada)', () => {
	const setup = () => {
		const schedulerJobs = memoryModel();
		const syncLogs = memoryModel();
		const runs: Doc[] = [];
		const items: Doc[] = [];
		const queryService = { executeQuery: jest.fn(async () => ({ data: { records: [] } })) };
		const syncComplete = new SalesforceSyncCompleteService(
			...([
				{},
				{},
				{},
				{},
				{},
				{},
				{},
				{},
				queryService,
				{},
				{},
				{},
				{},
				{},
				{ resolveOpen: jest.fn(async () => undefined) },
				{ record: jest.fn(async () => undefined) },
			] as unknown as ConstructorParameters<typeof SalesforceSyncCompleteService>)
		);
		const runRepository = {
			findOne: jest.fn(
				async ({ where }) =>
					runs.find((run) => run.holding_id === where.holding_id && run.type === where.type && run.status === 'running') ?? null
			),
		};
		const syncRuns = new SalesforceSyncRunService(
			runRepository as never,
			{} as never,
			{
				transaction: async (work: (manager: unknown) => Promise<unknown>) =>
					work({
						create: (_entity: unknown, data: Doc) => data,
						save: async (data: Doc) => {
							const run = { ...data, id: `run-${runs.length + 1}`, status: 'queued', created_at: new Date() };

							runs.push(run);

							return run;
						},
						insert: async (_entity: unknown, rows: Doc[]) => items.push(...rows),
					}),
			} as never
		);
		const staging = { getEligibleOpportunityIdsForProcessing: jest.fn(async () => ['006A', '006B', '006C']) };
		const dataSource = {
			query: jest.fn(async (sql: string, params: unknown[]) => {
				if (sql.includes('FROM salesforce_sync_runs WHERE holding_id = $1 AND status')) return [];
				if (sql.includes('FROM salesforce_sync_runs')) return runs.filter((run) => run.holding_id === params[0]);

				return [];
			}),
		};
		const adapter = new CrmAdapter(
			dataSource as never,
			{
				findOne: jest.fn(async ({ where }) => (where.holding_id === HOLDING ? { id: 'sf', holding_id: HOLDING, is_active: true } : null)),
			} as never,
			{} as never,
			{} as never,
			syncComplete,
			syncRuns,
			staging as never,
			{} as never,
			schedulerJobs as never,
			syncLogs as never,
			config as never
		);

		return { adapter, schedulerJobs, runs, items, queryService };
	};

	it('sincronizar corre la diaria del holding contra el CRM, termina y sale en runs como manual; 409 mientras corre', async () => {
		const { adapter, schedulerJobs, queryService } = setup();

		await expect(adapter.sync(OTHER)).rejects.toMatchObject({ status: 400 });
		const started = await adapter.sync(HOLDING);

		expect(started.run_id).toMatch(new RegExp(`^crm-job:salesforce-holding-sync:[^:]+:${HOLDING}:`));
		await expect(adapter.sync(HOLDING)).rejects.toBeInstanceOf(ConflictException);
		await flush(10);

		expect(queryService.executeQuery).toHaveBeenCalledWith(expect.stringContaining('FROM Opportunity'), HOLDING);
		expect(schedulerJobs.docs[0]).toEqual(
			expect.objectContaining({ status: 'completed', holdingResults: [expect.objectContaining({ holding_id: HOLDING, success: true })] })
		);
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data).toEqual([expect.objectContaining({ id: started.run_id, kind: 'crm_manual', trigger: 'manual', status: 'completed' })]);
		await expect(adapter.getRun(HOLDING, started.run_id as string)).resolves.toEqual(expect.objectContaining({ id: started.run_id }));
	});

	it('importar oportunidades: ejecución process_final del holding sin descartados, sale en runs; 409 con otra en curso', async () => {
		const { adapter, runs, items } = setup();
		const started = await adapter.importRecords(HOLDING, { object: 'opportunity', all: true }, ACTOR, new Set(['006B']));

		expect(started).toEqual({ run_id: 'crm-run:run-1', status: 'running', message: expect.any(String), accepted: 2 });
		expect(runs[0]).toEqual(expect.objectContaining({ holding_id: HOLDING, type: 'process_final', total_items: 2 }));
		expect(items.map((item) => item.salesforce_opportunity_id)).toEqual(['006A', '006C']);
		runs[0].status = 'running';
		await expect(adapter.importRecords(HOLDING, { object: 'opportunity', ids: ['006A'] }, ACTOR, new Set())).rejects.toBeInstanceOf(
			ConflictException
		);
		const list = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(list.data).toEqual([expect.objectContaining({ id: 'crm-run:run-1', kind: 'crm_import', status: 'running' })]);
	});

	it('traer e importar oportunidades elegidas (retry_full) o solo a revisión (update_staging)', async () => {
		const { adapter, runs } = setup();

		await expect(adapter.importOpportunities(HOLDING, ['006A', '006A', '006B'], 'full')).resolves.toEqual(
			expect.objectContaining({ run_id: 'crm-run:run-1', accepted: 2 })
		);
		await adapter.importOpportunities(HOLDING, ['006C'], 'review');

		expect(runs.map((run) => run.type)).toEqual(['retry_full', 'update_staging']);
		expect((await adapter.listRuns(HOLDING, { page: 1, limit: 20 })).data.map((run) => run.kind).sort()).toEqual(['crm_retry', 'crm_staging']);
	});
});

// ── ERP (Odoo) ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('ERP · Sincronizar ahora (envío) e Importar facturas (servicios reales)', () => {
	const setup = (stagingFind: () => Promise<unknown[]> = async () => []) => {
		const jobs = memoryModel();
		const wheres: unknown[] = [];
		const queryBuilder: Record<string, unknown> = {};

		for (const method of ['leftJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy']) {
			queryBuilder[method] = (...args: unknown[]) => {
				wheres.push(args);

				return queryBuilder;
			};
		}
		queryBuilder.getMany = async () => [];
		const scheduler = new InvoiceSchedulerService(
			...([
				{ createQueryBuilder: () => queryBuilder },
				{},
				{},
				{},
				{},
				{},
				{},
				{},
				{},
				memoryModel(),
				jobs,
				{},
				{},
				{},
				{},
				{},
				{ emitJobStarted: jest.fn(), emitJobProgress: jest.fn(), emitJobCompleted: jest.fn(), emitJobFailed: jest.fn() },
				{ resolveOpen: jest.fn(), upsertOpen: jest.fn() },
			] as unknown as ConstructorParameters<typeof InvoiceSchedulerService>)
		);

		jest.spyOn(scheduler as unknown as { sendErrorSummaryNotification: () => Promise<void> }, 'sendErrorSummaryNotification').mockResolvedValue();
		const processing = new InvoiceProcessingService(
			{ find: jest.fn(stagingFind), count: jest.fn(async () => 0), update: jest.fn() } as never,
			{} as never,
			{ getMappingConfig: jest.fn(async () => null) } as never,
			{} as never
		);
		const adapter = new ErpAdapter(
			{ query: jest.fn(async () => []) } as never,
			{
				find: jest.fn(async ({ where }) => (where.holding_id === HOLDING ? [{ id: 'c-1', holding_id: HOLDING, is_active: true }] : [])),
			} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			processing,
			{} as never,
			scheduler,
			jobs as never,
			config as never
		);

		return { adapter, jobs, wheres };
	};

	it('sincronizar envía las facturas del holding (no simulación), sale en runs; 409 mientras corre', async () => {
		const { adapter, jobs, wheres } = setup();

		await expect(adapter.sync(OTHER, ACTOR)).rejects.toMatchObject({ status: 400 });
		const started = await adapter.sync(HOLDING, ACTOR);

		expect(started.run_id).toMatch(/^erp-send:/);
		expect(jobs.docs[0]).toEqual(expect.objectContaining({ holdingId: HOLDING, dryRun: false, userId: 'auth-1', status: 'pending' }));
		await expect(adapter.sync(HOLDING, ACTOR)).rejects.toBeInstanceOf(ConflictException);
		await flush(10);

		expect(wheres).toEqual(expect.arrayContaining([['inv.holding_id = :holdingId', { holdingId: HOLDING }]]));
		expect(jobs.docs[0].status).toBe('completed');
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data).toEqual([expect.objectContaining({ id: started.run_id, kind: 'export_invoices', trigger: 'manual', status: 'completed' })]);
	});

	it('importar facturas del ERP: la corrida sale en runs (antes solo por id) y otra en curso → 409', async () => {
		const { adapter } = setup(() => new Promise(() => undefined));
		const started = await adapter.importRecords(HOLDING, { object: 'erp_invoice', all: true }, ACTOR, new Set());

		expect(started.run_id).toMatch(/^erp-import:proc_/);
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data).toEqual([expect.objectContaining({ id: started.run_id, kind: 'import_invoices', status: 'running' })]);
		expect((await adapter.listRuns(OTHER, { page: 1, limit: 20 })).data).toEqual([]);
		await expect(adapter.importRecords(HOLDING, { object: 'erp_invoice', all: true }, ACTOR, new Set())).rejects.toBeInstanceOf(
			ConflictException
		);
	});
});

// ── Almacén de datos (BigQuery) ──────────────────────────────────────────────────────────────────────────────────────────────

describe('Almacén de datos · Sincronizar ahora e Importar (BigQueryService real, cliente de BigQuery mockeado)', () => {
	const connection = {
		id: 'bq',
		holding_id: HOLDING,
		name: 'DWH',
		project_id: 'p',
		credentials: JSON.stringify({ client_email: 'sa@p.iam', private_key: 'k', private_key_id: 'abcdef123456' }),
		is_active: true,
	};
	const setup = (pendingPeriods: Doc = { min_period: '2026-07', max_period: '2026-09' }) => {
		const find = jest.fn(async () => []);
		const bigQuery = new BigQueryService(
			{} as never,
			{ findOne: jest.fn(async () => connection), find: jest.fn(async () => [connection]) } as never,
			{ find, findOne: jest.fn(async () => null) } as never,
			new Proxy({}, { get: () => jest.fn(async () => undefined) }) as never,
			{ query: jest.fn(async () => []) } as never
		);
		const adapter = new DatosAdapter(
			{ query: jest.fn(async (sql: string) => (sql.includes('min(period)') ? [pendingPeriods] : [])) } as never,
			{ find: jest.fn(async ({ where }) => (where.holding_id === HOLDING ? [connection] : [])) } as never,
			bigQuery,
			config as never
		);

		return { adapter, find };
	};

	beforeEach(() => {
		bigQueryQuery.mockReset();
		bigQueryQuery.mockResolvedValue([[]]);
	});

	it('sincronizar consulta el almacén con el rango pedido, la corrida sale en runs; una sola fecha → 400', async () => {
		const { adapter } = setup();

		await expect(adapter.sync(HOLDING, ACTOR, { date_from: '2026-09-01' })).rejects.toMatchObject({ status: 400 });
		await expect(adapter.sync(OTHER, ACTOR, {})).rejects.toMatchObject({ status: 400 });
		const started = await adapter.sync(HOLDING, ACTOR, { date_from: '2026-09-01', date_to: '2026-09-30' });

		expect(started.run_id).toMatch(/^datos-manual:/);
		await expect(adapter.sync(HOLDING, ACTOR, {})).rejects.toBeInstanceOf(ConflictException);
		await flush(10);

		expect(bigQueryQuery).toHaveBeenCalledWith(expect.objectContaining({ params: { from: '2026-09-01', to: '2026-09-30' } }));
		const runs = await adapter.listRuns(HOLDING, { page: 1, limit: 20 });

		expect(runs.data).toEqual([expect.objectContaining({ id: started.run_id, kind: 'datos_sync', status: 'completed' })]);
	});

	it('importar sin período abarca todos los meses con consumos por importar (no solo el mes en curso)', async () => {
		const { adapter, find } = setup();
		const started = await adapter.importRecords(HOLDING, { object: 'consumption', all: true });

		await flush(10);
		const where = (find.mock.calls[0] as unknown as [{ where: Doc }])[0].where;

		expect(where.holding_id).toBe(HOLDING);
		expect(JSON.stringify(where.period)).toContain('2026-07-01');
		expect(JSON.stringify(where.period)).toContain('2026-09-01');
		expect((await adapter.listRuns(HOLDING, { page: 1, limit: 20 })).data).toEqual([
			expect.objectContaining({ id: started.run_id, kind: 'datos_import', status: 'completed' }),
		]);
		await expect(
			setup({ min_period: null, max_period: null }).adapter.importRecords(HOLDING, { object: 'consumption', all: true })
		).rejects.toMatchObject({
			status: 400,
		});
	});
});
