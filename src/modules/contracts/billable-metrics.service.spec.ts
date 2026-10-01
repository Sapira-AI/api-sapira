import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { BillableMetricsController } from './billable-metrics.controller';
import { BillableMetricsService, METRIC_CODE_TAKEN_MESSAGE, METRIC_IN_USE_MESSAGE } from './billable-metrics.service';
import { CreateBillableMetricDto, UpdateBillableMetricDto } from './dtos/billable-metric.dto';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const METRIC = '55555555-5555-4555-8555-555555555555';
const HOLDING = 'h-1';

const metricRow = (overrides: Row = {}): Row => ({
	id: METRIC,
	code: 'rutas_completadas',
	name: 'Rutas completadas',
	description: null,
	aggregation: 'sum',
	unit: 'ruta',
	source_kind: 'manual',
	source_config: {},
	status: 'active',
	created_at: new Date('2026-09-28T10:00:00.000Z'),
	updated_at: new Date('2026-09-28T10:00:00.000Z'),
	archived_at: null,
	prices_count: '2',
	prices_total: '3',
	last_sync_at: null,
	...overrides,
});

const build = (handler: Handler = () => undefined) => {
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM billable_metrics bm WHERE bm.id = $1')) return params[0] === METRIC ? [metricRow()] : [];
		if (sql.includes('FROM billable_metrics bm')) return [metricRow()];
		if (sql.includes('INSERT INTO billable_metrics')) return [{ id: METRIC }];

		return [];
	});
	// Las escrituras corren en una transacción con la costura (`withApiWriter`); el runner comparte el mock de `query`.
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query,
	};
	const dataSource = { query, createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;

	return { service: new BillableMetricsService(dataSource), query, runner };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));

describe('BillableMetricsService', () => {
	it('list: solo activas por defecto, con prices_count y last_sync_at; includeArchived trae todas', async () => {
		const { service, query } = build();
		const result = await service.list(HOLDING);

		expect(result.data[0]).toMatchObject({
			id: METRIC,
			code: 'rutas_completadas',
			aggregation: 'sum',
			unit: 'ruta',
			prices_count: 2,
			prices_total: 3,
			last_sync_at: null,
			status: 'active',
		});
		expect(query.mock.calls[0][0]).toContain(`AND bm.status = 'active'`);
		expect(query.mock.calls[0][1]).toEqual([HOLDING]);
		await service.list(HOLDING, { includeArchived: true });
		expect(query.mock.calls[1][0]).not.toContain(`bm.status = 'active'`);
		// prices_count cuenta solo precios activos; last_sync_at sale de las entries dwh/api.
		expect(query.mock.calls[0][0]).toContain(`p.billable_metric_id = bm.id AND p.status = 'active'`);
		expect(query.mock.calls[0][0]).toContain(`e.source IN ('dwh', 'api')`);
	});

	it('get: 404 si no es del holding', async () => {
		const { service } = build();

		await expect(service.get('66666666-6666-4666-8666-666666666666', HOLDING)).rejects.toBeInstanceOf(NotFoundException);
		expect(await service.get(METRIC, HOLDING)).toMatchObject({ id: METRIC });
	});

	it('create: código único por holding (400 con errors[code]); inserta activa con el usuario y devuelve la métrica', async () => {
		const taken = build((sql) => (sql.includes('WHERE holding_id = $1 AND code = $2') ? [{ id: 'other' }] : undefined));
		const error = await taken.service
			.create({ code: 'rutas_completadas', name: 'Rutas', aggregation: 'sum', unit: 'ruta' }, HOLDING, 'auth-1')
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BadRequestException);
		expect(fieldErrorsOf(error as HttpException)).toEqual([{ field: 'code', message: METRIC_CODE_TAKEN_MESSAGE }]);

		const { service, query } = build((sql) => (sql.includes('WHERE holding_id = $1 AND code = $2') ? [] : undefined));
		const result = await service.create(
			{
				code: 'rutas_completadas',
				name: 'Rutas completadas',
				aggregation: 'sum',
				unit: 'ruta',
				source_kind: 'dwh',
				source_config: { table: 'finance.rutas' },
			},
			HOLDING,
			'auth-1'
		);
		const [insert] = calls(query, 'INSERT INTO billable_metrics');

		expect(insert[1]).toEqual([
			HOLDING,
			'rutas_completadas',
			'Rutas completadas',
			null,
			'sum',
			'ruta',
			'dwh',
			JSON.stringify({ table: 'finance.rutas' }),
			'user-1',
		]);
		expect(result).toMatchObject({ id: METRIC });
	});

	it('update: mezcla con lo guardado, no toca el código y rechaza archivadas (409)', async () => {
		const { service, query } = build();

		await service.update(METRIC, { name: 'Rutas OK', unit: 'viaje' }, HOLDING, 'auth-1');
		const [update] = calls(query, 'UPDATE billable_metrics SET name');

		expect(update[1]).toEqual([METRIC, HOLDING, 'Rutas OK', null, 'sum', 'viaje', 'manual', '{}', 'user-1']);
		expect(update[0]).not.toContain('code =');

		const archived = build((sql) =>
			sql.includes('FROM billable_metrics bm WHERE bm.id = $1') ? [metricRow({ status: 'archived' })] : undefined
		);

		await expect(archived.service.update(METRIC, { name: 'x' }, HOLDING, 'auth-1')).rejects.toBeInstanceOf(ConflictException);
	});

	it('archive: 409 con precios activos; sin ellos archiva; ya archivada es idempotente', async () => {
		const inUse = build();

		await expect(inUse.service.archive(METRIC, HOLDING, 'auth-1')).rejects.toMatchObject({ message: METRIC_IN_USE_MESSAGE });
		expect(calls(inUse.query, `SET status = 'archived'`)).toHaveLength(0);

		const free = build((sql) => (sql.includes('FROM billable_metrics bm WHERE bm.id = $1') ? [metricRow({ prices_count: '0' })] : undefined));

		await free.service.archive(METRIC, HOLDING, 'auth-1');
		expect(calls(free.query, `SET status = 'archived'`)[0][1]).toEqual([METRIC, HOLDING, 'user-1']);

		const already = build((sql) =>
			sql.includes('FROM billable_metrics bm WHERE bm.id = $1') ? [metricRow({ status: 'archived', prices_count: '0' })] : undefined
		);

		expect((await already.service.archive(METRIC, HOLDING, 'auth-1')).status).toBe('archived');
		expect(calls(already.query, `SET status = 'archived'`)).toHaveLength(0);
	});
});

