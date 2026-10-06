// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { API_WRITER_SQL } from './api-writer';
import { itemCategoriaSql } from './api-written-fields';
import { generateInvoices } from './billing-engine';
import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import {
	cleanPaymentTerms,
	ContractDraftsService,
	contractPrefix,
	correlativePattern,
	DEFAULT_PAYMENT_TERMS_PRESETS,
	formatContractNumber,
	MISSING_SOFT_DELETE_MESSAGE,
	ownCycleAnchor,
	parsePaymentTermsText,
	WHOLE_CONTRACT_RATE_CONFLICT,
} from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { CreateContractDto, UpdateContractDto, UpdateContractTermsDto } from './dtos/create-contract.dto';
import { TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE } from './tax-document-types';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const QUOTE = '55555555-5555-4555-8555-555555555555';
const QUOTE_ITEM = '66666666-6666-4666-8666-666666666666';
const ITEM_A = '77777777-7777-4777-8777-777777777777';
const ITEM_B = '88888888-8888-4888-8888-888888888888';
const TDT_33 = '99999999-0033-4999-8999-999999999933';
const TDT_34 = '99999999-0034-4999-8999-999999999934';
const TDT_110 = '99999999-0110-4999-8999-999999999110';
const TDT_GENERIC = '99999999-0000-4999-8999-999999999000';
const TDT_GENERIC_EXPORT = '99999999-0001-4999-8999-999999999001';
const NOW = new Date('2026-09-25T15:00:00.000Z');

/** Catálogo `tax_document_types` (solo facturas): Chile con 33/34/110 y los genéricos `*`. */
const TAX_CATALOG = [
	{ id: TDT_33, country_code: 'CL', code: '33', name: 'Factura electrónica', kind: 'invoice', is_electronic: true, sort: 10 },
	{ id: TDT_34, country_code: 'CL', code: '34', name: 'Factura no afecta o exenta electrónica', kind: 'invoice', is_electronic: true, sort: 20 },
	{
		id: TDT_110,
		country_code: 'CL',
		code: '110',
		name: 'Factura de exportación electrónica',
		kind: 'export_invoice',
		is_electronic: true,
		sort: 30,
	},
	{ id: TDT_GENERIC, country_code: '*', code: 'FACTURA', name: 'Factura', kind: 'invoice', is_electronic: false, sort: 10 },
	{
		id: TDT_GENERIC_EXPORT,
		country_code: '*',
		code: 'FACTURA_EXPORTACION',
		name: 'Factura de exportación',
		kind: 'export_invoice',
		is_electronic: false,
		sort: 20,
	},
];

type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const baseDto = (overrides: Partial<CreateContractDto> = {}): CreateContractDto =>
	({
		client_id: CLIENT,
		client_entity_id: ENTITY,
		company_id: COMPANY,
		contract_currency: 'CLP',
		items: [
			{
				key: 'k1',
				product_id: PRODUCT,
				item_type: 'Licencias',
				quantity: 2,
				unit_price: 100,
				discount_value: 10,
				billing_frequency: 'Mensual',
				billing_method: 'Anticipado',
				start_date: '2026-10-01',
				term_months: 12,
				is_recurring: true,
			},
		],
		...overrides,
	}) as CreateContractDto;

/** Respuestas por defecto de la base: holding con compañía chilena, razón social del cliente y producto del catálogo. */
const defaults: Array<[string, unknown[]]> = [
	['FROM users WHERE auth_id', [{ id: 'user-1' }]],
	[
		'FROM companies WHERE id',
		[{ id: COMPANY, legal_name: 'Simplit SpA', country: 'Chile', currency: 'CLP', contract_prefix: 'CTR-', tax_rate: '19' }],
	],
	[
		'FROM client_entities ce WHERE ce.id',
		[{ id: ENTITY, legal_name: 'ACME SpA', country: 'Chile', payment_terms: { kind: 'net', days: 45 }, belongs: true }],
	],
	['FROM clients WHERE id', [{ id: CLIENT, name_commercial: 'ACME' }]],
	['FROM products WHERE id = ANY', [{ id: PRODUCT, name: 'Licencia Pro' }]],
	['FROM currencies', [{ code: 'CLP' }, { code: 'USD' }]],
	['FROM tax_document_types', TAX_CATALOG],
	['FROM contracts c WHERE c.quote_id', []],
	['substring(contract_number', [{ next: 7 }]],
	['FROM holding_settings', [{ system_currency: 'CLP' }]],
	['INSERT INTO contracts', [{ id: 'contract-new' }]],
	['INSERT INTO contract_items', [{ id: 'item-1', auto_renew: false }]],
	['FROM quote_stages', [{ id: 'stage-created' }]],
	['information_schema.columns', [{ '?column?': 1 }]],
];

const build = (handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;

		return defaults.find(([needle]) => sql.includes(needle))?.[1] ?? [];
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
	const contracts = {
		detail: jest.fn().mockResolvedValue({ id: 'contract-new', contract_number: 'CTR-2026-007' }),
		resolveContract: jest.fn().mockResolvedValue({ id: 'contract-1', status: 'En revisión' }),
	} as unknown as ContractsService;

	return { service: new ContractDraftsService(dataSource, contracts), runner, dataSource, contracts };
};

const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));

describe('helpers de ContractDraftsService', () => {
	it('interpreta condiciones de pago en texto (master data y cotización)', () => {
		expect(parsePaymentTermsText('30 días')).toEqual({ kind: 'net', days: 30 });
		expect(parsePaymentTermsText('Contado')).toEqual({ kind: 'net', days: 0 });
		expect(parsePaymentTermsText('Fin de mes')).toEqual({ kind: 'end_of_month', days: 0 });
		expect(parsePaymentTermsText('fin de mes + 15')).toEqual({ kind: 'end_of_month', days: 15 });
		expect(parsePaymentTermsText('45')).toEqual({ kind: 'net', days: 45 });
		expect(parsePaymentTermsText('Día 5 del mes siguiente')).toEqual({ kind: 'day_of_next_month', day: 5 });
		expect(parsePaymentTermsText('dia 31 del mes siguiente')).toEqual({ kind: 'day_of_next_month', day: 31 });
		expect(parsePaymentTermsText('Día 40 del mes siguiente')).toBeNull();
		expect(parsePaymentTermsText('Según OC')).toBeNull();
	});

	it('limpia la condición de pago a su forma exacta', () => {
		expect(cleanPaymentTerms({ kind: 'net', days: 30, day: 5, label: 'x' })).toEqual({ kind: 'net', days: 30 });
		expect(cleanPaymentTerms({ kind: 'day_of_next_month', day: 17 })).toEqual({ kind: 'day_of_next_month', day: 17 });
		expect(cleanPaymentTerms({ kind: 'otro' })).toBeNull();
		expect(cleanPaymentTerms(null)).toBeNull();
	});

	it('numera {prefijo}-{año}-{NNN} con el prefijo sin guion final y CTR por defecto', () => {
		expect(contractPrefix('CTR-CO-')).toBe('CTR-CO');
		expect(contractPrefix('CTR-AR')).toBe('CTR-AR');
		expect(contractPrefix('')).toBe('CTR');
		expect(contractPrefix(null)).toBe('CTR');
		expect(formatContractNumber('CTR', 2026, 7)).toBe('CTR-2026-007');
		expect(formatContractNumber('CTR', 2026, 1234)).toBe('CTR-2026-1234');
		// El patrón escapa el prefijo y deja fuera los 6 hex del número viejo.
		const pattern = new RegExp(correlativePattern('CTR-CO', 2026));

		expect(pattern.test('CTR-CO-2026-012')).toBe(true);
		expect(pattern.test('CTR-CO-2026-404112')).toBe(false);
		expect(pattern.test('CTRXCO-2026-012')).toBe(false);
	});
});

describe('ContractDraftsService · mensual equivalente (MRR del 360 = MRR de la vista previa)', () => {
	const graduated = {
		model: 'graduated' as const,
		quantity_type: 'fixed' as const,
		minimum_amount: 95,
		tiers: [
			{ from: 1, to: 1000, per_unit_amount: 0.05, flat_amount: 20 },
			{ from: 1001, to: null, per_unit_amount: 0.03, flat_amount: 0 },
		],
	};

	it.each([
		['Mensual', 0],
		['Mensual', 10],
		['Trimestral', 10],
		['Anual', 25],
	])('%s con %s %% de descuento: unitario × cantidad × (1 − descuento) = mensual equivalente del motor', (frequency, pct) => {
		const item = { quantity: 2000, billing_frequency: frequency as 'Mensual', is_recurring: true, term_months: 12 };
		const unit = ContractDraftsService.equivalentMonthlyUnit(graduated, item, pct);
		const engine = generateInvoices({
			contract: { contract_currency: 'CLP', company: { country: 'Chile', tax_rate: 19 }, billing_anchor_day: 1 },
			items: [
				{
					key: 'g',
					product_name: 'Rutas',
					unit_price: unit,
					quantity: 2000,
					discount_value: pct,
					billing_frequency: frequency,
					billing_method: 'Anticipado',
					start_date: '2026-10-01',
					term_months: 12,
					is_recurring: true,
					price: graduated,
				},
			],
		});
		// Lo que calcula `calculate_monthly_and_period_prices` con el unitario guardado.
		const storedMonthly = Math.round(unit * 2000 * (1 - pct / 100) * 100) / 100;

		expect(storedMonthly).toBe(engine.items[0].monthly_equivalent);
		expect(storedMonthly).toBe(engine.totals.mrr);
	});
});

