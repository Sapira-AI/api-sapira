import {
	alignToPeriods,
	type BudgetLineView,
	budgetMonthlyByDimension,
	budgetMonthlyTotals,
	budgetPeriodStarts,
	normalizeLine,
	splitEven,
	splitWeighted,
	validateBudgetLines,
} from './budgets-rules';

const COMPANY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const line = (overrides: Partial<BudgetLineView>): BudgetLineView => ({
	period_start: '2026-01-01',
	dimension_type: 'total',
	dimension_id: null,
	dimension_key: null,
	amount: 100,
	...overrides,
});

describe('presupuestos: períodos y repartos', () => {
	it('períodos del año según granularidad', () => {
		expect(budgetPeriodStarts('month', 2026)).toHaveLength(12);
		expect(budgetPeriodStarts('quarter', 2026)).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
		expect(budgetPeriodStarts('year', 2026)).toEqual(['2026-01-01']);
	});

	it('splitEven y splitWeighted: 2 decimales y el residuo en la última parte (la suma cuadra)', () => {
		expect(splitEven(1000, 12).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1000, 6);
		expect(splitEven(1000, 12)[11]).toBe(83.37);
		expect(splitWeighted(100, [900, 300])).toEqual([75, 25]);
		expect(splitWeighted(10, [1, 1, 1])).toEqual([3.33, 3.33, 3.34]);
		expect(splitWeighted(9, [0, 0])).toEqual([4.5, 4.5]);
	});

	it('normalizeLine: dimensión por defecto total, clave sin espacios y id en minúsculas', () => {
		expect(normalizeLine({ period_start: '2026-01-01', amount: 5 })).toEqual(line({ amount: 5 }));
		expect(
			normalizeLine({ period_start: '2026-01-01', dimension_type: 'segment', dimension_key: '  Enterprise ', amount: 1 }).dimension_key
		).toBe('Enterprise');
		expect(
			normalizeLine({ period_start: '2026-01-01', dimension_type: 'company', dimension_id: COMPANY_A.toUpperCase(), amount: 1 }).dimension_id
		).toBe(COMPANY_A);
	});
});

describe('presupuestos: validación de líneas', () => {
	const validate = (lines: BudgetLineView[], granularity: 'month' | 'quarter' | 'year' = 'month') =>
		validateBudgetLines({ granularity, fiscalYear: 2026, lines });

	it('acepta un anual con reparto por compañía que suma el total', () => {
		expect(
			validate(
				[
					line({ amount: 1000 }),
					line({ dimension_type: 'company', dimension_id: COMPANY_A, amount: 600 }),
					line({ dimension_type: 'company', dimension_id: COMPANY_B, amount: 400 }),
				],
				'year'
			)
		).toEqual([]);
	});

	it('montos ≥ 0 con 2 decimales y períodos alineados a la granularidad y al año', () => {
		expect(validate([line({ amount: -1 })])[0]).toMatchObject({ field: 'lines[0].amount' });
		expect(validate([line({ amount: 1.234 })])[0].message).toContain('2 decimales');
		expect(validate([line({ period_start: '2026-02-15' })])[0]).toMatchObject({ field: 'lines[0].period_start' });
		expect(validate([line({ period_start: '2027-01-01' })])[0].message).toContain('2026');
		expect(validate([line({ period_start: '2026-02-01' })], 'quarter')[0].message).toContain('trimestre');
		expect(validate([line({ period_start: '2026-04-01' })], 'year')[0].message).toContain('2026-01-01');
	});

	it('reglas de dimensión: total sin entidad, id para compañía/vendedor/producto/cliente, clave para segmento/mercado; celdas únicas', () => {
		expect(validate([line({ dimension_id: COMPANY_A })])[0].message).toContain('total');
		expect(validate([line({ dimension_type: 'company' })])[0]).toMatchObject({ field: 'lines[0].dimension_id' });
		expect(validate([line({ dimension_type: 'seller', dimension_id: 'x' })])[0]).toMatchObject({ field: 'lines[0].dimension_id' });
		expect(validate([line({ dimension_type: 'segment' })])[0]).toMatchObject({ field: 'lines[0].dimension_key' });
		expect(validate([line({ dimension_type: 'market', dimension_key: 'Chile', dimension_id: COMPANY_A })])[0]).toMatchObject({
			field: 'lines[0].dimension_id',
		});
		expect(validate([line({}), line({})])[0].message).toContain('repetida');
	});

	it('con total, cada dimensión suma el total del período; sin total, una sola dimensión', () => {
		expect(validate([line({ amount: 100 }), line({ dimension_type: 'company', dimension_id: COMPANY_A, amount: 90 })])[0].message).toContain(
			'suma 90'
		);
		expect(validate([line({ dimension_type: 'company', dimension_id: COMPANY_A, period_start: '2026-02-01' }), line({})])[0].message).toContain(
			'no tiene línea total'
		);
		expect(
			validate([line({ dimension_type: 'company', dimension_id: COMPANY_A }), line({ dimension_type: 'segment', dimension_key: 'Pyme' })])[0]
				.message
		).toContain('una sola dimensión');
		expect(
			validate([line({ dimension_type: 'seller', dimension_id: COMPANY_A }), line({ dimension_type: 'seller', dimension_id: COMPANY_B })])
		).toEqual([]);
	});
});

