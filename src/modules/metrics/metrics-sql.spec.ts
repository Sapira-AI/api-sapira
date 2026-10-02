import { DataSource } from 'typeorm';

import { inactiveEmptyRowSql, MetricsDataService, SqlParams } from './metrics-data.service';
import { MrrMetricsService, renewalWindowSql } from './mrr-metrics.service';
import { RevenueMetricsService } from './revenue-metrics.service';

import type { MrrLine } from './mrr-movements';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';

function build(rows: (sql: string) => unknown[] = () => []) {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) =>
		sql.includes('holding_settings') ? [{ system_currency: 'USD' }] : rows(sql)
	);
	const data = new MetricsDataService({ query } as unknown as DataSource);

	return { query, data, mrr: new MrrMetricsService(data), revenue: new RevenueMetricsService(data) };
}

/** Postgres rechaza un `$n` que el SQL no referencia ("could not determine data type of parameter $n" → 500). */
function unreferencedParams(query: jest.Mock): string[] {
	return query.mock.calls.flatMap(([sql, params]: [string, unknown[] | undefined]) =>
		(params ?? []).map((_, index) => `$${index + 1}`).filter((placeholder) => !new RegExp(`\\${placeholder}(?!\\d)`).test(sql))
	);
}

describe('Renovaciones (500 en ventanas 30/90/180/365)', () => {
	it.each(['30', '90', '180', '365', 'overdue'] as const)('ventana %s: todo parámetro agregado está referenciado en el SQL', async (window) => {
		const { query, mrr } = build();

		await mrr.renewals(HOLDING, { window, segment: 'Enterprise' });

		expect(unreferencedParams(query)).toEqual([]);
	});

	it('solo "vencidos" usa el mes actual; las ventanas en días usan solo el número de días', () => {
		const days = new SqlParams();
		const overdue = new SqlParams();

		expect(renewalWindowSql('90', days, '2026-10')).toBe('ci.end_date BETWEEN CURRENT_DATE AND CURRENT_DATE + $1::int');
		expect(days.values).toEqual([90]);
		expect(renewalWindowSql('overdue', overdue, '2026-10')).toContain("p.momentum = 'PENDING_RENEWAL' AND p.period_month = $1::date");
		expect(overdue.values).toEqual(['2026-10-01']);
	});

	it('ningún endpoint de Métricas o Revenue deja parámetros sin referenciar', async () => {
		const { query, mrr, revenue } = build();
		const range = { from: '2026-01', to: '2026-03' };

		await mrr.overview(HOLDING, { asOf: '2026-03', clientId: 'bb0caa69-162e-4b9e-8e54-9aff347abf1f' });
		await mrr.movements(HOLDING, range);
		await mrr.byDimension(HOLDING, { ...range, dimension: 'segment' });
		await mrr.clientActivity(HOLDING, range);
		await mrr.cohorts(HOLDING, range);
		await mrr.bookings(HOLDING, range);
		await revenue.summary(HOLDING, range);
		await revenue.schedule(HOLDING, { ...range, search: 'ACME' });
		await revenue.exceptions(HOLDING, {});

		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('Pendiente de renovar = "Por renovar" de Contratos', () => {
	it('suma las filas PENDING_RENEWAL del mes (mrr_period, como Contratos), sin depender de las líneas convertidas del rango', async () => {
		const { query, mrr } = build((sql) =>
			sql.includes(`r.momentum = 'PENDING_RENEWAL'`) && sql.includes('COUNT(DISTINCT r.contract_id)')
				? [
						{ period: '2026-10', mrr: '974.00', cmrr: '974.00', items: '3', clients: '2', contracts: '2' },
						{ period: '2026-09', mrr: '500', cmrr: '500', items: '1', clients: '1', contracts: '1' },
					]
				: []
		);
		const result = await mrr.overview(HOLDING, { asOf: '2026-10' });
		const pendingSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('COUNT(DISTINCT r.contract_id)'));

		expect(result.kpis.pending_renewal).toMatchObject({ mrr: 974, cmrr: 974, items: 3, clients: 2, contracts: 2, previous: 500 });
		expect(pendingSql).toContain('SUM(r.mrr_period_system_ccy)');
		expect(pendingSql).toContain('r.period_month = ANY(');
	});
});

describe('Meses inactivos sin montos no son huecos de tipo de cambio (regla del rebuild v0.0.69)', () => {
	it('la condición mira montos del período en moneda de contrato y la vigencia del ítem', () => {
		const sql = inactiveEmptyRowSql();

		expect(sql).toContain('COALESCE(r.recognized_period_contract_ccy, 0) = 0');
		expect(sql).toContain('COALESCE(r.billed_period_contract_ccy, 0) = 0');
		expect(sql).toContain(
			"NOT (ci.start_date < (r.period_month + interval '1 month') AND (ci.end_date IS NULL OR ci.end_date >= r.period_month))"
		);
		expect(sql.startsWith('COALESCE(')).toBe(true);
	});

	it('Excepciones, líneas de MRR, devengo y detalle ignoran esas filas al marcar "sin tipo de cambio"', async () => {
		const { query, data, revenue } = build();

		await revenue.exceptions(HOLDING, {});
		await data.loadMrrLines(HOLDING, {}, { mode: 'system', code: 'USD' }, 'mrr', '2026-01', '2026-03');
		await revenue.schedule(HOLDING, { from: '2026-01', to: '2026-03' });
		const sqls = query.mock.calls.map(([sql]) => String(sql));
		const exceptions = sqls.find((sql) => sql.includes('AS item_fx'));
		const lines = sqls.find((sql) => sql.includes('AS item_fx_missing') && sql.includes('mrr_period_contracted_system_ccy'));
		const detail = sqls.find((sql) => sql.includes('AS unconverted') && sql.includes('LIMIT'));

		expect(exceptions).toContain('LEFT JOIN contract_items ci ON ci.id = r.contract_item_id');
		expect(exceptions).toContain(`AND NOT ${inactiveEmptyRowSql()}`);
		expect(lines).toContain(`NOT ${inactiveEmptyRowSql()}`);
		expect(detail).toContain(`NOT ${inactiveEmptyRowSql()}`);
	});
});

describe('Origen de las filas de bajas y movimientos (enlace a Contratos solo si source = contract)', () => {
	const mrrLine = (key: string, source: MrrLine['source'], contractId: string): MrrLine => ({
		key,
		source,
		contractId,
		contractNumber: source === 'contract' ? 'CTR-1' : null,
		itemId: key,
		clientId: `cl-${key}`,
		clientName: 'Cliente',
		companyId: 'co-1',
		companyName: 'Compañía',
		product: 'Producto',
		categoria: 'NEW',
		renewsItemId: null,
		renewedByItemId: null,
		legacyContractId: null,
		segment: null,
		market: null,
		industry: null,
		country: null,
		itemType: null,
		unitOfMeasure: null,
		months: new Map([
			['2026-01', { value: 100, valueContract: 100, pending: 0, momentum: null }],
			['2026-02', { value: 0, valueContract: 0, pending: 0, momentum: null }],
		]),
	});

	function withLines() {
		const built = build();

		jest.spyOn(built.data, 'loadMrrLines').mockResolvedValue({
			lines: [mrrLine('c:1', 'contract', 'contract-1'), mrrLine('s:1', 'subscription', 'subscription-1')],
			itemFxMissing: new Set<string>(),
			legacyCompanyRows: 0,
		});

		return built;
	}

	it('churn: cada fila del detalle trae su source (la de suscripción lleva el id de la suscripción en contract_id)', async () => {
		const { mrr } = withLines();
		const result = await mrr.churn(HOLDING, { from: '2026-02', to: '2026-02' });

		expect(result.data).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ category: 'churn', source: 'contract', contract_id: 'contract-1' }),
				expect.objectContaining({ category: 'churn', source: 'subscription', contract_id: 'subscription-1' }),
			])
		);
	});

	it('movimientos agrupados por contrato también traen source', async () => {
		const { mrr } = withLines();
		const result = await mrr.movementDetail(HOLDING, { from: '2026-02', to: '2026-02', groupBy: 'contract' });

		expect(result.data.map((row) => [row.contract_id, row.source]).sort()).toEqual([
			['contract-1', 'contract'],
			['subscription-1', 'subscription'],
		]);
	});
});