describe('ContractDraftsService', () => {
	describe('create', () => {
		it('crea en una transacción: número correlativo con lock, contrato, ítems, cotización y evento', async () => {
			const { service, runner, contracts } = build();

			const result = await service.create(baseDto(), 'h-1', 'auth-1', NOW);

			expect(result).toEqual({ id: 'contract-new', contract_number: 'CTR-2026-007' });
			expect(runner.startTransaction).toHaveBeenCalled();
			expect(runner.commitTransaction).toHaveBeenCalled();
			expect(runner.rollbackTransaction).not.toHaveBeenCalled();
			expect(runner.release).toHaveBeenCalled();
			expect(contracts.detail).toHaveBeenCalledWith('contract-new', 'h-1');

			const [lock] = calls(runner.query, 'pg_advisory_xact_lock');

			expect(lock[1]).toEqual(['contracts:h-1:CTR:2026']);
			const [next] = calls(runner.query, 'substring(contract_number');

			expect(next[1]).toEqual(['h-1', '^CTR-2026-(\\d{1,5})$']);

			const [[insertSql, insertParams]] = calls(runner.query, 'INSERT INTO contracts');

			expect(insertSql).toContain('billing_anchor_day, payment_terms, document_type');
			expect(insertParams).toEqual(
				expect.arrayContaining(['h-1', CLIENT, ENTITY, COMPANY, 'CTR-2026-007', 'En revisión', 'ACME SpA', 'ACME', 'CLP'])
			);
			// total = 2 × 100 × 12 × 0,9; día de ciclo = día del primer inicio; condición = la de la razón social;
			// tipo de documento sugerido (CL → CL); envío a Odoo apagado por defecto; agrupación juntas.
			expect(insertParams[8]).toBe(2160);
			expect(insertParams[13]).toBe('2027-09-30');
			// ... + día de ciclo, condición, tipo de documento (familia + documento del catálogo sugerido: CL → CL = 33) y
			// confirmaciones FX (misma moneda en todo: sin confirmar).
			// Día de ciclo automático: el body no lo trae → NULL (el generador usa el del primer recurrente; decisión 01-10).
			expect(insertParams.slice(-6)).toEqual([null, JSON.stringify({ kind: 'net', days: 45 }), 'FACTURA', TDT_33, false, false]);
			expect(insertParams[28]).toBe(false);
			expect(insertParams[29]).toBe(true);
			// Moneda del contrato = compañía: igual copia la política de la compañía (snapshot) y no escribe tasas.
			expect(insertParams[19]).toBe('monthly_avg');
			expect(insertParams[20]).toBe('spot');
			expect(calls(runner.query, 'INSERT INTO contract_fx_period_rates')).toHaveLength(0);

			const [[, itemParams]] = calls(runner.query, 'INSERT INTO contract_items');

			expect(itemParams).toEqual(
				expect.arrayContaining([
					'contract-new',
					'h-1',
					PRODUCT,
					'Licencia Pro',
					'Licencias',
					2,
					100,
					'Porcentaje',
					10,
					2400,
					2160,
					'CLP',
					'Mensual',
				])
			);
			expect(calls(runner.query, 'UPDATE contract_items SET auto_renew')).toHaveLength(0);
			expect(calls(runner.query, 'UPDATE quotes')).toHaveLength(0);

			// Costura: la marca es la primera sentencia; el ítem nace con categoría (historial del cliente) y precios derivados
			// explícitos (réplica de `auto_calculate_pricing_fields`: anual 1.200 → 2.400; mensual 2 × 100 × 0,9 = 180; período 180),
			// y `contracts.term` lo escribe la API después de los ítems.
			expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
			const [[itemSql]] = calls(runner.query, 'INSERT INTO contract_items');

			// Categoría con la regla de `calculate_contract_item_categoria` sin contar borradores borrados (deleted_at).
			expect(itemSql).toContain(itemCategoriaSql(1, 3, 19));
			expect(itemSql).toContain('p.deleted_at IS NULL');
			expect(itemParams.slice(8, 11)).toEqual([100, 1200, 'monthly']);
			expect(itemParams.slice(-5, -2)).toEqual([2400, 180, 180]);
			const termIndex = runner.query.mock.calls.findIndex(([sql]) => (sql as string).includes('UPDATE contracts c SET term'));

			expect(termIndex).toBeGreaterThan(runner.query.mock.calls.findIndex(([sql]) => (sql as string).includes('INSERT INTO contract_items')));
			expect(runner.query.mock.calls[termIndex][1]).toEqual(['contract-new', 'h-1']);

			const [[eventSql, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

			expect(eventSql).toContain(`'CREATED'`);
			expect(eventParams[0]).toBe('contract-new');
			expect(eventParams[1]).toBe('h-1');
			expect(eventParams[4]).toBe('user-1');
			expect(JSON.parse(eventParams[7] as string)).toMatchObject({
				source: 'api_v2',
				quote_id: null,
				origin: 'manual',
				contract_number: 'CTR-2026-007',
			});
			// Nunca escribe el cronograma ni facturas al crear.
			expect(calls(runner.query, 'contract_invoices')).toHaveLength(0);
			expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
		});

		it('número manual repetido en el holding → 409 y rollback', async () => {
			const { service, runner } = build((sql) =>
				sql.includes('SELECT 1 FROM contracts WHERE holding_id = $1 AND contract_number') ? [{ '?column?': 1 }] : undefined
			);

			await expect(service.create(baseDto({ contract_number: 'CTR-2026-100' }), 'h-1', 'auth-1', NOW)).rejects.toThrow(
				new ConflictException('Ya existe un contrato con el número CTR-2026-100')
			);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
			expect(runner.release).toHaveBeenCalled();
			expect(calls(runner.query, 'INSERT INTO contracts')).toHaveLength(0);
		});

		it('número manual libre: se usa tal cual, sin correlativo', async () => {
			const { service, runner } = build();

			await service.create(baseDto({ contract_number: 'ACME-01' }), 'h-1', 'auth-1', NOW);
			expect(calls(runner.query, 'substring(contract_number')).toHaveLength(0);
			expect(calls(runner.query, 'INSERT INTO contracts')[0][1]).toContain('ACME-01');
		});

		it('marcas de facturación (S1-15): las del body mandan; sin body, las de la cotización; sin nada, false', async () => {
			const manual = build();

			await manual.service.create(
				baseDto({ requires_references_for_billing: true, requires_multicurrency_billing: true }),
				'h-1',
				'auth-1',
				NOW
			);
			const [[, manualParams]] = calls(manual.runner.query, 'INSERT INTO contracts');

			expect(manualParams.slice(22, 25)).toEqual([false, true, true]);

			const fromQuote = build((sql) => {
				if (sql.includes('FROM quotes') && sql.includes('FOR UPDATE'))
					return [{ id: QUOTE, quote_number: 'Q-1', requires_multicompany: true, requires_references_for_billing: true }];
				if (sql.includes('FROM quote_items')) return [];

				return undefined;
			});

			await fromQuote.service.create(baseDto({ quote_id: QUOTE, requires_multicompany_billing: false }), 'h-1', 'auth-1', NOW);
			const [[, quoteParams]] = calls(fromQuote.runner.query, 'INSERT INTO contracts');

			// Multiempresa desmarcada en el body (aunque la cotización la traiga); referencias heredadas de la cotización.
			expect(quoteParams.slice(22, 25)).toEqual([false, false, true]);
		});

		it('sin término (S1-12): el ítem se guarda con plazo y fin NULL, el contrato sin fecha de fin y el valor sobre 12 períodos', async () => {
			const { service, runner } = build();
			const [item] = baseDto().items;

			await service.create(baseDto({ items: [{ ...item, term_months: null }] }), 'h-1', 'auth-1', NOW);
			const [[, contractParams]] = calls(runner.query, 'INSERT INTO contracts');
			const [[, itemParams]] = calls(runner.query, 'INSERT INTO contract_items');

			// total = 2 × 100 × 12 (horizonte) × 0,9; fin del contrato NULL.
			expect(contractParams[8]).toBe(2160);
			expect(contractParams[13]).toBeNull();
			expect(itemParams[19]).toBeNull();
			expect(itemParams[20]).toBeNull();
		});

		it('sin término en un ítem de pago único → 400 por campo', async () => {
			const { service } = build();
			const [item] = baseDto().items;
			const error = await service
				.create(baseDto({ items: [{ ...item, is_recurring: false, term_months: null }] }), 'h-1', 'auth-1', NOW)
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(BadRequestException);
			expect(fieldErrorsOf(error as HttpException).map((fieldError) => fieldError.field)).toEqual(['items.0.term_months']);
		});

		it('cotización ya usada → 409 con el número del contrato', async () => {
			const { service, runner } = build((sql) => {
				if (sql.includes('FROM quotes WHERE id')) return [{ id: QUOTE, quote_number: 'Q-1' }];
				if (sql.includes('FROM contracts c WHERE c.quote_id')) return [{ contract_number: 'CTR-2026-050' }];

				return undefined;
			});

			await expect(service.create(baseDto({ quote_id: QUOTE }), 'h-1', 'auth-1', NOW)).rejects.toThrow(
				new ConflictException('La cotización ya tiene un contrato creado (CTR-2026-050)')
			);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('desde cotización: respeta la auto-renovación desmarcada (S1-5), copia la línea y mueve la cotización', async () => {
			const { service, runner } = build((sql) => {
				// Multimoneda: el alta lee el flag de la cotización al validar (`loadContext`) y la bloquea al crear (FOR UPDATE).
				if (sql.includes('FROM quotes WHERE id') || sql.includes('FROM quotes q WHERE q.id'))
					return [{ id: QUOTE, quote_number: 'Q-1', quote_type: 'NewBusiness', booking_date: '2026-09-20', requires_multicurrency: true }];
				if (sql.includes('FROM quote_items WHERE id = ANY'))
					return [{ id: QUOTE_ITEM, quote_item_number: 'QL-9', custom_fields: { po: '123' } }];
				if (sql.includes('INSERT INTO contract_items')) return [{ id: 'item-1' }];

				return undefined;
			});
			const dto = baseDto({ quote_id: QUOTE });

			dto.items[0].quote_item_id = QUOTE_ITEM;
			dto.items[0].auto_renew = false;

			await service.create(dto, 'h-1', 'auth-1', NOW);

			expect(calls(runner.query, 'FROM quotes WHERE id')[0][0]).toContain('FOR UPDATE');
			const [[, itemParams]] = calls(runner.query, 'INSERT INTO contract_items');

			expect(itemParams).toEqual(expect.arrayContaining([QUOTE_ITEM, 'QL-9', JSON.stringify({ po: '123' }), '2026-09-20']));
			// Costura: `inherit_auto_renew_from_quote_item` no corre para la API; el INSERT lleva lo elegido y no hay corrección posterior.
			expect(itemParams[24]).toBe(false);
			expect(calls(runner.query, 'UPDATE contract_items SET auto_renew')).toHaveLength(0);
			// Solo la etapa: `updated_at` lo pone el trigger y el actor queda en el evento CONTRACT_CREATED de quote_events.
			expect(calls(runner.query, 'UPDATE quotes')[0][1]).toEqual([QUOTE, 'h-1', 'stage-created']);
			const [[, insertParams]] = calls(runner.query, 'INSERT INTO contracts');

			expect(insertParams[6]).toBe('NewBusiness');
			expect(insertParams[12]).toBe('2026-09-20');
			expect(insertParams[23]).toBe(true);
			const [[, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

			expect(JSON.parse(eventParams[7] as string)).toMatchObject({ quote_id: QUOTE, origin: `quote:${QUOTE}`, quote_stage_updated: true });
		});

		it('sin la etapa "Contrato creado" en el holding, la cotización queda donde está y el evento lo dice', async () => {
			const { service, runner } = build((sql) => {
				if (sql.includes('FROM quotes WHERE id')) return [{ id: QUOTE, quote_number: 'Q-1' }];
				if (sql.includes('FROM quote_stages')) return [];

				return undefined;
			});

			await service.create(baseDto({ quote_id: QUOTE }), 'h-1', 'auth-1', NOW);
			expect(calls(runner.query, 'UPDATE quotes')).toHaveLength(0);
			expect(JSON.parse(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][7] as string)).toMatchObject({
				quote_stage_updated: false,
			});
		});

		it('moneda distinta a la de la compañía: company_default copia la política de la compañía y la confirma', async () => {
			const { service, runner } = build();

			await service.create(baseDto({ contract_currency: 'USD', invoice_currency: 'USD' }), 'h-1', 'auth-1', NOW);
			const [[sql, insertParams]] = calls(runner.query, 'INSERT INTO contracts');

			expect(insertParams[19]).toBe('monthly_avg');
			expect(sql).toContain('CASE WHEN $38::boolean THEN now() END');
			expect(insertParams.slice(-2)).toEqual([false, true]);
			// Moneda de sistema CLP ≠ USD: la tasa a sistema la calcula la activación.
			expect(insertParams[16]).toBeNull();
		});

		it('valida en el holding con errores por campo (400)', async () => {
			const { service, runner } = build((sql) => {
				if (sql.includes('FROM products WHERE id = ANY')) return [];
				if (sql.includes('FROM client_entities ce WHERE ce.id')) return [{ id: ENTITY, belongs: false }];

				return undefined;
			});

			const error = await service.create(baseDto(), 'h-1', 'auth-1', NOW).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(BadRequestException);
			expect((error as HttpException).getResponse()).toMatchObject({
				errors: [
					{ field: 'client_entity_id', message: 'La razón social no pertenece al cliente' },
					{ field: 'items.0.product_id', message: 'El producto no existe en el catálogo del holding' },
				],
			});
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('usuario sin fila en users → 403 antes de abrir la transacción', async () => {
			const { service, runner } = build((sql) => (sql.includes('FROM users WHERE auth_id') ? [] : undefined));

			await expect(service.create(baseDto(), 'h-1', 'auth-1', NOW)).rejects.toBeInstanceOf(ForbiddenException);
			expect(runner.startTransaction).not.toHaveBeenCalled();
		});
	});

	describe('preview', () => {
		it('usa compañía y razón social de la base y no escribe nada', async () => {
			const { service, dataSource } = build();

			const result = await service.preview(baseDto(), 'h-1');

			expect(result.invoices).toHaveLength(12);
			expect(result.invoices[0]).toMatchObject({ issue_date: '2026-10-01', due_date: '2026-11-15', tax_rate: 19, subtotal: 180, tax: 34.2 });
			expect(result.invoices[0].lines[0]).toMatchObject({
				item_key: 'k1',
				product_name: 'Licencia Pro',
				quantity: 2,
				unit_price: 100,
				discount_pct: 10,
			});
			expect(result.totals).toEqual({ contract_value: 2160, invoiced_total: 2160, difference: 0, mrr: 180 });
			expect((dataSource.query as jest.Mock).mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql as string))).toBe(false);
		});

		it('sin término: 12 períodos de horizonte con su advertencia y la última fecha cubierta', async () => {
			const { service } = build();
			const [item] = baseDto().items;
			const result = await service.preview(baseDto({ items: [{ ...item, term_months: null, billing_frequency: 'Trimestral' }] }), 'h-1');

			expect(result.invoices).toHaveLength(12);
			expect(result.warning_codes).toEqual(['indefinite_horizon']);
			expect(result.indefinite_until).toBe('2029-09-30');
			expect(result.warnings.some((warning) => warning.includes('no tiene término'))).toBe(true);
		});

		it('precio anual: unitario mensual = anual / 12', async () => {
			const { service } = build();
			const dto = baseDto();

			Object.assign(dto.items[0], { unit_price: 100, annual_unit_price: 1200, price_entry_mode: 'annual', discount_value: 0 });
			const result = await service.preview(dto, 'h-1');

			expect(result.invoices[0].lines[0]).toMatchObject({ unit_price: 100, subtotal: 200 });
		});
	});

	describe('fromQuote', () => {
		it('404 si la cotización no es del holding', async () => {
			const { service } = build((sql) => (sql.includes('FROM quotes q') ? [] : undefined));

			await expect(service.fromQuote(QUOTE, 'h-1')).rejects.toBeInstanceOf(NotFoundException);
		});

		it('409 si ya produjo un contrato', async () => {
			const { service } = build((sql) => {
				if (sql.includes('FROM quotes q')) return [{ id: QUOTE }];
				if (sql.includes('FROM contracts c WHERE c.quote_id')) return [{ contract_number: 'CTR-2026-011' }];

				return undefined;
			});

			await expect(service.fromQuote(QUOTE, 'h-1')).rejects.toThrow('La cotización ya tiene un contrato creado (CTR-2026-011)');
		});

		it('prellena cliente, razones sociales e ítems con quote_item_id', async () => {
			const { service } = build((sql) => {
				if (sql.includes('FROM quotes q'))
					return [
						{
							id: QUOTE,
							quote_number: 'Q-1',
							quote_type: 'NewBusiness',
							booking_date: '2026-09-20',
							currency: 'USD',
							payment_terms: '30 días',
							client_id: CLIENT,
							requires_references_for_billing: true,
							client_name: 'ACME',
							stage_name: 'Enviada',
						},
					];
				if (sql.includes('FROM client_entities ce'))
					return [
						{ id: ENTITY, legal_name: 'ACME SpA', country: 'Chile', payment_terms: null },
						{ id: 'e-2', legal_name: 'ACME Perú', country: 'Perú', payment_terms: { kind: 'net', days: 60 } },
					];
				if (sql.includes('FROM quote_items qi'))
					return [
						{
							id: QUOTE_ITEM,
							product_id: PRODUCT,
							product_name: 'Licencia',
							item_type: 'Licencias',
							quantity: '2',
							unit_price: '100',
							discount_type: 'Monto fijo',
							discount_value: '240',
							billing_frequency: 'Mensual',
							billing_method: 'Anticipado',
							start_date: '2026-10-01',
							term_months: 12,
							is_recurring: true,
							auto_renew: true,
						},
					];

				return undefined;
			});

			const result = await service.fromQuote(QUOTE, 'h-1');

			// La condición estructurada se deriva del texto de la cotización ("30 días" → neto 30); las marcas viajan para prellenar. Sin compañía: se elige en el contrato.
			expect(result.quote).toMatchObject({
				id: QUOTE,
				quote_number: 'Q-1',
				payment_terms: '30 días',
				payment_terms_parsed: { kind: 'net', days: 30 },
				requires_multicompany_billing: false,
				requires_multicurrency_billing: false,
				requires_references_for_billing: true,
			});
			expect(result.client).toEqual({ id: CLIENT, name: 'ACME' });
			// Dos razones sociales: ninguna preseleccionada (la elige la usuaria).
			expect(result.entity).toBeNull();
			expect(result.entities.map((entity) => entity.id)).toEqual([ENTITY, 'e-2']);
			expect(result.items[0]).toMatchObject({
				key: QUOTE_ITEM,
				quote_item_id: QUOTE_ITEM,
				product_id: PRODUCT,
				quantity: 2,
				unit_price: 100,
				discount_value: 10,
				start_date: '2026-10-01',
				auto_renew: true,
				booking_date: '2026-09-20',
			});
			expect(result.warnings).toContain('"Licencia": el descuento en monto fijo se convirtió a 10 %');
			expect(result.warnings).toContain('La cotización está en la etapa "Enviada", no Firmada');
		});

		it('un recurrente cotizado sin plazo queda sin término (NULL), no con 12 meses; el no recurrente conserva 12', async () => {
			const { service } = build((sql) => {
				if (sql.includes('FROM quotes q')) return [{ id: QUOTE, quote_number: 'Q-2', client_id: CLIENT, client_name: 'ACME' }];
				if (sql.includes('FROM client_entities ce')) return [{ id: ENTITY, legal_name: 'ACME SpA', country: 'Chile', payment_terms: null }];
				if (sql.includes('FROM quote_items qi'))
					return [
						{
							id: 'qi-1',
							product_id: PRODUCT,
							product_name: 'Licencia',
							item_type: 'Licencias',
							quantity: '1',
							price: '1200',
							term_months: null,
							is_recurring: true,
						},
						{
							id: 'qi-2',
							product_id: PRODUCT,
							product_name: 'Setup',
							item_type: 'Servicios',
							quantity: '1',
							unit_price: '500',
							term_months: null,
							is_recurring: false,
						},
					];

				return undefined;
			});
			const result = await service.fromQuote(QUOTE, 'h-1');

			// Sin unitario: se deriva del precio sobre el horizonte de 12 períodos (1.200 / 12).
			expect(result.items[0]).toMatchObject({ term_months: null, unit_price: 100 });
			expect(result.items[1]).toMatchObject({ term_months: 12 });
		});
	});

	describe('formOptions', () => {
		it('compañías con próximo número completo, catálogo de productos y presets por defecto', async () => {
			const { service } = build((sql) => {
				if (sql.includes('FROM companies WHERE holding_id'))
					return [
						{
							id: COMPANY,
							legal_name: 'Hanka Colombia SAS',
							country: 'Colombia',
							currency: 'COP',
							contract_prefix: 'CTR-CO-',
							tax_rate: '0.19',
						},
						{
							id: 'co-2',
							legal_name: null,
							holding_name: 'SimpliRoute',
							country: 'Mexico',
							currency: 'MXN',
							contract_prefix: '',
							tax_rate: null,
							odoo_integration_id: 7,
						},
					];
				if (sql.includes('FROM master_data')) return [{ category: 'item_types', value: 'Licencias' }];
				if (sql.includes('substring(contract_number')) return [{ next: 12 }];
				if (sql.includes('FROM products p'))
					return [{ id: PRODUCT, name: 'Licencia', is_recurring: true, item_type: 'Licencias', unit_of_measure: 'UN' }];

				return undefined;
			});

			const result = await service.formOptions('h-1', NOW);

			expect(result.companies).toEqual([
				expect.objectContaining({
					id: COMPANY,
					contract_prefix: 'CTR-CO-',
					tax_rate: 19,
					next_number: 'CTR-CO-2026-012',
					currency: 'COP',
					// Sin la columna (antes de la migración) o sin valor: monthly_avg.
					fx_company_policy: 'monthly_avg',
					// Sin `odoo_integration_id`: los automatismos del contrato no operan (mismo criterio del scheduler).
					erp_integration_enabled: false,
					// Colombia no tiene filas en este catálogo: recibe los genéricos y se sugiere la factura local.
					country_code: 'CO',
					tax_document_types: [expect.objectContaining({ code: 'FACTURA' }), expect.objectContaining({ code: 'FACTURA_EXPORTACION' })],
					suggested_tax_document_type_id: TDT_GENERIC,
				}),
				expect.objectContaining({
					id: 'co-2',
					legal_name: 'SimpliRoute',
					tax_rate: null,
					next_number: 'CTR-2026-012',
					country_code: 'MX',
					erp_integration_enabled: true,
				}),
			]);
			expect(result.tax_document_types.map((option) => option.code)).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
			expect(result.currencies).toEqual(['CLP', 'USD']);
			expect(result.item_types).toEqual(['Licencias']);
			expect(result.payment_terms_presets).toEqual(DEFAULT_PAYMENT_TERMS_PRESETS);
			expect(result.document_types.map((option) => option.value)).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
			expect(result.products).toEqual([
				expect.objectContaining({ id: PRODUCT, name: 'Licencia', item_type: 'Licencias', unit_of_measure: 'UN', is_recurring: true }),
			]);
		});

		it('precios de catálogo activos por producto (etapa 3), con su spec listo para copiar', async () => {
			const { service } = build((sql) => {
				if (sql.includes('FROM products p'))
					return [
						{ id: PRODUCT, name: 'Licencia' },
						{ id: 'p-2', name: 'Soporte' },
					];
				if (sql.includes("owner = 'catalog' AND status = 'active'"))
					return [
						{
							id: 'price-1',
							name: 'Licencia por tramos',
							product_id: PRODUCT,
							currency: 'usd',
							version: '2',
							model: 'graduated',
							quantity_type: 'fixed',
							tiers: [{ from: 1, to: null, per_unit_amount: 5 }],
						},
					];

				return undefined;
			});

			const result = await service.formOptions('h-1', NOW);

			expect(result.products[0].catalog_prices).toEqual([
				{
					id: 'price-1',
					name: 'Licencia por tramos',
					version: 2,
					currency: 'USD',
					model: 'graduated',
					quantity_type: 'fixed',
					spec: expect.objectContaining({ model: 'graduated', tiers: [{ from: 1, to: null, per_unit_amount: 5, flat_amount: 0 }] }),
				},
			]);
			expect(result.products[1].catalog_prices).toEqual([]);
		});

		it('mapea las condiciones de pago de master data', async () => {
			const { service } = build((sql) =>
				sql.includes('FROM master_data')
					? [
							{ category: 'payment_terms', value: '30 días' },
							{ category: 'payment_terms', value: 'Contado' },
							{ category: 'payment_terms', value: 'Según OC' },
						]
					: undefined
			);

			const result = await service.formOptions('h-1', NOW);

			expect(result.payment_terms_presets).toEqual([
				{ label: '30 días', kind: 'net', days: 30 },
				{ label: 'Contado', kind: 'net', days: 0 },
			]);
		});

		it('documentos tributarios por compañía: los de su país y la sugerencia según la razón social elegida', async () => {
			const chile = (sql: string) =>
				sql.includes('FROM companies WHERE holding_id')
					? [{ id: COMPANY, legal_name: 'Simplit SpA', country: 'Chile', currency: 'CLP' }]
					: undefined;
			const local = await build(chile).service.formOptions('h-1', NOW);

			expect(local.companies[0].country_code).toBe('CL');
			expect(local.companies[0].tax_document_types.map((option) => option.code)).toEqual(['33', '34', '110']);
			// Sin razón social: factura local.
			expect(local.companies[0].suggested_tax_document_type_id).toBe(TDT_33);
			expect(local.tax_document_types).toHaveLength(3);

			const { service, dataSource } = build((sql) =>
				sql.includes('SELECT country FROM client_entities') ? [{ country: 'Perú' }] : chile(sql)
			);
			const exporting = await service.formOptions('h-1', NOW, { clientEntityId: ENTITY });

			expect(calls(dataSource.query as jest.Mock, 'SELECT country FROM client_entities')[0][1]).toEqual([ENTITY, 'h-1']);
			expect(exporting.companies[0].suggested_tax_document_type_id).toBe(TDT_110);
		});
	});

	describe('documento tributario (catálogo tax_document_types)', () => {
		const errorsOf = async (promise: Promise<unknown>) => {
			const error = await promise.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(BadRequestException);

			return fieldErrorsOf(error as HttpException);
		};
		const peruEntity = (sql: string) =>
			sql.includes('FROM client_entities ce WHERE ce.id')
				? [{ id: ENTITY, legal_name: 'ACME Perú SAC', country: 'Perú', payment_terms: null, belongs: true }]
				: undefined;

		it('sin elección: sugiere el documento del país (exportación si la razón social es de otro país) y fija la familia', async () => {
			const { service, runner } = build(peruEntity);

			// Aunque el body diga FACTURA, con catálogo manda el documento sugerido: CL → PE = 110 (exportación).
			await service.create(baseDto({ document_type: 'FACTURA' }), 'h-1', 'auth-1', NOW);
			const [[, params]] = calls(runner.query, 'INSERT INTO contracts');

			expect(params.slice(-4, -2)).toEqual(['FACTURA_EXPORTACION', TDT_110]);
		});

		it('sin elección y sin documento de exportación en el catálogo (México): el CFDI con familia de exportación, sin IVA (Domi 05-10)', async () => {
			const cfdi = {
				id: 'cfdi-i',
				country_code: 'MX',
				code: 'CFDI-I',
				name: 'Factura CFDI de ingreso',
				kind: 'invoice',
				is_electronic: true,
				sort: 10,
				tax_rate: 16,
			};
			const { service, runner } = build((sql) =>
				sql.includes('FROM companies WHERE id')
					? [{ id: COMPANY, legal_name: 'SimpliRoute MX', country: 'México', currency: 'USD', contract_prefix: 'CTR-', tax_rate: '16' }]
					: sql.includes('FROM client_entities ce WHERE ce.id')
						? [{ id: ENTITY, legal_name: 'ACME CR', country: 'Costa Rica', payment_terms: null, belongs: true }]
						: sql.includes('FROM tax_document_types')
							? [cfdi]
							: undefined
			);

			await service.create(baseDto({ document_type: 'FACTURA' }), 'h-1', 'auth-1', NOW);
			const [[, params]] = calls(runner.query, 'INSERT INTO contracts');

			expect(params.slice(-4, -2)).toEqual(['FACTURA_EXPORTACION', 'cfdi-i']);
		});

		it('con elección válida del país de la compañía: guarda el documento y deriva la familia de su kind', async () => {
			const { service, runner } = build();

			await service.create(baseDto({ tax_document_type_id: TDT_110 }), 'h-1', 'auth-1', NOW);
			expect(calls(runner.query, 'INSERT INTO contracts')[0][1].slice(-4, -2)).toEqual(['FACTURA_EXPORTACION', TDT_110]);

			const exempt = build();

			await exempt.service.create(baseDto({ tax_document_type_id: TDT_34 }), 'h-1', 'auth-1', NOW);
			expect(calls(exempt.runner.query, 'INSERT INTO contracts')[0][1].slice(-4, -2)).toEqual(['FACTURA', TDT_34]);
		});

		it('documento de otro país (o genérico cuando la compañía tiene catálogo propio) → 400 por campo, sin escribir', async () => {
			const { service, runner } = build();

			expect(await errorsOf(service.create(baseDto({ tax_document_type_id: TDT_GENERIC }), 'h-1', 'auth-1', NOW))).toEqual([
				{ field: 'tax_document_type_id', message: TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE },
			]);
			expect(calls(runner.query, 'INSERT INTO contracts')).toHaveLength(0);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('la vista previa usa la familia del documento del catálogo (exportación: sin IVA, export_type 1)', async () => {
			const { service } = build(peruEntity);
			const result = await service.preview(baseDto(), 'h-1');

			expect(result.invoices[0]).toMatchObject({ document_type: 'FACTURA_EXPORTACION', export_type: 1, tax_rate: 0 });
		});

		it('sin catálogo (tabla vacía): la familia sale de la regla por país, como antes', async () => {
			const { service, runner } = build((sql) => (sql.includes('FROM tax_document_types') ? [] : peruEntity(sql)));

			await service.create(baseDto(), 'h-1', 'auth-1', NOW);
			expect(calls(runner.query, 'INSERT INTO contracts')[0][1].slice(-4, -2)).toEqual(['FACTURA_EXPORTACION', null]);
		});
	});

	describe('remove (C5)', () => {
		const contractRow = (overrides: Record<string, unknown> = {}) => [
			{ id: 'c-1', contract_number: 'CTR-2026-001', status: 'En revisión', invoices_count: '0', ...overrides },
		];

		it('borrado lógico de un borrador sin facturas, con evento DELETED', async () => {
			const { service, runner } = build((sql) => (sql.includes('FROM contracts c') ? contractRow() : undefined));

			await expect(service.remove('CTR-2026-001', 'h-1', 'auth-1')).resolves.toEqual({
				id: 'c-1',
				contract_number: 'CTR-2026-001',
				deleted: true,
			});
			const [[selectSql]] = calls(runner.query, 'FROM contracts c');

			expect(selectSql).toContain('c.contract_number = $1');
			expect(selectSql).toContain('c.deleted_at IS NULL');
			expect(calls(runner.query, 'UPDATE contracts SET deleted_at = now()')[0][1]).toEqual(['c-1', 'h-1']);
			expect(calls(runner.query, `'DELETED'`)[0][1]).toEqual(expect.arrayContaining(['c-1', 'h-1', 'user-1']));
			expect(runner.commitTransaction).toHaveBeenCalled();
		});

		it('409 si no es borrador', async () => {
			const { service, runner } = build((sql) => (sql.includes('FROM contracts c') ? contractRow({ status: 'Activo' }) : undefined));

			await expect(service.remove('c-1', 'h-1', 'auth-1')).rejects.toThrow(
				new ConflictException('Solo se puede eliminar un contrato en borrador; CTR-2026-001 está Activo')
			);
			expect(calls(runner.query, 'UPDATE contracts')).toHaveLength(0);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('409 si ya tiene facturas no legacy', async () => {
			const { service } = build((sql) => (sql.includes('FROM contracts c') ? contractRow({ invoices_count: '2' }) : undefined));

			await expect(service.remove('c-1', 'h-1', 'auth-1')).rejects.toThrow('No se puede eliminar CTR-2026-001: ya tiene facturas');
		});

		it('404 si no es del holding (o ya estaba borrado)', async () => {
			const { service } = build((sql) => (sql.includes('FROM contracts c') ? [] : undefined));

			await expect(service.remove('11111111-1111-4111-8111-111111111111', 'h-1', 'auth-1')).rejects.toBeInstanceOf(NotFoundException);
		});

		it('409 legible (no 500) si falta la migración de borrado lógico, sin abrir transacción', async () => {
			const { service, runner } = build((sql) => (sql.includes('information_schema.columns') ? [] : undefined));

			await expect(service.remove('c-1', 'h-1', 'auth-1')).rejects.toThrow(new ConflictException(MISSING_SOFT_DELETE_MESSAGE));
			await expect(service.bulkRemove(['c-1'], 'h-1', 'auth-1')).rejects.toBeInstanceOf(ConflictException);
			expect(runner.startTransaction).not.toHaveBeenCalled();
		});

		it('consulta la columna una sola vez', async () => {
			const { service, dataSource } = build((sql) => (sql.includes('FROM contracts c') ? contractRow() : undefined));

			await service.remove('c-1', 'h-1', 'auth-1');
			await service.remove('c-1', 'h-1', 'auth-1');
			expect(calls(dataSource.query as jest.Mock, 'information_schema.columns')).toHaveLength(1);
		});
	});

	describe('bulkRemove (C5 masivo)', () => {
		const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
		const rows = [
			{ id: A, contract_number: 'CTR-A', status: 'En revisión', invoices_count: '0' },
			{ id: B, contract_number: 'CTR-B', status: 'Activo', invoices_count: '0' },
			{ id: C, contract_number: 'CTR-C', status: 'En revisión', invoices_count: '3' },
		];

		it('elimina los que califican en una transacción y devuelve los omitidos con el motivo', async () => {
			const { service, runner } = build((sql) => (sql.includes('FROM contracts c') ? rows : undefined));

			const result = await service.bulkRemove([A, B, C, D, A], 'h-1', 'auth-1');

			expect(result).toEqual({
				deleted: [{ id: A, contract_number: 'CTR-A' }],
				skipped: [
					{ id: B, contract_number: 'CTR-B', reason: 'Solo se puede eliminar un contrato en borrador; CTR-B está Activo' },
					{ id: C, contract_number: 'CTR-C', reason: 'No se puede eliminar CTR-C: ya tiene facturas' },
					{ id: D, contract_number: null, reason: 'El contrato no existe en el holding o ya fue eliminado' },
				],
			});
			const [[selectSql, selectParams]] = calls(runner.query, 'FROM contracts c');

			expect(selectSql).toContain('c.id = ANY($1::uuid[]) AND c.holding_id = $2');
			expect(selectSql).toContain('FOR UPDATE OF c');
			expect(selectSql).toContain('COALESCE(i.is_legacy, false) = false');
			expect(selectParams).toEqual([[A, B, C, D], 'h-1']);
			expect(calls(runner.query, 'UPDATE contracts SET deleted_at = now()').map(([, params]) => params)).toEqual([[A, 'h-1']]);
			const events = calls(runner.query, `'DELETED'`);

			expect(events).toHaveLength(1);
			expect(JSON.parse((events[0][1] as unknown[])[4] as string)).toEqual({ source: 'api_v2', contract_number: 'CTR-A', bulk: true });
			expect(runner.startTransaction).toHaveBeenCalledTimes(1);
			expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
		});

		it('si falla una escritura, no queda nada aplicado (rollback de toda la acción)', async () => {
			const { service, runner } = build((sql) => {
				if (sql.includes('FROM contracts c')) return rows;
				if (sql.includes(`'DELETED'`)) throw new Error('fallo');

				return undefined;
			});

			await expect(service.bulkRemove([A], 'h-1', 'auth-1')).rejects.toThrow('fallo');
			expect(runner.rollbackTransaction).toHaveBeenCalled();
			expect(runner.commitTransaction).not.toHaveBeenCalled();
		});
	});
});

describe('ContractDraftsService · tipo de cambio (modelo FX v2)', () => {
	const errorsOf = async (promise: Promise<unknown>) => {
		const error = await promise.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BadRequestException);

		return fieldErrorsOf(error as HttpException);
	};

	it('guarda políticas, confirmaciones y tasas con su propósito (contrato → otra moneda) en la misma transacción', async () => {
		const { service, runner } = build();

		await service.create(
			baseDto({
				contract_currency: 'USD',
				invoice_currency: 'CLP',
				fx_invoice_policy: 'fixed',
				fx_invoice_rates: [{ rate: 950 }],
				fx_company_policy: 'fixed_period',
				fx_company_rates: [
					{ rate: 940, period_start: '2026-10-01', period_end: '2027-03-31' },
					{ rate: 960, period_start: '2027-04-01', period_end: '2027-09-30' },
				],
			}),
			'h-1',
			'auth-1',
			NOW
		);
		const [[insertSql, insertParams]] = calls(runner.query, 'INSERT INTO contracts');

		expect(insertSql).toContain('fx_invoice_confirmed_at, fx_company_confirmed_at');
		expect([insertParams[19], insertParams[20], insertParams[21]]).toEqual(['fixed_period', 'fixed', 'CLP']);
		expect(insertParams.slice(-2)).toEqual([true, true]);

		const rates = calls(runner.query, 'INSERT INTO contract_fx_period_rates').map(([, params]) => params);

		expect(rates).toEqual([
			// Una tasa sin fechas es "para todo el contrato": se guarda con el rango de los ítems (Domi 01-10).
			['contract-new', 'h-1', 'invoice', 'USD', 'CLP', 950, '2026-10-01', '2027-09-30', 'Cargada al crear el contrato (v2)', 'user-1'],
			['contract-new', 'h-1', 'company', 'USD', 'CLP', 940, '2026-10-01', '2027-03-31', 'Cargada al crear el contrato (v2)', 'user-1'],
			['contract-new', 'h-1', 'company', 'USD', 'CLP', 960, '2027-04-01', '2027-09-30', 'Cargada al crear el contrato (v2)', 'user-1'],
		]);
		// Las tasas van después del contrato y antes del commit.
		const statements = runner.query.mock.calls.map(([sql]) => sql as string);

		expect(statements.findIndex((sql) => sql.includes('INSERT INTO contract_fx_period_rates'))).toBeGreaterThan(
			statements.findIndex((sql) => sql.includes('INSERT INTO contracts'))
		);
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('tasa para todo el contrato (sin fechas): no convive con tasas por período del mismo propósito (400 claro)', async () => {
		const { service, runner } = build();

		expect(
			await errorsOf(
				service.create(
					baseDto({
						invoice_currency: 'USD',
						fx_invoice_policy: 'fixed',
						fx_invoice_rates: [{ rate: 0.001 }, { rate: 0.0011, period_start: '2027-01-01', period_end: '2027-06-30' }],
					}),
					'h-1',
					'auth-1',
					NOW
				)
			)
		).toEqual([{ field: 'fx_invoice_rates.0', message: WHOLE_CONTRACT_RATE_CONFLICT }]);
		expect(calls(runner.query, 'INSERT INTO contracts')).toHaveLength(0);
	});

	it('ítem sin término: una tasa con inicio y sin fin cubre el horizonte de 12 períodos (indefinite_until), no da error', async () => {
		const { service, runner } = build();

		await service.create(
			baseDto({
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fx_invoice_rates: [{ rate: 0.001, period_start: '2026-10-01' }],
				items: [{ ...baseDto().items[0], term_months: null }],
			}),
			'h-1',
			'auth-1',
			NOW
		);
		const [rate] = calls(runner.query, 'INSERT INTO contract_fx_period_rates').map(([, params]) => params);

		expect(rate.slice(6, 8)).toEqual(['2026-10-01', '2027-09-30']);
	});

	it('vista previa: la tasa para todo el contrato valoriza todas las facturas, también las del horizonte de un ítem sin término', async () => {
		const { service } = build();
		const preview = await service.preview(
			baseDto({
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fx_invoice_rates: [{ rate: 0.001 }],
				items: [{ ...baseDto().items[0], term_months: null }],
			}),
			'h-1'
		);

		expect(preview.invoices).toHaveLength(12);
		expect(preview.invoices.every((invoice) => invoice.fx === 0.001)).toBe(true);
		expect(preview.indefinite_until).toBe('2027-09-30');
	});

	it('tipo de cambio fijo de facturación sin tasa: crea el borrador sin filas de tasa (se define por factura antes de emitir)', async () => {
		const { service, runner } = build();

		await service.create(baseDto({ invoice_currency: 'USD', fx_invoice_policy: 'fixed' }), 'h-1', 'auth-1', NOW);

		expect(calls(runner.query, 'INSERT INTO contracts')).toHaveLength(1);
		expect(calls(runner.query, 'INSERT INTO contract_fx_period_rates')).toHaveLength(0);
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('S6-10: la emisión automática requiere el envío automático al ERP (400 por campo, sin escribir)', async () => {
		const { service, runner } = build();

		expect(await errorsOf(service.create(baseDto({ auto_invoice: true, auto_send_to_odoo: false }), 'h-1', 'auth-1', NOW))).toEqual([
			{ field: 'auto_invoice', message: 'La emisión automática requiere el envío automático al ERP' },
		]);
		expect(await errorsOf(service.preview(baseDto({ auto_invoice: true }), 'h-1'))).toEqual([
			{ field: 'auto_invoice', message: 'La emisión automática requiere el envío automático al ERP' },
		]);
		expect(calls(runner.query, 'INSERT INTO contracts')).toHaveLength(0);
		await expect(service.preview(baseDto({ auto_invoice: true, auto_send_to_odoo: true }), 'h-1')).resolves.toBeDefined();
	});

	it('company_default guarda la política de la compañía (snapshot)', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('FROM companies WHERE id')
				? [{ id: COMPANY, legal_name: 'Simplit SpA', country: 'Chile', currency: 'CLP', tax_rate: '19', fx_company_policy: 'monthly_avg' }]
				: undefined
		);

		await service.create(
			baseDto({ contract_currency: 'USD', invoice_currency: 'USD', fx_company_policy: 'company_default' }),
			'h-1',
			'auth-1',
			NOW
		);
		const [[companySql]] = calls(runner.query, 'FROM companies WHERE id');

		expect(companySql).toContain(`COALESCE(fx_company_policy, 'monthly_avg')`);
		expect(calls(runner.query, 'INSERT INTO contracts')[0][1][19]).toBe('monthly_avg');
		expect(calls(runner.query, 'INSERT INTO contract_fx_period_rates')).toHaveLength(0);
	});

	it('rechaza tasas o políticas que no aplican, fechas invertidas y solapes (400 por campo, sin escribir)', async () => {
		const { service, runner } = build();

		expect(
			await errorsOf(service.create(baseDto({ fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 1 }] }), 'h-1', 'auth-1', NOW))
		).toEqual([{ field: 'fx_invoice_policy', message: 'Se factura en la moneda del contrato: no lleva tipo de cambio fijo' }]);
		expect(
			await errorsOf(
				service.preview(baseDto({ invoice_currency: 'USD', fx_invoice_policy: 'spot', fx_invoice_rates: [{ rate: 0.001 }] }), 'h-1')
			)
		).toEqual([{ field: 'fx_invoice_rates', message: 'Las tasas fijas de facturación solo aplican con tipo de cambio fijo' }]);
		expect(await errorsOf(service.preview(baseDto({ fx_company_policy: 'fixed_period', fx_company_rates: [{ rate: 1 }] }), 'h-1'))).toEqual([
			{ field: 'fx_company_policy', message: 'El contrato está en la moneda de la compañía: no lleva tipo de cambio de compañía' },
		]);
		expect(
			await errorsOf(
				service.preview(
					baseDto({
						invoice_currency: 'USD',
						fx_invoice_policy: 'fixed',
						fx_invoice_rates: [
							{ rate: 0.001, period_start: '2026-10-01', period_end: '2027-03-31' },
							{ rate: 0.0011, period_start: '2027-03-01', period_end: '2027-09-30' },
							{ rate: 0.0012, period_start: '2027-12-01', period_end: '2027-11-30' },
						],
					}),
					'h-1'
				)
			)
		).toEqual([
			{ field: 'fx_invoice_rates.2.period_end', message: 'El fin de la tasa debe ser posterior a su inicio' },
			{ field: 'fx_invoice_rates.1.period_start', message: 'La tasa se superpone con la del 2026-10-01 al 2027-03-31' },
		]);
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
	});

	it('UF: contrato en CLF sin moneda de facturación se factura en CLP si la compañía es CLP; si no, es obligatoria', async () => {
		const withUf = (sql: string) => (sql.includes('FROM currencies') ? [{ code: 'CLP' }, { code: 'USD' }, { code: 'CLF' }] : undefined);
		const { service, runner } = build(withUf);

		await service.create(baseDto({ contract_currency: 'CLF' }), 'h-1', 'auth-1', NOW);
		const [[, insertParams]] = calls(runner.query, 'INSERT INTO contracts');

		// fx_company_policy (copia de la compañía), fx_invoice_policy (del día por defecto), invoice_currency.
		expect([insertParams[19], insertParams[20], insertParams[21]]).toEqual(['monthly_avg', 'spot', 'CLP']);
		expect(insertParams.slice(-2)).toEqual([true, true]);

		const usdCompany = build((sql) =>
			sql.includes('FROM companies WHERE id')
				? [{ id: COMPANY, legal_name: 'Hanka USA', country: 'Estados Unidos', currency: 'USD', tax_rate: '0' }]
				: withUf(sql)
		);

		expect(await errorsOf(usdCompany.service.preview(baseDto({ contract_currency: 'CLF' }), 'h-1'))).toEqual([
			{ field: 'invoice_currency', message: 'Un contrato en UF se factura en otra moneda: elige la moneda de facturación (por ejemplo, CLP)' },
		]);
		// Con moneda de facturación explícita (y su política) sí se puede.
		await expect(
			usdCompany.service.preview(baseDto({ contract_currency: 'CLF', invoice_currency: 'USD', fx_invoice_policy: 'spot' }), 'h-1')
		).resolves.toBeDefined();
	});

	it('la vista previa usa la tasa fija de facturación (1 CLP = 0,001 USD, se multiplica)', async () => {
		const { service } = build();

		const result = await service.preview(
			baseDto({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 0.001 }] }),
			'h-1'
		);

		expect(result.invoices[0]).toMatchObject({
			currency: 'USD',
			fx: 0.001,
			subtotal: 180,
			amounts_invoice_currency: { subtotal: 0.18, tax: 0.03, total: 0.21 },
		});
		expect(result.invoices.every((invoice) => invoice.fx === 0.001)).toBe(true);
		expect(result.warnings.some((warning) => warning.includes('se valorizan al emitir'))).toBe(false);
	});
});

describe('CreateContractDto', () => {
	const check = async (body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(CreateContractDto, body), { whitelist: true, forbidNonWhitelisted: true }));

	it('tipo de cambio: política obligatoria con moneda de factura distinta, tasa opcional con fijo (obligatoria en la de compañía), tasa > 0 y políticas válidas', async () => {
		const fields = async (overrides: Record<string, unknown>) =>
			(await check({ ...baseDto(), ...overrides })).map((error) => `${error.field}: ${error.message}`);

		expect(await fields({ invoice_currency: 'usd' })).toEqual(['fx_invoice_policy: Elige el tipo de cambio de facturación: del día o fijo']);
		expect(await fields({ invoice_currency: 'CLP' })).toEqual([]);
		// La tasa fija de facturación es opcional al crear: se define por factura antes de emitir (el scheduler no emite sin tasa).
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed' })).toEqual([]);
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [] })).toEqual([]);
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: 'x' })).toEqual([
			'fx_invoice_rates: Tasas fijas de facturación inválidas',
		]);
		expect(
			await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 0, period_start: '2026-13-01' }] })
		).toEqual(['fx_invoice_rates.0.rate: La tasa debe ser mayor que 0', 'fx_invoice_rates.0.period_start: Fecha de inicio de la tasa inválida']);
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 0.00105 }] })).toEqual([]);
		// La política de compañía ya no acepta el valor de la base: company_default copia la de la compañía.
		expect(await fields({ fx_company_policy: 'monthly_avg' })).toEqual(['fx_company_policy: Elige cómo se convierte a la moneda de la compañía']);
		expect(await fields({ fx_company_policy: 'company_default' })).toEqual([]);
		// La UF nunca es moneda de facturación.
		expect(await fields({ contract_currency: 'CLF', invoice_currency: 'clf' })).toEqual([
			'invoice_currency: La UF no se factura: elige la moneda en que se emite (por ejemplo, CLP)',
		]);
		expect(await fields({ fx_company_policy: 'fixed_period' })).toEqual(['fx_company_rates: Agrega la tasa fija de la compañía']);
		expect(await fields({ fx_company_policy: 'fixed_period', fx_company_rates: [{ rate: 950, period_end: '2027-09-30' }] })).toEqual([]);
	});

	it('acepta el body del front (con key por ítem) y normaliza la moneda', async () => {
		const body = { ...baseDto(), contract_currency: 'clp', fx_invoice_policy: 'spot', payment_terms: { kind: 'net', days: 30 } };

		expect(await check(body)).toEqual([]);
		expect(plainToInstance(CreateContractDto, body).contract_currency).toBe('CLP');
	});

	it('exige producto, tipo, frecuencia, inicio y plazo por ítem, con la ruta del campo', async () => {
		const errors = await check({
			...baseDto(),
			items: [
				{
					key: 'k1',
					quantity: 0,
					unit_price: -1,
					discount_value: 120,
					billing_frequency: 'Diario',
					billing_method: 'X',
					start_date: '2026-13-01',
					term_months: 1.5,
				},
			],
		});
		const fields = Object.fromEntries(errors.map((error) => [error.field, error.message]));

		expect(fields).toMatchObject({
			'items.0.product_id': 'Elige un producto',
			'items.0.item_type': 'Elige el tipo de ítem',
			'items.0.quantity': 'La cantidad debe ser mayor que 0',
			'items.0.unit_price': 'El precio no puede ser negativo',
			'items.0.discount_value': 'El descuento va de 0 a 100 %',
			'items.0.billing_frequency': 'Elige la frecuencia de facturación',
			'items.0.billing_method': 'Elige si se factura anticipado o vencido',
			'items.0.start_date': 'Elige la fecha de inicio',
			'items.0.term_months': 'El plazo va en meses enteros',
		});
	});

	it('rechaza holding_id en el body, tipo de documento y día de ciclo inválidos, y sin ítems', async () => {
		const errors = await check({ ...baseDto(), holding_id: 'h-2', document_type: 'NC', billing_anchor_day: 32, items: [] });
		const fields = errors.map((error) => error.field);

		expect(fields).toEqual(expect.arrayContaining(['holding_id', 'document_type', 'billing_anchor_day', 'items']));
	});

	it('documento tributario: UUID opcional', async () => {
		expect(await check({ ...baseDto(), tax_document_type_id: TDT_33 })).toEqual([]);
		expect(await check({ ...baseDto(), tax_document_type_id: '33' })).toEqual([
			{ field: 'tax_document_type_id', message: 'Documento tributario inválido' },
		]);
	});

	it('valida la forma de la condición de pago', async () => {
		const errors = await check({ ...baseDto(), payment_terms: { kind: 'day_of_next_month', day: 40 } });

		expect(errors.map((error) => error.field)).toContain('payment_terms.day');
	});

	it('sin término: term_months null solo en recurrentes; las marcas de facturación son booleanas opcionales', async () => {
		const [item] = baseDto().items;

		expect(await check({ ...baseDto(), items: [{ ...item, term_months: null }] })).toEqual([]);
		expect((await check({ ...baseDto(), items: [{ ...item, term_months: null, is_recurring: false }] })).map((error) => error.field)).toEqual([
			'items.0.term_months',
		]);
		expect(
			await check({
				...baseDto(),
				requires_multicompany_billing: true,
				requires_multicurrency_billing: false,
				requires_references_for_billing: true,
			})
		).toEqual([]);
		expect((await check({ ...baseDto(), requires_references_for_billing: 'sí' })).map((error) => error.field)).toEqual([
			'requires_references_for_billing',
		]);
	});

	it('precio anual: exige annual_unit_price y no unit_price', async () => {
		const [item] = baseDto().items;
		const withoutUnit = { ...item };

		delete withoutUnit.unit_price;

		expect(await check({ ...baseDto(), items: [{ ...withoutUnit, price_entry_mode: 'annual', annual_unit_price: 1200 }] })).toEqual([]);
		expect((await check({ ...baseDto(), items: [{ ...withoutUnit, price_entry_mode: 'annual' }] })).map((error) => error.field)).toContain(
			'items.0.annual_unit_price'
		);
		expect((await check({ ...baseDto(), items: [withoutUnit] })).map((error) => error.field)).toContain('items.0.unit_price');
	});
});

