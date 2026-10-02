// `contract-invoices.service` importa el scheduler de facturas, que importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { DataSource } from 'typeorm';

import { BillingPaymentsService } from './billing-payments.service';
import { BillingReadService } from './billing-read.service';
import { documentKindSql, invoicesCte, monthEndOf, nextMonthStart, SOURCE_SQL, SqlParams, subscriptionSql } from './billing-sql';
import { INVOICE_SOURCES } from './billing-states';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const CLIENT = 'bb0caa69-162e-4b9e-8e54-9aff347abf1f';
const CONTRACT = '7f1d3c2a-9b8e-4f6a-8c5d-2e1f0a9b8c7d';
const INVOICE = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-01T15:00:00Z');

/** Postgres rechaza un `$n` que el SQL no referencia ("could not determine data type of parameter $n" → 500). */
function unreferencedParams(query: jest.Mock): string[] {
	return query.mock.calls.flatMap(([sql, params]: [string, unknown[] | undefined]) =>
		(params ?? []).map((_, index) => `$${index + 1}`).filter((placeholder) => !new RegExp(`\\${placeholder}(?!\\d)`).test(sql))
	);
}

const invoiceRow = {
	id: INVOICE,
	contract_id: CONTRACT,
	status: 'Por Emitir',
	document_kind: 'invoice',
	invoice_number: null,
	invoice_currency: 'CLP',
	total_due: '1000',
	paid_amount: '0',
	is_active: true,
};

function build(rows: (sql: string) => unknown[] = () => []) {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) => {
		if (sql.includes('holding_settings')) return [{ system_currency: 'USD' }];
		if (sql.includes('FROM users u') && sql.includes('role_permissions')) return [{ is_super_admin: true }];

		return rows(sql);
	});
	const dataSource = { query } as unknown as DataSource;

	return {
		query,
		read: new BillingReadService(dataSource),
		payments: new BillingPaymentsService(dataSource),
	};
}

const ALL_FILTERS = {
	from: '2026-01',
	to: '2026-03',
	date_field: 'due' as const,
	status: 'Emitida,Vencida',
	document_kind: 'invoice',
	erp_state: 'none,sent',
	electronic_state: 'issued_erp',
	payment_state: 'partial,overdue',
	company_id: HOLDING,
	client_id: CLIENT,
	client_entity_id: CLIENT,
	contract_id: CONTRACT,
	invoice_currency: 'clp,usd',
	deviation_unexplained: true,
	q: 'ACME_50%',
};

