// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, HttpException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';

import { CATALOG_PRICE_MESSAGES } from './catalog-prices';
import { ContractActivationService } from './contract-activation.service';
import { ContractDraftsService, METERED_ADVANCE_MESSAGE } from './contract-drafts.service';
import { ContractsService } from './contracts.service';
import { CreateContractDto, PricePreviewDto, type PriceSpecDto, UpdateContractDto } from './dtos/create-contract.dto';
import { normalizePriceSpec, priceSpecFromRow, priceSummaryFromRow, samePriceSpec } from './price-rows';

/**
 * Pricing v2 etapa 1 en el alta (`docs/v2-rediseno/spec-pricing-v2.md` §4.2 y §5): precio inline en `items[].price`,
 * `POST /contracts/price-preview`, persistencia en `prices` + `contract_items.price_id`, formulario, edición con versión
 * nueva y activación con desglose. Etapa 3: `items[].price_id` de catálogo → copia `owner = contract` con `list_price_id`.
 */

const CLIENT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const METRIC = '55555555-5555-4555-8555-555555555555';
const ITEM_A = '77777777-7777-4777-8777-777777777777';
const PRICE_A = '88888888-8888-4888-8888-888888888888';
const CATALOG_A = '99999999-9999-4999-8999-999999999991';
const CATALOG_B = '99999999-9999-4999-8999-999999999992';
const NOW = new Date('2026-09-28T15:00:00.000Z');

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const tiers = [
	{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
	{ from: 501, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
	{ from: 2001, to: null, per_unit_amount: 0.045, flat_amount: 0 },
];
const meteredPrice: PriceSpecDto = {
	model: 'graduated',
	quantity_type: 'metered',
	billable_metric_id: METRIC,
	tiers,
	free_units: 100,
	minimum_amount: 50,
	cap_amount: 80,
};

const meteredItem = (overrides: Record<string, unknown> = {}) => ({
	key: 'rutas',
	product_id: PRODUCT,
	item_type: 'Servicios',
	quantity: 1000,
	discount_value: 10,
	billing_frequency: 'Mensual',
	billing_method: 'Vencido',
	start_date: '2026-10-01',
	term_months: 3,
	price: meteredPrice,
	...overrides,
});

const baseDto = (overrides: Record<string, unknown> = {}): CreateContractDto =>
	({
		client_id: CLIENT,
		client_entity_id: ENTITY,
		company_id: COMPANY,
		contract_currency: 'CLF',
		invoice_currency: 'CLP',
		fx_invoice_policy: 'spot',
		items: [meteredItem()],
		...overrides,
	}) as CreateContractDto;

const defaults: Array<[string, unknown[]]> = [
	['FROM users WHERE auth_id', [{ id: 'user-1' }]],
	[
		'FROM companies WHERE id',
		[{ id: COMPANY, legal_name: 'Simplit SpA', country: 'Chile', currency: 'CLP', contract_prefix: 'CTR-', tax_rate: '19' }],
	],
	[
		'FROM client_entities ce WHERE ce.id',
		[{ id: ENTITY, legal_name: 'ACME SpA', country: 'Chile', payment_terms: { kind: 'net', days: 30 }, belongs: true }],
	],
	['FROM clients WHERE id', [{ id: CLIENT, name_commercial: 'ACME' }]],
	['FROM products WHERE id = ANY', [{ id: PRODUCT, name: 'Rutas optimizadas' }]],
	['FROM currencies', [{ code: 'CLP' }, { code: 'CLF' }, { code: 'USD' }]],
	['FROM tax_document_types', []],
	['FROM billable_metrics WHERE id = ANY', [{ id: METRIC, name: 'Rutas completadas', status: 'active' }]],
	['substring(contract_number', [{ next: 7 }]],
	['FROM holding_settings', [{ system_currency: 'CLP' }]],
	['INSERT INTO contracts', [{ id: 'contract-new' }]],
	['INSERT INTO contract_items', [{ id: ITEM_A, auto_renew: false }]],
	['INSERT INTO prices', [{ id: PRICE_A }]],
];

const build = (handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => handler(sql, params) ?? defaults.find(([needle]) => sql.includes(needle))?.[1] ?? [];
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: jest.fn(route),
	};
	const dataSource = { query: jest.fn(route), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
	const contracts = {
		detail: jest.fn().mockResolvedValue({ id: 'contract-new' }),
		resolveContract: jest.fn().mockResolvedValue({ id: 'contract-1', status: 'En revisión' }),
	} as unknown as ContractsService;

	return { service: new ContractDraftsService(dataSource, contracts), runner, dataSource };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const errorsOf = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(BadRequestException);

	return fieldErrorsOf(error as HttpException);
};

describe('CreateContractItemDto.price (PriceSpecDto)', () => {
	const check = async (body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(CreateContractDto, body), { whitelist: true, forbidNonWhitelisted: true })).map(
			(error) => `${error.field}: ${error.message}`
		);

	it('con un modelo de precio el unitario mensual deja de ser obligatorio; standard fijo lo sigue exigiendo', async () => {
		expect(await check(baseDto())).toEqual([]);
		// class-validator informa primero el decorador de más abajo (@Min) cuando el campo falta.
		expect(await check(baseDto({ items: [meteredItem({ price: { model: 'standard', quantity_type: 'fixed' } })] }))).toEqual([
			'items.0.unit_price: El precio no puede ser negativo',
		]);
		expect(await check(baseDto({ items: [meteredItem({ price: undefined })] }))).toEqual(['items.0.unit_price: El precio no puede ser negativo']);
		expect(await check(baseDto({ items: [meteredItem({ price: undefined, unit_price: 0.5 })] }))).toEqual([]);
	});

	it('valida tipos y rangos de cada campo del precio y de los tramos, con la ruta del campo', async () => {
		expect(
			await check(
				baseDto({
					items: [
						meteredItem({
							price: {
								model: 'percentage',
								quantity_type: 'measured',
								billable_metric_id: 'x',
								unit_amount: -1,
								tiers: [{ from: 0, to: 'a', per_unit_amount: -2, flat_amount: -1 }],
								package_size: 0,
								package_amount: 0,
								free_units: -1,
								minimum_amount: -5,
								cap_amount: -5,
							},
						}),
					],
				})
			)
		).toEqual([
			'items.0.price.model: Elige el modelo de precio: fijo, por tramos, volumen, paquete o asiento',
			'items.0.price.quantity_type: Indica si la cantidad es fija o medida',
			'items.0.price.billable_metric_id: Métrica facturable inválida',
			'items.0.price.unit_amount: El precio por unidad no puede ser negativo',
			'items.0.price.tiers.0.from: El tramo empieza en una unidad de 1 o más',
			'items.0.price.tiers.0.to: El fin del tramo va de 1 en adelante',
			'items.0.price.tiers.0.per_unit_amount: El precio unitario del tramo no puede ser negativo',
			'items.0.price.tiers.0.flat_amount: El cargo fijo del tramo no puede ser negativo',
			'items.0.price.package_size: El paquete debe tener más de 0 unidades',
			'items.0.price.package_amount: El precio del paquete debe ser mayor que 0',
			'items.0.price.free_units: Las unidades gratis no pueden ser negativas',
			'items.0.price.minimum_amount: El mínimo comprometido no puede ser negativo',
			'items.0.price.cap_amount: El tope máximo no puede ser negativo',
		]);
		expect(await check(baseDto({ items: [meteredItem({ price_id: 'nope' })] }))).toEqual(['items.0.price_id: Precio de catálogo inválido']);
	});

	it('PricePreviewDto: precio anidado, descuento 0–100 y 1–50 cantidades no negativas', async () => {
		const preview = async (body: unknown) =>
			flattenValidationErrors(await validate(plainToInstance(PricePreviewDto, body), { whitelist: true, forbidNonWhitelisted: true })).map(
				(error) => `${error.field}: ${error.message}`
			);

		expect(await preview({ price: meteredPrice, discount_pct: 10, quantities: [300, 1250, 1400] })).toEqual([]);
		expect(await preview({ price: meteredPrice, discount_pct: 101, quantities: [] })).toEqual([
			'discount_pct: El descuento va de 0 a 100 %',
			'quantities: Indica al menos una cantidad a simular',
		]);
		expect(await preview({ quantities: [-1] })).toEqual([
			'price: Define el precio a simular',
			'quantities: La cantidad a simular no puede ser negativa',
		]);
	});
});

describe('POST /contracts/price-preview (ContractDraftsService.pricePreview)', () => {
	it('devuelve un PricedLine por cantidad con el desglose del mockup (78,30 · 50,00 · 80,00)', () => {
		const lines = ContractDraftsService.pricePreview({ price: meteredPrice, discount_pct: 10, quantities: [1250, 300, 1400] });

		expect(lines.map((line) => line.subtotal)).toEqual([78.3, 50, 80]);
		expect(lines[0].breakdown.map((subline) => subline.kind)).toEqual(['free', 'tier', 'tier', 'discount']);
		expect(lines[1].breakdown.at(-1)).toMatchObject({ kind: 'minimum', amount: 26.6 });
		expect(lines[2].breakdown.at(-1)).toMatchObject({ kind: 'cap', amount: -6.4 });
		expect(lines[0]).toMatchObject({ quantity: 1250, billable_quantity: 1150, effective_unit_price: 0.06264, quantity_source: 'fixed' });
	});

	it('400 con errors[price.tiers[i].from] si los tramos tienen huecos, sin tocar la base', () => {
		const error = (() => {
			try {
				ContractDraftsService.pricePreview({
					price: {
						model: 'graduated',
						quantity_type: 'fixed',
						tiers: [
							{ from: 1, to: 5, per_unit_amount: 1 },
							{ from: 7, to: null, per_unit_amount: 1 },
						],
					},
					quantities: [10],
				});
			} catch (caught) {
				return caught;
			}

			return null;
		})();

		expect(error).toBeInstanceOf(BadRequestException);
		expect(fieldErrorsOf(error as HttpException)).toEqual([
			{ field: 'price.tiers[1].from', message: 'El tramo debe empezar en 6 (sin huecos ni solapes)' },
		]);
	});

	it('el controlador responde 200 y no necesita servicio', () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { ContractsController } = require('./contracts.controller') as typeof import('./contracts.controller');

		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.pricePreview)).toBe(200);
	});
});

