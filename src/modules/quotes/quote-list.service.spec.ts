import { DataSource } from 'typeorm';

import { parseQuoteStatusFilter, QUOTE_EVENTS_LATERAL, quoteListRow, QuoteListService } from './quote-list.service';

type Row = Record<string, unknown>;
const NOW = new Date('2026-09-28T15:00:00.000Z');
const CLIENT = '11111111-1111-4111-8111-111111111111';
const SELLER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '44444444-4444-4444-8444-444444444444';

const row: Row = {
	id: 'q-1',
	quote_number: 'COT-2026-0001',
	quote_type: 'Upselling',
	currency: 'USD',
	total_amount: '2160.00',
	kind: 'sent',
	derived_status: 'sent',
	stage_id: 's-sent',
	stage_name: 'Enviada',
	stage_color: '#3b82f6',
	stage_position: 2,
	client_id: CLIENT,
	client_name: 'ACME',
	client_country: 'Chile',
	seller_id: SELLER,
	seller_name: 'Ana',
	items_count: '2',
	mrr: '180.5',
	products: ['Licencia Pro'],
	quote_date: '2026-09-01',
	valid_until: '2026-10-01',
	booking_date: null,
	salesforce_opportunity_id: '006Rv00000abc',
	contract_id: null,
	applied_contract_id: 'c-9',
	applied_contract_number: 'CTR-2026-009',
	applied_contract_status: 'Activo',
	created_at: new Date('2026-09-01T10:00:00.000Z'),
	created_by_id: 'u-1',
	created_by_name: 'Domi',
	updated_by_id: 'u-2',
	updated_by_name: 'Leon',
	payment_terms: 'Fin de mes + 15',
};

const build = (handler: (sql: string, params: unknown[]) => unknown[] | undefined = () => undefined) => {
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('AS all_count'))
			return [
				{
					all_count: '10',
					draft_count: '3',
					sent_count: '4',
					expired_count: '1',
					signed_count: '1',
					contract_created_count: '1',
					lost_count: '0',
				},
			];
		if (sql.includes('AS open_amount'))
			return [{ currency: 'USD', quotes_count: '6', open_amount: '1000', open_mrr: '100', total_amount: '3000', mrr: '250' }];
		if (sql.includes('AS won')) return [{ won: '3', lost: '1' }];
		if (sql.includes('LIMIT')) return [row];

		return [];
	});

	return { service: new QuoteListService({ query } as unknown as DataSource), query };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));

describe('parseQuoteStatusFilter', () => {
	it('open = draft + sent + expired; all o vacío = todos; ignora valores fuera de la lista', () => {
		expect(parseQuoteStatusFilter('open')).toEqual(['draft', 'sent', 'expired']);
		expect(parseQuoteStatusFilter('signed,lost,signed')).toEqual(['signed', 'lost']);
		expect(parseQuoteStatusFilter('all,signed')).toEqual([]);
		expect(parseQuoteStatusFilter(undefined)).toEqual([]);
		expect(parseQuoteStatusFilter('hacked')).toEqual([]);
	});
});

