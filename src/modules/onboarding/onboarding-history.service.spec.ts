import * as fs from 'fs';
import * as path from 'path';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { API_WRITER_SQL } from '@/modules/contracts/api-writer';
import type { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { decodeLineKey, encodeLineKey, parseRawLineKey, rawLineKey } from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { candidateScore, lineCtes, lineDto, spliceOf } from './onboarding-lines';
import { OnboardingRegisterService } from './onboarding-register.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';
const CONTRACT = '44444444-4444-4444-8444-444444444444';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const PARTS = { client_id: CLIENT, product_name: 'PATHFINDER+ / Rutas|MX', contract_currency: 'USD' };
const KEY = encodeLineKey(PARTS);

const lineRow = (overrides: Record<string, unknown> = {}) => ({
	client_id: CLIENT,
	product_name: PARTS.product_name,
	contract_currency: 'USD',
	first_month: '2025-01',
	last_month: '2026-06',
	live_last_month: '2026-06',
	months_count: '18',
	mrr_last: '120.5',
	mrr_last_system: '120.5',
	status: 'pending',
	ended: true,
	contract_id: null,
	batch_ids: '{b-1}',
	invoices_count: '18',
	skip_reason_code: null,
	skip_reason: null,
	client_name: 'ACME',
	product_id: null,
	...overrides,
});

/** Filas de la línea para escribir: 2 pendientes, 1 empalmada, 1 cerrada (churn), 1 quitada (texto "duplicado"). */
const writeRows = [
	{ id: 'r-1', period: '2026-04', migrated_to_contract_id: null, skip_activation: false, skip_code: null, invoice_legacy_id: 'i-1' },
	{ id: 'r-2', period: '2026-05', migrated_to_contract_id: null, skip_activation: false, skip_code: null, invoice_legacy_id: 'i-2' },
	{ id: 'r-3', period: '2026-03', migrated_to_contract_id: 'c-old', skip_activation: false, skip_code: null, invoice_legacy_id: 'i-3' },
	{ id: 'r-4', period: '2026-02', migrated_to_contract_id: null, skip_activation: true, skip_code: 'churn', invoice_legacy_id: 'i-4' },
	{ id: 'r-5', period: '2026-06', migrated_to_contract_id: null, skip_activation: true, skip_code: 'duplicate', invoice_legacy_id: 'i-5' },
];

function build(handlers: Handler[] = [], contractDrafts: Partial<ContractDraftsService> = {}) {
	const db = fakeDb([
		...handlers,
		['m.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id', () => writeRows],
		['SELECT st.client_id', () => [lineRow()]],
		[
			'FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL',
			(params) => (params[0] === CONTRACT ? [{ id: CONTRACT, contract_number: 'CTR-2026-9', status: 'Activo', client_id: CLIENT }] : []),
		],
		['AS first_month', () => [{ first_month: '2026-07' }]],
	]);
	const drafts = {
		create: jest.fn().mockResolvedValue({ id: CONTRACT, contract_number: 'CTR-2026-9' }),
		remove: jest.fn().mockResolvedValue(undefined),
		preview: jest.fn().mockResolvedValue({ invoices: [] }),
		...contractDrafts,
	} as unknown as ContractDraftsService;

	return {
		db,
		drafts,
		service: new OnboardingHistoryService(db as unknown as DataSource, drafts, new OnboardingRegisterService(db as unknown as DataSource)),
	};
}

describe('clave de línea (cliente × producto × moneda)', () => {
	it('se codifica para la URL y vuelve igual, aunque el producto traiga "/", "|", espacios o tildes', () => {
		expect(KEY).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeLineKey(KEY)).toEqual(PARTS);
		expect(parseRawLineKey(rawLineKey(PARTS))).toEqual(PARTS);
	});

	it('clave rota o sin cliente válido → 400 (nunca llega SQL con una clave inválida)', () => {
		expect(() => decodeLineKey('no es base64!')).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from('abc|P|USD').toString('base64url'))).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from(`${CLIENT}|sin-moneda`).toString('base64url'))).toThrow(BadRequestException);
	});
});

