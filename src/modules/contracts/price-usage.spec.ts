import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { QueryContractPricesDto } from './dtos/price.dto';
import { buildModelsUsage, NO_MODEL } from './price-usage';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';

/**
 * Planes y precios › Modelos de precio y Precios › En contratos (decisión 07-10): `GET /prices/models/usage` y
 * `GET /prices/contract-prices`, solo lectura.
 */

type Row = Record<string, unknown>;

const HOLDING = 'h-1';
const NOW = new Date('2026-10-07T15:00:00.000Z');
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const METRIC = '55555555-5555-4555-8555-555555555555';

const build = (handler: (sql: string, params: unknown[]) => Row[] | undefined = () => undefined) => {
	const query = jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params) ?? []);
	const service = new PricesService({ query } as unknown as DataSource);

	return { service, query };
};

describe('buildModelsUsage', () => {
	it('grilla completa modelo × cantidad con ceros, `none` al final y totales de precios sumados', () => {
		const usage = buildModelsUsage(
			[
				{ model: 'standard', quantity_type: 'metered', items_in_use: '131', contracts: '40' },
				{ model: NO_MODEL, quantity_type: 'fixed', items_in_use: '12', contracts: '5' },
				{ model: 'percentage', quantity_type: 'fixed', items_in_use: '9', contracts: '9' },
			],
			[
				{ model: 'standard', quantity_type: 'metered', owner: 'contract', prices: '131' },
				{ model: 'graduated', quantity_type: 'metered', owner: 'catalog', prices: '2' },
				{ model: 'graduated', quantity_type: 'metered', owner: 'quote', prices: '7' },
			],
			[
				{ model: 'standard', items_in_use: '131', contracts: '40' },
				{ model: NO_MODEL, items_in_use: '12', contracts: '5' },
			],
			[
				{ quantity_type: 'metered', is_total: 0, items_in_use: '131', contracts: '40' },
				{ quantity_type: null, is_total: 1, items_in_use: '131', contracts: '40' },
			]
		);

		expect(usage.models).toHaveLength(11);
		expect(usage.models[0]).toEqual({
			model: 'standard',
			quantity_type: 'fixed',
			items_in_use: 0,
			contracts: 0,
			catalog_prices: 0,
			contract_prices: 0,
		});
		expect(usage.models.find((row) => row.model === 'standard' && row.quantity_type === 'metered')).toEqual({
			model: 'standard',
			quantity_type: 'metered',
			items_in_use: 131,
			contracts: 40,
			catalog_prices: 0,
			contract_prices: 131,
		});
		// Cotizaciones (`owner = quote`) no cuentan; modelos desconocidos se ignoran.
		expect(usage.models.find((row) => row.model === 'graduated' && row.quantity_type === 'metered')).toMatchObject({
			catalog_prices: 2,
			contract_prices: 0,
		});
		expect(usage.models.at(-1)).toEqual({
			model: NO_MODEL,
			quantity_type: 'fixed',
			items_in_use: 12,
			contracts: 5,
			catalog_prices: 0,
			contract_prices: 0,
		});
		expect(usage.totals).toEqual({ items_in_use: 131, contracts: 40, catalog_prices: 2, contract_prices: 131 });
		expect(usage.by_model).toEqual([
			{ model: 'standard', items_in_use: 131, contracts: 40 },
			{ model: 'graduated', items_in_use: 0, contracts: 0 },
			{ model: 'volume', items_in_use: 0, contracts: 0 },
			{ model: 'package', items_in_use: 0, contracts: 0 },
			{ model: 'seat', items_in_use: 0, contracts: 0 },
			{ model: NO_MODEL, items_in_use: 12, contracts: 5 },
		]);
		expect(usage.by_quantity_type).toEqual([
			{ quantity_type: 'fixed', items_in_use: 0, contracts: 0 },
			{ quantity_type: 'metered', items_in_use: 131, contracts: 40 },
		]);
	});

	it('sin datos: todo en cero', () => {
		const usage = buildModelsUsage([], []);

		expect(usage.models.every((row) => row.items_in_use === 0 && row.contract_prices === 0)).toBe(true);
		expect(usage.totals).toEqual({ items_in_use: 0, contracts: 0, catalog_prices: 0, contract_prices: 0 });
	});
});

