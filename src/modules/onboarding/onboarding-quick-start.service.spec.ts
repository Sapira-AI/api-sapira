import { DataSource } from 'typeorm';

import type { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { encodeLineKey } from './onboarding-common';
import { OnboardingQuickStartService } from './onboarding-quick-start.service';
import { OnboardingRegisterService } from './onboarding-register.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const PRODUCT = 'p-1';

const last = (overrides: Record<string, unknown> = {}) => ({
	id: 'inv-9',
	client_entity_id: 'ce-1',
	invoice_number: 'BR-9',
	issue_date: '2026-07-10',
	total_invoice_currency: '1100',
	amount_invoice_currency: '1000',
	invoice_currency: 'BRL',
	company_id: 'co-br',
	legal_name: 'Cliente Brasil Ltda',
	client_id: 'cl-1',
	client_name: 'Cliente Brasil',
	already_has_contract: false,
	currencies: '1',
	history_months_found: '3',
	...overrides,
});

function build(handlers: Handler[] = [], drafts: Partial<ContractDraftsService> = {}) {
	const db = fakeDb([
		...handlers,
		['WITH last AS', () => [last()]],
		[
			'FROM invoice_items_legacy WHERE holding_id',
			() => [
				{ invoices_legacy_id: 'inv-9', description: null, product_external_code: null, quantity: '1', unit_price: '1000', subtotal: '1000' },
			],
		],
		['SELECT id, name, product_code FROM products', () => [{ id: PRODUCT, name: 'PATHFINDER+', product_code: 'PF' }]],
		[
			'LEFT JOIN LATERAL',
			() => [
				{
					id: 'inv-9',
					invoice_number: 'BR-9',
					issue_date: '2026-07-10',
					company_id: 'co-br',
					legal_client_name: 'Cliente Brasil Ltda',
					invoice_currency: 'BRL',
					amount_invoice_currency: '1000',
					total_invoice_currency: '1100',
					status: 'Pagada',
					client_id: 'cl-1',
					item_id: 'it-9',
					item_subtotal: '1000',
					has_history: false,
				},
			],
		],
		['SELECT id, name FROM products', () => [{ id: PRODUCT, name: 'PATHFINDER+' }]],
		['FROM currencies', () => [{ code: 'BRL' }, { code: 'USD' }]],
	]);
	const contractDrafts = {
		create: jest.fn().mockResolvedValue({ id: 'ctr-1', contract_number: 'CTR-2026-50' }),
		remove: jest.fn().mockResolvedValue(undefined),
		...drafts,
	} as unknown as ContractDraftsService;
	const register = new OnboardingRegisterService(db as unknown as DataSource);

	return { db, contractDrafts, service: new OnboardingQuickStartService(db as unknown as DataSource, contractDrafts, register) };
}

const proposal = (overrides: Record<string, unknown> = {}) =>
	({
		entity_id: 'ce-1',
		period_from: '2026-07',
		period_to: '2026-07',
		contract_currency: 'BRL',
		amount_contract_currency: 1000,
		products: [{ product_id: PRODUCT, amount_contract_currency: 1000 }],
		...overrides,
	}) as never;

describe('arranque rápido: vista previa', () => {
	it('última factura por razón social con sus líneas; sin descripción no hay producto ni sugerencia (no se inventa)', async () => {
		const { db, service } = build();
		const preview = await service.preview(HOLDING, { as_of: '2026-07', history_months: 3 });

		expect(preview.proposals[0]).toMatchObject({
			entity: { id: 'ce-1' },
			client: { id: 'cl-1' },
			last_invoice: { id: 'inv-9', number: 'BR-9', currency: 'BRL', total: 1100 },
			items: [{ description: null, quantity: 1, unit_price: 1000, product_id: null, product_suggestion: null }],
			contract: { start_date: '2026-08-01', billing_frequency: 'Mensual', billing_method: 'Anticipado' },
			history_months_found: 3,
			flags: ['no_product'],
		});
		// Corte: facturas emitidas antes del primer día del mes siguiente.
		expect(db.statements('WITH last AS')[0].params).toEqual([HOLDING, '2026-08-01', null, 3]);
	});

	it('flags: sin cliente, con contrato y en varias monedas; el código del ERP calza el producto exacto', async () => {
		const { service } = build([
			['WITH last AS', () => [last({ client_id: null, already_has_contract: true, currencies: '2' })]],
			[
				'FROM invoice_items_legacy WHERE holding_id',
				() => [
					{ invoices_legacy_id: 'inv-9', description: 'x', product_external_code: 'PF', quantity: '2', unit_price: null, subtotal: '1000' },
				],
			],
		]);
		const [item] = (await service.preview(HOLDING, { as_of: '2026-07' })).proposals;

		expect(item.flags).toEqual(['no_client', 'already_has_contract', 'multi_currency']);
		expect(item.items[0]).toMatchObject({ product_id: PRODUCT, product_suggestion: { id: PRODUCT }, unit_price: 500 });
	});
});

describe('arranque rápido: tipo de cambio visible (Domi 14-10)', () => {
	it('sin lo completado: monto y moneda de la factura con fx 1 (la propuesta es en la moneda de la factura)', async () => {
		const [item] = (await build().service.preview(HOLDING, { as_of: '2026-07' })).proposals;

		expect(item).toMatchObject({ invoice_currency: 'BRL', amount_invoice_currency: 1000, fx_contract_to_invoice: 1, warnings: [], errors: [] });
	});

	it('con lo completado por la usuaria: fx implícito del registro y aviso fx_one_with_different_currencies (USD ≈ BRL)', async () => {
		const { service } = build();
		const [item] = (
			await service.preview(HOLDING, {
				as_of: '2026-07',
				proposals: [
					proposal({
						contract_currency: 'USD',
						amount_contract_currency: 1000,
						products: [{ product_id: PRODUCT, amount_contract_currency: 1000 }],
					}),
				],
			})
		).proposals;

		expect(item.fx_contract_to_invoice).toBe(1);
		expect(item.warnings).toContain('fx_one_with_different_currencies');
		const [ok] = (
			await service.preview(HOLDING, {
				as_of: '2026-07',
				proposals: [
					proposal({
						contract_currency: 'USD',
						amount_contract_currency: 200,
						products: [{ product_id: PRODUCT, amount_contract_currency: 200 }],
					}),
				],
			})
		).proposals;

		expect(ok).toMatchObject({ fx_contract_to_invoice: 5, warnings: [] });
	});

	it('línea a la que se sumaría (Domi 18-10): solo con lo completado; clave cliente | producto del catálogo | moneda y lines_touched', async () => {
		const empty = await build().service.preview(HOLDING, { as_of: '2026-07' });

		expect(empty.proposals[0]).toMatchObject({ line_key: null, line_exists: false });
		expect(empty.summary.lines_touched).toEqual([]);
		const key = encodeLineKey({ client_id: 'cl-1', product_name: 'PATHFINDER+', contract_currency: 'USD' });
		const filled = await build([
			[
				'SELECT DISTINCT m.client_id, m.product_name, m.contract_currency FROM',
				() => [{ client_id: 'cl-1', product_name: 'PATHFINDER+', contract_currency: 'USD' }],
			],
		]).service.preview(HOLDING, {
			as_of: '2026-07',
			proposals: [
				proposal({
					contract_currency: 'USD',
					amount_contract_currency: 200,
					products: [{ product_id: PRODUCT, amount_contract_currency: 200 }],
				}),
			],
		});

		expect(filled.proposals[0]).toMatchObject({ line_key: key, line_exists: true });
		expect(filled.summary.lines_touched).toEqual([key]);
	});
});

describe('arranque rápido: aplicar', () => {
	it('crea el contrato con el generador común (un ítem por producto, inicio = mes siguiente al período) y registra la última factura empalmada', async () => {
		const { db, contractDrafts, service } = build();
		const result = await service.apply(HOLDING, { as_of: '2026-07', proposals: [proposal()] }, ACTOR);
		const dto = (contractDrafts.create as jest.Mock).mock.calls[0][0];

		expect(result).toEqual({
			created: [{ entity_id: 'ce-1', contract: { id: 'ctr-1', contract_number: 'CTR-2026-50' }, history_rows: 1 }],
			skipped: [],
		});
		expect(dto).toMatchObject({
			client_id: 'cl-1',
			client_entity_id: 'ce-1',
			company_id: 'co-br',
			contract_currency: 'BRL',
			items: [
				{
					product_id: PRODUCT,
					quantity: 1,
					unit_price: 1000,
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					start_date: '2026-08-01',
					term_months: 12,
					is_recurring: true,
					// Viene de algo que ya existía (Domi 14-10).
					category: 'RENEWAL',
				},
			],
		});
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		// Fila del mes de la factura ya empalmada al contrato nuevo.
		expect(insert.params.slice(-2)).toEqual(['ctr-1', 'user-1']);
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[1])).toEqual(['history_registered', 'quick_start_applied']);
	});

	it('anual: unitario = monto mensual del producto (o el que venga) e inicio tras el período cubierto', () => {
		const { service } = build();
		const dto = service.contractDto(
			proposal({
				period_from: '2026-07',
				period_to: '2027-06',
				amount_contract_currency: 12000,
				products: [{ product_id: PRODUCT, amount_contract_currency: 12000, quantity: 4 }],
			}),
			last()
		);

		expect(dto.items[0]).toMatchObject({ quantity: 4, unit_price: 250, start_date: '2027-07-01' });
	});

	it('sin cliente comercial, sin producto o sin factura → skipped con motivo; sin contrato creado', async () => {
		const { contractDrafts, service } = build([['WITH last AS', () => [last({ client_id: null })]]]);
		const noClient = await service.apply(HOLDING, { as_of: '2026-07', proposals: [proposal()] }, ACTOR);
		const noProduct = await build().service.apply(HOLDING, { as_of: '2026-07', proposals: [proposal({ products: [] })] }, ACTOR);
		const noInvoice = await build([['WITH last AS', () => []]]).service.apply(HOLDING, { as_of: '2026-07', proposals: [proposal()] }, ACTOR);

		expect(noClient.skipped).toEqual([expect.objectContaining({ entity_id: 'ce-1', reason: 'no_client' })]);
		expect(noProduct.skipped).toEqual([expect.objectContaining({ reason: 'no_product' })]);
		expect(noInvoice.skipped).toEqual([expect.objectContaining({ reason: 'no_invoice' })]);
		expect(contractDrafts.create).not.toHaveBeenCalled();
	});

	it('si el registro falla después de crear el contrato, el borrador se elimina', async () => {
		const { contractDrafts, service } = build([['INSERT INTO mrr_legacy', () => Promise.reject(new Error('boom'))]]);
		const result = await service.apply(HOLDING, { as_of: '2026-07', proposals: [proposal()] }, ACTOR);

		expect(result.created).toEqual([]);
		expect(result.skipped).toEqual([expect.objectContaining({ reason: 'history_error', message: 'boom' })]);
		expect(contractDrafts.remove).toHaveBeenCalledWith('ctr-1', HOLDING, 'auth-1');
	});
});
