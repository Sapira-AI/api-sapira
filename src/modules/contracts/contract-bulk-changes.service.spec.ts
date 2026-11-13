// `contract-activation.service` → `InvoiceSchedulerService` importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ContractBulkChangesService } from './contract-bulk-changes.service';
import { ContractChangesService } from './contract-changes.service';
import { context, itemRow, LICENCIA, SOPORTE, soporteRow } from './contract-changes.test-fixtures';
import { ContractScheduledChangesService } from './contract-scheduled-changes.service';
import { ContractsService } from './contracts.service';

/**
 * Acciones masivas que cambian el contrato (Domi 13-11): ajuste de precio en lote (un cambio futuro por contrato, "desde el mes" o al
 * renovarse) y renovación automática en lote. Fixture: Licencia 10 × 100 y Soporte 1 × 200 de ene a dic 2026; hoy = 28-09-2026.
 */
const HOLDING = 'h-1';
const ACTIVE = 'c0000000-0000-4000-8000-000000000001';
const ENDED = 'c0000000-0000-4000-8000-000000000002';
const PRICED = 'c0000000-0000-4000-8000-000000000003';
const DRAFT = 'c0000000-0000-4000-8000-000000000004';
const today = new Date('2026-09-28T12:00:00Z');
const tiered = { price_model: 'tiered', price_quantity_type: 'fixed', price_tiers: [{ up_to: null, unit_amount: 10 }] };

const build = (autoRenewRows: Array<Record<string, unknown>> = []) => {
	const heads = [
		{ id: ACTIVE, contract_number: 'CTR-1', status: 'Activo', contract_currency: 'CLP', client_name: 'Acme' },
		{ id: ENDED, contract_number: 'CTR-2', status: 'Activo', contract_currency: 'CLP', client_name: 'Beta' },
		{ id: PRICED, contract_number: 'CTR-3', status: 'Activo', contract_currency: 'CLP', client_name: 'Gama' },
		{ id: DRAFT, contract_number: 'CTR-4', status: 'En revisión', contract_currency: 'CLP', client_name: 'Delta' },
	];
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			if (sql.includes('live_items')) return autoRenewRows;
			if (sql.includes('FROM contracts c LEFT JOIN clients')) return heads.filter((head) => (params[0] as string[]).includes(head.id));

			return [];
		}),
	} as unknown as DataSource;
	const contexts: Record<string, ReturnType<typeof context>> = {
		[ACTIVE]: context({ scheduled_changes: [] }),
		// Terminó el 30-11: antes del mes del ajuste (diciembre) → rige al renovarse.
		[ENDED]: context({ items: [itemRow({ end_date: '2026-11-30' })], invoices: [], scheduled_changes: [] }),
		[PRICED]: context({ items: [itemRow({ raw: tiered })], invoices: [], scheduled_changes: [] }),
	};
	const changes = {
		loadContext: jest.fn(async (_db: unknown, id: string) => contexts[id]),
		apply: jest.fn().mockResolvedValue({ applied: true }),
	};
	const scheduled = new ContractScheduledChangesService(dataSource, {} as ContractsService, changes as unknown as ContractChangesService);
	const create = jest.spyOn(scheduled, 'create').mockImplementation(async (id) => ({ id: `pact-${id}` }) as never);

	return {
		service: new ContractBulkChangesService(dataSource, changes as unknown as ContractChangesService, scheduled),
		changes,
		create,
		contexts,
	};
};
const change = { trigger: 'on_date' as const, effective_date: '2026-12-01', kind: 'percent_uplift' as const, value: 5 };
const dto = { ids: [ACTIVE, ENDED, PRICED, DRAFT], change };

