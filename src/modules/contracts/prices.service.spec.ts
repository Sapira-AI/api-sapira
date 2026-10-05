import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { API_WRITER_SQL } from './api-writer';
import { CATALOG_PRICE_MESSAGES, catalogPriceErrors, catalogPriceIds, loadCatalogPrices } from './catalog-prices';
import { CreatePriceDto, QueryPricesDto, UpdatePriceDto } from './dtos/price.dto';
import { PricesController } from './prices.controller';
import {
	PRICE_ALREADY_PUBLISHED_MESSAGE,
	PRICE_ARCHIVED_MESSAGE,
	PRICE_IN_USE_WARNING,
	PRICE_NOT_DRAFT_MESSAGE,
	PRICE_NOT_FOUND_MESSAGE,
	PricesService,
} from './prices.service';

/**
 * Catálogo de precios versionado (Pricing v2 etapa 3, `docs/v2-rediseno/spec-pricing-v2.md` §5): lista con filtros y orden
 * por lista blanca, detalle con versiones y contratos, borrador → publicar (archiva la anterior) → archivar, y las reglas
 * compartidas para copiar un precio de catálogo al contrato (`catalog-prices.ts`).
 */

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const HOLDING = 'h-1';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const METRIC = '55555555-5555-4555-8555-555555555555';
const V1 = '99999999-9999-4999-8999-999999999991';
const V2 = '99999999-9999-4999-8999-999999999992';
const V3 = '99999999-9999-4999-8999-999999999993';

const tiers = [
	{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
	{ from: 501, to: null, per_unit_amount: 0.06, flat_amount: 0 },
];
const spec = { model: 'graduated', quantity_type: 'metered', billable_metric_id: METRIC, tiers, free_units: 100 };

const catalogRow = (overrides: Row = {}): Row => ({
	id: V2,
	name: 'Tramos LatAm — UF',
	product_id: PRODUCT,
	product_name: 'Rutas optimizadas',
	currency: 'CLF',
	model: 'graduated',
	quantity_type: 'metered',
	version: 2,
	status: 'active',
	supersedes_price_id: V1,
	notes: null,
	published_at: new Date('2026-09-01T10:00:00.000Z'),
	archived_at: null,
	created_at: new Date('2026-08-30T10:00:00.000Z'),
	updated_at: new Date('2026-09-01T10:00:00.000Z'),
	metric_id: METRIC,
	metric_code: 'rutas',
	metric_name: 'Rutas completadas',
	metric_unit: 'ruta',
	price_id: V2,
	price_name: 'Tramos LatAm — UF',
	price_version: 2,
	price_status: 'active',
	price_model: 'graduated',
	price_quantity_type: 'metered',
	price_billable_metric_id: METRIC,
	price_unit_amount: null,
	price_tiers: tiers,
	price_package_size: null,
	price_package_amount: null,
	price_seat_minimum_quantity: '0',
	price_free_units: '100.000000',
	price_minimum_amount: null,
	price_cap_amount: null,
	price_invoice_line_mode: 'per_tier',
	price_charge_flat_when_free: false,
	price_list_price_id: null,
	contracts_count: '24',
	...overrides,
});

const build = (handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('c.id AS contract_id'))
			return [{ contract_id: 'c-1', contract_number: 'CTR-2026-001', contract_status: 'Activo', client_name: 'ACME', item_id: 'i-1' }];
		if (sql.includes('WHERE p.id = $1 AND p.holding_id = $2')) return params[0] === V2 ? [catalogRow()] : [];
		if (sql.includes('SELECT COUNT(*) AS total')) return [{ total: '1' }];
		if (sql.includes('FROM prices p') && sql.includes('LIMIT')) return [catalogRow()];
		if (sql.includes('ORDER BY p.version DESC, p.created_at DESC'))
			return [
				{ id: V3, name: 'Tramos LatAm — UF', version: 3, status: 'draft', supersedes_price_id: V2, contracts_count: '0' },
				{ id: V2, name: 'Tramos LatAm — UF', version: 2, status: 'active', supersedes_price_id: V1, contracts_count: '24' },
				{ id: V1, name: 'Tramos LatAm — UF', version: 1, status: 'archived', supersedes_price_id: null, contracts_count: '3' },
			];
		if (sql.includes('FROM products WHERE id = $1')) return [{ id: PRODUCT }];
		if (sql.includes('FROM currencies')) return [{ code: 'CLF' }, { code: 'CLP' }];
		if (sql.includes('FROM billable_metrics WHERE id = $1')) return [{ id: METRIC, status: 'active' }];
		if (sql.includes('COALESCE(MAX(version), 0) + 1')) return [{ next: '3' }];
		if (sql.includes('INSERT INTO prices')) return [{ id: V2 }];

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
	const query = jest.fn(route);
	const dataSource = { query, createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;

	return { service: new PricesService(dataSource), query, runner };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const errorsOf = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(BadRequestException);

	return fieldErrorsOf(error as HttpException);
};
const rejects = async (promise: Promise<unknown>, type: new (...args: never[]) => Error) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(type);

	return (error as HttpException).message;
};