describe('ContractDraftsService · alta con modelo de precio', () => {
	it('valida el precio contra el holding: métrica inexistente o archivada, metered + Anticipado (salvo seat), price_id de catálogo y tramos', async () => {
		const { service } = build((sql) =>
			sql.includes('FROM billable_metrics WHERE id = ANY') ? [{ id: METRIC, name: 'Rutas', status: 'archived' }] : undefined
		);

		// `price_id` que no es del catálogo del holding + inline a la vez: los dos errores del catálogo van primero.
		expect(await errorsOf(service.preview(baseDto({ items: [meteredItem({ billing_method: 'Anticipado', price_id: METRIC })] }), 'h-1'))).toEqual(
			[
				{ field: 'items.0.price_id', message: CATALOG_PRICE_MESSAGES.both },
				{ field: 'items.0.price_id', message: CATALOG_PRICE_MESSAGES.missing },
				{ field: 'items.0.price.billable_metric_id', message: 'La métrica facturable está archivada' },
				{ field: 'items.0.billing_method', message: METERED_ADVANCE_MESSAGE },
			]
		);

		const missing = build((sql) => (sql.includes('FROM billable_metrics WHERE id = ANY') ? [] : undefined));

		expect(await errorsOf(missing.service.preview(baseDto(), 'h-1'))).toEqual([
			{ field: 'items.0.price.billable_metric_id', message: 'La métrica facturable no existe en el holding' },
		]);
		// seat medido sí puede ir Anticipado (último valor conocido).
		const seat = build();

		await expect(
			seat.service.preview(
				baseDto({
					items: [
						meteredItem({
							billing_method: 'Anticipado',
							price: {
								model: 'seat',
								quantity_type: 'metered',
								billable_metric_id: METRIC,
								unit_amount: 12,
								seat_minimum_quantity: 10,
							},
						}),
					],
				}),
				'h-1'
			)
		).resolves.toBeTruthy();
		const gaps = build();

		expect(
			await errorsOf(
				gaps.service.preview(
					baseDto({
						items: [
							meteredItem({
								price: {
									...meteredPrice,
									tiers: [
										{ from: 2, to: 5, per_unit_amount: 1, flat_amount: 0 },
										{ from: 6, to: 10, per_unit_amount: 1, flat_amount: 0 },
									],
								},
							}),
						],
					}),
					'h-1'
				)
			)
		).toEqual([
			{ field: 'items.0.price.tiers[0].from', message: 'El primer tramo empieza en 1' },
			{ field: 'items.0.price.tiers[1].to', message: 'El último tramo cierra en infinito (deja "hasta" vacío)' },
		]);
	});

	it('la vista previa trae las líneas medidas pendientes con su desglose y la advertencia', async () => {
		const { service } = build();
		const result = await service.preview(baseDto(), 'h-1');

		expect(result.invoices).toHaveLength(3);
		expect(result.invoices[0].lines[0]).toMatchObject({ quantity: 1000, quantity_source: 'pending', subtotal: 64.8 });
		expect(result.warnings).toContain(
			'Consumo por informar en "Rutas optimizadas": la línea usa la cantidad base del ítem y se recalcula al registrar'
		);
	});

	it('crear: el ítem se guarda con el unitario mensual equivalente y el precio nace en prices (owner contract, activo, v1) apuntado por price_id', async () => {
		const { service, runner } = build();

		await service.create(baseDto(), 'h-1', 'auth-1', NOW);

		const [itemInsert] = calls(runner.query, 'INSERT INTO contract_items');

		// 1.000 rutas a precio del período sin descuento = 72,00 → 0,072 por unidad y mes (la columna aplica el 10 % como siempre).
		expect(itemInsert[1]).toEqual(expect.arrayContaining([0.072, 'Porcentaje', 10]));
		const [priceInsert] = calls(runner.query, 'INSERT INTO prices');

		expect(priceInsert[0]).toContain(`'contract'`);
		expect(priceInsert[1]).toEqual([
			'h-1',
			PRODUCT,
			'contract-new',
			'Rutas optimizadas',
			'CLF',
			'graduated',
			'metered',
			METRIC,
			null,
			JSON.stringify(normalizePriceSpec(meteredPrice).tiers),
			null,
			null,
			0,
			100,
			50,
			80,
			1,
			null,
			'user-1',
			'single',
			false,
			null,
		]);
		const [attach] = calls(runner.query, 'UPDATE contract_items SET price_id');

		expect(attach[1]).toEqual([ITEM_A, 'h-1', PRICE_A]);
		expect(runner.commitTransaction).toHaveBeenCalled();
		// El orden importa: ítem → precio → price_id, todo dentro de la misma transacción.
		const order = runner.query.mock.calls.map(([sql]) => sql as string);

		expect(order.findIndex((sql) => sql.includes('INSERT INTO contract_items'))).toBeLessThan(
			order.findIndex((sql) => sql.includes('INSERT INTO prices'))
		);
		expect(order.findIndex((sql) => sql.includes('INSERT INTO prices'))).toBeLessThan(
			order.findIndex((sql) => sql.includes('UPDATE contract_items SET price_id'))
		);
	});

	describe('precio de catálogo (etapa 3: items[].price_id)', () => {
		const catalogRow = (overrides: Row = {}): Row => ({
			id: CATALOG_A,
			name: 'Tramos LatAm — UF',
			product_id: PRODUCT,
			currency: 'CLF',
			status: 'active',
			version: 2,
			model: 'graduated',
			quantity_type: 'metered',
			billable_metric_id: METRIC,
			unit_amount: null,
			tiers,
			package_size: null,
			package_amount: null,
			seat_minimum_quantity: '0',
			free_units: '100.000000',
			minimum_amount: '50.00',
			cap_amount: '80.00',
			invoice_line_mode: 'per_tier',
			charge_flat_when_free: false,
			...overrides,
		});
		const withCatalog =
			(rows: Row[]): Handler =>
			(sql) =>
				sql.includes('FROM prices WHERE id = ANY') ? rows : undefined;
		const catalogItem = (overrides: Record<string, unknown> = {}) => meteredItem({ price: undefined, price_id: CATALOG_A, ...overrides });

		it('DTO: con price_id el unitario mensual deja de ser obligatorio', async () => {
			const check = async (body: unknown) =>
				flattenValidationErrors(
					await validate(plainToInstance(CreateContractDto, body), { whitelist: true, forbidNonWhitelisted: true })
				).map((error) => `${error.field}: ${error.message}`);

			expect(await check(baseDto({ items: [catalogItem()] }))).toEqual([]);
			expect(await check(baseDto({ items: [catalogItem({ price_id: 'nope' })] }))).toEqual(['items.0.price_id: Precio de catálogo inválido']);
			expect(await check(baseDto({ items: [catalogItem({ list_price_id: CATALOG_A })] }))).toEqual([]);
		});

		it('el catálogo debe existir en el holding, estar publicado, ser del mismo producto y de la moneda del contrato', async () => {
			const otherProduct = '44444444-4444-4444-8444-444444444445';
			const cases: Array<[Row[], string]> = [
				[[], CATALOG_PRICE_MESSAGES.missing],
				[[catalogRow({ status: 'draft' })], CATALOG_PRICE_MESSAGES.draft],
				[[catalogRow({ status: 'archived' })], CATALOG_PRICE_MESSAGES.archived],
				[[catalogRow({ product_id: otherProduct })], CATALOG_PRICE_MESSAGES.product],
				[[catalogRow({ currency: 'CLP' })], CATALOG_PRICE_MESSAGES.currency('CLP', 'CLF')],
			];

			for (const [rows, message] of cases) {
				const { service, dataSource } = build(withCatalog(rows));

				expect(await errorsOf(service.preview(baseDto({ items: [catalogItem()] }), 'h-1'))).toEqual([{ field: 'items.0.price_id', message }]);
				// Se lee solo el catálogo (owner = catalog) del holding, por id.
				const [load] = calls(dataSource.query as jest.Mock, 'FROM prices WHERE id = ANY');

				expect(load[0]).toContain(`owner = 'catalog'`);
				expect(load[1]).toEqual([[CATALOG_A], 'h-1']);
			}
			// Medido del catálogo + Anticipado → misma regla que el inline (salvo seat).
			const { service } = build(withCatalog([catalogRow()]));

			expect(await errorsOf(service.preview(baseDto({ items: [catalogItem({ billing_method: 'Anticipado' })] }), 'h-1'))).toEqual([
				{ field: 'items.0.billing_method', message: METERED_ADVANCE_MESSAGE },
			]);
			expect(await errorsOf(service.preview(baseDto({ items: [catalogItem({ price: meteredPrice })] }), 'h-1'))).toEqual([
				{ field: 'items.0.price_id', message: CATALOG_PRICE_MESSAGES.both },
			]);
		});

		it('la vista previa tarifa con el modelo del catálogo sin pedir unit_price', async () => {
			const { service } = build(withCatalog([catalogRow()]));
			const preview = await service.preview(baseDto({ items: [catalogItem()] }), 'h-1');

			expect(preview.invoices.length).toBeGreaterThan(0);
			expect(preview.invoices[0].lines[0].quantity_source).toBe('pending');
		});

		it('crear copia el catálogo al contrato: fila owner = contract, v1, nombre del catálogo y list_price_id; el contrato nunca apunta al catálogo', async () => {
			const { service, runner } = build(withCatalog([catalogRow()]));

			await service.create(baseDto({ items: [catalogItem()] }), 'h-1', 'auth-1', NOW);
			const [priceInsert] = calls(runner.query, 'INSERT INTO prices');
			const params = priceInsert[1] as unknown[];

			expect(priceInsert[0]).toContain(`'contract'`);
			expect(params.slice(0, 8)).toEqual(['h-1', PRODUCT, 'contract-new', 'Tramos LatAm — UF', 'CLF', 'graduated', 'metered', METRIC]);
			// version 1, sin supersedes, per_tier copiado, list_price_id = catálogo.
			expect(params.slice(16)).toEqual([1, null, 'user-1', 'per_tier', false, CATALOG_A]);
			expect(calls(runner.query, 'UPDATE contract_items SET price_id')[0][1]).toEqual([ITEM_A, 'h-1', PRICE_A]);
			expect(calls(runner.query, 'UPDATE contract_items SET price_id')[0][1]).not.toContain(CATALOG_A);
			// El unitario mensual equivalente sale del modelo copiado (1.000 rutas → 72,00 del período).
			expect(calls(runner.query, 'INSERT INTO contract_items')[0][1]).toEqual(expect.arrayContaining([0.072]));
		});
	});

	it('crear sin precio no escribe en prices (standard fijo = comportamiento de hoy)', async () => {
		const { service, runner } = build();

		await service.create(baseDto({ items: [meteredItem({ price: undefined, unit_price: 100 })] }), 'h-1', 'auth-1', NOW);

		expect(calls(runner.query, 'INSERT INTO prices')).toHaveLength(0);
		expect(calls(runner.query, 'FROM billable_metrics')).toHaveLength(0);
	});

	describe('editar (GET :id/form y PUT :id)', () => {
		const header = (overrides: Row = {}): Row => ({
			id: 'contract-1',
			contract_number: 'CTR-2026-001',
			status: 'En revisión',
			created_at: NOW,
			client_id: CLIENT,
			client_entity_id: ENTITY,
			company_id: COMPANY,
			quote_id: null,
			contract_currency: 'CLF',
			invoice_currency: 'CLP',
			fx_invoice_policy: 'spot',
			fx_company_policy: 'monthly_avg',
			payment_terms: null,
			document_type: 'FACTURA',
			tax_document_type_id: null,
			billing_anchor_day: 1,
			group_invoices_by_period: true,
			auto_send_to_odoo: false,
			auto_invoice: false,
			booking_date: null,
			salesforce_opportunity_id: null,
			notes: null,
			invoice_terms_and_conditions: null,
			custom_fields: {},
			total_value: '194.4',
			invoices_count: '0',
			...overrides,
		});
		const priceRow = {
			price_id: PRICE_A,
			price_name: 'Rutas optimizadas',
			price_version: 1,
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
			price_minimum_amount: '50.00',
			price_cap_amount: '80.00',
		};
		const storedItem = {
			id: ITEM_A,
			quote_item_id: null,
			product_id: PRODUCT,
			product_name: 'Rutas optimizadas',
			account: null,
			item_type: 'Servicios',
			unit_of_measure: 'ruta',
			quantity: '1000',
			unit_price: '0.072',
			annual_unit_price: null,
			price_entry_mode: 'monthly',
			discount_value: '10',
			billing_frequency: 'Mensual',
			billing_method: 'Vencido',
			start_date: '2026-10-01',
			term_months: 3,
			is_recurring: true,
			auto_renew: false,
			auto_renew_term_months: null,
			booking_date: null,
			...priceRow,
		};
		const draftHandler: Handler = (sql) => {
			if (sql.includes('c.created_at, c.client_id')) return [header()];
			if (sql.includes('SELECT ci.id, ci.product_id, ci.quote_item_id')) return [storedItem];
			if (sql.includes('FROM contract_items ci') && sql.includes('ORDER BY ci.start_date NULLS LAST')) return [storedItem];
			if (sql.includes('FROM contract_fx_period_rates WHERE contract_id')) return [];
			if (sql.includes('FROM quantities WHERE contract_item_id')) return [{ count: '0' }];
			if (sql.includes('INSERT INTO prices')) return [{ id: 'price-v2' }];

			return undefined;
		};

		it('form devuelve el precio inline del ítem como PriceSpec (números, tramos, condiciones)', async () => {
			const { service } = build(draftHandler);
			const result = await service.form('contract-1', 'h-1');

			expect(result.form.items[0].price).toEqual({
				model: 'graduated',
				quantity_type: 'metered',
				billable_metric_id: METRIC,
				unit_amount: null,
				tiers,
				package_size: null,
				package_amount: null,
				seat_minimum_quantity: 0,
				free_units: 100,
				minimum_amount: 50,
				cap_amount: 80,
				invoice_line_mode: 'single',
				charge_flat_when_free: false,
			});
			expect(result.form.items[0].unit_price).toBe(0.072);
		});

		it('PUT con el mismo precio no crea versión; con un precio distinto crea v2 (supersedes) y archiva v1, con evento PRICE_CHANGED', async () => {
			const same = build(draftHandler);

			await same.service.update(
				'contract-1',
				{ ...baseDto(), items: [{ ...meteredItem(), id: ITEM_A }] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			expect(calls(same.runner.query, 'INSERT INTO prices')).toHaveLength(0);
			expect(calls(same.runner.query, `'PRICE_CHANGED'`)).toHaveLength(0);

			const changed = build(draftHandler);

			await changed.service.update(
				'contract-1',
				{ ...baseDto(), items: [{ ...meteredItem({ price: { ...meteredPrice, cap_amount: 90 } }), id: ITEM_A }] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			const [priceInsert] = calls(changed.runner.query, 'INSERT INTO prices');

			// version 2 con supersedes = v1
			expect((priceInsert[1] as unknown[]).slice(15)).toEqual([90, 2, PRICE_A, 'user-1', 'single', false, null]);
			expect(calls(changed.runner.query, 'UPDATE contract_items SET price_id')[0][1]).toEqual([ITEM_A, 'h-1', 'price-v2']);
			const [archive] = calls(changed.runner.query, `SET status = 'archived'`);

			expect(archive[1]).toEqual([[PRICE_A], 'h-1', 'user-1']);
			const [event] = calls(changed.runner.query, `'PRICE_CHANGED'`);

			expect(JSON.parse((event[1] as unknown[])[6] as string).changes).toEqual([{ item_id: ITEM_A, from: PRICE_A, to: 'price-v2' }]);
			expect(changed.runner.commitTransaction).toHaveBeenCalled();
		});

		it('PUT sin precio en un ítem que lo tenía: price_id a NULL y precio archivado; al quitar el ítem, su precio también se archiva', async () => {
			const removed = build(draftHandler);

			await removed.service.update(
				'contract-1',
				{ ...baseDto(), items: [{ ...meteredItem({ price: undefined, unit_price: 50 }), id: ITEM_A }] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			expect(calls(removed.runner.query, 'SET price_id = NULL')[0][1]).toEqual([ITEM_A, 'h-1']);
			expect(calls(removed.runner.query, `SET status = 'archived'`)[0][1]).toEqual([[PRICE_A], 'h-1', 'user-1']);

			const deleted = build(draftHandler);

			await deleted.service.update(
				'contract-1',
				{ ...baseDto(), items: [meteredItem({ key: 'nuevo' })] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			const order = deleted.runner.query.mock.calls.map(([sql]) => sql as string);

			expect(order.findIndex((sql) => sql.includes('DELETE FROM contract_items'))).toBeLessThan(
				order.findIndex((sql) => sql.includes(`SET status = 'archived'`))
			);
			expect(calls(deleted.runner.query, `SET status = 'archived'`)[0][1]).toEqual([[PRICE_A], 'h-1', 'user-1']);
		});

		it('form devuelve list_price_id junto al precio copiado; PUT con el mismo precio y el mismo catálogo no crea versión', async () => {
			const copied = { ...storedItem, price_list_price_id: CATALOG_A };
			const copiedHandler: Handler = (sql, params) => {
				if (sql.includes('SELECT ci.id, ci.product_id, ci.quote_item_id')) return [copied];
				if (sql.includes('FROM contract_items ci') && sql.includes('ORDER BY ci.start_date NULLS LAST')) return [copied];

				return draftHandler(sql, params);
			};
			const { service } = build(copiedHandler);
			const result = await service.form('contract-1', 'h-1');

			expect(result.form.items[0].list_price_id).toBe(CATALOG_A);
			expect(result.form.items[0].price).toMatchObject({ model: 'graduated', quantity_type: 'metered' });

			const same = build(copiedHandler);

			await same.service.update(
				'contract-1',
				{ ...baseDto(), items: [{ ...meteredItem(), id: ITEM_A, list_price_id: CATALOG_A }] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			expect(calls(same.runner.query, 'INSERT INTO prices')).toHaveLength(0);

			// Cambiar a otro catálogo (misma moneda, mismo producto) crea v2 copiando ese catálogo, con supersedes = v1.
			const other = build((sql, params) => {
				if (sql.includes('FROM prices WHERE id = ANY')) {
					return [
						{
							id: CATALOG_B,
							name: 'Tramos LatAm v3',
							product_id: PRODUCT,
							currency: 'CLF',
							status: 'active',
							version: 3,
							model: 'standard',
							quantity_type: 'fixed',
							unit_amount: '0.05',
						},
					];
				}

				return copiedHandler(sql, params);
			});

			await other.service.update(
				'contract-1',
				{ ...baseDto(), items: [{ ...meteredItem({ price: undefined, price_id: CATALOG_B }), id: ITEM_A }] } as UpdateContractDto,
				'h-1',
				'auth-1',
				NOW
			);
			const [priceInsert] = calls(other.runner.query, 'INSERT INTO prices');
			const params = priceInsert[1] as unknown[];

			expect(params.slice(3, 7)).toEqual(['Tramos LatAm v3', 'CLF', 'standard', 'fixed']);
			expect(params.slice(16)).toEqual([2, PRICE_A, 'user-1', 'single', false, CATALOG_B]);
			expect(calls(other.runner.query, `SET status = 'archived'`)[0][1]).toEqual([[PRICE_A], 'h-1', 'user-1']);
		});
	});
});

describe('price-rows (filas de prices ↔ PriceSpec)', () => {
	it('lee una fila con prefijo, normaliza y compara', () => {
		const row = {
			price_id: PRICE_A,
			price_name: 'X',
			price_version: '2',
			price_status: 'active',
			price_model: 'package',
			price_quantity_type: 'fixed',
			price_billable_metric_id: null,
			price_unit_amount: null,
			price_tiers: null,
			price_package_size: '1000.000000',
			price_package_amount: '25.00',
			price_seat_minimum_quantity: null,
			price_free_units: null,
			price_minimum_amount: null,
			price_cap_amount: null,
		};

		expect(priceSpecFromRow(row)).toMatchObject({
			model: 'package',
			quantity_type: 'fixed',
			package_size: 1000,
			package_amount: 25,
			free_units: null,
		});
		expect(priceSummaryFromRow(row)).toMatchObject({ id: PRICE_A, version: 2, model: 'package' });
		expect(priceSpecFromRow({ price_id: null, price_model: null })).toBeNull();
		expect(priceSummaryFromRow({ price_id: null })).toBeNull();
		expect(samePriceSpec(priceSpecFromRow(row), { model: 'package', quantity_type: 'fixed', package_size: 1000, package_amount: 25 })).toBe(true);
		expect(samePriceSpec(priceSpecFromRow(row), { model: 'package', quantity_type: 'fixed', package_size: 500, package_amount: 25 })).toBe(false);
		// Normalizar descarta campos de otros modelos y fija defaults.
		expect(
			normalizePriceSpec({ model: 'standard', quantity_type: 'fixed', unit_amount: 5, tiers, package_size: 3, billable_metric_id: METRIC })
		).toEqual({
			model: 'standard',
			quantity_type: 'fixed',
			billable_metric_id: null,
			unit_amount: 5,
			tiers: null,
			package_size: null,
			package_amount: null,
			seat_minimum_quantity: 0,
			free_units: 0,
			minimum_amount: null,
			cap_amount: null,
			invoice_line_mode: 'single',
			charge_flat_when_free: false,
		});
	});
});

describe('ContractActivationService · ítems con modelo de precio', () => {
	const contract: Row = {
		id: 'c-1',
		contract_number: 'CTR-2026-001',
		status: 'En revisión',
		client_id: 'client-1',
		client_entity_id: 'entity-1',
		company_id: 'company-1',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		system_currency: 'CLP',
		contract_company_currency: 'CLP',
		fx_invoice_policy: 'spot',
		group_invoices_by_period: true,
		billing_anchor_day: '1',
		payment_terms: { kind: 'net', days: 30 },
		document_type: 'FACTURA',
		company_found: 'company-1',
		company_country: 'Chile',
		company_currency: 'CLP',
		company_tax_rate: '19',
		entity_found: 'entity-1',
		entity_country: 'Chile',
		invoices_count: '0',
		currency_mismatch: false,
	};
	const item = (overrides: Row = {}): Row => ({
		contract_id: 'c-1',
		id: ITEM_A,
		product_id: PRODUCT,
		product_name: 'Rutas optimizadas',
		account: null,
		unit_of_measure: 'ruta',
		quantity: '1000',
		unit_price: '0.072',
		annual_unit_price: null,
		discount_type: 'Porcentaje',
		discount_value: '10',
		final_price: '194.4',
		billing_frequency: 'Mensual',
		billing_method: 'Vencido',
		start_date: '2026-10-01',
		end_date: '2026-12-31',
		term_months: 3,
		is_recurring: true,
		price_id: PRICE_A,
		price_status: 'active',
		price_model: 'graduated',
		price_quantity_type: 'metered',
		price_billable_metric_id: METRIC,
		price_tiers: JSON.stringify(tiers),
		price_free_units: '100',
		price_minimum_amount: '50',
		price_cap_amount: '80',
		consumption: JSON.stringify([
			{ period_start: '2026-10-01', quantity: 1250, amount_override: null, apply_item_discount: true, is_estimated: false },
		]),
		...overrides,
	});

	it('evaluate: el consumo ya registrado alimenta la cuota de su período; el resto queda pendiente; metered + Anticipado y precio archivado bloquean', () => {
		const plan = ContractActivationService.evaluate('c-1', contract, [item()]);

		expect(plan.check.can_activate).toBe(true);
		expect(plan.engine!.invoices.map((invoice) => invoice.lines[0]).map((line) => [line.quantity_source, line.subtotal])).toEqual([
			['consumption', 78.3],
			['pending', 64.8],
			['pending', 64.8],
		]);
		expect(plan.check.warnings).toContain(
			'Consumo por informar en "Rutas optimizadas": la línea usa la cantidad base del ítem y se recalcula al registrar'
		);

		const blocked = ContractActivationService.evaluate('c-1', contract, [item({ billing_method: 'Anticipado', price_status: 'archived' })]);

		expect(blocked.check.blockers.map((blocker) => blocker.code)).toEqual(['metered_advance', 'archived_price']);
	});

	it('persist escribe quantity_source y pricing_breakdown en cada línea, con su contract_item_id en el INSERT (sin patrón B)', async () => {
		const runner = {
			connect: jest.fn(),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
			query: jest.fn(async (sql: string) => {
				if (sql.includes('JOIN contracts c ON c.id = ci.contract_id')) return [item()];
				if (sql.includes('FROM contracts c')) return [contract];
				if (sql.includes('INSERT INTO invoices')) return [{ id: 'inv-1' }];
				if (sql.includes('INSERT INTO invoice_items')) return [{ id: 'line-1' }];
				if (sql.includes('UPDATE contracts SET status')) return [{ id: 'c-1' }];

				return [];
			}),
		};
		const dataSource = { query: jest.fn(async () => [{ id: 'user-1' }]), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
		const service = new ContractActivationService(dataSource);
		const result = await service.activate(['c-1'], 'h-1', 'auth-1');

		expect(result.activated).toEqual([{ id: 'c-1', contract_number: 'CTR-2026-001', invoices_created: 3, warning_codes: [] }]);
		const lineInserts = calls(runner.query, 'INSERT INTO invoice_items');

		expect(lineInserts).toHaveLength(3);
		expect(lineInserts[0][0]).toContain('quantity_source, pricing_breakdown');
		const first = lineInserts[0][1] as unknown[];

		expect(first[2]).toBe(1250);
		expect(first.at(-3)).toBe('consumption');
		expect(JSON.parse(first.at(-2) as string).map((subline: { kind: string; amount: number }) => [subline.kind, subline.amount])).toEqual([
			['free', 0],
			['tier', 42],
			['tier', 45],
			['discount', -8.7],
		]);
		expect((lineInserts[1][1] as unknown[]).at(-3)).toBe('pending');
		// Costura: el vínculo con el ítem va en el mismo INSERT (último parámetro) y no hay UPDATE posterior.
		expect(lineInserts[0][0]).toContain('invoice_id, contract_item_id,');
		expect(first.at(-1)).toBe(item().id);
		expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);
	});
});