describe('ajuste de precio en lote', () => {
	it('vista previa: una fila por contrato con cómo rige, mensual antes y después y el motivo de los omitidos; no escribe', async () => {
		const { service, create } = build();
		const { data, summary } = await service.previewScheduledChange(dto, HOLDING, today);

		expect(data.map((row) => [row.contract_number, row.can_save, row.applies, row.effective_date, row.mrr_before, row.mrr_after])).toEqual([
			['CTR-1', true, 'on_date', '2026-12-01', 1200, 1260],
			['CTR-2', true, 'on_renewal', '2026-11-30', 1000, 1050],
			['CTR-3', false, null, null, null, null],
			['CTR-4', false, null, null, null, null],
		]);
		expect(data[2].skip_reason).toContain('modelo de precio');
		expect(data[3].skip_reason).toContain('no está activo');
		expect(summary).toEqual({ contracts: 4, to_save: 2, skipped: 2, on_date: 1, on_renewal: 1, with_blockers: 0 });
		expect(create).not.toHaveBeenCalled();
	});

	it('guardar: un cambio futuro por contrato (desde el mes o al renovarse); un contrato que falla no detiene al resto', async () => {
		const { service, create } = build();

		create.mockImplementationOnce(async () => {
			throw new ConflictException('El contrato está cancelado');
		});
		const result = await service.applyScheduledChange(dto, HOLDING, 'auth-1', today);

		expect(result.failed).toEqual([{ id: ACTIVE, contract_number: 'CTR-1', message: 'El contrato está cancelado' }]);
		expect(result.created).toEqual([
			{
				id: ENDED,
				contract_number: 'CTR-2',
				scheduled_change_id: `pact-${ENDED}`,
				scheduled_change_ids: [`pact-${ENDED}`],
				applies: 'on_renewal',
			},
		]);
		expect(result.skipped.map((row) => row.contract_number)).toEqual(['CTR-3', 'CTR-4']);
		expect(create.mock.calls.map((call) => [call[0], call[1]])).toEqual([
			[
				ACTIVE,
				expect.objectContaining({ trigger: 'on_date', effective_date: '2026-12-01', kind: 'percent_uplift', value: 5, rounding: 'unit_2' }),
			],
			[ENDED, expect.objectContaining({ trigger: 'on_renewal', kind: 'percent_uplift', value: 5 })],
		]);
		expect(create.mock.calls[1][1]).not.toHaveProperty('effective_date');
	});

	it('un ítem con modelo de precio queda fuera del reajuste del contrato y el resto se ajusta; un reajuste igual ya pactado se omite', async () => {
		const { service, contexts } = build();

		contexts[ACTIVE] = context({ items: [itemRow(), soporteRow({ raw: tiered })], scheduled_changes: [] });
		const mixed = (await service.previewScheduledChange({ ...dto, ids: [ACTIVE] }, HOLDING, today)).data[0];

		expect([mixed.can_save, mixed.items, mixed.items_excluded, mixed.mrr_before, mixed.mrr_after]).toEqual([true, 1, 1, 1000, 1050]);
		contexts[ACTIVE] = context({
			scheduled_changes: [
				{
					id: 'p-1',
					contract_item_id: null,
					trigger: 'on_date',
					effective_date: '2026-12-01',
					kind: 'percent_uplift',
					value: 4,
					status: 'scheduled',
				} as never,
			],
		});
		const repeated = (await service.previewScheduledChange({ ...dto, ids: [ACTIVE] }, HOLDING, today)).data[0];

		expect(repeated.can_save).toBe(false);
		expect(repeated.skip_reason).toContain('Ya tiene un cambio programado igual');
	});
});