describe('PricesService · lista', () => {
	it('solo catálogo del holding, paginado, con la forma pública de cada precio', async () => {
		const { service, query } = build();
		const result = await service.list(HOLDING, {});

		expect(result).toMatchObject({ total: 1, currentPage: 1, pages: 1, limit: 25 });
		expect(result.data[0]).toEqual({
			id: V2,
			name: 'Tramos LatAm — UF',
			product_id: PRODUCT,
			product_name: 'Rutas optimizadas',
			currency: 'CLF',
			model: 'graduated',
			quantity_type: 'metered',
			billable_metric: { id: METRIC, code: 'rutas', name: 'Rutas completadas', unit: 'ruta' },
			version: 2,
			status: 'active',
			supersedes_price_id: V1,
			contracts_count: 24,
			notes: null,
			published_at: '2026-09-01T10:00:00.000Z',
			archived_at: null,
			created_at: '2026-08-30T10:00:00.000Z',
			updated_at: '2026-09-01T10:00:00.000Z',
			spec: {
				model: 'graduated',
				quantity_type: 'metered',
				billable_metric_id: METRIC,
				unit_amount: null,
				tiers,
				package_size: null,
				package_amount: null,
				seat_minimum_quantity: 0,
				free_units: 100,
				minimum_amount: null,
				cap_amount: null,
				invoice_line_mode: 'per_tier',
				charge_flat_when_free: false,
			},
		});
		const [count, rows] = query.mock.calls as Array<[string, unknown[]]>;

		expect(count[0]).toContain(`p.owner = 'catalog'`);
		expect(count[1]).toEqual([HOLDING]);
		// Orden por defecto y sin filtro de estado (all); contracts_count cuenta contratos no eliminados con copia del precio.
		expect(rows[0]).toContain('ORDER BY p.updated_at DESC, p.version DESC, p.id LIMIT 25 OFFSET 0');
		expect(rows[0]).not.toContain('p.status =');
		expect(rows[0]).toContain('cp.list_price_id = p.id');
		expect(rows[0]).toContain('c.deleted_at IS NULL');
	});

	it('filtros parametrizados (estado, producto, moneda, modelo, búsqueda) y orden por lista blanca', async () => {
		const { service, query } = build();

		await service.list(HOLDING, {
			status: 'draft',
			product_id: PRODUCT,
			currency: 'CLF',
			model: 'graduated',
			search: 'LatAm',
			sortBy: 'contracts_count',
			sortOrder: 'asc',
			page: 3,
			limit: 10,
		});
		const [sql, params] = query.mock.calls[1] as [string, unknown[]];

		expect(sql).toContain('p.status = $2');
		expect(sql).toContain('p.product_id = $3::uuid');
		expect(sql).toContain('p.currency = $4');
		expect(sql).toContain('p.model = $5');
		expect(sql).toContain('(p.name ILIKE $6 OR pr.name ILIKE $6)');
		expect(sql).toContain('ORDER BY contracts_count ASC, p.version DESC, p.id LIMIT 10 OFFSET 20');
		expect(params).toEqual([HOLDING, 'draft', PRODUCT, 'CLF', 'graduated', '%LatAm%']);
		// `status=all` no filtra; el nombre del producto ordena por la tabla de productos.
		await service.list(HOLDING, { status: 'all', sortBy: 'product_name' });
		expect((query.mock.calls[3] as [string])[0]).toContain('ORDER BY pr.name DESC');
		expect((query.mock.calls[3] as [string])[0]).not.toContain('p.status =');
	});
});

