import { DataSource } from 'typeorm';

import { MetricsDataService } from './metrics-data.service';
import { aggregate, nextMonthStart, type SellerDeal, SellersMetricsService } from './sellers-metrics.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const LUIS = '33333333-3333-4333-8333-333333333333';

type Impl = (sql: string, params?: unknown[]) => unknown[];

function build(rows: Impl = () => []) {
	const query = jest.fn(async (sql: string, params?: unknown[]) =>
		sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : rows(sql, params)
	);
	const data = new MetricsDataService({ query } as unknown as DataSource);

	return { query, service: new SellersMetricsService(data) };
}

/** Fila de la base tal como la devuelve el SQL de negocios. */
const dealRow = (over: Record<string, unknown>) => ({
	id: 'q-1',
	quote_number: 'COT-1',
	seller_id: ANA,
	seller_name: 'Ana',
	client_id: 'c-1',
	client_name: 'Acme',
	quote_type: 'Nuevo cliente',
	stage: 'Enviada',
	stage_kind: 'sent',
	created_on: '2026-02-10',
	booking_date: null,
	amount: 1000,
	currency: 'USD',
	first_contract_on: null,
	contracts_count: 0,
	contract_ref: null,
	tcv: 0,
	mrr: 0,
	billed: 0,
	collected: 0,
	first_invoice_on: null,
	closed: false,
	lost: false,
	closed_on: null,
	...over,
});

const sellerRows = [
	{ id: ANA, name: 'Ana', is_active: true },
	{ id: LUIS, name: 'Luis', is_active: true },
	{ id: '44444444-4444-4444-8444-444444444444', name: 'Ex', is_active: false },
];

const db =
	(deals: Array<Record<string, unknown>>, noSeller = { contracts: 2, tcv: 500, mrr: 50, billed: 100, collected: 60 }): Impl =>
	(sql) =>
		sql.includes('FROM sellers s')
			? sellerRows
			: sql.includes('WITH links AS')
				? deals
				: sql.includes('FROM contracts c LEFT JOIN clients cl')
					? [noSeller]
					: [];

describe('aggregate (funnel de un conjunto de negocios)', () => {
	const period = { from: '2026-01-01', to: '2026-04-01' };
	const deals: SellerDeal[] = [
		// Creada y cerrada en el período, con contrato facturado y cobrado.
		{
			quote_id: 'a',
			quote_number: 'A',
			seller_id: ANA,
			seller_name: 'Ana',
			client_id: null,
			client_name: null,
			quote_type: null,
			stage: 'Firmada',
			stage_kind: 'signed',
			created_on: '2026-01-05',
			closed: true,
			lost: false,
			closed_on: '2026-01-25',
			amount: 100,
			currency: 'USD',
			contract: { id: 'k1', number: 'CTR-1' },
			contracts_count: 1,
			tcv: 1200,
			mrr: 100,
			billed: 300,
			collected: 200,
			first_invoice_on: '2026-02-01',
		},
		// Creada antes del período y cerrada dentro: cuenta como cerrada pero no como creada.
		{
			quote_id: 'b',
			quote_number: 'B',
			seller_id: ANA,
			seller_name: 'Ana',
			client_id: null,
			client_name: null,
			quote_type: null,
			stage: 'Enviada',
			stage_kind: 'sent',
			created_on: '2025-12-01',
			closed: true,
			lost: false,
			closed_on: '2026-03-10',
			amount: 100,
			currency: 'USD',
			contract: null,
			contracts_count: 0,
			tcv: 0,
			mrr: 0,
			billed: 0,
			collected: 0,
			first_invoice_on: null,
		},
		// Creada en el período, perdida.
		{
			quote_id: 'c',
			quote_number: 'C',
			seller_id: ANA,
			seller_name: 'Ana',
			client_id: null,
			client_name: null,
			quote_type: null,
			stage: 'Rechazada',
			stage_kind: 'lost',
			created_on: '2026-02-01',
			closed: false,
			lost: true,
			closed_on: null,
			amount: 100,
			currency: 'USD',
			contract: null,
			contracts_count: 0,
			tcv: 0,
			mrr: 0,
			billed: 0,
			collected: 0,
			first_invoice_on: null,
		},
		// Creada en el período, cerrada después del período: cuenta como creada, no como cerrada.
		{
			quote_id: 'd',
			quote_number: 'D',
			seller_id: ANA,
			seller_name: 'Ana',
			client_id: null,
			client_name: null,
			quote_type: null,
			stage: 'Firmada',
			stage_kind: 'signed',
			created_on: '2026-03-20',
			closed: true,
			lost: false,
			closed_on: '2026-04-02',
			amount: 100,
			currency: 'USD',
			contract: null,
			contracts_count: 0,
			tcv: 999,
			mrr: 9,
			billed: 9,
			collected: 9,
			first_invoice_on: null,
		},
	];

	it('cuenta creadas y cerradas por su propia fecha, suma el dinero solo de los cierres del período y promedia ciclo y días a la primera factura', () => {
		const row = aggregate(ANA, 'Ana', true, deals, period.from, period.to);

		expect(row).toEqual({
			seller_id: ANA,
			seller_name: 'Ana',
			is_active: true,
			created: 3,
			closed: 2,
			lost: 1,
			with_contract: 1,
			conversion: 0.667,
			tcv: 1200,
			mrr: 100,
			billed: 300,
			collected: 200,
			cycle_days: 59.5,
			days_to_first_invoice: 7,
		});
		expect(aggregate(null, 'Equipo', true, [], period.from, period.to)).toMatchObject({
			created: 0,
			closed: 0,
			conversion: null,
			cycle_days: null,
			days_to_first_invoice: null,
		});
		expect(nextMonthStart('2026-12')).toBe('2027-01-01');
	});
});

