import { dsoOf, dsoSql, dsoTrendCuts, previousMonthEnd, systemAmountChecksSql, systemAmountDataChecks } from './billing-receivables';

describe('DSO (fórmula del reporte AR anterior)', () => {
	it('DSO = Por cobrar ÷ Facturado de los últimos 90 días × 90, redondeado; sin facturado = null', () => {
		// ARAgingReport: Math.round((totalAR / billed) * 90).
		expect(dsoOf(500, 1500)).toBe(30);
		expect(dsoOf(1000, 900)).toBe(100);
		expect(dsoOf(123.4, 1000)).toBe(11);
		expect(dsoOf(500, 0)).toBeNull();
		expect(dsoOf(0, 100)).toBe(0);
	});

	it('cortes de la tendencia: fin de cada mes anterior y el corte del mes en curso', () => {
		expect(previousMonthEnd('2026-03-15')).toBe('2026-02-28');
		expect(dsoTrendCuts('2026-10-02', 4)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-02']);
		expect(dsoTrendCuts('2026-01-10', 2)).toEqual(['2025-12-31', '2026-01-10']);
	});

	it('SQL: saldo al corte con pagos por fecha (moneda de la factura), Pagada sin pagos = 0, ventana de 90 días por emisión, sin CLF/UF', () => {
		const sql = dsoSql('WITH d AS (SELECT 1)', '$2', '$3').replace(/\s+/g, ' ');

		expect(sql).toContain('cuts AS (SELECT DISTINCT unnest($3::date[]) AS cut)');
		expect(sql).toContain('JOIN cuts c ON p.payment_date <= c.cut');
		expect(sql).toContain('UPPER(p.currency) = d.invoice_currency');
		expect(sql).toContain("CASE WHEN d.status = 'Pagada' AND d.paid_amount < d.total_due - 0.005 THEN 0");
		expect(sql).toContain('d.issue_date::date >= c.cut - 90 AND d.issue_date::date <= c.cut');
		expect(sql).toContain("d.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')");
		expect(sql).toContain("d.invoice_currency NOT IN ('CLF', 'UF')");
	});
});

describe('chequeo de datos: monto en sistema inconsistente', () => {
	it('SQL: mediana de la razón sistema/factura por moneda y mes, facturas con saldo a más de 10× (arriba o abajo)', () => {
		const sql = systemAmountChecksSql('WITH d AS (SELECT 1)', '$2', '$3').replace(/\s+/g, ' ');

		expect(sql).toContain(
			'percentile_cont(0.5) WITHIN GROUP (ORDER BY i.total_system_currency / COALESCE(i.total_invoice_currency, i.amount_invoice_currency))'
		);
		expect(sql).toContain(
			'd.total_system_currency / d.total_due > r.median_ratio * 10 OR d.total_system_currency / d.total_due < r.median_ratio / 10'
		);
		expect(sql).toContain('d.balance > 0.005');
	});

	it('data_checks: conteo, saldo en sistema y muestra de 20 (no corrige ni excluye)', () => {
		const rows = Array.from({ length: 25 }, (_, index) => ({
			id: `i${index}`,
			invoice_number: `F-${index}`,
			client_id: 'c1',
			client_name: 'Acme',
			company_name: 'Sapira',
			currency: 'CLP',
			issue_date: '2026-09-01',
			total_due: '1000',
			total_system_currency: '1000',
			balance_system: '10',
			ratio: '1',
			median_ratio: '0.001',
		}));
		const [check] = systemAmountDataChecks(rows);

		expect(check).toMatchObject({ code: 'system_amount_inconsistent', count: 25, balance_system: 250 });
		expect(check.invoices_sample).toHaveLength(20);
		expect(check.invoices_sample[0]).toMatchObject({ id: 'i0', total: 1000, total_system: 1000, ratio: 1, median_ratio: 0.001 });
		expect(systemAmountDataChecks([])).toEqual([]);
	});
});