describe('PricesService · detalle', () => {
	it('trae versions[] (cadena producto + moneda, la más nueva primero) y contracts[] (hasta 50); 404 si no es del holding', async () => {
		const { service, query } = build();
		const detail = await service.get(V2, HOLDING);

		expect(detail.versions.map((version) => [version.version, version.status, version.contracts_count])).toEqual([
			[3, 'draft', 0],
			[2, 'active', 24],
			[1, 'archived', 3],
		]);
		expect(detail.contracts).toEqual([
			{ contract_id: 'c-1', contract_number: 'CTR-2026-001', contract_status: 'Activo', client_name: 'ACME', item_id: 'i-1' },
		]);
		const [versions] = calls(query, 'ORDER BY p.version DESC, p.created_at DESC');

		expect(versions[1]).toEqual([HOLDING, PRODUCT, 'CLF']);
		const [contracts] = calls(query, 'c.id AS contract_id');

		expect(contracts[0]).toContain('LIMIT 50');
		expect(contracts[1]).toEqual([V2, HOLDING]);
		expect(await rejects(service.get(V1, HOLDING), NotFoundException)).toBe(PRICE_NOT_FOUND_MESSAGE);
	});
});

describe('PricesService · crear y editar', () => {
	const dto = (overrides: Record<string, unknown> = {}) =>
		({ name: 'Tramos LatAm — UF', product_id: PRODUCT, currency: 'CLF', spec, ...overrides }) as CreatePriceDto;

	it('crear: borrador con la versión siguiente de producto + moneda, spec normalizado, sin supersedes', async () => {
		const { service, runner } = build();
		const query = runner.query;
		const result = await service.create(dto({ notes: 'v3: baja el tramo 2' }), HOLDING, 'auth-1');

		expect(result.id).toBe(V2);
		// Costura: la versión y el INSERT corren en una transacción con `sapira.writer = 'api'` como primera sentencia.
		expect(query.mock.calls[0][0]).toBe(API_WRITER_SQL);
		expect(runner.commitTransaction).toHaveBeenCalled();
		const [next] = calls(query, 'COALESCE(MAX(version), 0) + 1');

		expect(next[0]).toContain(`owner = 'catalog'`);
		expect(next[1]).toEqual([HOLDING, PRODUCT, 'CLF']);
		const [insert] = calls(query, 'INSERT INTO prices');

		expect(insert[0]).toContain(`'catalog'`);
		expect(insert[0]).toContain(`'draft'`);
		expect(insert[1]).toEqual([
			HOLDING,
			PRODUCT,
			'Tramos LatAm — UF',
			'CLF',
			'graduated',
			'metered',
			METRIC,
			null,
			JSON.stringify(tiers),
			null,
			null,
			0,
			100,
			null,
			null,
			'single',
			false,
			3,
			null,
			'v3: baja el tramo 2',
			'user-1',
		]);
	});

	it('crear: 400 por producto ajeno, moneda no habilitada, spec incoherente (spec.<campo>) y métrica inexistente o archivada', async () => {
		const missing = build((sql) => {
			if (sql.includes('FROM products WHERE id = $1')) return [];
			if (sql.includes('FROM billable_metrics WHERE id = $1')) return [];

			return undefined;
		});

		expect(
			await errorsOf(
				missing.service.create(
					dto({ currency: 'USD', spec: { ...spec, tiers: [{ from: 2, to: null, per_unit_amount: 1 }] } }),
					HOLDING,
					'auth-1'
				)
			)
		).toEqual([
			{ field: 'product_id', message: 'El producto no existe en el catálogo del holding' },
			{ field: 'currency', message: 'La moneda USD no está habilitada' },
			{ field: 'spec.tiers[0].from', message: 'El primer tramo empieza en 1' },
			{ field: 'spec.billable_metric_id', message: 'La métrica facturable no existe en el holding' },
		]);
		expect(calls(missing.query, 'INSERT INTO prices')).toHaveLength(0);

		const archived = build((sql) => (sql.includes('FROM billable_metrics WHERE id = $1') ? [{ id: METRIC, status: 'archived' }] : undefined));

		expect(await errorsOf(archived.service.create(dto(), HOLDING, 'auth-1'))).toEqual([
			{ field: 'spec.billable_metric_id', message: 'La métrica facturable está archivada' },
		]);
	});

	it('editar: solo borradores (409 si está publicado); actualiza nombre, spec y nota sin tocar producto ni moneda', async () => {
		const published = build();

		expect(await rejects(published.service.update(V2, { name: 'x' }, HOLDING, 'auth-1'), ConflictException)).toBe(PRICE_NOT_DRAFT_MESSAGE);
		expect(calls(published.query, 'UPDATE prices SET name')).toHaveLength(0);

		const draft = build((sql, params) =>
			sql.includes('WHERE p.id = $1 AND p.holding_id = $2') && params[0] === V2
				? [catalogRow({ status: 'draft', published_at: null })]
				: undefined
		);

		await draft.service.update(
			V2,
			{ name: 'Tramos LatAm v3', spec: { ...spec, free_units: 200 }, notes: null } as UpdatePriceDto,
			HOLDING,
			'auth-1'
		);
		const [update] = calls(draft.runner.query, 'UPDATE prices SET name');

		expect(draft.runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);

		expect(update[0]).toContain(`status = 'draft'`);
		expect(update[0]).not.toContain('product_id =');
		expect(update[0]).not.toContain('currency =');
		expect(update[1]).toEqual([
			V2,
			HOLDING,
			'Tramos LatAm v3',
			'graduated',
			'metered',
			METRIC,
			null,
			JSON.stringify(tiers),
			null,
			null,
			0,
			200,
			null,
			null,
			'single',
			false,
			null,
			'user-1',
		]);
	});

	it('nueva versión: copia la fuente como borrador con supersedes = origen y lo que venga en el body', async () => {
		const { service, runner } = build();

		await service.newVersion(V2, { notes: 'v3' }, HOLDING, 'auth-1');
		const [insert] = calls(runner.query, 'INSERT INTO prices');
		const params = insert[1] as unknown[];

		expect(params.slice(0, 6)).toEqual([HOLDING, PRODUCT, 'Tramos LatAm — UF', 'CLF', 'graduated', 'metered']);
		expect(params.slice(15)).toEqual(['per_tier', false, 3, V2, 'v3', 'user-1']);
	});
});

