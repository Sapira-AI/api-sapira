jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { IntegrationsService } from './integrations.service';
import { RecordSource } from './integrations.types';

const HOLDING = 'h-1';

const source = (object: string, extra: Partial<RecordSource> = {}): RecordSource => ({
	object,
	label: object,
	table: `${object}_stg`,
	direction: 'import',
	importable: true,
	importByIds: true,
	sql: `SELECT * FROM ${object}_stg WHERE holding_id = $1`,
	...extra,
});

function adapter(tipo: string, sources: RecordSource[], defaultRules: Record<string, unknown> = {}) {
	return {
		tipo,
		mappingObjects: ['products', 'fields'],
		defaultRules,
		recordSources: jest.fn(() => sources),
		importRecords: jest.fn(async () => ({ run_id: 'r', status: 'running', message: 'ok', accepted: 2 })),
		deleteImpact: jest.fn(async () => [] as Array<{ field: string; message: string }>),
		deleteConnection: jest.fn(async () => undefined),
		getMapping: jest.fn(),
		putMapping: jest.fn(async () => undefined),
		getConnection: jest.fn(),
		listRuns: jest.fn(),
		pendingMapping: jest.fn(),
		schedule: jest.fn(() => ({ daily_at: '08:30', timezone: 'America/Santiago', enabled: true, next_at: null })),
	};
}

