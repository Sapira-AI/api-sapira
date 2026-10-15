import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { OnboardingPreviousInvoicesService } from './onboarding-previous-invoices.service';
import { OnboardingRegisterService } from './onboarding-register.service';

import type { PreviousInvoiceInputDto } from './dtos/onboarding.dto';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const CO_CL = 'co-cl';
const CLIENT = 'cl-1';
const ENTITY = 'ce-1';

const invoice = (overrides: Partial<PreviousInvoiceInputDto> = {}): PreviousInvoiceInputDto =>
	({
		row: 1,
		invoice_number: 'F-100',
		issue_date: '2026-07-01',
		legal_client_name: 'Acme  SpA',
		client_tax_id: '76.123.456-7',
		company_name: 'simplit spa',
		currency: 'CLP',
		amount: 1000,
		total: 1190,
		items: [{ subtotal: 1000 }],
		...overrides,
	}) as PreviousInvoiceInputDto;

const companies: Handler = [
	'SELECT id, legal_name, currency FROM companies',
	() => [
		{ id: CO_CL, legal_name: 'Simplit SpA', currency: 'CLP' },
		{ id: 'co-uy', legal_name: 'SimpliRoute S.A.S', currency: 'UYU' },
		{ id: 'co-co', legal_name: 'SimpliRoute S.A.S', currency: 'COP' },
		{ id: 'co-ar', legal_name: 'SimpliRoute S.A.S', currency: 'ARS' },
	],
];
const countries: Handler = ['SELECT id, country_code FROM companies', () => [{ id: CO_CL, country_code: 'CL' }]];
const existing: Handler = [
	'SELECT invoice_number, odoo_integration_id FROM invoices_legacy',
	() => [{ invoice_number: 'F-OLD', odoo_integration_id: 77 }],
];
const entities: Handler = [
	'FROM client_entities ce LEFT JOIN clients cl',
	() => [
		{ id: ENTITY, legal_name: 'ACME SPA', tax_id: '761234567', client_id: CLIENT, client_name: 'Acme', links: [] },
		{ id: 'ce-loose', legal_name: 'Suelta Ltda', tax_id: null, client_id: null, client_name: null, links: [] },
	],
];
const byRef: Handler = [
	'salesforce_account_id = ANY',
	() => [{ id: 'cl-crm', name_commercial: 'Cliente CRM', salesforce_account_id: '001X', client_number: null }],
];
const candidates: Handler = ['public.similarity', () => [{ wanted: 'Nueva Ltda', id: 'cl-9', name_commercial: 'Nueva', score: '0.8' }]];

function build(handlers: Handler[] = []) {
	const db = fakeDb([
		...handlers,
		companies,
		countries,
		existing,
		entities,
		byRef,
		candidates,
		['INSERT INTO invoices_legacy', () => [{ id: 'inv-new' }]],
	]);

	return { db, service: new OnboardingPreviousInvoicesService(db as unknown as DataSource) };
}