describe('UpdateContractDto y UpdateContractTermsDto', () => {
	const check = async (type: new () => object, body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true }));

	it('editar: mismas reglas que crear, más `items[].id` opcional (UUID)', async () => {
		const [item] = baseDto().items;

		expect(await check(UpdateContractDto, { ...baseDto(), items: [{ ...item, id: ITEM_A }, item] })).toEqual([]);
		expect(await check(UpdateContractDto, { ...baseDto(), items: [{ ...item, id: 'nope' }] })).toEqual([
			{ field: 'items.0.id', message: 'Ítem del contrato inválido' },
		]);
		expect((await check(UpdateContractDto, { ...baseDto(), items: [{ ...item, id: ITEM_A, quantity: 0 }] })).map((error) => error.field)).toEqual(
			['items.0.quantity']
		);
		// Sigue rechazando lo que crear rechaza.
		expect((await check(UpdateContractDto, { ...baseDto(), holding_id: 'h-2', items: [] })).map((error) => error.field)).toEqual(
			expect.arrayContaining(['holding_id', 'items'])
		);
	});

	it('condiciones de factura: texto de hasta 5.000 caracteres o null; nada más', async () => {
		expect(await check(UpdateContractTermsDto, { invoice_terms_and_conditions: 'Pago a 30 días' })).toEqual([]);
		expect(await check(UpdateContractTermsDto, { invoice_terms_and_conditions: null })).toEqual([]);
		expect(await check(UpdateContractTermsDto, { invoice_terms_and_conditions: 'x'.repeat(5001) })).toEqual([
			{ field: 'invoice_terms_and_conditions', message: 'Las condiciones no pueden superar 5.000 caracteres' },
		]);
		expect(await check(UpdateContractTermsDto, {})).toEqual([
			{ field: 'invoice_terms_and_conditions', message: 'Escribe las condiciones de factura (o null para borrarlas)' },
		]);
		expect((await check(UpdateContractTermsDto, { invoice_terms_and_conditions: 'x', notes: 'y' })).map((error) => error.field)).toEqual([
			'notes',
		]);
	});
});