describe('DTOs de métricas', () => {
	const check = async (type: new () => object, body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true })).map(
			(error) => `${error.field}: ${error.message}`
		);

	it('crear: código slug en minúsculas, nombre, agregación y unidad obligatorios, fuente de la lista, nada de holding_id', async () => {
		expect(
			await check(CreateBillableMetricDto, { code: ' Rutas_Completadas ', name: 'Rutas completadas', aggregation: 'sum', unit: 'ruta' })
		).toEqual([]);
		expect(
			await check(CreateBillableMetricDto, { code: 'r', name: '', aggregation: 'avg', unit: '', source_kind: 'bigquery', holding_id: 'h' })
		).toEqual([
			'holding_id: property holding_id should not exist',
			'code: El código necesita al menos 2 caracteres',
			'name: Escribe el nombre de la métrica',
			'aggregation: Elige cómo se agrega la métrica: suma, conteo, máximo, mínimo, último o únicos',
			'unit: Escribe la unidad de la métrica',
			'source_kind: Elige la fuente: manual, csv, dwh o api',
		]);
		expect(await check(CreateBillableMetricDto, { code: 'rutas completadas', name: 'x', aggregation: 'max', unit: 'u' })).toEqual([
			'code: El código solo admite minúsculas, números, guion y guion bajo',
		]);
	});

	it('editar: todo opcional; el código no existe en el DTO', async () => {
		expect(await check(UpdateBillableMetricDto, {})).toEqual([]);
		expect(await check(UpdateBillableMetricDto, { code: 'otro' })).toEqual(['code: property code should not exist']);
		expect(await check(UpdateBillableMetricDto, { description: null, aggregation: 'last' })).toEqual([]);
	});
});

describe('BillableMetricsController', () => {
	it('guards, rutas y paso del holding y del usuario', async () => {
		const service = {
			list: jest.fn().mockResolvedValue({ data: [] }),
			get: jest.fn().mockResolvedValue({}),
			create: jest.fn().mockResolvedValue({}),
			update: jest.fn().mockResolvedValue({}),
			archive: jest.fn().mockResolvedValue({}),
		} as unknown as BillableMetricsService;
		const controller = new BillableMetricsController(service);
		const req = { user: { sub: 'auth-1' } };

		expect(Reflect.getMetadata(GUARDS_METADATA, BillableMetricsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(PATH_METADATA, BillableMetricsController)).toBe('billable-metrics');
		expect(Reflect.getMetadata(PATH_METADATA, BillableMetricsController.prototype.archive)).toBe(':id/archive');
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, BillableMetricsController.prototype.archive)).toBe(200);
		await controller.list('true', HOLDING);
		expect(service.list).toHaveBeenCalledWith(HOLDING, { includeArchived: true });
		await controller.create({ code: 'x', name: 'X', aggregation: 'sum', unit: 'u' }, HOLDING, req);
		expect(service.create).toHaveBeenCalledWith({ code: 'x', name: 'X', aggregation: 'sum', unit: 'u' }, HOLDING, 'auth-1');
		await controller.get(METRIC, HOLDING);
		expect(service.get).toHaveBeenCalledWith(METRIC, HOLDING);
		await controller.update(METRIC, { name: 'Y' }, HOLDING, req);
		expect(service.update).toHaveBeenCalledWith(METRIC, { name: 'Y' }, HOLDING, 'auth-1');
		await controller.archive(METRIC, HOLDING, req);
		expect(service.archive).toHaveBeenCalledWith(METRIC, HOLDING, 'auth-1');
	});
});