describe('estado derivado y empalme', () => {
	it('precedencia del estado en SQL: pendiente (un solo estado; `ended` aparte) > empalmada > cerrada > quitada', () => {
		const sql = lineCtes({ holding: '$1', today: '$2' }).replace(/\s+/g, ' ');

		expect(sql).toContain(
			"CASE WHEN l.has_pending THEN 'pending' WHEN l.has_linked THEN 'linked' WHEN l.has_closed THEN 'closed' ELSE 'removed' END AS status"
		);
		expect(sql).not.toContain('pending_ended');
		expect(sql).toContain('l.last_date < $2::date AS ended');
		// Lectura tolerante del texto libre y MRR del último mes sin las filas quitadas.
		expect(sql).toContain("ILIKE '%duplic%'");
		expect(sql).toContain('x.period_month = x.live_last AND NOT x.removed');
	});

	it('lineDto: clave codificada, contrato y lotes', () => {
		const dto = lineDto(lineRow({ status: 'linked', contract_id: CONTRACT, contract_number: 'CTR-1', contract_status: 'Activo' }));

		expect(dto.key).toBe(KEY);
		expect(dto).toMatchObject({ status: 'linked', mrr_last: 120.5, batch_ids: ['b-1'], contract: { id: CONTRACT, contract_number: 'CTR-1' } });
		expect(dto.companies).toEqual([]);
	});

	it('compañías emisoras de la línea (Domi 18-10): distintas company_id de sus filas, como arreglo o texto JSON', () => {
		const sql = lineCtes({ holding: '$1', today: '$2' }).replace(/\s+/g, ' ');

		expect(sql).toContain('ARRAY_AGG(DISTINCT x.company_id) FILTER (WHERE x.company_id IS NOT NULL) AS company_ids');
		const companies = [
			{ id: CONTRACT, legal_name: 'SimpliRoute SpA' },
			{ id: OTHER_CLIENT, legal_name: null },
		];

		expect(lineDto(lineRow({ companies })).companies).toEqual(companies);
		expect(lineDto(lineRow({ companies: JSON.stringify(companies.slice(0, 1)) })).companies).toEqual(companies.slice(0, 1));
	});

	it('hueco y solape: último + 1 = primero → exacto; huecos y meses solapados (los corta U14) se cuentan', () => {
		expect(spliceOf('2026-06', '2026-07', ['2026-05', '2026-06'])).toEqual({ gap_months: 0, overlap_months: 0, contract_first_month: '2026-07' });
		expect(spliceOf('2026-03', '2026-07', ['2026-03'])).toMatchObject({ gap_months: 3, overlap_months: 0 });
		expect(spliceOf('2026-09', '2026-07', ['2026-07', '2026-08', '2026-09', '2026-09'])).toMatchObject({ gap_months: 0, overlap_months: 3 });
		expect(spliceOf(null, '2026-07', [])).toEqual({ gap_months: 0, overlap_months: 0, contract_first_month: '2026-07' });
	});

	it('candidatos: mismo producto, misma moneda y arranque justo al mes siguiente suben el puntaje', () => {
		const line = { product_name: 'PATHFINDER+', currency: 'USD', last_month: '2026-06' };

		expect(candidateScore(line, { products: ['pathfinder+'], currency: 'USD', first_month: '2026-07' })).toBe(4);
		expect(candidateScore(line, { products: ['Otro'], currency: 'CLF', first_month: '2026-09' })).toBe(0);
	});
});