describe('PricesService · publicar y archivar', () => {
	const draftV3 = catalogRow({ id: V3, version: 3, status: 'draft', supersedes_price_id: null, published_at: null, contracts_count: '0' });

	it('publicar: en una transacción archiva la activa anterior de producto + moneda y activa la nueva con supersedes y published_at', async () => {
		const { service, runner } = build((sql, params) => {
			if (sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1'))
				return [{ id: V3, status: 'draft', product_id: PRODUCT, currency: 'CLF', supersedes_price_id: null }];
			if (sql.includes(`status = 'active' AND id <> $4`)) return [{ id: V2 }];
			if (sql.includes('WHERE p.id = $1 AND p.holding_id = $2') && params[0] === V3)
				return [{ ...draftV3, status: 'active', supersedes_price_id: V2 }];

			return undefined;
		});
		const result = await service.publish(V3, HOLDING, 'auth-1');

		expect(result).toMatchObject({ id: V3, status: 'active', supersedes_price_id: V2, superseded_price_id: V2 });
		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		const [lock] = calls(runner.query, 'FOR UPDATE');

		expect(lock[1]).toEqual([V3, HOLDING]);
		const [archive] = calls(runner.query, `SET status = 'archived'`);

		expect(archive[1]).toEqual([[V2], HOLDING, 'user-1']);
		const [activate] = calls(runner.query, `SET status = 'active'`);

		expect(activate[0]).toContain('published_at = now()');
		expect(activate[0]).toContain('supersedes_price_id = COALESCE($3, supersedes_price_id)');
		expect(activate[1]).toEqual([V3, HOLDING, V2, 'user-1']);
		// Nada toca contract_items ni las copias owner = contract: los contratos firmados siguen con su precio.
		expect(runner.query.mock.calls.some(([sql]) => (sql as string).includes('contract_items'))).toBe(false);
	});

	it('publicar: 409 si ya está publicado o archivado, 404 si no existe; siempre rollback y release', async () => {
		const cases: Array<[Row | null, new (...args: never[]) => Error, string]> = [
			[{ id: V2, status: 'active' }, ConflictException, PRICE_ALREADY_PUBLISHED_MESSAGE],
			[{ id: V1, status: 'archived' }, ConflictException, PRICE_ARCHIVED_MESSAGE],
			[null, NotFoundException, PRICE_NOT_FOUND_MESSAGE],
		];

		for (const [row, type, message] of cases) {
			const { service, runner } = build((sql) =>
				sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1') ? (row ? [row] : []) : undefined
			);

			expect(await rejects(service.publish(V2, HOLDING, 'auth-1'), type)).toBe(message);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
			expect(runner.release).toHaveBeenCalled();
			expect(calls(runner.query, `SET status = 'active'`)).toHaveLength(0);
		}
	});

	it('archivar: permitido con contratos (conservan su copia) y avisa con contracts_count; idempotente', async () => {
		const { service, runner } = build();
		const result = await service.archive(V2, HOLDING, 'auth-1');

		expect(result.warnings).toEqual([PRICE_IN_USE_WARNING(24)]);
		expect(calls(runner.query, `SET status = 'archived'`)[0][1]).toEqual([V2, HOLDING, 'user-1']);
		expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);

		const already = build((sql, params) =>
			sql.includes('WHERE p.id = $1 AND p.holding_id = $2') && params[0] === V2
				? [catalogRow({ status: 'archived', contracts_count: '0' })]
				: undefined
		);
		const again = await already.service.archive(V2, HOLDING, 'auth-1');

		expect(again).toMatchObject({ status: 'archived', warnings: [] });
		expect(calls(already.query, `SET status = 'archived'`)).toHaveLength(0);
		expect(calls(already.runner.query, `SET status = 'archived'`)).toHaveLength(0);
	});
});