describe('importación de facturas previas: vista previa', () => {
	it('clasifica new, duplicate (base, en el archivo y por id del ERP), error de compañía, needs_entity y needs_client', async () => {
		const { service } = build();
		const preview = await service.previewImport(HOLDING, {
			invoices: [
				invoice(),
				invoice({ row: 2, invoice_number: 'F-OLD' }),
				invoice({ row: 3 }),
				invoice({ row: 4, invoice_number: 'F-200', erp_invoice_id: 77 }),
				invoice({ row: 5, invoice_number: 'F-300', company_name: 'No Existe SA' }),
				invoice({ row: 6, invoice_number: 'F-400', company_name: 'SimpliRoute S.A.S', currency: 'USD' }),
				invoice({ row: 7, invoice_number: 'F-500', legal_client_name: 'Nueva Ltda', client_tax_id: undefined }),
				invoice({ row: 8, invoice_number: 'F-600', legal_client_name: 'Suelta Ltda', client_tax_id: undefined }),
				invoice({ row: 9, invoice_number: 'F-700', legal_client_name: 'Suelta Ltda', client_tax_id: undefined, client_crm_id: '001X' }),
				invoice({ row: 10, invoice_number: 'F-800', company_name: 'SimpliRoute S.A.S', currency: 'UYU' }),
			],
		});
		const status = Object.fromEntries(preview.rows.map((row) => [row.row, row.status]));

		expect(status).toEqual({
			1: 'new',
			2: 'duplicate',
			3: 'duplicate',
			4: 'duplicate',
			5: 'error',
			6: 'error',
			7: 'needs_entity',
			8: 'needs_client',
			9: 'new',
			10: 'new',
		});
		// Razón social por RUT normalizado (puntos y guion fuera) → su cliente comercial.
		expect(preview.rows[0]).toMatchObject({ entity: { id: ENTITY }, client: { id: CLIENT }, company: { id: CO_CL } });
		// Sin cliente en la razón social: el id del CRM de la fila lo resuelve.
		expect(preview.rows[8].client).toEqual({ id: 'cl-crm', name: 'Cliente CRM' });
		expect(preview.rows[5].errors[0]).toContain('varias compañías');
		expect(preview.rows[6].entity_suggestion).toMatchObject({
			legal_name: 'Nueva Ltda',
			country: 'CL',
			client_candidates: [{ id: 'cl-9', score: 0.8 }],
		});
		expect(preview.summary).toMatchObject({ new: 3, duplicate: 3, error: 2, needs_entity: 1, needs_client: 1 });
		expect(preview.missing_entities).toEqual([
			{ legal_name: 'Nueva Ltda', tax_id: null, rows: [7], client_candidates: [{ id: 'cl-9', name: 'Nueva', score: 0.8 }] },
		]);
		expect(preview.missing_companies).toEqual(['No Existe SA', 'SimpliRoute S.A.S']);
	});
});