describe('SQL de Facturación: todo parámetro agregado está referenciado', () => {
	it('lista con todos los filtros (y blocked), resumen, cola, NC, antigüedad, catálogos', async () => {
		const { query, read } = build();

		await read.invoices(HOLDING, { ...ALL_FILTERS, blocked: true, sortBy: 'balance', sortOrder: 'asc', page: 2, limit: 20 }, NOW);
		await read.invoices(HOLDING, { blocked: false }, NOW);
		await read.invoices(HOLDING, {}, NOW);
		await read.summary(HOLDING, ALL_FILTERS, NOW);
		await read.summary(HOLDING, {}, NOW);
		await read.toIssue(
			HOLDING,
			{ ...ALL_FILTERS, status: undefined, until: '2026-10-31', group: 'blocked', blocker_code: 'needs_reference' },
			NOW
		);
		await read.creditNotes(HOLDING, { ...ALL_FILTERS, credit_type: 'cancellation' }, NOW);
		await read.aging(HOLDING, { as_of: '2026-09-30', company_id: HOLDING, client_id: CLIENT, currency: 'usd', detail: 'invoices' }, NOW);
		await read.calendar(
			HOLDING,
			{ ...ALL_FILTERS, blocked: true, granularity: 'week', start: '2026-09-01', end: '2026-10-31', group_by: 'contract' },
			NOW
		);
		await read.calendar(HOLDING, { ...ALL_FILTERS, scope: 'to_issue' }, NOW);
		await read.subscriptionInvoices(
			HOLDING,
			{ ...ALL_FILTERS, charge_state: 'failed,open', sortBy: 'due_date', sortOrder: 'asc', page: 2, limit: 10 },
			NOW
		);
		await read.subscriptionInvoices(HOLDING, {}, NOW);
		await read.invoices(HOLDING, { source: 'contract,other' }, NOW);
		await read.aging(HOLDING, { source: 'contract,other', group: 'company', q: 'acme' }, NOW);
		await read.toIssue(HOLDING, { sortBy: 'client_name', sortOrder: 'asc', group: 'ready' }, NOW);
		await read.forecast(
			HOLDING,
			{ granularity: 'week', from: '2026-10-01', to: '2026-12-31', company_id: HOLDING, source: 'contract,other', q: 'x' },
			NOW
		);
		await read.goalProgress(HOLDING, { year: 2026, company_id: HOLDING, source: 'contract,other' }, { '2026-01': 1000 }, NOW);
		await read.dsoTrend(HOLDING, { months: 3, segment: 'Enterprise', market: 'Chile', company_id: HOLDING }, NOW);
		await read.aging(HOLDING, { segment: 'Enterprise,Pyme', market: 'Chile' }, NOW);
		await read.filters(HOLDING);
		await read.exportBatches(HOLDING, { ...ALL_FILTERS, blocked: true }, async () => undefined, NOW);

		expect(query).toHaveBeenCalled();
		expect(unreferencedParams(query)).toEqual([]);
	});

	it('export_only: solo facturas de exportación (export_type = 1); sin el filtro no se acota', async () => {
		const { query, read } = build(() => []);

		await read.invoices(HOLDING, { export_only: true }, NOW);
		expect(query.mock.calls.some(([sql]) => String(sql).includes('i.export_type = 1'))).toBe(true);
		query.mockClear();
		await read.invoices(HOLDING, {}, NOW);
		expect(query.mock.calls.some(([sql]) => String(sql).includes('i.export_type = 1'))).toBe(false);
	});

	it('la página decora las Por Emitir con bloqueos del 360, documentos vinculados y unificadas (lotes sin parámetros sueltos)', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('SELECT d.* FROM d') && sql.includes('LIMIT')) return [{ ...invoiceRow, invoice_type: 'Unificada' }];
			if (sql.includes('COUNT(*) AS total')) return [{ total: '1' }];

			return [];
		});
		const result = await read.invoices(HOLDING, {}, NOW);

		expect(result).toMatchObject({ total: 1, items: 1, currentPage: 1, pages: 1, limit: 50 });
		expect(result.data[0]).toMatchObject({ id: INVOICE, blocked_reasons: [], related_documents: [], legacy_unified: false });
		const sqls = query.mock.calls.map(([sql]) => String(sql));

		expect(sqls.some((sql) => sql.includes('consolidated_v2'))).toBe(true);
		expect(sqls.some((sql) => sql.includes("'relation', CASE"))).toBe(true);
		expect(unreferencedParams(query)).toEqual([]);
	});

	it('pagos y correos de una factura (404 si no es del holding)', async () => {
		const { query, read } = build((sql) => (sql.includes('SELECT d.* FROM d') || sql.includes('SELECT 1 FROM invoices') ? [invoiceRow] : []));

		await read.invoicePayments(HOLDING, INVOICE, NOW);
		await read.invoiceEmails(HOLDING, INVOICE);
		expect(unreferencedParams(query)).toEqual([]);
		await expect(build().read.invoicePayments(HOLDING, INVOICE, NOW)).rejects.toThrow('Factura no encontrada');
	});

	it('una factura (deep link): fila de la lista decorada + payments_summary; 404 si no es del holding', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('SELECT d.* FROM d'))
				return [{ ...invoiceRow, status: 'Emitida', invoice_number: 'F-10', paid_amount: '400', balance: '600' }];
			if (sql.includes('confirmed_count'))
				return [{ confirmed_count: '2', voided_count: '1', other_currency_count: '0', last_payment_date: '2026-09-15' }];

			return [];
		});
		const result = await read.invoice(HOLDING, INVOICE, NOW);

		expect(result).toMatchObject({
			id: INVOICE,
			invoice_number: 'F-10',
			blocked_reasons: [],
			related_documents: [],
			to_issue_group: null,
			payments_summary: {
				currency: 'CLP',
				total: 1000,
				paid: 400,
				balance: 600,
				payments_count: 2,
				voided_count: 1,
				last_payment_date: '2026-09-15',
			},
		});
		expect(unreferencedParams(query)).toEqual([]);
		await expect(build().read.invoice(HOLDING, INVOICE, NOW)).rejects.toThrow('Factura no encontrada');
	});

	it('vista previa de pago: facturas con pagos en su moneda y cierre de período', async () => {
		const { query, payments } = build((sql) =>
			sql.includes('get_cutoff_date')
				? [
						{
							id: INVOICE,
							contract_id: CONTRACT,
							status: 'Emitida',
							document_type: 'FACTURA',
							is_active: true,
							voided: false,
							invoice_currency: 'CLP',
							total: 1000,
							paid: 0,
						},
					]
				: []
		);
		const plan = await payments.preview(
			HOLDING,
			{ allocations: [{ invoice_id: INVOICE, amount: 100 }], currency: 'CLP', payment_date: '2026-10-01' },
			NOW
		);

		expect(plan.can_apply).toBe(true);
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('get_cutoff_date'))!;

		expect(sql).toContain('p.confirmed = true');
		expect(sql).toContain('UPPER(p.currency) = UPPER(COALESCE(i.invoice_currency, i.contract_currency))');
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('KPIs (summary)', () => {
	it('Facturado neto: solo activas; la NC de una factura ya anulada (Cancelada) u origen consolidado no resta de nuevo (regla del 360)', async () => {
		const { query, read } = build();

		await read.summary(HOLDING, { include_inactive: true }, NOW);
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('AS credited'))!;

		expect(sql).toContain('ri.is_active AS related_invoice_active');
		const filterOf = (alias: string) => {
			const end = sql.indexOf(`, 0) AS ${alias},`);

			return sql.slice(sql.lastIndexOf('FILTER (WHERE ', end) + 'FILTER (WHERE '.length, end);
		};

		expect(filterOf('billed')).toMatch(/^d\.is_active AND d\.document_kind = 'invoice'/);
		expect(filterOf('credited')).toMatch(/^d\.is_active AND d\.document_kind = 'credit_note'/);
		expect(filterOf('credited')).toContain(
			"d.related_invoice_id IS NULL OR (d.related_invoice_status IS DISTINCT FROM 'Cancelada' AND d.related_invoice_active IS NOT FALSE)"
		);
		expect(filterOf('pending_issue')).toMatch(/^d\.is_active AND d\.status = 'Por Emitir'/);
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('saldo: una sola regla para lista, resumen y antigüedad (G6)', () => {
	it('Pagada ⇒ saldo 0 aunque los pagos no cubran el total; el caso se cuenta en warnings paid_without_full_payments', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('AS paid_without_full_payments') && sql.includes('d.client_id, d.client_name')) {
				return [
					{
						client_id: CLIENT,
						client_name: 'Acme',
						currency: 'CLP',
						due_date: '2026-09-01',
						balance: '0',
						paid_without_full_payments: true,
					},
					{
						client_id: CLIENT,
						client_name: 'Acme',
						currency: 'CLP',
						due_date: '2026-09-01',
						balance: '500',
						paid_without_full_payments: false,
					},
				];
			}
			if (sql.includes('AS credited')) return [{ currency: 'CLP', paid_without_full_payments: '1' }];

			return [];
		});
		const aging = await read.aging(HOLDING, {}, NOW);
		const summary = await read.summary(HOLDING, {}, NOW);
		const warning = { code: 'paid_without_full_payments', count: 1 };

		expect(aging.warnings).toEqual([expect.objectContaining(warning)]);
		expect(aging.by_currency[0]).toMatchObject({ currency: 'CLP', total: 500, invoices: 1 });
		expect(summary.warnings).toEqual([expect.objectContaining(warning)]);
		const sqls = query.mock.calls.map(([text]) => String(text));
		const agingSql = sqls.find((text) => text.includes('d.client_id, d.client_name'))!;
		const rule = "WHEN d.status = 'Pagada' THEN 0";

		// La antigüedad usa la misma regla de saldo que la CTE (que alimenta la lista y el resumen), no un CASE propio.
		expect(agingSql).toContain(rule);
		expect(agingSql).toContain("WHEN b.status = 'Pagada' THEN 0");
		expect(agingSql).not.toContain('NOT EXISTS (SELECT 1 FROM invoice_payments');
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('antigüedad: reporte Cuentas por cobrar', () => {
	it('detalle por factura con último pago al corte, saldo en sistema y totales del sistema', async () => {
		const { query, read } = build((sql) =>
			sql.includes('last_payment_date') && sql.includes('d.client_id, d.client_name')
				? [
						{
							client_id: CLIENT,
							client_name: 'Acme',
							currency: 'CLP',
							due_date: '2026-09-01',
							balance: '500',
							balance_system: '0.55',
							id: INVOICE,
							invoice_number: 'F-7',
							company_name: 'Sapira SpA',
							issue_date: '2026-08-01',
							last_payment_date: '2026-09-15',
						},
					]
				: []
		);
		const result = await read.aging(HOLDING, { as_of: '2026-10-01', detail: 'invoices' }, NOW);

		expect(result).toMatchObject({ as_of: '2026-10-01', system_currency: 'USD', system: { currency: 'USD', total: 0.55, unconverted: 0 } });
		expect(result.clients[0]).toMatchObject({ last_payment_date: '2026-09-15', max_days_overdue: 30, total_system: 0.55 });
		expect(result.invoices).toEqual([
			expect.objectContaining({
				id: INVOICE,
				invoice_number: 'F-7',
				company_name: 'Sapira SpA',
				days_overdue: 30,
				bucket: 'd1_30',
				balance: 500,
				last_payment_date: '2026-09-15',
			}),
		]);
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('last_payment_date'))!;

		// Último pago: solo confirmados y hasta el corte.
		expect(sql).toMatch(/p\.confirmed = true AND p\.payment_date <= \$\d+::date/);
		expect(unreferencedParams(query)).toEqual([]);
		// Sin `detail` no viaja el detalle.
		expect('invoices' in (await read.aging(HOLDING, {}, NOW))).toBe(false);
	});
});

describe('origen y suscripciones', () => {
	it('source filtra por origen en la CTE (suscripción manda); los tres orígenes = sin filtro', () => {
		const params = new SqlParams();
		const { cte } = invoicesCte(HOLDING, { source: 'contract,other' }, params, { today: '2026-10-01' });

		expect(cte).toContain(`(${SOURCE_SQL.contract} OR ${SOURCE_SQL.other})`);
		expect(invoicesCte(HOLDING, { source: 'contract,subscription,other' }, new SqlParams(), { today: '2026-10-01' }).cte).not.toContain(
			SOURCE_SQL.contract
		);
		expect(invoicesCte(HOLDING, { source: 'subscription' }, new SqlParams(), { today: '2026-10-01' }).cte).toContain(
			`(${SOURCE_SQL.subscription})`
		);
	});

	/** Evalúa una regla de `SOURCE_SQL` sobre una fila (traducción literal del SQL: IS [NOT] NULL, =, AND/OR/NOT). */
	const sourceOf = (row: Record<string, unknown>) =>
		INVOICE_SOURCES.filter((source) => {
			const js = SOURCE_SQL[source]
				.replace(/\s+/g, ' ')
				.replace(/i\.(\w+) IS NOT NULL/g, '(r.$1 != null)')
				.replace(/i\.(\w+) IS NULL/g, '(r.$1 == null)')
				.replace(/i\.(\w+) = '([^']*)'/g, "(r.$1 === '$2')")
				.replace(/\bAND\b/g, '&&')
				.replace(/\bOR\b/g, '||')
				.replace(/\bNOT\b/g, '!');

			return (new Function('r', `return ${js};`) as (r: Record<string, unknown>) => boolean)(row);
		});

	it('borrador de Stripe sin suscripción enlazada (Suscripción / Invoice, sin contrato ni líneas) es de suscripción, no "Sin contrato"', () => {
		const stripeDraft = {
			invoice_number: 'B4C5701F-0032',
			invoice_type: 'Suscripción',
			document_type: 'Invoice',
			contract_id: null,
			subscription_id: null,
			stripe_id: null,
			status: 'Por Emitir',
		};

		expect(sourceOf(stripeDraft)).toEqual(['subscription']);
		expect(sourceOf({ ...stripeDraft, invoice_type: 'Importada' })).toEqual(['subscription']);
		expect(sourceOf({ ...stripeDraft, document_type: 'FACTURA' })).toEqual(['subscription']);
		expect(sourceOf({ ...stripeDraft, invoice_type: 'Manual', document_type: 'FACTURA', stripe_id: 'in_1' })).toEqual(['subscription']);
		// Una factura de contrato con `document_type = 'Invoice'` sigue siendo de contrato; sin nada de lo anterior, "otra".
		expect(sourceOf({ ...stripeDraft, invoice_type: 'Automatica', contract_id: CONTRACT })).toEqual(['contract']);
		expect(sourceOf({ ...stripeDraft, invoice_type: 'Importada', document_type: 'FACTURA' })).toEqual(['other']);
	});

	it('resumen: la parte de suscripciones usa la misma regla de origen (d.is_subscription), no solo subscription_id', async () => {
		const { query, read } = build();

		await read.summary(HOLDING, {}, NOW);
		const sqls = query.mock.calls.map(([text]) => String(text));
		const summarySql = sqls.find((text) => text.includes('AS billed_system_subscription'))!;
		const collectedSql = sqls.find((text) => text.includes('AS collected_system_subscription'))!;

		expect(summarySql).toContain(`${subscriptionSql('i')} AS is_subscription`);
		expect(summarySql).toContain('d.is_subscription), 0) AS billed_system_subscription');
		expect(summarySql).toContain('d.is_subscription), 0) AS credited_system_subscription');
		expect(collectedSql).toContain('d.is_subscription) AS collected_system_subscription');
		expect(sqls.join('\n')).not.toContain('d.subscription_id IS NOT NULL');
	});

	it('resumen: Facturado y Cobrado incluyen suscripciones y devuelven su parte aparte', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('AS credited'))
				return [
					{
						currency: 'USD',
						billed_system: '1000',
						billed_system_subscription: '300',
						credited_system: '100',
						credited_system_subscription: '20',
					},
				];
			if (sql.includes('AS collected'))
				return [{ currency: 'USD', collected: '500', collected_system: '500', collected_system_subscription: '120' }];

			return [];
		});
		const summary = await read.summary(HOLDING, {}, NOW);

		expect(summary.system).toMatchObject({ net: 900, collected: 500 });
		expect(summary.subscriptions).toEqual({ net: 280, collected: 120 });
		expect(unreferencedParams(query)).toEqual([]);
	});

	it('resumen: Cobrado excluye los ajustes no monetarios (settlement_reason) y los devuelve aparte por moneda y en sistema', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('AS collected'))
				return [
					{ currency: 'USD', collected: '500', collected_system: '500', non_cash_adjustments: '20', non_cash_adjustments_system: '20' },
				];

			return [];
		});
		const summary = await read.summary(HOLDING, {}, NOW);
		const sql = query.mock.calls.map(([statement]) => String(statement)).find((statement) => statement.includes('AS collected'))!;

		expect(sql).toContain('SUM(p.amount) FILTER (WHERE (p.settlement_reason IS NULL)) AS collected');
		expect(sql).toContain('FILTER (WHERE NOT (p.settlement_reason IS NULL)) AS non_cash_adjustments');
		expect(summary.by_currency[0]).toMatchObject({ currency: 'USD', collected: 500, non_cash_adjustments: 20 });
		expect(summary.system).toMatchObject({ collected: 500, non_cash_adjustments: 20 });
		expect(unreferencedParams(query)).toEqual([]);
	});

	it('pagos de una factura: motivo de ajuste, monto y moneda originales (del movimiento) y tipo de cambio', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('SELECT d.* FROM d')) return [{ ...invoiceRow, status: 'Emitida', invoice_currency: 'CLP' }];
			if (sql.includes('created_by_name'))
				return [
					{
						id: 'p1',
						amount: '950000',
						currency: 'clp',
						confirmed: true,
						original_amount: '1000',
						fx_rate: '950',
						original_currency: 'USD',
					},
					{ id: 'p2', amount: '5000', currency: 'CLP', confirmed: true, settlement_reason: 'bank_fee' },
				];

			return [];
		});
		const result = await read.invoicePayments(HOLDING, INVOICE, NOW);
		const sql = query.mock.calls.map(([statement]) => String(statement)).find((statement) => statement.includes('created_by_name'))!;

		expect(sql).toContain('LEFT JOIN bank_movements bm ON bm.id = p.bank_movement_id AND bm.holding_id = p.holding_id');
		expect(result.payments[0]).toMatchObject({ original_amount: 1000, fx_rate: 950, original_currency: 'USD', settlement_reason: null });
		expect(result.payments[1]).toMatchObject({ settlement_reason: 'bank_fee', original_amount: null, original_currency: null });
	});

	it('facturas de suscripción: solo subscription_id, estado del cobro desde Stripe, enlace al documento y conteos por estado', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('SELECT s.* FROM s'))
				return [
					{
						...invoiceRow,
						status: 'Emitida',
						contract_id: null,
						subscription_id: 'sub-uuid',
						subscription_external_id: 'sub_123',
						stripe_id: 'in_123',
						document_url: 'https://invoice.stripe.com/i/acct/in_123',
						plan: 'Plan Pro',
						period_start: '2026-09-01',
						period_end: '2026-09-30',
						charge_state: 'failed',
						charge_attempts: '2',
						source_provider: 'stripe',
						source_account: 'Sapira Chile',
						source_connection_id: 'conn-1',
						source_livemode: true,
					},
				];
			if (sql.includes('AS total') && sql.includes("s.charge_state = 'failed'"))
				return [{ total: '1', paid: '4', open: '0', failed: '1', refunded: '0', void: '0' }];

			return [];
		});
		const result = await read.subscriptionInvoices(HOLDING, { charge_state: 'failed' }, NOW);

		expect(result).toMatchObject({ total: 1, counts: { paid: 4, failed: 1, open: 0 } });
		expect(result.data[0]).toMatchObject({
			plan: 'Plan Pro',
			charge_state: 'failed',
			charge_attempts: 2,
			stripe_id: 'in_123',
			document_url: expect.stringContaining('stripe.com'),
			source_provider: 'stripe',
			source_account: 'Sapira Chile',
			source_connection_id: 'conn-1',
			source_livemode: true,
		});
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('SELECT s.* FROM s'))!;

		// Fuente = proveedor de la suscripción + cuenta conectada (la conexión de la suscripción o la del staging de la factura).
		expect(sql).toContain('LEFT JOIN stripe_connections sc ON sc.holding_id = $');
		expect(sql).toContain('COALESCE(sb.connection_id, st.connection_id)');
		expect(sql).toContain("st.raw_data->>'account_name'");

		expect(sql).toContain(`(${SOURCE_SQL.subscription})`);
		expect(sql).toContain("st.raw_data->>'status' = 'uncollectible'");
		// Borrador de Stripe (Por Emitir): cobro abierto.
		expect(sql).toContain("WHEN d.status = 'Por Emitir' OR st.raw_data->>'status' = 'draft' THEN 'open'");
		expect(sql).toContain('LEFT JOIN stripe_invoices_stg st ON st.holding_id = $');
		expect(sql).toMatch(/WHERE s\.charge_state = ANY\(\$\d+::text\[\]\)/);
		expect(sql).toContain('ORDER BY COALESCE(s.issue_date, s.scheduled_at)');
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('pagos y ajustes (Cobranza)', () => {
	it('lista pagos confirmados por fecha de pago, separa ajustes no monetarios y suma por moneda', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('AS created_by_name'))
				return [
					{
						id: 'p1',
						invoice_id: INVOICE,
						invoice_number: 'F-1',
						client_name: 'Acme',
						amount: '1000',
						currency: 'CLP',
						payment_date: '2026-09-10',
						settlement_reason: null,
					},
					{
						id: 'p2',
						invoice_id: INVOICE,
						invoice_number: 'F-1',
						client_name: 'Acme',
						amount: '5',
						currency: 'CLP',
						payment_date: '2026-09-11',
						settlement_reason: 'bank_fee',
					},
				];
			if (sql.includes('AS adjustments_count'))
				return [{ currency: 'CLP', payments: '2', cash: '1000', cash_count: '1', adjustments: '5', adjustments_count: '1' }];

			return [];
		});
		const result = await read.paymentsList(HOLDING, { from: '2026-09', to: '2026-09', company_id: HOLDING, source: 'contract,other' }, NOW);

		expect(result).toMatchObject({ total: 2, totals: [{ currency: 'CLP', cash: 1000, cash_count: 1, adjustments: 5, adjustments_count: 1 }] });
		expect(result.data.map((row) => row.kind)).toEqual(['cash', 'adjustment']);
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('AS created_by_name'))!;

		expect(sql).toMatch(/p\.payment_date >= \$\d+::date AND p\.payment_date < \$\d+::date/);
		expect(sql).toContain('p.confirmed = true');
		// El período no filtra la emisión de la factura (va sobre la fecha de pago).
		expect(sql).not.toContain('COALESCE(i.issue_date, i.scheduled_at) >=');
		expect(unreferencedParams(query)).toEqual([]);
		await read.paymentsList(HOLDING, { kind: 'adjustment' }, NOW);
		expect(query.mock.calls.at(-1)![0]).toContain('p.settlement_reason IS NOT NULL');
		expect(unreferencedParams(query)).toEqual([]);
	});
});

