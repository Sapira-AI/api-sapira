// `InvoiceSchedulerService` importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';

import { API_WRITER_SQL } from './api-writer';
import { ContractChangesService } from './contract-changes.service';
import { context, CONTRACT_ID, HOLDING, LICENCIA } from './contract-changes.test-fixtures';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const PACT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pactRow = (overrides: Row = {}): Row => ({
	id: PACT_ID,
	contract_id: CONTRACT_ID,
	contract_item_id: LICENCIA,
	product_name: 'Licencia',
	group_key: null,
	parent_id: null,
	trigger: 'on_date',
	effective_date: '2026-11-15',
	anchor_date: null,
	interval_months: null,
	next_effective_date: '2026-11-15',
	kind: 'percent_uplift',
	value: '5',
	index_code: null,
	index_base_date: null,
	index_base_value: null,
	index_lag_months: 1,
	rounding: 'unit_2',
	status: 'scheduled',
	status_reason: null,
	status_changed_by: null,
	applied_event_id: null,
	applied_at: null,
	applied_value: null,
	origin: { type: 'manual' },
	notes: null,
	created_by: 'user-1',
	created_at: '2026-09-28T00:00:00Z',
	updated_at: '2026-09-28T00:00:00Z',
	...overrides,
});

const build = (handler: Handler = () => undefined, pact: Row = pactRow()) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM contracts WHERE id = $1') && sql.includes('FOR UPDATE')) return [{ status: 'Activo' }];
		if (sql.includes('FROM contract_items WHERE contract_id = $1'))
			return [
				{
					id: LICENCIA,
					product_name: 'Licencia',
					is_recurring: true,
					churn_date: null,
					renewed_by_item_id: null,
					categoria: 'NEW',
					end_date: '2026-12-31',
				},
			];
		if (sql.includes('INSERT INTO contract_scheduled_changes')) return [{ id: PACT_ID }];
		if (sql.includes('FROM contract_scheduled_changes sc')) return [pact];

		return [];
	};
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: jest.fn(route),
	};
	const dataSource = { query: jest.fn(route), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
	const contracts = { resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID }) } as unknown as ContractsService;
	const changes = {
		loadContext: jest.fn().mockResolvedValue(context({ scheduled_changes: [] })),
		preview: jest.fn().mockResolvedValue({ can_apply: true }),
		apply: jest.fn().mockResolvedValue({ applied: true }),
		closeResolvedAlerts: jest.fn().mockResolvedValue(0),
	};

	return {
		service: new ContractScheduledChangesService(dataSource, contracts, changes as unknown as ContractChangesService),
		runner,
		changes,
	};
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const today = new Date('2026-09-28T12:00:00Z');