describe('SellersMetricsService', () => {
	it('funnel: una fila por vendedor activo (los inactivos solo con actividad), total del equipo con vendedores con ventas y "Sin vendedor"', async () => {
		const { service, query } = build(
			db([
				dealRow({
					id: 'q-1',
					created_on: '2026-02-10',
					closed: true,
					closed_on: '2026-02-20',
					contracts_count: 1,
					contract_ref: 'k1|CTR-9',
					tcv: 1200,
					mrr: 100,
					billed: 300,
					collected: 200,
					first_invoice_on: '2026-03-01',
				}),
				dealRow({ id: 'q-2', seller_id: LUIS, seller_name: 'Luis', created_on: '2026-02-11' }),
				dealRow({ id: 'q-3', seller_id: null, seller_name: null, created_on: '2026-02-12', closed: true, closed_on: '2026-02-13' }),
			])
		);
		const result = await service.funnel(HOLDING, { from: '2026-01', to: '2026-03' });

		expect(result.currency).toBe('USD');
		expect(result.rows.map((row) => [row.seller_name, row.created, row.closed, row.with_contract, row.tcv])).toEqual([
			['Ana', 1, 1, 1, 1200],
			['Luis', 1, 0, 0, 0],
		]);
		// El equipo solo suma negocios con vendedor; la cotización sin vendedor no entra.
		expect(result.team).toMatchObject({ created: 2, closed: 1, sellers_with_sales: 1, tcv: 1200, billed: 300, collected: 200 });
		expect(result.no_seller).toEqual({ contracts: 2, tcv: 500, mrr: 50, billed: 100, collected: 60 });
		const [sql, params] = query.mock.calls.find(([text]) => String(text).includes('WITH links AS')) as [string, unknown[]];

		// Cerrada = etapa firmada/contrato creado o contrato vinculado; vínculo por quote_id o por ítems; período como $-params.
		expect(sql).toContain("d.stage_kind IN ('signed', 'contract_created') OR d.contracts_count > 0");
		expect(sql).toContain('JOIN quote_items qi ON qi.id = ci.quote_item_id');
		expect(sql).toContain("i.status = 'Pagada'");
		expect(params.slice(0, 3)).toEqual([HOLDING, '2026-01-01', '2026-04-01']);
		expect(sql).not.toMatch(/\$\d+\s*$/);
	});

	it('funnel con sellerId: filtra cotizaciones y vendedores, y no calcula "Sin vendedor"', async () => {
		const { service, query } = build(db([dealRow({ created_on: '2026-02-10' })]));
		const result = await service.funnel(HOLDING, { from: '2026-02', to: '2026-02', sellerId: ANA });

		expect(result.rows.map((row) => row.seller_name)).toEqual(['Ana', 'Luis']);
		expect(result.no_seller).toEqual({ contracts: 0, tcv: 0, mrr: 0, billed: 0, collected: 0 });
		const dealsSql = String(query.mock.calls.find(([text]) => String(text).includes('WITH links AS'))?.[0]);

		expect(dealsSql).toContain('q.seller_id = ANY(');
		expect(query.mock.calls.some(([text]) => String(text).includes('FROM contracts c LEFT JOIN clients cl'))).toBe(false);
	});

	it('detalle de un vendedor: paginado, los cerrados en el período primero; `none` lista los contratos sin vendedor', async () => {
		const { service } = build(
			db(
				[
					dealRow({ id: 'q-1', quote_number: 'COT-1', created_on: '2026-02-10' }),
					dealRow({
						id: 'q-2',
						quote_number: 'COT-2',
						created_on: '2026-01-10',
						closed: true,
						closed_on: '2026-02-20',
						contracts_count: 1,
						contract_ref: 'k1|CTR-9',
						tcv: 1200,
					}),
					dealRow({ id: 'q-3', quote_number: 'COT-3', created_on: '2026-02-12', closed: true, closed_on: '2026-05-01' }),
				],
				{
					id: 'k2',
					contract_number: 'CTR-2',
					client_name: 'Beta',
					contract_on: '2026-02-01',
					tcv: 50,
					mrr: 5,
					billed: 10,
					collected: 0,
				} as never
			)
		);
		const page = await service.sellerDeals(HOLDING, ANA, { from: '2026-01', to: '2026-03', page: 1, limit: 2 });

		expect(page).toMatchObject({ currency: 'USD', total: 3, pages: 2, currentPage: 1, limit: 2 });
		expect(page.data.map((deal) => (deal as { quote_number: string }).quote_number)).toEqual(['COT-2', 'COT-3']);
		expect(page.data[0]).toMatchObject({ contract: { id: 'k1', number: 'CTR-9' }, closed_in_period: true, tcv: 1200 });
		const none = await service.sellerDeals(HOLDING, 'none', { from: '2026-01', to: '2026-03' });

		expect(none.data).toEqual([
			{ contract: { id: 'k2', number: 'CTR-2' }, client_name: 'Beta', contract_on: '2026-02-01', tcv: 50, mrr: 5, billed: 10, collected: 0 },
		]);
	});
});
