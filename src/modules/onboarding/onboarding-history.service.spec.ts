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
	status: 'pending_ended',
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

	return { db, drafts, service: new OnboardingHistoryService(db as unknown as DataSource, drafts) };
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
	it('precedencia del estado en SQL: pendiente (terminada si su último mes pasó) > empalmada > cerrada > quitada', () => {
		const sql = lineCtes({ holding: '$1', today: '$2' }).replace(/\s+/g, ' ');

		expect(sql).toContain(
			"CASE WHEN l.has_pending THEN CASE WHEN l.last_date < $2::date THEN 'pending_ended' ELSE 'pending' END WHEN l.has_linked THEN 'linked' WHEN l.has_closed THEN 'closed' ELSE 'removed' END"
		);
		// Lectura tolerante del texto libre y MRR del último mes sin las filas quitadas.
		expect(sql).toContain("ILIKE '%duplic%'");
		expect(sql).toContain('x.period_month = x.live_last AND NOT x.removed');
	});

	it('lineDto: clave codificada, contrato y lotes', () => {
		const dto = lineDto(lineRow({ status: 'linked', contract_id: CONTRACT, contract_number: 'CTR-1', contract_status: 'Activo' }));

		expect(dto.key).toBe(KEY);
		expect(dto).toMatchObject({ status: 'linked', mrr_last: 120.5, batch_ids: ['b-1'], contract: { id: CONTRACT, contract_number: 'CTR-1' } });
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

	it('editar meses: 400 si un mes no es de la línea; si cambia, escribe mrr_legacy explícito y deja evento con antes/después', async () => {
		const month = { id: 'r-1', subtotal_contract_currency: '100', is_recurring: true, term: 1, period: '2026-04' };
		const { db, service } = build([['AND m.id = ANY($5::uuid[])', () => [month]]]);

		await expect(service.editMonths(HOLDING, KEY, { months: [{ id: 'r-9', subtotal_contract_currency: 1 }] }, ACTOR)).rejects.toBeInstanceOf(
			BadRequestException
		);
		await service.editMonths(HOLDING, KEY, { months: [{ id: 'r-1', subtotal_contract_currency: 150 }] }, ACTOR);
		const [update] = db.statements('UPDATE mrr_legacy SET subtotal_contract_currency');

		expect(update.sql).toContain('mrr_legacy = CASE WHEN $4 THEN round($3::numeric / term, 2)');
		expect(update.params).toEqual(['r-1', HOLDING, 150, true]);
		expect(JSON.parse(String(db.statements('INSERT INTO onboarding_events')[0].params[5]))).toMatchObject({
			months: [{ id: 'r-1', before: { subtotal_contract_currency: 100 }, after: { subtotal_contract_currency: 150 } }],
		});
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
		expect(defaults.warnings).toEqual(expect.arrayContaining([expect.stringContaining('no está en el catálogo')]));
	});

	it('crear: usa el generador común sin `origin`, empalma y deja el evento; si el empalme falla elimina el borrador', async () => {
		const { db, drafts, service } = build();
		const result = await service.createContract(HOLDING, KEY, dto, ACTOR);

		expect((drafts.create as jest.Mock).mock.calls[0][0]).not.toHaveProperty('origin');
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
	it('cuenta líneas por estado, empalme por contrato, facturas previas y el inicio de la historia', async () => {
		const { db, service: history } = build([
			[
				'GROUP BY st.status',
				() => [
					{ status: 'pending_ended', lines: '80' },
					{ status: 'linked', lines: '630' },
					{ status: 'removed', lines: '3' },
				],
			],
			['COUNT(DISTINCT m.client_id) AS clients', () => [{ clients: '196' }]],
			['AS contract_without_mrr', () => [{ gap: '28', overlap_cut: '83', contract_without_mrr: '12' }]],
			['AS vencida', () => [{ total: '10', pending: '4', linked: '3', pagada: '6', enviada: '4', vencida: '0' }]],
			["'metrics_history_start'", () => [{ start: '2025-01-01' }]],
			['SELECT system_currency FROM holding_settings', () => [{ system_currency: 'USD' }]],
		]);
		const { OnboardingService } = await import('./onboarding.service');
		const summary = await new OnboardingService(db as unknown as DataSource, history).summary(HOLDING);

		expect(summary).toEqual({
			history: { lines: 713, pending: 0, pending_ended: 80, linked: 630, closed: 0, removed: 3, clients_without_contract: 196 },
			splice: { gap: 28, overlap_cut: 83, contract_without_mrr: 12 },
			previous_invoices: { total: 10, pending: 4, linked: 3, by_status: { Pagada: 6, Enviada: 4, Vencida: 0 } },
			settings: { metrics_history_start: '2025-01', system_currency: 'USD' },
		});
	});
});
