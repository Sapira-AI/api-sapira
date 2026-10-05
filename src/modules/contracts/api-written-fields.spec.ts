import * as fs from 'fs';
import * as path from 'path';

import { API_WRITER_SQL, setApiWriter, withApiWriter } from './api-writer';
import {
	classifyClientItem,
	contractFxNeedsRefresh,
	frequencyMultiplier,
	INVOICE_FROM_INVOICE_CURRENCY_SQL,
	INVOICE_HAS_INVOICE_AMOUNT_SQL,
	INVOICE_HEADER_CURRENCY_SQL,
	INVOICE_SYSTEM_SOURCE_CURRENCY_SQL,
	invoiceTermsSql,
	itemCategoriaSql,
	latestContractEnd,
	MIRROR_BY_INVOICE_SQL,
	mirrorInvoiceSystemAmounts,
	pgRound,
	pricingFields,
	refreshContractSystemFx,
	refreshInvoiceSystemAmounts,
	syncContractTerm,
	systemFxDivides,
	TAX_RATE_PCT_SQL,
} from './api-written-fields';

import type { DataSource, QueryRunner } from 'typeorm';

/**
 * Costura `sapira.writer = 'api'` del lado de la API: la marca es la primera sentencia de toda transacción v2 que escribe, y
 * los campos que rellenaban triggers legacy los escribe la API con réplicas exactas (regla
 * `docs/reglas-desarrollo/logica-en-api-triggers.md`).
 */

type Row = Record<string, unknown>;
const db = (handler: (sql: string, params: unknown[]) => unknown = () => undefined) => {
	const query = jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params) ?? []);

	return { runner: { query } as unknown as QueryRunner, query };
};
const sqls = (query: jest.Mock) => query.mock.calls.map(([sql]) => sql as string);
const squashSql = (sql: string) => sql.replace(/\s+/g, ' ');

describe('latestContractEnd: una sola regla para contract_end_date (decisión de Domi 01-10)', () => {
	it('mayor fin de los recurrentes vivos; indefinido → null; sin vivos → undefined (se conserva el guardado)', () => {
		expect(
			latestContractEnd([
				{ is_recurring: true, end_date: '2026-12-31' },
				{ is_recurring: true, end_date: '2027-06-30' },
				// No cuentan: no recurrente, espejo de baja, con baja y renovado.
				{ is_recurring: false, end_date: '2028-01-31' },
				{ is_recurring: true, end_date: '2029-01-31', categoria: 'CHURN' },
				{ is_recurring: true, end_date: '2029-01-31', churn_date: '2026-10-01' },
				{ is_recurring: true, end_date: '2029-01-31', renewed_by_item_id: 'r-1' },
			])
		).toBe('2027-06-30');
		expect(
			latestContractEnd([
				{ is_recurring: true, end_date: '2026-12-31' },
				{ is_recurring: true, end_date: null },
			])
		).toBeNull();
		expect(latestContractEnd([{ is_recurring: false, end_date: '2026-12-31' }])).toBeUndefined();
	});
});