describe('lecturas', () => {
	it('lista: filtros de cliente y producto sobre las filas, estado y lote sobre la línea, orden por lista blanca', async () => {
		const { db, service } = build([['COUNT(*) OVER ()', () => [{ ...lineRow(), total_count: '1' }]]]);
		const result = await service.list(HOLDING, {
			status: 'pending,pending_ended',
			clientId: CLIENT,
			product: 'P',
			batchId: CLIENT,
			sortBy: 'mrr',
			sortOrder: 'desc',
		});
		const [call] = db.statements('COUNT(*) OVER ()');

		expect(result).toMatchObject({ total: 1, currentPage: 1, pages: 1, limit: 25 });
		expect(result.data[0].key).toBe(KEY);
		expect(call.sql).toContain('m.client_id = $3');
		expect(call.sql).toContain('st.status = ANY($5::text[])');
		expect(call.sql).toContain('ORDER BY st.mrr_last_system DESC');
		expect(call.params.slice(0, 2)).toEqual([HOLDING, expect.stringMatching(/^\d{4}-\d{2}-01$/)]);
	});

	it('orden por defecto: prioridad de estado (pendiente → empalmada → cerrada → quitada) y cliente; ended=true = pendientes terminadas', async () => {
		const { db, service } = build([['COUNT(*) OVER ()', () => []]]);

		await service.list(HOLDING, { ended: 'true' });
		await service.list(HOLDING, { sortBy: 'client', ended: 'false' });
		const [byDefault, byClient] = db.statements('COUNT(*) OVER ()');

		expect(byDefault.sql).toContain(
			"ORDER BY CASE st.status WHEN 'pending' THEN 0 WHEN 'linked' THEN 1 WHEN 'closed' THEN 2 ELSE 3 END ASC NULLS LAST, cl.name_commercial"
		);
		expect(byDefault.sql).toContain("st.status = 'pending' AND st.ended");
		expect(byClient.sql).toContain('ORDER BY cl.name_commercial ASC NULLS LAST');
		expect(byClient.sql).toContain("st.status = 'pending' AND NOT st.ended");
	});

	it('línea de otro holding (sin filas) → 404', async () => {
		const { service } = build([['SELECT st.client_id', () => []]]);

		await expect(service.line(HOLDING, KEY)).rejects.toBeInstanceOf(NotFoundException);
	});
});

describe('escrituras', () => {
	const firstStatementIsWriter = (db: ReturnType<typeof fakeDb>) =>
		expect(db.calls.find((call) => /set_config/.test(call.sql))?.sql).toBe(API_WRITER_SQL);

	it('empalmar: solo los meses pendientes, facturas sin contrato, devengo si el contrato está Activo y evento', async () => {
		const { db, service } = build();
		const result = await service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR);
		const [update] = db.statements('SET migrated_to_contract_id = $1');

		firstStatementIsWriter(db);
		expect(update.params).toEqual([CONTRACT, 'user-1', HOLDING, ['r-1', 'r-2']]);
		expect(db.statements('UPDATE invoices_legacy SET contract_id = $1')[0].params).toEqual([CONTRACT, HOLDING, ['i-1', 'i-2']]);
		expect(db.statements('revenue_schedule_rebuild')).toHaveLength(1);
		expect(db.statements('INSERT INTO onboarding_events')[0].params).toEqual(
			expect.arrayContaining([HOLDING, 'history_linked', rawLineKey(PARTS), 'contract', CONTRACT])
		);
		// Último mes vivo = 2026-05 (2026-06 está quitado): el contrato arranca en 2026-07 → hueco de 1 mes.
		expect(result.splice).toEqual({ gap_months: 1, overlap_months: 0, contract_first_month: '2026-07' });
		expect(db.committed()).toBe(1);
	});

	it('empalmar un borrador no reconstruye devengo (se arma al activarse)', async () => {
		const { db, service } = build([
			[
				'FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL',
				() => [{ id: CONTRACT, status: 'En revisión', client_id: CLIENT }],
			],
		]);

		await service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR);
		expect(db.statements('revenue_schedule_rebuild')).toHaveLength(0);
	});

	it('409 contract_other_client, 409 line_not_pending y 404 contrato fuera del holding (con rollback)', async () => {
		const other = build([['FROM contracts WHERE id = $1', () => [{ id: CONTRACT, status: 'Activo', client_id: OTHER_CLIENT }]]]);

		await expect(other.service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR)).rejects.toMatchObject({
			constructor: ConflictException,
			response: { code: 'contract_other_client' },
		});
		const noPending = build([
			[
				'm.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id',
				() => writeRows.filter((row) => row.migrated_to_contract_id || row.skip_activation),
			],
		]);

		await expect(noPending.service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR)).rejects.toMatchObject({
			response: { code: 'line_not_pending' },
		});
		const missing = build();

		await expect(missing.service.link(HOLDING, KEY, { contract_id: OTHER_CLIENT }, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
		expect(other.db.rolledBack() + noPending.db.rolledBack() + missing.db.rolledBack()).toBe(3);
	});

	it('cerrar (fue baja) marca churn solo en los pendientes; quitar marca duplicado/error en lo no empalmado y no quitado', async () => {
		const { db, service } = build();

		await service.close(HOLDING, KEY, {}, ACTOR);
		await service.remove(HOLDING, KEY, { reason: 'error' }, ACTOR);
		const [close, remove] = db.statements('SET skip_activation = true');

		expect(close.params).toEqual([HOLDING, ['r-1', 'r-2'], 'churn', 'Fue baja', 'user-1']);
		expect(remove.params).toEqual([HOLDING, ['r-1', 'r-2', 'r-4'], 'error', 'Error de carga', 'user-1']);
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[1])).toEqual(['history_closed', 'history_removed']);
	});

	it('reabrir devuelve a pendiente lo cerrado o quitado; desvincular libera el empalme y las facturas que solo lo respaldaban', async () => {
		const { db, service } = build();

		await service.reopen(HOLDING, KEY, ACTOR);
		await service.unlink(HOLDING, KEY, ACTOR);
		expect(db.statements('SET skip_activation = false')[0].params).toEqual([HOLDING, ['r-4', 'r-5']]);
		expect(db.statements('SET migrated_to_contract_id = NULL')[0].params).toEqual([HOLDING, ['r-3']]);
		expect(db.statements('UPDATE invoices_legacy il SET contract_id = NULL')[0].params).toEqual([HOLDING, ['i-3'], ['c-old']]);
	});
});