describe('importación de facturas previas: aplicar', () => {
	it('inserta new y needs_client en un lote, nunca crea clientes comerciales y deja el evento', async () => {
		const { db, service } = build();
		const result = await service.applyImport(
			HOLDING,
			{
				invoices: [
					invoice(),
					invoice({ row: 2, invoice_number: 'F-OLD' }),
					invoice({ row: 3, invoice_number: 'F-600', legal_client_name: 'Suelta Ltda', client_tax_id: undefined }),
				],
			},
			ACTOR
		);

		expect(result).toMatchObject({ inserted: 2, skipped_duplicates: 1, errors: 0, entities_created: 0, needs_client: 1 });
		expect(db.statements('INSERT INTO clients')).toHaveLength(0);
		const [first] = db.statements('INSERT INTO invoices_legacy');

		expect(first.params.slice(0, 4)).toEqual([HOLDING, CO_CL, CLIENT, ENTITY]);
		expect(first.params[19]).toBe(result.batch_id);
		expect(db.statements('INSERT INTO invoice_items_legacy')[0].params).toEqual(['inv-new', HOLDING, null, '', 1, 1000, 0, 'CLP', 1000, 0, 1000]);
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('previous_invoices_imported');
		expect(db.committed()).toBe(1);
	});

	it('create_entities: crea solo razones sociales confirmadas (con cliente existente o sueltas); cliente ajeno → 400', async () => {
		const { db, service } = build([
			['SELECT id FROM clients WHERE holding_id = $1 AND id = ANY', () => [{ id: CLIENT }]],
			['FROM countries', () => [{ code: 'BR', name_es: 'Brasil' }]],
			['INSERT INTO client_entities', () => [{ id: 'ce-new' }]],
		]);

		await service.applyImport(
			HOLDING,
			{
				invoices: [invoice(), invoice({ row: 2, invoice_number: 'F-900', legal_client_name: 'Nueva Ltda', client_tax_id: undefined })],
				create_entities: [
					{ legal_name: 'Nueva Ltda', country: 'BR', client_id: CLIENT },
					{ legal_name: 'Otra Ltda', country: 'BR' },
				],
			},
			ACTOR
		);
		expect(db.statements('INSERT INTO client_entities')).toHaveLength(2);
		expect(db.statements('INSERT INTO clients ')).toHaveLength(0);

		const bad = build([['SELECT id FROM clients WHERE holding_id = $1 AND id = ANY', () => []]]);

		await expect(
			bad.service.applyImport(
				HOLDING,
				{ invoices: [invoice()], create_entities: [{ legal_name: 'X', country: 'BR', client_id: 'cl-ajeno' }] },
				ACTOR
			)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('nada nuevo → 409 nothing_to_import con rollback', async () => {
		const { db, service } = build();

		await expect(service.applyImport(HOLDING, { invoices: [invoice({ invoice_number: 'F-OLD' })] }, ACTOR)).rejects.toMatchObject({
			constructor: ConflictException,
			response: { code: 'nothing_to_import' },
		});
		expect(db.rolledBack()).toBe(1);
	});
});

describe('revertir lote y relacionar cliente', () => {
	const batch = (row: Record<string, unknown>): Handler => [
		'AS imported',
		() => [{ imported: true, reverted: false, with_history: 0, linked: 0, ...row }],
	];

	it('revertir: 404 si el lote no existe, 409 batch_has_history / batch_linked / already_reverted, y borra las facturas del lote', async () => {
		await expect(build([batch({ imported: false })]).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
		await expect(build([batch({ with_history: 2 })]).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'batch_has_history' },
		});
		await expect(build([batch({ linked: 1 })]).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'batch_linked' },
		});
		await expect(build([batch({ reverted: true })]).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'already_reverted' },
		});
		const { db, service } = build([batch({}), ['DELETE FROM invoices_legacy', () => [{ id: 'a' }, { id: 'b' }]]]);

		await expect(service.revertImport(HOLDING, 'b-1', ACTOR)).resolves.toEqual({ batch_id: 'b-1', removed: 2 });
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('previous_invoices_reverted');
	});

	it('relacionar cliente: vincula la razón social (principal si no tenía) y completa el cliente de sus facturas', async () => {
		const { db, service } = build([
			['FOR UPDATE OF il', () => [{ id: 'inv-1', client_entity_id: 'ce-loose', entity_client_id: null }]],
			['SELECT id FROM clients WHERE id = $1', () => [{ id: CLIENT }]],
			['SET client_id = $3', () => [{ id: 'inv-1' }, { id: 'inv-2' }]],
		]);

		await service.assignClient(HOLDING, 'inv-1', { client_id: CLIENT }, ACTOR).catch(() => undefined);
		expect(db.statements('INSERT INTO client_entity_clients')[0].params).toEqual(['ce-loose', CLIENT, HOLDING, true]);
		expect(JSON.parse(String(db.statements('INSERT INTO onboarding_events')[0].params[5]))).toMatchObject({ invoices_updated: 2 });

		const noEntity = build([['FOR UPDATE OF il', () => [{ id: 'inv-1', client_entity_id: null }]]]);

		await expect(noEntity.service.assignClient(HOLDING, 'inv-1', { client_id: CLIENT }, ACTOR)).rejects.toMatchObject({
			response: { code: 'invoice_without_entity' },
		});
	});
});