describe('calendario de facturación', () => {
	it('todas las facturas por emisión en el rango (sin Canceladas por defecto), agregadas por cliente y mes', async () => {
		const { query, read } = build((sql) =>
			sql.includes('AS cal_date')
				? [
						{
							id: INVOICE,
							invoice_number: 'F-1',
							client_id: CLIENT,
							client_name: 'Acme',
							contract_id: CONTRACT,
							contract_number: 'C-1',
							status: 'Emitida',
							document_kind: 'invoice',
							payment_state: 'overdue',
							is_overdue: true,
							cal_date: '2026-10-03',
							currency: 'CLP',
							total_due: '1190',
							total_system_currency: '1.3',
						},
					]
				: []
		);
		const result = await read.calendar(HOLDING, { start: '2026-10-15', granularity: 'month' }, NOW);

		expect(result).toMatchObject({
			granularity: 'month',
			scope: 'invoices',
			start: '2026-10-01',
			end: '2027-09-30',
			currency: 'USD',
			truncated: false,
		});
		expect(result.periods).toHaveLength(12);
		expect(result.rows[0].cells['2026-10']).toMatchObject({
			invoices: 1,
			by_state: { overdue: 1 },
			system: 1.3,
			by_currency: [{ currency: 'CLP', amount: 1190 }],
		});
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('AS cal_date'))!;

		expect(sql).toContain(`i.status IS DISTINCT FROM 'Cancelada'`);
		expect(sql).toContain('COALESCE(d.issue_date, d.scheduled_at)::date >= $');
		// Solo facturas vivas por defecto: sin NC/ND (salvo filtro de tipo).
		expect(sql).toContain(`AND d.document_kind = 'invoice'`);
		expect(unreferencedParams(query)).toEqual([]);
	});

	it('vencimiento con date_field=due; la cola (to_issue) toma el grupo de la cola y no acota el inicio (atrasadas → before)', async () => {
		const { query, read } = build();

		await read.calendar(HOLDING, { date_field: 'due', granularity: 'day', start: '2026-10-01' }, NOW);
		await read.calendar(HOLDING, { scope: 'to_issue', status: 'Emitida', start: '2026-10-01' }, NOW);
		const sqls = query.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('AS cal_date'));

		expect(sqls[0]).toContain('LEFT(d.due_date, 10) AS cal_date');
		expect(sqls[1]).toContain(`d.status = 'Por Emitir'`);
		expect(sqls[1]).not.toContain('::date >= $');
		expect(sqls[1]).not.toContain('i.status = ANY');
	});

	it('rango inválido → 400', async () => {
		await expect(build().read.calendar(HOLDING, { granularity: 'day', start: '2026-01-01', end: '2026-06-01' }, NOW)).rejects.toThrow('hasta 62');
	});
});

