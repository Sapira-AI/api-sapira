import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { PermissionContext } from '@/guards/permissions.service';

import { AccountingPeriodsService, dayBefore, isFirstDayOfMonth, isLastDayOfMonth, monthLabel } from './accounting-periods.service';
import { fakeDb, Handler } from './fake-db.testing-spec';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const COMPANY = '66666666-6666-4666-8666-666666666666';
const actor: PermissionContext = {
	userId: 'user-1',
	name: 'Ana Pérez',
	email: 'ana@x.cl',
	isSuperAdmin: false,
	roleId: 'r1',
	codes: new Set(['CLOSE_PERIODS']),
};

const build = (cutoff: string | null, extra: Handler[] = []) => {
	const db = fakeDb([
		...extra,
		['FOR UPDATE', (params) => (params[1] === HOLDING ? [{ id: COMPANY }] : [])],
		['SELECT cutoff_date FROM accounting_period_cutoff', () => (cutoff ? [{ cutoff_date: cutoff }] : [])],
		['SELECT id, legal_name, currency FROM companies', (params) => (params[1] === HOLDING ? [{ id: COMPANY }] : [])],
	]);

	return { db, service: new AccountingPeriodsService(db as unknown as DataSource) };
};

describe('fechas de período', () => {
	it('último día de mes, día 1, día anterior y nombre del mes', () => {
		expect(['2026-02-28', '2024-02-29', '2026-08-31', '2026-08-30', '2026-02-30'].map(isLastDayOfMonth)).toEqual([
			true,
			true,
			true,
			false,
			false,
		]);
		expect(['2026-07-01', '2026-07-02'].map(isFirstDayOfMonth)).toEqual([true, false]);
		expect(dayBefore('2026-03-01')).toBe('2026-02-28');
		expect(monthLabel('2026-07-01')).toBe('Julio 2026');
	});
});

describe('AccountingPeriodsService', () => {
	it('cerrar: fecha que no es fin de mes o motivo corto → 400, sin abrir transacción', async () => {
		const { db, service } = build(null);

		await expect(service.close(HOLDING, COMPANY, { until_date: '2026-08-30', reason: 'Cierre de agosto' }, actor)).rejects.toThrow(
			'La fecha de cierre debe ser el último día de un mes'
		);
		await expect(service.close(HOLDING, COMPANY, { until_date: '2026-08-31', reason: '  corto  ' }, actor)).rejects.toThrow(
			'El motivo debe tener al menos 10 caracteres'
		);
		expect(db.calls).toHaveLength(0);
	});

	it('cerrar sin cierre previo: upsert del cutoff + evento con el usuario de la sesión, en una transacción', async () => {
		const { db, service } = build(null);

		await service.close(HOLDING, COMPANY, { until_date: '2026-08-31', reason: 'Cierre contable de agosto' }, actor);
		const [cutoff] = db.statements('INSERT INTO accounting_period_cutoff');
		const [event] = db.statements('INSERT INTO accounting_period_events');

		expect(cutoff.params).toEqual([HOLDING, COMPANY, '2026-08-31', 'CLOSED', 'user-1', 'Ana Pérez', 'ana@x.cl', 'Cierre contable de agosto']);
		expect(event.params).toEqual([
			HOLDING,
			COMPANY,
			'CLOSED',
			null,
			'2026-08-31',
			'user-1',
			'Ana Pérez',
			'ana@x.cl',
			'Cierre contable de agosto',
		]);
		expect(db.committed()).toBe(1);
	});

	it('cerrar a la misma fecha o antes del cierre actual → 409 y rollback', async () => {
		const { db, service } = build('2026-08-31');

		await expect(service.close(HOLDING, COMPANY, { until_date: '2026-08-31', reason: 'Cierre de agosto' }, actor)).rejects.toThrow(
			new ConflictException('Ya está cerrado hasta el 31-08-2026')
		);
		await expect(service.close(HOLDING, COMPANY, { until_date: '2026-07-31', reason: 'Cierre de julio' }, actor)).rejects.toThrow(
			'No se puede cerrar antes del cierre actual (31-08-2026): para retroceder, reabre desde el mes que necesitas'
		);
		expect(db.statements('INSERT INTO accounting_period_events')).toHaveLength(0);
		expect(db.rolledBack()).toBe(2);
	});

	it('cerrar avanza desde el cierre actual y lo registra como "antes"', async () => {
		const { db, service } = build('2026-07-31');

		await service.close(HOLDING, COMPANY, { until_date: '2026-09-30', reason: 'Cierre del trimestre' }, actor);
		expect(db.statements('INSERT INTO accounting_period_events')[0].params.slice(3, 5)).toEqual(['2026-07-31', '2026-09-30']);
	});

	it('reabrir: día 1, debe haber cierre y el mes debe estar cerrado; nuevo cierre = día anterior', async () => {
		await expect(
			build('2026-08-31').service.reopen(HOLDING, COMPANY, { from_date: '2026-07-15', reason: 'Ajuste de factura' }, actor)
		).rejects.toThrow('La fecha de reapertura debe ser el día 1 de un mes');
		await expect(build(null).service.reopen(HOLDING, COMPANY, { from_date: '2026-07-01', reason: 'Ajuste de factura' }, actor)).rejects.toThrow(
			'No hay períodos cerrados para reabrir'
		);
		await expect(
			build('2026-06-30').service.reopen(HOLDING, COMPANY, { from_date: '2026-07-01', reason: 'Ajuste de factura' }, actor)
		).rejects.toThrow('Julio 2026 ya está abierto (cerrado hasta 30-06-2026)');
		const { db, service } = build('2026-08-31');

		await service.reopen(HOLDING, COMPANY, { from_date: '2026-07-01', reason: 'Ajuste de factura de julio' }, actor);
		expect(db.statements('INSERT INTO accounting_period_events')[0].params.slice(2, 5)).toEqual(['REOPENED', '2026-08-31', '2026-06-30']);
		expect(db.statements('INSERT INTO accounting_period_cutoff')[0].params[2]).toBe('2026-06-30');
	});

	it('compañía de otro holding → 404', async () => {
		const { service } = build(null);

		await expect(
			service.close('99999999-9999-4999-8999-999999999999', COMPANY, { until_date: '2026-08-31', reason: 'Cierre de agosto' }, actor)
		).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.get('99999999-9999-4999-8999-999999999999', COMPANY)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('GET arma cierre e historial', async () => {
		const { service } = build(null, [
			[
				'SELECT * FROM accounting_period_cutoff',
				() => [{ cutoff_date: '2026-07-31', last_action: 'CLOSED', last_action_by_name: 'Ana', last_action_reason: 'Cierre julio' }],
			],
			[
				'FROM accounting_period_events',
				() => [
					{
						id: 'e1',
						action: 'CLOSED',
						cutoff_date_before: null,
						cutoff_date_after: '2026-07-31',
						performed_by_name: 'Ana',
						performed_by_email: 'a@x',
						reason: 'Cierre julio',
					},
				],
			],
		]);
		const periods = await service.get(HOLDING, COMPANY);

		expect(periods).toMatchObject({
			cutoff_date: '2026-07-31',
			last_action: 'CLOSED',
			events: [{ action: 'CLOSED', cutoff_date_after: '2026-07-31' }],
		});
	});
});