describe('contrato desde la línea', () => {
	const dto = {
		client_id: CLIENT,
		client_entity_id: CLIENT,
		company_id: CLIENT,
		contract_currency: 'USD',
		items: [
			{
				product_id: CLIENT,
				item_type: 'Fijo',
				quantity: 1,
				unit_price: 120,
				billing_frequency: 'Mensual',
				billing_method: 'Anticipado',
				start_date: '2026-07-01',
				term_months: 12,
			},
		],
		origin: { type: 'history', line_key: KEY },
	} as never;

	it('prellenado: un ítem con el MRR del último mes vivo, Mensual Anticipado, 12 meses, inicio = mes siguiente', async () => {
		const { service } = build([
			[
				'GROUP BY m.company_id',
				() => [{ company_id: 'co-1', client_entity_id: 'ce-1', mrr: '120.5', quantity: '2', rows: '1', has_quantity: true }],
			],
		]);
		const defaults = await service.contractDefaults(HOLDING, KEY);

		expect(defaults).toMatchObject({
			client_id: CLIENT,
			client_entity_id: 'ce-1',
			company_id: 'co-1',
			contract_currency: 'USD',
			items: [
				{
					quantity: 2,
					unit_price: 60.25,
					billing_frequency: 'Mensual',
					billing_method: 'Anticipado',
					term_months: 12,
					start_date: '2026-07-01',
				},
			],
			origin: { type: 'history', line_key: KEY },
		});
		// Contrato desde el histórico = Renovación (Domi 14-10).
		expect(defaults.items[0].category).toBe('RENEWAL');
		expect(defaults.warnings).toEqual(expect.arrayContaining([expect.stringContaining('no está en el catálogo')]));
	});

	it('crear: usa el generador común sin `origin`, empalma y deja el evento; si el empalme falla elimina el borrador', async () => {
		const { db, drafts, service } = build();
		const result = await service.createContract(HOLDING, KEY, dto, ACTOR);

		expect((drafts.create as jest.Mock).mock.calls[0][0]).not.toHaveProperty('origin');
		// Ítems en RENEWAL salvo categoría explícita.
		expect((drafts.create as jest.Mock).mock.calls[0][0].items[0].category).toBe('RENEWAL');
		const explicit = build();

		await explicit.service.createContract(
			HOLDING,
			KEY,
			{ ...(dto as object), items: [{ ...(dto as { items: object[] }).items[0], category: 'UPSELL' }] } as never,
			ACTOR
		);
		expect((explicit.drafts.create as jest.Mock).mock.calls[0][0].items[0].category).toBe('UPSELL');
		expect(result.contract).toEqual({ id: CONTRACT, contract_number: 'CTR-2026-9' });
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[1])).toEqual(['history_linked', 'history_contract_created']);

		const failing = build([['SET migrated_to_contract_id = $1', () => Promise.reject(new Error('boom'))]]);

		await expect(failing.service.createContract(HOLDING, KEY, dto, ACTOR)).rejects.toThrow('boom');
		expect(failing.drafts.remove).toHaveBeenCalledWith(CONTRACT, HOLDING, 'auth-1');
	});

	it('409 si el contrato es de otro cliente o la línea no tiene pendientes (no crea nada)', async () => {
		const { drafts, service } = build();

		await expect(service.createContract(HOLDING, KEY, { ...(dto as object), client_id: OTHER_CLIENT } as never, ACTOR)).rejects.toMatchObject({
			response: { code: 'contract_other_client' },
		});
		expect(drafts.create).not.toHaveBeenCalled();
	});
});

