import * as fs from 'fs';
import * as path from 'path';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { API_WRITER_SQL } from '@/modules/contracts/api-writer';
import type { ContractDraftsService } from '@/modules/contracts/contract-drafts.service';
import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import {
	decodeLineKey,
	decodeRootKey,
	encodeLineKey,
	encodeRootKey,
	eventDto,
	ONBOARDING_EVENT_TYPES,
	parseRawLineKey,
	rawLineKey,
	rawRootKey,
	rootOf,
} from './onboarding-common';
import { OnboardingHistoryService } from './onboarding-history.service';
import { candidateScore, lineCtes, lineDto, spliceOf } from './onboarding-lines';
import { OnboardingRegisterService } from './onboarding-register.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';
const CONTRACT = '44444444-4444-4444-8444-444444444444';
const OTHER_CONTRACT = '99999999-9999-4999-8999-999999999999';
const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BATCH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
/** Registro sin contrato: `batch_id` × cliente × moneda (clave de 4 partes con contrato vacío). */
const PARTS = { batch_id: BATCH, client_id: CLIENT, contract_currency: 'USD', contract_id: null };
const KEY = encodeLineKey(PARTS);
/** Registro de la misma raíz relacionado con `CONTRACT`. */
const LINKED_PARTS = { ...PARTS, contract_id: CONTRACT };
const LINKED_KEY = encodeLineKey(LINKED_PARTS);
const ROOT_KEY = encodeRootKey(PARTS);
/** Otro registro pendiente del mismo cliente y moneda (otro `batch_id`): lo que "Unificar" junta. */
const OTHER_PARTS = { ...PARTS, batch_id: OTHER_BATCH };
const OTHER_KEY = encodeLineKey(OTHER_PARTS);
const PRODUCT_A = 'PATHFINDER+ / Rutas|MX';
const PRODUCT_B = 'Soporte';

/** Productos del registro como los devuelve `pj.products` (json_agg, ordenados por MRR del último mes). */
const products = [
	{
		product_name: PRODUCT_A,
		product_id: null,
		first_month: '2025-01',
		last_month: '2026-06',
		months_count: 18,
		mrr_last: '90.5',
		mrr_last_system: '90.5',
	},
	{
		product_name: PRODUCT_B,
		product_id: 'p-b',
		first_month: '2026-01',
		last_month: '2026-06',
		months_count: 6,
		mrr_last: '30',
		mrr_last_system: '30',
	},
];

const lineRow = (overrides: Record<string, unknown> = {}) => ({
	batch_id: BATCH,
	client_id: CLIENT,
	contract_currency: 'USD',
	contract_id: null,
	first_month: '2025-01',
	last_month: '2026-06',
	live_last_month: '2026-06',
	months_count: '18',
	mrr_last: '120.5',
	mrr_last_system: '120.5',
	status: 'pending',
	has_after_contract: false,
	invoices_count: '18',
	skip_reason: null,
	legal_names: '{"ACME SpA","ACME Ltda"}',
	registered_at: new Date('2026-09-01T12:00:00Z'),
	products,
	client_name: 'ACME',
	...overrides,
});

/**
 * Filas de la raíz para escribir: 2 pendientes (productos A y B), 1 empalmada con `CONTRACT`, 1 no activada (churn). Con el modelo por
 * registro la base devuelve solo las del registro pedido: `lockLine` filtra por `migrated_to_contract_id IS NULL` o `= $5`.
 */
const writeRows = [
	{
		id: 'r-1',
		period: '2026-04',
		product_name: PRODUCT_A,
		migrated_to_contract_id: null,
		skip_activation: false,
		skip_code: null,
		invoice_legacy_id: 'i-1',
	},
	{
		id: 'r-2',
		period: '2026-05',
		product_name: PRODUCT_B,
		migrated_to_contract_id: null,
		skip_activation: false,
		skip_code: null,
		invoice_legacy_id: 'i-2',
	},
	{
		id: 'r-3',
		period: '2026-03',
		product_name: PRODUCT_A,
		migrated_to_contract_id: CONTRACT,
		skip_activation: false,
		skip_code: null,
		invoice_legacy_id: 'i-3',
	},
	{
		id: 'r-4',
		period: '2026-02',
		product_name: PRODUCT_A,
		migrated_to_contract_id: null,
		skip_activation: true,
		skip_code: 'churn',
		invoice_legacy_id: 'i-4',
	},
];
/** Lo que devolvería la base para el registro de la clave: `params[4]` es el contrato (solo en la clave de un registro relacionado). */
const recordRowsOf = (params: unknown[]) =>
	writeRows.filter((row) => (params[4] ? row.migrated_to_contract_id === params[4] : !row.migrated_to_contract_id));

function build(handlers: Handler[] = [], contractDrafts: Partial<ContractDraftsService> = {}) {
	const db = fakeDb([
		...handlers,
		['m.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id', recordRowsOf],
		// El registro leído tras escribir: `params[4]` es el contrato de la clave → registro relacionado.
		[
			'SELECT st.batch_id',
			(params) => [
				lineRow(params[4] ? { status: 'linked', contract_id: params[4], contract_number: 'CTR-2026-9', contract_status: 'Activo' } : {}),
			],
		],
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

describe('clave de registro (batch_id × cliente × moneda × contrato) y raíz (Domi 18-10, definitivo)', () => {
	it('se codifica para la URL y vuelve igual; el registro sin contrato termina en `|` vacío', () => {
		expect(KEY).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(decodeLineKey(KEY)).toEqual(PARTS);
		expect(parseRawLineKey(rawLineKey(PARTS))).toEqual(PARTS);
		expect(rawLineKey(PARTS)).toBe(`${BATCH}|${CLIENT}|USD|`);
	});

	it('la clave de un registro relacionado lleva el contrato; la raíz es la de 3 partes y se guarda en los eventos', () => {
		expect(decodeLineKey(LINKED_KEY)).toEqual(LINKED_PARTS);
		expect(rawLineKey(LINKED_PARTS)).toBe(`${BATCH}|${CLIENT}|USD|${CONTRACT}`);
		expect(rawRootKey(LINKED_PARTS)).toBe(`${BATCH}|${CLIENT}|USD`);
		expect(rootOf(LINKED_PARTS)).toEqual({ batch_id: BATCH, client_id: CLIENT, contract_currency: 'USD' });
		expect(encodeRootKey(LINKED_PARTS)).toBe(ROOT_KEY);
		expect(LINKED_KEY).not.toBe(KEY);
		// La raíz se acepta para buscar eventos, venga como registro o como raíz.
		expect(decodeRootKey(LINKED_KEY)).toEqual(rootOf(PARTS));
		expect(decodeRootKey(ROOT_KEY)).toEqual(rootOf(PARTS));
	});

	it('clave rota, de 3 partes, con la forma anterior (cliente|producto|moneda) o sin uuid → 400 (nunca llega SQL con una clave inválida)', () => {
		expect(() => decodeLineKey('no es base64!')).toThrow(BadRequestException);
		expect(() => decodeLineKey(ROOT_KEY)).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from(`${CLIENT}|PATHFINDER+|USD|`).toString('base64url'))).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from(`${BATCH}|${CLIENT}|US|`).toString('base64url'))).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from(`${BATCH}|${CLIENT}|USD|no-uuid`).toString('base64url'))).toThrow(BadRequestException);
		expect(() => decodeLineKey(Buffer.from(`${BATCH}|${CLIENT}|USD||`).toString('base64url'))).toThrow(BadRequestException);
		expect(() => decodeRootKey(Buffer.from(`${CLIENT}|PATHFINDER+|USD`).toString('base64url'))).toThrow(BadRequestException);
		expect(parseRawLineKey(`${BATCH}|${CLIENT}|USD`)).toBeNull();
		// El campo del error dice qué clave falló.
		expect(() => decodeLineKey('x', 'keys.1')).toThrow(
			expect.objectContaining({ response: { message: 'Registro inválido', errors: [{ field: 'keys.1', message: expect.any(String) }] } })
		);
	});

	it('eventDto devuelve la raíz (3 partes) sea cual sea el registro desde el que se escribió; una clave con otra forma sale null', () => {
		expect(eventDto({ id: 'e-1', type: 'history_linked', line_key: rawRootKey(PARTS), payload: {} }).line_key).toBe(ROOT_KEY);
		expect(eventDto({ id: 'e-2', type: 'history_linked', line_key: rawLineKey(LINKED_PARTS), payload: {} }).line_key).toBe(ROOT_KEY);
		expect(eventDto({ id: 'e-3', type: 'history_linked', line_key: `${CLIENT}|PATHFINDER+|USD`, payload: {} }).line_key).toBeNull();
		// Sin "Quitar" (Domi 18-10); con "Unificar".
		expect(ONBOARDING_EVENT_TYPES).not.toContain('history_removed');
		expect(ONBOARDING_EVENT_TYPES).toContain('history_unified');
	});
});

