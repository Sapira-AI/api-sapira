import {
	balancesAt,
	contractJournalLines,
	forwardSchedule,
	indexByItem,
	JOURNAL_LINES,
	type JournalLineKind,
	type JournalMonth,
	journalMonths,
	type RevenueItemMonth,
	rollforward,
} from './revenue-balances';

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

	it('asientos: (a) facturación a diferido, (b) reconocimiento desde diferido, (c) no facturado; cuadran y concilian', () => {
		const [jan] = journalMonths([row('k', '2026-01', 80, 30, 80, 30, 'c-2')], ['2026-01']);

		expect(lineTotals(jan)).toEqual({ billing_deferred: 30, recognition_deferred: 30, recognition_unbilled: 50 });
		expect(jan.entries).toEqual([
			{ account: 'receivable', debit: 30, credit: 0 },
			{ account: 'deferred', debit: 30, credit: 30 },
			{ account: 'unbilled', debit: 50, credit: 0 },
			{ account: 'revenue', debit: 0, credit: 80 },
		]);
		expect(jan.balances.unbilled).toMatchObject({ opening: 0, movement: 50, closing: 50, reconciles: true });
		expect(jan.balanced).toBe(true);
		expect(jan.fx_difference).toBe(0);
	});

	it('(d) facturación de lo ya reconocido revierte por facturar; el exceso va a diferido', () => {
		// Por facturar inicial 50; el mes reconoce 100 y factura 150 → por facturar 0, diferido 0.
		expect(contractJournalLines({ netOpening: -50, netClosing: 0, billed: 150, recognized: 100 })).toEqual({
			billing_deferred: 100,
			recognition_deferred: 100,
			recognition_unbilled: 0,
			billing_unbilled: 50,
			fx_deferred: 0,
			fx_unbilled: 0,
		});
		// NC que baja el facturado de un contrato en por facturar: Dr por facturar / Cr cuentas por cobrar (d negativo).
		expect(contractJournalLines({ netOpening: 0, netClosing: -30, billed: -20, recognized: 10 })).toMatchObject({
			recognition_unbilled: 10,
			billing_unbilled: -20,
			billing_deferred: 0,
			recognition_deferred: 0,
		});
	});

	describe('asientos = roll-forward (fixture con prepago, vencido, cruce, NC y tipo de cambio)', () => {
		const attrs = (product: string, segment: string | null) => ({ product, segment, market: 'Chile', clientId: 'cl-1', clientName: 'ACME' });
		const fixture: RevenueItemMonth[] = [
			// c-1 prepago anual con dos productos (diferido).
			{ ...row('i1', '2026-01', 100, 1200, 100, 1200, 'c-1'), attrs: attrs('Plataforma', 'Enterprise') },
			{ ...row('i1', '2026-02', 100, 0, 200, 1200, 'c-1'), attrs: attrs('Plataforma', 'Enterprise') },
			{ ...row('i1', '2026-03', 100, 0, 300, 1200, 'c-1'), attrs: attrs('Plataforma', 'Enterprise') },
			{ ...row('i2', '2026-02', 20, 0, 20, 0, 'c-1'), attrs: attrs('Soporte', 'Enterprise') },
			{ ...row('i2', '2026-03', 20, 60, 40, 60, 'c-1'), attrs: attrs('Soporte', 'Enterprise') },
			// c-2 vencido: reconoce 100 al mes y factura 300 en marzo (por facturar → se revierte).
			{ ...row('j', '2026-01', 100, 0, 100, 0, 'c-2'), attrs: attrs('Plataforma', null) },
			{ ...row('j', '2026-02', 100, 0, 200, 0, 'c-2'), attrs: attrs('Plataforma', null) },
			{ ...row('j', '2026-03', 100, 300, 300, 300, 'c-2'), attrs: attrs('Plataforma', null) },
			// c-3 cruza de diferido a por facturar; en marzo una NC baja el facturado.
			{ ...row('k', '2026-01', 100, 150, 100, 150, 'c-3'), attrs: attrs('Soporte', 'Pyme') },
			{ ...row('k', '2026-02', 100, 0, 200, 150, 'c-3'), attrs: attrs('Soporte', 'Pyme') },
			{ ...row('k', '2026-03', 100, -50, 300, 100, 'c-3'), attrs: attrs('Soporte', 'Pyme') },
			// c-4 en otra moneda: los acumulados se convierten a la tasa del mes (R7) → diferencia de cambio en diferido.
			{ ...row('m', '2026-01', 100, 1000, 100, 1000, 'c-4'), attrs: attrs('Plataforma', 'Pyme') },
			{ ...row('m', '2026-02', 105, 0, 210, 1050, 'c-4'), attrs: attrs('Plataforma', 'Pyme') },
			{ ...row('m', '2026-03', 98, 0, 294, 980, 'c-4'), attrs: attrs('Plataforma', 'Pyme') },
			// c-5 solo por facturar y en otra moneda → el tipo de cambio va contra por facturar.
			{ ...row('n', '2026-02', 50, 0, 50, 0, 'c-5'), attrs: attrs('Soporte', 'Pyme') },
			{ ...row('n', '2026-03', 50, 0, 104, 0, 'c-5'), attrs: attrs('Soporte', 'Pyme') },
		];
		const months = ['2026-01', '2026-02', '2026-03'];

		it.each(months)('%s: facturado, reconocido, movimientos y tipo de cambio = roll-forward; cada cuenta concilia', (month) => {
			const [journal] = journalMonths(fixture, [month]);
			const bridge = rollforward(fixture, [month]);
			const lines = lineTotals(journal);
			const amount = (kind: JournalLineKind) => lines[kind] ?? 0;

			expect(journal.balanced).toBe(true);
			expect(round(amount('billing_deferred') + amount('billing_unbilled'))).toBeCloseTo(bridge.deferred.billed, 2);
			expect(round(amount('recognition_deferred') + amount('recognition_unbilled'))).toBeCloseTo(bridge.deferred.recognized, 2);
			expect(round(amount('fx_deferred') + amount('fx_unbilled'))).toBeCloseTo(bridge.deferred.fx, 2);
			expect(journal.fx_difference).toBeCloseTo(bridge.deferred.fx, 2);
			expect(journal.balances.deferred).toMatchObject({ opening: bridge.deferred.opening, closing: bridge.deferred.closing, reconciles: true });
			expect(journal.balances.deferred.movement).toBeCloseTo(bridge.deferred.closing - bridge.deferred.opening, 2);
			expect(journal.balances.unbilled).toMatchObject({ opening: bridge.unbilled.opening, closing: bridge.unbilled.closing, reconciles: true });
			expect(journal.balances.unbilled.movement).toBeCloseTo(bridge.unbilled.change, 2);
		});

		it('el rango completo suma lo mismo que el roll-forward del rango', () => {
			const journal = journalMonths(fixture, months);
			const bridge = rollforward(fixture, months);
			const total = (kinds: JournalLineKind[]) =>
				round(journal.reduce((sum, month) => sum + kinds.reduce((s, kind) => s + (lineTotals(month)[kind] ?? 0), 0), 0));

			expect(total(['billing_deferred', 'billing_unbilled'])).toBeCloseTo(bridge.deferred.billed, 2);
			expect(total(['recognition_deferred', 'recognition_unbilled'])).toBeCloseTo(bridge.deferred.recognized, 2);
			expect(total(['fx_deferred', 'fx_unbilled'])).toBeCloseTo(bridge.deferred.fx, 2);
			expect(round(journal.reduce((sum, month) => sum + month.balances.unbilled.movement, 0))).toBeCloseTo(bridge.unbilled.change, 2);
		});

		it('c-5 sin diferido: su tipo de cambio va contra por facturar', () => {
			const [march] = journalMonths(
				fixture.filter((r) => r.contractId === 'c-5'),
				['2026-03']
			);

			expect(lineTotals(march)).toMatchObject({ recognition_unbilled: 50, fx_unbilled: -4 });
			expect(march.balances.unbilled).toMatchObject({ opening: 50, movement: 54, closing: 104, reconciles: true });
		});

		it.each(['product', 'segment', 'contract', 'client', 'market', 'industry'] as const)(
			'abierto por %s: cada valor cuadra y la suma de las líneas no cambia',
			(groupBy) => {
				for (const month of months) {
					const [plain] = journalMonths(fixture, [month]);
					const [grouped] = journalMonths(fixture, [month], groupBy);

					expect(grouped.groups.length).toBeGreaterThan(0);
					expect(grouped.groups.every((group) => group.balanced)).toBe(true);
					// Las líneas de distintos valores no se netean entre sí: el subtotal suma el debe bruto del mes abierto.
					expect(round(grouped.groups.reduce((sum, group) => sum + group.debit, 0))).toBeCloseTo(
						grouped.entries.reduce((sum, entry) => sum + entry.debit, 0),
						2
					);
					for (const [kind, value] of Object.entries(lineTotals(plain)))
						expect(lineTotals(grouped)[kind as JournalLineKind] ?? 0).toBeCloseTo(value, 1);
					for (const account of ['deferred', 'unbilled'] as const) {
						expect(grouped.balances[account]).toMatchObject({
							opening: plain.balances[account].opening,
							closing: plain.balances[account].closing,
							reconciles: true,
						});
						expect(grouped.balances[account].movement).toBeCloseTo(plain.balances[account].movement, 1);
					}
				}
			}
		);

		it('filas sin valor de la dimensión van a "Sin asignar", al final', () => {
			const [march] = journalMonths(fixture, ['2026-03'], 'segment');

			expect(march.groups.map((group) => group.label)).toEqual(['Enterprise', 'Pyme', 'Sin asignar']);
			expect(march.postings.some((posting) => posting.group?.label === 'Sin asignar')).toBe(true);
		});

		it('por producto, la facturación de un contrato se prorratea por el facturado de cada ítem', () => {
			const [march] = journalMonths(
				fixture.filter((r) => r.contractId === 'c-1'),
				['2026-03'],
				'product'
			);
			const support = march.postings.filter((posting) => posting.group?.label === 'Soporte' && posting.account === 'receivable');

			expect(support.reduce((sum, posting) => sum + posting.debit, 0)).toBe(60);
		});
	});
});

/** Monto con signo por tipo de línea: debe − haber de la pierna de su cuenta deudora. */
function lineTotals(month: JournalMonth): Partial<Record<JournalLineKind, number>> {
	const out: Partial<Record<JournalLineKind, number>> = {};

	for (const posting of month.postings) {
		if (posting.account !== JOURNAL_LINES[posting.line].debit) continue;
		out[posting.line] = round((out[posting.line] ?? 0) + posting.debit - posting.credit);
	}

	return out;
}

function round(value: number) {
	return Math.round(value * 100) / 100;
}
