import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { encodeLineKey } from './onboarding-common';
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
	'SELECT id, legal_name, currency, tax_id, country_code FROM companies',
	() => [
		{ id: CO_CL, legal_name: 'Simplit SpA', currency: 'CLP', tax_id: '76.000.000-1', country_code: 'CL' },
		{ id: 'co-uy', legal_name: 'SimpliRoute S.A.S', currency: 'UYU', tax_id: '218668210015', country_code: 'UY' },
		{ id: 'co-co', legal_name: 'SimpliRoute S.A.S', currency: 'COP', tax_id: '901412306-5', country_code: 'CO' },
		{ id: 'co-ar', legal_name: 'SimpliRoute S.A.S', currency: 'ARS', tax_id: '30-71661797-8', country_code: 'AR' },
	],
];
/** Lo que el motor de Registrar histórico lee de una factura y sus líneas (por línea, Domi 28-10). */
const planInvoice = (overrides: Record<string, unknown> = {}) => ({
	id: 'inv-new',
	invoice_number: 'F-100',
	issue_date: '2026-07-01',
	company_id: CO_CL,
	legal_client_name: 'Acme',
	invoice_currency: 'CLP',
	amount_invoice_currency: '1000',
	total_invoice_currency: '1190',
	status: 'Enviada',
	client_id: CLIENT,
	reconciled_invoice_id: null,
	...overrides,
});
const PLAN_INVOICES = 'il.id = ANY($2::uuid[])';
const PLAN_ITEMS = 'FROM invoice_items_legacy ii WHERE ii.invoices_legacy_id = ANY';
const PLAN_REGISTERED = 'AS allocated';
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
	const db = fakeDb([...handlers, companies, existing, entities, byRef, candidates, ['INSERT INTO invoices_legacy', () => [{ id: 'inv-new' }]]]);

	return {
		db,
		service: new OnboardingPreviousInvoicesService(db as unknown as DataSource, new OnboardingRegisterService(db as unknown as DataSource)),
	};
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
		// Compañías con el mismo nombre: la fila dice en qué países están y qué columna desempata.
		expect(preview.rows[5].errors[0]).toBe(
			'Hay varias compañías llamadas "SimpliRoute S.A.S" (UY, CO, AR): indica company_tax_id o company_country para saber cuál emitió la factura'
		);
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

	it('compañía emisora por identificador fiscal o por país cuando hay varias con el mismo nombre (Domi 28-10); la moneda sigue como último desempate', async () => {
		const { service } = build();
		const preview = await service.previewImport(HOLDING, {
			invoices: [
				invoice({ company_name: 'SimpliRoute S.A.S', currency: 'USD', company_tax_id: '30-71.661.797-8' }),
				invoice({ row: 2, invoice_number: 'F-2', company_name: 'SimpliRoute S.A.S', currency: 'USD', company_country: 'co' }),
				invoice({ row: 3, invoice_number: 'F-3', company_name: 'simpliroute sas', currency: 'USD', company_tax_id: '21866821-0015' }),
				invoice({ row: 4, invoice_number: 'F-4', company_name: 'SimpliRoute S.A.S', currency: 'COP' }),
				invoice({ row: 5, invoice_number: 'F-5', company_name: 'SimpliRoute S.A.S', currency: 'USD', company_country: 'BR' }),
			],
		});

		expect(preview.rows.map((row) => [row.status, row.company?.id ?? null])).toEqual([
			['new', 'co-ar'],
			['new', 'co-co'],
			['new', 'co-uy'],
			['new', 'co-co'],
			['error', null],
		]);
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

describe('lista y filtros de facturas previas (Domi 14-10)', () => {
	it('con o sin histórico, compañía emisora y país de la razón social; la fila trae notas y país', async () => {
		const { db, service } = build([
			[
				'COUNT(*) OVER ()',
				() => [{ id: 'inv-1', company_id: CO_CL, notes: 'Pago parcial', entity_country: 'BR', has_history: false, total_count: '1' }],
			],
		]);
		const result = await service.list(HOLDING, { hasHistory: 'false', companyId: CO_CL, country: 'BR' });
		const [call] = db.statements('COUNT(*) OVER ()');

		expect(call.sql).toContain('NOT EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)');
		expect(call.sql).toContain('il.company_id = $2');
		expect(call.sql).toContain('upper(ce.country_code) = $3');
		expect(call.params).toEqual([HOLDING, CO_CL, 'BR']);
		expect(result.data[0]).toMatchObject({ notes: 'Pago parcial', country: 'BR', has_history: false });
		await service.list(HOLDING, { hasHistory: 'true' });
		expect(db.statements('COUNT(*) OVER ()')[1].sql).toContain('AND EXISTS (SELECT 1 FROM mrr_legacy m WHERE m.invoice_legacy_id = il.id)');
	});

	it('opciones de filtro: solo compañías y países presentes en las facturas previas del holding', async () => {
		const { db, service } = build([
			['SELECT DISTINCT co.id, co.legal_name', () => [{ id: CO_CL, legal_name: 'Simplit SpA' }]],
			['SELECT DISTINCT upper(ce.country_code)', () => [{ country: 'BR' }, { country: 'CL' }]],
		]);

		await expect(service.filterOptions(HOLDING)).resolves.toEqual({
			companies: [{ id: CO_CL, legal_name: 'Simplit SpA' }],
			countries: ['BR', 'CL'],
		});
		expect(db.statements('SELECT DISTINCT').every((call) => call.params[0] === HOLDING)).toBe(true);
	});
});

describe('importación con histórico en el mismo paso (Domi 14-10)', () => {
	const PRODUCT = 'p-pf';
	const products: Handler = [
		'SELECT id, name, product_code FROM products',
		() => [
			{ id: PRODUCT, name: 'PATHFINDER+', product_code: 'PF' },
			{ id: 'p-sop', name: 'Soporte', product_code: 'SOP' },
		],
	];
	const currencies: Handler = ['FROM currencies', () => [{ code: 'CLP' }, { code: 'USD' }]];
	const historyItem = (overrides: Record<string, unknown> = {}) => ({
		subtotal: 1000,
		product: 'PF',
		period_from: '2026-07',
		period_to: '2026-07',
		contract_currency: 'CLP',
		amount_contract_currency: 1000,
		...overrides,
	});

	it('vista previa: ready (por código o nombre), incomplete (faltan campos) y error (producto inexistente, período, suma, sin cliente)', async () => {
		const { service } = build([products, currencies]);
		const preview = await service.previewImport(HOLDING, {
			invoices: [
				invoice({ items: [historyItem()] }),
				invoice({
					row: 2,
					invoice_number: 'F-2',
					items: [historyItem({ product: 'pathfinder+', contract_currency: 'USD', amount_contract_currency: 1000 })],
				}),
				invoice({ row: 3, invoice_number: 'F-3', items: [historyItem({ period_to: undefined, amount_contract_currency: undefined })] }),
				invoice({ row: 4, invoice_number: 'F-4', items: [historyItem({ product: 'No Existe' })] }),
				invoice({ row: 5, invoice_number: 'F-5', items: [historyItem({ period_from: '2026-08', period_to: '2026-07' })] }),
				invoice({ row: 6, invoice_number: 'F-6', items: [historyItem({ subtotal: 500 })] }),
				invoice({ row: 7, invoice_number: 'F-7', legal_client_name: 'Suelta Ltda', client_tax_id: undefined, items: [historyItem()] }),
				invoice({ row: 8, invoice_number: 'F-8' }),
			],
		});
		const history = Object.fromEntries(preview.rows.map((row) => [row.row, row.history]));

		expect(history[1]).toEqual({
			status: 'ready',
			errors: [],
			product: { id: PRODUCT, name: 'PATHFINDER+' },
			fx_contract_to_invoice: 1,
			warnings: [],
			lines: [{ index: 1, product: { id: PRODUCT, name: 'PATHFINDER+' }, contract_currency: 'CLP', fx_contract_to_invoice: 1, warnings: [] }],
		});
		// CLP de factura con USD de contrato y fx 1: aviso de monto copiado.
		expect(history[2]).toMatchObject({ status: 'ready', fx_contract_to_invoice: 1, warnings: ['fx_one_with_different_currencies'] });
		expect(history[3]).toMatchObject({
			status: 'incomplete',
			errors: ['Línea 1: falta el período hasta', 'Línea 1: falta el monto en moneda de contrato'],
		});
		expect(history[4]).toMatchObject({ status: 'error', errors: ['Línea 1: el producto "No Existe" no está en el catálogo'] });
		expect(history[5].status).toBe('error');
		expect(history[6].errors).toEqual(['La suma de las líneas no cuadra con el neto de la factura (±1 %)']);
		expect(history[7].errors[0]).toContain('no tiene cliente comercial');
		expect(history[8]).toMatchObject({ status: 'none', product: null, lines: [] });
		expect(preview.summary).toMatchObject({ history_ready: 2, history_incomplete: 1, history_error: 4 });
		expect(preview.rows[0]).not.toHaveProperty('history_products');
	});

	it('histórico por línea y opcional (Domi 28-10): cada línea con su período, moneda y producto; una línea sin histórico entra solo como línea; el tipo de cambio es por línea', async () => {
		const { service } = build([products, currencies]);
		const preview = await service.previewImport(HOLDING, {
			invoices: [
				// Dos contratos pactados en monedas distintas, cobrados en una factura CLP: ya no se exige que las líneas coincidan.
				invoice({
					amount: 1500,
					total: 1785,
					items: [
						historyItem({ subtotal: 1000, contract_currency: 'USD', amount_contract_currency: 1 }),
						historyItem({
							subtotal: 500,
							product: 'SOP',
							period_from: '2026-07',
							period_to: '2026-09',
							contract_currency: 'CLP',
							amount_contract_currency: 500,
						}),
					],
				}),
				// Una línea con histórico y otra sin ninguno de sus campos: ready, con una sola línea de registro.
				invoice({ row: 2, invoice_number: 'F-2', amount: 1500, total: 1785, items: [historyItem(), { subtotal: 500 }] }),
			],
		});
		const [mixed, partial] = preview.rows.map((row) => row.history);

		expect(mixed).toMatchObject({ status: 'ready', errors: [], product: { id: PRODUCT }, fx_contract_to_invoice: 1000 });
		expect(mixed.lines).toEqual([
			{ index: 1, product: { id: PRODUCT, name: 'PATHFINDER+' }, contract_currency: 'USD', fx_contract_to_invoice: 1000, warnings: [] },
			{ index: 2, product: { id: 'p-sop', name: 'Soporte' }, contract_currency: 'CLP', fx_contract_to_invoice: 1, warnings: [] },
		]);
		expect(partial).toMatchObject({ status: 'ready', errors: [] });
		expect(partial.lines).toHaveLength(1);
	});

	it('aplicar: registra el histórico de las facturas ready en la misma transacción y con el lote de la importación; incomplete entra sin histórico', async () => {
		const { db, service } = build([
			products,
			currencies,
			[PLAN_INVOICES, () => [planInvoice()]],
			[PLAN_ITEMS, () => [{ id: 'it-1', invoices_legacy_id: 'inv-new', subtotal: '1000', description: 'Plataforma', currency: 'CLP' }]],
			['INSERT INTO invoice_items_legacy', () => [{ id: 'it-1' }]],
			['SELECT id, name FROM products', () => [{ id: PRODUCT, name: 'PATHFINDER+' }]],
		]);
		const result = await service.applyImport(
			HOLDING,
			{
				invoices: [
					invoice({ items: [historyItem()] }),
					invoice({ row: 2, invoice_number: 'F-2', items: [historyItem({ amount_contract_currency: undefined })] }),
				],
			},
			ACTOR
		);
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		expect(result).toMatchObject({ inserted: 2, history_rows_created: 1, history_skipped: [] });
		// Las filas cuelgan de la línea recién insertada (RETURNING id de las líneas), con su descripción.
		expect(insert.params.slice(0, 4)).toEqual([HOLDING, 'inv-new', 'it-1', 1]);
		expect(insert.params[14]).toBe('Plataforma');
		expect(result.history_records_touched).toHaveLength(1);
		// El registro de MRR legacy nace con su propio `batch_id` (uno por cliente × moneda, Domi 18-10), nunca el lote de la importación; el
		// lote lo guarda en su evento (`history_batch_ids`) para poder revertirlo.
		expect(result.history_batch_ids).toHaveLength(1);
		expect(result.history_batch_ids[0]).not.toBe(result.batch_id);
		expect(insert.params).toContain(result.history_batch_ids[0]);
		expect(insert.params).not.toContain(result.batch_id);
		expect(db.statements('INSERT INTO mrr_legacy')).toHaveLength(1);
		const events = db.statements('INSERT INTO onboarding_events');

		expect(events.map((call) => call.params[1])).toEqual(['history_registered', 'previous_invoices_imported']);
		expect(JSON.parse(String(events[1].params[5]))).toMatchObject({ history_batch_ids: result.history_batch_ids });
		expect(db.committed()).toBe(1);
	});

	it('aplicar: dos facturas del mismo cliente y moneda comparten registro; otra moneda abre otro', async () => {
		const inserted = ['inv-a', 'inv-b', 'inv-c'];
		const { service } = build([
			products,
			currencies,
			['INSERT INTO invoices_legacy', () => [{ id: inserted.shift() }]],
			['INSERT INTO invoice_items_legacy', (params) => [{ id: `it-${params[0]}` }]],
			[
				PLAN_INVOICES,
				(params) =>
					(params[1] as string[]).map((id) => planInvoice({ id, invoice_number: id, invoice_currency: id === 'inv-c' ? 'USD' : 'CLP' })),
			],
			[PLAN_ITEMS, (params) => (params[0] as string[]).map((id) => ({ id: `it-${id}`, invoices_legacy_id: id, subtotal: '1000' }))],
			['SELECT id, name FROM products', () => [{ id: PRODUCT, name: 'PATHFINDER+' }]],
		]);
		const result = await service.applyImport(
			HOLDING,
			{
				invoices: [
					invoice({ items: [historyItem()] }),
					invoice({ row: 2, invoice_number: 'F-2', items: [historyItem()] }),
					invoice({ row: 3, invoice_number: 'F-3', currency: 'USD', items: [historyItem({ contract_currency: 'USD' })] }),
				],
			},
			ACTOR
		);

		expect(result).toMatchObject({ inserted: 3, history_rows_created: 3 });
		expect(result.history_batch_ids).toHaveLength(2);
		expect(result.history_records_touched).toHaveLength(2);
	});

	it('cliente comercial por número de cliente (además de RUT, nombre e id del CRM) y como candidato seguro si falta la razón social', async () => {
		const { service } = build([
			[
				'salesforce_account_id = ANY',
				() => [{ id: 'cl-num', name_commercial: 'Por Número', salesforce_account_id: null, client_number: 'C-77' }],
			],
		]);
		const preview = await service.previewImport(HOLDING, {
			invoices: [
				invoice({ legal_client_name: 'Suelta Ltda', client_tax_id: undefined, client_number: 'C-77' }),
				invoice({
					row: 2,
					invoice_number: 'F-2',
					legal_client_name: 'Nueva Ltda',
					client_tax_id: undefined,
					client_number: 'C-77',
					country: 'BR',
				}),
			],
		});

		expect(preview.rows[0]).toMatchObject({ status: 'new', client: { id: 'cl-num' } });
		expect(preview.rows[1]).toMatchObject({
			status: 'needs_entity',
			entity_suggestion: { country: 'BR', client_candidates: [{ id: 'cl-num', name: 'Por Número', score: 1 }] },
		});
	});
});

describe('revertir lote y relacionar cliente', () => {
	/** El evento del lote (con sus `history_batch_ids`, o sin ellos en importaciones anteriores al 18-10) y el estado del lote. */
	const batch = (row: Record<string, unknown>, imported: unknown = { history_batch_ids: null }): Handler[] => [
		["payload -> 'history_batch_ids'", () => (imported ? [imported] : [])],
		['AS with_history', () => [{ reverted: false, with_history: 0, linked: 0, ...row }]],
	];

	it('revertir: 404 si el lote no existe, 409 batch_has_history / batch_linked / already_reverted, y borra las facturas del lote', async () => {
		await expect(build(batch({}, null)).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toBeInstanceOf(NotFoundException);
		await expect(build(batch({ with_history: 2 })).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'batch_has_history' },
		});
		await expect(build(batch({ linked: 1 })).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'batch_linked' },
		});
		await expect(build(batch({ reverted: true })).service.revertImport(HOLDING, 'b-1', ACTOR)).rejects.toMatchObject({
			response: { code: 'already_reverted' },
		});
		const { db, service } = build([...batch({}), ['DELETE FROM invoices_legacy', () => [{ id: 'a' }, { id: 'b' }]]]);

		await expect(service.revertImport(HOLDING, 'b-1', ACTOR)).resolves.toEqual({ batch_id: 'b-1', removed: 2, history_rows_removed: 0 });
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('previous_invoices_reverted');
	});

	it('revertir un lote con histórico propio (los registros que creó la importación, sin empalmar): lo borra también y lo informa', async () => {
		const { db, service } = build([
			...batch({}, { history_batch_ids: ['h-1', 'h-2'] }),
			['DELETE FROM mrr_legacy', () => [{ id: 'm-1' }, { id: 'm-2' }]],
			['DELETE FROM invoices_legacy', () => [{ id: 'a' }]],
		]);

		await expect(service.revertImport(HOLDING, 'b-1', ACTOR)).resolves.toEqual({ batch_id: 'b-1', removed: 1, history_rows_removed: 2 });
		// El bloqueo solo cuenta histórico ajeno a los registros de la importación o empalmado.
		const [check] = db.statements('AS with_history');

		expect(check.sql).toContain('m.batch_id <> ALL($3::uuid[]) OR m.migrated_to_contract_id IS NOT NULL');
		expect(check.params).toEqual([HOLDING, 'b-1', ['h-1', 'h-2']]);
		const [del] = db.statements('DELETE FROM mrr_legacy');

		expect(del.sql).toContain('m.batch_id = ANY($3::uuid[]) AND m.migrated_to_contract_id IS NULL');
		expect(del.params).toEqual([HOLDING, 'b-1', ['h-1', 'h-2']]);
		// Primero el histórico, después las facturas.
		expect(db.calls.findIndex((call) => call.sql.includes('DELETE FROM mrr_legacy'))).toBeLessThan(
			db.calls.findIndex((call) => call.sql.includes('DELETE FROM invoices_legacy'))
		);
		// Importación anterior al 18-10 (sin `history_batch_ids`): el histórico propio era el del lote mismo.
		const legacy = build([...batch({}), ['DELETE FROM invoices_legacy', () => [{ id: 'a' }]]]);

		await legacy.service.revertImport(HOLDING, 'b-1', ACTOR);
		expect(legacy.db.statements('DELETE FROM mrr_legacy')[0].params).toEqual([HOLDING, 'b-1', ['b-1']]);
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
		reconciled_invoice_id: null,
		...overrides,
	});
	const itemRow = (overrides: Record<string, unknown> = {}) => ({
		id: 'it-1',
		invoices_legacy_id: INVOICE,
		subtotal: '1200000',
		description: null,
		currency: null,
		...overrides,
	});
	/** Una fila de `mrr_legacy` ya registrada sobre una línea (lo que cubre en moneda de factura). */
	const registeredRow = (itemId: string, allocated: string, split = 1) => ({
		invoice_legacy_id: INVOICE,
		item_id: itemId,
		split_index: split,
		allocated,
	});
	const handlers = (row = invoiceRow(), covered: unknown[] = [], items: unknown[] = [itemRow()], registered: unknown[] = []): Handler[] => [
		[PLAN_INVOICES, () => [row]],
		[PLAN_ITEMS, () => items],
		[PLAN_REGISTERED, () => registered],
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
	const line = (overrides: Record<string, unknown> = {}) => ({
		item_id: 'it-1',
		period_from: '2026-01',
		period_to: '2026-12',
		contract_currency: 'USD',
		amount_contract_currency: 1200,
		products: [
			{ product_id: PRODUCT_A, amount_contract_currency: 1000 },
			{ product_id: PRODUCT_B, amount_contract_currency: 200 },
		],
		...overrides,
	});
	/** Una factura con una línea de registro (lo que cambia va en la línea; `invoiceOverrides` en la factura). */
	const input = (overrides: Record<string, unknown> = {}, invoiceOverrides: Record<string, unknown> = {}) =>
		({ invoice_id: INVOICE, lines: [line(overrides)], ...invoiceOverrides }) as never;
	const make = (extra: Handler[]) => {
		const db = fakeDb(extra);

		return { db, service: new OnboardingRegisterService(db as unknown as DataSource) };
	};

	it('vista previa: meses del período, MRR mensual, tipo de cambio y avisos (suma, mes cubierto, tipo de cambio raro, sin cliente)', async () => {
		const ok = await make(handlers()).service.preview(HOLDING, { invoices: [input()] });

		expect(ok.rows[0]).toMatchObject({ months: expect.arrayContaining(['2026-01', '2026-12']), warnings: [], errors: [] });
		expect(ok.rows[0].lines[0]).toMatchObject({
			item_id: 'it-1',
			item_index: 1,
			months: expect.arrayContaining(['2026-01', '2026-12']),
			mrr_per_month: 100,
			fx_contract_to_invoice: 1000,
			warnings: [],
			errors: [],
			blocked: false,
		});
		expect(ok.rows[0].months).toHaveLength(12);
		expect(ok.summary).toMatchObject({ invoices: 1, lines: 1, ready: 1, invoices_ready: 1, rows_to_create: 24 });

		// El tipo de cambio sale del subtotal de la línea (no del neto de la factura): 3.000.000 ÷ 1.500 = 2.000, lejos de la mediana 950.
		const warned = await make(
			handlers(
				invoiceRow({ client_id: null, amount_invoice_currency: '3000000' }),
				[{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' }],
				[itemRow({ subtotal: '3000000' })]
			)
		).service.preview(HOLDING, { invoices: [input({ amount_contract_currency: 1500 })] });

		expect(warned.rows[0].warnings).toEqual(expect.arrayContaining(['sum_mismatch', 'fx_outlier', 'no_client']));
		// Tipo de cambio visible (Domi 14-10): moneda y monto de la factura junto al fx implícito.
		expect(ok.rows[0]).toMatchObject({ invoice_currency: 'CLP', amount_invoice_currency: 1200000 });

		// Monedas distintas con fx ≈ 1 (el monto de contrato se copió del de factura): aviso propio, además del outlier contra la mediana.
		const copied = await make(handlers(invoiceRow({ amount_invoice_currency: '1200' }), [], [itemRow({ subtotal: '1200' })])).service.preview(
			HOLDING,
			{
				invoices: [input()],
			}
		);

		expect(copied.rows[0].lines[0].fx_contract_to_invoice).toBe(1);
		expect(copied.rows[0].warnings).toEqual(expect.arrayContaining(['fx_one_with_different_currencies', 'fx_outlier']));
		expect(warned.rows[0].errors).toContain('no_client');

		const covered = await make(
			handlers(invoiceRow(), [{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' }])
		).service.preview(HOLDING, {
			invoices: [input()],
		});

		expect(covered.rows[0].warnings).toEqual(['month_already_covered']);
		expect(covered.summary.rows_to_create).toBe(23);
	});

	const UUID_CLIENT = '22222222-2222-4222-8222-222222222222';
	const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
	const TARGET = { batch_id: BATCH, client_id: UUID_CLIENT, contract_currency: 'USD', contract_id: null };
	const TARGET_KEY = encodeLineKey(TARGET);
	/** El registro pendiente existente, como lo devuelven `resolveTargets` (raíz) y `pendingRecords` (fila de la bandeja). */
	const pendingHandlers: Handler[] = [
		['HAVING BOOL_OR(NOT m.skip_activation)', () => [{ batch_id: BATCH, client_id: UUID_CLIENT, contract_currency: 'USD' }]],
		[
			'SELECT st.batch_id',
			() => [
				{
					batch_id: BATCH,
					client_id: UUID_CLIENT,
					contract_currency: 'USD',
					contract_id: null,
					status: 'pending',
					first_month: '2025-01',
					last_month: '2025-12',
					months_count: '12',
					mrr_last: '100',
					registered_at: '2026-09-01T00:00:00.000Z',
					products: [{ product_name: 'PATHFINDER+', product_id: PRODUCT_A, mrr_last: '100' }],
				},
			],
		],
	];

	it('vista previa: sin destino el registro nace al aplicar (record_key null) y se listan los registros pendientes del cliente y moneda; una factura bloqueada no cuenta (Domi 18-10)', async () => {
		const { db, service } = make([...pendingHandlers, ...handlers(invoiceRow({ client_id: UUID_CLIENT }))]);
		const preview = await service.preview(HOLDING, { invoices: [input()] });

		expect(preview.rows[0].lines[0]).toMatchObject({ record_key: null, record_exists: false });
		expect(preview.rows[0].lines[0].existing_records).toEqual([
			{
				key: TARGET_KEY,
				batch_id: BATCH,
				products: ['PATHFINDER+'],
				first_month: '2025-01',
				last_month: '2025-12',
				months_count: 12,
				mrr_last: 100,
				registered_at: '2026-09-01T00:00:00.000Z',
			},
		]);
		// Los dos productos de la factura caen en el mismo registro: un registro nuevo (cliente × moneda).
		expect(preview.summary).toMatchObject({ records_touched: [], records_to_create: 1 });
		expect(db.statements('SELECT st.batch_id')[0].params).toEqual([HOLDING, [UUID_CLIENT]]);
		// Sin cliente comercial no hay registro; una factura bloqueada no abre registro.
		const noClient = await make(handlers(invoiceRow({ client_id: null }))).service.preview(HOLDING, { invoices: [input()] });

		expect(noClient.rows[0].lines[0]).toMatchObject({ record_key: null, record_exists: false, existing_records: [] });
		expect(noClient.summary).toMatchObject({ records_touched: [], records_to_create: 0 });
	});

	it('target_key (continuar un registro): por factura o global, debe ser un registro pendiente del mismo cliente y moneda; si no, target_not_found | target_mismatch', async () => {
		const { service } = make([...pendingHandlers, ...handlers(invoiceRow({ client_id: UUID_CLIENT }))]);
		const own = await service.preview(HOLDING, { invoices: [input({ target_key: TARGET_KEY })] });

		expect(own.rows[0].lines[0]).toMatchObject({ record_key: TARGET_KEY, record_exists: true, errors: [] });
		expect(own.summary).toMatchObject({ records_touched: [TARGET_KEY], records_to_create: 0 });
		const global = await service.preview(HOLDING, { invoices: [input()], target_key: TARGET_KEY });

		expect(global.rows[0].lines[0]).toMatchObject({ record_key: TARGET_KEY, record_exists: true });
		// También por factura (todas sus líneas).
		const byInvoice = await service.preview(HOLDING, { invoices: [input({}, { target_key: TARGET_KEY })] });

		expect(byInvoice.rows[0].lines[0]).toMatchObject({ record_key: TARGET_KEY, record_exists: true });
		const mismatch = await service.preview(HOLDING, { invoices: [input({ contract_currency: 'CLP', target_key: TARGET_KEY })] });

		expect(mismatch.rows[0].errors).toContain('target_mismatch');
		expect(mismatch.rows[0].lines[0].record_key).toBeNull();
		const missing = await make(handlers(invoiceRow({ client_id: UUID_CLIENT }))).service.preview(HOLDING, {
			invoices: [input({ target_key: TARGET_KEY })],
		});

		expect(missing.rows[0].errors).toContain('target_not_found');
		// Un registro relacionado nunca es destino; una clave rota es 400 con su campo.
		const linked = await service.preview(HOLDING, {
			invoices: [input({ target_key: encodeLineKey({ ...TARGET, contract_id: BATCH }) })],
		});

		expect(linked.rows[0].errors).toContain('target_not_found');
		await expect(service.preview(HOLDING, { invoices: [input({}, { target_key: 'rota' })] })).rejects.toMatchObject({
			response: { errors: [{ field: 'invoices.0.target_key' }] },
		});
		await expect(service.preview(HOLDING, { invoices: [input({ target_key: 'rota' })] })).rejects.toMatchObject({
			response: { errors: [{ field: 'invoices.0.lines.0.target_key' }] },
		});
		await expect(service.preview(HOLDING, { invoices: [input()], target_key: 'rota' })).rejects.toMatchObject({
			response: { errors: [{ field: 'target_key' }] },
		});
	});

	it('aplicar con target_key: las filas nacen en el batch_id del registro elegido y el evento lo dice', async () => {
		const { db, service } = make([...pendingHandlers, ...handlers(invoiceRow({ client_id: UUID_CLIENT }))]);
		const result = await service.register(HOLDING, { invoices: [input()], target_key: TARGET_KEY }, ACTOR);

		expect(result).toMatchObject({ created_rows: 24, records_touched: [TARGET_KEY], batch_ids: [BATCH], skipped: [] });
		expect(db.statements('INSERT INTO mrr_legacy')[0].params[29]).toBe(BATCH);
		const [event] = db.statements('INSERT INTO onboarding_events');

		expect(event.params[2]).toBe(`${BATCH}|${UUID_CLIENT}|USD`);
		expect(JSON.parse(String(event.params[5]))).toMatchObject({ batch_id: BATCH, continued: `${BATCH}|${UUID_CLIENT}|USD|` });
	});

	it('aplicar: una fila por producto × mes no cubierto (term = meses, mrr = parte ÷ meses, fx = factura ÷ contrato), los dos productos en un solo registro, y marca la factura', async () => {
		const { db, service } = make(
			handlers(invoiceRow(), [{ client_id: CLIENT, product_name: 'PATHFINDER+', contract_currency: 'USD', period: '2026-03' }])
		);
		const result = await service.register(HOLDING, { invoices: [input()] }, ACTOR);
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		expect(result).toMatchObject({ created_rows: 23, skipped: [], created_ids: [] });
		// Un registro (`batch_id`) para los dos productos de la factura; su clave lleva ese lote.
		expect(result.records_touched).toHaveLength(1);
		expect(result.batch_ids).toHaveLength(1);
		expect(insert.params[29]).toBe(result.batch_ids[0]);
		expect(insert.sql).toContain('RETURNING id');
		// Primera fila: producto A, enero: split 1, subtotal 1000, asignado 1.000.000 CLP, term 12, MRR 83,33, fx 1000.
		expect(insert.params.slice(0, 4)).toEqual([HOLDING, INVOICE, 'it-1', 1]);
		expect(insert.params.slice(17, 26)).toEqual([1000000, CLIENT, 'USD', 1000, 'PATHFINDER+', 12, '2026-01-01', true, 1000]);
		expect(insert.params[26]).toBe(83.33);
		expect(insert.sql).toContain('ON CONFLICT (invoice_item_legacy_id, split_index, period_month) DO NOTHING');
		expect(db.statements("SET reconciliation_status = 'mrr_legacy'")).toHaveLength(1);
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('history_registered');
	});

	it('aplicar: se salta lo ya registrado, sin líneas, una línea ajena, sin cliente o con la suma que no cuadra', async () => {
		const cases: Array<[Handler[], Record<string, unknown>, string]> = [
			[handlers(invoiceRow(), [], [itemRow()], [registeredRow('it-1', '1200000')]), {}, 'already_registered'],
			[handlers(invoiceRow(), [], []), {}, 'invoice_without_items'],
			[handlers(invoiceRow(), [], [itemRow({ id: 'it-9' })]), {}, 'item_not_found'],
			[handlers(invoiceRow({ client_id: null })), {}, 'no_client'],
			[handlers(), { amount_contract_currency: 2000 }, 'sum_mismatch'],
			[handlers(), { period_from: '2026-05', period_to: '2026-01' }, 'invalid_period'],
		];

		for (const [extra, overrides, reason] of cases) {
			const { db, service } = make(extra);
			const result = await service.register(HOLDING, { invoices: [input(overrides)] }, ACTOR);

			expect(result.skipped).toEqual([{ invoice_id: INVOICE, item_id: 'it-1', reason }]);
			expect(db.statements('INSERT INTO mrr_legacy')).toHaveLength(0);
		}
	});

	describe('por línea de factura (Domi 28-10)', () => {
		/** Factura CLP de 1.200.000 con dos líneas: Plataforma 1.000.000 (contrato en USD) y Soporte 200.000 (contrato en CLP). */
		const twoItems = [
			itemRow({ subtotal: '1000000', description: 'Plataforma' }),
			itemRow({ id: 'it-2', subtotal: '200000', description: 'Soporte' }),
		];
		const twoLines = (extra: Record<string, unknown> = {}) =>
			({
				invoice_id: INVOICE,
				lines: [
					line({ products: [{ product_id: PRODUCT_A, amount_contract_currency: 1200 }] }),
					line({
						item_id: 'it-2',
						contract_currency: 'CLP',
						amount_contract_currency: 200000,
						products: [{ product_id: PRODUCT_B, amount_contract_currency: 200000 }],
					}),
				],
				...extra,
			}) as never;

		it('cada línea con su moneda de contrato y su tipo de cambio (subtotal de la línea ÷ monto); una factura abre un registro por moneda', async () => {
			const { db, service } = make(handlers(invoiceRow(), [], twoItems));
			const preview = await service.preview(HOLDING, { invoices: [twoLines()] });

			expect(
				preview.rows[0].lines.map((row) => [row.item_id, row.item_index, row.item_description, row.fx_contract_to_invoice, row.errors])
			).toEqual([
				['it-1', 1, 'Plataforma', 833.333333, []],
				['it-2', 2, 'Soporte', 1, []],
			]);
			expect(preview.summary).toMatchObject({ invoices: 1, lines: 2, ready: 2, invoices_ready: 1, rows_to_create: 24, records_to_create: 2 });
			const result = await service.register(HOLDING, { invoices: [twoLines()] }, ACTOR);
			const inserts = db.statements('INSERT INTO mrr_legacy');

			expect(result).toMatchObject({ created_rows: 24, skipped: [] });
			expect(result.batch_ids).toHaveLength(2);
			expect(result.records_touched).toHaveLength(2);
			// Cada línea cuelga de su línea de factura, con su descripción, subtotal y asignado.
			expect(inserts[0].params.slice(0, 4)).toEqual([HOLDING, INVOICE, 'it-1', 1]);
			expect(inserts[0].params.slice(14, 18)).toEqual(['Plataforma', 'CLP', 1000000, 1000000]);
			expect(inserts[1].params.slice(0, 4)).toEqual([HOLDING, INVOICE, 'it-2', 1]);
			expect(inserts[1].params.slice(14, 18)).toEqual(['Soporte', 'CLP', 200000, 200000]);
			expect(inserts[1].params[19]).toBe('CLP');
			// La factura se marca una vez; un evento por línea.
			expect(db.statements("SET reconciliation_status = 'mrr_legacy'")).toHaveLength(1);
			expect(db.statements('INSERT INTO onboarding_events').map((call) => JSON.parse(String(call.params[5])).item_id)).toEqual([
				'it-1',
				'it-2',
			]);
		});

		it('dividir una línea en varios productos: split_index por producto, después de los ya usados en esa línea', async () => {
			const { db, service } = make([['AS max_split', () => [{ item_id: 'it-1', max_split: 2 }]], ...handlers(invoiceRow(), [], twoItems)]);
			const result = await service.register(HOLDING, { invoices: [input()] }, ACTOR);
			const [insert] = db.statements('INSERT INTO mrr_legacy');

			expect(result.created_rows).toBe(24);
			// Producto A en split 3 y producto B en split 4 (la línea ya tenía 2 partes de otro registro); 32 valores por fila, 12 meses por producto.
			expect(insert.params[3]).toBe(3);
			expect(insert.params[12 * 32 + 3]).toBe(4);
		});

		it('registro parcial: una línea con filas está registrada y las demás de la factura se pueden registrar; repetir una línea en el body es duplicate_line', async () => {
			const partial = make(handlers(invoiceRow(), [], twoItems, [registeredRow('it-1', '1000000')]));
			const preview = await partial.service.preview(HOLDING, { invoices: [twoLines()] });

			expect(preview.rows[0].lines.map((row) => row.errors)).toEqual([['already_registered'], []]);
			expect(preview.summary).toMatchObject({ lines: 2, ready: 1, invoices_ready: 1, with_errors: 1 });
			const result = await partial.service.register(HOLDING, { invoices: [twoLines()] }, ACTOR);

			expect(result).toMatchObject({ created_rows: 12, skipped: [{ invoice_id: INVOICE, item_id: 'it-1', reason: 'already_registered' }] });
			expect(partial.db.statements('INSERT INTO mrr_legacy')[0].params[2]).toBe('it-2');
			const repeated = await make(handlers(invoiceRow(), [], twoItems)).service.preview(HOLDING, {
				invoices: [{ invoice_id: INVOICE, lines: [line(), line()] } as never],
			});

			expect(repeated.rows[0].lines.map((row) => row.errors)).toEqual([[], ['duplicate_line']]);
		});

		it('una factura registrada entera antes de la regla (todas sus filas en la primera línea, que cubren el neto) no deja registrar ninguna línea', async () => {
			const { service } = make(handlers(invoiceRow(), [], twoItems, [registeredRow('it-1', '1000000'), registeredRow('it-1', '200000', 2)]));
			const preview = await service.preview(HOLDING, { invoices: [twoLines()] });

			expect(preview.rows[0].lines.map((row) => row.errors)).toEqual([['already_registered'], ['already_registered']]);
			expect(preview.summary).toMatchObject({ ready: 0, invoices_ready: 0 });
		});
	});
});