describe('catalog-prices (reglas compartidas alta / item_add)', () => {
	it('loadCatalogPrices lee solo owner = catalog del holding y devuelve el spec listo para copiar', async () => {
		const query = jest.fn<Promise<Row[]>, [string, unknown[]]>(async () => [
			{
				id: V2,
				name: 'Tramos',
				product_id: PRODUCT,
				currency: 'clf',
				status: 'active',
				version: '2',
				model: 'graduated',
				quantity_type: 'fixed',
				tiers: JSON.stringify(tiers),
			},
		]);
		const map = await loadCatalogPrices({ query } as unknown as DataSource, [V2], HOLDING);

		expect(query.mock.calls[0][0]).toContain(`owner = 'catalog'`);
		expect(query.mock.calls[0][1]).toEqual([[V2], HOLDING]);
		expect(map.get(V2)).toMatchObject({ id: V2, currency: 'CLF', version: 2, spec: { model: 'graduated', tiers } });
		expect(await loadCatalogPrices({ query } as unknown as DataSource, [], HOLDING)).toEqual(new Map());
		expect(query).toHaveBeenCalledTimes(1);
		expect(catalogPriceIds([{ price_id: V2 }, { price_id: V2 }, { price_id: null }, {}])).toEqual([V2]);
	});

	it('catalogPriceErrors: inexistente, borrador, archivado, otro producto, otra moneda, inline + catálogo', () => {
		const catalog = { id: V2, name: 'x', product_id: PRODUCT, currency: 'CLF', status: 'active', version: 2, spec: spec as never };
		const messages = (input: Partial<Parameters<typeof catalogPriceErrors>[0]>) =>
			catalogPriceErrors({ field: 'items.0', catalog, inline: false, product_id: PRODUCT, contract_currency: 'CLF', ...input }).map(
				(error) => error.message
			);

		expect(messages({})).toEqual([]);
		expect(messages({ catalog: undefined })).toEqual([CATALOG_PRICE_MESSAGES.missing]);
		expect(messages({ catalog: undefined, inline: true })).toEqual([CATALOG_PRICE_MESSAGES.both, CATALOG_PRICE_MESSAGES.missing]);
		expect(messages({ catalog: { ...catalog, status: 'draft' } })).toEqual([CATALOG_PRICE_MESSAGES.draft]);
		expect(messages({ catalog: { ...catalog, status: 'archived' } })).toEqual([CATALOG_PRICE_MESSAGES.archived]);
		expect(messages({ product_id: 'otro' })).toEqual([CATALOG_PRICE_MESSAGES.product]);
		expect(messages({ contract_currency: 'clp' })).toEqual([CATALOG_PRICE_MESSAGES.currency('CLF', 'CLP')]);
		expect(
			catalogPriceErrors({ field: 'change.items.1', catalog: undefined, inline: false, product_id: PRODUCT, contract_currency: 'CLF' })[0].field
		).toBe('change.items.1.price_id');
	});
});