describe('PricesService.modelsUsage', () => {
	it('ítems vivos de contratos no eliminados ni cancelados, con hoy de Santiago; precios de catálogo no archivados y de contratos no eliminados', async () => {
		const { service, query } = build((sql) => {
			if (sql.includes('GROUP BY 1, 2, 3')) return [{ model: 'standard', quantity_type: 'metered', owner: 'contract', prices: '131' }];
			if (sql.includes('GROUP BY 1, 2')) return [{ model: 'standard', quantity_type: 'metered', items_in_use: '131', contracts: '40' }];
			if (sql.includes('GROUPING SETS')) return [{ quantity_type: null, is_total: 1, items_in_use: '131', contracts: '40' }];

			return undefined;
		});
		const usage = await service.modelsUsage(HOLDING, NOW);

		expect(usage.totals).toEqual({ items_in_use: 131, contracts: 40, catalog_prices: 0, contract_prices: 131 });
		const [items, prices, byModel, byQuantity] = query.mock.calls as Array<[string, unknown[]]>;

		expect(items[1]).toEqual([HOLDING, '2026-10-07']);
		expect(items[0]).toContain('c.deleted_at IS NULL');
		expect(items[0]).toContain(`c.status IS DISTINCT FROM 'Cancelado'`);
		expect(items[0]).toContain('ci.end_date IS NULL OR ci.end_date >= $2::date');
		expect(items[0]).toContain('ci.churn_date IS NULL OR ci.churn_date > $2::date');
		expect(items[0]).toContain('LEFT JOIN prices p ON p.id = ci.price_id');
		expect(prices[1]).toEqual([HOLDING]);
		expect(prices[0]).toContain(`p.owner = 'catalog' AND p.status <> 'archived'`);
		expect(prices[0]).toContain(`p.owner = 'contract' AND c.deleted_at IS NULL`);
		expect(byModel[0]).toContain('GROUP BY 1');
		expect(byModel[1]).toEqual([HOLDING, '2026-10-07']);
		expect(byQuantity[0]).toContain('p.id IS NOT NULL');
		expect(byQuantity[0]).toContain('GROUP BY GROUPING SETS ((p.quantity_type), ())');
	});
});

describe('PricesService.contractPrices', () => {
	const row: Row = {
		id: 'p-1',
		name: 'Rutas optimizadas',
		currency: 'CLP',
		model: 'standard',
		quantity_type: 'metered',
		updated_at: new Date('2026-10-01T00:00:00.000Z'),
		contract_id: 'c-1',
		contract_number: 'CTR-2026-001',
		contract_status: 'active',
		client_id: 'cl-1',
		client_name: 'SimpliRoute',
		product_id: PRODUCT,
		product_name: 'Rutas',
		metric_id: METRIC,
		metric_code: 'rutas',
		metric_name: 'Rutas completadas',
		metric_unit: 'ruta',
		price_id: 'p-1',
		price_model: 'standard',
		price_quantity_type: 'metered',
		price_billable_metric_id: METRIC,
		price_unit_amount: '150.000000',
		price_tiers: null,
		price_free_units: '0',
		price_seat_minimum_quantity: '0',
		price_invoice_line_mode: 'single',
		price_charge_flat_when_free: false,
		price_list_price_id: null,
		items_count: '1',
		item_ids: ['ci-1'],
	};

	it('solo `owner = contract` del holding, paginado, con contrato, cliente, producto, métrica, spec e ítems', async () => {
		const { service, query } = build((sql) =>
			sql.includes('COUNT(*) AS total') ? [{ total: '131' }] : sql.includes('LIMIT') ? [row] : undefined
		);
		const result = await service.contractPrices(HOLDING, {}, NOW);

		expect(result).toMatchObject({ total: 131, currentPage: 1, pages: 6, limit: 25 });
		expect(result.data[0]).toEqual({
			id: 'p-1',
			name: 'Rutas optimizadas',
			currency: 'CLP',
			model: 'standard',
			quantity_type: 'metered',
			contract: { id: 'c-1', number: 'CTR-2026-001', status: 'active' },
			client: { id: 'cl-1', name: 'SimpliRoute' },
			product: { id: PRODUCT, name: 'Rutas' },
			billable_metric: { id: METRIC, code: 'rutas', name: 'Rutas completadas', unit: 'ruta' },
			list_price_id: null,
			items_count: 1,
			item_ids: ['ci-1'],
			updated_at: '2026-10-01T00:00:00.000Z',
			spec: expect.objectContaining({ model: 'standard', quantity_type: 'metered', unit_amount: 150, billable_metric_id: METRIC }),
		});
		const [count, rows] = query.mock.calls as Array<[string, unknown[]]>;

		expect(count[0]).toContain(`p.owner = 'contract'`);
		expect(count[0]).toContain('c.deleted_at IS NULL');
		expect(count[1]).toEqual([HOLDING]);
		// Hoy va al final y solo en la consulta de filas (estado mostrado del contrato).
		expect(rows[1]).toEqual([HOLDING, '2026-10-07']);
		expect(rows[0]).toContain('ds.derived_status AS contract_status');
		expect(rows[0]).toContain('ORDER BY ci.start_date DESC NULLS LAST, ci.id) AS item_ids');
		expect(rows[0]).toContain('ORDER BY c.contract_number ASC NULLS LAST, p.id LIMIT 25 OFFSET 0');
	});

	it('filtros parametrizados (modelo, cantidad, producto, búsqueda) y orden por lista blanca', async () => {
		const { service, query } = build((sql) => (sql.includes('COUNT(*) AS total') ? [{ total: '0' }] : undefined));

		await service.contractPrices(
			HOLDING,
			{
				model: 'standard',
				quantity_type: 'metered',
				product_id: PRODUCT,
				search: ' simpli ',
				sortBy: 'items_count',
				sortOrder: 'desc',
				page: 2,
				limit: 10,
			},
			NOW
		);
		const [count, rows] = query.mock.calls as Array<[string, unknown[]]>;

		expect(count[1]).toEqual([HOLDING, 'standard', 'metered', PRODUCT, '%simpli%']);
		expect(count[0]).toContain('p.model = $2 AND p.quantity_type = $3 AND p.product_id = $4::uuid');
		expect(count[0]).toContain('c.contract_number ILIKE $5 OR cl.name_commercial ILIKE $5 OR pr.name ILIKE $5 OR p.name ILIKE $5');
		expect(rows[1]).toEqual([HOLDING, 'standard', 'metered', PRODUCT, '%simpli%', '2026-10-07']);
		expect(rows[0]).toContain('$6::date');
		expect(rows[0]).toContain('ORDER BY items_count DESC NULLS LAST, p.id LIMIT 10 OFFSET 10');
	});
});

