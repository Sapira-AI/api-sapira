import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';

import { ContractBulkService, settingsChangeTitle } from './contract-bulk.service';
import { ActivateContractsDto, BulkContractIdsDto, BulkContractSettingsDto } from './dtos/bulk-contracts.dto';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const contract = (id: string, number: string, autoSend: boolean | null, autoInvoice: boolean | null, extra: Record<string, unknown> = {}) => ({
	id,
	contract_number: number,
	auto_send_to_odoo: autoSend,
	auto_invoice: autoInvoice,
	currency_mismatch: false,
	...extra,
});

const build = (rows: unknown[], handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM contracts c')) return rows;

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

	return { service: new ContractBulkService(dataSource), runner, dataSource };
};

const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const errorsOf = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(BadRequestException);

	return fieldErrorsOf(error as HttpException);
};

describe('ContractBulkService.updateSettings', () => {
	it('cambia solo los que difieren, en una transacción, con un evento SETTINGS_CHANGED por contrato', async () => {
		const { service, runner } = build([contract(A, 'CTR-A', false, false), contract(B, 'CTR-B', true, false)]);

		const result = await service.updateSettings({ ids: [A, B], auto_send_to_odoo: true }, 'h-1', 'auth-1');

		expect(result).toEqual({
			bulk_id: expect.any(String),
			updated: 1,
			unchanged: 1,
			results: [
				{ id: A, contract_number: 'CTR-A', changed: true },
				{ id: B, contract_number: 'CTR-B', changed: false },
			],
		});
		const [[selectSql, selectParams]] = calls(runner.query, 'FROM contracts c');

		expect(selectSql).toContain('c.id = ANY($1::uuid[]) AND c.holding_id = $2');
		expect(selectSql).toContain('c.deleted_at IS NULL');
		expect(selectSql).toContain('FOR UPDATE OF c');
		expect(selectParams).toEqual([[A, B], 'h-1']);
		expect(calls(runner.query, 'UPDATE contracts').map(([, params]) => params)).toEqual([[A, 'h-1', true, false]]);

		const events = calls(runner.query, `'SETTINGS_CHANGED'`);

		expect(events).toHaveLength(1);
		const [eventContract, eventHolding, title, , createdBy, metadata] = events[0][1] as unknown[];

		expect([eventContract, eventHolding, title, createdBy]).toEqual([A, 'h-1', 'Envío automático al ERP activado', 'user-1']);
		expect(JSON.parse(metadata as string)).toEqual({
			source: 'api_v2',
			bulk: true,
			bulk_id: result.bulk_id,
			before: { auto_send_to_odoo: false, auto_invoice: false },
			after: { auto_send_to_odoo: true, auto_invoice: false },
		});
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
	});

	it('los eventos de una misma acción comparten bulk_id; si la costura falla se hace rollback y se libera la conexión', async () => {
		const { service, runner } = build([contract(A, 'CTR-A', false, false), contract(B, 'CTR-B', false, false)]);
		const result = await service.updateSettings({ ids: [A, B], auto_send_to_odoo: true }, 'h-1', 'auth-1');
		const ids = calls(runner.query, `'SETTINGS_CHANGED'`).map(([, params]) => JSON.parse((params as unknown[])[5] as string).bulk_id);

		expect(ids).toEqual([result.bulk_id, result.bulk_id]);
		const failing = build([contract(A, 'CTR-A', false, false)], (sql) => {
			if (sql.includes('sapira.writer')) throw new Error('sin conexión');

			return undefined;
		});

		await expect(failing.service.updateSettings({ ids: [A], auto_send_to_odoo: true }, 'h-1', 'auth-1')).rejects.toThrow('sin conexión');
		expect(failing.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(failing.runner.release).toHaveBeenCalledTimes(1);
	});

	it('S6-10: rechaza encender la emisión automática si el contrato no envía al ERP (toda la acción, con mensaje claro)', async () => {
		const { service, runner } = build([contract(A, 'CTR-A', true, false), contract(B, 'CTR-B', false, false)]);

		const errors = await errorsOf(service.updateSettings({ ids: [A, B], auto_invoice: true }, 'h-1', 'auth-1'));

		expect(errors).toEqual([{ field: 'ids.1', message: 'CTR-B: la emisión automática requiere el envío automático al ERP; actívalo primero' }]);
		expect(calls(runner.query, 'UPDATE contracts')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	it('S6-10: apagar el envío con la emisión encendida también se rechaza; encender ambos a la vez se acepta', async () => {
		const first = build([contract(A, 'CTR-A', true, true)]);

		expect(await errorsOf(first.service.updateSettings({ ids: [A], auto_send_to_odoo: false }, 'h-1', 'auth-1'))).toEqual([
			{ field: 'ids.0', message: 'CTR-A: la emisión automática requiere el envío automático al ERP; desactiva también la emisión automática' },
		]);

		const second = build([contract(A, 'CTR-A', false, false)]);
		const result = await second.service.updateSettings({ ids: [A], auto_send_to_odoo: true, auto_invoice: true }, 'h-1', 'auth-1');

		expect(result.updated).toBe(1);
		expect(calls(second.runner.query, `'SETTINGS_CHANGED'`)[0][1]).toContain('Envío automático al ERP activado · Emisión automática activada');

		// Apagar ambos también es válido.
		const third = build([contract(A, 'CTR-A', true, true)]);

		await expect(
			third.service.updateSettings({ ids: [A], auto_send_to_odoo: false, auto_invoice: false }, 'h-1', 'auth-1')
		).resolves.toMatchObject({
			updated: 1,
		});
	});

	it('NULL en envío automático cuenta como envío (mismo criterio que el scheduler)', async () => {
		const { service } = build([contract(A, 'CTR-A', null, false)]);

		await expect(service.updateSettings({ ids: [A], auto_invoice: true }, 'h-1', 'auth-1')).resolves.toMatchObject({ updated: 1 });
	});

	it('ids que no son del holding → 400 con el índice, sin escribir nada', async () => {
		const { service, runner } = build([contract(A, 'CTR-A', false, false)]);

		expect(await errorsOf(service.updateSettings({ ids: [A, C], auto_send_to_odoo: true }, 'h-1', 'auth-1'))).toEqual([
			{ field: 'ids.1', message: 'El contrato no existe en el holding' },
		]);
		expect(calls(runner.query, 'UPDATE contracts')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')).toHaveLength(0);
	});

	it('ítems en otra moneda: 400 antes de que el trigger de moneda rompa el UPDATE', async () => {
		const { service } = build([contract(A, 'CTR-A', false, false, { currency_mismatch: true })]);

		expect(await errorsOf(service.updateSettings({ ids: [A], auto_send_to_odoo: true }, 'h-1', 'auth-1'))).toEqual([
			{ field: 'ids.0', message: 'CTR-A: sus ítems no están en la moneda del contrato; corrígelo antes de cambiar la configuración' },
		]);
	});

	it('sin interruptores → 400 sin tocar la base; usuario sin fila → 403', async () => {
		const { service, dataSource } = build([]);

		await expect(service.updateSettings({ ids: [A] }, 'h-1', 'auth-1')).rejects.toBeInstanceOf(BadRequestException);
		expect((dataSource.query as jest.Mock).mock.calls).toHaveLength(0);

		const noUser = build([], (sql) => (sql.includes('FROM users') ? [] : undefined));

		await expect(noUser.service.updateSettings({ ids: [A], auto_invoice: false }, 'h-1', 'auth-1')).rejects.toBeInstanceOf(ForbiddenException);
		expect(noUser.runner.startTransaction).not.toHaveBeenCalled();
	});

	it('títulos del evento en español y sin nombres de proveedor', () => {
		const off = { auto_send_to_odoo: false, auto_invoice: false };

		expect(settingsChangeTitle(off, { auto_send_to_odoo: false, auto_invoice: true })).toBe('Emisión automática activada');
		expect(settingsChangeTitle({ auto_send_to_odoo: true, auto_invoice: true }, off)).toBe(
			'Envío automático al ERP desactivado · Emisión automática desactivada'
		);
		expect(settingsChangeTitle(off, off)).not.toMatch(/odoo/i);
	});
});

describe('DTOs masivos', () => {
	const check = async <T extends object>(cls: new () => T, body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true }));

	it('ids: 1 a 500 UUID para configuración y borrado; 1 a 100 para activar', async () => {
		expect(await check(BulkContractIdsDto, { ids: [A] })).toEqual([]);
		expect((await check(BulkContractIdsDto, { ids: [] }))[0]).toMatchObject({ field: 'ids', message: 'Elige al menos un contrato' });
		expect((await check(BulkContractIdsDto, { ids: ['x'] }))[0]).toMatchObject({ message: 'Contrato inválido' });
		expect((await check(BulkContractIdsDto, { ids: Array(501).fill(A) }))[0]).toMatchObject({ message: 'Máximo 500 contratos por acción' });
		expect((await check(ActivateContractsDto, { ids: Array(101).fill(A) }))[0]).toMatchObject({
			message: 'Máximo 100 contratos por activación',
		});
	});

	it('configuración: booleanos opcionales y sin holding_id en el body', async () => {
		expect(await check(BulkContractSettingsDto, { ids: [A], auto_send_to_odoo: true, auto_invoice: false })).toEqual([]);
		expect((await check(BulkContractSettingsDto, { ids: [A], auto_invoice: 'si' }))[0]).toMatchObject({ field: 'auto_invoice' });
		expect((await check(BulkContractSettingsDto, { ids: [A], holding_id: 'h-2' }))[0]).toMatchObject({ field: 'holding_id' });
	});
});
