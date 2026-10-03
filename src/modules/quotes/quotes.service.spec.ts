import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors } from '@/core/utils/validation-errors';
import type { PaymentTerms } from '@/databases/postgresql/entities/clientes/client-entity.entity';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { type ContractDraftsService, parsePaymentTermsText } from '@/modules/contracts/contract-drafts.service';

import { CreateQuoteDto, UpdateQuoteDto } from './dtos/create-quote.dto';
import { QuoteStageTransitionDto } from './dtos/quote-stage.dto';
import { QuoteListService } from './quote-list.service';
import { QuotesController, QuoteStagesController } from './quotes.controller';
import { paymentTermsText, QuotesService } from './quotes.service';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const CLIENT = '11111111-1111-4111-8111-111111111111';
const CONTACT = '12121212-1212-4121-8121-121212121212';
const PRODUCT = '44444444-4444-4444-8444-444444444444';
const QUOTE = '55555555-5555-4555-8555-555555555555';
const ITEM_A = '77777777-7777-4777-8777-777777777777';
const ITEM_B = '88888888-8888-4888-8888-888888888888';
const S_DRAFT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const S_SENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const S_SIGNED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-09-28T15:00:00.000Z');

const quoteRow = (overrides: Row = {}): Row => ({
	id: QUOTE,
	quote_number: 'COT-2026-0003',
	quote_type: 'upsell',
	currency: 'USD',
	total_amount: '2160',
	kind: 'sent',
	derived_status: 'sent',
	stage_id: S_SENT,
	stage_name: 'Enviada',
	quote_stage_id: S_SENT,
	client_id: CLIENT,
	client_name: 'ACME',
	items_count: '1',
	mrr: '180',
	quote_date: '2026-09-01',
	valid_until: '2026-10-01',
	booking_date: null,
	contract_id: null,
	applied_contract_id: null,
	created_at: new Date('2026-09-01T10:00:00.000Z'),
	...overrides,
});

const itemRow = (overrides: Row = {}): Row => ({
	id: ITEM_A,
	product_id: PRODUCT,
	product_name: 'Licencia Pro',
	item_type: 'Licencias',
	quantity: '2',
	unit_price: '100',
	price_entry_mode: 'monthly',
	discount_type: 'Porcentaje',
	discount_value: '10',
	price: '2400',
	final_price: '2160',
	monthly_price: '180',
	billing_period_price: '180',
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	start_date: '2026-10-01',
	end_date: '2027-09-30',
	term_months: 12,
	is_recurring: true,
	auto_renew: false,
	currency: 'USD',
	custom_fields: {},
	item_price_id: null,
	...overrides,
});

const baseDto = (overrides: Partial<CreateQuoteDto> = {}): CreateQuoteDto =>
	({
		client_id: CLIENT,
		quote_type: 'upsell',
		currency: 'USD',
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
	}) as CreateQuoteDto;