describe('quoteListRow', () => {
	it('deriva tipo de negocio, origen y el contrato aplicado (relación applied)', () => {
		const mapped = quoteListRow(row);

		expect(mapped).toMatchObject({
			quote_type: 'upsell',
			quote_type_label: 'Upsell',
			origin: 'salesforce',
			status: 'sent',
			stage: { id: 's-sent', kind: 'sent', position: 2 },
			seller: { id: SELLER, name: 'Ana' },
			total_amount: 2160,
			mrr: 180.5,
			items_count: 2,
			contract: { id: 'c-9', contract_number: 'CTR-2026-009', relation: 'applied' },
			created_by: { id: 'u-1', name: 'Domi' },
			updated_by: { id: 'u-2', name: 'Leon' },
			// Q-D4: la forma estructurada se deriva del texto; nada se guarda aparte.
			payment_terms: 'Fin de mes + 15',
			payment_terms_json: { kind: 'end_of_month', days: 15 },
		});
		expect(quoteListRow({ ...row, payment_terms: 'Según OC' }).payment_terms_json).toBeNull();
	});

	it('la línea de vida no se guarda en quotes: sale de quote_events (lateral ev) y signed_at es el booking de las firmadas', () => {
		expect(QUOTE_EVENTS_LATERAL).toContain(`e.type = 'SENT'`);
		expect(QUOTE_EVENTS_LATERAL).toContain(`e.type = 'LOST'`);
		expect(QUOTE_EVENTS_LATERAL).toContain(`e.type = 'CREATED'`);
		expect(QuoteListService.ROW_COLUMNS).toContain(
			`CASE WHEN ds.derived_status IN ('signed', 'contract_created') THEN q.booking_date::text END AS signed_at`
		);
		for (const column of ['q.sent_at', 'q.signed_at', 'q.lost_at', 'q.lost_reason', 'q.created_by', 'q.payment_terms_json'])
			expect(QuoteListService.ROW_COLUMNS).not.toContain(column);
		expect(QuoteListService.conversionSql('WHERE q.holding_id = $1')).toContain('q.booking_date BETWEEN $2::date - 90');
		expect(QuoteListService.conversionSql('WHERE q.holding_id = $1')).toContain('ev.lost_at::date BETWEEN');
	});
});