describe('IntegrationsService', () => {
	let settings: Record<string, unknown>;
	let queries: Array<{ sql: string; params: unknown[] }>;
	let records: Array<Record<string, unknown>>;
	let autoEnabled: boolean | undefined;
	let upserts: Array<Record<string, unknown>>;
	/** `holding_integration_settings`: una fila por holding e integración (`auto_enabled` + `settings`); fila ausente = habilitado. */
	const integrationSettings = {
		findOne: jest.fn(async () =>
			Object.keys(settings).length || autoEnabled !== undefined ? { settings, auto_enabled: autoEnabled ?? true } : null
		),
		upsert: jest.fn(async (values: Record<string, unknown>) => {
			upserts.push(values);
			if (values.settings) settings = values.settings as Record<string, unknown>;
			if (typeof values.auto_enabled === 'boolean') autoEnabled = values.auto_enabled;
		}),
	};
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			queries.push({ sql, params });
			if (sql.includes('INSERT INTO integration_record_discards')) return (params[3] as string[]).map((key) => ({ id: key }));
			if (sql.includes('information_schema.columns')) return [{ column_name: 'salesforce_id', data_type: 'text' }];
			if (sql.includes('AS c0')) return [{ c0: 'ana@acme.cl', c1: '0' }];
			if (sql.includes('FROM roles')) return params[0] === 'role-tech' ? [{ name: 'Admin Técnico' }] : [{ name: 'Ventas' }];
			if (sql.includes('GROUP BY status'))
				return [
					{ status: 'ready', change_kind: 'new', n: 2 },
					{ status: 'pending', change_kind: 'update', n: 1 },
					{ status: 'imported', change_kind: null, n: 5 },
					{ status: 'discarded', n: 1 },
					{ status: 'excluded_by_rule', n: 2 },
				];
			if (sql.includes('GROUP BY object')) return [{ object: 'opportunity', n: 8 }];
			if (sql.includes('GROUP BY excluded_rule')) return [{ excluded_rule: 'rule-1', n: 2 }];
			if (sql.includes('count(*)::int AS total')) return [{ total: records.length }];
			if (sql.includes('SELECT g.record_key')) return records.map((row) => ({ record_key: row.record_key }));
			if (sql.includes('SELECT * FROM g')) return records;

			return [];
		}),
	};
	const erp = adapter('erp', [source('customer'), source('erp_invoice', { importByIds: false })], { exclude_sapira_invoices: true });
	const crm = adapter(
		'crm',
		[
			source('opportunity', {
				computedFields: [
					{ field: 'owner_email', label: 'Correo del dueño', type: 'text', lowercase: true },
					{ field: 'line_items_count', label: 'Cantidad de ítems', type: 'number' },
				],
			}),
		],
		{ opportunity_stages: ['Ganado'] }
	);
	const stripe = adapter('stripe', [source('invoice', { importByIds: false, hasAccount: true })]);
	const datos = adapter('datos', [source('consumption', { importByIds: false })]);
	(crm as unknown as { fetchOpportunities: jest.Mock }).fetchOpportunities = jest.fn(async () => ({ data: [] }));
	const service = new IntegrationsService(
		dataSource as never,
		integrationSettings as never,
		erp as never,
		crm as never,
		stripe as never,
		datos as never
	);

	beforeEach(() => {
		settings = {};
		queries = [];
		records = [];
		autoEnabled = undefined;
		upserts = [];
		jest.clearAllMocks();
	});

	it('tipos: erp, crm, stripe y datos; otro → 404 (pagos ya no existe)', () => {
		expect(service.adapter('stripe')).toBe(stripe);
		expect(() => service.adapter('pagos')).toThrow(NotFoundException);
	});

	it('records: oculta descartados y excluidos por defecto, aplica reglas y arma KPIs', async () => {
		settings = {
			rules: [
				{
					id: 'rule-1',
					name: 'Tech touch',
					object: 'opportunity',
					enabled: true,
					conditions: [{ field: 'raw_data.Owner.Name', operator: 'is', value: 'Tech touch' }],
				},
			],
		};
		records = [
			{
				object: 'opportunity',
				record_key: '006A',
				label: 'Acme',
				sapira_id: null,
				external_id: '006A',
				status: 'ready',
				excluded_rule: null,
				message: null,
				last_sync_at: null,
			},
		];
		const result = await service.records(HOLDING, 'crm', { page: 1, limit: 20 });
		const dataQuery = queries.find((query) => query.sql.includes('SELECT * FROM g'));

		expect(dataQuery?.sql).toContain('WHEN r.object = $3 AND ((r.rule_row #>> $4::text[]) = $5) THEN $6');
		expect(dataQuery?.params).toEqual(
			expect.arrayContaining([HOLDING, 'crm', ['raw_data', 'Owner', 'Name'], 'Tech touch', 'rule-1', ['discarded', 'excluded_by_rule']])
		);
		expect(result.kpis).toEqual({
			synced: 5,
			error: 0,
			review: 1,
			pending: 3,
			ready: 2,
			ready_new: 2,
			ready_update: 1,
			discarded: 1,
			excluded_by_rule: 2,
		});
		expect(result.rules).toEqual([{ id: 'rule-1', name: 'Tech touch', count: 2 }]);
		expect(result.data[0]).toEqual(
			expect.objectContaining({ id: 'opportunity:006A', status: 'ready', status_label: 'Listo para importar', account: null })
		);
		expect(result).toEqual(expect.objectContaining({ total: 1, currentPage: 1, pages: 1, limit: 20 }));
	});

	it('records: cada consulta usa todos sus parámetros (con y sin status, regla, cuenta, fechas y búsqueda)', async () => {
		settings = {
			rules: [
				{
					id: 'rule-1',
					name: 'Tech touch',
					object: 'opportunity',
					enabled: true,
					conditions: [{ field: 'stage', operator: 'is', value: 'X' }],
				},
			],
		};
		const variants = [
			{},
			{ status: ['pending'] },
			{ status: ['imported', 'synced'] },
			{ status: ['excluded_by_rule'], rule: 'Tech touch' },
			{ rule: 'Tech touch' },
			{ object: 'opportunity', from: '2026-09-26', to: '2026-10-03', search: 'acme', status: ['ready'] },
			{ status: ['ready'], change_kind: ['update'] },
			{ change_kind: ['new', 'update'], rule: 'Tech touch' },
		];

		for (const variant of variants) {
			queries = [];
			await service.records(HOLDING, 'crm', { ...variant, page: 1, limit: 20 });
			await service.records(HOLDING, 'stripe', { ...variant, object: undefined, account_id: 'a-1', page: 2, limit: 20 });
			for (const { sql, params } of queries) {
				const used = new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));

				// Postgres no puede tipar un `$n` que no aparece en la consulta ("could not determine data type of parameter").
				expect({ variant, used: [...used].sort((a, b) => a - b) }).toEqual({ variant, used: params.map((_, index) => index + 1) });
			}
		}
	});

	it('records: los cambios a existentes van a Por revisar (status pending, "Cambios por revisar"), no a Listos', async () => {
		records = [{ object: 'opportunity', record_key: '001A', label: 'Acme', status: 'pending', change_kind: 'update' }];
		const result = await service.records(HOLDING, 'crm', { status: ['pending'], page: 1, limit: 20 });
		const dataQuery = queries.find((query) => query.sql.includes('SELECT * FROM g'));

		expect(dataQuery?.sql).toContain("WHEN e.status = 'ready' AND e.change_kind = 'update' THEN 'pending'");
		expect(result.data[0]).toEqual(expect.objectContaining({ status: 'pending', status_label: 'Cambios por revisar', change_kind: 'update' }));
	});

	it('records: rótulo propio de la fuente (cotización protegida) salvo descartado o excluido', async () => {
		records = [
			{
				object: 'opportunity',
				record_key: '006P',
				label: 'Con contrato',
				status: 'imported',
				source_status_label: 'Cotización con contrato: no se actualiza',
			},
			{
				object: 'opportunity',
				record_key: '006D',
				label: 'Descartada',
				status: 'discarded',
				source_status_label: 'Cotización con contrato: no se actualiza',
			},
		];
		const result = await service.records(HOLDING, 'crm', { page: 1, limit: 20 });

		expect(result.data[0].status_label).toBe('Cotización con contrato: no se actualiza');
		expect(result.data[1].status_label).not.toBe('Cotización con contrato: no se actualiza');
	});

	it('importar: confirm_updates solo con ids (nunca con all)', async () => {
		await expect(
			service.importRecords(HOLDING, 'crm', { object: 'opportunity', all: true, confirm_updates: true }, { authId: 'a', userId: 'u' })
		).rejects.toMatchObject({ status: 400 });
	});

	it('records: change_kind por registro (sin dato del adaptador = null) y filtro por change_kind', async () => {
		records = [
			{ object: 'opportunity', record_key: '001A', label: 'Acme', status: 'ready', change_kind: 'update' },
			{ object: 'opportunity', record_key: '001B', label: 'Beta', status: 'ready' },
		];
		const result = await service.records(HOLDING, 'crm', { change_kind: ['update'], page: 1, limit: 20 });
		const dataQuery = queries.find((query) => query.sql.includes('SELECT * FROM g'));

		expect(dataQuery?.sql).toContain('g.change_kind = ANY(');
		expect(dataQuery?.params).toEqual(expect.arrayContaining([['update']]));
		expect(result.data.map((row) => row.change_kind)).toEqual(['update', null]);
		// Una fuente sin `hasChangeKind` aporta NULL.
		expect(dataQuery?.sql).toContain('NULL::text AS change_kind');
	});

	it('diferencias de un registro: del adaptador, 404 si no existe y available:false si el adaptador no las calcula', async () => {
		const changes = jest.fn(async (_holding: string, _object: string, key: string) =>
			key === 'nope'
				? null
				: {
						label: 'Acme',
						change_kind: 'update' as const,
						sapira_id: 'c-1',
						sapira_label: 'Acme',
						available: true,
						changes: [],
						message: null,
					}
		);

		(crm as unknown as { recordChanges?: jest.Mock }).recordChanges = changes;
		try {
			await expect(service.recordChanges(HOLDING, 'crm', 'opportunity', '001A')).resolves.toEqual(
				expect.objectContaining({ object: 'opportunity', record_key: '001A', available: true, sapira_id: 'c-1' })
			);
			await expect(service.recordChanges(HOLDING, 'crm', 'opportunity', 'nope')).rejects.toBeInstanceOf(NotFoundException);
			await expect(service.recordChanges(HOLDING, 'crm', 'invoice', '1')).rejects.toMatchObject({ status: 400 });
		} finally {
			delete (crm as unknown as { recordChanges?: jest.Mock }).recordChanges;
		}
		await expect(service.recordChanges(HOLDING, 'erp', 'customer', '7')).resolves.toEqual(
			expect.objectContaining({ available: false, changes: [], change_kind: null })
		);
	});

	it('records: sapira_label y subestado (detail_kind) por registro, conteo de subestados y filtro por detail_kind', async () => {
		const invoice = source('invoice', { direction: 'export', importable: false, hasSapiraLabel: true, hasDetail: true });
		const original = dataSource.query.getMockImplementation()!;

		erp.recordSources.mockReturnValue([invoice]);
		dataSource.query.mockImplementation(async (sql: string, params: unknown[] = []) =>
			sql.includes('detail_kind IS NOT NULL')
				? [{ object: 'invoice', detail_kind: 'erp_draft', detail_label: 'Borrador en el ERP', status: 'synced', n: 214 }]
				: original(sql, params)
		);
		records = [
			{
				object: 'invoice',
				record_key: 'i-1',
				label: 'Factura sin folio · Acme',
				sapira_id: 'i-1',
				sapira_label: 'Factura sin folio · CTR-2026-81 · 28-09-2026',
				detail_kind: 'erp_draft',
				detail_label: 'Borrador en el ERP',
				status: 'synced',
				message: 'Enviada como borrador; se emite en el ERP',
			},
		];
		try {
			const result = await service.records(HOLDING, 'erp', { detail_kind: ['erp_draft'], search: 'CTR-2026', page: 1, limit: 20 });

			expect(result.data[0]).toEqual(
				expect.objectContaining({
					sapira_label: 'Factura sin folio · CTR-2026-81 · 28-09-2026',
					detail_kind: 'erp_draft',
					detail_label: 'Borrador en el ERP',
				})
			);
			expect(result.details).toEqual([{ object: 'invoice', kind: 'erp_draft', label: 'Borrador en el ERP', status: 'synced', count: 214 }]);
			const page = queries.find((query) => query.sql.includes('SELECT * FROM g'));

			expect(page?.sql).toContain('x.sapira_label::text AS sapira_label, x.detail_kind::text, x.detail_label::text');
			expect(page?.sql).toContain('f.sapira_label ILIKE');
			expect(page?.sql).toMatch(/g\.detail_kind = ANY\(\$\d+::text\[\]\)/);
			expect(page?.params).toEqual(expect.arrayContaining([['erp_draft']]));
		} finally {
			dataSource.query.mockImplementation(original);
			erp.recordSources.mockImplementation(() => [source('customer'), source('erp_invoice', { importByIds: false })]);
		}
	});

	it('records: sin sapira_label ni subestado en la fuente → null y sin conteo de subestados', async () => {
		records = [{ object: 'customer', record_key: '7', label: 'Acme', status: 'pending' }];
		const result = await service.records(HOLDING, 'erp', { page: 1, limit: 20 });

		expect(result.data[0]).toEqual(expect.objectContaining({ sapira_label: null, detail_kind: null, detail_label: null }));
		expect(result.details).toEqual([]);
		expect(queries.find((query) => query.sql.includes('SELECT * FROM g'))?.sql).toContain('NULL::text AS detail_kind');
	});

	describe('No aplica en mapeos (§5.6)', () => {
		const view = () => ({
			object: 'products',
			object_label: 'Productos',
			anchor: 'sapira',
			external_available: true,
			external_error: null,
			counts: { total: 3, mapped: 1, unmapped: 1, suggested: 1, unused: 0, not_applicable: 0 },
			data: [
				{
					key: 'p-1',
					sapira: { id: 'p-1', label: 'A', meta: {} },
					external: { id: '1', label: 'A', meta: {} },
					status: 'mapped',
					suggestion: null,
					usage: null,
					meta: null,
				},
				{
					key: 'p-2',
					sapira: { id: 'p-2', label: 'B', meta: {} },
					external: null,
					status: 'unmapped',
					suggestion: null,
					usage: null,
					meta: null,
				},
				{
					key: 'p-3',
					sapira: { id: 'p-3', label: 'C', meta: {} },
					external: null,
					status: 'suggested',
					suggestion: { id: '3', label: 'C', meta: {} },
					usage: null,
					meta: null,
				},
			],
		});
		const actor = { authId: 'a', userId: 'u' };

		beforeEach(() => erp.getMapping.mockImplementation(async () => view()));

		it('marca, guarda en settings.mapping_not_applicable y la vista las saca de los conteos; restore las devuelve', async () => {
			settings = { exclude_sapira_invoices: false };
			const marked = await service.markNotApplicable(HOLDING, 'erp', 'products', ['p-2', 'p-3'], actor as never);

			expect(settings).toEqual({ exclude_sapira_invoices: false, mapping_not_applicable: { products: ['p-2', 'p-3'] } });
			expect(erp.getMapping).toHaveBeenCalledWith(HOLDING, 'products', {});
			expect(marked.counts).toEqual({ total: 1, mapped: 1, unmapped: 0, suggested: 0, unused: 0, not_applicable: 2 });
			expect(marked.data.map((row) => row.key)).toEqual(['p-1']);
			const onlyNa = await service.getMapping(HOLDING, 'erp', 'products', { status: 'not_applicable' });

			expect(onlyNa.data.map((row) => row.key)).toEqual(['p-2', 'p-3']);
			const restored = await service.restoreNotApplicable(HOLDING, 'erp', 'products', ['p-2', 'p-3'], actor as never);

			expect(settings).toEqual({ exclude_sapira_invoices: false, mapping_not_applicable: {} });
			expect(restored.counts.not_applicable).toBe(0);
		});

		it('una fila mapeada o que no existe → 400; sugerencias marcadas no se aceptan; pending_mapping recibe las keys', async () => {
			await expect(service.markNotApplicable(HOLDING, 'erp', 'products', ['p-1', 'zz'], actor as never)).rejects.toMatchObject({ status: 400 });
			settings = { mapping_not_applicable: { products: ['p-3'] } };
			const accepted = await service.acceptSuggestions(HOLDING, 'erp', 'products', undefined, actor as never);

			expect(accepted.accepted).toBe(0);
			erp.pendingMapping.mockResolvedValue(0);
			erp.getConnection.mockResolvedValue({ connected: false, active: false, last_sync_at: null });
			erp.listRuns.mockResolvedValue({ data: [] });
			await service.summary(HOLDING).catch(() => undefined);
			expect(erp.pendingMapping).toHaveBeenCalledWith(HOLDING, { products: ['p-3'] });
		});
	});

	describe('errores que se repiten', () => {
		const MSG = 'Productos Salesforce sin mapping activo: Bundle TMS-ADA (01tRO00000N9nnTYAR).';
		const at = (d: string) => `2026-${d}T11:35:00.000Z`;
		const occurrence = (d: string, key = '006G') => ({
			run_id: `crm-job:${d}`,
			kind: 'crm_daily',
			at: at(d),
			object: 'opportunity',
			record_key: key,
			status: 'error' as const,
			message: MSG,
		});
		const run = (d: string, errors: number) => ({
			id: `crm-job:${d}`,
			tipo: 'crm',
			kind: 'crm_daily',
			kind_label: 'Sincronización diaria',
			trigger: 'automatic',
			status: errors ? 'partial' : 'completed',
			started_at: at(d),
			finished_at: null,
			duration_ms: null,
			totals: { total: 10, ok: 0, unchanged: 10 - errors, errors, skipped: 10 - errors },
			error: null,
			metrics: {},
		});
		const history = jest.fn();

		beforeEach(() => {
			(crm as unknown as { recordHistory: jest.Mock }).recordHistory = history;
			(crm as unknown as { getRun: jest.Mock }).getRun = jest.fn();
		});
		afterAll(() => delete (crm as unknown as { recordHistory?: jest.Mock }).recordHistory);

		it('lista: filtra y pagina en el servicio y agrega errors_new / errors_recurring con dos lecturas del historial', async () => {
			crm.listRuns.mockResolvedValue({ data: [run('09-30', 1), run('10-01', 1), run('10-02', 1)] });
			history.mockResolvedValue([occurrence('09-30'), occurrence('10-01'), occurrence('10-02')]);
			const page = await service.listRuns(HOLDING, 'crm', { page: 1, limit: 2 });

			expect(crm.listRuns).toHaveBeenCalledWith(HOLDING, { page: 1, limit: expect.any(Number) });
			expect(history).toHaveBeenCalledTimes(2);
			expect(history).toHaveBeenNthCalledWith(1, HOLDING, expect.objectContaining({ errorsOnly: true }));
			expect(history).toHaveBeenNthCalledWith(2, HOLDING, expect.objectContaining({ keys: ['006G'] }));
			expect(page.total).toBe(3);
			expect(page.data.map((item) => [item.id, item.errors_new, item.errors_recurring, item.errors_recurring_since])).toEqual([
				['crm-job:10-02', 0, 1, at('09-30')],
				['crm-job:10-01', 0, 1, at('09-30')],
			]);
		});

		it('lista: si el historial falla, todo cuenta como nuevo y la lista responde', async () => {
			crm.listRuns.mockResolvedValue({ data: [run('10-02', 2)] });
			history.mockRejectedValue(new Error('mongo caído'));
			const page = await service.listRuns(HOLDING, 'crm', { page: 1, limit: 20 });

			expect(page.data[0]).toEqual(expect.objectContaining({ errors_new: 2, errors_recurring: 0, errors_recurring_since: null }));
		});

		it('detalle: historial solo de los registros con error, hasta el inicio de la corrida', async () => {
			(crm as unknown as { getRun: jest.Mock }).getRun.mockResolvedValue({
				...run('10-02', 1),
				records: [
					{
						object: 'opportunity',
						record_key: '006G',
						label: 'Maderas Gavilán-',
						sapira_id: null,
						external_id: '006G',
						status: 'error',
						message: MSG,
					},
				],
				errors_summary: [{ message: MSG, count: 1 }],
			});
			history.mockResolvedValue([occurrence('09-26'), occurrence('09-27')]);
			const detail = await service.getRun(HOLDING, 'crm', 'crm-job:10-02');

			expect(history).toHaveBeenCalledWith(HOLDING, expect.objectContaining({ keys: ['006G'], until: new Date(at('10-02')) }));
			expect(detail.records[0].recurrence).toEqual({ first_seen_at: at('09-26'), runs_count: 3, consecutive: true });
			expect(detail.errors_summary[0].recurrence).toEqual(expect.objectContaining({ runs_count: 3, recurring_records: 1 }));
		});

		it('records: recurrence solo en los registros con error de la página; el resumen cuenta recurring_errors', async () => {
			records = [
				{ object: 'opportunity', record_key: '006G', label: 'Maderas Gavilán-', status: 'error', message: MSG },
				{ object: 'opportunity', record_key: '006K', label: 'Otra', status: 'ready', message: null },
			];
			history.mockResolvedValue([occurrence('09-30'), occurrence('10-01')]);
			const result = await service.records(HOLDING, 'crm', { page: 1, limit: 20 });

			expect(history).toHaveBeenCalledTimes(1);
			expect(history).toHaveBeenCalledWith(HOLDING, expect.objectContaining({ keys: ['006G'] }));
			expect(result.data.map((record) => record.recurrence)).toEqual([{ first_seen_at: at('09-30'), runs_count: 2, consecutive: true }, null]);
			history.mockClear();
			await service.records(HOLDING, 'crm', { page: 1, limit: 20 }, { recurrence: false });
			expect(history).not.toHaveBeenCalled();

			const original = dataSource.query.getMockImplementation();

			dataSource.query.mockImplementation((async (sql: string, params: unknown[] = []) =>
				sql.includes("WHERE g.status = 'error' ORDER BY")
					? [records[0]]
					: (original as (s: string, p: unknown[]) => Promise<never>)(sql, params)) as never);
			for (const item of [erp, crm, stripe, datos]) {
				item.getConnection.mockResolvedValue({ connected: true, active: true, last_sync_at: null });
				item.listRuns.mockResolvedValue({ data: [] });
				item.pendingMapping.mockResolvedValue(0);
			}
			(stripe as unknown as { listConnections: jest.Mock }).listConnections = jest.fn(async () => ({ data: [] }));
			const summary = await service.summary(HOLDING);

			dataSource.query.mockImplementation(original as never);
			expect(summary.data.find((row) => row.tipo === 'crm')).toEqual(
				expect.objectContaining({ recurring_errors: 1, recurring_since: at('09-30') })
			);
			expect(summary.data.find((row) => row.tipo === 'erp')).toEqual(expect.objectContaining({ recurring_errors: 0, recurring_since: null }));
		});
	});

	it('records: objeto que no es del tipo → 400', async () => {
		await expect(service.records(HOLDING, 'crm', { object: 'invoice', page: 1, limit: 20 })).rejects.toMatchObject({ status: 400 });
	});

	it('importar: ids solo donde el proceso los acepta y sin descartados ni excluidos', async () => {
		await expect(
			service.importRecords(HOLDING, 'erp', { object: 'erp_invoice', ids: ['1'] }, { authId: 'a', userId: 'u' })
		).rejects.toMatchObject({ status: 400 });
		records = [{ record_key: '7' }];
		await service.importRecords(HOLDING, 'erp', { object: 'customer', all: true }, { authId: 'a', userId: 'u' });
		const [, , , skip] = erp.importRecords.mock.calls[0] as unknown as [string, unknown, unknown, Set<string>];

		expect([...skip]).toEqual(['7']);
		expect(queries.some((query) => query.params.some((param) => Array.isArray(param) && param.includes('excluded_by_rule')))).toBe(true);
	});

	it('descartar guarda solo registros que existen en el holding', async () => {
		records = [{ record_key: '006A' }];
		const result = await service.discard(HOLDING, 'crm', { object: 'opportunity', ids: ['006A', '006-ajeno'] }, { authId: 'a', userId: 'u' });

		expect(result).toEqual({ updated: 1 });
		expect(queries.find((query) => query.sql.includes('INSERT INTO integration_record_discards'))?.params[3]).toEqual(['006A']);
	});

	it('reglas por tipo: valida, guarda y null vuelve al default', async () => {
		await expect(service.putSettings(HOLDING, 'crm', { opportunity_stages: [] }, { authId: 'a', userId: 'u' })).rejects.toMatchObject({
			status: 400,
		});
		await expect(service.putSettings(HOLDING, 'crm', { otra: true }, { authId: 'a', userId: 'u' })).rejects.toMatchObject({ status: 400 });
		const saved = await service.putSettings(HOLDING, 'crm', { opportunity_stages: [' Ganado ', 'Closed Won'] }, { authId: 'a', userId: 'u' });

		expect(saved.settings).toEqual({ opportunity_stages: ['Ganado', 'Closed Won'] });
		expect(saved.uses_default).toEqual({ opportunity_stages: false });
		const reset = await service.putSettings(HOLDING, 'crm', { opportunity_stages: null }, { authId: 'a', userId: 'u' });

		expect(reset.uses_default).toEqual({ opportunity_stages: true });
	});

	it('ajustes y corrida automática en la misma fila de holding_integration_settings (fila ausente = habilitado), Stripe incluido', async () => {
		expect((await service.getSettings(HOLDING, 'crm')).auto_sync).toBe(true);
		const off = await service.putSettings(HOLDING, 'crm', { auto_sync: false }, { authId: 'a', userId: 'u' });

		expect(upserts[0]).toEqual(expect.objectContaining({ holding_id: HOLDING, integration: 'salesforce', auto_enabled: false, updated_by: 'u' }));
		expect(upserts[0]).not.toHaveProperty('settings');
		expect(integrationSettings.upsert).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ conflictPaths: ['holding_id', 'integration'] })
		);
		expect(off.auto_sync).toBe(false);
		await service.putSettings(HOLDING, 'crm', { opportunity_stages: ['Ganado'] }, { authId: 'a', userId: 'u' });
		expect(upserts[1]).toEqual(expect.objectContaining({ integration: 'salesforce', settings: { opportunity_stages: ['Ganado'] } }));
		expect(upserts[1]).not.toHaveProperty('auto_enabled');
		await service.putSettings(HOLDING, 'stripe', { auto_sync: false }, { authId: 'a', userId: 'u' });
		expect(upserts[2]).toEqual(expect.objectContaining({ integration: 'stripe', auto_enabled: false }));
		expect(integrationSettings.findOne).toHaveBeenCalledWith({ where: { holding_id: HOLDING, integration: 'stripe' } });
		await service.getSettings(HOLDING, 'datos');
		expect(integrationSettings.findOne).toHaveBeenLastCalledWith({ where: { holding_id: HOLDING, integration: 'bigquery' } });
	});

	it('reglas: campos calculados legibles primero (correo del dueño, cantidad de ítems) con operadores', async () => {
		const result = await service.ruleFields(HOLDING, 'crm', 'opportunity');

		expect(result.data.slice(0, 2)).toEqual([
			{ field: 'owner_email', label: 'Correo del dueño', sample: 'ana@acme.cl', type: 'text', computed: true },
			{ field: 'line_items_count', label: 'Cantidad de ítems', sample: '0', type: 'number', computed: true },
		]);
		expect(result.operators.map((operator) => operator.value)).toEqual(['is', 'is_not', 'contains', 'empty', 'not_empty']);
	});

	it('reglas SimpliRoute: "Cantidad de ítems" es 0 y "Correo del dueño" es el de marketing (guardado en minúsculas) se evalúan en records', async () => {
		await service.putRules(
			HOLDING,
			'crm',
			[
				{ name: 'Ganadas sin ítems', object: 'opportunity', conditions: [{ field: 'line_items_count', operator: 'is', value: '0' }] },
				{
					name: 'Dueño marketing',
					object: 'opportunity',
					conditions: [{ field: 'owner_email', operator: 'is', value: ' Marketing@simplit-solutions.com ' }],
				},
			],
			{ authId: 'a', userId: 'u' }
		);
		const rules = settings.rules as Array<{ conditions: Array<{ value: string }> }>;

		expect(rules[1].conditions[0].value).toBe('marketing@simplit-solutions.com');
		queries = [];
		await service.records(HOLDING, 'crm', { page: 1, limit: 20 });
		const dataQuery = queries.find((query) => query.sql.includes('SELECT * FROM g'));

		expect(dataQuery?.params).toEqual(expect.arrayContaining([['line_items_count'], '0', ['owner_email'], 'marketing@simplit-solutions.com']));
		await expect(
			service.putRules(
				HOLDING,
				'crm',
				[{ name: 'x', object: 'opportunity', conditions: [{ field: 'inventado', operator: 'is', value: '1' }] }],
				{
					authId: 'a',
					userId: 'u',
				}
			)
		).rejects.toMatchObject({ status: 400 });
	});

	it('eliminar conexión con impacto pide confirmación (409 con detalle)', async () => {
		erp.deleteImpact.mockResolvedValueOnce([{ field: 'invoices_pending', message: '3 facturas por enviar al ERP' }]);
		const error = await service.deleteConnection(HOLDING, 'erp', false).catch((caught) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as ConflictException).getResponse()).toEqual(
			expect.objectContaining({ errors: [{ field: 'invoices_pending', message: '3 facturas por enviar al ERP' }] })
		);
		expect(erp.deleteConnection).not.toHaveBeenCalled();
		erp.deleteImpact.mockResolvedValueOnce([{ field: 'x', message: 'y' }]);
		await service.deleteConnection(HOLDING, 'erp', true);
		expect(erp.deleteConnection).toHaveBeenCalledWith(HOLDING, undefined);
	});

	it('aceptar sugerencias respeta el lado ancla del mapeo', async () => {
		crm.getMapping.mockResolvedValue({
			anchor: 'external',
			data: [
				{ key: '01tA', external: { id: '01tA' }, sapira: null, suggestion: { id: 'p-1' }, status: 'suggested' },
				{ key: '01tB', external: { id: '01tB' }, sapira: null, suggestion: { id: 'p-2' }, status: 'suggested' },
			],
		});
		const result = await service.acceptSuggestions(HOLDING, 'crm', 'products', ['01tB'], { authId: 'a', userId: 'u' });

		expect(crm.putMapping).toHaveBeenCalledWith(HOLDING, 'products', [{ sapira_id: 'p-2', external_id: '01tB' }], { authId: 'a', userId: 'u' });
		expect(result.accepted).toBe(1);
		await expect(service.acceptSuggestions(HOLDING, 'crm', 'fields', undefined, { authId: 'a', userId: 'u' })).rejects.toMatchObject({
			status: 400,
		});
	});

	it('mapeo de campos: super admin o Admin Técnico; el resto 403', async () => {
		await expect(service.assertFieldsEditor(HOLDING, { isSuperAdmin: true } as never)).resolves.toBeUndefined();
		await expect(service.assertFieldsEditor(HOLDING, { isSuperAdmin: false, roleId: 'role-tech' } as never)).resolves.toBeUndefined();
		await expect(service.assertFieldsEditor(HOLDING, { isSuperAdmin: false, roleId: 'role-ventas' } as never)).rejects.toBeInstanceOf(
			ForbiddenException
		);
	});

	it('traer oportunidades: sin fechas = último mes, con las etapas guardadas', async () => {
		settings = { opportunity_stages: ['Ganado', 'Firmado'] };
		await service.fetchCrmOpportunities(HOLDING, {});
		const [, input] = (crm as unknown as { fetchOpportunities: jest.Mock }).fetchOpportunities.mock.calls[0];

		expect(input.stages).toEqual(['Ganado', 'Firmado']);
		expect(input.date_to).toBe(new Date().toISOString().slice(0, 10));
		await expect(service.fetchCrmOpportunities(HOLDING, { date_from: '2024-01-01', date_to: '2026-01-01' })).rejects.toMatchObject({
			status: 400,
		});
	});
});