describe('estado derivado y empalme', () => {
	it('un registro = batch_id × cliente × moneda × contrato, con uno o varios productos y un solo estado: con contrato es relacionada; sin contrato, pendiente > no activada', () => {
		const sql = lineCtes({ holding: '$1' }).replace(/\s+/g, ' ');

		// El agregado y el último mes vivo van por registro (el contrato entra en el GROUP BY y en la partición), nunca por producto.
		expect(sql).toContain('GROUP BY x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id');
		expect(sql).toContain('OVER (PARTITION BY m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id) AS live_last');
		expect(sql).toContain(
			'OVER (PARTITION BY m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id, m.product_name) AS product_live_last'
		);
		// Productos dentro del registro: uno por nombre, con su último mes vivo, ordenados por MRR.
		expect(sql).toContain('GROUP BY x.batch_id, x.client_id, x.contract_currency, x.migrated_to_contract_id, x.product_name');
		expect(sql).toContain("json_build_object('product_name', p.product_name, 'product_id', (SELECT pr.id FROM products pr");
		expect(sql).toContain('ORDER BY p.mrr_last DESC, p.product_name) AS products');
		// Tres estados, sin `removed` ni `ended`.
		expect(sql).toContain("CASE WHEN l.contract_id IS NOT NULL THEN 'linked' WHEN l.has_pending THEN 'pending' ELSE 'closed' END AS status");
		expect(sql).toContain('BOOL_OR(NOT x.skip_activation) AS has_pending');
		expect(sql).not.toContain("'removed'");
		expect(sql).not.toContain('AS ended');
		expect(sql).not.toContain('has_closed');
		// Sin interpretar el texto libre (Domi 18-10): marcada sin código = "No activado" (churn). MRR = cada producto en su último mes vivo.
		expect(sql).not.toContain('ILIKE');
		expect(sql).toContain("COALESCE(to_jsonb(m) ->> 'skip_reason_code', 'churn')");
		expect(sql).toContain('FILTER (WHERE x.period_month = x.product_live_last AND NOT x.removed), 0) AS mrr_last');
		expect(sql).not.toContain('x.period_month = x.live_last');
		expect(sql).toContain('MIN(x.created_at) AS registered_at');
	});

	it('lineDto: clave del registro, raíz, productos (dos, ordenados por MRR) con mrr_last sumado, contrato, razones sociales y fecha de registro', () => {
		const dto = lineDto(lineRow());

		expect(dto).toMatchObject({
			key: KEY,
			root_key: ROOT_KEY,
			batch_id: BATCH,
			client: { id: CLIENT, name: 'ACME' },
			currency: 'USD',
			status: 'pending',
			contract: null,
			mrr_last: 120.5,
			mrr_last_system: 120.5,
			invoices_count: 18,
			legal_names: ['ACME SpA', 'ACME Ltda'],
			registered_at: '2026-09-01T12:00:00.000Z',
			issues: [],
			skip_reason: null,
		});
		expect(dto.products).toEqual([
			{
				product_name: PRODUCT_A,
				product_id: null,
				first_month: '2025-01',
				last_month: '2026-06',
				months_count: 18,
				mrr_last: 90.5,
				mrr_last_system: 90.5,
			},
			{
				product_name: PRODUCT_B,
				product_id: 'p-b',
				first_month: '2026-01',
				last_month: '2026-06',
				months_count: 6,
				mrr_last: 30,
				mrr_last_system: 30,
			},
		]);
		expect(dto.products.reduce((sum, product) => sum + product.mrr_last, 0)).toBe(dto.mrr_last);
		expect(dto).not.toHaveProperty('ended');
		expect(dto).not.toHaveProperty('skip_reason_code');
		expect(dto).not.toHaveProperty('product_name');
		// `products` también llega como texto JSON.
		expect(lineDto(lineRow({ products: JSON.stringify(products.slice(1)) })).products).toHaveLength(1);
		const linked = lineDto(lineRow({ status: 'linked', contract_id: CONTRACT, contract_number: 'CTR-1', contract_status: 'Activo' }));

		expect(linked).toMatchObject({ key: LINKED_KEY, root_key: ROOT_KEY, status: 'linked', contract: { id: CONTRACT, contract_number: 'CTR-1' } });
	});

	it('una raíz con meses en dos contratos y meses sueltos son tres registros con estado puro y claves distintas, misma raíz (Avon CARD, Logytech en prod)', () => {
		const records = [
			lineRow({ status: 'linked', contract_id: CONTRACT, contract_number: 'CTR-1', contract_status: 'Activo' }),
			lineRow({ status: 'linked', contract_id: OTHER_CONTRACT, contract_number: 'CTR-2', contract_status: 'Activo' }),
			lineRow({ status: 'pending', contract_id: null }),
		].map(lineDto);

		expect(records.map((record) => record.status)).toEqual(['linked', 'linked', 'pending']);
		expect(records.map((record) => record.contract?.contract_number ?? null)).toEqual(['CTR-1', 'CTR-2', null]);
		expect(new Set(records.map((record) => record.key)).size).toBe(3);
		expect(records.map((record) => record.root_key)).toEqual([ROOT_KEY, ROOT_KEY, ROOT_KEY]);
		expect(records.filter((record) => record.status === 'pending' && record.contract)).toHaveLength(0);
	});

	it('un batch_id con varios clientes (cargas masivas) son registros distintos por cliente, sin tocar datos', () => {
		const [a, b] = [lineRow(), lineRow({ client_id: OTHER_CLIENT, client_name: 'Otro' })].map(lineDto);

		expect(a.batch_id).toBe(b.batch_id);
		expect(a.key).not.toBe(b.key);
		expect(a.root_key).not.toBe(b.root_key);
		expect(decodeLineKey(b.key)).toEqual({ ...PARTS, client_id: OTHER_CLIENT });
	});

	it('compañías emisoras del registro (Domi 18-10): distintas company_id de sus filas, como arreglo o texto JSON', () => {
		const sql = lineCtes({ holding: '$1' }).replace(/\s+/g, ' ');

		expect(sql).toContain('ARRAY_AGG(DISTINCT x.company_id) FILTER (WHERE x.company_id IS NOT NULL) AS company_ids');
		const companies = [
			{ id: CONTRACT, legal_name: 'SimpliRoute SpA' },
			{ id: OTHER_CLIENT, legal_name: null },
		];

		expect(lineDto(lineRow({ companies })).companies).toEqual(companies);
		expect(lineDto(lineRow({ companies: JSON.stringify(companies.slice(0, 1)) })).companies).toEqual(companies.slice(0, 1));
		expect(lineDto(lineRow()).companies).toEqual([]);
	});

	it('hueco, mes de empalme y meses después del inicio del contrato (Domi 18-10): solo lo posterior es un problema', () => {
		const exact = { gap_months: 0, seam_month: null, months_after_contract: [], contract_first_month: '2026-07' };

		expect(spliceOf('2026-06', '2026-07', ['2026-05', '2026-06'])).toEqual(exact);
		expect(spliceOf('2026-03', '2026-07', ['2026-03'])).toMatchObject({ gap_months: 3, seam_month: null, months_after_contract: [] });
		expect(spliceOf('2026-07', '2026-07', ['2026-06', '2026-07'])).toEqual({ ...exact, seam_month: '2026-07' });
		expect(spliceOf('2026-09', '2026-07', ['2026-09', '2026-07', '2026-08', '2026-09'])).toEqual({
			...exact,
			seam_month: '2026-07',
			months_after_contract: ['2026-08', '2026-09'],
		});
		expect(spliceOf(null, '2026-07', [])).toEqual(exact);
	});

	it('problemas del registro: histórico empalmado después del primer mes con MRR del contrato (recurrente, no quitado)', () => {
		const sql = lineCtes({ holding: '$1' }).replace(/\s+/g, ' ');

		expect(sql).toContain('FROM mrr_legacy m LEFT JOIN first_rsm f ON f.contract_id = m.migrated_to_contract_id');
		expect(sql).toContain('AND (f.first_month IS NOT NULL AND m.period_month > f.first_month)) AS after_contract');
		expect(sql).toContain('BOOL_OR(x.after_contract) AS has_after_contract');
		expect(lineDto(lineRow({ has_after_contract: true })).issues).toEqual(['history_after_contract']);
		expect(lineDto(lineRow({ has_after_contract: false })).issues).toEqual([]);
	});

	it('candidatos: alguno de los productos del registro, misma moneda y arranque justo al mes siguiente suben el puntaje', () => {
		const line = { products: [PRODUCT_A, PRODUCT_B], currency: 'USD', last_month: '2026-06' };

		expect(candidateScore(line, { products: ['soporte'], currency: 'USD', first_month: '2026-07' })).toBe(4);
		expect(candidateScore(line, { products: ['Otro'], currency: 'CLF', first_month: '2026-09' })).toBe(0);
	});
});