describe('DTOs del catálogo', () => {
	const check = async (type: new () => object, body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true })).map(
			(error) => `${error.field}: ${error.message}`
		);

	it('crear: nombre, producto, moneda (mayúsculas) y spec anidado obligatorios; nada de holding_id ni owner', async () => {
		expect(await check(CreatePriceDto, { name: ' Tramos ', product_id: PRODUCT, currency: 'clf', spec })).toEqual([]);
		expect(
			(
				await check(CreatePriceDto, {
					name: '',
					product_id: 'x',
					currency: 'c',
					spec: { model: 'matrix' },
					holding_id: 'h',
					owner: 'catalog',
				})
			).sort()
		).toEqual([
			'currency: Moneda inválida',
			'holding_id: property holding_id should not exist',
			'name: Escribe el nombre del precio',
			'owner: property owner should not exist',
			'product_id: Producto inválido',
			'spec.model: Elige el modelo de precio: fijo, por tramos, volumen, paquete o asiento',
			'spec.quantity_type: Indica si la cantidad es fija o medida',
		]);
		expect(plainToInstance(CreatePriceDto, { currency: ' clf ' }).currency).toBe('CLF');
	});

	it('editar: todo opcional; producto y moneda no existen en el DTO', async () => {
		expect(await check(UpdatePriceDto, {})).toEqual([]);
		expect(await check(UpdatePriceDto, { product_id: PRODUCT })).toEqual(['product_id: property product_id should not exist']);
		expect(await check(UpdatePriceDto, { currency: 'CLP' })).toEqual(['currency: property currency should not exist']);
		expect(await check(UpdatePriceDto, { notes: null, spec: { ...spec, free_units: -1 } })).toEqual([
			'spec.free_units: Las unidades gratis no pueden ser negativas',
		]);
	});

	it('query: estado, modelo y orden de la lista blanca; página y límite numéricos (máximo 200)', async () => {
		expect(
			await check(QueryPricesDto, {
				status: 'draft',
				model: 'seat',
				sortBy: 'contracts_count',
				sortOrder: 'asc',
				page: '2',
				limit: '50',
				currency: 'clp',
			})
		).toEqual([]);
		expect(
			await check(QueryPricesDto, { status: 'x', model: 'matrix', sortBy: 'holding_id', sortOrder: 'up', limit: 500, owner: 'contract' })
		).toEqual([
			'owner: Solo se lista el catálogo (owner = catalog)',
			'status: Estado inválido: active, draft, archived o all',
			'model: Modelo inválido',
			'sortBy: Orden inválido',
			'sortOrder: Orden inválido',
			'limit: Máximo 200 por página',
		]);
	});
});

describe('PricesController', () => {
	it('guards, rutas, códigos HTTP y paso del holding y del usuario', async () => {
		const service = {
			list: jest.fn().mockResolvedValue({ data: [] }),
			get: jest.fn().mockResolvedValue({}),
			create: jest.fn().mockResolvedValue({}),
			update: jest.fn().mockResolvedValue({}),
			publish: jest.fn().mockResolvedValue({}),
			archive: jest.fn().mockResolvedValue({}),
			newVersion: jest.fn().mockResolvedValue({}),
		} as unknown as PricesService;
		const controller = new PricesController(service);
		const req = { user: { sub: 'auth-1' } };
		const proto = PricesController.prototype;

		expect(Reflect.getMetadata(GUARDS_METADATA, PricesController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(PATH_METADATA, PricesController)).toBe('prices');
		expect(Reflect.getMetadata(PATH_METADATA, proto.publish)).toBe(':id/publish');
		expect(Reflect.getMetadata(PATH_METADATA, proto.archive)).toBe(':id/archive');
		expect(Reflect.getMetadata(PATH_METADATA, proto.newVersion)).toBe(':id/new-version');
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.publish)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.archive)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.newVersion)).toBe(201);
		await controller.list({ status: 'active' }, HOLDING);
		expect(service.list).toHaveBeenCalledWith(HOLDING, { status: 'active' });
		await controller.create({ name: 'x' } as CreatePriceDto, HOLDING, req);
		expect(service.create).toHaveBeenCalledWith({ name: 'x' }, HOLDING, 'auth-1');
		await controller.get(V2, HOLDING);
		expect(service.get).toHaveBeenCalledWith(V2, HOLDING);
		await controller.update(V2, { name: 'y' }, HOLDING, req);
		expect(service.update).toHaveBeenCalledWith(V2, { name: 'y' }, HOLDING, 'auth-1');
		await controller.publish(V2, HOLDING, req);
		expect(service.publish).toHaveBeenCalledWith(V2, HOLDING, 'auth-1');
		await controller.archive(V2, HOLDING, req);
		expect(service.archive).toHaveBeenCalledWith(V2, HOLDING, 'auth-1');
		await controller.newVersion(V2, { notes: 'v3' }, HOLDING, req);
		expect(service.newVersion).toHaveBeenCalledWith(V2, { notes: 'v3' }, HOLDING, 'auth-1');
	});
});