describe('ContractScheduledChangesService (pactos R1, §9.3.6)', () => {
	it('create: costura primero, lock del contrato, INSERT scheduled con la próxima fecha y evento SCHEDULED_CHANGE_CREATED', async () => {
		const { service, runner } = build();
		const view = await service.create(
			CONTRACT_ID,
			{ contract_item_id: LICENCIA, trigger: 'on_date', effective_date: '2026-11-15', kind: 'percent_uplift', value: 5 },
			HOLDING,
			'auth-1'
		);

		expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
		expect(calls(runner.query, 'FOR UPDATE')[0][0]).toContain('FROM contracts');
		const [[, params]] = calls(runner.query, 'INSERT INTO contract_scheduled_changes');

		expect(params.slice(0, 11)).toEqual([
			HOLDING,
			CONTRACT_ID,
			LICENCIA,
			null,
			'on_date',
			'2026-11-15',
			null,
			null,
			'2026-11-15',
			'percent_uplift',
			5,
		]);
		const [[eventSql, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(eventSql).toContain("'Completed'");
		expect(eventParams[2]).toBe('SCHEDULED_CHANGE_CREATED');
		expect(JSON.parse(String(eventParams[7]))).toMatchObject({ scheduled_change_id: PACT_ID, kind: 'percent_uplift' });
		expect(view).toMatchObject({ id: PACT_ID, value: 5, status: 'scheduled', product_name: 'Licencia' });
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('create: 400 por campos del disparo; 409 en un contrato cancelado', async () => {
		const { service } = build();

		await expect(
			service.create(CONTRACT_ID, { contract_item_id: LICENCIA, trigger: 'on_date', kind: 'percent_uplift', value: 5 }, HOLDING, 'auth-1')
		).rejects.toBeInstanceOf(BadRequestException);
		const cancelled = build((sql) =>
			sql.includes('FROM contracts WHERE id = $1') && sql.includes('FOR UPDATE') ? [{ status: 'Cancelado' }] : undefined
		);

		await expect(
			cancelled.service.create(CONTRACT_ID, { trigger: 'on_renewal', kind: 'percent_uplift', value: 5 }, HOLDING, 'auth-1')
		).rejects.toMatchObject({ response: { code: 'scheduled_change_contract_not_open' } });
	});

	it('update: solo scheduled (409 scheduled_change_not_editable); el evento guarda antes y después', async () => {
		const { service, runner } = build();

		await service.update(CONTRACT_ID, PACT_ID, { value: 7 }, HOLDING, 'auth-1');
		const [[sql, params]] = calls(runner.query, 'UPDATE contract_scheduled_changes SET contract_item_id');

		expect(sql).toContain("status = 'scheduled'");
		expect(params[11]).toBe(7);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(eventParams[2]).toBe('SCHEDULED_CHANGE_UPDATED');
		const applied = build(undefined, pactRow({ status: 'applied' }));

		await expect(applied.service.update(CONTRACT_ID, PACT_ID, { value: 7 }, HOLDING, 'auth-1')).rejects.toMatchObject({
			response: { code: 'scheduled_change_not_editable' },
		});
	});

	it('skip: on_date → skipped con motivo; every_n_months → hija skipped y la madre avanza un intervalo; cancel → cancelled', async () => {
		const once = build();

		await once.service.skip(CONTRACT_ID, PACT_ID, { reason: 'Se negoció mantener' }, HOLDING, 'auth-1');
		expect(calls(once.runner.query, 'UPDATE contract_scheduled_changes SET status')[0][1]).toEqual([
			PACT_ID,
			CONTRACT_ID,
			HOLDING,
			'skipped',
			'Se negoció mantener',
			'user-1',
		]);
		expect(calls(once.runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][2]).toBe('SCHEDULED_CHANGE_SKIPPED');
		const yearly = build(
			undefined,
			pactRow({ trigger: 'every_n_months', anchor_date: '2026-12-01', interval_months: 12, next_effective_date: '2026-12-01' })
		);

		await yearly.service.skip(CONTRACT_ID, PACT_ID, { reason: 'Este año no' }, HOLDING, 'auth-1');
		expect(calls(yearly.runner.query, "'every_n_months', $6, $7, $8, 'skipped'")[0][1].slice(0, 6)).toEqual([
			HOLDING,
			CONTRACT_ID,
			LICENCIA,
			null,
			PACT_ID,
			'2026-12-01',
		]);
		expect(calls(yearly.runner.query, 'make_interval(months => interval_months)')).toHaveLength(1);
		const cancel = build();

		await cancel.service.cancel(CONTRACT_ID, PACT_ID, { reason: 'Ya no aplica' }, HOLDING, 'auth-1');
		expect(calls(cancel.runner.query, 'UPDATE contract_scheduled_changes SET status')[0][1][3]).toBe('cancelled');
		expect(calls(cancel.runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][2]).toBe('SCHEDULED_CHANGE_CANCELLED');
		// Notificaciones v2: omitir o cancelar cierra la alerta "Cambio programado por aplicar" del contrato.
		expect(once.changes.closeResolvedAlerts).toHaveBeenCalledWith(CONTRACT_ID, HOLDING);
		expect(cancel.changes.closeResolvedAlerts).toHaveBeenCalledWith(CONTRACT_ID, HOLDING);
	});

	it('apply/preview y apply: delegan en el motor de modificaciones con el pedido del pacto y la marca (options.scheduled_change)', async () => {
		const { service, changes } = build();

		await service.applyPreview(CONTRACT_ID, PACT_ID, {}, HOLDING, today);
		const [, request, , , options] = changes.preview.mock.calls[0];

		expect(request).toMatchObject({
			effective_date: '2026-12-01',
			change: { type: 'item_change', items: [{ item_id: LICENCIA, unit_price: 105 }] },
		});
		expect(options).toMatchObject({ scheduled_change: { id: PACT_ID, value: 5, kind: 'percent_uplift', trigger: 'on_date' } });
		await service.apply(CONTRACT_ID, PACT_ID, { value: 6 }, HOLDING, 'auth-1', 'key-1', today);
		expect(changes.apply.mock.calls[0][4]).toBe('key-1');
		expect(changes.apply.mock.calls[0][6]).toMatchObject({ scheduled_change: { value: 6 } });
	});

	it('preview antes de guardar: simula el pacto en memoria con el motor (ítems, fecha por ítem, pacto aplicado); no escribe ni delega', async () => {
		const { service, changes, runner } = build();
		const preview = await service.createPreview(
			CONTRACT_ID,
			{ trigger: 'on_date', effective_date: '2026-12-01', kind: 'percent_uplift', value: 5 },
			HOLDING,
			today
		);

		expect(preview.can_apply).toBe(true);
		expect(preview.effective_date).toBe('2026-12-01');
		// Alcance contrato: Licencia 10 × 100 → +5 (10 × 5) y Soporte 1 × 200 → +10, desde el 01-12.
		expect(preview.items.added.map((item) => [item.product_name, item.start_date, item.monthly_price])).toEqual([
			['Licencia', '2026-12-01', 50],
			['Soporte', '2026-12-01', 10],
		]);
		expect(preview.rsm.mrr_delta).toBe(60);
		expect([preview.contract.before.mrr, preview.contract.after.mrr]).toEqual([1200, 1260]);
		expect(preview.invoices.updated.map((invoice) => invoice.id)).toEqual(['inv-12']);
		expect(changes.preview).not.toHaveBeenCalled();
		expect(changes.apply).not.toHaveBeenCalled();
		expect(runner.startTransaction).not.toHaveBeenCalled();
		// En la renovación: la vista previa es la renovación con el pacto.
		const renewal = await service.createPreview(
			CONTRACT_ID,
			{ trigger: 'on_renewal', kind: 'percent_uplift', value: 5, contract_item_id: LICENCIA },
			HOLDING,
			today
		);

		expect(renewal.type).toBe('renewal');
		expect(renewal.contract.after.end_date).toBe('2027-12-31');
		// Se lee "cómo quedará": una fila por ítem renovado con el unitario ya reajustado, el MRR con el cambio y sin "ajustes" que no cambian.
		expect(renewal.items.added.map((item) => [item.categoria, item.quantity, item.unit_price, item.monthly_price])).toEqual([
			['RENEWAL', 10, 105, 1050],
		]);
		expect(renewal.items.adjusted).toEqual([]);
		expect([renewal.contract.before.mrr, renewal.contract.after.mrr]).toEqual([1200, 1250]);
	});

	it('preview antes de guardar: mismas reglas que crear (400 por campo) e índice sin publicar → blocker index_value_missing', async () => {
		const { service } = build();

		await expect(
			service.createPreview(CONTRACT_ID, { trigger: 'on_date', kind: 'percent_uplift', value: 5 }, HOLDING, today)
		).rejects.toBeInstanceOf(BadRequestException);
		const indexed = await service.createPreview(
			CONTRACT_ID,
			{ trigger: 'on_date', effective_date: '2026-12-01', kind: 'index', value: 0, index_code: 'IPC', index_base_value: 100 },
			HOLDING,
			today
		);

		expect(indexed.can_apply).toBe(false);
		expect(indexed.blockers.map((blocker) => blocker.code)).toEqual(['index_value_missing']);
	});

	it('apply de un índice sin dato publicado → 409 blocked con el preview (index_value_missing); el preview lo muestra sin aplicar', async () => {
		const indexed = pactRow({ kind: 'index', index_code: 'IPC', index_base_value: '100', value: '0' });
		const { service, changes } = build(undefined, indexed);
		const preview = await service.applyPreview(CONTRACT_ID, PACT_ID, {}, HOLDING, today);

		expect(preview.blockers.map((blocker) => blocker.code)).toEqual(['index_value_missing']);
		expect(changes.preview).not.toHaveBeenCalled();
		await expect(service.apply(CONTRACT_ID, PACT_ID, {}, HOLDING, 'auth-1', undefined, today)).rejects.toBeInstanceOf(ConflictException);
		expect(changes.apply).not.toHaveBeenCalled();
	});
});

describe('revertir un cambio programado aplicado (usuarias 13-11)', () => {
	const applied = (sql: string) =>
		sql.includes("metadata->'created_items'")
			? [{ id: PACT_ID, applied_event_id: 'event-1', created_items: { 'new:1': 'item-adj-1', 'new:2': 'item-adj-2' } }]
			: undefined;

	it('vista previa y revertir: delegan en el motor con el cambio, el evento que lo aplicó y los ítems que creó', async () => {
		const { service, changes } = build(applied);

		await service.revertPreview(CONTRACT_ID, PACT_ID, { reason: ' Se cargó por error ' }, HOLDING, today);
		const [contractId, request, , , options] = changes.preview.mock.calls[0];

		expect(contractId).toBe(CONTRACT_ID);
		expect(request).toEqual({
			effective_date: '2026-09-28',
			origin: { type: 'manual' },
			reason: 'Se cargó por error',
			change: { type: 'scheduled_change_revert' },
		});
		expect(options).toEqual({ revert: { scheduled_change_id: PACT_ID, event_id: 'event-1', item_ids: ['item-adj-1', 'item-adj-2'] } });
		await service.revert(CONTRACT_ID, PACT_ID, { reason: 'Se cargó por error' }, HOLDING, 'auth-1', 'key-9', today);
		expect(changes.apply.mock.calls[0].slice(3, 5)).toEqual(['auth-1', 'key-9']);
		expect(changes.apply.mock.calls[0][6]).toEqual(options);
	});

	it('404 si el cambio no es de ese contrato; sin evento de aplicación viaja sin ítems (el motor lo bloquea)', async () => {
		const missing = build((sql) => (sql.includes("metadata->'created_items'") ? [] : undefined));

		await expect(missing.service.revert(CONTRACT_ID, PACT_ID, { reason: 'x' }, HOLDING, 'auth-1')).rejects.toThrow(
			'Cambio programado no encontrado'
		);
		const bare = build((sql) =>
			sql.includes("metadata->'created_items'") ? [{ id: PACT_ID, applied_event_id: null, created_items: null }] : undefined
		);

		await bare.service.revertPreview(CONTRACT_ID, PACT_ID, { reason: 'x' }, HOLDING, today);
		expect(bare.changes.preview.mock.calls[0][4]).toEqual({ revert: { scheduled_change_id: PACT_ID, event_id: null, item_ids: [] } });
	});
});

describe('ContractsController · rutas de pactos', () => {
	it('expone GET/POST :id/scheduled-changes, PATCH :changeId y POST skip|cancel|apply/preview|apply (200)', () => {
		const proto = ContractsController.prototype;

		expect(Reflect.getMetadata(PATH_METADATA, proto.scheduledChanges)).toBe(':id/scheduled-changes');
		expect(Reflect.getMetadata(PATH_METADATA, proto.createScheduledChange)).toBe(':id/scheduled-changes');
		expect(Reflect.getMetadata(PATH_METADATA, proto.updateScheduledChange)).toBe(':id/scheduled-changes/:changeId');
		expect(Reflect.getMetadata(PATH_METADATA, proto.skipScheduledChange)).toBe(':id/scheduled-changes/:changeId/skip');
		expect(Reflect.getMetadata(PATH_METADATA, proto.cancelScheduledChange)).toBe(':id/scheduled-changes/:changeId/cancel');
		expect(Reflect.getMetadata(PATH_METADATA, proto.previewScheduledChange)).toBe(':id/scheduled-changes/:changeId/apply/preview');
		expect(Reflect.getMetadata(PATH_METADATA, proto.applyScheduledChange)).toBe(':id/scheduled-changes/:changeId/apply');
		expect(Reflect.getMetadata(PATH_METADATA, proto.previewRevertScheduledChange)).toBe(':id/scheduled-changes/:changeId/revert/preview');
		expect(Reflect.getMetadata(PATH_METADATA, proto.revertScheduledChange)).toBe(':id/scheduled-changes/:changeId/revert');
		for (const handler of [proto.previewRevertScheduledChange, proto.revertScheduledChange])
			expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
		for (const handler of [proto.skipScheduledChange, proto.cancelScheduledChange, proto.previewScheduledChange, proto.applyScheduledChange])
			expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
	});
});
