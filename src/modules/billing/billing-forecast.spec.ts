// `billing-read.service` importa el scheduler de facturas, que importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { calendarPeriods } from './billing-calendar';
import { buildForecast, buildForecastBudget, buildGoal } from './billing-forecast';
import { contractCurrencyTotals } from './billing-read.service';

import type { AgingRow } from './billing-states';

const AS_OF = '2026-10-02';
const row = (overrides: Partial<AgingRow>): AgingRow => ({
	client_id: 'c1',
	client_name: 'Acme',
	currency: 'CLP',
	due_date: '2026-10-15',
	balance: 1000,
	balance_system: 1,
	...overrides,
});

describe('proyección de cobros (por vencimiento)', () => {
	const periods = calendarPeriods(AS_OF, '2026-12-31', 'month');

	it('vencido por cobrar aparte, columnas del rango, posteriores y sin vencimiento; el total cuadra', () => {
		const result = buildForecast(
			[
				row({ due_date: '2026-09-01', balance_system: 5 }),
				row({ due_date: '2026-10-15', balance_system: 1 }),
				row({ client_id: 'c2', client_name: 'Beta', currency: 'USD', due_date: '2026-11-30', balance: 10, balance_system: 10 }),
				row({ due_date: '2027-03-01', balance_system: 2 }),
				row({ due_date: null, balance_system: 3 }),
				row({ due_date: '2026-10-20', balance_system: null }),
			],
			{ asOf: AS_OF, periods, granularity: 'month', behaviour: [{ client_id: 'c2', avg_days_to_pay: 35, avg_days_late: 5, paid_invoices: 4 }] }
		);

		expect(result.overdue).toMatchObject({ system: 5, invoices: 1 });
		expect(result.columns['2026-10']).toMatchObject({
			system: 1,
			invoices: 2,
			unconverted: 1,
			by_currency: [{ currency: 'CLP', amount: 2000, invoices: 2 }],
		});
		expect(result.columns['2026-11'].by_currency).toEqual([{ currency: 'USD', amount: 10, invoices: 1 }]);
		expect(result.later.system).toBe(2);
		expect(result.no_due_date.system).toBe(3);
		expect(result.total).toMatchObject({ system: 21, invoices: 6 });
		expect(result.clients.map((client) => `${client.name}:${client.total}`)).toEqual(['Acme:11', 'Beta:10']);
		expect(result.clients[1]).toMatchObject({ cells: { '2026-11': 10 }, avg_days_to_pay: 35, avg_days_late: 5, paid_invoices: 4 });
		expect(result.clients[0]).toMatchObject({ overdue: 5, later: 2, no_due_date: 3, avg_days_to_pay: null });
		// Por compañía emisora (con país): misma partición que el total.
		expect(result.companies).toEqual([
			expect.objectContaining({ company_id: null, name: 'Sin compañía', overdue: 5, later: 2, no_due_date: 3, total: 21, unconverted: 1 }),
		]);
	});

	it('las facturas CLF/UF no entran (datos por revisar) y los saldos 0 se ignoran', () => {
		const result = buildForecast([row({ currency: 'CLF', balance: 15 }), row({ currency: 'uf', balance: 2 }), row({ balance: 0 })], {
			asOf: AS_OF,
			periods,
			granularity: 'month',
		});

		expect(result.review_invoices).toBe(2);
		expect(result.total.invoices).toBe(0);
		expect(result.clients).toEqual([]);
	});

	it('semanal: la columna es el lunes de la semana del vencimiento', () => {
		const weeks = calendarPeriods(AS_OF, '2026-10-25', 'week');
		const result = buildForecast([row({ due_date: '2026-10-08' })], { asOf: AS_OF, periods: weeks, granularity: 'week' });

		expect(result.columns['2026-10-05'].system).toBe(1);
	});
});

