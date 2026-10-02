// `contract-changes.service` → `contract-activation.service` → `InvoiceSchedulerService` importa `uuid` (solo ESM): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

/**
 * Jobs y endpoints de la auto-renovación v2 (spec modificaciones §9.3.5 y §9.3.6, B2-4) sin base: `DataSource` falso que enruta por SQL.
 * Cubre la costura (`setApiWriter` primero), la idempotencia (por ítem y fin / por pacto y fecha, revisada con el contrato bloqueado),
 * la ventana de aviso, el try/catch por holding, que **nunca** renueva sola, omitir con motivo y la lista con conteos.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { NotificationsService } from '@/modules/notifications/notifications.service';

import { API_WRITER_SQL } from './api-writer';
import { ContractChangesService } from './contract-changes.service';
import { RENEWAL_PROPOSED, SYSTEM_ACTOR_ID } from './contract-renewals';
import { ContractRenewalsService } from './contract-renewals.service';
import { ContractsScheduler } from './contracts.scheduler';
import { ContractsService } from './contracts.service';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const HOLDING = 'h-1';
const CONTRACT = 'c0000000-0000-4000-8000-000000000001';
const ITEM = '11111111-1111-4111-8111-111111111111';
const today = new Date('2026-09-28T12:00:00Z');

const candidateRow: Row = {
	id: ITEM,
	contract_id: CONTRACT,
	contract_number: 'CTR-2026-001',
	product_name: 'Licencia',
	end_date: '2026-10-20',
	quantity: '10',
	unit_price: '100',
	monthly_price: '1000',
	currency: 'CLP',
	term_months: 12,
	billing_frequency: 'Mensual',
};

const build = (handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('SELECT DISTINCT holding_id FROM contracts')) return [{ holding_id: HOLDING }];
		if (sql.includes('FROM holding_settings')) return [{ auto_renewal_notice_days: 30 }];
		if (sql.includes('FROM contract_items ci') && sql.includes('ci.auto_renew = true')) return [candidateRow];
		if (sql.includes('FROM contract_scheduled_changes sc') && sql.includes("sc.trigger IN ('on_date', 'every_n_months')")) return [];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: 'event-1' }];

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
	const contracts = { resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT }) } as unknown as ContractsService;
	const changes = {
		preview: jest.fn().mockResolvedValue({
			contract: { before: { mrr: 1200, end_date: '2026-10-20' }, after: { mrr: 1200, end_date: '2027-10-20' } },
			items: { added: [{}] },
			invoices: { created: [{}], updated: [] },
			warnings: [],
			blockers: [],
			can_apply: true,
		}),
		apply: jest.fn(),
	} as unknown as ContractChangesService;
	const notifications = {
		createOrUpdate: jest.fn().mockResolvedValue({}),
		resolveByDeduplicationKey: jest.fn().mockResolvedValue(undefined),
	} as unknown as NotificationsService;

	return { service: new ContractRenewalsService(dataSource, contracts, changes, notifications), runner, dataSource, changes, notifications };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));

describe('job contracts-auto-renewal (§9.3.5)', () => {
	it('propone (no renueva): evento RENEWAL_PROPOSED del actor sistema con ítems, preview, pactos y clave; costura primero; notifica', async () => {
		const { service, runner, changes, notifications } = build();

		expect(await service.proposeRenewalsForHolding(HOLDING, today)).toBe(1);
		expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
		expect(runner.query.mock.calls[1][0]).toContain('FOR UPDATE');
		const [insert] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const params = insert[1] as unknown[];

		expect(insert[0]).toContain(`'${RENEWAL_PROPOSED}', 'Pending'`);
		expect(params[4]).toBe(SYSTEM_ACTOR_ID);
		expect(params[5]).toBe('2026-10-20');
		expect(JSON.parse(params[7] as string)).toMatchObject({
			job: 'contracts-auto-renewal',
			created_by_system: true,
			status: 'open',
			notice_days: 30,
			proposal_keys: [`${ITEM}:2026-10-20`],
			items: [expect.objectContaining({ item_id: ITEM, renewal_start: '2026-10-21', monthly_price: 1000 })],
			preview: expect.objectContaining({ available: true, end_date_after: '2027-10-20', can_apply: true }),
			pacts: [],
		});
		// El preview es de solo lectura; nunca se aplica la renovación.
		expect((changes.preview as jest.Mock).mock.calls[0][1]).toMatchObject({ change: { type: 'renewal', items: [{ item_id: ITEM }] } });
		expect(changes.apply).not.toHaveBeenCalled();
		expect((notifications.createOrUpdate as jest.Mock).mock.calls[0][1]).toMatchObject({
			type: 'contract_renewal_proposed',
			resource_id: CONTRACT,
			deduplication_key: 'contracts:renewal-proposal:event-1',
			recipients: { include_super_admins: true },
		});
	});

	it('idempotente: con la clave ítem:fin ya propuesta (lectura o con el lock) no inserta ni notifica', async () => {
		const proposed: Handler = (sql) => (sql.includes("metadata->'proposal_keys'") ? [{ key: `${ITEM}:2026-10-20` }] : undefined);
		const first = build(proposed);

		expect(await first.service.proposeRenewalsForHolding(HOLDING, today)).toBe(0);
		expect(first.dataSource.createQueryRunner).not.toHaveBeenCalled();
		// Otra réplica la propuso entre la lectura y el lock: se revisa de nuevo dentro de la transacción.
		let reads = 0;
		const race = build((sql) => (sql.includes("metadata->'proposal_keys'") ? (++reads > 1 ? [{ key: `${ITEM}:2026-10-20` }] : []) : undefined));

		expect(await race.service.proposeRenewalsForHolding(HOLDING, today)).toBe(0);
		expect(calls(race.runner.query, 'INSERT INTO contract_lifecycle_events')).toEqual([]);
		expect(race.notifications.createOrUpdate).not.toHaveBeenCalled();
	});

	it('ventana de aviso: el SQL filtra auto_renew, sin renovar ni churn, contrato active | pending_renewal y fin ≤ hoy + días del holding', async () => {
		const { service, dataSource } = build((sql) => (sql.includes('FROM holding_settings') ? [{ auto_renewal_notice_days: 45 }] : undefined));

		await service.proposeRenewalsForHolding(HOLDING, today);
		const [query] = calls(dataSource.query as jest.Mock, 'ci.auto_renew = true');

		expect(query[0]).toContain(`ds.derived_status IN ('active', 'pending_renewal')`);
		expect(query[0]).toContain('ci.renewed_by_item_id IS NULL AND ci.churn_date IS NULL');
		expect(query[1]).toEqual([HOLDING, '2026-09-28', '2026-11-12']);
	});

	it('try/catch por holding: un holding que falla queda con su error y el resto sigue', async () => {
		const { service } = build((sql, params) => {
			if (sql.includes('SELECT DISTINCT holding_id FROM contracts')) return [{ holding_id: 'h-bad' }, { holding_id: HOLDING }];
			if (sql.includes('FROM holding_settings') && params[0] === 'h-bad') throw new Error('boom');

			return undefined;
		});

		expect(await service.proposeRenewals(today)).toEqual([
			{ holding_id: 'h-bad', success: false, events: 0, error: 'boom' },
			{ holding_id: HOLDING, success: true, events: 1 },
		]);
	});
});

describe('job contracts-scheduled-changes (§9.3.6)', () => {
	const pactRow = (overrides: Row = {}): Row => ({
		id: 'pact-1',
		contract_id: CONTRACT,
		contract_number: 'CTR-2026-001',
		contract_item_id: ITEM,
		product_name: 'Licencia',
		trigger: 'on_date',
		kind: 'index',
		value: '0',
		index_code: 'IPC',
		index_base_value: '100',
		index_lag_months: 1,
		due_date: '2026-10-15',
		...overrides,
	});

	it('pacto índice sin dato → evento SCHEDULED_CHANGE_DUE con blocker index_value_missing; con serie lleva la variación', async () => {
		const missing = build((sql) => (sql.includes('FROM contract_scheduled_changes sc') ? [pactRow()] : undefined));

		expect(await missing.service.flagDueForHolding(HOLDING, today)).toBe(1);
		const [insert] = calls(missing.runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(insert[0]).toContain(`'SCHEDULED_CHANGE_DUE', 'Pending'`);
		expect(JSON.parse((insert[1] as unknown[])[7] as string)).toMatchObject({
			scheduled_change_id: 'pact-1',
			due_key: 'pact-1:2026-10-15',
			index: { code: 'IPC', value_missing: true },
			blockers: ['index_value_missing'],
		});
		const withIndex = build((sql) => {
			if (sql.includes('FROM contract_scheduled_changes sc')) return [pactRow()];
			if (sql.includes('FROM indicadores_economicos')) return [{ codigo: 'IPC', fecha: '2026-09-01', valor: '104' }];

			return undefined;
		});

		await withIndex.service.flagDueForHolding(HOLDING, today);
		const [indexed] = calls(withIndex.runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(JSON.parse((indexed[1] as unknown[])[7] as string)).toMatchObject({ index: { value_missing: false, percent: 4 }, blockers: [] });
		expect((withIndex.notifications.createOrUpdate as jest.Mock).mock.calls[0][1]).toMatchObject({
			type: 'contract_scheduled_change_due',
			deduplication_key: 'contracts:scheduled-change-due:pact-1:2026-10-15',
		});
	});

	it('idempotente por pacto y fecha; la fuera de la ventana no avisa', async () => {
		const done = build((sql) => {
			if (sql.includes('FROM contract_scheduled_changes sc')) return [pactRow({ kind: 'percent_uplift' })];
			if (sql.includes("metadata->>'due_key'")) return [{ key: 'pact-1:2026-10-15' }];

			return undefined;
		});

		expect(await done.service.flagDueForHolding(HOLDING, today)).toBe(0);
		const late = build((sql) => (sql.includes('FROM contract_scheduled_changes sc') ? [pactRow({ due_date: '2026-12-15' })] : undefined));

		expect(await late.service.flagDueForHolding(HOLDING, today)).toBe(0);
	});
});

describe('propuestas: lista y omitir (§9.3.5)', () => {
	const proposalRow = (metadata: Row = {}): Row => ({
		id: 'e0000000-0000-4000-8000-0000000000ee',
		contract_id: CONTRACT,
		contract_number: 'CTR-2026-001',
		client_name: 'Cliente SpA',
		contract_currency: 'CLP',
		created_at: '2026-09-28T09:00:00Z',
		metadata: { status: 'open', items: [{ item_id: ITEM, product_name: 'Licencia', end_date: '2026-10-20', monthly_price: 1000 }], ...metadata },
	});

	it('GET /contracts/renewal-proposals: abiertas con ítems pendientes y conteos (renuevan en 30 días)', async () => {
		const { service } = build((sql) => {
			if (sql.includes(`e.event_type = '${RENEWAL_PROPOSED}'`)) return [proposalRow()];
			if (sql.includes('FROM contract_items WHERE id = ANY')) return [{ id: ITEM }];

			return undefined;
		});

		expect(await service.listProposals(HOLDING, today)).toEqual({
			data: [expect.objectContaining({ event_id: 'e0000000-0000-4000-8000-0000000000ee', days_to_end: 22, monthly_total: 1000 })],
			counts: { open: 1, renew_in_30_days: 1, overdue: 0 },
		});
	});

	it('omitir: evento RENEWAL_PROPOSAL_DISMISSED con motivo, la propuesta queda dismissed y se cierra la notificación', async () => {
		const { service, runner, notifications } = build((sql) =>
			sql.includes('FOR UPDATE') && sql.includes('RENEWAL_PROPOSED') ? [proposalRow()] : undefined
		);
		const result = await service.dismiss(CONTRACT, 'e0000000-0000-4000-8000-0000000000ee', 'El cliente no renueva', HOLDING, 'auth-1');

		expect(result).toEqual({
			proposal_event_id: 'e0000000-0000-4000-8000-0000000000ee',
			event_id: 'event-1',
			status: 'dismissed',
			reason: 'El cliente no renueva',
		});
		expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][0]).toContain(`'RENEWAL_PROPOSAL_DISMISSED', 'Completed'`);
		expect(calls(runner.query, "jsonb_build_object('status', 'dismissed'")[0][1]).toEqual([
			'e0000000-0000-4000-8000-0000000000ee',
			HOLDING,
			'event-1',
			'El cliente no renueva',
		]);
		expect(notifications.resolveByDeduplicationKey).toHaveBeenCalledWith(
			HOLDING,
			'contracts:renewal-proposal:e0000000-0000-4000-8000-0000000000ee'
		);
	});

	it('omitir: 404 si no es del contrato, 409 renewal_proposal_not_open si ya se confirmó u omitió', async () => {
		await expect(build().service.dismiss(CONTRACT, 'x', 'motivo', HOLDING, 'auth-1')).rejects.toBeInstanceOf(NotFoundException);
		const confirmed = build((sql) =>
			sql.includes('FOR UPDATE') && sql.includes('RENEWAL_PROPOSED') ? [proposalRow({ status: 'confirmed' })] : undefined
		);

		await expect(confirmed.service.dismiss(CONTRACT, 'x', 'motivo', HOLDING, 'auth-1')).rejects.toMatchObject({
			response: expect.objectContaining({ code: 'renewal_proposal_not_open' }),
		});
		await expect(confirmed.service.dismiss(CONTRACT, 'x', 'motivo', HOLDING, 'auth-1')).rejects.toBeInstanceOf(ConflictException);
		expect(confirmed.runner.rollbackTransaction).toHaveBeenCalled();
	});
});

describe('ContractsScheduler', () => {
	const scheduler = (enabled: string | undefined) => {
		const renewals = {
			proposeRenewals: jest.fn().mockResolvedValue([{ holding_id: HOLDING, success: true, events: 2 }]),
			flagDueScheduledChanges: jest.fn().mockResolvedValue([]),
			extendHorizons: jest.fn().mockResolvedValue([{ holding_id: HOLDING, success: true, events: 1 }]),
		} as unknown as ContractRenewalsService;
		const config = { get: jest.fn().mockReturnValue(enabled) } as unknown as ConfigService;

		return { scheduler: new ContractsScheduler(renewals, config), renewals };
	};

	it('crons contracts-scheduled-changes (05:30) y contracts-auto-renewal (06:00) en America/Santiago; CONTRACT_JOBS_ENABLED=false los apaga', async () => {
		const meta = (method: string) =>
			Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', ContractsScheduler.prototype[method as keyof ContractsScheduler]);

		expect(meta('autoRenewalDaily')).toMatchObject({ cronTime: '0 6 * * *', name: 'contracts-auto-renewal', timeZone: 'America/Santiago' });
		expect(meta('scheduledChangesDaily')).toMatchObject({ cronTime: '30 5 * * *', name: 'contracts-scheduled-changes' });
		expect(meta('extendHorizonDaily')).toMatchObject({ cronTime: '45 5 * * *', name: 'contracts-extend-horizon', timeZone: 'America/Santiago' });
		const on = scheduler(undefined);

		expect(await on.scheduler.autoRenewalDaily()).toEqual([{ holding_id: HOLDING, success: true, events: 2 }]);
		await on.scheduler.scheduledChangesDaily();
		expect(on.renewals.flagDueScheduledChanges).toHaveBeenCalled();
		expect(await on.scheduler.extendHorizonDaily()).toEqual([{ holding_id: HOLDING, success: true, events: 1 }]);
		const off = scheduler('false');

		expect(await off.scheduler.autoRenewalDaily()).toBeNull();
		expect(off.renewals.proposeRenewals).not.toHaveBeenCalled();
		expect(await off.scheduler.extendHorizonDaily()).toBeNull();
	});
});