describe('api-writer', () => {
	it('setApiWriter fija la marca local a la transacción', async () => {
		const { runner, query } = db();

		await setApiWriter(runner);
		expect(API_WRITER_SQL).toBe(`SELECT set_config('sapira.writer', 'api', true)`);
		expect(query).toHaveBeenCalledWith(API_WRITER_SQL);
	});

	it('withApiWriter: abre, marca como primera sentencia, confirma y libera; si falla revierte', async () => {
		const runner = {
			connect: jest.fn(),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
			query: jest.fn(async () => [{ id: 'x' }]),
		};
		const dataSource = { createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;

		await expect(withApiWriter(dataSource, (tx) => tx.query('UPDATE prices SET name = $1', ['n']))).resolves.toEqual([{ id: 'x' }]);
		expect(runner.query.mock.calls[0]).toEqual([API_WRITER_SQL]);
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(1);

		await expect(withApiWriter(dataSource, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.release).toHaveBeenCalledTimes(2);
	});
});

describe('costura en todos los servicios v2 que escriben (texto de los servicios)', () => {
	const modules = path.join(__dirname, '..');
	const services = [
		...fs.readdirSync(__dirname).map((file) => path.join(__dirname, file)),
		...fs.readdirSync(path.join(modules, 'quotes')).map((file) => path.join(modules, 'quotes', file)),
	].filter((file) => file.endsWith('.service.ts'));

	it.each(services.map((file) => [path.relative(modules, file), file]))(
		'%s: cada startTransaction() va seguido de setApiWriter(runner) y ninguna escritura queda fuera de transacción',
		(_name, file) => {
			const source = fs.readFileSync(file, 'utf8');
			const starts = source.split('await runner.startTransaction();').slice(1);

			for (const rest of starts) {
				// La primera sentencia que va a la base después de abrir la transacción es la marca.
				const firstAwait = rest
					.split('\n')
					.map((line) => line.trim())
					.find((line) => line.startsWith('await ') || line.includes('await '));

				expect(firstAwait).toBe('await setApiWriter(runner);');
			}
			// La marca solo se fija con el helper, y no hay INSERT/UPDATE/DELETE por `this.dataSource.query` (autocommit sin marca).
			expect(source).not.toContain(`set_config('sapira.writer'`);
			expect(source).not.toMatch(/this\.dataSource\.query(<[^>]+>)?\(\s*`\s*(INSERT|UPDATE|DELETE)\b/);
		}
	);

	it('cubre los servicios que escriben: activación, borradores, masivos, cambios, facturas, descripciones y referencias, consumos, precios, métricas y cotizaciones', () => {
		const withMarker = services
			.filter((file) => /setApiWriter|withApiWriter/.test(fs.readFileSync(file, 'utf8')))
			.map((file) => path.basename(file));

		expect(withMarker.sort()).toEqual(
			[
				'billable-metrics.service.ts',
				'consumption.service.ts',
				'contract-activation.service.ts',
				'contract-bulk.service.ts',
				'contract-changes.service.ts',
				'contract-drafts.service.ts',
				'contract-invoice-consolidation.service.ts',
				'contract-invoice-descriptions.service.ts',
				'contract-invoice-edit.service.ts',
				'contract-invoice-partial-po.service.ts',
				'contract-invoice-reorganize.service.ts',
				'contract-invoice-void.service.ts',
				'contract-invoices.service.ts',
				'contract-renewals.service.ts',
				'contract-scheduled-changes.service.ts',
				'prices.service.ts',
				'quote-stages.service.ts',
				'quotes.service.ts',
			].sort()
		);
	});
});

describe('pricingFields: réplica de auto_calculate_pricing_fields + calculate_monthly_and_period_prices', () => {
	const base = {
		unit_price: 100,
		annual_unit_price: null,
		price_entry_mode: 'monthly',
		quantity: 2,
		billing_frequency: 'Mensual',
		is_recurring: true,
		final_price: 2160,
		term_months: 12,
		discount_type: 'Porcentaje',
		discount_value: 10,
	};

	it('mensual con descuento porcentual: anual = unitario × 12, mensual = unitario × cantidad × (1 − %), período × meses', () => {
		expect(pricingFields(base, 'contract_items')).toEqual({
			unit_price: 100,
			annual_unit_price: 1200,
			annual_price: 2400,
			price_entry_mode: 'monthly',
			monthly_price: 180,
			billing_period_price: 180,
		});
		expect(pricingFields({ ...base, billing_frequency: 'Trimestral' }, 'quote_items').billing_period_price).toBe(540);
	});

	it('modo anual: unitario = anual ÷ 12 (6 decimales) y el período sale del total anual', () => {
		expect(
			pricingFields(
				{
					...base,
					unit_price: null,
					annual_unit_price: 1000,
					price_entry_mode: 'annual',
					quantity: 3,
					billing_frequency: 'Anual',
					discount_type: null,
					discount_value: 0,
				},
				'contract_items'
			)
		).toEqual({
			unit_price: 83.333333,
			annual_unit_price: 1000,
			annual_price: 3000,
			price_entry_mode: 'annual',
			monthly_price: 250,
			billing_period_price: 3000,
		});
	});

	it('modo anual con descuento (regla v2: el trigger dejaba el período bruto): % sobre el total anual; monto fijo → mensual × meses', () => {
		const annual = {
			...base,
			unit_price: null,
			annual_unit_price: 1200,
			price_entry_mode: 'annual',
			quantity: 2,
			billing_frequency: 'Trimestral',
			final_price: 2160,
			term_months: 12,
		};

		// 2 × 100 × 0,9 = 180 al mes; el trimestre = 2.400 × 0,9 × 3 / 12 = 540 (el trigger dejaba 600, sin el descuento).
		expect(pricingFields(annual, 'contract_items')).toMatchObject({
			unit_price: 100,
			annual_price: 2400,
			monthly_price: 180,
			billing_period_price: 540,
		});
		expect(pricingFields(annual, 'quote_items').billing_period_price).toBe(540);
		// Monto fijo: mensual = final ÷ plazo = 2.100 / 12 = 175; período = 175 × 3 (el trigger dejaba 600).
		expect(pricingFields({ ...annual, discount_type: 'Monto fijo', discount_value: 300, final_price: 2100 }, 'contract_items')).toMatchObject({
			monthly_price: 175,
			billing_period_price: 525,
		});
		// Sin descuento sigue saliendo del total anual (exacto al centavo): 1.000 × 3 / 12 con unitario 83,333333.
		expect(
			pricingFields({ ...annual, annual_unit_price: 1000, quantity: 1, discount_type: null, discount_value: 0 }, 'contract_items')
				.billing_period_price
		).toBe(250);
	});

	it('una vez (regla v2, U6): sin mensual; período = el final completo (el trigger lo repartía por período)', () => {
		expect(pricingFields({ ...base, is_recurring: false, final_price: 900, term_months: 3 }, 'contract_items')).toMatchObject({
			monthly_price: null,
			billing_period_price: 900,
		});
	});

	it('CHURN/DOWNSELL solo en contract_items: mensual = final ÷ plazo (negativo)', () => {
		const churn = { ...base, categoria: 'CHURN', final_price: -600, term_months: 3, billing_frequency: 'Trimestral' };

		expect(pricingFields(churn, 'contract_items')).toMatchObject({ monthly_price: -200, billing_period_price: -600 });
		expect(pricingFields(churn, 'quote_items')).toMatchObject({ monthly_price: 180, billing_period_price: 540 });
	});

	it('monto fijo: final ÷ plazo; sin final, base − descuento con piso 0; modo nulo → monthly', () => {
		expect(
			pricingFields({ ...base, quantity: 1, discount_type: 'Monto fijo', discount_value: 50, final_price: 2850 }, 'contract_items')
				.monthly_price
		).toBe(237.5);
		expect(
			pricingFields({ ...base, quantity: 1, discount_type: 'Monto fijo', discount_value: 150, final_price: null }, 'contract_items')
				.monthly_price
		).toBe(0);
		expect(pricingFields({ ...base, price_entry_mode: null }, 'quote_items').price_entry_mode).toBe('monthly');
		// Monto fijo sin término (indefinido, regla v2): final ÷ horizonte de 12 períodos (mensual → 12 meses) = 2.850 / 12.
		expect(
			pricingFields(
				{ ...base, quantity: 1, discount_type: 'Monto fijo', discount_value: 50, final_price: 2850, term_months: null },
				'contract_items'
			).monthly_price
		).toBe(237.5);
	});

	it('redondeo como ROUND de Postgres (half away from zero) y frecuencias en minúsculas', () => {
		expect(pgRound(0.335, 2)).toBe(0.34);
		expect(pgRound(-2.5, 0)).toBe(-3);
		expect(pgRound(1.005, 2)).toBe(1.01);
		expect([frequencyMultiplier('BIANUAL'), frequencyMultiplier('semestral'), frequencyMultiplier(null), frequencyMultiplier('rara')]).toEqual([
			24, 6, 1, 1,
		]);
	});
});

describe('refreshInvoiceSystemAmounts: regla por estado → moneda de sistema, sentido de la tasa por política (regla v2, 04-10)', () => {
	it('misma moneda → FX 1; monthly_avg (directa) multiplica; fixed_period (inversa del holding) divide; sin tasa → FX NULL; tasas cacheadas', async () => {
		const invoices: Row[] = [
			{ id: 'i-usd', source_currency: 'USD', from_invoice: true, fx_date: '2026-10-01', system_currency: 'USD', fx_policy: 'monthly_avg' },
			{ id: 'i-mxn-1', source_currency: 'MXN', from_invoice: true, fx_date: '2026-10-01', system_currency: 'USD', fx_policy: 'monthly_avg' },
			{ id: 'i-mxn-2', source_currency: 'MXN', from_invoice: true, fx_date: '2026-10-01', system_currency: 'USD', fx_policy: 'monthly_avg' },
			{
				id: 'i-clp-fijo',
				source_currency: 'CLP',
				from_invoice: true,
				fx_date: '2026-10-01',
				system_currency: 'USD',
				fx_policy: 'fixed_period',
			},
			{ id: 'i-eur', source_currency: 'EUR', from_invoice: true, fx_date: '2026-11-01', system_currency: 'USD', fx_policy: 'fixed_period' },
			{
				id: 'i-sin-moneda',
				source_currency: null,
				from_invoice: false,
				fx_date: '2026-10-01',
				system_currency: 'USD',
				fx_policy: 'monthly_avg',
			},
		];
		const { runner, query } = db((sql, params) => {
			if (sql.includes('COALESCE(hs.system_currency')) return invoices;
			if (sql.includes('calculate_system_fx_rate')) {
				// Promedio mensual directo (1 MXN = 0,0569 USD); tasa fija del holding inversa (950 CLP por 1 USD).
				if (params[1] === 'MXN') return [{ rate: '0.0569' }];
				if (params[1] === 'CLP') return [{ rate: '950' }];

				return [{ rate: null }];
			}

			return undefined;
		});

		await refreshInvoiceSystemAmounts(runner, 'h-1', ['i-usd', 'i-mxn-1', 'i-mxn-2', 'i-clp-fijo', 'i-eur', 'i-sin-moneda', 'i-usd']);
		const [select] = query.mock.calls;

		expect(select[1]).toEqual([['i-usd', 'i-mxn-1', 'i-mxn-2', 'i-clp-fijo', 'i-eur', 'i-sin-moneda'], 'h-1']);
		expect(select[0]).toContain('COALESCE(i.issue_date, i.scheduled_at, i.original_issue_date, CURRENT_DATE)');
		expect(select[0]).toContain(`COALESCE(hs.system_currency, 'USD')`);
		expect(select[0]).toContain(`${INVOICE_SYSTEM_SOURCE_CURRENCY_SQL} AS source_currency, ${INVOICE_FROM_INVOICE_CURRENCY_SQL} AS from_invoice`);
		// Sin líneas "sin vueltas" ni tasas ítem → contrato: la regla del 01-10 quedó reemplazada.
		expect(select[0]).not.toContain('invoice_items');
		expect(select[0]).not.toContain('contract_fx_period_rates');
		const updates = query.mock.calls.filter(([sql]) => (sql as string).startsWith('UPDATE invoices'));

		expect(updates.map(([, params]) => (params as unknown[])[0])).toEqual(['i-usd', 'i-mxn-1', 'i-mxn-2', 'i-clp-fijo', 'i-eur']);
		// Factura en la moneda de sistema: el mismo neto facturado, sin convertir.
		expect(updates[0][0]).toContain('fx_contract_to_system = 1.0');
		expect(updates[0][0]).toContain('amount_system_currency = amount_invoice_currency');
		expect(updates[0][0]).toContain(`total_system_currency = ROUND(amount_invoice_currency * (1 + ${TAX_RATE_PCT_SQL} / 100.0), 2)`);
		expect(updates[1][0]).toContain(
			'amount_system_currency = ROUND(CASE WHEN $5::boolean THEN amount_invoice_currency / NULLIF($3::numeric, 0) ELSE amount_invoice_currency * $3::numeric END, 2)'
		);
		expect(updates[1][0]).not.toContain('amount_contract_currency');
		// monthly_avg → multiplica (divides = false); fixed_period → divide (divides = true). La tasa guardada es la del lookup.
		expect(updates[1][1]).toEqual(['i-mxn-1', 'h-1', 0.0569, 'USD', false]);
		expect(updates[3][1]).toEqual(['i-clp-fijo', 'h-1', 950, 'USD', true]);
		expect(updates[4][0]).toContain('fx_contract_to_system = NULL');
		expect(updates[4][0]).not.toContain('amount_system_currency');
		// La tasa MXN → USD del mismo día se busca una vez; siempre desde la moneda de factura.
		const lookups = query.mock.calls.filter(([sql]) => (sql as string).includes('calculate_system_fx_rate'));

		expect(lookups.map(([, params]) => params)).toEqual([
			['h-1', 'MXN', 'USD', '2026-10-01', 'monthly_avg'],
			['h-1', 'CLP', 'USD', '2026-10-01', 'fixed_period'],
			['h-1', 'EUR', 'USD', '2026-11-01', 'fixed_period'],
		]);
	});

	it('regla por estado: documento con neto → moneda de factura; Por Emitir (o sin neto) → moneda de contrato del encabezado', () => {
		// Neto 0 con monto en contrato ≠ 0 = aún sin valorizar en moneda de factura → encabezado.
		expect(squashSql(INVOICE_HAS_INVOICE_AMOUNT_SQL)).toBe(
			`(i.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(i.invoice_currency), '') IS NOT NULL AND (i.amount_invoice_currency <> 0 OR COALESCE(i.amount_contract_currency, 0) = 0))`
		);
		expect(INVOICE_FROM_INVOICE_CURRENCY_SQL).toBe(`(i.status IS DISTINCT FROM 'Por Emitir' AND ${INVOICE_HAS_INVOICE_AMOUNT_SQL})`);
		expect(INVOICE_HEADER_CURRENCY_SQL).toBe(`UPPER(TRIM(COALESCE(NULLIF(TRIM(i.contract_currency), ''), c.contract_currency)))`);
		expect(INVOICE_SYSTEM_SOURCE_CURRENCY_SQL).toBe(
			`(CASE WHEN ${INVOICE_FROM_INVOICE_CURRENCY_SQL} THEN UPPER(TRIM(i.invoice_currency)) ELSE ${INVOICE_HEADER_CURRENCY_SQL} END)`
		);
	});

	it('el trigger aplica la misma regla por estado que la API (Por Emitir → contrato; documento → factura; al emitir recalcula)', () => {
		const trigger = fs.readFileSync(path.join(__dirname, '../../databases/postgresql/functions/auto_populate_invoice_fx_to_system.sql'), 'utf8');

		expect(trigger).toContain(`IF NEW.status IS DISTINCT FROM 'Por Emitir'
     AND NEW.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(NEW.invoice_currency), '') IS NOT NULL
     AND (NEW.amount_invoice_currency <> 0 OR COALESCE(NEW.amount_contract_currency, 0) = 0) THEN`);
		expect(trigger).toContain(
			`SELECT UPPER(TRIM(COALESCE(NULLIF(TRIM(NEW.contract_currency), ''), c.contract_currency))) INTO v_contract_currency`
		);
		// BEFORE INSERT OR UPDATE: el UPDATE de estado de la emisión (envío al ERP / webhook, sin la marca) recalcula.
		expect(
			fs.readFileSync(path.join(__dirname, '../../databases/postgresql/triggers/trigger_auto_populate_invoice_fx_to_system.sql'), 'utf8')
		).toContain('BEFORE INSERT OR UPDATE ON public.invoices');
	});

	it('documentos: contrato USD facturado en CLP y unificado multimoneda (ex F1): se convierte el neto en CLP con la tasa CLP → USD, sin líneas directas', async () => {
		const invoices: Row[] = [
			// FAC de un contrato USD que se cobra en CLP: neto 930.000 CLP (no los 1.000 USD del contrato).
			{
				id: 'i-usd-en-clp',
				source_currency: 'CLP',
				from_invoice: true,
				fx_date: '2026-08-31',
				system_currency: 'USD',
				fx_policy: 'fixed_period',
			},
			// FAC 027725 (CTR-2026-151, contrato USD): unificado USD 299 + CLF 6,6 → 549.352,90 CLP; la línea USD ya no entra directo.
			{
				id: 'i-unificada',
				source_currency: 'CLP',
				from_invoice: true,
				fx_date: '2026-07-31',
				system_currency: 'USD',
				fx_policy: 'fixed_period',
				amount_contract_currency: '549352.90',
			},
		];
		const { runner, query } = db((sql, params) => {
			if (sql.includes('COALESCE(hs.system_currency')) return invoices;
			if (sql.includes('calculate_system_fx_rate')) return [{ rate: params[1] === 'CLP' ? '930' : null }];

			return undefined;
		});

		await refreshInvoiceSystemAmounts(runner, 'h-1', ['i-usd-en-clp', 'i-unificada']);
		const [select] = query.mock.calls;

		expect(select[0]).toContain(`${INVOICE_FROM_INVOICE_CURRENCY_SQL} AS from_invoice`);
		const lookups = query.mock.calls.filter(([sql]) => (sql as string).includes('calculate_system_fx_rate'));

		expect(lookups.map(([, params]) => (params as unknown[])[1])).toEqual(['CLP', 'CLP']);
		const updates = query.mock.calls.filter(([sql]) => (sql as string).startsWith('UPDATE invoices'));

		expect(updates.map(([, params]) => params)).toEqual([
			['i-usd-en-clp', 'h-1', 930, 'USD', true],
			['i-unificada', 'h-1', 930, 'USD', true],
		]);
		expect(updates.every(([sql]) => (sql as string).includes('amount_invoice_currency / NULLIF($3::numeric, 0)'))).toBe(true);
	});

	it('Por Emitir: siempre desde la moneda de contrato del encabezado (también la unificada multimoneda en CLP), sin líneas directas', async () => {
		const invoices: Row[] = [
			// Contrato CLF que se factura en CLP, Por Emitir: el monto en CLF del encabezado con la tasa CLF → USD (aunque tenga neto en CLP).
			{ id: 'pe-clf', source_currency: 'CLF', from_invoice: false, fx_date: '2026-10-01', system_currency: 'USD', fx_policy: 'fixed_period' },
			// Unificada multimoneda Por Emitir (CTR-2026-90-LuvEnv): encabezado en CLP → tasa CLP → USD (antes: CLF sobre un monto en CLP).
			{ id: 'pe-mixta', source_currency: 'CLP', from_invoice: false, fx_date: '2026-10-01', system_currency: 'USD', fx_policy: 'fixed_period' },
			// Contrato USD que se facturará en CLP: el encabezado en USD tal cual.
			{ id: 'pe-usd', source_currency: 'USD', from_invoice: false, fx_date: '2026-11-01', system_currency: 'USD', fx_policy: 'fixed_period' },
		];
		const { runner, query } = db((sql, params) => {
			if (sql.includes('COALESCE(hs.system_currency')) return invoices;
			if (sql.includes('calculate_system_fx_rate')) return [{ rate: params[1] === 'CLF' ? '0.025' : '930' }];

			return undefined;
		});

		await refreshInvoiceSystemAmounts(runner, 'h-1', ['pe-clf', 'pe-mixta', 'pe-usd']);
		const updates = query.mock.calls.filter(([sql]) => (sql as string).startsWith('UPDATE invoices'));

		expect(updates.map(([, params]) => params)).toEqual([
			['pe-clf', 'h-1', 0.025, 'USD', true],
			['pe-mixta', 'h-1', 930, 'USD', true],
			['pe-usd', 'h-1', 'USD'],
		]);
		expect(updates[0][0]).toContain('amount_contract_currency / NULLIF($3::numeric, 0)');
		expect(updates[0][0]).not.toContain('amount_invoice_currency');
		expect(updates[2][0]).toContain('amount_system_currency = amount_contract_currency');
	});

	it('systemFxDivides: solo fixed_period divide (tabla del holding inversa); monthly_avg y sin política multiplican', () => {
		expect([systemFxDivides('fixed_period'), systemFxDivides('monthly_avg'), systemFxDivides(null)]).toEqual([true, false, false]);
	});

	it('IVA del encabezado en % entero aunque la factura traiga la escala 0,19 (Tanda 2)', () => {
		expect(TAX_RATE_PCT_SQL).toBe('(CASE WHEN tax_rate > 0 AND tax_rate <= 1 THEN tax_rate * 100 ELSE COALESCE(tax_rate, 0) END)');
	});

	it('sin ids no consulta nada', async () => {
		const { runner, query } = db();

		await refreshInvoiceSystemAmounts(runner, 'h-1', []);
		expect(query).not.toHaveBeenCalled();
	});
});

describe('mirrorInvoiceSystemAmounts: NC espejo con la tasa de la original (regla v2, ROADMAP #10)', () => {
	it('toma FX, moneda y tasa efectiva de la original (neto en moneda de factura × sistema ÷ neto de la original; respaldo: contrato); sin montos en la original cae al refresh', async () => {
		const copied = db((sql) => (sql.startsWith('UPDATE invoices n') ? [{ id: 'nc-1' }] : undefined));

		await mirrorInvoiceSystemAmounts(copied.runner, 'h-1', 'nc-1', 'inv-1');
		expect(copied.query).toHaveBeenCalledTimes(1);
		const [sql, params] = copied.query.mock.calls[0];

		expect(sql).toContain('fx_contract_to_system = o.fx_contract_to_system, system_currency = o.system_currency');
		// Tasa efectiva de la original sobre el neto en moneda de factura (misma moneda de factura); si no, sobre el monto en contrato.
		// Tasa efectiva sobre el neto en moneda de factura solo si la original ya es documento (regla por estado, 04-10).
		expect(squashSql(MIRROR_BY_INVOICE_SQL)).toBe(
			`n.amount_invoice_currency IS NOT NULL AND COALESCE(o.amount_invoice_currency, 0) <> 0 AND o.status IS DISTINCT FROM 'Por Emitir' AND UPPER(TRIM(n.invoice_currency)) = UPPER(TRIM(o.invoice_currency))`
		);
		expect(squashSql(sql as string)).toContain(
			`amount_system_currency = ROUND(CASE WHEN ${squashSql(MIRROR_BY_INVOICE_SQL)} THEN n.amount_invoice_currency * o.amount_system_currency / o.amount_invoice_currency ELSE n.amount_contract_currency * o.amount_system_currency / o.amount_contract_currency END, 2)`
		);
		expect(sql).toContain('(CASE WHEN n.tax_rate > 0 AND n.tax_rate <= 1 THEN n.tax_rate * 100 ELSE COALESCE(n.tax_rate, 0) END)');
		expect(params).toEqual(['nc-1', 'inv-1', 'h-1']);

		const fallback = db();

		await mirrorInvoiceSystemAmounts(fallback.runner, 'h-1', 'nc-1', 'inv-1');
		// Sin fila actualizada: `refreshInvoiceSystemAmounts` de la NC (lee la factura y su contrato).
		expect(sqls(fallback.query)[1]).toContain('COALESCE(hs.system_currency');
		expect(fallback.query.mock.calls[1][1]).toEqual([['nc-1'], 'h-1']);
	});
});

describe('refreshContractSystemFx: calculate_contract_fx_amounts(uuid) con el sentido de la tasa por política (regla v2)', () => {
	const contract = (overrides: Row = {}) => ({
		contract_currency: 'MXN',
		fx_date: '2026-10-01',
		system_currency: 'USD',
		fx_policy: 'monthly_avg',
		...overrides,
	});

	it('con tasa: UPDATE en SAVEPOINT de fx_rate_to_system, total × o ÷ tasa según la política (2 decimales) y moneda del sistema', async () => {
		const run = async (overrides: Row, rate: number) => {
			const { runner, query } = db((sql) => {
				if (sql.includes('FROM contracts c')) return [contract(overrides)];
				if (sql.includes('calculate_system_fx_rate')) return [{ rate }];

				return undefined;
			});

			expect(await refreshContractSystemFx(runner, 'c-1', 'h-1')).toBe(true);

			return query;
		};
		// Promedio mensual directo: 1 MXN = 0,0569 USD → total × tasa.
		const monthly = await run({}, 0.0569);

		expect(sqls(monthly)[0]).toContain('COALESCE(c.booking_date, CURRENT_DATE)');
		const update = monthly.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE contracts'))!;

		expect(update[0]).toContain(
			'total_value_system_currency = ROUND(CASE WHEN $5::boolean THEN total_value / NULLIF($3::numeric, 0) ELSE total_value * $3::numeric END, 2)'
		);
		expect(update[1]).toEqual(['c-1', 'h-1', 0.0569, 'USD', false]);
		expect(sqls(monthly).filter((sql) => sql.includes('SAVEPOINT'))).toEqual([
			'SAVEPOINT contract_system_fx',
			'RELEASE SAVEPOINT contract_system_fx',
		]);
		// Tasa fija del holding (inversa, 950 CLP por USD) → total ÷ tasa, igual que el trigger.
		const fixed = await run({ contract_currency: 'CLP', fx_policy: 'fixed_period' }, 950);

		expect(fixed.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE contracts'))![1]).toEqual(['c-1', 'h-1', 950, 'USD', true]);
	});

	it('misma moneda → tasa 1 sin buscar; sin moneda de sistema o sin tasa no escribe', async () => {
		const same = db((sql) => (sql.includes('FROM contracts c') ? [contract({ contract_currency: 'USD' })] : undefined));

		expect(await refreshContractSystemFx(same.runner, 'c-1', 'h-1')).toBe(true);
		expect(sqls(same.query).some((sql) => sql.includes('calculate_system_fx_rate'))).toBe(false);
		expect(same.query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE contracts'))![1]).toEqual(['c-1', 'h-1', 1, 'USD', false]);

		const noSystem = db((sql) => (sql.includes('FROM contracts c') ? [contract({ system_currency: null })] : undefined));

		expect(await refreshContractSystemFx(noSystem.runner, 'c-1', 'h-1')).toBe(false);
		const noRate = db((sql) => (sql.includes('FROM contracts c') ? [contract()] : undefined));

		expect(await refreshContractSystemFx(noRate.runner, 'c-1', 'h-1')).toBe(false);
		expect(sqls(noRate.query).some((sql) => sql.startsWith('UPDATE'))).toBe(false);
	});

	it('si el UPDATE falla (p. ej. el guard de período) vuelve al SAVEPOINT y no aborta la transacción', async () => {
		const { runner, query } = db((sql) => {
			if (sql.includes('FROM contracts c')) return [contract({ contract_currency: 'USD' })];
			if (sql.startsWith('UPDATE contracts')) throw new Error('PERIOD_LOCKED');

			return undefined;
		});

		expect(await refreshContractSystemFx(runner, 'c-1', 'h-1')).toBe(false);
		expect(sqls(query).at(-1)).toBe('ROLLBACK TO SAVEPOINT contract_system_fx');
	});

	it('contractFxNeedsRefresh: entra a Firmado/Activo, o ya está y cambia total, moneda o booking', () => {
		const row = (overrides: Row = {}) => ({
			status: 'Activo',
			total_value: '1000.00',
			contract_currency: 'USD',
			booking_date: '2026-09-01',
			...overrides,
		});

		expect(contractFxNeedsRefresh(row({ status: 'Borrador' }), row())).toBe(true);
		expect(contractFxNeedsRefresh(row(), row({ total_value: 1200 }))).toBe(true);
		expect(contractFxNeedsRefresh(row(), row({ booking_date: '2026-10-01' }))).toBe(true);
		expect(contractFxNeedsRefresh(row(), row({ total_value: 1000 }))).toBe(false);
		expect(contractFxNeedsRefresh(row(), row({ status: 'Cancelado', total_value: 5 }))).toBe(false);
		expect(contractFxNeedsRefresh(undefined, row())).toBe(false);
	});
});

describe('otros campos que ya no rellena un trigger', () => {
	it('syncContractTerm: contracts.term = MAX(term_months), NULL con un recurrente indefinido, solo si cambia (antes update_contract_term)', async () => {
		const { runner, query } = db();

		await syncContractTerm(runner, 'c-1', 'h-1');
		expect(query.mock.calls[0][0]).toContain('ELSE MAX(term_months) END AS term');
		// Un recurrente indefinido (sin término ni fin) deja el contrato sin plazo, como `contract_end_date`.
		expect(query.mock.calls[0][0]).toContain('WHEN bool_or(COALESCE(is_recurring, true) AND term_months IS NULL AND end_date IS NULL) THEN NULL');
		expect(query.mock.calls[0][0]).toContain('FROM contract_items WHERE contract_id = $1');
		expect(query.mock.calls[0][0]).toContain('c.term IS DISTINCT FROM x.term');
		expect(query.mock.calls[0][1]).toEqual(['c-1', 'h-1']);
	});

	it('itemCategoriaSql: NEW / REACTIVATION / UPSELL / CROSS-SELL por historial del cliente, sin borradores ni borrados (decisión 01-10, §9.1 #9)', () => {
		const sql = itemCategoriaSql(1, 3, 19);

		expect(sql).toContain('WHEN $3::uuid IS NULL THEN NULL');
		expect(sql).toContain("WHERE k.id = $1::uuid) THEN 'NEW'");
		expect(sql).toContain("pi.product_id = $3::uuid) THEN 'UPSELL'");
		expect(sql).toContain("ELSE 'CROSS-SELL' END");
		// Contratos anteriores = mismo cliente, creados antes, otro id, no borrados (borrado lógico v2) y activados (sin borradores).
		expect(sql).toContain('p.client_id = k.client_id AND p.id <> k.id AND p.created_at < k.created_at');
		expect(sql).toContain('p.deleted_at IS NULL');
		expect(sql).toContain("p.status IS DISTINCT FROM 'En revisión' AND p.status IS DISTINCT FROM 'Borrador'");
		// Todos los anteriores cancelados con el churn vigente al inicio del ítem → REACTIVATION.
		expect(sql).toContain("AND NOT (p.status = 'Cancelado' AND (p.churn_date IS NULL OR p.churn_date <= $19::date))) THEN 'REACTIVATION'");
	});

	describe('classifyClientItem (espejo TS de itemCategoriaSql)', () => {
		const contract = (status: string, churn: string | null, products: string[] = ['p-1']) => ({
			status,
			churn_date: churn,
			product_ids: products,
		});

		it('los borradores nunca cuentan como contratos anteriores: un cliente con solo borradores es NEW', () => {
			expect(classifyClientItem([contract('En revisión', null), contract('Borrador', null)], 'p-1', '2026-10-01')).toBe('NEW');
			expect(classifyClientItem([], 'p-1', '2026-10-01')).toBe('NEW');
			expect(classifyClientItem([contract('Activo', null)], null, '2026-10-01')).toBeNull();
		});

		it('todos los activados cancelados con el churn vigente → REACTIVATION (también rama c de reactivate)', () => {
			expect(classifyClientItem([contract('Cancelado', '2026-03-01'), contract('En revisión', null)], 'p-9', '2026-10-01')).toBe(
				'REACTIVATION'
			);
			// Churn todavía no vigente a la fecha: el cliente sigue activo → UPSELL / CROSS-SELL.
			expect(classifyClientItem([contract('Cancelado', '2026-12-01')], 'p-1', '2026-10-01')).toBe('UPSELL');
		});

		it('mixto: con al menos un contrato vigente se mantiene UPSELL / CROSS-SELL por producto', () => {
			const previous = [contract('Cancelado', '2026-03-01', ['p-1']), contract('Activo', null, ['p-2'])];

			expect(classifyClientItem(previous, 'p-1', '2026-10-01')).toBe('UPSELL');
			expect(classifyClientItem(previous, 'p-3', '2026-10-01')).toBe('CROSS-SELL');
		});
	});

	it('invoiceTermsSql: condiciones propias o las del contrato (antes invoices_fill_terms_from_contract)', () => {
		expect(invoiceTermsSql(4)).toBe('(SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $4::uuid)');
		expect(invoiceTermsSql(2, 28)).toBe('COALESCE($28::text, (SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $2::uuid))');
	});
});