describe('CTE de facturas', () => {
	it('holding siempre filtrado; Canceladas fuera por defecto; derivados sobre d; búsqueda escapada', () => {
		const params = new SqlParams();
		const { cte, where } = invoicesCte(HOLDING, { q: '50%_off', payment_state: 'overdue' }, params, {
			today: '2026-10-01',
			excludeCancelledByDefault: true,
		});

		expect(cte).toContain('i.holding_id = $1');
		expect(cte).toContain(`i.status IS DISTINCT FROM 'Cancelada'`);
		expect(cte).toContain('i.is_active = true');
		expect(where).toBe('WHERE d.payment_state = ANY($4::text[])');
		expect(params.values).toEqual([HOLDING, '2026-10-01', '%50\\%\\_off%', ['overdue']]);
		// Pagos solo confirmados y en la moneda de la factura (B-F14).
		expect(cte).toContain('p.confirmed = true');
		expect(cte).toContain('UPPER(p.currency) = UPPER(COALESCE(i.invoice_currency, i.contract_currency))');
		// Nombre real del documento tributario (catálogo global, por el contrato): "Factura exenta", "Factura de exportación"…
		expect(cte).toContain('LEFT JOIN tax_document_types tdt ON tdt.id = c.tax_document_type_id');
		expect(cte).toContain('tdt.name AS tax_document_name');
	});

	it('con status explícito no excluye Canceladas; include_inactive suma orígenes consolidados', () => {
		const params = new SqlParams();
		const { cte } = invoicesCte(HOLDING, { status: 'Cancelada', include_inactive: true }, params, {
			today: '2026-10-01',
			excludeCancelledByDefault: true,
		});

		expect(cte).not.toContain('IS DISTINCT FROM');
		expect(cte).not.toContain('i.is_active = true');
	});

	it('document_kind en SQL con la misma regla que isCreditNote', () => {
		expect(documentKindSql('i')).toContain(`= 'ND' THEN 'debit_note'`);
		expect(documentKindSql('i')).toContain('^(NC|NOTA[[:space:]_-]*(DE[[:space:]_-]*)?CR[EÉ]DITO)');
	});

	it('fechas de mes sin UTC', () => {
		expect(nextMonthStart('2026-12')).toBe('2027-01-01');
		expect(nextMonthStart('2026-02')).toBe('2026-03-01');
		expect(monthEndOf('2026-02-10')).toBe('2026-02-28');
		expect(monthEndOf('2028-02-01')).toBe('2028-02-29');
	});
});