describe('lecturas', () => {
	it('lista: cliente, lote y contrato sobre las filas; estado, producto (registros que lo contienen) y búsqueda sobre el registro; orden por lista blanca', async () => {
		const { db, service } = build([['COUNT(*) OVER ()', () => [{ ...lineRow(), total_count: '1' }]]]);
		const result = await service.list(HOLDING, {
			status: 'pending,closed',
			clientId: CLIENT,
			product: PRODUCT_B,
			batchId: BATCH,
			contractId: CONTRACT,
			search: 'acme',
			sortBy: 'mrr',
			sortOrder: 'desc',
		});
		const [call] = db.statements('COUNT(*) OVER ()');

		expect(result).toMatchObject({ total: 1, currentPage: 1, pages: 1, limit: 25 });
		expect(result.data[0].key).toBe(KEY);
		expect(call.sql).toContain('m.client_id = $2');
		expect(call.sql).toContain('m.batch_id = $3');
		expect(call.sql).toContain('m.migrated_to_contract_id = $4');
		expect(call.sql).toContain('st.status = ANY($5::text[])');
		expect(call.sql).toContain('$6 = ANY(pj.product_names)');
		expect(call.sql).toContain("array_to_string(pj.product_names, ' ') ILIKE $7");
		expect(call.sql).toContain('ORDER BY st.mrr_last_system DESC');
		expect(call.params).toEqual([HOLDING, CLIENT, BATCH, CONTRACT, ['pending', 'closed'], PRODUCT_B, '%acme%']);
		// Sin filtro por producto sobre las filas: el agregado es de todo el registro.
		expect(call.sql).not.toContain('m.product_name = $');
	});

	it('orden por defecto: prioridad de estado (pendiente → relacionada → no activada) y cliente; sin `ended`', async () => {
		const { db, service } = build([['COUNT(*) OVER ()', () => []]]);

		await service.list(HOLDING, {});
		await service.list(HOLDING, { sortBy: 'product' });
		const [byDefault, byProduct] = db.statements('COUNT(*) OVER ()');

		expect(byDefault.sql).toContain(
			"ORDER BY CASE st.status WHEN 'pending' THEN 0 WHEN 'linked' THEN 1 ELSE 2 END ASC NULLS LAST, cl.name_commercial"
		);
		expect(byDefault.sql).not.toContain('st.ended');
		expect(byProduct.sql).toContain('ORDER BY pj.top_product ASC NULLS LAST');
	});

	it('filtro issue=history_after_contract: registros con histórico después del inicio de su contrato', async () => {
		const { db, service } = build([['COUNT(*) OVER ()', () => []]]);

		await service.list(HOLDING, { issue: 'history_after_contract' });
		await service.list(HOLDING, {});
		const [filtered, plain] = db.statements('COUNT(*) OVER ()');

		expect(filtered.sql).toContain('WHERE st.has_after_contract');
		expect(plain.sql).not.toContain('WHERE st.has_after_contract');
	});

	it('registro de otro holding (sin filas) → 404', async () => {
		const { service } = build([['SELECT st.batch_id', () => []]]);

		await expect(service.line(HOLDING, KEY)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('toda lectura por clave acota al registro: lote, cliente, moneda y sin contrato (IS NULL) o con el contrato de la clave; el detalle trae los eventos de la raíz', async () => {
		const { db, service } = build();

		await service.detail(HOLDING, KEY);
		await service.detail(HOLDING, LINKED_KEY);
		const [pending, linked] = db.statements('SELECT st.batch_id');
		const [pendingMonths, linkedMonths] = db.statements('AS counted');
		const [pendingEvents, linkedEvents] = db.statements('FROM onboarding_events e');

		expect(pending.sql).toContain('m.batch_id = $2 AND m.client_id = $3 AND m.contract_currency = $4 AND m.migrated_to_contract_id IS NULL');
		expect(pending.params).toEqual([HOLDING, BATCH, CLIENT, 'USD']);
		expect(linked.sql).toContain('m.migrated_to_contract_id = $5');
		expect(linked.params).toEqual([HOLDING, BATCH, CLIENT, 'USD', CONTRACT]);
		expect(pendingMonths.sql).toContain('m.migrated_to_contract_id IS NULL');
		expect(pendingMonths.sql).toContain('m.product_name');
		expect(linkedMonths.sql).toContain('m.migrated_to_contract_id = $5');
		expect(linkedMonths.params).toEqual([HOLDING, BATCH, CLIENT, 'USD', CONTRACT]);
		// El historial es de la raíz: la misma desde cualquiera de sus registros.
		expect(pendingEvents.params).toEqual([HOLDING, rawRootKey(PARTS)]);
		expect(linkedEvents.params).toEqual([HOLDING, rawRootKey(PARTS)]);
	});
});

describe('escrituras', () => {
	const firstStatementIsWriter = (db: ReturnType<typeof fakeDb>) =>
		expect(db.calls.find((call) => /set_config/.test(call.sql))?.sql).toBe(API_WRITER_SQL);

	it('relacionar: todas las filas pendientes del registro sin contrato (los dos productos), facturas sin contrato, devengo si está Activo, evento de la raíz; devuelve el registro relacionado', async () => {
		const { db, service } = build();
		const result = await service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR);
		const [update] = db.statements('SET migrated_to_contract_id = $1');

		firstStatementIsWriter(db);
		expect(db.statements('FOR UPDATE')[0].sql).toContain('m.migrated_to_contract_id IS NULL');
		expect(update.params).toEqual([CONTRACT, 'user-1', HOLDING, ['r-1', 'r-2']]);
		expect(db.statements('UPDATE invoices_legacy SET contract_id = $1')[0].params).toEqual([CONTRACT, HOLDING, ['i-1', 'i-2']]);
		expect(db.statements('revenue_schedule_rebuild')).toHaveLength(1);
		const [event] = db.statements('INSERT INTO onboarding_events');

		expect(event.params).toEqual(expect.arrayContaining([HOLDING, 'history_linked', rawRootKey(PARTS), 'contract', CONTRACT]));
		expect(JSON.parse(String(event.params[5]))).toMatchObject({ rows: 2, products: [PRODUCT_A, PRODUCT_B] });
		// Último mes empalmado = 2026-05: el contrato arranca en 2026-07 → hueco de 1 mes.
		expect(result.splice).toEqual({ gap_months: 1, seam_month: null, months_after_contract: [], contract_first_month: '2026-07' });
		// La respuesta es el registro relacionado resultante (clave nueva, misma raíz).
		expect(result.line).toMatchObject({ key: LINKED_KEY, root_key: ROOT_KEY, status: 'linked', contract: { id: CONTRACT } });
		expect(db.committed()).toBe(1);
	});

	it('relacionar suma los meses que el contrato ya tenía en la raíz al empalme del registro relacionado', async () => {
		const { service } = build([['SELECT DISTINCT to_char(m.period_month', () => [{ period: '2026-03' }, { period: '2026-07' }]]]);
		const result = await service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR);

		expect(result.splice).toEqual({ gap_months: 0, seam_month: '2026-07', months_after_contract: [], contract_first_month: '2026-07' });
	});

	it('relacionar, no activar, reabrir y crear contrato rechazan la clave de un registro relacionado (409) sin tocar la base', async () => {
		const { db, service } = build();

		await expect(service.link(HOLDING, LINKED_KEY, { contract_id: CONTRACT }, ACTOR)).rejects.toMatchObject({
			response: { code: 'line_not_pending' },
		});
		await expect(service.close(HOLDING, LINKED_KEY, {}, ACTOR)).rejects.toMatchObject({ response: { code: 'line_not_pending' } });
		await expect(service.reopen(HOLDING, LINKED_KEY, ACTOR)).rejects.toMatchObject({ response: { code: 'line_not_closed' } });
		await expect(service.createContract(HOLDING, LINKED_KEY, { client_id: CLIENT, items: [] } as never, ACTOR)).rejects.toMatchObject({
			response: { code: 'line_not_pending' },
		});
		expect(db.calls).toHaveLength(0);
		// "Quitar" ya no existe (Domi 18-10): un duplicado se corrige con "Editar línea".
		expect((service as unknown as Record<string, unknown>).remove).toBeUndefined();
	});

	it('relacionar un borrador no reconstruye devengo (se arma al activarse)', async () => {
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
				() => writeRows.filter((row) => !row.migrated_to_contract_id && row.skip_activation),
			],
		]);

		await expect(noPending.service.link(HOLDING, KEY, { contract_id: CONTRACT }, ACTOR)).rejects.toMatchObject({
			response: { code: 'line_not_pending' },
		});
		const missing = build();

		await expect(missing.service.link(HOLDING, KEY, { contract_id: OTHER_CLIENT }, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
		expect(other.db.rolledBack() + noPending.db.rolledBack() + missing.db.rolledBack()).toBe(3);
	});

	it('no activar marca churn (siempre) con la nota opcional solo en los pendientes; reabrir devuelve a pendiente lo no activado', async () => {
		const { db, service } = build();

		await service.close(HOLDING, KEY, { notes: 'Se fue a la competencia' }, ACTOR);
		await service.close(HOLDING, KEY, {}, ACTOR);
		await service.reopen(HOLDING, KEY, ACTOR);
		const [withNote, plain] = db.statements('SET skip_activation = true');

		expect(withNote.sql).toContain("skip_reason_code = 'churn'");
		expect(withNote.params).toEqual([HOLDING, ['r-1', 'r-2'], 'Se fue a la competencia', 'user-1']);
		expect(plain.params).toEqual([HOLDING, ['r-1', 'r-2'], null, 'user-1']);
		expect(db.statements('SET skip_activation = false')[0].params).toEqual([HOLDING, ['r-4']]);
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[1])).toEqual([
			'history_closed',
			'history_closed',
			'history_reopened',
		]);
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[2])).toEqual(Array(3).fill(rawRootKey(PARTS)));
	});

	it('desvincular (sobre el registro relacionado) libera el empalme y las facturas que solo lo respaldaban y devuelve el registro sin contrato', async () => {
		const { db, service } = build();
		const result = await service.unlink(HOLDING, LINKED_KEY, ACTOR);

		expect(db.statements('FOR UPDATE')[0].sql).toContain('m.migrated_to_contract_id = $5');
		expect(db.statements('SET migrated_to_contract_id = NULL')[0].params).toEqual([HOLDING, ['r-3']]);
		expect(db.statements('UPDATE invoices_legacy il SET contract_id = NULL')[0].params).toEqual([HOLDING, ['i-3'], [CONTRACT]]);
		expect(db.statements('INSERT INTO onboarding_events')[0].params).toEqual(expect.arrayContaining(['history_unlinked', rawRootKey(PARTS)]));
		expect(result).toMatchObject({ key: KEY, status: 'pending', contract: null });
		await expect(service.unlink(HOLDING, KEY, ACTOR)).rejects.toMatchObject({ response: { code: 'line_not_linked' } });
	});
});

