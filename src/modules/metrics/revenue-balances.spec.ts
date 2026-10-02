import { balancesAt, forwardSchedule, indexByItem, journalMonths, type RevenueItemMonth, rollforward } from './revenue-balances';

const row = (
	itemId: string,
	period: string,
	recognized: number,
	billed: number,
	recognizedCum: number,
	billedCum: number,
	contractId = 'c-1'
): RevenueItemMonth => ({
	contractId,
	itemId,
	companyId: 'co-1',
	period,
	recognized,
	billed,
	recognizedCum,
	billedCum,
});

describe('revenue-balances', () => {
	// Contrato anual 1.200 facturado por adelantado en enero; reconoce 100 al mes.
	const annual = [row('i', '2026-01', 100, 1200, 100, 1200), row('i', '2026-02', 100, 0, 200, 1200), row('i', '2026-03', 100, 0, 300, 1200)];

	it('diferido y por facturar netean por contrato, no por fila', () => {
		const rows = [...annual, row('j', '2026-01', 50, 0, 50, 0)];

		// Contrato c-1: facturado 1.200 − reconocido 150 = 1.050 diferido; el ítem j (por facturar 50) netea dentro del contrato.
		expect(balancesAt(indexByItem(rows), '2026-01')).toEqual({ deferred: 1050, unbilled: 0 });
		expect(balancesAt(indexByItem([row('k', '2026-01', 80, 0, 80, 0, 'c-2')]), '2026-01')).toEqual({ deferred: 0, unbilled: 80 });
	});

	it('después del último mes de un ítem, el saldo queda donde quedó', () => {
		expect(balancesAt(indexByItem(annual), '2026-09')).toEqual({ deferred: 900, unbilled: 0 });
	});

	it('roll-forward cuadra: inicial + facturado − reconocido + Δ por facturar + FX = final', () => {
		const result = rollforward(annual, ['2026-02', '2026-03']);

		expect(result.deferred).toEqual({ opening: 1100, billed: 0, recognized: 200, unbilled_change: 0, fx: 0, closing: 900 });
		expect(result.check).toBe(0);
	});

	it('reconocimiento futuro consume el diferido del contrato y el resto es backlog por facturar', () => {
		const future = [row('i', '2026-04', 100, 0, 0, 0), row('i', '2026-05', 100, 0, 0, 0)];
		const result = forwardSchedule(annual.slice(0, 1), future, '2026-01');

		expect(result.months).toEqual([
			{ period: '2026-04', from_deferred: 100, unbilled_backlog: 0 },
			{ period: '2026-05', from_deferred: 100, unbilled_backlog: 0 },
		]);
		expect(result.total).toBe(200);
	});

	it('asientos: Cr ingresos = reconocido; Dr diferido lo cubierto y Dr por facturar el resto; cuadran', () => {
		const [jan] = journalMonths([row('k', '2026-01', 80, 30, 80, 30, 'c-2')], ['2026-01']);

		expect(jan.entries).toEqual([
			{ account: 'deferred', debit: 30, credit: 0 },
			{ account: 'unbilled', debit: 50, credit: 0 },
			{ account: 'revenue', debit: 0, credit: 80 },
		]);
		expect(jan.balanced).toBe(true);
		expect(jan.fx_difference).toBe(0);
	});
});