describe('cola Por emitir: bloqueos del 360 por factura y grupos', () => {
	const K1 = '00000000-0000-4000-8000-0000000000a1';
	const K2 = '00000000-0000-4000-8000-0000000000a2';
	const invoice = (id: string, contractId: string, overrides: Record<string, unknown> = {}) => ({
		id,
		contract_id: contractId,
		invoice_number: null,
		status: 'Por Emitir',
		document_type: 'FACTURA',
		invoice_type: 'Automatica',
		is_active: true,
		is_legacy: false,
		issue_date: '2026-10-20',
		scheduled_at: '2026-10-20',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		amount_contract_currency: '1000',
		tax_rate: '19',
		odoo_invoice_id: null,
		sent_to_odoo_at: null,
		lines_count: '1',
		lines_without_product: '0',
		references_count: '0',
		requires_references_for_billing: false,
		...overrides,
	});
	const rows = [
		invoice('a', K1, { requires_references_for_billing: true }),
		invoice('b', K2, { issue_date: '2026-09-25' }),
		invoice('c', K1, { odoo_invoice_id: 77, sent_to_odoo_at: '2026-09-30T12:00:00Z' }),
		invoice('d', K2, { tax_rate: null }),
	];
	const contexts = [
		{
			id: K1,
			contract_number: 'C-1',
			auto_send_to_odoo: true,
			odoo_integration_id: 3,
			odoo_partner_id: 9,
			client_entity_id: 'e',
			cutoff_date: null,
		},
		{
			id: K2,
			contract_number: 'C-2',
			auto_send_to_odoo: true,
			odoo_integration_id: null,
			odoo_partner_id: null,
			client_entity_id: 'e',
			cutoff_date: null,
		},
	];

	it('ERP: needs_reference bloquea, borrador en el ERP aparte; sin ERP: rezagada y lista (los bloqueos del envío no aplican)', async () => {
		const { read } = build((sql) => {
			if (sql.includes('SELECT d.id, d.contract_id, d.invoice_currency, d.total_due FROM d'))
				return rows.map((row) => ({
					id: row.id,
					contract_id: row.contract_id,
					invoice_currency: 'CLP',
					total_due: row.id === 'b' ? null : '1190',
				}));
			if (sql.includes('references_count')) return rows;
			if (sql.includes('FROM contracts c')) return contexts;
			if (sql.includes('SELECT d.* FROM d')) return rows.map((row) => ({ ...row, document_kind: 'invoice', total_due: '1190' }));

			return [];
		});
		const result = await read.toIssue(HOLDING, { limit: 10 }, NOW);
		const byId = Object.fromEntries(result.data.map((row) => [row.id, row]));

		expect(result.until).toBe('2026-10-31');
		expect(result.groups).toMatchObject({ ready: 1, blocked: { count: 1, by_code: { needs_reference: 1 } }, late: 1, erp_draft: 1 });
		expect(result.groups.amount_invoice_currency_by_currency).toEqual({
			ready: [{ currency: 'CLP', amount: 1190, invoices: 1, unvalued: 0 }],
			blocked: [{ currency: 'CLP', amount: 1190, invoices: 1, unvalued: 0 }],
			late: [{ currency: 'CLP', amount: 0, invoices: 1, unvalued: 1 }],
			erp_draft: [{ currency: 'CLP', amount: 1190, invoices: 1, unvalued: 0 }],
		});
		expect(byId.a).toMatchObject({ group: 'blocked', issue_path: 'erp' });
		expect(byId.a.blocked_reasons).toEqual([expect.objectContaining({ code: 'needs_reference', action: 'references' })]);
		expect(byId.b).toMatchObject({ group: 'late', issue_path: 'external', blocked_reasons: [] });
		expect(byId.c.group).toBe('erp_draft');
		expect(byId.c.blocked_reasons.map((blocker) => blocker.code)).toEqual(['already_sent', 'sent_to_erp_draft']);
		expect(byId.d).toMatchObject({ group: 'ready', issue_path: 'external', blocked_reasons: [] });
		expect(result).toMatchObject({ total: 4, currentPage: 1, pages: 1, limit: 10, truncated: false });
	});
});