describe('unificar registros pendientes (Domi 18-10)', () => {
	it('las filas de los demás toman el batch_id del primero, los eventos de sus raíces se re-clavan y queda un evento; devuelve el registro resultante', async () => {
		const { db, service } = build();
		const result = await service.unify(HOLDING, { keys: [KEY, OTHER_KEY, OTHER_KEY] }, ACTOR);
		const locks = db.statements('FOR UPDATE');

		expect(db.calls.find((call) => /set_config/.test(call.sql))?.sql).toBe(API_WRITER_SQL);
		// Un lock por registro distinto (la clave repetida se ignora), siempre sin contrato.
		expect(locks).toHaveLength(2);
		expect(locks.map((call) => call.params[1])).toEqual([BATCH, OTHER_BATCH]);
		expect(db.statements('UPDATE mrr_legacy SET batch_id = $3')[0].params).toEqual([HOLDING, ['r-1', 'r-2', 'r-4'], BATCH]);
		expect(db.statements('UPDATE onboarding_events SET line_key = $3')[0].params).toEqual([
			HOLDING,
			[rawRootKey(OTHER_PARTS)],
			rawRootKey(PARTS),
		]);
		const [event] = db.statements('INSERT INTO onboarding_events');

		expect(event.params.slice(1, 3)).toEqual(['history_unified', rawRootKey(PARTS)]);
		expect(JSON.parse(String(event.params[5]))).toEqual({ batch_id: BATCH, merged_batch_ids: [OTHER_BATCH], rows: 3, records: 2 });
		expect(result).toMatchObject({ key: KEY, status: 'pending' });
		expect(db.committed()).toBe(1);
	});

	it('400 con menos de dos registros distintos o una clave rota; 409 unify_mismatch (otro cliente o moneda) y record_not_pending (relacionado o sin pendientes), sin tocar la base', async () => {
		const { db, service } = build();

		await expect(service.unify(HOLDING, { keys: [KEY, KEY] }, ACTOR)).rejects.toMatchObject({ response: { errors: [{ field: 'keys' }] } });
		await expect(service.unify(HOLDING, { keys: [KEY, 'rota'] }, ACTOR)).rejects.toMatchObject({ response: { errors: [{ field: 'keys.1' }] } });
		await expect(
			service.unify(HOLDING, { keys: [KEY, encodeLineKey({ ...OTHER_PARTS, client_id: OTHER_CLIENT })] }, ACTOR)
		).rejects.toMatchObject({
			response: { code: 'unify_mismatch' },
		});
		await expect(
			service.unify(HOLDING, { keys: [KEY, encodeLineKey({ ...OTHER_PARTS, contract_currency: 'CLP' })] }, ACTOR)
		).rejects.toMatchObject({
			response: { code: 'unify_mismatch' },
		});
		await expect(service.unify(HOLDING, { keys: [KEY, LINKED_KEY] }, ACTOR)).rejects.toMatchObject({ response: { code: 'record_not_pending' } });
		expect(db.calls).toHaveLength(0);
		// El segundo registro existe pero está todo no activado: no se unifica.
		const closed = build([
			[
				'm.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id',
				(params) => (params[1] === OTHER_BATCH ? writeRows.filter((row) => row.skip_activation) : recordRowsOf(params)),
			],
		]);

		await expect(closed.service.unify(HOLDING, { keys: [KEY, OTHER_KEY] }, ACTOR)).rejects.toMatchObject({
			response: { code: 'record_not_pending' },
		});
		expect(closed.db.statements('UPDATE mrr_legacy')).toHaveLength(0);
		expect(closed.db.rolledBack()).toBe(1);
	});
});