describe('Detalle mensual por contrato (D-CTR-2: 360 › Devengo lee este endpoint)', () => {
	it('filtra por contrato, lee la moneda del contrato y devuelve cada fila RSM tal cual con su ítem y la moneda del ítem', async () => {
		const CONTRACT = '11111111-1111-4111-8111-111111111111';
		const row = {
			id: 'r-1',
			period: '2026-02',
			momentum: 'BOP',
			source: 'contract',
			contract_id: CONTRACT,
			contract_number: 'CTR-1',
			product: 'Soporte',
			item_id: 'i-1',
			item_currency: 'CLF',
			contract_currency: 'USD',
			company_currency: 'CLP',
			system_currency: 'USD',
			recognized_period_contract_ccy: '120.5',
			recognized: '120.5',
		};
		const { query, revenue } = build((sql) =>
			sql.includes('SELECT contract_currency FROM contracts') ? [{ contract_currency: 'USD' }] : sql.includes('LIMIT') ? [row] : [{ n: 1 }]
		);
		const page = await revenue.schedule(HOLDING, { from: '2026-01', to: '2026-03', contractId: CONTRACT, currency: 'contract', limit: 1000 });
		const detail = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('LIMIT'))!;

		expect(detail).toContain('r.contract_id = $');
		expect(detail).toContain('ci.currency AS item_currency');
		expect(page.currency).toBe('USD');
		expect(page.data[0]).toMatchObject({
			item_id: 'i-1',
			item_currency: 'CLF',
			product: 'Soporte',
			amounts: { contract: { recognized: 120.5 } },
		});
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('Detalle mensual: saldo inicial y movimiento del mes (Domi 02-10)', () => {
	it.each(['deferred_opening', 'deferred_change', 'unbilled_opening', 'unbilled_change'] as const)(
		'orden por %s: el CTE del mes anterior va solo en la consulta de filas y todo parámetro está referenciado',
		async (sortBy) => {
			const { query, revenue } = build();

			await revenue.schedule(HOLDING, { from: '2026-01', to: '2026-03', sortBy, search: 'ACME', segment: 'Enterprise' });
			const sqls = query.mock.calls.map(([sql]) => String(sql));
			const rows = sqls.find((sql) => sql.includes('OFFSET'))!;
			const count = sqls.find((sql) => sql.includes('COUNT(*) AS n'))!;

			expect(rows).toContain(`ORDER BY ${sortBy}_system_ccy DESC`);
			expect(rows).toContain("pv.period_month = (r.period_month - interval '1 month')::date");
			expect(count).not.toContain('pv');
			expect(unreferencedParams(query)).toEqual([]);
		}
	);

	it('inicial = cierre del mes anterior del ítem (0 sin fila anterior); movimiento = cierre − inicial; en las tres monedas', async () => {
		const row = {
			id: 'r-1',
			period: '2026-02',
			source: 'contract',
			deferred_eom: '900',
			deferred_opening_system_ccy: '1000',
			deferred_change_system_ccy: '-100',
			unbilled_opening_system_ccy: '0',
			unbilled_change_system_ccy: '0',
			deferred_opening_contract_ccy: '1000',
			deferred_change_contract_ccy: '-100',
		};
		const { query, revenue } = build((sql) => (sql.includes('OFFSET') ? [row] : [{ n: 1 }]));
		const page = await revenue.schedule(HOLDING, { from: '2026-02', to: '2026-02' });
		const rows = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('OFFSET'))!;

		expect(rows).toContain('CASE WHEN pv.item_key IS NULL THEN 0 ELSE pv.deferred_system_ccy END AS deferred_opening_system_ccy');
		expect(rows).toContain('r.unbilled_balance_eom_ccy - (CASE WHEN pv.item_key IS NULL THEN 0 ELSE pv.unbilled_ccy END) AS unbilled_change_ccy');
		expect(rows).toContain("ORDER BY (p.momentum = 'CHURN')");
		expect(rows).toContain("p.momentum IS DISTINCT FROM 'PENDING_RENEWAL'");
		// El mes anterior del primer mes del rango también se lee.
		expect(query.mock.calls.find(([sql]) => String(sql).includes('OFFSET'))![1]).toEqual(expect.arrayContaining(['2026-01-01', '2026-01-01']));
		expect(page.data[0]).toMatchObject({
			deferred_opening: 1000,
			deferred_change: -100,
			unbilled_opening: 0,
			unbilled_change: 0,
			amounts: { contract: { deferred_opening: 1000, deferred_change: -100 } },
		});
	});
});

describe('Asientos con apertura por dimensión', () => {
	const COMPANY = '22222222-2222-4222-8222-222222222222';

	it.each([undefined, 'market', 'industry', 'segment', 'contract', 'client', 'product'] as const)(
		'groupBy=%s: todo parámetro está referenciado',
		async (groupBy) => {
			const { query, revenue } = build((sql) => (sql.includes('SELECT currency FROM companies') ? [{ currency: 'CLP' }] : []));
			const result = await revenue.journal(HOLDING, { from: '2026-01', to: '2026-03', companyId: COMPANY, groupBy });

			expect(result.group_by).toBe(groupBy ?? null);
			expect(result.currency).toBe('CLP');
			expect(unreferencedParams(query)).toEqual([]);
		}
	);

	it('lee las dimensiones de `clients` (mismas fuentes que Métricas) y arma las líneas con códigos del mapping', async () => {
		const rsm = [
			{
				contract_id: 'c-1',
				contract_number: 'CTR-1',
				item_id: 'i-1',
				company_id: COMPANY,
				period: '2026-01',
				recognized: '100',
				billed: '1200',
				recognized_cum: '100',
				billed_cum: '1200',
				client_id: 'cl-1',
				client_name: 'ACME',
				market: null,
				industry: 'Retail',
				segment: 'Enterprise',
				product: 'Plataforma',
			},
		];
		const { query, revenue } = build((sql) =>
			sql.includes('SELECT currency FROM companies')
				? [{ currency: 'CLP' }]
				: sql.includes('company_account_mappings')
					? [
							{
								revenue_account_code: '4.1.01',
								revenue_account_name: 'Ingresos',
								deferred_account_code: '2.2.05',
								deferred_account_name: 'Diferidos',
								unbilled_account_code: '1.1.03',
								unbilled_account_name: 'Por facturar',
							},
						]
					: sql.includes('AS recognized_cum')
						? rsm
						: []
		);
		const result = await revenue.journal(HOLDING, { from: '2026-01', to: '2026-01', companyId: COMPANY, groupBy: 'market' });
		const loader = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('AS recognized_cum'))!;

		expect(loader).toContain('cl.market, cl.industry, cl.segment');
		expect(result.months[0].groups).toEqual([{ key: '__none__', label: 'Sin asignar', debit: 1300, credit: 1300, balanced: true }]);
		expect(result.months[0].postings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ line: 'billing_deferred', account: 'receivable', code: null, name: 'Cuentas por cobrar', debit: 1200 }),
				expect.objectContaining({ line: 'billing_deferred', account: 'deferred', code: '2.2.05', credit: 1200 }),
				expect.objectContaining({ line: 'recognition_deferred', account: 'revenue', code: '4.1.01', credit: 100 }),
			])
		);
		expect(result.missing_codes).toEqual(['receivable']);
		expect(result.months[0].balances.deferred).toMatchObject({ opening: 0, movement: 1100, closing: 1100, reconciles: true });
	});
});