describe('QueryContractPricesDto', () => {
	const errorsOf = async (query: Record<string, unknown>) =>
		(await validate(plainToInstance(QueryContractPricesDto, query))).map((error) => error.property);

	it('acepta los filtros válidos y rechaza modelo, cantidad, producto, orden y límite inválidos', async () => {
		expect(
			await errorsOf({ model: 'volume', quantity_type: 'fixed', product_id: PRODUCT, page: '2', limit: '50', sortBy: 'client_name' })
		).toEqual([]);
		expect(await errorsOf({ model: 'percentage' })).toEqual(['model']);
		expect(await errorsOf({ quantity_type: 'usage' })).toEqual(['quantity_type']);
		expect(await errorsOf({ product_id: 'x' })).toEqual(['product_id']);
		expect(await errorsOf({ sortBy: 'holding_id' })).toEqual(['sortBy']);
		expect(await errorsOf({ limit: '500' })).toEqual(['limit']);
	});
});

describe('PricesController · rutas de solo lectura', () => {
	it('models/usage y contract-prices se declaran antes de :id, con los guards de la clase', () => {
		const proto = PricesController.prototype as unknown as Record<string, unknown>;
		const paths = Object.getOwnPropertyNames(PricesController.prototype)
			.filter((name) => name !== 'constructor')
			.map((name) => Reflect.getMetadata(PATH_METADATA, proto[name] as object) as string | undefined)
			.filter(Boolean);

		expect(paths.indexOf('models/usage')).toBeLessThan(paths.indexOf(':id'));
		expect(paths.indexOf('contract-prices')).toBeLessThan(paths.indexOf(':id'));
		expect(Reflect.getMetadata(GUARDS_METADATA, PricesController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
	});

	it('delegan en el servicio con el holding', async () => {
		const prices = { modelsUsage: jest.fn().mockResolvedValue({ models: [] }), contractPrices: jest.fn().mockResolvedValue({ data: [] }) };
		const controller = new PricesController(prices as unknown as PricesService);

		await controller.modelsUsage(HOLDING);
		await controller.contractPrices({ model: 'seat' }, HOLDING);
		expect(prices.modelsUsage).toHaveBeenCalledWith(HOLDING);
		expect(prices.contractPrices).toHaveBeenCalledWith(HOLDING, { model: 'seat' });
	});
});