describe('contrato desde el registro', () => {
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
		origin: { type: 'history', record_key: KEY },
	} as never;
	const perProduct: Handler = [
		'GROUP BY m.product_name',
		() => [
			{ product_name: PRODUCT_A, mrr: '90.5', quantity: '2', rows: '1', has_quantity: true },
			{ product_name: PRODUCT_B, mrr: '30', quantity: null, rows: '1', has_quantity: false },
		],
	];

	it('prellenado: un ítem por producto con el MRR y la cantidad de su último mes vivo, Mensual Anticipado, 12 meses, inicio = mes siguiente', async () => {
		const { service } = build([['GROUP BY m.company_id', () => [{ company_id: 'co-1', client_entity_id: 'ce-1', mrr: '120.5' }]], perProduct]);
		const defaults = await service.contractDefaults(HOLDING, KEY);

		expect(defaults).toMatchObject({
			client_id: CLIENT,
			client_entity_id: 'ce-1',
			company_id: 'co-1',
			contract_currency: 'USD',
			products: [PRODUCT_A, PRODUCT_B],
			origin: { type: 'history', record_key: KEY },
		});
		expect(defaults.items).toEqual([
			expect.objectContaining({
				key: 'history-1',
				product_id: null,
				product_name: PRODUCT_A,
				quantity: 2,
				unit_price: 45.25,
				start_date: '2026-07-01',
			}),
			expect.objectContaining({
				key: 'history-2',
				product_id: 'p-b',
				product_name: PRODUCT_B,
				quantity: 1,
				unit_price: 30,
				start_date: '2026-07-01',
			}),
		]);
		// Contrato desde el histórico = Renovación (Domi 14-10), Mensual Anticipado, 12 meses.
		expect(defaults.items.map((item) => [item.category, item.billing_frequency, item.billing_method, item.term_months])).toEqual([
			['RENEWAL', 'Mensual', 'Anticipado', 12],
			['RENEWAL', 'Mensual', 'Anticipado', 12],
		]);
		expect(defaults.warnings).toEqual([expect.stringContaining(`"${PRODUCT_A}" no está en el catálogo`)]);
	});

	it('crear: usa el generador común sin `origin` ni `products`, empalma todos los productos y deja el evento; si el empalme falla elimina el borrador', async () => {
		const { db, drafts, service } = build();
		const result = await service.createContract(HOLDING, KEY, dto, ACTOR);
		const sent = (drafts.create as jest.Mock).mock.calls[0][0];

		expect(sent).not.toHaveProperty('origin');
		expect(sent).not.toHaveProperty('products');
		expect(sent.items[0].category).toBe('RENEWAL');
		const explicit = build();

		await explicit.service.createContract(
			HOLDING,
			KEY,
			{ ...(dto as object), items: [{ ...(dto as { items: object[] }).items[0], category: 'UPSELL' }] } as never,
			ACTOR
		);
		expect((explicit.drafts.create as jest.Mock).mock.calls[0][0].items[0].category).toBe('UPSELL');
		expect(result.contract).toEqual({ id: CONTRACT, contract_number: 'CTR-2026-9' });
		expect(db.statements('SET migrated_to_contract_id = $1')[0].params).toEqual([CONTRACT, 'user-1', HOLDING, ['r-1', 'r-2']]);
		// Devuelve el registro relacionado nuevo (misma raíz × contrato creado).
		expect(result.line).toMatchObject({ key: LINKED_KEY, root_key: ROOT_KEY, status: 'linked', contract: { id: CONTRACT } });
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[1])).toEqual(['history_linked', 'history_contract_created']);
		expect(db.statements('INSERT INTO onboarding_events').map((call) => call.params[2])).toEqual([rawRootKey(PARTS), rawRootKey(PARTS)]);
		expect(JSON.parse(String(db.statements('INSERT INTO onboarding_events')[1].params[5]))).toMatchObject({
			origin: { type: 'history', record_key: rawLineKey(PARTS) },
			products: null,
		});

		const failing = build([['SET migrated_to_contract_id = $1', () => Promise.reject(new Error('boom'))]]);

		await expect(failing.service.createContract(HOLDING, KEY, dto, ACTOR)).rejects.toThrow('boom');
		expect(failing.drafts.remove).toHaveBeenCalledWith(CONTRACT, HOLDING, 'auth-1');
	});

	it('`products` deja un producto fuera: solo sus filas se empalman (el resto sigue pendiente); un producto ajeno al registro → 400', async () => {
		const { db, service } = build();

		await service.createContract(HOLDING, KEY, { ...(dto as object), products: [PRODUCT_B] } as never, ACTOR);
		expect(db.statements('SET migrated_to_contract_id = $1')[0].params).toEqual([CONTRACT, 'user-1', HOLDING, ['r-2']]);
		expect(JSON.parse(String(db.statements('INSERT INTO onboarding_events')[1].params[5]))).toMatchObject({ products: [PRODUCT_B] });
		const unknown = build();

		await expect(unknown.service.createContract(HOLDING, KEY, { ...(dto as object), products: ['Otro'] } as never, ACTOR)).rejects.toMatchObject({
			response: { errors: [{ field: 'products.0' }] },
		});
		expect(unknown.drafts.create).not.toHaveBeenCalled();
		// Solo productos sin pendientes → 409.
		await expect(
			unknown.service.createContract(HOLDING, KEY, { ...(dto as object), products: [PRODUCT_A] } as never, ACTOR)
		).resolves.toBeTruthy();
		const nothing = build([
			[
				'm.migrated_to_contract_id, m.skip_activation, m.invoice_legacy_id',
				() => writeRows.filter((row) => row.id === 'r-4' || row.id === 'r-2'),
			],
		]);

		await expect(
			nothing.service.createContract(HOLDING, KEY, { ...(dto as object), products: [PRODUCT_A] } as never, ACTOR)
		).rejects.toMatchObject({
			response: { code: 'line_not_pending' },
		});
	});

	it('vista previa: la de Contratos + el empalme de los productos elegidos', async () => {
		const { db, service } = build([['SELECT DISTINCT to_char(m.period_month', () => [{ period: '2026-04' }, { period: '2026-05' }]]]);
		const preview = await service.contractPreview(HOLDING, KEY, { ...(dto as object), products: [PRODUCT_B] } as never);

		expect(preview.splice).toEqual({ gap_months: 1, seam_month: null, months_after_contract: [], contract_first_month: '2026-07' });
		const [months] = db.statements('SELECT DISTINCT to_char(m.period_month');

		expect(months.sql).toContain('lower(btrim(m.product_name)) = ANY($5::text[])');
		expect(months.params).toEqual([HOLDING, BATCH, CLIENT, 'USD', ['soporte']]);
	});

	it('409 si el contrato es de otro cliente o el registro no tiene pendientes (no crea nada)', async () => {
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
		product_name: PRODUCT_A,
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
		// Filas del registro pedido: solo el de la moneda USD (el de destino al cambiar la moneda está vacío).
		['m.migrated_to_contract_id, m.migrated_at, m.migrated_by', (params) => (params[3] === 'USD' ? rows : [])],
		['LEFT JOIN LATERAL', (params) => (params[1] as string[]).map((id) => invoiceRow(id, id === INV_A ? 'F-A' : 'F-B'))],
		[
			'SELECT id, name FROM products WHERE holding_id = $1 AND id = ANY',
			() => [
				{ id: P1, name: PRODUCT_A },
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
	const coveredJune = [{ client_id: CLIENT, product_name: PRODUCT_A, contract_currency: 'USD', period: '2026-06' }];

	it('vista previa: regenera las filas de la factura con el motor de Registrar histórico; el mes de otra factura queda cubierto', async () => {
		const { db, service } = build(editHandlers(baseRows, coveredJune));
		const preview = await service.editPreview(HOLDING, KEY, { invoices: [input()] });
		const entries = preview.months.map((month) => [month.invoice_number, month.period_month, month.status]);

		expect(entries).toEqual([
			['F-A', '2026-04', 'changed'],
			['F-A', '2026-05', 'changed'],
			['F-B', '2026-06', 'kept'],
		]);
		// Tipo de cambio desde lo que el registro tenía asignado de la factura (95.000 × 2), no desde el neto completo: 190.000 ÷ 300.
		expect(preview.months[0]).toMatchObject({
			invoice_id: INV_A,
			subtotal_contract_currency: 100,
			mrr_contract_ccy: 100,
			mrr_system_ccy: 200,
			fx_contract_to_system: 0.5,
			invoice_currency: 'CLP',
			fx_contract_to_invoice: 633.333333,
			products: [PRODUCT_A],
		});
		expect(preview.months[2]).toMatchObject({ mrr_system_ccy: 100, fx_contract_to_system: 1 });
		expect(preview.warnings).toEqual([
			{
				code: 'month_already_covered',
				invoice_id: INV_A,
				period_month: '2026-06',
				message: '2026-06 ya está cubierto por otra factura del registro',
			},
		]);
		expect(preview.totals).toEqual({ mrr_last_contract_ccy: 100, mrr_last_system_ccy: 100, system_currency: 'EUR' });
		expect(preview).toMatchObject({
			line: {
				key: KEY,
				batch_id: BATCH,
				currency: 'USD',
				products: [{ product_name: PRODUCT_A, product_id: null, mrr_last: 100 }],
				first_month: '2026-04',
				last_month: '2026-06',
				months_count: 3,
			},
			rekey: null,
			lines_touched: [KEY],
		});
		// Los meses que se reemplazan no cuentan como cubiertos.
		expect(db.statements('SELECT DISTINCT m.client_id')[0].params[2]).toEqual(['r-a1', 'r-a2']);
		expect(db.statements('INSERT INTO')).toHaveLength(0);
	});

	it('vista previa: cambiar el producto no mueve el registro (vive dentro: el mes sale `changed`); cambiar la moneda de todas las facturas sí (rekey)', async () => {
		const { service } = build(editHandlers());
		const product = await service.editPreview(HOLDING, KEY, {
			invoices: [input({ period_to: '2026-05', amount_contract_currency: 200, products: [{ product_id: P2, amount_contract_currency: 200 }] })],
		});

		expect(product.rekey).toBeNull();
		expect(product.lines_touched).toEqual([KEY]);
		expect(product.line.products.map((value) => value.product_name)).toEqual([PRODUCT_A, 'Ruteo Pro']);
		expect(product.months.map((month) => [month.period_month, month.status, month.products])).toEqual([
			['2026-04', 'changed', ['Ruteo Pro']],
			['2026-05', 'changed', ['Ruteo Pro']],
			['2026-06', 'kept', [PRODUCT_A]],
		]);
		const currency = await service.editPreview(HOLDING, KEY, {
			invoices: [
				input({
					period_to: '2026-05',
					contract_currency: 'CLP',
					amount_contract_currency: 190000,
					products: [{ product_id: P1, amount_contract_currency: 190000 }],
				}),
				input({
					invoice_id: INV_B,
					period_from: '2026-06',
					contract_currency: 'CLP',
					amount_contract_currency: 95000,
					products: [{ product_id: P1, amount_contract_currency: 95000 }],
				}),
			],
		});
		const to = encodeLineKey({ ...PARTS, contract_currency: 'CLP' });

		expect(currency.rekey).toEqual({ from: KEY, to });
		expect(currency.lines_touched).toEqual([KEY, to]);
		expect(currency.line).toMatchObject({ key: to, batch_id: BATCH, currency: 'CLP', months_count: 3 });
		expect(currency.months.map((month) => month.status)).toEqual(['changed', 'changed', 'changed']);
	});

	it('400 si la factura no es del registro, está repetida o el motor la rechaza; avisos de tipo de cambio por factura', async () => {
		const { service } = build(editHandlers());

		await expect(service.editPreview(HOLDING, KEY, { invoices: [input({ invoice_id: CONTRACT })] })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.editPreview(HOLDING, KEY, { invoices: [input(), input()] })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.editPreview(HOLDING, KEY, { invoices: [input({ period_from: '2026-07' })] })).rejects.toMatchObject({
			response: { errors: [{ field: 'invoices.0', message: expect.stringContaining('Período inválido') }] },
		});
		const copied = await service.editPreview(HOLDING, KEY, {
			invoices: [
				input({ period_to: '2026-05', amount_contract_currency: 190000, products: [{ product_id: P1, amount_contract_currency: 190000 }] }),
			],
		});

		expect(copied.warnings.map((warning) => warning.code)).toEqual(['fx_one_with_different_currencies']);
	});

	it('aplicar: borra las filas de la factura en este registro y las vuelve a registrar con el mismo batch_id (split libre), con evento y lines_touched', async () => {
		const { db, service } = build(editHandlers(baseRows, coveredJune));
		const result = await service.editLine(HOLDING, KEY, { invoices: [input()] }, ACTOR);

		expect(db.calls.find((call) => /set_config/.test(call.sql))?.sql).toBe(API_WRITER_SQL);
		expect(db.statements('DELETE FROM mrr_legacy')[0].params).toEqual([HOLDING, ['r-a1', 'r-a2']]);
		const [insert] = db.statements('INSERT INTO mrr_legacy');

		// Dos meses (junio está cubierto por la factura B), split_index después de los usados en la línea de factura (2 → 3), mismo lote.
		expect(insert.params.slice(0, 4)).toEqual([HOLDING, INV_A, 'it-F-A', 3]);
		expect(insert.params.slice(17, 26)).toEqual([190000, CLIENT, 'USD', 300, PRODUCT_A, 3, '2026-04-01', true, 633.333333]);
		expect(insert.params[29]).toBe(BATCH);
		expect(insert.sql).toContain('RETURNING id');
		expect(db.calls.findIndex((call) => call.sql.includes('DELETE FROM mrr_legacy'))).toBeLessThan(
			db.calls.findIndex((call) => call.sql.includes('INSERT INTO mrr_legacy'))
		);
		expect(db.statements("SET reconciliation_status = 'pending'")).toHaveLength(1);
		const events = db.statements('INSERT INTO onboarding_events');

		expect(events.map((call) => call.params[1])).toEqual(['history_registered', 'history_line_edited']);
		expect(events.map((call) => call.params[2])).toEqual([rawRootKey(PARTS), rawRootKey(PARTS)]);
		expect(JSON.parse(String(events[1].params[5]))).toMatchObject({
			batch_id: BATCH,
			rows_removed: 2,
			lines_touched: [rawLineKey(PARTS)],
			rekey: null,
		});
		expect(result).toMatchObject({ key: KEY, lines_touched: [KEY] });
		expect(db.committed()).toBe(1);
	});

	it('registro relacionado: período, montos y productos conservan el empalme (solo en las filas recién insertadas); moneda → 409 line_linked_rekey; la suma que no cuadra → 400', async () => {
		const linked = baseRows.map((row) => ({
			...row,
			migrated_to_contract_id: CONTRACT,
			migrated_at: '2026-09-01T00:00:00Z',
			migrated_by: 'u-9',
		}));
		const ok = build([['INSERT INTO mrr_legacy', () => [{ id: 'n-1' }, { id: 'n-2' }]], ...editHandlers(linked)]);
		const edited = await ok.service.editLine(
			HOLDING,
			LINKED_KEY,
			{
				invoices: [
					input({ period_to: '2026-05', amount_contract_currency: 220, products: [{ product_id: P2, amount_contract_currency: 220 }] }),
				],
			},
			ACTOR
		);
		const [carry] = ok.db.statements('SET migrated_to_contract_id = $5');

		expect(ok.db.statements('FOR UPDATE')[0].sql).toContain('m.migrated_to_contract_id = $5');
		expect(carry.sql).toContain('AND id = ANY($4::uuid[])');
		expect(carry.params).toEqual([HOLDING, BATCH, INV_A, ['n-1', 'n-2'], CONTRACT, '2026-09-01T00:00:00Z', 'u-9']);
		// Sigue en el mismo registro (clave con el contrato) y el evento va a la raíz.
		expect(edited).toMatchObject({ key: LINKED_KEY, lines_touched: [LINKED_KEY] });
		expect(ok.db.statements('INSERT INTO onboarding_events').at(-1)?.params[2]).toBe(rawRootKey(PARTS));
		const blocked = build(editHandlers(linked));

		await expect(
			blocked.service.editLine(
				HOLDING,
				LINKED_KEY,
				{
					invoices: [
						input({
							contract_currency: 'CLP',
							amount_contract_currency: 190000,
							products: [{ product_id: P1, amount_contract_currency: 190000 }],
						}),
					],
				},
				ACTOR
			)
		).rejects.toMatchObject({ constructor: ConflictException, response: { code: 'line_linked_rekey' } });
		expect(blocked.db.statements('DELETE FROM mrr_legacy')).toHaveLength(0);
		const preview = await build(editHandlers(linked)).service.editPreview(HOLDING, LINKED_KEY, {
			invoices: [
				input({
					contract_currency: 'CLP',
					amount_contract_currency: 190000,
					products: [{ product_id: P1, amount_contract_currency: 190000 }],
				}),
			],
		});

		expect(preview.warnings.map((warning) => warning.code)).toContain('line_linked_rekey_blocked');
		const mismatch = build(editHandlers());

		await expect(
			mismatch.service.editLine(HOLDING, KEY, { invoices: [input({ products: [{ product_id: P1, amount_contract_currency: 100 }] })] }, ACTOR)
		).rejects.toMatchObject({ response: { errors: [{ field: 'invoices.0.products' }] } });
		expect(blocked.db.rolledBack() + mismatch.db.rolledBack()).toBe(2);
	});

	it('detalle: cada factura trae su registro actual (período, total y un producto por nombre con su parte) para prellenar el formulario; meses con producto', async () => {
		const { service } = build([
			[
				'AS counted',
				() => [
					{
						id: 'r-a1',
						period_month: '2026-04',
						product_name: PRODUCT_A,
						subtotal_contract_currency: '1200',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{
						id: 'r-a2',
						period_month: '2026-04',
						product_name: PRODUCT_B,
						subtotal_contract_currency: '240',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{
						id: 'r-a3',
						period_month: '2026-05',
						product_name: PRODUCT_A,
						subtotal_contract_currency: '1200',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{
						id: 'r-a4',
						period_month: '2026-05',
						product_name: PRODUCT_B,
						subtotal_contract_currency: '240',
						term: 12,
						is_recurring: true,
						invoice_legacy_id: INV_A,
					},
					{
						id: 'r-b1',
						period_month: '2026-06',
						product_name: PRODUCT_A,
						subtotal_contract_currency: '90',
						term: 1,
						is_recurring: false,
						invoice_legacy_id: INV_B,
					},
				],
			],
			[
				'FROM invoices_legacy il WHERE il.holding_id = $1 AND il.id IN',
				() => [
					{ id: INV_A, invoice_number: 'F-A' },
					{ id: INV_B, invoice_number: 'F-B' },
				],
			],
			['SELECT id, name FROM products WHERE holding_id = $1 ORDER BY created_at', () => [{ id: 'p-b', name: ' soporte ' }]],
		]);
		const detail = await service.detail(HOLDING, KEY);

		expect(detail.invoices[0].registration).toEqual({
			period_from: '2026-04',
			period_to: '2026-05',
			amount_contract_currency: 240,
			is_recurring: true,
			contract_currency: 'USD',
			products: [
				{ product_id: null, product_name: PRODUCT_A, amount_contract_currency: 200 },
				{ product_id: 'p-b', product_name: PRODUCT_B, amount_contract_currency: 40 },
			],
		});
		expect(detail.invoices[1].registration).toMatchObject({
			period_from: '2026-06',
			period_to: '2026-06',
			amount_contract_currency: 90,
			is_recurring: false,
		});
		expect(detail.months.map((month) => [month.period_month, month.product_name, month.state])).toEqual([
			['2026-04', PRODUCT_A, 'pending'],
			['2026-04', PRODUCT_B, 'pending'],
			['2026-05', PRODUCT_A, 'pending'],
			['2026-05', PRODUCT_B, 'pending'],
			['2026-06', PRODUCT_A, 'pending'],
		]);
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

describe('resumen y eventos', () => {
	it('cuenta registros por estado (tres estados, sin removed ni pending_ended), empalme por contrato, facturas previas y el inicio de la historia', async () => {
		const { db } = build([
			[
				'GROUP BY st.status',
				() => [
					{ status: 'pending', records: '68' },
					{ status: 'linked', records: '692' },
					{ status: 'closed', records: '200' },
				],
			],
			['AS contract_without_mrr', () => [{ gap: '28', contract_without_mrr: '12' }]],
			['AS seam_months', () => [{ seam_months: '70', after_months: '40', after_records: '15', after_contracts: '13' }]],
			['AS vencida', () => [{ total: '10', linked: '3', adopted: '2', without_history: '5', pagada: '6', enviada: '4', vencida: '0' }]],
			["'metrics_history_start'", () => [{ start: '2025-01-01' }]],
			['SELECT system_currency FROM holding_settings', () => [{ system_currency: 'USD' }]],
		]);
		const { OnboardingService } = await import('./onboarding.service');
		const summary = await new OnboardingService(db as unknown as DataSource).summary(HOLDING);

		expect(summary).toEqual({
			history: { records: 960, pending: 68, linked: 692, closed: 200 },
			splice: { gap: 28, seam_months: 70, history_after_contract: { months: 40, records: 15, contracts: 13 }, contract_without_mrr: 12 },
			previous_invoices: {
				total: 10,
				without_history: 5,
				with_history: 5,
				linked: 3,
				adopted: 2,
				by_status: { Pagada: 6, Enviada: 4, Vencida: 0 },
			},
			settings: { metrics_history_start: '2025-01', system_currency: 'USD' },
		});
		const [seams] = db.statements('AS seam_months');

		expect(seams.sql).toContain(
			'COUNT(DISTINCT (m.batch_id, m.client_id, m.contract_currency, m.migrated_to_contract_id)) FILTER (WHERE (f.first_month IS NOT NULL AND m.period_month = f.first_month)) AS seam_months'
		);
		expect(seams.sql).toContain('FILTER (WHERE (f.first_month IS NOT NULL AND m.period_month > f.first_month)) AS after_contracts');
		expect(db.statements('GROUP BY st.status')[0].params).toEqual([HOLDING]);
	});

	it('GET /onboarding/events?lineKey= busca por la raíz, venga la clave de un registro relacionado, del sin contrato o la raíz misma', async () => {
		const { db } = build();
		const { OnboardingService } = await import('./onboarding.service');
		const service = new OnboardingService(db as unknown as DataSource);

		await service.events(HOLDING, { lineKey: LINKED_KEY });
		await service.events(HOLDING, { lineKey: KEY });
		await service.events(HOLDING, { lineKey: ROOT_KEY });
		const calls = db.statements('FROM onboarding_events e');

		expect(calls).toHaveLength(3);
		expect(calls.map((call) => call.params[1])).toEqual([rawRootKey(PARTS), rawRootKey(PARTS), rawRootKey(PARTS)]);
		expect(calls[0].sql).toContain('e.line_key = $2');
		await expect(service.events(HOLDING, { lineKey: 'rota' })).rejects.toBeInstanceOf(BadRequestException);
	});
});