describe('antigüedad por compañía, proyección y meta (revisión 02-10)', () => {
	const agingRow = (overrides: Record<string, unknown>) => ({
		client_id: CLIENT,
		client_name: 'Acme',
		currency: 'CLP',
		due_date: '2026-09-15',
		balance: '1000',
		balance_system: '1',
		id: INVOICE,
		invoice_number: 'F-1',
		company_id: HOLDING,
		company_name: 'Sapira SpA',
		status: 'Emitida',
		issue_date: '2026-09-01',
		last_payment_date: null,
		paid_without_full_payments: false,
		...overrides,
	});

	it('group=company: por compañía y moneda; CLF/UF van a "por revisar" (conteo por compañía), nunca como moneda', async () => {
		const { read } = build((sql) =>
			sql.includes('lp.last_payment_date')
				? [
						agingRow({}),
						agingRow({ id: 'x', currency: 'CLF', balance: '15', balance_system: '600' }),
						agingRow({ id: 'y', currency: 'USD', balance: '10', balance_system: '10' }),
					]
				: []
		);
		const result = await read.aging(HOLDING, { group: 'company' }, NOW);

		expect(result.by_currency.map((entry) => entry.currency)).toEqual(['CLP', 'USD']);
		expect(result.by_company).toEqual([
			expect.objectContaining({ company_id: HOLDING, name: 'Sapira SpA', currency: 'CLP', total: 1000, review_invoices: 1 }),
			expect.objectContaining({ company_id: HOLDING, currency: 'USD', total: 10, review_invoices: 1 }),
		]);
		expect(result.review).toEqual({ invoices: 1, by_company: [{ company_id: HOLDING, name: 'Sapira SpA', invoices: 1, currencies: ['CLF'] }] });
		expect(result.system.total).toBe(11);
		expect('by_company' in (await read.aging(HOLDING, {}, NOW))).toBe(false);
	});

	it('proyección: vencido aparte, columnas por vencimiento, comportamiento de pago por cliente y SQL de 12 meses', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('lp.last_payment_date'))
				return [
					agingRow({ due_date: '2026-09-15' }),
					agingRow({ id: 'b', due_date: '2026-10-20', balance: '500', balance_system: '0.5' }),
					agingRow({ id: 'c', due_date: null }),
				];
			if (sql.includes('avg_days_to_pay')) return [{ client_id: CLIENT, avg_days_to_pay: '42', avg_days_late: '12', paid_invoices: '3' }];

			return [];
		});
		const result = await read.forecast(HOLDING, { granularity: 'month' }, NOW);

		expect(result.periods).toHaveLength(12);
		expect(result.overdue.system).toBe(1);
		expect(result.columns['2026-10'].system).toBe(0.5);
		expect(result.no_due_date.invoices).toBe(1);
		expect(result.clients[0]).toMatchObject({ client_id: CLIENT, avg_days_to_pay: 42, avg_days_late: 12, paid_invoices: 3 });
		expect(result.payment_behaviour).toEqual({ avg_days_to_pay: 42, avg_days_late: 12, clients: 1 });
		const behaviourSql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes('avg_days_to_pay'))!;

		expect(behaviourSql).toContain("d.status = 'Pagada'");
		expect(behaviourSql).toMatch(/lp\.last_date > \$\d+::date - 365/);
		await expect(read.forecast(HOLDING, { granularity: 'day', from: '2026-10-01', to: '2027-10-01' }, NOW)).rejects.toThrow(/62 columnas/);
	});

	it('meta: cobrado del año (solo pagos monetarios) + saldo que vence en el año = proyectado; % de cumplimiento', async () => {
		const { query, read } = build((sql) => {
			if (sql.includes('lp.last_payment_date'))
				return [
					agingRow({ due_date: '2026-09-15', balance_system: '100' }),
					agingRow({ id: 'z', due_date: '2027-02-01', balance_system: '50' }),
				];
			if (sql.includes("to_char(p.payment_date, 'YYYY-MM')")) return [{ month: '2026-03', collected: '400', unconverted: '0' }];

			return [];
		});
		const result = await read.goalProgress(HOLDING, { year: 2026 }, { '2026-01': 1000 }, NOW);

		expect(result).toMatchObject({
			year: 2026,
			currency: 'USD',
			goal: 1000,
			collected: 400,
			overdue: 100,
			open_due: 100,
			projected: 500,
			pct_collected: 40,
			pct_projected: 50,
		});
		expect(result.months.find((month) => month.month === '2026-10')?.expected).toBe(100);
		const sql = query.mock.calls.map(([text]) => String(text)).find((text) => text.includes("to_char(p.payment_date, 'YYYY-MM')"))!;

		expect(sql).toContain('p.settlement_reason IS NULL');
	});

	it('cola Por emitir con sortBy: la página sale en el orden pedido (lista blanca)', async () => {
		const { query, read } = build();

		await read.toIssue(HOLDING, { sortBy: 'client_name', sortOrder: 'asc' }, NOW);
		await read.toIssue(HOLDING, {}, NOW);
		const queueSql = query.mock.calls.map(([text]) => String(text)).filter((text) => text.includes("d.status = 'Por Emitir' AND d.is_active"));

		expect(queueSql[0]).toContain('ORDER BY d.client_name ASC NULLS LAST');
		expect(queueSql[1]).toContain('ORDER BY COALESCE(d.issue_date, d.scheduled_at) NULLS LAST, d.id');
	});
});