describe('QuoteListService.list', () => {
	it('acota al holding, excluye borradas y arma los filtros con $n; el estado va como literal de la lista blanca solo en filas y totales', async () => {
		const { service, query } = build();
		const page = await service.list(
			'h-1',
			{
				status: 'open',
				clientId: CLIENT,
				sellerId: SELLER,
				currency: 'usd,clp',
				quoteType: 'upsell',
				productId: PRODUCT,
				origin: 'salesforce',
				hasContract: 'false',
				validUntilFrom: '2026-09-01',
				amountMin: 100,
				search: ' 76.123 ',
				page: 2,
				limit: 10,
				sortBy: 'mrr',
				sortOrder: 'asc',
			},
			NOW
		);
		const [listSql, listParams] = calls(query, 'OFFSET')[0] as [string, unknown[]];
		const [countSql] = calls(query, 'AS all_count')[0] as [string];
		const [totalsSql] = calls(query, 'AS open_amount')[0] as [string];

		expect(listSql).toContain('q.holding_id = $1');
		expect(listSql).toContain('q.deleted_at IS NULL');
		expect(listSql).toContain('q.client_id = ANY($3::uuid[])');
		expect(listSql).toContain('q.seller_id = ANY($4::uuid[])');
		expect(listSql).toContain('upper(q.currency) = ANY($5::text[])');
		expect(listSql).toContain(`lower(COALESCE(q.quote_type, '')) = ANY($6::text[])`);
		expect(listSql).toContain('pi.product_id = ANY($7::uuid[])');
		expect(listSql).toContain('q.salesforce_opportunity_id IS NOT NULL');
		expect(listSql).toContain('NOT (ct.id IS NOT NULL OR ap.contract_id IS NOT NULL)');
		expect(listSql).toContain('q.valid_until >= $8::date');
		expect(listSql).toContain('q.total_amount >= $9::numeric');
		expect(listSql).toContain('q.quote_number ILIKE $10');
		expect(listSql).toContain(`regexp_replace(ce.tax_id`);
		expect(listSql).toContain(`AND ds.derived_status IN ('draft', 'sent', 'expired')`);
		expect(listSql).toContain('ORDER BY it.mrr ASC NULLS LAST, q.id');
		expect(listSql).toContain('LIMIT 10 OFFSET 10');
		expect(listParams).toEqual([
			'h-1',
			'2026-09-28',
			[CLIENT],
			[SELLER],
			['USD', 'CLP'],
			['upsell', 'upselling'],
			[PRODUCT],
			'2026-09-01',
			100,
			'%76.123%',
		]);
		// El conteo comparte params y no filtra por estado; los totales sí.
		expect(countSql).not.toContain(`ds.derived_status IN (`);
		expect(totalsSql).toContain(`ds.derived_status IN ('draft', 'sent', 'expired')`);
		expect(page).toMatchObject({
			items: 8,
			pages: 1,
			currentPage: 2,
			limit: 10,
			counts: { all: 10, draft: 3, sent: 4, expired: 1, signed: 1, contract_created: 1, lost: 0, open: 8 },
			totals: {
				quotes: 6,
				by_currency: [{ currency: 'USD', quotes: 6, total_amount: 3000, open_amount: 1000, mrr: 250, open_mrr: 100 }],
				conversion_90d: { won: 3, lost: 1, closed: 4, rate: 75 },
			},
		});
		expect(page.data[0]).toMatchObject({ id: 'q-1', quote_type: 'upsell', contract: { relation: 'applied' } });
	});

	it('ordena solo por columnas de la lista blanca y por defecto por fecha de cotización', async () => {
		const { service, query } = build();

		await service.list('h-1', { sortBy: 'contract' }, NOW);
		expect(calls(query, 'OFFSET')[0][0]).toContain('ORDER BY COALESCE(ct.contract_number, ap.contract_number) DESC NULLS LAST, q.id');
		await service.list('h-1', { sortBy: 'hacked' as never }, NOW);
		expect(calls(query, 'OFFSET')[1][0]).toContain('ORDER BY q.quote_date DESC NULLS LAST, q.id');
	});

	it('kind, etapa y razón social filtran sobre la etapa guardada y las asociaciones del cliente', async () => {
		const { service, query } = build();

		await service.list(
			'h-1',
			{
				kind: 'draft,sent',
				stageId: 's-1',
				entityId: '33333333-3333-4333-8333-333333333333',
			},
			NOW
		);
		const [sql, params] = calls(query, 'OFFSET')[0] as [string, unknown[]];

		expect(sql).toContain('client_entity_clients x WHERE x.client_entity_id = ce.id AND x.client_id = q.client_id');
		expect(sql).toContain('q.quote_stage_id = ANY($4::uuid[])');
		expect(sql).toContain('ds.kind = ANY($5::text[])');
		expect(params.slice(2)).toEqual([['33333333-3333-4333-8333-333333333333'], ['s-1'], ['draft', 'sent']]);
	});
});

describe('QuoteListService.summary', () => {
	it('KPIs con el mismo estado mostrado: abiertas, firmadas sin contrato, vencidas, perdidas 90 d, pipeline por moneda y conversión', async () => {
		const { service, query } = build((sql) =>
			sql.includes('AS all_count')
				? [
						{
							all_count: '10',
							draft_count: '3',
							sent_count: '4',
							expired_count: '1',
							signed_count: '1',
							contract_created_count: '1',
							lost_count: '0',
							lost_90d_count: '0',
							expiring_7d_count: '2',
						},
					]
				: undefined
		);
		const summary = await service.summary('h-1', NOW);

		expect(summary).toEqual({
			as_of: '2026-09-28',
			total: 10,
			open: 8,
			draft: 3,
			sent: 4,
			expired: 1,
			expiring_7d: 2,
			signed_without_contract: 1,
			contract_created: 1,
			lost: 0,
			lost_90d: 0,
			pipeline_by_currency: [{ currency: 'USD', open_amount: 1000, open_mrr: 100, signed_amount: 0 }],
			conversion_90d: { won: 3, lost: 1, closed: 4, rate: 75 },
		});
		for (const [sql, params] of query.mock.calls as Array<[string, unknown[]]>) {
			expect(sql).toContain('q.deleted_at IS NULL');
			expect(params).toEqual(['h-1', '2026-09-28']);
		}
	});
});