describe('presupuesto de ingresos a caja (año)', () => {
	const monthlyBudget = (amount: number) =>
		Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`2026-${String(index + 1).padStart(2, '0')}`, amount]));
	const rows = [
		row({ due_date: '2026-09-01', balance_system: 100 }),
		row({ due_date: '2026-12-10', balance_system: 50 }),
		row({ due_date: '2027-01-10', balance_system: 70 }),
		row({ due_date: null, balance_system: 9 }),
	];

	it('proyectado = cobrado + saldo que vence en el año (lo vencido en el mes del corte); % sobre el presupuesto, por mes y a la fecha', () => {
		const result = buildGoal({
			year: 2026,
			currency: 'USD',
			budgetByMonth: { ...monthlyBudget(50), '2026-12': 450 },
			asOf: AS_OF,
			rows,
			collectedByMonth: { '2026-02': 300, '2026-09': 100 },
		});

		expect(result).toMatchObject({
			collected: 400,
			overdue: 100,
			open_due: 150,
			no_due_date: 9,
			projected: 550,
			pct_collected: 40,
			pct_projected: 55,
		});
		expect(result.months.find((month) => month.month === '2026-10')).toMatchObject({ expected: 100, budget: 50, pct: 200 });
		expect(result.months.find((month) => month.month === '2026-12')).toMatchObject({ expected: 50, budget: 450 });
		// A la fecha (ene–oct): presupuesto 500, cobrado 400 → 80 %.
		expect(result).toMatchObject({ goal: 1000, budget_ytd: 500, pct_ytd: 80 });
	});

	it('sin presupuesto: % nulos; año siguiente solo cuenta lo que vence en él; año pasado solo el cobrado', () => {
		expect(buildGoal({ year: 2026, currency: 'USD', budgetByMonth: null, asOf: AS_OF, rows, collectedByMonth: {} })).toMatchObject({
			goal: null,
			pct_collected: null,
			pct_projected: null,
			budget_ytd: null,
		});
		expect(buildGoal({ year: 2027, currency: 'USD', budgetByMonth: { '2027-01': 100 }, asOf: AS_OF, rows, collectedByMonth: {} })).toMatchObject({
			open_due: 70,
			overdue: 0,
			projected: 70,
		});
		expect(
			buildGoal({ year: 2025, currency: 'USD', budgetByMonth: { '2025-01': 100 }, asOf: AS_OF, rows, collectedByMonth: { '2025-05': 80 } })
		).toMatchObject({
			open_due: 0,
			projected: 80,
		});
	});
});

describe('proyección con presupuesto por período', () => {
	it('mensual: presupuesto del mes, cobrado hasta el corte y proyectado (el período del corte suma lo vencido); % = (cobrado + proyectado) ÷ presupuesto', () => {
		const periods = calendarPeriods(AS_OF, '2026-11-30', 'month');
		const forecast = buildForecast(
			[
				row({ due_date: '2026-09-01', balance_system: 40 }),
				row({ due_date: '2026-10-20', balance_system: 30 }),
				row({ due_date: '2026-11-05', balance_system: 90 }),
			],
			{
				asOf: AS_OF,
				periods,
				granularity: 'month',
			}
		);
		const result = buildForecastBudget({
			forecast,
			asOf: AS_OF,
			budgetByPeriod: { '2026-10': 100, '2026-11': null },
			collectedByDay: { '2026-10-01': 10, '2026-10-02': 20, '2026-10-05': 999 },
		});

		expect(result.periods['2026-10']).toEqual({ budget: 100, collected: 30, projected: 70, pct: 100 });
		expect(result.periods['2026-11']).toEqual({ budget: null, collected: 0, projected: 90, pct: null });
		expect(result.total).toEqual({ budget: 100, collected: 30, projected: 160, pct: 190 });
	});
});

describe('IVA y total en la moneda del contrato', () => {
	it('misma moneda: el IVA de la factura; otra: IVA ÷ tipo de cambio; spot sin tipo de cambio: null', () => {
		expect(contractCurrencyTotals({ amount_contract_currency: '1000', vat: '190', contract_currency: 'CLP', invoice_currency: 'CLP' })).toEqual({
			vat_contract_currency: 190,
			total_contract_currency: 1190,
		});
		expect(
			contractCurrencyTotals({
				amount_contract_currency: '10',
				vat: '76000',
				fx_contract_to_invoice: '40000',
				contract_currency: 'clf',
				invoice_currency: 'CLP',
			})
		).toEqual({
			vat_contract_currency: 1.9,
			total_contract_currency: 11.9,
		});
		expect(contractCurrencyTotals({ amount_contract_currency: '10', vat: null, contract_currency: 'CLF', invoice_currency: 'CLP' })).toEqual({
			vat_contract_currency: null,
			total_contract_currency: null,
		});
	});
});