describe('registrar histórico (§3.2b)', () => {
	const INVOICE = 'inv-1';
	const PRODUCT_A = 'p-a';
	const PRODUCT_B = 'p-b';
	const invoiceRow = (overrides: Record<string, unknown> = {}) => ({
		id: INVOICE,
		invoice_number: 'F-1',
		issue_date: '2026-01-05',
		company_id: CO_CL,
		client_tax_id: null,
		entity_tax_id: '761234567',
		legal_client_name: 'Acme',
		invoice_currency: 'CLP',
		amount_invoice_currency: '1200000',
		total_invoice_currency: '1428000',
		vat: null,
		status: 'Pagada',
		client_id: CLIENT,
		item_id: 'it-1',
		item_subtotal: '1200000',
		item_description: null,
		item_currency: null,
		has_history: false,
		...overrides,
	});
	const handlers = (row = invoiceRow(), covered: unknown[] = []): Handler[] => [
		['LEFT JOIN LATERAL', () => [row]],
		[
			'SELECT id, name FROM products',
			() => [
				{ id: PRODUCT_A, name: 'PATHFINDER+' },
				{ id: PRODUCT_B, name: 'Soporte' },
			],
		],
		['FROM currencies', () => [{ code: 'USD' }, { code: 'CLP' }]],
		['percentile_cont', () => [{ contract_currency: 'USD', invoice_currency: 'CLP', fx: '950' }]],
		['SELECT DISTINCT m.client_id', () => covered],
	];
	const input = (overrides: Record<string, unknown> = {}) =>
		({
			invoice_id: INVOICE,
			period_from: '2026-01',
			period_to: '2026-12',
			contract_currency: 'USD',
			amount_contract_currency: 1200,
			products: [
				{ product_id: PRODUCT_A, amount_contract_currency: 1000 },
				{ product_id: PRODUCT_B, amount_contract_currency: 200 },
			],
			...overrides,
		}) as never;
	const make = (extra: Handler[]) => {
		const db = fakeDb(extra);

		return { db, service: new OnboardingRegisterService(db as unknown as DataSource) };
	};

	it('vista previa: meses del período, MRR mensual, tipo de cambio y avisos (suma, mes cubierto, tipo de cambio raro, sin cliente)', async () => {
		const ok = await make(handlers()).service.preview(HOLDING, { invoices: [input()] });

		expect(ok.rows[0]).toMatchObject({
			months: expect.arrayContaining(['2026-01', '2026-12']),
			mrr_per_month: 100,
			fx_contract_to_invoice: 1000,
			warnings: [],
			errors: [],
		});
		expect(ok.rows[0].months).toHaveLength(12);
		expect(ok.summary).toMatchObject({ ready: 1, rows_to_create: 24 });

		const warned = await make(
			handlers(invoiceRow({ client_id: null, amount_invoice_currency: '3000000' }), [
				{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' },
			])
		).service.preview(HOLDING, { invoices: [input({ amount_contract_currency: 1500 })] });

		expect(warned.rows[0].warnings).toEqual(expect.arrayContaining(['sum_mismatch', 'fx_outlier', 'no_client']));
		expect(warned.rows[0].errors).toContain('no_client');

		const covered = await make(
			handlers(invoiceRow(), [{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' }])
		).service.preview(HOLDING, {
			invoices: [input()],
		});

		expect(covered.rows[0].warnings).toEqual(['month_already_covered']);
		expect(covered.summary.rows_to_create).toBe(23);
	});

	it('aplicar: una fila por producto × mes no cubierto (term = meses, mrr = parte ÷ meses, fx = factura ÷ contrato) y marca la factura', async () => {
		const { db, service } = make(
			handlers(invoiceRow(), [{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' }])
		);
		const result = await service.register(HOLDING, { invoices: [input()] }, ACTOR);
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		expect(result).toMatchObject({ created_rows: 23, skipped: [] });
		expect(result.lines_touched).toHaveLength(2);
		// Primera fila: producto A, enero: split 1, subtotal 1000, asignado 1.000.000 CLP, term 12, MRR 83,33, fx 1000.
		expect(insert.params.slice(0, 4)).toEqual([HOLDING, INVOICE, 'it-1', 1]);
		expect(insert.params.slice(17, 26)).toEqual([1000000, CLIENT, 'USD', 1000, 'PATHFINDER+', 12, '2026-01-01', true, 1000]);
		expect(insert.params[26]).toBe(83.33);
		expect(insert.sql).toContain('ON CONFLICT (invoice_item_legacy_id, split_index, period_month) DO NOTHING');
		expect(db.statements("SET reconciliation_status = 'mrr_legacy'")).toHaveLength(1);
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('history_registered');
	});

	it('aplicar: se salta lo ya registrado, sin líneas, sin cliente o con la suma que no cuadra', async () => {
		const cases: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
			[{ has_history: true }, {}, 'already_registered'],
			[{ item_id: null }, {}, 'invoice_without_items'],
			[{ client_id: null }, {}, 'no_client'],
			[{}, { amount_contract_currency: 2000 }, 'sum_mismatch'],
			[{}, { period_from: '2026-05', period_to: '2026-01' }, 'invalid_period'],
		];

		for (const [row, overrides, reason] of cases) {
			const { db, service } = make(handlers(invoiceRow(row)));
			const result = await service.register(HOLDING, { invoices: [input(overrides)] }, ACTOR);

			expect(result.skipped).toEqual([{ invoice_id: INVOICE, reason }]);
			expect(db.statements('INSERT INTO mrr_legacy')).toHaveLength(0);
		}
	});
});