const defaults: Array<[string, unknown[]]> = [
	['FROM users WHERE auth_id', [{ id: 'user-1' }]],
	['FROM clients WHERE id = $1 AND holding_id', [{ id: CLIENT, name_commercial: 'ACME', country: 'Chile' }]],
	['FROM client_contacts WHERE id', [{ id: CONTACT, client_id: CLIENT }]],
	['FROM products WHERE id = ANY', [{ id: PRODUCT, name: 'Licencia Pro' }]],
	[`kind = 'draft' ORDER BY position`, [{ id: S_DRAFT, name: 'Borrador' }]],
	['SELECT ce.payment_terms FROM client_entities', [{ payment_terms: { kind: 'net', days: 45 } }]],
	['regexp_match(quote_number', [{ next: 7 }]],
	['INSERT INTO quotes', [{ id: 'quote-new' }]],
	['INSERT INTO quote_items', [{ id: 'item-new' }]],
	['INSERT INTO prices', [{ id: 'price-new' }]],
	['INSERT INTO quote_events', [{ id: 'event-1' }]],
	['WHERE q.id = $3 AND q.holding_id = $1', [quoteRow()]],
	['lk.contract_id AS linked_contract_id', [itemRow()]],
	['SELECT COUNT(*) AS entities', [{ entities: 1 }]],
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
	const contractDrafts = {
		create: jest.fn().mockResolvedValue({ id: 'contract-new', contract_number: 'CTR-2026-007' }),
	} as unknown as ContractDraftsService;
	const service = new QuotesService(dataSource, new QuoteListService(dataSource), contractDrafts);

	return { service, runner, dataSource, contractDrafts };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const rejects = (promise: Promise<unknown>, code: string) =>
	expect(promise).rejects.toMatchObject({ constructor: ConflictException, response: { code } });

describe('helpers', () => {
	it('texto de la condición de pago para el front viejo y SF', () => {
		expect(paymentTermsText({ kind: 'net', days: 30 })).toBe('30 días');
		expect(paymentTermsText({ kind: 'net', days: 0 })).toBe('Contado');
		expect(paymentTermsText({ kind: 'end_of_month', days: 0 })).toBe('Fin de mes');
		expect(paymentTermsText({ kind: 'day_of_next_month', day: 5 })).toBe('Día 5 del mes siguiente');
		expect(paymentTermsText(null)).toBeNull();
	});

	it('round-trip formulario → texto → formulario: todo lo que emite paymentTermsText lo reconoce parsePaymentTermsText', () => {
		const forms: PaymentTerms[] = [
			{ kind: 'net', days: 0 },
			{ kind: 'net', days: 30 },
			{ kind: 'net', days: 365 },
			{ kind: 'end_of_month', days: 0 },
			{ kind: 'end_of_month', days: 15 },
			{ kind: 'day_of_next_month', day: 1 },
			{ kind: 'day_of_next_month', day: 5 },
			{ kind: 'day_of_next_month', day: 31 },
		];

		for (const form of forms) expect(parsePaymentTermsText(paymentTermsText(form))).toEqual(form);
	});

	it('resolvePaymentTerms: la estructurada manda y se guarda su texto canónico; solo texto → se interpreta y canoniza; null = sin condición', () => {
		const defaults: PaymentTerms = { kind: 'net', days: 45 };

		expect(QuotesService.resolvePaymentTerms({}, defaults)).toEqual({ terms: defaults, termsText: '45 días' });
		expect(QuotesService.resolvePaymentTerms({ payment_terms: null }, defaults)).toEqual({ terms: null, termsText: null });
		expect(
			QuotesService.resolvePaymentTerms({ payment_terms: { kind: 'end_of_month', days: 10 }, payment_terms_text: 'lo que sea' }, defaults)
		).toEqual({ terms: { kind: 'end_of_month', days: 10 }, termsText: 'Fin de mes + 10' });
		expect(QuotesService.resolvePaymentTerms({ payment_terms_text: ' neto 60 ' }, defaults)).toEqual({
			terms: { kind: 'net', days: 60 },
			termsText: '60 días',
		});
		expect(QuotesService.resolvePaymentTerms({ payment_terms_text: 'dia 5 del mes siguiente' }, null)).toEqual({
			terms: { kind: 'day_of_next_month', day: 5 },
			termsText: 'Día 5 del mes siguiente',
		});
	});

	it('texto de condición de pago no interpretable → 400 con errors[payment_terms_text] (no se guarda nada que no vuelva a la forma)', async () => {
		expect(() => QuotesService.resolvePaymentTerms({ payment_terms_text: 'Según OC' }, null)).toThrow(BadRequestException);
		const { service, runner } = build();

		await expect(service.create(baseDto({ payment_terms_text: 'Según OC' }), 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			constructor: BadRequestException,
			response: { errors: [{ field: 'payment_terms_text', message: expect.stringContaining('no se interpreta') }] },
		});
		expect(calls(runner.query, 'INSERT INTO quotes')).toHaveLength(0);
	});
});

describe('QuotesService.create', () => {
	it('una transacción: correlativo con lock, encabezado en la etapa draft con condición de pago por defecto, ítems y evento CREATED', async () => {
		const { service, runner } = build();

		const result = await service.create(baseDto(), 'h-1', 'auth-1', NOW);

		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		expect(runner.release).toHaveBeenCalled();
		expect(calls(runner.query, 'pg_advisory_xact_lock')[0][1]).toEqual(['quotes:h-1:COT:2026']);
		expect(calls(runner.query, 'regexp_match(quote_number')[0][1]).toEqual(['h-1', '^COT-2026-(\\d{1,12})$']);
		const [[insertSql, insertParams]] = calls(runner.query, 'INSERT INTO quotes') as Array<[string, unknown[]]>;

		// Nada derivado se guarda: ni json de la condición, ni actor (va en el evento), ni `updated_at` (trigger).
		for (const column of ['payment_terms_json', 'created_by', 'updated_by', 'updated_at']) expect(insertSql).not.toContain(column);
		expect(insertParams.slice(0, 7)).toEqual(['h-1', CLIENT, null, null, S_DRAFT, 'COT-2026-0007', 'upsell']);
		// Fecha = hoy, válida hasta = +30 días, total = 2 × 100 × 12 × 0,9, condición de pago = texto canónico de la de la razón social.
		expect(insertParams.slice(7, 13)).toEqual(['2026-09-28', '2026-10-28', null, 'USD', 2160, '45 días']);
		expect(insertParams).toHaveLength(19);
		expect(insertParams[18]).toBeNull();
		const [[itemSql, itemParams]] = calls(runner.query, 'INSERT INTO quote_items') as Array<[string, unknown[]]>;

		expect(itemSql).toContain(`'manual'`);
		expect(itemParams).toEqual(
			expect.arrayContaining([
				'quote-new',
				'h-1',
				PRODUCT,
				'Licencia Pro',
				'Licencias',
				2,
				100,
				1200,
				'Porcentaje',
				10,
				2400,
				2160,
				180,
				180,
				'USD',
				'2026-10-01',
				'2027-09-30',
			])
		);
		expect(calls(runner.query, 'INSERT INTO prices')).toHaveLength(0);
		const [[eventSql, eventParams]] = calls(runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(eventSql).toContain('INSERT INTO quote_events');
		expect(eventParams.slice(0, 7)).toEqual(['h-1', 'quote-new', 'CREATED', null, S_DRAFT, null, 'draft']);
		expect(JSON.parse(eventParams[9] as string)).toMatchObject({
			source: 'api_v2',
			quote_number: 'COT-2026-0007',
			total_amount: 2160,
			items: ['item-new'],
		});
		expect(result).toMatchObject({ id: QUOTE, status: 'sent' });
	});

	it('con PriceSpec por tramos guarda el precio con owner quote y apunta el ítem; con price_id copia el catálogo (list_price_id)', async () => {
		const CATALOG = '99999999-9999-4999-8999-999999999999';
		const { service, runner } = build((sql) =>
			sql.includes("owner = 'catalog'")
				? [
						{
							id: CATALOG,
							product_id: PRODUCT,
							name: 'Tramos LatAm',
							currency: 'USD',
							status: 'active',
							version: 2,
							model: 'graduated',
							quantity_type: 'fixed',
							tiers: [{ from: 1, to: null, per_unit_amount: 2, flat_amount: 0 }],
						},
					]
				: undefined
		);
		const dto = baseDto({
			items: [
				{
					...baseDto().items[0],
					key: 'inline',
					unit_price: undefined,
					price: { model: 'graduated', quantity_type: 'fixed', tiers: [{ from: 1, to: null, per_unit_amount: 1 }] },
				},
				{ ...baseDto().items[0], key: 'catalog', unit_price: undefined, price_id: CATALOG },
			] as CreateQuoteDto['items'],
		});

		await service.create(dto, 'h-1', 'auth-1', NOW);
		const prices = calls(runner.query, 'INSERT INTO prices') as Array<[string, unknown[]]>;

		expect(prices).toHaveLength(2);
		expect(prices[0][0]).toContain(`$1, 'quote', $2, $3`);
		expect(prices[0][1].slice(0, 7)).toEqual(['h-1', PRODUCT, 'quote-new', 'Licencia Pro', 'USD', 'graduated', 'fixed']);
		expect(prices[0][1][18]).toBeNull();
		expect(prices[1][1][3]).toBe('Tramos LatAm');
		expect(prices[1][1][18]).toBe(CATALOG);
		expect(calls(runner.query, 'UPDATE quote_items SET price_id')).toHaveLength(2);
	});

	it('price_id de catálogo en otra moneda → 400 con las mismas reglas que Contratos (catalog-prices.ts)', async () => {
		const CATALOG = '99999999-9999-4999-8999-999999999999';
		const { service } = build((sql) =>
			sql.includes("owner = 'catalog'")
				? [
						{
							id: CATALOG,
							product_id: PRODUCT,
							name: 'Tramos',
							currency: 'CLP',
							status: 'active',
							version: 1,
							model: 'standard',
							quantity_type: 'fixed',
							unit_amount: 10,
						},
					]
				: undefined
		);
		const dto = baseDto({ items: [{ ...baseDto().items[0], unit_price: undefined, price_id: CATALOG }] as CreateQuoteDto['items'] });

		await expect(service.create(dto, 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			response: { errors: [{ field: 'items.0.price_id', message: expect.stringContaining('en CLP y el contrato en USD') }] },
		});
	});

	it('409 sin etapa draft en el holding, 409 con número manual repetido y 400 con producto ajeno (con rollback)', async () => {
		const noDraft = build((sql) => (sql.includes(`kind = 'draft' ORDER BY position`) ? [] : undefined));

		await rejects(noDraft.service.create(baseDto(), 'h-1', 'auth-1', NOW), 'stage_kind_missing');
		expect(noDraft.runner.rollbackTransaction).toHaveBeenCalled();
		const manualMode: Handler = (sql) => (sql.includes('to_jsonb(hs)') ? [{ settings: { quote_numbering_mode: 'manual' } }] : undefined);
		const taken = build(
			(sql, params) =>
				manualMode(sql, params) ??
				(sql.includes('SELECT 1 FROM quotes WHERE holding_id = $1 AND quote_number') ? [{ '?column?': 1 }] : undefined)
		);

		await rejects(taken.service.create(baseDto({ quote_number: 'Q-9' }), 'h-1', 'auth-1', NOW), 'quote_number_taken');
		const foreign = build((sql) => (sql.includes('FROM products WHERE id = ANY') ? [] : undefined));

		await expect(foreign.service.create(baseDto(), 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			constructor: BadRequestException,
			response: { errors: [{ field: 'items.0.product_id', message: 'El producto no existe en el catálogo del holding' }] },
		});
		expect(calls(foreign.runner.query, 'INSERT INTO quotes')).toHaveLength(0);
	});
});

describe('QuotesService.create · numeración del holding (Configuración ronda 4)', () => {
	const withSettings =
		(settings: Record<string, unknown>, extra: Handler = () => undefined): Handler =>
		(sql, params) =>
			sql.includes('to_jsonb(hs)') ? [{ settings }] : extra(sql, params);

	it('manual: el número es obligatorio (400) y se guarda tal cual, único en el holding', async () => {
		const manual = build(withSettings({ quote_numbering_mode: 'manual' }));

		await expect(manual.service.create(baseDto(), 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			constructor: BadRequestException,
			response: { errors: [{ field: 'quote_number', message: 'Escribe el número de la cotización (el holding usa numeración manual)' }] },
		});
		expect(manual.runner.rollbackTransaction).toHaveBeenCalled();
		const ok = build(withSettings({ quote_numbering_mode: 'manual' }));

		await ok.service.create(baseDto({ quote_number: 'ACME-OCT-1' }), 'h-1', 'auth-1', NOW);
		const [[, params]] = calls(ok.runner.query, 'INSERT INTO quotes') as Array<[string, unknown[]]>;

		expect(params).toContain('ACME-OCT-1');
		expect(calls(ok.runner.query, 'pg_advisory_xact_lock')[0][1]).toEqual(['quotes:h-1:number:ACME-OCT-1']);
	});

	it('automáticos: un número escrito a mano → 400; con prefijo sin año y ancho 5; solo correlativo', async () => {
		const auto = build();

		await expect(auto.service.create(baseDto({ quote_number: 'Q-9' }), 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			constructor: BadRequestException,
			response: { errors: [{ field: 'quote_number', message: 'Este holding numera las cotizaciones automáticamente: no escribas el número' }] },
		});
		const prefixed = build(
			withSettings(
				{ quote_numbering_mode: 'prefixed', quote_number_prefix: 'PROP', quote_number_include_year: false, quote_number_width: 5 },
				(sql) => (sql.includes('regexp_match(quote_number') ? [{ next: 42 }] : undefined)
			)
		);

		await prefixed.service.create(baseDto(), 'h-1', 'auth-1', NOW);
		expect(calls(prefixed.runner.query, 'regexp_match(quote_number')[0][1]).toEqual(['h-1', '^PROP-(\\d{1,12})$']);
		expect((calls(prefixed.runner.query, 'INSERT INTO quotes') as Array<[string, unknown[]]>)[0][1]).toContain('PROP-00042');
		const sequential = build(
			withSettings({ quote_numbering_mode: 'sequential', quote_number_width: 3 }, (sql) =>
				sql.includes('regexp_match(quote_number') ? [{ next: 7 }] : undefined
			)
		);

		await sequential.service.create(baseDto(), 'h-1', 'auth-1', NOW);
		expect(calls(sequential.runner.query, 'pg_advisory_xact_lock')[0][1]).toEqual(['quotes:h-1:sequential']);
		expect((calls(sequential.runner.query, 'INSERT INTO quotes') as Array<[string, unknown[]]>)[0][1]).toContain('007');
	});
});

describe('QuotesService.update', () => {
	const existingItems = [
		{ id: ITEM_A, price_id: null, price_version: null, linked_contract_number: null },
		{ id: ITEM_B, price_id: 'price-b', price_version: 1, linked_contract_number: null },
	];
	const updateDto = (): UpdateQuoteDto =>
		({
			...baseDto({ quote_type: 'new_business', notes: 'editada' }),
			items: [
				{ ...baseDto().items[0], id: ITEM_A, quantity: 3 },
				{ ...baseDto().items[0], key: 'nuevo', product_name: 'Soporte' },
			],
		}) as UpdateQuoteDto;

	it('con id actualiza (mismo id), sin id inserta, ausentes elimina; recalcula el total y deja UPDATED con el detalle', async () => {
		const { service, runner } = build((sql) => (sql.includes('p.version AS price_version') ? existingItems : undefined));

		await service.update(QUOTE, updateDto(), 'h-1', 'auth-1', NOW);
		expect(calls(runner.query, 'FOR UPDATE OF q')).toHaveLength(1);
		const updates = calls(runner.query, 'UPDATE quote_items SET') as Array<[string, unknown[]]>;

		expect(updates).toHaveLength(1);
		expect(updates[0][1].slice(0, 2)).toEqual([ITEM_A, 'h-1']);
		expect(updates[0][1]).toEqual(expect.arrayContaining([3, 3600, 3240]));
		expect(calls(runner.query, 'INSERT INTO quote_items')).toHaveLength(1);
		expect(calls(runner.query, 'DELETE FROM quote_items')[0][1]).toEqual([[ITEM_B], QUOTE, 'h-1']);
		// El precio del ítem eliminado se archiva; nunca se borra y se recrea un ítem existente.
		expect(calls(runner.query, `SET status = 'archived'`)[0][1]).toEqual([['price-b'], 'h-1', 'user-1']);
		const [[headerSql, headerParams]] = calls(runner.query, 'UPDATE quotes SET') as Array<[string, unknown[]]>;

		expect(headerSql).not.toContain('quote_number');
		expect(headerSql).not.toContain('quote_stage_id');
		expect(headerParams.slice(0, 3)).toEqual([QUOTE, 'h-1', CLIENT]);
		expect(headerParams[5]).toBe('new_business');
		// 3 × 100 × 12 × 0,9 + 2 × 100 × 12 × 0,9
		expect(headerParams[10]).toBe(5400);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(eventParams[2]).toBe('UPDATED');
		expect(JSON.parse(eventParams[9] as string)).toMatchObject({
			items: { updated: [ITEM_A], inserted: ['item-new'], deleted: [ITEM_B] },
			total_amount: { from: 2160, to: 5400 },
		});
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('409 item_linked_to_contract si un ítem a quitar ya está en un contrato (rollback, sin DELETE)', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('p.version AS price_version')
				? [existingItems[0], { ...existingItems[1], linked_contract_number: 'CTR-2026-050' }]
				: undefined
		);

		await expect(service.update(QUOTE, updateDto(), 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			response: { code: 'item_linked_to_contract', item_id: ITEM_B, message: expect.stringContaining('CTR-2026-050') },
		});
		expect(calls(runner.query, 'DELETE FROM quote_items')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	const locked = (row: Row) =>
		build((sql) =>
			sql.includes('WHERE q.id = $3 AND q.holding_id = $1')
				? [quoteRow(row)]
				: sql.includes('p.version AS price_version')
					? existingItems
					: undefined
		);

	it('firmada o perdida: 409 edit_requires_confirmation sin el flag; con contrato o en Contrato creado 409 quote_has_contract; 400 con ítem ajeno', async () => {
		await rejects(
			locked({ kind: 'signed', derived_status: 'signed' }).service.update(QUOTE, updateDto(), 'h-1', 'auth-1', NOW),
			'edit_requires_confirmation'
		);
		await rejects(
			locked({ kind: 'lost', derived_status: 'lost' }).service.update(QUOTE, updateDto(), 'h-1', 'auth-1', NOW),
			'edit_requires_confirmation'
		);
		await rejects(
			locked({ contract_id: 'c-1', contract_number: 'CTR-1', derived_status: 'contract_created' }).service.update(
				QUOTE,
				{ ...updateDto(), confirm_edit_after_signature: true },
				'h-1',
				'auth-1',
				NOW
			),
			'quote_has_contract'
		);
		await rejects(
			locked({ kind: 'contract_created', derived_status: 'contract_created' }).service.update(
				QUOTE,
				{ ...updateDto(), confirm_edit_after_signature: true },
				'h-1',
				'auth-1',
				NOW
			),
			'quote_has_contract'
		);
		const foreign = build((sql) => (sql.includes('p.version AS price_version') ? [existingItems[0]] : undefined));
		const dto = updateDto();

		dto.items[1].id = ITEM_B;
		await expect(foreign.service.update(QUOTE, dto, 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			response: { errors: [{ field: 'items.1.id', message: 'El ítem no pertenece a la cotización' }] },
		});
	});

	it('firmada con confirm_edit_after_signature: guarda, no cambia la etapa y deja UPDATED con edited_after_signature y el diff', async () => {
		const stored = [
			{
				...existingItems[0],
				product_id: PRODUCT,
				product_name: 'Licencia Pro',
				quantity: '2',
				unit_price: '100',
				annual_unit_price: '1200',
				price_entry_mode: 'monthly',
				discount_value: '10',
				final_price: '2160',
				start_date: '2026-10-01',
				end_date: '2027-09-30',
				term_months: 12,
				billing_frequency: 'Mensual',
				billing_method: 'Anticipado',
				is_recurring: true,
			},
			{ ...existingItems[1], product_id: PRODUCT, product_name: 'Soporte viejo', quantity: '1', unit_price: '50', final_price: '600' },
		];
		const { service, runner } = build((sql) =>
			sql.includes('WHERE q.id = $3 AND q.holding_id = $1')
				? [quoteRow({ kind: 'signed', derived_status: 'signed', stage_id: S_SIGNED, booking_date: '2026-09-20', quote_type: 'Upselling' })]
				: sql.includes('p.version AS price_version')
					? stored
					: undefined
		);

		await service.update(QUOTE, { ...updateDto(), confirm_edit_after_signature: true }, 'h-1', 'auth-1', NOW);
		expect(calls(runner.query, 'quote_stage_id =')).toHaveLength(0);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;
		const metadata = JSON.parse(eventParams[9] as string);

		expect(eventParams.slice(2, 7)).toEqual(['UPDATED', S_SIGNED, S_SIGNED, 'signed', 'signed']);
		expect(metadata).toMatchObject({ edited_after_signature: true, stage_kind: 'signed' });
		// quote_type: 'Upselling' (SF) normalizado a upsell → cambia a new_business; booking se conserva (no aparece).
		expect(metadata.changes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: 'quote_type', before: 'upsell', after: 'new_business' }),
				expect.objectContaining({ field: 'notes', before: null, after: 'editada' }),
				expect.objectContaining({ field: 'total_amount', before: 2160, after: 5400 }),
			])
		);
		expect(metadata.changes.map((change: { field: string }) => change.field)).not.toContain('booking_date');
		expect(metadata.item_changes).toEqual([
			{
				action: 'changed',
				item_id: ITEM_A,
				product_name: 'Licencia Pro',
				changes: [
					expect.objectContaining({ field: 'quantity', label: 'Cantidad', before: 2, after: 3 }),
					expect.objectContaining({ field: 'final_price', before: 2160, after: 3240 }),
				],
			},
			expect.objectContaining({ action: 'added', item_id: 'item-new', product_name: 'Soporte' }),
			expect.objectContaining({
				action: 'removed',
				item_id: ITEM_B,
				product_name: 'Soporte viejo',
				changes: expect.arrayContaining([expect.objectContaining({ field: 'quantity', before: 1, after: null })]),
			}),
		]);
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('toda edición (también en borrador) deja el diff; sin cambios en firmada no marca edited_after_signature fuera de signed/lost', async () => {
		const { service, runner } = build((sql) => (sql.includes('p.version AS price_version') ? existingItems : undefined));

		await service.update(QUOTE, updateDto(), 'h-1', 'auth-1', NOW);
		const metadata = JSON.parse(calls(runner.query, 'INSERT INTO quote_events')[0][1][9] as string);

		expect(metadata.edited_after_signature).toBeUndefined();
		expect(Array.isArray(metadata.changes)).toBe(true);
		expect(metadata.item_changes.map((change: { action: string }) => change.action)).toEqual(['changed', 'added', 'removed']);
	});
});

describe('QuotesService.transition', () => {
	const stages: Record<string, Row> = {
		[S_DRAFT]: { id: S_DRAFT, name: 'Borrador', kind: 'draft' },
		[S_SENT]: { id: S_SENT, name: 'Enviada', kind: 'sent' },
		[S_SIGNED]: { id: S_SIGNED, name: 'Firmada', kind: 'signed' },
		S_CC: { id: 'S_CC', name: 'Contrato creado', kind: 'contract_created' },
	};
	const withStages =
		(quote: Row = {}, items: Row[] = [itemRow()]): Handler =>
		(sql, params) => {
			if (sql.includes('WHERE q.id = $3 AND q.holding_id = $1')) return [quoteRow(quote)];
			if (sql.includes('FROM quote_stages WHERE holding_id = $1 AND id = $2'))
				return stages[String(params[1])] ? [stages[String(params[1])]] : [];
			if (sql.includes('FROM quote_stages WHERE holding_id = $1 AND kind = $2'))
				return Object.values(stages).filter((stage) => stage.kind === params[1]);
			if (sql.includes('ORDER BY product_name, id')) return items;

			return undefined;
		};

	it('enviada → firmada con ítems completos y booking: escribe solo etapa y booking (la línea de vida es el evento SIGNED)', async () => {
		const { service, runner } = build(withStages());

		await service.transition(QUOTE, { kind: 'signed', booking_date: '2026-09-20' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		const [[sql, params]] = calls(runner.query, 'UPDATE quotes SET quote_stage_id') as Array<[string, unknown[]]>;

		for (const column of ['signed_at', 'sent_at', 'lost_at', 'updated_by', 'updated_at']) expect(sql).not.toContain(column);
		expect(params).toEqual([QUOTE, 'h-1', S_SIGNED, '2026-09-20']);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(eventParams.slice(2, 7)).toEqual(['SIGNED', S_SENT, S_SIGNED, 'sent', 'signed']);
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('firmada exige booking (409 booking_date_required) e ítems completos (409 items_incomplete con errors[])', async () => {
		const noBooking = build(withStages());

		await rejects(
			noBooking.service.transition(QUOTE, { kind: 'signed' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW),
			'booking_date_required'
		);
		expect(noBooking.runner.rollbackTransaction).toHaveBeenCalled();
		const incomplete = build(withStages({}, [itemRow({ product_id: null, start_date: null })]));

		await expect(
			incomplete.service.transition(QUOTE, { kind: 'signed', booking_date: '2026-09-20' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW)
		).rejects.toMatchObject({
			response: { code: 'items_incomplete', errors: [{ field: 'items.0.product_id' }, { field: 'items.0.start_date' }] },
		});
	});

	it('409 invalid_transition (a o desde Contrato creado), quote_has_contract con vínculo, stage_kind_mismatch sin etapa del kind; 400 perdida sin motivo; 400 etapa ajena', async () => {
		await rejects(
			build(withStages({ kind: 'signed', derived_status: 'signed' })).service.transition(
				QUOTE,
				{ kind: 'contract_created' } as QuoteStageTransitionDto,
				'h-1',
				'auth-1',
				NOW
			),
			'invalid_transition'
		);
		await rejects(
			build(withStages({ kind: 'contract_created', derived_status: 'contract_created' })).service.transition(
				QUOTE,
				{ stage_id: S_DRAFT } as QuoteStageTransitionDto,
				'h-1',
				'auth-1',
				NOW
			),
			'invalid_transition'
		);
		await rejects(
			build(withStages({ contract_id: 'c-1', contract_number: 'CTR-1' })).service.transition(
				QUOTE,
				{ stage_id: S_DRAFT } as QuoteStageTransitionDto,
				'h-1',
				'auth-1',
				NOW
			),
			'quote_has_contract'
		);
		await rejects(
			build(withStages()).service.transition(QUOTE, { kind: 'lost' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW),
			'stage_kind_mismatch'
		);
		await rejects(
			build(withStages()).service.transition(QUOTE, { stage_id: S_SIGNED, kind: 'sent' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW),
			'stage_kind_mismatch'
		);
		const lostStages = build((sql, params) => {
			if (sql.includes('FROM quote_stages WHERE holding_id = $1 AND kind = $2') && params[1] === 'lost')
				return [{ id: 'S_LOST', name: 'Perdida', kind: 'lost' }];

			return withStages()(sql, params);
		});

		await expect(lostStages.service.transition(QUOTE, { kind: 'lost' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW)).rejects.toMatchObject({
			response: { errors: [{ field: 'reason', message: 'Indica el motivo de la pérdida' }] },
		});
		await expect(
			build(withStages()).service.transition(
				QUOTE,
				{ stage_id: '99999999-9999-4999-8999-999999999999' } as QuoteStageTransitionDto,
				'h-1',
				'auth-1',
				NOW
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('mover entre dos etapas draft deja STAGE_CHANGED; volver de firmada a enviada deja REOPENED (signed_at se deriva del estado)', async () => {
		const negotiating = { id: 'S_NEG', name: 'Negociando', kind: 'draft' };
		const { service, runner } = build((sql, params) => {
			if (sql.includes('FROM quote_stages WHERE holding_id = $1 AND id = $2') && params[1] === 'S_NEG') return [negotiating];

			return withStages({ kind: 'draft', derived_status: 'draft', stage_id: S_DRAFT })(sql, params);
		});

		await service.transition(QUOTE, { stage_id: 'S_NEG' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		expect(calls(runner.query, 'INSERT INTO quote_events')[0][1][2]).toBe('STAGE_CHANGED');
		const reopen = build(withStages({ kind: 'signed', derived_status: 'signed', stage_id: S_SIGNED }));

		await reopen.service.transition(QUOTE, { kind: 'sent' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		const [[sql, params]] = calls(reopen.runner.query, 'UPDATE quotes SET quote_stage_id') as Array<[string, unknown[]]>;

		expect(sql).not.toContain('signed_at');
		expect(params).toEqual([QUOTE, 'h-1', S_SENT, null]);
		expect(calls(reopen.runner.query, 'INSERT INTO quote_events')[0][1][2]).toBe('REOPENED');
	});

	it('libre entre etapas (Domi 02-10): firmada → borrador REOPENED conserva booking; perdida → firmada SIGNED usa el booking guardado; perdida → enviada', async () => {
		const signed = build(withStages({ kind: 'signed', derived_status: 'signed', stage_id: S_SIGNED, booking_date: '2026-09-20' }));

		await signed.service.transition(QUOTE, { kind: 'draft' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		expect(calls(signed.runner.query, 'UPDATE quotes SET quote_stage_id')[0][1]).toEqual([QUOTE, 'h-1', S_DRAFT, '2026-09-20']);
		const [[, signedEvent]] = calls(signed.runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(signedEvent.slice(2, 7)).toEqual(['REOPENED', S_SIGNED, S_DRAFT, 'signed', 'draft']);
		expect(signedEvent[7]).toBe('user-1');
		const lost = build(withStages({ kind: 'lost', derived_status: 'lost', stage_id: 'S_LOST_ID', booking_date: '2026-08-01' }));

		await lost.service.transition(QUOTE, { kind: 'signed' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		expect(calls(lost.runner.query, 'UPDATE quotes SET quote_stage_id')[0][1]).toEqual([QUOTE, 'h-1', S_SIGNED, '2026-08-01']);
		expect(calls(lost.runner.query, 'INSERT INTO quote_events')[0][1][2]).toBe('SIGNED');
		const toSent = build(withStages({ kind: 'lost', derived_status: 'lost', stage_id: 'S_LOST_ID' }));

		await toSent.service.transition(QUOTE, { kind: 'sent', booking_date: '2026-10-05' } as QuoteStageTransitionDto, 'h-1', 'auth-1', NOW);
		expect(calls(toSent.runner.query, 'UPDATE quotes SET quote_stage_id')[0][1]).toEqual([QUOTE, 'h-1', S_SENT, '2026-10-05']);
		const [[, sentEvent]] = calls(toSent.runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(sentEvent[2]).toBe('REOPENED');
		expect(JSON.parse(sentEvent[9] as string)).toMatchObject({ booking_date: '2026-10-05', booking_date_before: null });
	});
});

describe('QuotesService.duplicate', () => {
	it('borrador nuevo con correlativo propio, sin Salesforce ni booking, ítems copiados sin id y evento DUPLICATED_FROM', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('WHERE q.id = $3 AND q.holding_id = $1')
				? [
						quoteRow({
							kind: 'signed',
							derived_status: 'signed',
							salesforce_opportunity_id: '006Rv0000abc',
							booking_date: '2026-09-20',
							quote_number: '006Rv0000abc',
						}),
					]
				: undefined
		);

		await service.duplicate(QUOTE, { quote_date: '2026-10-01' }, 'h-1', 'auth-1', NOW);
		expect(calls(runner.query, 'pg_advisory_xact_lock')[0][1]).toEqual(['quotes:h-1:COT:2026']);
		const [[, params]] = calls(runner.query, 'INSERT INTO quotes') as Array<[string, unknown[]]>;

		expect(params[4]).toBe(S_DRAFT);
		expect(params[5]).toBe('COT-2026-0007');
		expect(params.slice(7, 10)).toEqual(['2026-10-01', '2026-10-31', null]);
		expect(params[18]).toBeNull();
		expect(calls(runner.query, 'INSERT INTO quote_items')).toHaveLength(1);
		expect(calls(runner.query, 'UPDATE quote_items SET')).toHaveLength(0);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO quote_events') as Array<[string, unknown[]]>;

		expect(eventParams[2]).toBe('DUPLICATED_FROM');
		expect(JSON.parse(eventParams[9] as string)).toMatchObject({
			source_quote_id: QUOTE,
			source_quote_number: '006Rv0000abc',
			quote_number: 'COT-2026-0007',
		});
	});
});

describe('QuotesService.remove', () => {
	it('borrado lógico en borrador/enviada/perdida sin contrato, con evento DELETED', async () => {
		const { service, runner } = build();

		expect(await service.remove(QUOTE, 'h-1', 'auth-1', NOW)).toEqual({ id: QUOTE, deleted: true });
		const [[sql, params]] = calls(runner.query, 'UPDATE quotes SET deleted_at') as Array<[string, unknown[]]>;

		expect(sql).toContain('deleted_at = now()');
		expect(sql).not.toContain('updated_at');
		expect(params).toEqual([QUOTE, 'h-1']);
		expect(calls(runner.query, 'INSERT INTO quote_events')[0][1][2]).toBe('DELETED');
		expect(calls(runner.query, 'DELETE FROM quotes')).toHaveLength(0);
	});

	it('409 quote_not_deletable en firmada, con contrato o ya en Contrato creado; 404 si no es del holding o está borrada', async () => {
		const withRow = (row: Row) => build((sql) => (sql.includes('WHERE q.id = $3 AND q.holding_id = $1') ? [quoteRow(row)] : undefined));

		await rejects(withRow({ kind: 'signed', derived_status: 'signed' }).service.remove(QUOTE, 'h-1', 'auth-1', NOW), 'quote_not_deletable');
		await rejects(
			withRow({ applied_contract_id: 'c-1', derived_status: 'contract_created' }).service.remove(QUOTE, 'h-1', 'auth-1', NOW),
			'quote_not_deletable'
		);
		const missing = build((sql) => (sql.includes('WHERE q.id = $3 AND q.holding_id = $1') ? [] : undefined));

		await expect(missing.service.remove(QUOTE, 'h-9', 'auth-1', NOW)).rejects.toBeInstanceOf(NotFoundException);
		expect(missing.runner.rollbackTransaction).toHaveBeenCalled();
	});
});

describe('QuotesService.createContract (costura con Contratos)', () => {
	const body = { client_id: CLIENT, client_entity_id: 'e-1', company_id: 'co-1', contract_currency: 'USD', items: [] } as never;

	it('firmada sin contrato: delega en ContractDraftsService.create con quote_id fijo y devuelve el contrato 360', async () => {
		const { service, contractDrafts } = build((sql) =>
			sql.includes('WHERE q.id = $3 AND q.holding_id = $1') ? [quoteRow({ kind: 'signed', derived_status: 'signed' })] : undefined
		);

		const result = await service.createContract(QUOTE, body, 'h-1', 'auth-1', NOW);

		expect(contractDrafts.create).toHaveBeenCalledWith(expect.objectContaining({ client_id: CLIENT, quote_id: QUOTE }), 'h-1', 'auth-1', NOW);
		expect(result).toEqual({ id: 'contract-new', contract_number: 'CTR-2026-007' });
	});

	it('409 quote_not_signed en enviada y quote_already_applied con contrato; no delega', async () => {
		const sent = build();

		await rejects(sent.service.createContract(QUOTE, body, 'h-1', 'auth-1', NOW), 'quote_not_signed');
		const applied = build((sql) =>
			sql.includes('WHERE q.id = $3 AND q.holding_id = $1')
				? [quoteRow({ kind: 'signed', contract_id: 'c-1', contract_number: 'CTR-1', derived_status: 'contract_created' })]
				: undefined
		);

		await rejects(applied.service.createContract(QUOTE, body, 'h-1', 'auth-1', NOW), 'quote_already_applied');
		expect(sent.contractDrafts.create).not.toHaveBeenCalled();
		expect(applied.contractDrafts.create).not.toHaveBeenCalled();
	});
});

describe('QuotesService.form · permisos de edición (Domi 02-10)', () => {
	const formOf = (row: Row) =>
		build((sql) => (sql.includes('WHERE q.id = $3 AND q.holding_id = $1') ? [quoteRow(row)] : undefined)).service.form(QUOTE, 'h-1', NOW);

	it('se edita en cualquier etapa sin contrato; firmada/perdida piden confirmación; el único bloqueo es quote_has_contract', async () => {
		await expect(formOf({ kind: 'draft', derived_status: 'draft' })).resolves.toMatchObject({
			editable: true,
			edit_blocker: null,
			edit_requires_confirmation: false,
		});
		for (const kind of ['signed', 'lost']) {
			await expect(formOf({ kind, derived_status: kind })).resolves.toMatchObject({
				editable: true,
				edit_blocker: null,
				edit_requires_confirmation: true,
			});
		}
		await expect(formOf({ kind: 'signed', contract_id: 'c-1', contract_number: 'CTR-1' })).resolves.toMatchObject({
			editable: false,
			edit_blocker: 'quote_has_contract',
			edit_requires_confirmation: false,
		});
		await expect(formOf({ kind: 'contract_created', derived_status: 'contract_created' })).resolves.toMatchObject({
			editable: false,
			edit_blocker: 'quote_has_contract',
		});
	});
});

describe('QuotesService.detail', () => {
	it('360: estado mostrado, ítems, totales, vínculos, alertas y permisos calculados', async () => {
		const { service } = build((sql) => {
			if (sql.includes('WHERE q.id = $3 AND q.holding_id = $1'))
				return [quoteRow({ kind: 'signed', derived_status: 'signed', payment_terms: 'Según OC', valid_until: '2026-01-01' })];
			if (sql.includes('lk.contract_id AS linked_contract_id')) return [itemRow({ end_date: '2027-10-01' })];
			if (sql.includes('SELECT COUNT(*) AS entities')) return [{ entities: 0 }];
			if (sql.includes('FROM quote_events e'))
				return [{ id: 'e-1', type: 'SIGNED', from_kind: 'sent', to_kind: 'signed', created_at: NOW, user_id: 'u-1', user_name: 'Domi' }];

			return undefined;
		});
		const detail = await service.detail(QUOTE, 'h-1', NOW);

		expect(detail).toMatchObject({
			status: 'signed',
			status_label: 'Firmada',
			totals: { currency: 'USD', total_amount: 2160, mrr: 180, one_time: 0 },
			links: { contract: null, applied_to: [] },
			can_edit: true,
			edit_requires_confirmation: true,
			can_delete: false,
			can_create_contract: true,
			can_apply_to_contract: true,
		});
		expect(detail.items[0]).toMatchObject({ id: ITEM_A, expected_end_date: '2027-09-30', end_date: '2027-10-01', pricing: null });
		expect(detail.alerts.map((alert) => alert.code)).toEqual([
			'items_end_date_off',
			'payment_terms_unparsed',
			'client_without_entities',
			'signed_without_contract',
		]);
		expect(detail.events[0]).toMatchObject({ type: 'SIGNED', actor: { id: 'u-1', name: 'Domi' } });
	});

	it('datos del documento (PDF): emisor por país del cliente, razón social y contacto del vendedor, solo lectura', async () => {
		const { service, dataSource } = build((sql) => {
			if (sql.includes('WHERE q.id = $3 AND q.holding_id = $1'))
				return [
					quoteRow({
						client_country: 'Chile',
						seller_id: 'seller-1',
						seller_name: 'Ana',
						seller_email: 'ana@sapira.test',
						seller_phone: '+56 9 1111',
						contact_id: CONTACT,
						contact_name: 'Pedro',
						contact_email: 'pedro@acme.test',
					}),
				];
			if (sql.includes('FROM company_holdings h'))
				return [
					{
						holding_name: 'Sapira',
						holding_logo_url: 'https://cdn/logo.png',
						company_id: 'co-1',
						legal_name: 'Sapira SpA',
						tax_id: '76.123.456-7',
						legal_address: 'Av. Siempre Viva 123',
						country: 'Chile',
						email: null,
						tax_rate: '19',
					},
				];
			if (sql.includes('SELECT ce.id, ce.legal_name, ce.tax_id'))
				return [
					{ id: 'ent-1', legal_name: 'ACME Chile SpA', tax_id: '77.777.777-7', country: 'Chile', legal_address: 'Calle 1', email: null },
				];

			return undefined;
		});
		const detail = await service.detail(QUOTE, 'h-1', NOW);

		expect(detail.issuer).toEqual({
			company_id: 'co-1',
			legal_name: 'Sapira SpA',
			trade_name: 'Sapira',
			tax_id: '76.123.456-7',
			address: 'Av. Siempre Viva 123',
			country: 'Chile',
			email: null,
			phone: null,
			website: null,
			logo_url: 'https://cdn/logo.png',
			tax_rate: 19,
		});
		expect(detail.client_entity).toMatchObject({ id: 'ent-1', legal_name: 'ACME Chile SpA', tax_id: '77.777.777-7', address: 'Calle 1' });
		expect(detail.seller).toEqual({ id: 'seller-1', name: 'Ana', email: 'ana@sapira.test', phone: '+56 9 1111' });
		expect(detail.contact).toMatchObject({ id: CONTACT, name: 'Pedro', email: 'pedro@acme.test' });
		const [, params] = calls(dataSource.query as jest.Mock, 'FROM company_holdings h')[0];

		expect(params).toEqual(['h-1', 'Chile']);
	});

	it('sin compañía ni razón social: el emisor cae al holding y la razón social queda en null', async () => {
		const { service } = build((sql) => {
			if (sql.includes('FROM company_holdings h')) return [{ holding_name: 'Sapira', company_id: null }];

			return undefined;
		});
		const detail = await service.detail(QUOTE, 'h-1', NOW);

		expect(detail.issuer).toMatchObject({ company_id: null, legal_name: 'Sapira', tax_id: null, tax_rate: null });
		expect(detail.client_entity).toBeNull();
		expect(detail.seller).toBeNull();
	});
});

describe('DTOs', () => {
	const errorsOf = async (dto: object) => flattenValidationErrors(await validate(dto));

	it('crear: exige cliente, tipo de negocio del catálogo, moneda y al menos un ítem con producto, tipo, cantidad, frecuencia, método, inicio y plazo', async () => {
		const errors = await errorsOf(plainToInstance(CreateQuoteDto, { quote_type: 'Upselling', items: [{}] }));
		const fields = errors.map((error) => error.field);

		expect(fields).toEqual(
			expect.arrayContaining([
				'client_id',
				'quote_type',
				'currency',
				'items.0.product_id',
				'items.0.item_type',
				'items.0.quantity',
				'items.0.unit_price',
				'items.0.billing_frequency',
				'items.0.billing_method',
				'items.0.start_date',
				'items.0.term_months',
			])
		);
	});

	it('el unitario mensual deja de ser obligatorio con precio anual, PriceSpec o price_id; la moneda se normaliza', async () => {
		const dto = plainToInstance(CreateQuoteDto, {
			...baseDto({ currency: ' usd ' }),
			items: [
				{ ...baseDto().items[0], unit_price: undefined, annual_unit_price: 1200, price_entry_mode: 'annual' },
				{
					...baseDto().items[0],
					unit_price: undefined,
					price: { model: 'package', quantity_type: 'fixed', package_size: 10, package_amount: 100 },
				},
				{ ...baseDto().items[0], unit_price: undefined, price_id: PRODUCT },
			],
		});

		expect(await errorsOf(dto)).toEqual([]);
		expect(dto.currency).toBe('USD');
		const update = plainToInstance(UpdateQuoteDto, { ...baseDto(), items: [{ ...baseDto().items[0], id: 'no-uuid' }] });

		expect((await errorsOf(update)).map((error) => error.field)).toEqual(['items.0.id']);
	});

	it('transición: stage_id o kind (al menos uno); kind de la lista', async () => {
		expect((await errorsOf(plainToInstance(QuoteStageTransitionDto, {}))).map((error) => error.field)).toEqual(['stage_id']);
		expect(await errorsOf(plainToInstance(QuoteStageTransitionDto, { kind: 'signed', booking_date: '2026-09-20' }))).toEqual([]);
		expect((await errorsOf(plainToInstance(QuoteStageTransitionDto, { kind: 'won' }))).map((error) => error.field)).toEqual(['kind']);
	});
});

describe('controladores', () => {
	it('heredan SupabaseAuthGuard + HoldingScopeGuard', () => {
		for (const controller of [QuotesController, QuoteStagesController]) {
			expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		}
	});
});
