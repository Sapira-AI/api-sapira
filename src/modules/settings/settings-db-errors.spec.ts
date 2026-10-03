import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { accountsCompleteSql, localizeAccountName } from '@/core/utils/account-mappings';

import { isRealIsoDate } from './settings-common';
import { translateDbError } from './settings-db-errors';

const pg = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(String(extra.message ?? 'pg')), { code, ...extra });

describe('translateDbError (nunca 500 sin mensaje)', () => {
	it.each([
		['23505', {}, ConflictException, 'Ya existe un registro con esos datos'],
		['23505', { constraint: 'holding_fx_period_rates_unique_period' }, ConflictException, 'Ya existe una tasa para ese par en esas fechas'],
		['23505', { constraint: 'company_legal_documents_pkey' }, ConflictException, 'Este documento ya está registrado'],
		[
			'23503',
			{ message: 'update or delete on table "x" violates foreign key constraint … is still referenced' },
			ConflictException,
			'Está en uso en otros registros: no se puede eliminar',
		],
		['23503', { message: 'insert … Key (x)=(y) is not present in table' }, BadRequestException, 'Un dato relacionado no existe o ya se eliminó'],
		['23514', { constraint: 'holding_fx_period_rates_rate_check' }, BadRequestException, 'La tasa debe ser mayor que cero'],
		['23514', {}, BadRequestException, 'Un valor no cumple las reglas permitidas'],
		['22008', {}, BadRequestException, 'La fecha no es válida'],
		['22P02', {}, BadRequestException, 'Un dato tiene un formato no válido'],
		['40P01', {}, ConflictException, 'Otra persona modificó estos datos al mismo tiempo: vuelve a intentarlo'],
		[
			'P0001',
			{ message: 'Ya existe una tasa de cambio para este par de monedas en el período especificado. Los períodos no pueden superponerse.' },
			ConflictException,
			'Ya existe una tasa para ese par en esas fechas',
		],
		['P0001', { message: 'El período está cerrado' }, ConflictException, 'El período está cerrado'],
	])('%s %o → %p', (code, extra, type, message) => {
		const translated = translateDbError(pg(code, extra));

		expect(translated).toBeInstanceOf(type);
		expect(translated?.message).toBe(message);
	});

	it('lee el código desde driverError (QueryFailedError de TypeORM)', () => {
		expect(translateDbError({ message: 'x', driverError: { code: '23505' } })?.getStatus()).toBe(409);
	});

	it('HttpException propia, errores sin código o desconocidos quedan igual (null)', () => {
		expect(translateDbError(new NotFoundException('x'))).toBeNull();
		expect(translateDbError(new Error('boom'))).toBeNull();
		expect(translateDbError(pg('XX000'))).toBeNull();
	});
});

describe('fechas reales', () => {
	it('rechaza fechas imposibles y formatos inválidos', () => {
		expect(['2026-02-28', '2024-02-29', '2026-12-31'].map(isRealIsoDate)).toEqual([true, true, true]);
		expect(['2026-02-30', '2025-02-29', '2026-04-31', '2026-13-01', '26-01-01', 20260101].map(isRealIsoDate)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});

describe('cuentas contables (criterio único)', () => {
	it('"completas" exige las 5 cuentas con código y nombre', () => {
		const sql = accountsCompleteSql('m');

		expect(sql).toContain('m.id IS NOT NULL');
		for (const column of ['receivable', 'deferred', 'unbilled', 'revenue', 'fx_difference']) {
			expect(sql).toContain(`NULLIF(btrim(m.${column}_account_code), '') IS NOT NULL`);
			expect(sql).toContain(`NULLIF(btrim(m.${column}_account_name), '') IS NOT NULL`);
		}
	});

	it('defaults en inglés de la tabla → español; vacío → null; propio → igual', () => {
		expect(['Revenue', 'Deferred Revenue', 'Unbilled Revenue (Contract Asset)', '  ', null, 'Ventas SaaS'].map(localizeAccountName)).toEqual([
			'Ingresos',
			'Ingresos diferidos',
			'Ingresos por facturar',
			null,
			null,
			'Ventas SaaS',
		]);
	});
});