describe('ContractDraftsService · editar borrador (GET :id/form y PUT :id)', () => {
	/** Borrador guardado en CLP con dos ítems (A recurrente, B único) y una tasa fija de facturación en USD. */
	const header = (overrides: Record<string, unknown> = {}) => ({
		id: 'contract-1',
		contract_number: 'CTR-2026-001',
		status: 'En revisión',
		created_at: new Date('2026-09-20T12:00:00.000Z'),
		client_id: CLIENT,
		client_entity_id: ENTITY,
		company_id: COMPANY,
		quote_id: null,
		contract_currency: 'CLP',
		invoice_currency: 'USD',
		fx_invoice_policy: 'fixed',
		fx_company_policy: 'monthly_avg',
		payment_terms: { days: 45, kind: 'net' },
		document_type: 'FACTURA',
		tax_document_type_id: TDT_33,
		billing_anchor_day: 1,
		group_invoices_by_period: true,
		auto_send_to_odoo: false,
		auto_invoice: false,
		booking_date: '2026-09-20',
		salesforce_opportunity_id: null,
		notes: 'Nota original',
		invoice_terms_and_conditions: null,
		custom_fields: {},
		total_value: '2160',
		invoices_count: '0',
		...overrides,
	});
	const storedItems = [
		{
			id: ITEM_A,
			quote_item_id: null,
			product_id: PRODUCT,
			product_name: 'Licencia Pro',
			account: 'Norte',
			item_type: 'Licencias',
			unit_of_measure: 'UN',
			quantity: '2',
			unit_price: '100',
			annual_unit_price: '1200',
			price_entry_mode: 'monthly',
			discount_value: '10',
			billing_frequency: 'Mensual',
			billing_method: 'Anticipado',
			start_date: '2026-10-01',
			term_months: 12,
			is_recurring: true,
			auto_renew: false,
			auto_renew_term_months: null,
			booking_date: '2026-09-20',
		},
		{
			id: ITEM_B,
			quote_item_id: null,
			product_id: PRODUCT,
			product_name: 'Implementación',
			account: null,
			item_type: 'Servicios',
			unit_of_measure: null,
			quantity: '1',
			unit_price: null,
			annual_unit_price: '6000',
			price_entry_mode: 'annual',
			discount_value: '0',
			billing_frequency: 'Mensual',
			billing_method: 'Anticipado',
			start_date: '2026-10-01',
			term_months: 1,
			is_recurring: false,
			auto_renew: false,
			auto_renew_term_months: null,
			booking_date: null,
		},
	];
	const storedRates = [{ purpose: 'invoice', rate: '0.001', period_start: '2026-10-01', period_end: '2027-09-30' }];
	const draftHandler =
		(overrides: Record<string, unknown> = {}, extra: Handler = () => undefined): Handler =>
		(sql, params) => {
			const custom = extra(sql, params);

			if (custom !== undefined) return custom;
			if (sql.includes('c.created_at, c.client_id')) return [header(overrides)];
			if (sql.includes('SELECT ci.id, ci.product_id, ci.quote_item_id'))
				return storedItems.map(({ id, product_id, quote_item_id }) => ({ id, product_id, quote_item_id, price_id: null }));
			if (sql.includes('FROM contract_items ci') && sql.includes('ORDER BY ci.start_date NULLS LAST')) return storedItems;
			if (sql.includes('FROM contract_fx_period_rates WHERE contract_id')) return storedRates;
			if (sql.includes('FROM quantities WHERE contract_item_id')) return [{ count: '0' }];

			return undefined;
		};
	const conflictOf = async (promise: Promise<unknown>) => {
		const error = await promise.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);

		return (error as HttpException).message;
	};
	const errorsOf = async (promise: Promise<unknown>) => {
		const error = await promise.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BadRequestException);

		return fieldErrorsOf(error as HttpException);
	};

	describe('form', () => {
		it('la tasa única que cubre el rango de los ítems vuelve sin fechas (todo el contrato) y el día de ciclo NULL vuelve null (automático)', async () => {
			const { service } = build(
				draftHandler({ billing_anchor_day: null }, (sql) =>
					sql.includes('FROM contract_fx_period_rates WHERE contract_id')
						? [{ purpose: 'invoice', rate: '0.001', period_start: '2026-10-01', period_end: '2027-09-30' }]
						: sql.includes('MIN(ci.start_date)')
							? [{ start: '2026-10-01', end: '2027-09-30' }]
							: undefined
				)
			);
			const { form } = await service.form('contract-1', 'h-1');

			expect(form.fx_invoice_rates).toEqual([{ rate: 0.001 }]);
			expect(form.billing_anchor_day).toBeNull();
		});

		it('devuelve el borrador en la forma exacta del body de crear, con items[].id y las tasas por propósito', async () => {
			const { service, contracts } = build(draftHandler());
			const result = await service.form('CTR-2026-001', 'h-1');

			expect(contracts.resolveContract).toHaveBeenCalledWith('CTR-2026-001', 'h-1');
			expect(result).toMatchObject({
				id: 'contract-1',
				contract_number: 'CTR-2026-001',
				status: 'En revisión',
				created_at: '2026-09-20T12:00:00.000Z',
			});
			expect(result.form).toEqual({
				client_id: CLIENT,
				client_entity_id: ENTITY,
				company_id: COMPANY,
				contract_number: 'CTR-2026-001',
				contract_currency: 'CLP',
				invoice_currency: 'USD',
				fx_invoice_policy: 'fixed',
				fx_invoice_rates: [{ rate: 0.001, period_start: '2026-10-01', period_end: '2027-09-30' }],
				fx_company_policy: 'company_default',
				payment_terms: { kind: 'net', days: 45 },
				tax_document_type_id: TDT_33,
				document_type: 'FACTURA',
				billing_anchor_day: 1,
				group_invoices_by_period: true,
				auto_send_to_odoo: false,
				auto_invoice: false,
				booking_date: '2026-09-20',
				notes: 'Nota original',
				custom_fields: {},
				requires_multicompany_billing: false,
				requires_multicurrency_billing: false,
				requires_references_for_billing: false,
				items: [
					{
						id: ITEM_A,
						key: ITEM_A,
						product_id: PRODUCT,
						currency: 'CLP',
						product_name: 'Licencia Pro',
						account: 'Norte',
						item_type: 'Licencias',
						unit_of_measure: 'UN',
						quantity: 2,
						unit_price: 100,
						discount_value: 10,
						billing_frequency: 'Mensual',
						billing_method: 'Anticipado',
						start_date: '2026-10-01',
						term_months: 12,
						is_recurring: true,
						auto_renew: false,
						booking_date: '2026-09-20',
						billing_cycle: 'contract',
					},
					{
						id: ITEM_B,
						key: ITEM_B,
						product_id: PRODUCT,
						currency: 'CLP',
						product_name: 'Implementación',
						item_type: 'Servicios',
						quantity: 1,
						// Modo anual: vuelve el precio anual y el modo, sin unitario mensual.
						annual_unit_price: 6000,
						price_entry_mode: 'annual',
						discount_value: 0,
						billing_frequency: 'Mensual',
						billing_method: 'Anticipado',
						start_date: '2026-10-01',
						term_months: 1,
						is_recurring: false,
						auto_renew: false,
						billing_cycle: 'contract',
					},
				],
				scheduled_changes: [],
			});
			// Lo que devuelve pasa la validación del body de editar tal cual.
			expect(
				flattenValidationErrors(
					await validate(plainToInstance(UpdateContractDto, result.form), { whitelist: true, forbidNonWhitelisted: true })
				)
			).toEqual([]);
		});

		it('un ítem sin término vuelve con term_months null (y las marcas guardadas como booleanos)', async () => {
			const { service } = build(
				draftHandler({ requires_references_for_billing: true }, (sql) =>
					sql.includes('FROM contract_items ci') && sql.includes('ORDER BY ci.start_date NULLS LAST')
						? [{ ...storedItems[0], term_months: null }]
						: undefined
				)
			);
			const result = await service.form('contract-1', 'h-1');

			expect(result.form.requires_references_for_billing).toBe(true);
			expect(result.form.items[0].term_months).toBeNull();
			expect(
				flattenValidationErrors(
					await validate(plainToInstance(UpdateContractDto, result.form), { whitelist: true, forbidNonWhitelisted: true })
				)
			).toEqual([]);
		});

		it('409 si no es borrador; 404 si no es del holding', async () => {
			expect(await conflictOf(build(draftHandler({ status: 'Activo' })).service.form('contract-1', 'h-1'))).toBe(
				'Solo se edita un contrato en borrador; CTR-2026-001 está Activo'
			);
			const { service, contracts } = build(draftHandler());

			(contracts.resolveContract as jest.Mock).mockRejectedValueOnce(new NotFoundException('Contrato no encontrado'));
			await expect(service.form('contract-x', 'h-1')).rejects.toBeInstanceOf(NotFoundException);
		});
	});

	describe('invoicePreview (GET :id/invoices/preview)', () => {
		it('arma el formulario del borrador guardado y delega en la misma vista previa que POST /contracts/preview', async () => {
			const { service } = build(draftHandler());
			const engine = { invoices: [], warnings: [] };
			const previewSpy = jest.spyOn(service, 'preview').mockResolvedValue(engine as never);
			const formSpy = jest.spyOn(service, 'form');

			const result = await service.invoicePreview('CTR-2026-001', 'h-1');

			expect(result).toBe(engine);
			expect(formSpy).toHaveBeenCalledWith('contract-1', 'h-1');
			const { form } = await formSpy.mock.results[0].value;

			// Además del formulario: plantilla de glosa, número y consumos registrados del borrador (mismo insumo que la activación).
			expect(previewSpy).toHaveBeenCalledWith(
				form,
				'h-1',
				expect.objectContaining({ contract_number: 'CTR-2026-001', description_template: null, consumption: expect.any(Map) })
			);
			expect(form).toMatchObject({ contract_currency: 'CLP', invoice_currency: 'USD', fx_invoice_policy: 'fixed' });
			expect(form.items).toHaveLength(2);
		});

		it('lee la plantilla de glosa y los consumos del borrador; el motor recibe plantilla, contexto, límite y consumos', async () => {
			const template = { blocks: [{ type: 'text', text: 'Servicio' }, { type: 'contract_number' }] };
			const { service } = build(
				draftHandler({}, (sql) => {
					if (sql.includes('SELECT invoice_description_template FROM contracts')) return [{ invoice_description_template: template }];
					if (sql.includes('FROM consumption_entries e'))
						return [
							{
								contract_item_id: ITEM_A,
								period_start: '2026-10-01',
								quantity: '7',
								amount_override: null,
								apply_item_discount: true,
								is_estimated: false,
							},
						];
					if (sql.includes('AS own_description_max_chars')) return [{ description_limits: [], own_description_max_chars: 30 }];

					return undefined;
				})
			);
			const previewSpy = jest.spyOn(service, 'preview');
			const result = await service.invoicePreview('contract-1', 'h-1');
			const extras = previewSpy.mock.calls[0][2]!;

			expect(extras.consumption!.get(ITEM_A)).toEqual([
				{ period_start: '2026-10-01', quantity: 7, amount_override: null, apply_item_discount: true, is_estimated: false },
			]);
			expect(extras.description_template).toMatchObject({ blocks: [{ type: 'text', text: 'Servicio' }, { type: 'contract_number' }] });
			// Glosa con la plantilla del contrato (texto + número) y ajustada al límite del documento (30).
			const descriptions = result.invoices.flatMap((invoice) => invoice.lines.map((line) => line.description));

			expect(descriptions.length).toBeGreaterThan(0);
			expect(descriptions.every((text) => text.startsWith('Servicio') && text.length <= 30)).toBe(true);
			expect(descriptions[0]).toContain('CTR-2026-001');
			// engineInput: mismos campos que la activación.
			const input = ContractDraftsService.engineInput(
				baseDto({ contract_number: 'CTR-X' } as never),
				{
					company: {
						id: COMPANY,
						legal_name: 'Simplit SpA',
						country: 'Chile',
						currency: 'CLP',
						contract_prefix: 'CTR-',
						tax_rate: 19,
						fx_company_policy: 'monthly_avg',
					},
					entity: { id: ENTITY, legal_name: 'ACME SpA', country: 'Chile', payment_terms: null },
					client: { id: CLIENT, name: 'ACME' },
					products: new Map(),
					tax_document_types: [],
					tax_document_type: null,
					billable_metrics: new Map(),
					catalog_prices: new Map(),
				} as never,
				ContractDraftsService.resolveItems(baseDto(), new Map()),
				{
					description_max_chars: 40,
					consumption: new Map([
						['k1', [{ period_start: '2026-10-01', quantity: 3, amount_override: null, apply_item_discount: true, is_estimated: false }]],
					]),
				}
			);

			expect(input.contract).toMatchObject({
				description_max_chars: 40,
				description_template: null,
				description_context: { contract_number: 'CTR-X', client_name: 'ACME SpA' },
			});
			expect(input.items[0].consumption).toHaveLength(1);
		});

		it('409 { code: not_draft } si el contrato no es borrador, sin calcular nada', async () => {
			const { service } = build(draftHandler({ status: 'Activo' }));
			const previewSpy = jest.spyOn(service, 'preview');
			const error = await service.invoicePreview('contract-1', 'h-1').catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			expect((error as HttpException).getResponse()).toMatchObject({ code: 'not_draft' });
			expect(previewSpy).not.toHaveBeenCalled();
		});
	});

	describe('update', () => {
		const [itemA] = baseDto().items;
		const updateDto = (overrides: Partial<UpdateContractDto> = {}): UpdateContractDto =>
			({
				...baseDto(),
				// El formulario devuelve el día de ciclo guardado (1); sin él sería "automático" (NULL).
				billing_anchor_day: 1,
				notes: 'Nota nueva',
				items: [
					{ ...itemA, id: ITEM_A, key: ITEM_A, quantity: 3 },
					{
						key: 'nuevo',
						product_id: PRODUCT,
						item_type: 'Soporte',
						quantity: 1,
						unit_price: 50,
						billing_frequency: 'Mensual',
						billing_method: 'Vencido',
						start_date: '2026-11-01',
						term_months: 6,
					},
				],
				...overrides,
			}) as UpdateContractDto;

		it('reemplaza encabezado, ítems (actualiza, crea, elimina) y tasas en una transacción, y deja DRAFT_UPDATED con el resumen', async () => {
			const { service, runner, contracts } = build(draftHandler());
			const result = await service.update(
				'contract-1',
				updateDto({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 0.0011 }] }),
				'h-1',
				'auth-1',
				NOW
			);

			expect(result).toEqual({ id: 'contract-new', contract_number: 'CTR-2026-007' });
			expect(contracts.detail).toHaveBeenCalledWith('contract-1', 'h-1');
			expect(runner.commitTransaction).toHaveBeenCalled();
			expect(runner.rollbackTransaction).not.toHaveBeenCalled();

			// Encabezado bloqueado y actualizado sin tocar número, cotización ni fecha de creación.
			expect(calls(runner.query, 'c.created_at, c.client_id')[0][0]).toContain('FOR UPDATE OF c');
			const [[headerSql, headerParams]] = calls(runner.query, 'UPDATE contracts SET');

			expect(headerSql).not.toMatch(/contract_number\s*=/);
			expect(headerSql).not.toMatch(/quote_id\s*=/);
			expect(headerSql).not.toMatch(/created_at\s*=/);
			expect(headerParams.slice(0, 2)).toEqual(['contract-1', 'h-1']);
			// total = 3 × 100 × 12 × 0,9 + 1 × 50 × 6 = 3240 + 300; notas nuevas; documento del catálogo conservado (33 → FACTURA).
			expect(headerParams[5]).toBe(3540);
			expect(headerParams[8]).toBe('Nota nueva');
			expect(headerParams.slice(27, 31)).toEqual(['FACTURA', TDT_33, true, false]);
			// Misma moneda de contrato: no se apaga la validación de moneda.
			expect(calls(runner.query, 'skip_currency_validation')).toHaveLength(0);

			// Ítem A actualizado (cantidad 3), el nuevo insertado, B eliminado.
			const [[updateSql, updateParams]] = calls(runner.query, 'UPDATE contract_items SET');

			// Costura: marca primero; el UPDATE del ítem escribe los precios derivados (3 × 100 × 0,9 = 270 mensual) y el plazo del
			// contrato se refresca después de crear y quitar ítems.
			expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
			expect(updateSql).toContain('annual_price = $29, monthly_price = $30, billing_period_price = $31');
			expect(updateParams.slice(28, 31)).toEqual([3600, 270, 270]);
			expect(runner.query.mock.calls.findIndex(([sql]) => (sql as string).includes('UPDATE contracts c SET term'))).toBeGreaterThan(
				runner.query.mock.calls.findIndex(([sql]) => (sql as string).includes('DELETE FROM contract_items'))
			);

			// La categoría se recalcula con el cliente y el producto guardados (sin contar borradores borrados).
			expect(updateSql).toContain(`categoria = ${itemCategoriaSql(2, 4, 20)}`);
			expect(updateParams.slice(0, 3)).toEqual([ITEM_A, 'contract-1', 'h-1']);
			expect(updateParams).toHaveLength(32);
			expect(updateParams).toEqual(expect.arrayContaining([PRODUCT, 'Licencia Pro', 3, 100, 'Porcentaje', 10, 3600, 3240, 'CLP']));
			const [[, insertParams]] = calls(runner.query, 'INSERT INTO contract_items');

			expect(insertParams.slice(0, 2)).toEqual(['contract-1', 'h-1']);
			expect(insertParams).toEqual(expect.arrayContaining(['Soporte', 50, 'Vencido', '2026-11-01', 6]));
			expect(calls(runner.query, 'DELETE FROM contract_items')[0][1]).toEqual(['contract-1', 'h-1', [ITEM_B]]);
			// Antes de quitar B se verifica que no tenga cantidades registradas.
			expect(calls(runner.query, 'FROM quantities WHERE contract_item_id')[0][1]).toEqual([[ITEM_B]]);

			// Tasas: se reemplazan las guardadas por las del formulario.
			expect(calls(runner.query, 'DELETE FROM contract_fx_period_rates')[0][1]).toEqual(['contract-1', 'h-1']);
			expect(calls(runner.query, 'INSERT INTO contract_fx_period_rates').map(([, params]) => params)).toEqual([
				['contract-1', 'h-1', 'invoice', 'CLP', 'USD', 0.0011, '2026-10-01', '2027-09-30', 'Cargada al editar el borrador (v2)', 'user-1'],
			]);

			const [[eventSql, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

			expect(eventSql).toContain(`'DRAFT_UPDATED'`);
			expect(eventParams[3]).toBe(
				'Borrador CTR-2026-001 editado (campos: notes, total_value; 1 ítem(s) nuevo(s); 1 ítem(s) actualizado(s); 1 ítem(s) quitado(s))'
			);
			expect(JSON.parse(eventParams[6] as string)).toEqual([ITEM_A, 'item-1', ITEM_B]);
			expect(JSON.parse(eventParams[7] as string)).toMatchObject({
				source: 'api_v2',
				contract_number: 'CTR-2026-001',
				changed_fields: ['notes', 'total_value'],
				before: { notes: 'Nota original', total_value: 2160 },
				after: { notes: 'Nota nueva', total_value: 3540 },
				items: { updated: [ITEM_A], inserted: ['item-1'], deleted: [ITEM_B] },
				// Diff de tasas e ítems (antes/después).
				fx_rates_diff: { changed: true, after: [{ purpose: 'invoice', rate: 0.0011, period_start: '2026-10-01', period_end: '2027-09-30' }] },
				items_diff: expect.arrayContaining([
					expect.objectContaining({ item_id: ITEM_A, after: expect.objectContaining({ quantity: 3 }) }),
					expect.objectContaining({ item_id: 'item-1', before: null }),
					expect.objectContaining({ item_id: ITEM_B, after: null }),
				]),
			});
			// Antes de quitar B también se mira `consumption_entries` (409 item_has_consumption si tiene).
			expect(calls(runner.query, 'FROM consumption_entries WHERE contract_item_id')[0][1]).toEqual([[ITEM_B], 'h-1']);
			// Nunca escribe facturas ni cronograma.
			expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
			expect(calls(runner.query, 'contract_invoices')).toHaveLength(0);
		});

		it('null explícito borra booking_date y la oportunidad; sin día de ciclo se guarda NULL (automático)', async () => {
			const { service, runner } = build(draftHandler({ salesforce_opportunity_id: 'OPP-1' }));

			await service.update(
				'contract-1',
				updateDto({ booking_date: null, salesforce_opportunity_id: null, billing_anchor_day: undefined }),
				'h-1',
				'auth-1',
				NOW
			);
			const [[, params]] = calls(runner.query, 'UPDATE contracts SET');

			expect(params[9]).toBeNull();
			expect(params[23]).toBeNull();
			expect(params[25]).toBeNull();
			const metadata = JSON.parse(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][7] as string);

			expect(metadata.changed_fields).toEqual(expect.arrayContaining(['booking_date', 'salesforce_opportunity_id', 'billing_anchor_day']));
			// Ausente conserva lo guardado.
			const kept = build(draftHandler({ salesforce_opportunity_id: 'OPP-1' }));

			await kept.service.update('contract-1', updateDto(), 'h-1', 'auth-1', NOW);
			expect(calls(kept.runner.query, 'UPDATE contracts SET')[0][1].slice(9, 10)).toEqual(['2026-09-20']);
			expect(calls(kept.runner.query, 'UPDATE contracts SET')[0][1][23]).toBe('OPP-1');
		});

		it('quitar un ítem con consumo registrado → 409 item_has_consumption y rollback', async () => {
			const { service, runner } = build(
				draftHandler({}, (sql) => (sql.includes('FROM consumption_entries WHERE contract_item_id') ? [{ count: '2' }] : undefined))
			);
			const error = await service.update('contract-1', updateDto(), 'h-1', 'auth-1', NOW).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			expect((error as ConflictException).getResponse()).toMatchObject({ code: 'item_has_consumption' });
			expect(calls(runner.query, 'UPDATE contracts SET')).toHaveLength(0);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('mismo modelo de precio pero otra moneda u otro producto → versión nueva del precio', async () => {
			const price = { model: 'seat' as const, quantity_type: 'fixed' as const, unit_amount: 2, seat_minimum_quantity: 1 };
			const stored = (extra: Record<string, unknown>) =>
				draftHandler({}, (sql) =>
					sql.includes('INSERT INTO prices')
						? [{ id: 'price-2' }]
						: sql.includes('SELECT ci.id, ci.product_id, ci.quote_item_id')
							? [
									{
										id: ITEM_A,
										product_id: PRODUCT,
										quote_item_id: null,
										price_id: 'price-1',
										price_version: 1,
										price_model: 'seat',
										price_quantity_type: 'fixed',
										price_unit_amount: '2',
										price_free_units: '0',
										price_seat_minimum_quantity: '1',
										price_invoice_line_mode: 'single',
										price_currency: 'CLP',
										price_product_id: PRODUCT,
										...extra,
									},
								]
							: undefined
				);
			const dto = updateDto({ items: [{ ...itemA, id: ITEM_A, key: ITEM_A, price }] });
			const same = build(stored({}));

			await same.service.update('contract-1', dto, 'h-1', 'auth-1', NOW);
			expect(calls(same.runner.query, 'INSERT INTO prices')).toHaveLength(0);
			const otherCurrency = build(stored({ price_currency: 'USD' }));

			await otherCurrency.service.update('contract-1', dto, 'h-1', 'auth-1', NOW);
			expect(calls(otherCurrency.runner.query, 'INSERT INTO prices')).toHaveLength(1);
			const otherProduct = build(stored({ price_product_id: 'otro-producto' }));

			await otherProduct.service.update('contract-1', dto, 'h-1', 'auth-1', NOW);
			expect(calls(otherProduct.runner.query, 'INSERT INTO prices')).toHaveLength(1);
		});

		it('cambio de moneda: apaga la validación de moneda solo en la transacción (los ítems se reescriben en la moneda nueva)', async () => {
			const { service, runner } = build(draftHandler());

			await service.update(
				'contract-1',
				updateDto({ contract_currency: 'USD', invoice_currency: 'USD', fx_company_policy: 'company_default' }),
				'h-1',
				'auth-1',
				NOW
			);
			const statements = runner.query.mock.calls.map(([sql]) => sql as string);
			const guard = statements.findIndex((sql) => sql.includes(`set_config('sapira.skip_currency_validation', 'on', true)`));

			expect(guard).toBeGreaterThan(-1);
			expect(guard).toBeLessThan(statements.findIndex((sql) => sql.includes('UPDATE contracts SET')));
			expect(calls(runner.query, 'UPDATE contract_items SET')[0][1]).toContain('USD');
			expect(calls(runner.query, 'INSERT INTO contract_items')[0][1]).toContain('USD');
		});

		it('409 si no es borrador o ya tiene facturas; 400 si cambian el número o la cotización, o un ítem es ajeno', async () => {
			expect(await conflictOf(build(draftHandler({ status: 'Activo' })).service.update('contract-1', updateDto(), 'h-1', 'auth-1', NOW))).toBe(
				'Solo se edita un contrato en borrador; CTR-2026-001 está Activo'
			);
			expect(
				await conflictOf(build(draftHandler({ invoices_count: '2' })).service.update('contract-1', updateDto(), 'h-1', 'auth-1', NOW))
			).toBe('El borrador CTR-2026-001 ya tiene facturas: no se puede editar como formulario');
			expect(
				await errorsOf(
					build(draftHandler()).service.update(
						'contract-1',
						updateDto({ contract_number: 'OTRO-1', quote_id: QUOTE }),
						'h-1',
						'auth-1',
						NOW
					)
				)
			).toEqual([
				{ field: 'contract_number', message: 'El número de contrato no se cambia al editar el borrador' },
				{ field: 'quote_id', message: 'La cotización de origen no se cambia al editar el borrador' },
			]);
			const foreign = build(draftHandler());

			expect(
				await errorsOf(
					foreign.service.update(
						'contract-1',
						updateDto({
							items: [
								{ ...itemA, key: 'x', id: QUOTE_ITEM },
								{ ...itemA, key: 'a', id: ITEM_A },
								{ ...itemA, key: 'b', id: ITEM_A },
							],
						}),
						'h-1',
						'auth-1',
						NOW
					)
				)
			).toEqual([
				{ field: 'items.0.id', message: 'El ítem no pertenece a este borrador' },
				{ field: 'items.2.id', message: 'Ítem repetido' },
			]);
			expect(calls(foreign.runner.query, 'UPDATE contracts SET')).toHaveLength(0);
			expect(foreign.runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('no quita ítems con cantidades registradas (409 y rollback) y aplica las validaciones de crear', async () => {
			const { service, runner } = build(
				draftHandler({}, (sql) => (sql.includes('FROM quantities WHERE contract_item_id') ? [{ count: '3' }] : undefined))
			);

			expect(await conflictOf(service.update('contract-1', updateDto(), 'h-1', 'auth-1', NOW))).toBe(
				'No se pueden quitar ítems que ya tienen cantidades registradas: déjalos en el borrador'
			);
			expect(calls(runner.query, 'UPDATE contracts SET')).toHaveLength(0);
			expect(runner.rollbackTransaction).toHaveBeenCalled();

			// Reglas FX de crear: tasa fija sin conversión → 400 por campo.
			expect(
				await errorsOf(
					build(draftHandler()).service.update(
						'contract-1',
						updateDto({ fx_invoice_policy: 'fixed', fx_invoice_rates: [{ rate: 1 }] }),
						'h-1',
						'auth-1',
						NOW
					)
				)
			).toEqual([{ field: 'fx_invoice_policy', message: 'Se factura en la moneda del contrato: no lleva tipo de cambio fijo' }]);
		});
	});

	describe('updateTerms', () => {
		const termsHandler =
			(row: Record<string, unknown>): Handler =>
			(sql) =>
				sql.includes('SELECT id, contract_number, status, invoice_terms_and_conditions FROM contracts') ? [row] : undefined;
		const active = { id: 'contract-1', contract_number: 'CTR-2026-001', status: 'Activo', invoice_terms_and_conditions: 'Viejo' };

		it('actualiza las condiciones de un contrato activo (o borrador) y deja TERMS_UPDATED con antes/después', async () => {
			const { service, runner } = build(termsHandler(active));
			const result = await service.updateTerms('CTR-2026-001', { invoice_terms_and_conditions: 'Pago a 30 días' }, 'h-1', 'auth-1');

			expect(result).toEqual({
				id: 'contract-1',
				contract_number: 'CTR-2026-001',
				invoice_terms_and_conditions: 'Pago a 30 días',
				changed: true,
				pending_invoices_updated: false,
			});
			expect(calls(runner.query, 'UPDATE contracts SET invoice_terms_and_conditions')[0][1]).toEqual(['contract-1', 'h-1', 'Pago a 30 días']);
			const [[eventSql, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

			expect(eventSql).toContain(`'TERMS_UPDATED'`);
			expect(eventParams[3]).toBe('user-1');
			expect(JSON.parse(eventParams[4] as string)).toEqual({
				source: 'api_v2',
				contract_number: 'CTR-2026-001',
				before: 'Viejo',
				after: 'Pago a 30 días',
				pending_invoices_updated: false,
			});
			expect(runner.commitTransaction).toHaveBeenCalled();
		});

		it('null (o texto vacío) borra las condiciones; sin cambio no escribe ni deja evento', async () => {
			const cleared = build(termsHandler(active));

			expect(await cleared.service.updateTerms('contract-1', { invoice_terms_and_conditions: '  ' }, 'h-1', 'auth-1')).toMatchObject({
				invoice_terms_and_conditions: null,
				changed: true,
			});
			expect(calls(cleared.runner.query, 'UPDATE contracts SET invoice_terms_and_conditions')[0][1][2]).toBeNull();

			const same = build(termsHandler(active));

			expect(await same.service.updateTerms('contract-1', { invoice_terms_and_conditions: 'Viejo' }, 'h-1', 'auth-1')).toMatchObject({
				changed: false,
			});
			expect(calls(same.runner.query, 'UPDATE contracts')).toHaveLength(0);
			expect(calls(same.runner.query, 'INSERT INTO contract_lifecycle_events')).toHaveLength(0);
		});

		it('si la costura (setApiWriter) falla: rollback y conexión liberada (la costura va dentro del try)', async () => {
			const failing = build((sql) => {
				if (sql.includes('sapira.writer')) throw new Error('costura caída');

				return termsHandler(active)(sql, []);
			});

			await expect(failing.service.updateTerms('contract-1', { invoice_terms_and_conditions: 'x' }, 'h-1', 'auth-1')).rejects.toThrow(
				'costura caída'
			);
			expect(failing.runner.rollbackTransaction).toHaveBeenCalledTimes(1);
			expect(failing.runner.release).toHaveBeenCalled();
		});

		it('409 si el contrato está cancelado; 404 si no es del holding', async () => {
			const cancelled = build(termsHandler({ ...active, status: 'Cancelado' }));

			expect(await conflictOf(cancelled.service.updateTerms('contract-1', { invoice_terms_and_conditions: 'x' }, 'h-1', 'auth-1'))).toBe(
				'El contrato CTR-2026-001 está cancelado: sus condiciones de factura ya no se editan'
			);
			expect(cancelled.runner.rollbackTransaction).toHaveBeenCalled();

			const missing = build(termsHandler(active));

			(missing.contracts.resolveContract as jest.Mock).mockRejectedValueOnce(new NotFoundException('Contrato no encontrado'));
			await expect(missing.service.updateTerms('contract-x', { invoice_terms_and_conditions: 'x' }, 'h-1', 'auth-1')).rejects.toBeInstanceOf(
				NotFoundException
			);
		});
	});
});

describe('fieldErrorsOf (lo que GlobalExceptionFilter reenvía)', () => {
	it('expone errors[{ field, message }] de una HttpException', () => {
		expect(fieldErrorsOf(new BadRequestException({ message: 'x', errors: [{ field: 'a', message: 'b' }] }))).toEqual([
			{ field: 'a', message: 'b' },
		]);
		expect(fieldErrorsOf(new BadRequestException('x'))).toBeNull();
		expect(fieldErrorsOf(new Error('x'))).toBeNull();
	});
});

describe('ContractsController (escritura)', () => {
	const drafts = {
		formOptions: jest.fn().mockResolvedValue({}),
		fromQuote: jest.fn().mockResolvedValue({}),
		preview: jest.fn().mockResolvedValue({}),
		create: jest.fn().mockResolvedValue({}),
		remove: jest.fn().mockResolvedValue({}),
		bulkRemove: jest.fn().mockResolvedValue({}),
		form: jest.fn().mockResolvedValue({}),
		invoicePreview: jest.fn().mockResolvedValue({}),
		update: jest.fn().mockResolvedValue({}),
		updateTerms: jest.fn().mockResolvedValue({}),
	} as unknown as ContractDraftsService;
	const controller = new ContractsController(
		{} as ContractsService,
		drafts,
		{} as ContractSubscriptionsService,
		{} as Contract360Service,
		{} as ContractBulkService,
		{} as ContractActivationService,
		{} as ConsumptionService,
		{} as ContractChangesService,
		{} as ContractInvoicesService,
		{} as ContractInvoiceDescriptionsService,

		{} as ContractInvoiceEditService,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);

	it('las rutas nuevas heredan SupabaseAuthGuard + HoldingScopeGuard del controlador', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.preview)).toBe(200);
	});

	it('pasa el holding del guard y el usuario autenticado', async () => {
		const dto = baseDto();

		const updateDto = { ...dto, items: dto.items } as UpdateContractDto;
		const terms = { invoice_terms_and_conditions: 'x' };

		await controller.formOptions({ client_entity_id: ENTITY }, 'h-1');
		await controller.fromQuote(QUOTE, 'h-1');
		await controller.preview(dto, 'h-1');
		await controller.create(dto, 'h-1', { user: { sub: 'auth-1' } });
		await controller.remove('c-1', 'h-1', { user: { sub: 'auth-1' } });
		await controller.bulkDelete({ ids: ['c-1', 'c-2'] }, 'h-1', { user: { sub: 'auth-1' } });
		await controller.form('c-1', 'h-1');
		await controller.invoicePreview('c-1', 'h-1');
		await controller.update('c-1', updateDto, 'h-1', { user: { sub: 'auth-1' } });
		await controller.updateTerms('c-1', terms, 'h-1', { user: { sub: 'auth-1' } });

		expect(drafts.formOptions).toHaveBeenCalledWith('h-1', expect.any(Date), { clientEntityId: ENTITY });
		expect(drafts.fromQuote).toHaveBeenCalledWith(QUOTE, 'h-1');
		expect(drafts.preview).toHaveBeenCalledWith(dto, 'h-1');
		expect(drafts.create).toHaveBeenCalledWith(dto, 'h-1', 'auth-1');
		expect(drafts.remove).toHaveBeenCalledWith('c-1', 'h-1', 'auth-1');
		expect(drafts.bulkRemove).toHaveBeenCalledWith(['c-1', 'c-2'], 'h-1', 'auth-1');
		expect(drafts.form).toHaveBeenCalledWith('c-1', 'h-1');
		expect(drafts.invoicePreview).toHaveBeenCalledWith('c-1', 'h-1');
		expect(drafts.update).toHaveBeenCalledWith('c-1', updateDto, 'h-1', 'auth-1');
		expect(drafts.updateTerms).toHaveBeenCalledWith('c-1', terms, 'h-1', 'auth-1');
	});
});

describe('ContractDraftsService · bloque B2 (ciclo propio §9.3.9 y pactos al crear §9.3.6)', () => {
	const ownItem = (overrides: Record<string, unknown> = {}) => ({
		key: 'k2',
		product_id: PRODUCT,
		item_type: 'Licencias',
		quantity: 1,
		unit_price: 300,
		billing_frequency: 'Mensual' as const,
		billing_method: 'Anticipado' as const,
		start_date: '2026-10-15',
		term_months: 3,
		is_recurring: true,
		billing_cycle: 'own' as const,
		...overrides,
	});

	it('billing_cycle own: el ítem guarda billing_anchor_day = día de inicio y la vista previa lo factura en su día sin tramo prorrateado', async () => {
		const { service, runner } = build();
		const dto = baseDto({ items: [...baseDto().items, ownItem()] });
		const preview = await service.preview(dto, 'h-1');
		const own = preview.invoices.filter((invoice) => invoice.lines.some((line) => line.item_key === 'k2'));

		expect(own.map((invoice) => [invoice.issue_date, invoice.subtotal])).toEqual([
			['2026-10-15', 300],
			['2026-11-15', 300],
			['2026-12-15', 300],
		]);
		await service.create(dto, 'h-1', 'auth-1', NOW);
		const items = calls(runner.query, 'INSERT INTO contract_items');

		expect(items[0][0]).toContain('billing_period_price, billing_anchor_day, custom_fields, categoria');
		expect(items[0][1][30]).toBeNull();
		expect(items[1][1][30]).toBe(15);
		// Categoría a nivel cliente con el inicio del ítem como fecha (§9.1 #9).
		expect(items[0][0]).toContain('$19::date');
		expect(ownCycleAnchor({ billing_cycle: 'own', start_date: '2026-10-31' })).toBe(31);
		expect(ownCycleAnchor({ billing_cycle: 'own', start_date: '2026-10-31', is_recurring: false })).toBeNull();
	});

	it('scheduled_changes[]: se insertan con el id del ítem resuelto por item_key; item_key ajeno → 400 sin escribir', async () => {
		const { service, runner } = build((sql) => (sql.includes('INSERT INTO contract_scheduled_changes') ? [{ id: 'pact-1' }] : undefined));

		await service.create(
			baseDto({
				scheduled_changes: [
					{ item_key: 'k1', trigger: 'on_renewal', kind: 'percent_uplift', value: 5 },
					{
						trigger: 'every_n_months',
						anchor_date: '2027-10-01',
						interval_months: 12,
						kind: 'index',
						value: 0,
						index_code: 'IPC',
						index_base_value: 120,
					},
				],
			}),
			'h-1',
			'auth-1',
			NOW
		);
		const pacts = calls(runner.query, 'INSERT INTO contract_scheduled_changes');

		expect(pacts.map(([, params]) => [params[2], params[4], params[8], params[9]])).toEqual([
			['item-1', 'on_renewal', null, 'percent_uplift'],
			[null, 'every_n_months', '2027-10-01', 'index'],
		]);
		const bad = build();

		await expect(
			bad.service.create(
				baseDto({ scheduled_changes: [{ item_key: 'otro', trigger: 'on_renewal', kind: 'quantity', value: 3 }] }),
				'h-1',
				'auth-1',
				NOW
			)
		).rejects.toMatchObject({ response: { errors: [expect.objectContaining({ field: 'scheduled_changes.0.contract_item_id' })] } });
		expect(calls(bad.runner.query, 'INSERT INTO contracts')).toHaveLength(0);
	});
});