describe('cambio programado en lote solo para algunos productos (usuarias 13-11)', () => {
	const PRODUCT_LICENCIA = 'a0000000-0000-4000-8000-000000000001';
	const PRODUCT_SOPORTE = 'a0000000-0000-4000-8000-000000000002';
	const withProducts = () => {
		const built = build();

		built.contexts[ACTIVE] = context({
			items: [itemRow({ product_id: PRODUCT_LICENCIA }), soporteRow({ product_id: PRODUCT_SOPORTE })],
			scheduled_changes: [],
		});
		built.contexts[ENDED] = context({ items: [soporteRow({ product_id: PRODUCT_SOPORTE })], invoices: [], scheduled_changes: [] });

		return built;
	};

	it('vista previa: solo cuentan los ítems de esos productos; el contrato sin ellos se omite', async () => {
		const { service } = withProducts();
		const { data } = await service.previewScheduledChange({ ids: [ACTIVE, ENDED], change, product_ids: [PRODUCT_LICENCIA] }, HOLDING, today);

		expect(data.map((row) => [row.contract_number, row.can_save, row.items, row.products, row.mrr_before, row.mrr_after])).toEqual([
			['CTR-1', true, 1, ['Licencia'], 1000, 1050],
			['CTR-2', false, 0, null, null, null],
		]);
		expect(data[1].skip_reason).toBe('No tiene ítems vigentes de los productos elegidos');
	});

	it('guardar: un cambio por ítem del producto (alcance ítem), no uno de todo el contrato', async () => {
		const { service, create } = withProducts();
		const result = await service.applyScheduledChange(
			{ ids: [ACTIVE], change, product_ids: [PRODUCT_LICENCIA, PRODUCT_SOPORTE] },
			HOLDING,
			'auth-1',
			today
		);

		expect(create.mock.calls.map((call) => (call[1] as { contract_item_id?: string }).contract_item_id)).toEqual([LICENCIA, SOPORTE]);
		expect(result.created).toHaveLength(1);
		expect(result.created[0].scheduled_change_ids).toHaveLength(2);
	});
});

describe('renovación automática en lote', () => {
	const rows = [
		{
			id: ACTIVE,
			contract_number: 'CTR-1',
			status: 'Activo',
			client_name: 'Acme',
			live_items: 2,
			items_to_change: 2,
			items_on: 0,
			end_date: '2026-12-31',
		},
		{
			id: ENDED,
			contract_number: 'CTR-2',
			status: 'Activo',
			client_name: 'Beta',
			live_items: 1,
			items_to_change: 0,
			items_on: 1,
			end_date: '2026-11-30',
		},
		{ id: DRAFT, contract_number: 'CTR-4', status: 'En revisión', client_name: 'Delta', live_items: 1, items_to_change: 1, end_date: null },
	];

	it('enciende con el cambio billing_conditions de cada contrato que cambia; los demás se omiten con su motivo', async () => {
		const { service, changes } = build(rows);
		const preview = await service.previewAutoRenew({ ids: [ACTIVE, ENDED, DRAFT], auto_renew: true }, HOLDING);

		expect(preview.data.map((row) => [row.contract_number, row.can_apply, row.skip_reason])).toEqual([
			['CTR-1', true, null],
			['CTR-2', false, 'Ya tiene la renovación automática encendida'],
			['CTR-4', false, 'El contrato no está activo (En revisión)'],
		]);
		expect(preview.data.map((row) => row.current)).toEqual(['off', 'on', 'off']);
		expect(changes.apply).not.toHaveBeenCalled();
		const result = await service.applyAutoRenew({ ids: [ACTIVE, ENDED, DRAFT], auto_renew: true }, HOLDING, 'auth-1', today);

		expect(result.updated).toEqual([{ id: ACTIVE, contract_number: 'CTR-1', items_changed: 2 }]);
		expect(result.skipped).toHaveLength(2);
		expect(changes.apply).toHaveBeenCalledTimes(1);
		expect(changes.apply.mock.calls[0].slice(0, 4)).toEqual([
			ACTIVE,
			expect.objectContaining({ change: { type: 'billing_conditions', auto_renew: true }, reason: 'Renovación automática encendida en lote' }),
			HOLDING,
			'auth-1',
		]);
		expect(LICENCIA).toBeDefined();
	});
});