describe('editar línea = volver a registrar sus facturas (Domi 14-10)', () => {
	const P1 = '55555555-5555-4555-8555-555555555555';
	const P2 = '66666666-6666-4666-8666-666666666666';
	const INV_A = '77777777-7777-4777-8777-777777777777';
	const INV_B = '88888888-8888-4888-8888-888888888888';
	const editRow = (overrides: Record<string, unknown>): Record<string, unknown> => ({
		subtotal_contract_currency: '100',
		term: 1,
		is_recurring: true,
		mrr_legacy: '100',
		mrr_legacy_system_currency: '100',
		fx_contract_to_system: '1',
		allocated_invoice_currency: '95000',
		fx_contract_to_invoice: '950',
		invoice_currency: 'CLP',
		migrated_to_contract_id: null,
		migrated_at: null,
		migrated_by: null,
		skip_activation_reason: null,
		skip_activation_at: null,
		skip_activation_by: null,
		skip_code: null,
		...overrides,
	});
	/** Factura A: abril y mayo; factura B: junio. */
	const baseRows = [
		editRow({ id: 'r-a1', invoice_legacy_id: INV_A, invoice_number: 'F-A', period: '2026-04' }),
		editRow({ id: 'r-a2', invoice_legacy_id: INV_A, invoice_number: 'F-A', period: '2026-05' }),
		editRow({ id: 'r-b1', invoice_legacy_id: INV_B, invoice_number: 'F-B', period: '2026-06' }),
	];
	const input = (overrides: Record<string, unknown> = {}) => ({
		invoice_id: INV_A,
		period_from: '2026-04',
		period_to: '2026-06',
		contract_currency: 'USD',
		amount_contract_currency: 300,
		products: [{ product_id: P1, amount_contract_currency: 300 }],
		...overrides,
	});
	const invoiceRow = (id: string, number: string) => ({
		id,
		invoice_number: number,
		issue_date: '2026-04-01',
		company_id: 'co-1',
		legal_client_name: 'ACME',
		invoice_currency: 'CLP',
		amount_invoice_currency: '500000',
		total_invoice_currency: '595000',
		status: 'Pagada',
		client_id: CLIENT,
		item_id: `it-${number}`,
		item_subtotal: '500000',
		has_history: true,
	});
	const editHandlers = (rows = baseRows, covered: unknown[] = [], extra: Handler[] = []): Handler[] => [
		...extra,
		['m.migrated_to_contract_id, m.migrated_at, m.migrated_by', (params) => (params[2] === PARTS.product_name ? rows : [])],
		['LEFT JOIN LATERAL', (params) => (params[1] as string[]).map((id) => invoiceRow(id, id === INV_A ? 'F-A' : 'F-B'))],
		[
			'SELECT id, name FROM products WHERE holding_id = $1 AND id = ANY',
			() => [
				{ id: P1, name: PARTS.product_name },
				{ id: P2, name: 'Ruteo Pro' },
			],
		],
		['SELECT code FROM currencies', () => [{ code: 'USD' }, { code: 'CLP' }]],
		['SELECT DISTINCT m.client_id', () => covered],
		['AS max_split', () => [{ item_id: 'it-F-A', max_split: 2 }]],
		// Moneda de sistema con la regla del trigger: tasa 0,5 → mrr ÷ 0,5.
		[
			'unnest($2::text[], $3::text[])',
			(params) => (params[2] as string[]).map((month) => ({ currency: 'USD', month, system_currency: 'EUR', rate: '0.5' })),
		],
	];
	const coveredJune = [{ client_id: CLIENT, product_name: PARTS.product_name, contract_currency: 'USD', period: '2026-06' }];

	it('vista previa: regenera las filas de la factura con el motor de Registrar histórico; el mes de otra factura queda cubierto', async () => {
		const { db, service } = build(editHandlers(baseRows, coveredJune));
		const preview = await service.editPreview(HOLDING, KEY, { invoices: [input()] });
		const entries = preview.months.map((month) => [month.invoice_number, month.period_month, month.status]);

		expect(entries).toEqual([
			['F-A', '2026-04', 'changed'],
			['F-A', '2026-05', 'changed'],
			['F-B', '2026-06', 'kept'],
		]);
		// Tipo de cambio desde lo que la línea tenía asignado de la factura (95.000 × 2), no desde el neto completo: 190.000 ÷ 300.
		expect(preview.months[0]).toMatchObject({
			invoice_id: INV_A,
			subtotal_contract_currency: 100,
			mrr_contract_ccy: 100,
			mrr_system_ccy: 200,
			fx_contract_to_system: 0.5,
			invoice_currency: 'CLP',
			fx_contract_to_invoice: 633.333333,
		});
		expect(preview.months[2]).toMatchObject({ mrr_system_ccy: 100, fx_contract_to_system: 1 });
		expect(preview.warnings).toEqual([
			{
				code: 'month_already_covered',
				invoice_id: INV_A,
				period_month: '2026-06',
				message: '2026-06 ya está cubierto por otra factura de la línea',
			},
		]);
		expect(preview.totals).toEqual({ mrr_last_contract_ccy: 100, mrr_last_system_ccy: 100, system_currency: 'EUR' });
		expect(preview).toMatchObject({
			line: { key: KEY, first_month: '2026-04', last_month: '2026-06', months_count: 3 },
			rekey: null,
			lines_touched: [KEY],
		});
		// Los meses que se reemplazan no cuentan como cubiertos.
		expect(db.statements('SELECT DISTINCT m.client_id')[0].params[2]).toEqual(['r-a1', 'r-a2']);
		expect(db.statements('INSERT INTO')).toHaveLength(0);
	});

	it('vista previa: cambiar el producto de todas las facturas mueve la línea (rekey) y lo dice en lines_touched', async () => {
		const { service } = build(editHandlers());
		const preview = await service.editPreview(HOLDING, KEY, {
			invoices: [
				input({ period_to: '2026-05', amount_contract_currency: 200, products: [{ product_id: P2, amount_contract_currency: 200 }] }),
				input({
					invoice_id: INV_B,
					period_from: '2026-06',
					amount_contract_currency: 100,
					products: [{ product_id: P2, amount_contract_currency: 100 }],
				}),
			],
		});
		const to = encodeLineKey({ ...PARTS, product_name: 'Ruteo Pro' });

		expect(preview.rekey).toEqual({ from: KEY, to });
		expect(preview.lines_touched).toEqual([KEY, to]);
		expect(preview.line).toMatchObject({ key: to, product_name: 'Ruteo Pro', months_count: 3 });
		// Los meses existían en la línea de origen: pasan a la de destino como cambiados.
		expect(preview.months.map((month) => month.status)).toEqual(['changed', 'changed', 'changed']);
	});

	it('400 si la factura no es de la línea, está repetida o el motor la rechaza; avisos de tipo de cambio por factura', async () => {
		const { service } = build(editHandlers());

		await expect(service.editPreview(HOLDING, KEY, { invoices: [input({ invoice_id: CONTRACT })] })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.editPreview(HOLDING, KEY, { invoices: [input(), input()] })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.editPreview(HOLDING, KEY, { invoices: [input({ period_from: '2026-07' })] })).rejects.toMatchObject({
			response: { errors: [{ field: 'invoices.0', message: expect.stringContaining('Período inválido') }] },
		});
		// 190.000 CLP ÷ 190.000 USD = 1 con monedas distintas.
		const copied = await service.editPreview(HOLDING, KEY, {
			invoices: [
				input({ period_to: '2026-05', amount_contract_currency: 190000, products: [{ product_id: P1, amount_contract_currency: 190000 }] }),
			],
		});

		expect(copied.warnings.map((warning) => warning.code)).toEqual(['fx_one_with_different_currencies']);
	});

	it('aplicar: borra las filas de la factura en esta línea y las vuelve a registrar (split libre, mismo lote), con evento y lines_touched', async () => {
		const { db, service } = build(editHandlers(baseRows, coveredJune));
		const result = await service.editLine(HOLDING, KEY, { invoices: [input()] }, ACTOR);

		expect(db.calls.find((call) => /set_config/.test(call.sql))?.sql).toBe(API_WRITER_SQL);
		expect(db.statements('DELETE FROM mrr_legacy')[0].params).toEqual([HOLDING, ['r-a1', 'r-a2']]);
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		// Dos meses (junio está cubierto por la factura B), split_index después de los usados en la línea de factura (2 → 3).
		expect(insert.params.slice(0, 4)).toEqual([HOLDING, INV_A, 'it-F-A', 3]);
		expect(insert.params.slice(17, 26)).toEqual([190000, CLIENT, 'USD', 300, PARTS.product_name, 3, '2026-04-01', true, 633.333333]);
		expect(db.calls.findIndex((call) => call.sql.includes('DELETE FROM mrr_legacy'))).toBeLessThan(
			db.calls.findIndex((call) => call.sql.includes('INSERT INTO mrr_legacy'))
		);
		expect(db.statements("SET reconciliation_status = 'pending'")).toHaveLength(1);
		const events = db.statements('INSERT INTO onboarding_events');

		expect(events.map((call) => call.params[1])).toEqual(['history_registered', 'history_line_edited']);
		expect(JSON.parse(String(events[1].params[5]))).toMatchObject({ rows_removed: 2, lines_touched: [rawLineKey(PARTS)], rekey: null });
		expect(result).toMatchObject({ key: KEY, lines_touched: [KEY] });
		expect(db.committed()).toBe(1);
	});

	it('empalmadas: período y montos conservan el empalme; producto o moneda → 409 line_linked_rekey; la suma que no cuadra → 400', async () => {
		const linked = baseRows.map((row) =>
			row.invoice_legacy_id === INV_A
				? { ...row, migrated_to_contract_id: 'c-1', migrated_at: '2026-09-01T00:00:00Z', migrated_by: 'u-9' }
				: row
		);
		const ok = build(editHandlers(linked));

		await ok.service.editLine(
			HOLDING,
			KEY,
			{
				invoices: [
					input({ period_to: '2026-05', amount_contract_currency: 220, products: [{ product_id: P1, amount_contract_currency: 220 }] }),
				],
			},
			ACTOR
		);
		const [carry] = ok.db.statements('SET migrated_to_contract_id = $4');

		expect(carry.params).toEqual([HOLDING, expect.any(String), INV_A, 'c-1', '2026-09-01T00:00:00Z', 'u-9']);
		const blocked = build(editHandlers(linked));

		await expect(blocked.service.editLine(HOLDING, KEY, { invoices: [input({ contract_currency: 'CLP' })] }, ACTOR)).rejects.toMatchObject({
			constructor: ConflictException,
			response: { code: 'line_linked_rekey' },
		});
		expect(blocked.db.statements('DELETE FROM mrr_legacy')).toHaveLength(0);
		const preview = await build(editHandlers(linked)).service.editPreview(HOLDING, KEY, {
			invoices: [input({ products: [{ product_id: P2, amount_contract_currency: 300 }] })],
		});

		expect(preview.warnings.map((warning) => warning.code)).toContain('line_linked_rekey_blocked');
		const mismatch = build(editHandlers());

		await expect(
			mismatch.service.editLine(HOLDING, KEY, { invoices: [input({ products: [{ product_id: P1, amount_contract_currency: 100 }] })] }, ACTOR)
		).rejects.toMatchObject({ response: { errors: [{ field: 'invoices.0.products' }] } });
		expect(blocked.db.rolledBack() + mismatch.db.rolledBack()).toBe(2);
	});

	it('detalle: cada factura trae su registro actual en la línea para prellenar el formulario', async () => {
		const { service } = build([
			[
				'AS counted',
				() => [
					{
						id: 'r-a1',
						period_month: '2026-04',
						subtotal_contract_currency: '1200',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{
						id: 'r-a2',
						period_month: '2026-05',
						subtotal_contract_currency: '1200',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{ id: 'r-b1', period_month: '2026-06', subtotal_contract_currency: '90', term: 1, is_recurring: false, invoice_legacy_id: INV_B },
				],
			],
			[
				'FROM invoices_legacy il WHERE il.holding_id = $1 AND il.id IN',
				() => [
					{ id: INV_A, invoice_number: 'F-A' },
					{ id: INV_B, invoice_number: 'F-B' },
				],
			],
		]);
		const detail = await service.detail(HOLDING, KEY);

		expect(detail.invoices[0].registration).toEqual({
			period_from: '2026-04',
			period_to: '2026-05',
			amount_contract_currency: 200,
			is_recurring: true,
			contract_currency: 'USD',
			products: [{ product_id: null, product_name: PARTS.product_name, amount_contract_currency: 200 }],
		});
		expect(detail.invoices[1].registration).toMatchObject({
			period_from: '2026-06',
			period_to: '2026-06',
			amount_contract_currency: 90,
			is_recurring: false,
		});
	});
});

describe('costura: todo servicio del módulo que escribe lo hace con withApiWriter y nunca por autocommit', () => {
	it.each(fs.readdirSync(__dirname).filter((file) => file.endsWith('.service.ts')))('%s', (file) => {
		const source = fs.readFileSync(path.join(__dirname, file), 'utf8');

		expect(source).not.toMatch(/this\.dataSource\.query(<[^>]+>)?\(\s*`\s*(INSERT|UPDATE|DELETE)\b/);
		expect(source).not.toContain('startTransaction');
		expect(source).not.toContain(`set_config('sapira.writer'`);
		// Ninguna escritura del módulo dispara correos, notificaciones ni sincronizaciones.
		expect(source).not.toMatch(/NotificationsService|EmailsService|sendMail|OdooService|SalesforceService|modules\/integrations/);
	});
});

describe('resumen', () => {
	it('cuenta líneas por estado (cerradas y quitadas por separado), empalme por contrato, facturas previas y el inicio de la historia', async () => {
		const { db, service: history } = build([
			[
				'GROUP BY st.status',
				() => [
					{ status: 'pending', lines: '85', ended: '80' },
					{ status: 'linked', lines: '630', ended: '600' },
					{ status: 'closed', lines: '195', ended: '195' },
					{ status: 'removed', lines: '3', ended: '3' },
				],
			],
			['COUNT(DISTINCT m.client_id) AS clients', () => [{ clients: '196' }]],
			['AS contract_without_mrr', () => [{ gap: '28', overlap_cut: '83', contract_without_mrr: '12' }]],
			['AS vencida', () => [{ total: '10', linked: '3', without_history: '5', pagada: '6', enviada: '4', vencida: '0' }]],
			["'metrics_history_start'", () => [{ start: '2025-01-01' }]],
			['SELECT system_currency FROM holding_settings', () => [{ system_currency: 'USD' }]],
		]);
		const { OnboardingService } = await import('./onboarding.service');
		const summary = await new OnboardingService(db as unknown as DataSource, history).summary(HOLDING);

		expect(summary).toEqual({
			// Un solo estado pendiente: `pending` cuenta todas (85) y `pending_ended` las que ya terminaron (80).
			history: { lines: 913, pending: 85, pending_ended: 80, linked: 630, closed: 195, removed: 3, clients_without_contract: 196 },
			splice: { gap: 28, overlap_cut: 83, contract_without_mrr: 12 },
			// Domi 18-10: sin `pending`; sin y con histórico suman el total; `linked` = con contrato.
			previous_invoices: { total: 10, without_history: 5, with_history: 5, linked: 3, by_status: { Pagada: 6, Enviada: 4, Vencida: 0 } },
			settings: { metrics_history_start: '2025-01', system_currency: 'USD' },
		});
	});
});
