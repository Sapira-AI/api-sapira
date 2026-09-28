import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { findFixedRate, fixedFxAmounts } from './billing-engine';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type Row = Record<string, unknown>;

/** Borrador chileno en CLP, IVA 19, 30 días, día de ciclo 1, facturas juntas. */
const draft = (id: string, overrides: Row = {}): Row => ({
	id,
	contract_number: id === A ? 'CTR-2026-001' : 'CTR-2026-002',
	status: 'En revisión',
	client_id: 'client-1',
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	system_currency: 'CLP',
	contract_company_currency: 'CLP',
	fx_invoice_policy: 'spot',
	fx_company_policy: null,
	group_invoices_by_period: true,
	auto_invoice: true,
	requires_references_for_billing: false,
	billing_anchor_day: '1',
	payment_terms: { kind: 'net', days: 30 },
	document_type: 'FACTURA',
	company_found: 'company-1',
	company_legal_name: 'Simplit SpA',
	company_tax_id: '76.000.000-0',
	company_address: 'Av. Siempre Viva 123',
	company_country: 'Chile',
	company_currency: 'CLP',
	company_tax_rate: '19',
	entity_found: 'entity-1',
	entity_tax_id: '77.777.777-7',
	entity_country: 'Chile',
	entity_payment_terms: { kind: 'net', days: 60 },
	invoices_count: '0',
	currency_mismatch: false,
	...overrides,
});

/** Recurrente mensual 2 × 100 por 3 meses + implementación única de 500, ambos desde el 01-10-2026. */
const items = (contractId: string, overrides: Row = {}): Row[] => [
	{
		contract_id: contractId,
		id: `${contractId}-rec`,
		product_id: 'p-lic',
		product_name: 'Licencia',
		account: 'Norte',
		unit_of_measure: 'Usuarios',
		quantity: '2',
		unit_price: '100',
		annual_unit_price: null,
		discount_type: null,
		discount_value: '0',
		final_price: '600',
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		start_date: '2026-10-01',
		end_date: '2026-12-31',
		term_months: 3,
		is_recurring: true,
		...overrides,
	},
	{
		contract_id: contractId,
		id: `${contractId}-setup`,
		product_id: 'p-setup',
		product_name: 'Implementación',
		account: null,
		unit_of_measure: null,
		quantity: '1',
		unit_price: '500',
		annual_unit_price: null,
		discount_type: null,
		discount_value: '0',
		final_price: '500',
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		start_date: '2026-10-01',
		end_date: '2026-10-31',
		term_months: 1,
		is_recurring: false,
	},
];

