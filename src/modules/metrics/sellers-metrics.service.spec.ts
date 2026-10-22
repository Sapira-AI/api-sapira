import { DataSource } from 'typeorm';

import { MetricsDataService } from './metrics-data.service';
import { aggregate, daysBetween, dealTypeOf, nextMonthStart, type SellerDeal, SellersMetricsService, trend } from './sellers-metrics.service';

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

/** Fila de la base tal como la devuelve el SQL de negocios cerrados. */
const dealRow = (over: Record<string, unknown>) => ({
	id: 'q-1',
	quote_number: 'COT-1',
	seller_id: ANA,
	seller_name: 'Ana',
	client_id: 'c-1',
	client_name: 'Acme',
	quote_type: 'Nuevo cliente',
	stage: 'Firmada',
	stage_kind: 'signed',
	booking_date: '2026-02-10',
	closed_on: '2026-02-10',
	amount: 1000,
	currency: 'USD',
	contracts_count: 1,
	started_on: '2026-02-20',
	contract_ref: 'k1|CTR-9|Activo',
	contract_cancelled: false,
	items_count: 2,
	items_without_mrr: 0,
	mrr_new: 150,
	mrr_replaced: 0,
	billed: 300,
	collected: 150,
	periods: 2,
	paid_periods: 1,
	invoices_cancelled: 0,
	first_invoice_on: '2026-03-01',
	first_payment_on: null,
	...over,
});

const sellerRows = [
	{ id: ANA, name: 'Ana', is_active: true },
	{ id: LUIS, name: 'Luis', is_active: true },
	{ id: '44444444-4444-4444-8444-444444444444', name: 'Ex', is_active: false },
];

const db =
	(
		deals: Array<Record<string, unknown>>,
		noSeller: Record<string, unknown> = { contracts: 2, mrr: 50, billed: 100, collected: 60, contracts_cancelled: 1 }
	): Impl =>
	(sql) =>
		sql.includes('FROM sellers s') ? sellerRows : sql.includes('WITH items AS') ? deals : sql.includes('WITH base AS') ? [noSeller] : [];

describe('reglas puras del panel de vendedores v2', () => {
	it('familia de tipo, días entre fechas y tope del período', () => {
		expect(dealTypeOf('new_business')).toBe('new_business');
		expect(dealTypeOf('cross_sell')).toBe('upsell');
		expect(dealTypeOf('downsell')).toBe('downsell');
		expect(dealTypeOf('renewal')).toBe('other');
		expect(dealTypeOf(null)).toBe('other');
		expect(daysBetween('2026-01-05', '2026-01-25')).toBe(20);
		expect(daysBetween('2026-01-05', null)).toBeNull();
		expect(nextMonthStart('2026-12')).toBe('2027-01-01');
	});

	it('aggregate: conteos por tipo, MRR sumando solo los que lo tienen (downsell negativo), sin facturar, % pagado, promedios y reversiones', () => {
		const base: SellerDeal = {
			quote_id: 'a',
			quote_number: 'A',
			seller_id: ANA,
			seller_name: 'Ana',
			client_id: null,
			client_name: null,
			quote_type: 'Nuevo cliente',
			type_code: 'new_business',
			type: 'new_business',
			type_label: 'Nuevo negocio',
			stage: 'Firmada',
			closed_on: '2026-01-05',
			amount: 100,
			currency: 'USD',
			contract: { id: 'k1', number: 'CTR-1', status: 'Activo' },
			contracts_count: 1,
			started_on: '2026-01-15',
			mrr: 100,
			billed: 300,
			collected: 200,
			first_invoice_on: '2026-02-01',
			first_payment_on: '2026-02-20',
			periods: 3,
			paid_periods: 2,
			invoices_cancelled: 1,
			contract_cancelled: false,
			days_to_start: 10,
			days_to_first_invoice: 27,
			days_to_payment: 19,
		};
		const deals: SellerDeal[] = [
			base,
			{
				...base,
				quote_id: 'b',
				type_code: 'downsell',
				type: 'downsell',
				type_label: 'Downsell',
				mrr: -40,
				billed: 0,
				collected: 0,
				first_invoice_on: null,
				first_payment_on: null,
				periods: 0,
				paid_periods: 0,
				invoices_cancelled: 0,
				days_to_start: 20,
				days_to_first_invoice: null,
				days_to_payment: null,
			},
			{
				...base,
				quote_id: 'c',
				type_code: 'upsell',
				type: 'upsell',
				type_label: 'Upsell',
				contract: null,
				contracts_count: 0,
				started_on: null,
				mrr: null,
				billed: 0,
				collected: 0,
				first_invoice_on: null,
				first_payment_on: null,
				periods: 0,
				paid_periods: 0,
				invoices_cancelled: 0,
				contract_cancelled: true,
				days_to_start: null,
				days_to_first_invoice: null,
				days_to_payment: null,
			},
		];
		const row = aggregate(ANA, 'Ana', true, deals);

		expect(row).toEqual({
			seller_id: ANA,
			seller_name: 'Ana',
			is_active: true,
			deals: 3,
			by_type: { new_business: 1, upsell: 1, downsell: 1, other: 0 },
			with_contract: 2,
			without_contract: 1,
			not_invoiced: 1,
			mrr: 60,
			billed: 300,
			collected: 200,
			paid_share: 0.667,
			periods_avg: 1.5,
			days_to_start: 15,
			days_to_first_invoice: 27,
			days_to_payment: 19,
			contracts_cancelled: 1,
			invoices_cancelled: 1,
		});
		expect(aggregate(null, 'Equipo', true, [])).toMatchObject({
			deals: 0,
			mrr: 0,
			paid_share: null,
			periods_avg: null,
			days_to_first_invoice: null,
		});
		expect(trend(deals, ['2025-12', '2026-01'])).toEqual([
			{ month: '2025-12', deals: 0, mrr: { new_business: 0, upsell: 0, downsell: 0, other: 0 } },
			{ month: '2026-01', deals: 3, mrr: { new_business: 100, upsell: 0, downsell: -40, other: 0 } },
		]);
	});
});