describe('presupuestos: total por mes y alineación con los períodos del reporte', () => {
	it('anual ÷ 12 (residuo al último mes), trimestre ÷ 3, mensual tal cual; meses sin línea = 0 dentro del año', () => {
		const annual = budgetMonthlyTotals([line({ amount: 1200 })], 'year', 2026);

		expect(Object.keys(annual)).toHaveLength(12);
		expect(annual['2026-01']).toBe(100);
		expect(budgetMonthlyTotals([line({ period_start: '2026-04-01', amount: 300 })], 'quarter', 2026)).toMatchObject({
			'2026-04': 100,
			'2026-06': 100,
			'2026-01': 0,
		});
		expect(budgetMonthlyTotals([line({ period_start: '2026-03-01', amount: 7 })], 'month', 2026)).toMatchObject({ '2026-03': 7, '2026-04': 0 });
		// Sin líneas total: la suma de la única dimensión.
		expect(
			budgetMonthlyTotals(
				[
					line({ dimension_type: 'seller', dimension_id: COMPANY_A, amount: 60 }),
					line({ dimension_type: 'seller', dimension_id: COMPANY_B, amount: 40 }),
				],
				'month',
				2026
			)['2026-01']
		).toBe(100);
	});

	it('por compañía: monto por mes de cada entidad', () => {
		const byCompany = budgetMonthlyByDimension(
			[line({ amount: 1200 }), line({ dimension_type: 'company', dimension_id: COMPANY_A, amount: 1200 })],
			'year',
			'company',
			2026
		);

		expect(byCompany.get(COMPANY_A)?.['2026-05']).toBe(100);
	});

	it('mes = el del mes; semana y día prorrateados por días; sin presupuesto = null', () => {
		const monthly = { '2026-09': 300, '2026-10': 310 };

		expect(
			alignToPeriods(monthly, [
				{ key: '2026-10', start: '2026-10-01', end: '2026-10-31' },
				{ key: '2026-12', start: '2026-12-01', end: '2026-12-31' },
			])
		).toEqual({ '2026-10': 310, '2026-12': null });
		// Semana 28-sep → 4-oct: 3 días de septiembre (300/30) + 4 de octubre (310/31).
		expect(alignToPeriods(monthly, [{ key: '2026-09-28', start: '2026-09-28', end: '2026-10-04' }])).toEqual({ '2026-09-28': 70 });
		expect(alignToPeriods(monthly, [{ key: '2026-10-02', start: '2026-10-02', end: '2026-10-02' }])).toEqual({ '2026-10-02': 10 });
	});
});
