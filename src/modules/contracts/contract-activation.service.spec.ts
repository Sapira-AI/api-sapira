// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { API_WRITER_SQL } from './api-writer';
import { findFixedRate, fixedFxAmounts } from './billing-engine';
import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
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
		// FX a la moneda del sistema del contrato (réplica de `calculate_contract_fx_amounts`).
		if (sql.includes('fx_system_policy') && sql.includes('FROM contracts c')) {
			const contract = contracts.find((row) => row.id === params[0]);

			return contract
				? [{ contract_currency: contract.contract_currency, fx_date: '2026-10-01', system_currency: 'CLP', fx_policy: 'monthly_avg' }]
				: [];
		}
		if (sql.includes('FROM calculate_system_fx_rate')) return [{ rate: 950 }];
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
			// Sin documento del catálogo: la etiqueta es la de la familia.
			document_type_label: 'Factura',
			tax_document_type: null,
		});
		expect(plan.check.sample).toHaveLength(3);
		// Condición del contrato (30 días), no la de la razón social (60).
		expect(plan.check.sample[0]).toMatchObject({ due_date: '2026-10-31', subtotal: 700, tax: 133, total: 833, tax_rate: 19 });
		expect(plan.check.sample[0].lines.map((line) => line.item_key)).toEqual([`${A}-rec`, `${A}-setup`]);
	});

	it('glosas largas: se ajustan al límite del documento del contrato (SII 80) y la vista previa avisa description_fitted', () => {
		const long = items(A, {
			product_name: 'Plataforma de optimizacion de rutas de ultima milla para flota refrigerada',
			account: 'Santiago Centro',
		});
		const plan = ContractActivationService.evaluate(
			A,
			draft(A, { tax_document_type_id: 'tdt-33', tax_document_type_name: 'Factura electrónica', own_description_max_chars: 80 }),
			long
		);
		const descriptions = plan.engine!.invoices.flatMap((invoice) => invoice.lines.map((line) => line.description));

		expect(plan.check.can_activate).toBe(true);
		expect(descriptions.every((text) => text.length <= 80)).toBe(true);
		expect(plan.check.warning_codes).toContain('description_fitted');
		// Sin límite (contrato sin documento ni país con límite), la glosa de hoy tal cual y sin aviso.
		const unlimited = ContractActivationService.evaluate(A, draft(A, { company_country: null }), long);

		expect(unlimited.check.warning_codes).not.toContain('description_fitted');
		expect(unlimited.engine!.invoices[0].lines[0].description.length).toBeGreaterThan(80);
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
		[
			'moneda ≠ compañía emisora aunque la copia del contrato esté desalineada (manda la compañía)',
			{ contract_currency: 'USD', invoice_currency: 'USD', contract_company_currency: 'USD', company_currency: 'CLP' },
			null,
			'fx_company_policy_missing',
		],
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

	it('sin término (S1-12): el recurrente con plazo y fin NULL no bloquea; la vista previa trae hasta cuándo se generaron facturas', () => {
		const [recurring, setup] = items(A);
		const plan = ContractActivationService.evaluate(A, draft(A), [{ ...recurring, term_months: null, end_date: null, final_price: null }, setup]);

		expect(plan.check.can_activate).toBe(true);
		expect(plan.check.blockers).toEqual([]);
		// 12 meses de horizonte (la de implementación va junto a la primera).
		expect(plan.check.invoices_count).toBe(12);
		expect(plan.check.indefinite_until).toBe('2027-09-30');
		expect(plan.check.warnings.some((warning) => warning.includes('no tiene término'))).toBe(true);
		// Un ítem de pago único sin plazo sigue incompleto.
		expect(codes(ContractActivationService.evaluate(A, draft(A), [recurring, { ...setup, term_months: null }]))).toContain('incomplete_items');
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
		// Día de ciclo automático (NULL) es un estado válido, no un aviso (decisión de Domi 01-10).
		expect(plan.check.warnings.join(' ')).not.toContain('día de ciclo');
	});

	it('period_closed: bloquea si alguna factura generada se emitiría en un período cerrado, con el paso para destrabar', () => {
		const closed = ContractActivationService.evaluate(A, draft(A, { cutoff_date: '2026-10-31' }), items(A));

		expect(closed.check.can_activate).toBe(false);
		expect(closed.check.blockers).toEqual([
			{
				code: 'period_closed',
				message: expect.stringContaining('cierre al 2026-10-31'),
				next_step: expect.stringContaining('Reabrir el período'),
			},
		]);
		expect(ContractActivationService.evaluate(A, draft(A, { cutoff_date: '2026-09-30' }), items(A)).check.can_activate).toBe(true);
	});

	it('con documento tributario del catálogo, la vista previa muestra su nombre en vez de la familia', () => {
		const plan = ContractActivationService.evaluate(
			A,
			draft(A, {
				document_type: 'FACTURA_EXPORTACION',
				tax_document_type_id: 'tdt-110',
				tax_document_type_code: '110',
				tax_document_type_name: 'Factura de exportación electrónica',
			}),
			items(A)
		);

		expect(plan.check.document_type).toBe('FACTURA_EXPORTACION');
		expect(plan.check.document_type_label).toBe('Factura de exportación electrónica');
		expect(plan.check.tax_document_type).toEqual({ id: 'tdt-110', code: '110', name: 'Factura de exportación electrónica' });
		// La familia sigue gobernando el IVA y el export_type de las facturas.
		expect(plan.check.sample[0]).toMatchObject({ export_type: 1, tax_rate: 0 });
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

	it('sin tasa (o sin cubrir algún período): se puede activar con aviso; la tasa se define por factura antes de emitir', () => {
		const none = ContractActivationService.evaluate(A, fixedDraft([]), usdItems());

		expect(codes(none)).toEqual([]);
		expect(none.check.can_activate).toBe(true);
		expect(none.check.warnings).toContain(
			'Tipo de cambio fijo sin tasa: define la tasa por factura antes de emitir (3 facturas sin tasa USD → CLP, desde el 2026-10-01)'
		);
		expect(none.fixedRates).toEqual([null, null, null]);

		const partial = ContractActivationService.evaluate(A, fixedDraft([rate('USD', 'CLP', 950, '2026-10-01', '2026-11-15')]), usdItems());

		expect(codes(partial)).toEqual([]);
		expect(partial.check.warnings).toContain(
			'Tipo de cambio fijo sin tasa: define la tasa por factura antes de emitir (1 factura sin tasa USD → CLP, desde el 2026-12-01)'
		);
		expect(partial.fixedRates).toEqual([950, 950, null]);
	});

	it('activar: fx y montos en moneda de factura llenos en encabezado y líneas', async () => {
		const { service, runners } = build([fixedDraft([rate('USD', 'CLP', 950, '2026-01-01', '2026-12-31')])], usdItems());

		const result = await service.activate([A], 'h-1', 'auth-1');

		expect(result.activated).toHaveLength(1);
		const [, header] = runners[0].query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;

		// vat, tax_rate, neto contrato, neto factura, total factura, moneda contrato, factura, fx (los de sistema los escribe
		// `refreshInvoiceSystemAmounts` después del INSERT).
		expect((header as unknown[]).slice(6, 14)).toEqual([126350, 19, 700, 665000, 791350, 'USD', 'CLP', 950]);
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
		expect(statements[0]).toContain('c.billing_anchor_day');
		expect(runners).toHaveLength(0);
	});
});

describe('ContractActivationService.activate', () => {
	it('costura: marca primero; facturas con contract_item_id (sin patrón B), booking/FX antes del estado, rebuild y evento', async () => {
		const { service, runners } = build([draft(A)], items(A), (sql) =>
			sql.includes('SELECT status, booking_date::text AS booking_date, company_currency, fx_rate_to_system FROM contracts')
				? [{ status: 'Activo', booking_date: '2026-10-01', company_currency: 'CLP', fx_rate_to_system: '1' }]
				: undefined
		);

		const result = await service.activate([A], 'h-1', 'auth-1');

		expect(result).toEqual({
			activated: [{ id: A, contract_number: 'CTR-2026-001', invoices_created: 3, warning_codes: [] }],
			skipped: [],
			failed: [],
		});
		expect(runners).toHaveLength(1);
		const [runner] = runners;
		const statements = sqlOf(runner);
		const index = (needle: string) => statements.findIndex((sql) => sql.includes(needle));
		const lastIndex = (needle: string) => statements.map((sql) => sql.includes(needle)).lastIndexOf(true);

		// La marca `sapira.writer = 'api'` es la primera sentencia; después se bloquea el contrato antes de leer los ítems.
		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements[1]).toContain('FOR UPDATE OF c');
		// Todas las facturas y líneas antes de pasar a Activo; el rebuild y el evento después.
		expect(lastIndex('INSERT INTO invoice_items')).toBeLessThan(index('UPDATE contracts SET status'));
		expect(index('UPDATE contracts SET status')).toBeLessThan(index('revenue_schedule_rebuild'));
		expect(index('revenue_schedule_rebuild')).toBeLessThan(index(`'ACTIVATION'`));
		expect(statements.filter((sql) => sql.includes('INSERT INTO invoices'))).toHaveLength(3);
		expect(statements.some((sql) => sql.includes('contract_invoices'))).toBe(false);
		expect(statements.some((sql) => sql.includes('bypass_period_guard'))).toBe(false);

		// Sin patrón B: la línea nace con su ítem y no hay UPDATE posterior de invoice_items.
		const lineInserts = runner.query.mock.calls.filter(([sql]) => (sql as string).includes('INSERT INTO invoice_items'));

		expect(lineInserts).toHaveLength(4);
		expect(lineInserts.every(([sql]) => (sql as string).includes('invoice_id, contract_item_id,'))).toBe(true);
		expect(statements.some((sql) => sql.includes('UPDATE invoice_items'))).toBe(false);
		// Estado y fecha de la línea = los del encabezado (lo que hacía `auto_populate_invoice_item_fields`).
		expect(lineInserts[0][0]).toContain(
			'(SELECT h.status FROM invoices h WHERE h.id = $1), (SELECT h.issue_date FROM invoices h WHERE h.id = $1)'
		);

		// Booking (hoy si es null) y company_currency = la de la compañía emisora (regla v2), con el contrato todavía en
		// borrador; FX a sistema antes del estado.
		const booking = runner.query.mock.calls.find(([sql]) => (sql as string).includes('booking_date = COALESCE(booking_date, CURRENT_DATE)'))!;

		expect(booking[0]).toContain(
			'company_currency = COALESCE((SELECT co.currency FROM companies co WHERE co.id = contracts.company_id), company_currency)'
		);
		expect(booking[1]).toEqual([A, 'h-1', 'En revisión']);
		expect(index('booking_date = COALESCE')).toBeLessThan(index('UPDATE contracts SET status'));
		expect(index('UPDATE contracts SET fx_rate_to_system')).toBeGreaterThan(index('booking_date = COALESCE'));
		expect(index('UPDATE contracts SET fx_rate_to_system')).toBeLessThan(index('UPDATE contracts SET status'));

		// Encabezado = Σ líneas, IVA explícito, misma moneda → FX 1 y montos en moneda de factura llenos; id propio = grupo.
		const [headerSql, headerParams] = runner.query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;
		const invoiceId = 'inv-1';

		// id generado en el mismo INSERT y `invoice_group_id = id` (antes `assign_invoice_group_id`); condiciones del contrato.
		expect(headerSql).toContain('id, invoice_group_id,');
		expect(headerSql).toMatch(/SELECT\s+g\.id, g\.id,/);
		expect(headerSql).toContain('FROM (SELECT gen_random_uuid() AS id) g');
		expect(headerSql).toContain('(SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $4::uuid)');
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
			invoiceId,
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
			// Pricing v2: línea de hoy → cantidad fija, sin desglose.
			'fixed',
			null,
			`${A}-rec`,
		]);
		// Montos en moneda del sistema de las 3 facturas creadas (réplica de `auto_populate_invoice_fx_to_system`).
		const refresh = runner.query.mock.calls.find(([sql]) => (sql as string).includes('COALESCE(hs.system_currency'))!;

		expect((refresh[1] as unknown[])[0]).toHaveLength(3);
		expect((refresh[1] as unknown[])[0]).toContain(invoiceId);

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
			// Antes/después de lo que escribe la activación, avisos, horizonte, facturas creadas e ítems afectados.
			before: { status: 'En revisión', booking_date: null, company_currency: 'CLP', fx_rate_to_system: null },
			after: { status: 'Activo', booking_date: '2026-10-01', company_currency: 'CLP', fx_rate_to_system: 1 },
			warning_codes: [],
			indefinite_until: null,
			created_invoice_ids: ['inv-1', expect.any(String), expect.any(String)],
			items_affected: [`${A}-rec`, `${A}-setup`],
		});
		expect(JSON.parse((event[1] as unknown[])[5] as string)).toEqual([`${A}-rec`, `${A}-setup`]);
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
	});

	it('facturación en otra moneda: FX y montos en moneda de factura nacen NULL', async () => {
		const { service, runners } = build([draft(A, { invoice_currency: 'USD' })], items(A));

		await service.activate([A], 'h-1', 'auth-1');
		const [, headerParams] = runners[0].query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO invoices'))!;

		// neto y total en moneda de factura, moneda de factura y fx.
		expect((headerParams as unknown[])[9]).toBeNull();
		expect((headerParams as unknown[])[10]).toBeNull();
		expect((headerParams as unknown[])[12]).toBe('USD');
		expect((headerParams as unknown[])[13]).toBeNull();
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
		expect(result.activated).toEqual([{ id: B, contract_number: 'CTR-2026-002', invoices_created: 3, warning_codes: [] }]);
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
		activation,
		{} as ConsumptionService,
		{} as ContractChangesService,
		{} as ContractInvoicesService,
		{} as ContractInvoiceDescriptionsService,

		{} as ContractInvoiceEditService,
		{} as never,
		{} as never,
		{} as never
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
