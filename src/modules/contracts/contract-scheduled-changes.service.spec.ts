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
		for (const handler of [proto.skipScheduledChange, proto.cancelScheduledChange, proto.previewScheduledChange, proto.applyScheduledChange])
			expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
	});
});