type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const build = (contracts: Row[], contractItems: Row[], handler: Handler = () => undefined) => {
	let sequence = 0;
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM contract_items ci') && sql.includes('JOIN contracts c')) {
			const ids = params[0] as string[];

			return contractItems.filter((item) => ids.includes(String(item.contract_id)));
		}
		if (sql.includes('FROM contracts c')) {
			const ids = params[0] as string[];

			return contracts.filter((contract) => ids.includes(String(contract.id)));
		}
		if (sql.includes('INSERT INTO invoices')) return [{ id: `inv-${++sequence}` }];
		if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-${++sequence}` }];
		if (sql.includes('UPDATE contracts SET status')) return [{ id: params[0] }];

		return [];
	};
	const runners: Array<Record<string, jest.Mock>> = [];
	const dataSource = {
		query: jest.fn(route),
		createQueryRunner: jest.fn(() => {
			const runner = {
				connect: jest.fn(),
				startTransaction: jest.fn(),
				commitTransaction: jest.fn(),
				rollbackTransaction: jest.fn(),
				release: jest.fn(),
				query: jest.fn(route),
			};

			runners.push(runner);

			return runner;
		}),
	} as unknown as DataSource;

	return { service: new ContractActivationService(dataSource), dataSource, runners };
};

const sqlOf = (runner: Record<string, jest.Mock>) => runner.query.mock.calls.map(([sql]) => sql as string);
const codes = (plan: ReturnType<typeof ContractActivationService.evaluate>) => plan.check.blockers.map((blocker) => blocker.code);

describe('ContractActivationService.evaluate (bloqueos)', () => {
	it('borrador completo: se puede activar y usa la configuración guardada del contrato', () => {
		const plan = ContractActivationService.evaluate(A, draft(A), items(A));

		expect(plan.check).toMatchObject({
			id: A,
			contract_number: 'CTR-2026-001',
			can_activate: true,
			blockers: [],
			invoices_count: 3,
			first_issue_date: '2026-10-01',
			total_to_invoice: 1100,
			currency: 'CLP',
			document_type: 'FACTURA',
		});
		expect(plan.check.sample).toHaveLength(3);
		// Condición del contrato (30 días), no la de la razón social (60).
		expect(plan.check.sample[0]).toMatchObject({ due_date: '2026-10-31', subtotal: 700, tax: 133, total: 833, tax_rate: 19 });
		expect(plan.check.sample[0].lines.map((line) => line.item_key)).toEqual([`${A}-rec`, `${A}-setup`]);
	});

	it.each<[string, Row, Row[] | null, string]>([
		['no es borrador', { status: 'Activo' }, null, 'not_draft'],
		['ya tiene facturas', { invoices_count: '2' }, null, 'has_invoices'],
		['solo facturas legacy', { legacy_invoices_count: '4' }, null, 'has_legacy_invoices'],
		['borrador viejo facturado en UF', { invoice_currency: 'CLF' }, null, 'uf_invoice_currency'],
		[
			'contrato en UF sin moneda de facturación',
			{ contract_currency: 'CLF', invoice_currency: null, fx_company_policy: 'monthly_avg' },
			null,
			'uf_invoice_currency',
		],
		['sin razón social', { client_entity_id: null, entity_found: null }, null, 'no_client_entity'],
		['sin compañía', { company_id: null, company_found: null }, null, 'no_company'],
		['compañía sin IVA', { company_tax_rate: null }, null, 'no_tax_rate'],
		['ítems en otra moneda', { currency_mismatch: true }, null, 'currency_mismatch'],
		[
			'moneda ≠ compañía sin política FX (S1-17)',
			{ contract_currency: 'USD', invoice_currency: 'USD', contract_company_currency: 'CLP' },
			null,
			'fx_company_policy_missing',
		],
		['FX fijo de facturación sin tasa', { invoice_currency: 'USD', fx_invoice_policy: 'fixed' }, null, 'fixed_fx_without_rate'],
		['sin ítems', {}, [], 'no_items'],
	])('%s → %s', (_label, overrides, customItems, code) => {
		const plan = ContractActivationService.evaluate(A, draft(A, overrides), customItems ?? items(A));

		expect(codes(plan)).toContain(code);
		expect(plan.check.can_activate).toBe(false);
		expect(plan.check.blockers.every((blocker) => blocker.message.length > 0)).toBe(true);
	});

	it('facturas reales en el borrador: mensaje de dato inconsistente; solo legacy: bloqueo aparte', () => {
		const real = ContractActivationService.evaluate(A, draft(A, { invoices_count: '1', legacy_invoices_count: '3' }), items(A));

		expect(real.check.blockers).toEqual([
			{ code: 'has_invoices', message: 'Este borrador ya tiene facturas; no debería pasar (dato inconsistente). Revísalas antes de activar.' },
		]);
		const legacyOnly = ContractActivationService.evaluate(A, draft(A, { legacy_invoices_count: '3' }), items(A));

		expect(legacyOnly.check.blockers).toEqual([
			{ code: 'has_legacy_invoices', message: 'Tiene facturas legacy reconciliadas: se resuelve en el flujo de onboarding/legacy.' },
		]);
	});

	it('ítems sin producto o incompletos', () => {
		expect(codes(ContractActivationService.evaluate(A, draft(A), items(A, { product_id: null })))).toEqual(['items_without_product']);
		expect(codes(ContractActivationService.evaluate(A, draft(A), items(A, { start_date: null })))).toContain('incomplete_items');
	});

	it('moneda ≠ compañía con política definida: no bloquea', () => {
		const plan = ContractActivationService.evaluate(
			A,
			draft(A, { contract_currency: 'USD', invoice_currency: 'USD', contract_company_currency: 'CLP', fx_company_policy: 'monthly_avg' }),
			items(A)
		);

		expect(plan.check.can_activate).toBe(true);
	});

	it('contrato que no es del holding', () => {
		expect(ContractActivationService.evaluate(MISSING, undefined, []).check).toMatchObject({
			id: MISSING,
			can_activate: false,
			blockers: [{ code: 'not_found', message: 'El contrato no existe en el holding' }],
		});
	});

	it('antes de la migración (sin día de ciclo ni condición propia): defaults del generador y condición de la razón social', () => {
		const plan = ContractActivationService.evaluate(
			A,
			draft(A, { billing_anchor_day: null, payment_terms: null, document_type: null }),
			items(A)
		);

		expect(plan.check.can_activate).toBe(true);
		expect(plan.check.sample[0].due_date).toBe('2026-11-30');
		expect(plan.check.document_type).toBe('FACTURA');
		expect(plan.check.warnings).toContain('El contrato no tiene día de ciclo guardado: se usa el del primer ítem recurrente');
	});

	it('precio anual guardado sin unitario mensual: se divide en 12', () => {
		expect(
			ContractActivationService.engineItem({ id: 'x', unit_price: null, annual_unit_price: '1200', quantity: '1', term_months: 12 }).unit_price
		).toBe(100);
	});
});

describe('Tipo de cambio fijo de facturación (contract_fx_period_rates)', () => {
	const rate = (from: string, to: string, value: number, start: string, end: string, created = '2026-09-01') => ({
		from_currency: from,
		to_currency: to,
		rate: String(value),
		period_start: start,
		period_end: end,
		created_at: created,
	});
	/** Contrato en USD facturado en CLP con FX fijo (la compañía es CLP y tiene política de compañía). */
	const fixedDraft = (rates: unknown[]) =>
		draft(A, {
			contract_currency: 'USD',
			invoice_currency: 'CLP',
			system_currency: 'USD',
			fx_invoice_policy: 'fixed',
			fx_company_policy: 'monthly_avg',
			fx_invoice_rates: rates,
		});
	const usdItems = () => items(A).map((item) => ({ ...item }));

	it('findFixedRate: directa que cubre la fecha (la más reciente), si no la inversa como 1/tasa; null si nada cubre', () => {
		const rates = [
			rate('USD', 'CLP', 900, '2026-01-01', '2026-12-31', '2026-01-01'),
			rate('USD', 'CLP', 950, '2026-10-01', '2026-12-31', '2026-09-20'),
			rate('CLP', 'USD', 0.002, '2027-01-01', '2027-12-31'),
		];

		expect(findFixedRate(rates, 'USD', 'CLP', '2026-10-01')).toBe(950);
		expect(findFixedRate(rates, 'USD', 'CLP', '2026-03-15')).toBe(900);
		expect(findFixedRate(rates, 'USD', 'CLP', '2027-02-01')).toBe(500);
		expect(findFixedRate(rates, 'USD', 'CLP', '2028-01-01')).toBeNull();
		expect(findFixedRate(rates, 'USD', 'PEN', '2026-10-01')).toBeNull();
	});

	it('fixedFxAmounts: espejo de apply_fixed_fx_to_contract (encabezado y líneas × fx)', () => {
		const { check } = ContractActivationService.evaluate(A, fixedDraft([rate('USD', 'CLP', 950, '2026-01-01', '2026-12-31')]), usdItems());
		const amounts = fixedFxAmounts(check.sample[0], 950);

		expect(amounts).toMatchObject({ amount: 665000, vat: 126350, total: 791350 });
		expect(amounts.lines[0]).toEqual({ unit_price: 95000, subtotal: 190000, tax_amount: 36100, total: 226100 });
	});

	it('con tasa para todos los períodos: se puede activar y la muestra trae el fx', () => {
		const { check } = ContractActivationService.evaluate(A, fixedDraft([rate('USD', 'CLP', 950, '2026-01-01', '2026-12-31')]), usdItems());

		expect(check.can_activate).toBe(true);
		expect(check.sample.map((invoice) => invoice.fx)).toEqual([950, 950, 950]);
		expect(check.currency).toBe('USD');
	});

	it('sin tasa (o sin cubrir algún período) → fixed_fx_without_rate', () => {
		const none = ContractActivationService.evaluate(A, fixedDraft([]), usdItems());

		expect(codes(none)).toEqual(['fixed_fx_without_rate']);
		expect(none.check.blockers[0].message).toContain('3 facturas no tienen tasa USD → CLP');

		const partial = ContractActivationService.evaluate(A, fixedDraft([rate('USD', 'CLP', 950, '2026-10-01', '2026-11-15')]), usdItems());

		expect(codes(partial)).toEqual(['fixed_fx_without_rate']);
		expect(partial.check.blockers[0].message).toContain('1 factura no tiene tasa USD → CLP para su período (desde el 2026-12-01)');
	});

	it('activar: fx y montos en moneda de factura llenos en encabezado y líneas', async () => {
		const { service, runners } = build([fixedDraft([rate('USD', 'CLP', 950, '2026-01-01', '2026-12-31')])], usdItems());

		const result = await service.activate([A], 'h-1', 'auth-1');

		expect(result.activated).toHaveLength(1);
		const [, header] = runners[0].query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;

		// vat, tax_rate, neto contrato, neto factura, sistema, total factura, total sistema, moneda contrato, factura, fx
		expect((header as unknown[]).slice(6, 16)).toEqual([126350, 19, 700, 665000, 700, 791350, 833, 'USD', 'CLP', 950]);
		const [, line] = runners[0].query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoice_items'))!;

		expect((line as unknown[]).slice(4, 13)).toEqual([100, 95000, 0, 200, 190000, 38, 36100, 238, 226100]);
		expect((line as unknown[])[18]).toBe(950);
	});

	it('la consulta lee las tasas del contrato y cuenta facturas sin legacy ni canceladas', async () => {
		const { service, dataSource } = build([draft(A)], items(A));

		await service.preview([A], 'h-1');
		const [sql] = (dataSource.query as jest.Mock).mock.calls.find(([statement]) => (statement as string).includes('FROM contracts c'))!;

		expect(sql).toMatch(
			/FROM contract_fx_period_rates r\s+WHERE r\.contract_id = c\.id AND r\.holding_id = c\.holding_id AND r\.purpose = 'invoice'\) AS fx_invoice_rates/
		);
		expect(sql).toMatch(/COALESCE\(i\.is_legacy, false\) = false\s+AND i\.status IS DISTINCT FROM 'Cancelada'\) AS invoices_count/);
		expect(sql).toMatch(/i\.is_legacy = true\s+AND i\.status IS DISTINCT FROM 'Cancelada'\) AS legacy_invoices_count/);
	});
});

describe('ContractActivationService.preview', () => {
	it('evalúa cada contrato del holding sin escribir', async () => {
		const { service, dataSource, runners } = build([draft(A), draft(B, { status: 'Activo' })], [...items(A), ...items(B)]);

		const { data } = await service.preview([A, B, MISSING, A], 'h-1');

		expect(data.map((check) => [check.id, check.can_activate])).toEqual([
			[A, true],
			[B, false],
			[MISSING, false],
		]);
		const statements = (dataSource.query as jest.Mock).mock.calls.map(([sql]) => sql as string);

		expect(statements.every((sql) => sql.trim().startsWith('SELECT'))).toBe(true);
		expect(statements[0]).toContain('c.holding_id = $2');
		expect(statements[0]).toContain("(to_jsonb(c)->>'billing_anchor_day')");
		expect(runners).toHaveLength(0);
	});
});

describe('ContractActivationService.activate', () => {
	it('facturas antes del estado, líneas con patrón B, rebuild y evento, en una transacción', async () => {
		const { service, runners } = build([draft(A)], items(A));

		const result = await service.activate([A], 'h-1', 'auth-1');

		expect(result).toEqual({ activated: [{ id: A, contract_number: 'CTR-2026-001', invoices_created: 3 }], skipped: [], failed: [] });
		expect(runners).toHaveLength(1);
		const [runner] = runners;
		const statements = sqlOf(runner);
		const index = (needle: string) => statements.findIndex((sql) => sql.includes(needle));
		const lastIndex = (needle: string) => statements.map((sql) => sql.includes(needle)).lastIndexOf(true);

		// El contrato se bloquea antes de leer los ítems.
		expect(statements[0]).toContain('FOR UPDATE OF c');
		// Todas las facturas y líneas antes de pasar a Activo; el rebuild y el evento después.
		expect(lastIndex('INSERT INTO invoice_items')).toBeLessThan(index('UPDATE contracts SET status'));
		expect(lastIndex('UPDATE invoice_items')).toBeLessThan(index('UPDATE contracts SET status'));
		expect(index('UPDATE contracts SET status')).toBeLessThan(index('revenue_schedule_rebuild'));
		expect(index('revenue_schedule_rebuild')).toBeLessThan(index(`'ACTIVATION'`));
		expect(statements.filter((sql) => sql.includes('INSERT INTO invoices'))).toHaveLength(3);
		expect(statements.some((sql) => sql.includes('contract_invoices'))).toBe(false);
		expect(statements.some((sql) => sql.includes('bypass_period_guard'))).toBe(false);

		// Patrón B: el INSERT de la línea no lleva contract_item_id; el UPDATE de su factura lo fija después.
		const lineInserts = runner.query.mock.calls.filter(([sql]) => (sql as string).includes('INSERT INTO invoice_items'));

		expect(lineInserts).toHaveLength(4);
		expect(lineInserts.every(([sql]) => !(sql as string).includes('contract_item_id'))).toBe(true);
		const firstLink = runner.query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE invoice_items'))!;

		expect(firstLink[0]).toContain('SET contract_item_id = x.contract_item_id');
		expect(firstLink[1]).toEqual([['line-2', 'line-3'], [`${A}-rec`, `${A}-setup`], 'inv-1']);
		expect(index('UPDATE invoice_items')).toBeGreaterThan(index('INSERT INTO invoice_items'));

		// Encabezado = Σ líneas, IVA explícito, misma moneda → FX 1 y montos en moneda de factura llenos.
		const [, headerParams] = runner.query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;

		expect(headerParams).toEqual([
			'company-1',
			'client-1',
			'entity-1',
			A,
			'2026-10-01',
			'2026-10-31',
			133,
			19,
			700,
			700,
			700,
			833,
			833,
			'CLP',
			'CLP',
			1,
			'FACTURA',
			0,
			'h-1',
			'Simplit SpA',
			'76.000.000-0',
			'Av. Siempre Viva 123',
			'77.777.777-7',
			false,
			true,
		]);
		const [, lineParams] = lineInserts[0];

		expect(lineParams).toEqual([
			'inv-1',
			'Licencia Cuenta Norte - Periodo 01/10/2026 a 31/10/2026',
			2,
			'Usuarios',
			100,
			100,
			0,
			200,
			200,
			38,
			38,
			238,
			238,
			'h-1',
			A,
			'p-lic',
			'CLP',
			'CLP',
			1,
			'scheduled-generation',
			'2026-10-01',
			'2026-10-01',
			'2026-10-31',
		]);

		// Pasa a Activo solo si sigue En revisión; rebuild completo; evento con usuario, cantidad y total.
		const statusUpdate = runner.query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE contracts SET status'))!;

		expect(statusUpdate[1]).toEqual([A, 'h-1', 'Activo', 'En revisión']);
		expect(runner.query.mock.calls.find(([sql]) => (sql as string).includes('revenue_schedule_rebuild'))![1]).toEqual([A]);
		const event = runner.query.mock.calls.find(([sql]) => (sql as string).includes(`'ACTIVATION'`))!;

		expect((event[1] as unknown[])[3]).toBe('user-1');
		expect(JSON.parse((event[1] as unknown[])[4] as string)).toMatchObject({
			source: 'api_v2',
			invoices_created: 3,
			total_to_invoice: 1100,
			currency: 'CLP',
		});
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
	});

	it('facturación en otra moneda: FX y montos en moneda de factura nacen NULL', async () => {
		const { service, runners } = build([draft(A, { invoice_currency: 'USD' })], items(A));

		await service.activate([A], 'h-1', 'auth-1');
		const [, headerParams] = runners[0].query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;

		expect((headerParams as unknown[])[9]).toBeNull();
		expect((headerParams as unknown[])[11]).toBeNull();
		expect((headerParams as unknown[])[14]).toBe('USD');
		expect((headerParams as unknown[])[15]).toBeNull();
	});

	it('cada contrato en su transacción: un fallo no frena al resto; los bloqueados se omiten sin escribir', async () => {
		const { service, runners } = build(
			[draft(A), draft(B), draft(MISSING, { status: 'Activo', contract_number: 'CTR-X' })],
			[...items(A), ...items(B), ...items(MISSING)],
			(sql, params) => {
				if (sql.includes('INSERT INTO invoices') && params[3] === A) throw new Error('TAX_RATE_NOT_CONFIGURED');

				return undefined;
			}
		);

		const result = await service.activate([A, B, MISSING], 'h-1', 'auth-1');

		expect(result.failed).toEqual([{ id: A, contract_number: 'CTR-2026-001', message: 'No se pudo activar: TAX_RATE_NOT_CONFIGURED' }]);
		expect(result.activated).toEqual([{ id: B, contract_number: 'CTR-2026-002', invoices_created: 3 }]);
		expect(result.skipped).toEqual([{ id: MISSING, contract_number: 'CTR-X', blockers: [expect.objectContaining({ code: 'not_draft' })] }]);
		expect(runners).toHaveLength(3);
		expect(runners[0].rollbackTransaction).toHaveBeenCalled();
		expect(runners[0].commitTransaction).not.toHaveBeenCalled();
		expect(runners[1].commitTransaction).toHaveBeenCalled();
		expect(runners[2].rollbackTransaction).toHaveBeenCalled();
		expect(sqlOf(runners[2]).some((sql) => /^\s*(INSERT|UPDATE)/.test(sql))).toBe(false);
		expect(runners.every((runner) => runner.release.mock.calls.length === 1)).toBe(true);
	});

	it('si el contrato cambió de estado entre la lectura y el UPDATE, falla sin confirmar', async () => {
		const { service, runners } = build([draft(A)], items(A), (sql) => (sql.includes('UPDATE contracts SET status') ? [] : undefined));

		const result = await service.activate([A], 'h-1', 'auth-1');

		expect(result.failed[0].message).toContain('cambió de estado');
		expect(runners[0].commitTransaction).not.toHaveBeenCalled();
	});
});

describe('ContractsController (acciones masivas y activación)', () => {
	const bulk = { updateSettings: jest.fn().mockResolvedValue({}) } as unknown as ContractBulkService;
	const activation = {
		preview: jest.fn().mockResolvedValue({ data: [] }),
		activate: jest.fn().mockResolvedValue({}),
	} as unknown as ContractActivationService;
	const controller = new ContractsController(
		{} as ContractsService,
		{} as ContractDraftsService,
		{} as ContractSubscriptionsService,
		{} as Contract360Service,
		bulk,
		activation
	);

	it('heredan SupabaseAuthGuard + HoldingScopeGuard y responden 200', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.activate)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.activatePreview)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.bulkDelete)).toBe(200);
	});

	it('pasan el holding del guard y el usuario autenticado', async () => {
		const req = { user: { sub: 'auth-1' } };

		await controller.bulkSettings({ ids: [A], auto_invoice: false }, 'h-1', req);
		await controller.activatePreview({ ids: [A] }, 'h-1');
		await controller.activate({ ids: [A, B] }, 'h-1', req);

		expect(bulk.updateSettings).toHaveBeenCalledWith({ ids: [A], auto_invoice: false }, 'h-1', 'auth-1');
		expect(activation.preview).toHaveBeenCalledWith([A], 'h-1');
		expect(activation.activate).toHaveBeenCalledWith([A, B], 'h-1', 'auth-1');
	});
});