describe('SellersMetricsService v2', () => {
	it('panel: filas por vendedor activo (inactivos solo con negocios), equipo con conteo de vendedores, tendencia y Sin vendedor; MRR = ítems vinculados menos reemplazados', async () => {
		const { service, query } = build(
			db([
				dealRow({ id: 'q-1', closed_on: '2026-02-10' }),
				dealRow({
					id: 'q-2',
					seller_id: LUIS,
					seller_name: 'Luis',
					quote_type: 'Downselling',
					closed_on: '2026-03-03',
					mrr_new: 60,
					mrr_replaced: 100,
					started_on: '2026-03-01',
					periods: 0,
					paid_periods: 0,
					billed: 0,
					collected: 0,
					first_invoice_on: null,
				}),
				dealRow({ id: 'q-3', seller_id: null, seller_name: null, closed_on: '2026-02-12' }),
				dealRow({
					id: 'q-4',
					quote_type: 'Upselling',
					closed_on: '2026-02-15',
					items_count: 1,
					items_without_mrr: 1,
					mrr_new: 0,
					contract_ref: null,
					contracts_count: 0,
					started_on: null,
					billed: 0,
					collected: 0,
					periods: 0,
					paid_periods: 0,
					first_invoice_on: null,
				}),
			])
		);
		const result = await service.funnel(HOLDING, { from: '2026-01', to: '2026-03' });

		expect(result.currency).toBe('USD');
		expect(result.rows.map((row) => [row.seller_name, row.deals, row.with_contract, row.mrr, row.by_type.upsell])).toEqual([
			['Ana', 2, 1, 150, 1],
			['Luis', 1, 1, -40, 0],
		]);
		expect(result.team).toMatchObject({ deals: 3, mrr: 110, sellers_with_deals: 2, sellers: 2, billed: 300 });
		expect(result.trend.map((month) => [month.month, month.deals, month.mrr.new_business, month.mrr.downsell])).toEqual([
			['2026-01', 0, 0, 0],
			['2026-02', 2, 150, 0],
			['2026-03', 1, 0, -40],
		]);
		expect(result.no_seller).toEqual({ contracts: 2, mrr: 50, billed: 100, collected: 60, contracts_cancelled: 1 });
		const [sql, params] = query.mock.calls.find(([text]) => String(text).includes('WITH items AS')) as [string, unknown[]];

		expect(sql).toContain("d.stage_kind IN ('signed', 'contract_created') OR d.contracts_count > 0");
		expect(sql).toContain('JOIN quote_items qi ON qi.id = ci.quote_item_id');
		expect(sql).toContain('contract_amendment_items ai ON ai.new_item_id = i.item_id');
		expect(sql).toContain('inv.issue_date >= k.closed_on');
		expect(sql).toContain('LEFT JOIN agg ON agg.quote_id = k.id');
		expect(sql).toContain('inv AS MATERIALIZED');
		expect(sql).toContain("inv.status = 'Cancelada'");
		expect(params.slice(0, 3)).toEqual([HOLDING, '2026-01-01', '2026-04-01']);
		expect(params[4]).toEqual(['Emitida', 'Enviada', 'Vencida', 'Pagada']);
		// Un negocio cuyos ítems no tienen devengo todavía no inventa MRR.
		const sinMrr = result.rows[0];

		expect(sinMrr.without_contract).toBe(1);
	});

	it('filtro de tipo y de vendedor: acota filas, equipo y tendencia; con sellerId no calcula Sin vendedor', async () => {
		const { service, query } = build(
			db([
				dealRow({ id: 'q-1', closed_on: '2026-02-10' }),
				dealRow({ id: 'q-2', quote_type: 'Upselling', closed_on: '2026-02-11', mrr_new: 20 }),
			])
		);
		const porTipo = await service.funnel(HOLDING, { from: '2026-02', to: '2026-02', type: 'upsell' });

		expect(porTipo.rows[0]).toMatchObject({ seller_name: 'Ana', deals: 1, mrr: 20 });
		expect(porTipo.team.deals).toBe(1);
		const porVendedor = await service.funnel(HOLDING, { from: '2026-02', to: '2026-02', sellerId: ANA });

		expect(porVendedor.rows.map((row) => row.seller_name)).toEqual(['Ana', 'Luis']);
		expect(porVendedor.no_seller).toEqual({ contracts: 0, mrr: 0, billed: 0, collected: 0, contracts_cancelled: 0 });
		expect(String(query.mock.calls.filter(([text]) => String(text).includes('WITH items AS')).at(-1)?.[0])).toContain('q.seller_id = ANY(');
	});

	it('detalle: negocios del vendedor paginados y con su línea de tiempo; `none` lista los contratos sin vendedor con sus días a la primera factura', async () => {
		const { service } = build(
			db(
				[
					dealRow({ id: 'q-1', quote_number: 'COT-1', closed_on: '2026-02-10' }),
					dealRow({ id: 'q-2', quote_number: 'COT-2', closed_on: '2026-02-20', first_payment_on: '2026-03-15' }),
				],
				{
					id: 'k2',
					contract_number: 'CTR-2',
					status: 'Cancelado',
					client_name: 'Beta',
					contract_on: '2026-02-01',
					mrr: 5,
					billed: 10,
					collected: 0,
					periods: 1,
					first_invoice_on: '2026-02-11',
				}
			)
		);
		const page = await service.sellerDeals(HOLDING, ANA, { from: '2026-01', to: '2026-03', page: 1, limit: 1 });

		expect(page).toMatchObject({ currency: 'USD', total: 2, pages: 2, currentPage: 1, limit: 1 });
		expect(page.data[0]).toMatchObject({
			quote_number: 'COT-2',
			type: 'new_business',
			type_label: 'Nuevo negocio',
			contract: { id: 'k1', number: 'CTR-9', status: 'Activo' },
			days_to_start: 0,
			days_to_first_invoice: 9,
			days_to_payment: 14,
		});
		const none = await service.sellerDeals(HOLDING, 'none', { from: '2026-01', to: '2026-03' });

		expect(none.data).toEqual([
			{
				contract: { id: 'k2', number: 'CTR-2', status: 'Cancelado' },
				client_name: 'Beta',
				contract_on: '2026-02-01',
				mrr: 5,
				billed: 10,
				collected: 0,
				periods: 1,
				first_invoice_on: '2026-02-11',
				days_to_first_invoice: 10,
				contract_cancelled: true,
			},
		]);
	});
});
