import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import {
	cleanPaymentTerms,
	ContractDraftsService,
	contractPrefix,
	correlativePattern,
	DEFAULT_PAYMENT_TERMS_PRESETS,
	formatContractNumber,
	MISSING_SOFT_DELETE_MESSAGE,
	parsePaymentTermsText,
} from './contract-drafts.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { CreateContractDto } from './dtos/create-contract.dto';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const COMPANY = '33333333-3333-4333-8333-333333333333';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const QUOTE = '55555555-5555-4555-8555-555555555555';
const QUOTE_ITEM = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-25T15:00:00.000Z');

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
	const contracts = { detail: jest.fn().mockResolvedValue({ id: 'contract-new', contract_number: 'CTR-2026-007' }) } as unknown as ContractsService;

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
			// ... + día de ciclo, condición, tipo de documento y confirmaciones FX (misma moneda en todo: sin confirmar).
			expect(insertParams.slice(-5)).toEqual([1, JSON.stringify({ kind: 'net', days: 45 }), 'FACTURA', false, false]);
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
				if (sql.includes('FROM quotes WHERE id'))
					return [{ id: QUOTE, quote_number: 'Q-1', quote_type: 'NewBusiness', booking_date: '2026-09-20', requires_multicurrency: true }];
				if (sql.includes('FROM quote_items WHERE id = ANY'))
					return [{ id: QUOTE_ITEM, quote_item_number: 'QL-9', custom_fields: { po: '123' } }];
				// El trigger heredó `true` de la cotización aunque la usuaria mandó `false`.
				if (sql.includes('INSERT INTO contract_items')) return [{ id: 'item-1', auto_renew: true }];

				return undefined;
			});
			const dto = baseDto({ quote_id: QUOTE });

			dto.items[0].quote_item_id = QUOTE_ITEM;
			dto.items[0].auto_renew = false;

			await service.create(dto, 'h-1', 'auth-1', NOW);

			expect(calls(runner.query, 'FROM quotes WHERE id')[0][0]).toContain('FOR UPDATE');
			const [[, itemParams]] = calls(runner.query, 'INSERT INTO contract_items');

			expect(itemParams).toEqual(expect.arrayContaining([QUOTE_ITEM, 'QL-9', JSON.stringify({ po: '123' }), '2026-09-20']));
			expect(calls(runner.query, 'UPDATE contract_items SET auto_renew')).toEqual([[expect.any(String), ['item-1', false]]]);
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
			expect(sql).toContain('CASE WHEN $37::boolean THEN now() END');
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
			expect(result.totals).toEqual({ contract_value: 2160, invoiced_total: 2160, difference: 0 });
			expect((dataSource.query as jest.Mock).mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql as string))).toBe(false);
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

			expect(result.quote).toMatchObject({
				id: QUOTE,
				quote_number: 'Q-1',
				payment_terms: '30 días',
				payment_terms_parsed: { kind: 'net', days: 30 },
			});
			expect(result.client).toEqual({ id: CLIENT, name: 'ACME' });
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
				}),
				expect.objectContaining({ id: 'co-2', legal_name: 'SimpliRoute', tax_rate: null, next_number: 'CTR-2026-012' }),
			]);
			expect(result.currencies).toEqual(['CLP', 'USD']);
			expect(result.item_types).toEqual(['Licencias']);
			expect(result.payment_terms_presets).toEqual(DEFAULT_PAYMENT_TERMS_PRESETS);
			expect(result.document_types.map((option) => option.value)).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
			expect(result.products).toEqual([
				expect.objectContaining({ id: PRODUCT, name: 'Licencia', item_type: 'Licencias', unit_of_measure: 'UN', is_recurring: true }),
			]);
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
			expect(selectSql).toContain("(to_jsonb(c)->>'deleted_at') IS NULL");
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
			// Una tasa sin fechas cubre el contrato: primer inicio → último fin de los ítems.
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

		expect(companySql).toContain(`COALESCE(to_jsonb(companies)->>'fx_company_policy', 'monthly_avg')`);
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

	it('tipo de cambio: política obligatoria con moneda de factura distinta, tasas ≥ 1 con fijo, tasa > 0 y políticas válidas', async () => {
		const fields = async (overrides: Record<string, unknown>) =>
			(await check({ ...baseDto(), ...overrides })).map((error) => `${error.field}: ${error.message}`);

		expect(await fields({ invoice_currency: 'usd' })).toEqual(['fx_invoice_policy: Elige el tipo de cambio de facturación: del día o fijo']);
		expect(await fields({ invoice_currency: 'CLP' })).toEqual([]);
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed' })).toEqual([
			'fx_invoice_rates: Agrega la tasa fija de facturación',
		]);
		expect(await fields({ invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [] })).toEqual([
			'fx_invoice_rates: Agrega la tasa fija de facturación',
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

	it('valida la forma de la condición de pago', async () => {
		const errors = await check({ ...baseDto(), payment_terms: { kind: 'day_of_next_month', day: 40 } });

		expect(errors.map((error) => error.field)).toContain('payment_terms.day');
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
	} as unknown as ContractDraftsService;
	const controller = new ContractsController(
		{} as ContractsService,
		drafts,
		{} as ContractSubscriptionsService,
		{} as Contract360Service,
		{} as ContractBulkService,
		{} as ContractActivationService
	);

	it('las rutas nuevas heredan SupabaseAuthGuard + HoldingScopeGuard del controlador', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.preview)).toBe(200);
	});

	it('pasa el holding del guard y el usuario autenticado', async () => {
		const dto = baseDto();

		await controller.formOptions('h-1');
		await controller.fromQuote(QUOTE, 'h-1');
		await controller.preview(dto, 'h-1');
		await controller.create(dto, 'h-1', { user: { sub: 'auth-1' } });
		await controller.remove('c-1', 'h-1', { user: { sub: 'auth-1' } });
		await controller.bulkDelete({ ids: ['c-1', 'c-2'] }, 'h-1', { user: { sub: 'auth-1' } });

		expect(drafts.formOptions).toHaveBeenCalledWith('h-1');
		expect(drafts.fromQuote).toHaveBeenCalledWith(QUOTE, 'h-1');
		expect(drafts.preview).toHaveBeenCalledWith(dto, 'h-1');
		expect(drafts.create).toHaveBeenCalledWith(dto, 'h-1', 'auth-1');
		expect(drafts.remove).toHaveBeenCalledWith('c-1', 'h-1', 'auth-1');
		expect(drafts.bulkRemove).toHaveBeenCalledWith(['c-1', 'c-2'], 'h-1', 'auth-1');
	});
});
