import { categoryOf } from './metrics-categories';
import { addMonths, monthRange, resolveRange } from './metrics-period';
import {
	buildCohorts,
	buildWaterfall,
	classifyMonth,
	clientActivity,
	type LineMonth,
	logoStats,
	type MrrLine,
	periodIndicators,
	retentionOf,
	splitUnconverted,
	yoyRetention,
} from './mrr-movements';

type Cells = Record<string, number | null | Partial<LineMonth>>;

function line(key: string, cells: Cells, extra: Partial<MrrLine> = {}): MrrLine {
	const months = new Map<string, LineMonth>();

	for (const [month, cell] of Object.entries(cells)) {
		if (typeof cell === 'object' && cell !== null) months.set(month, { value: 0, valueContract: null, pending: 0, momentum: null, ...cell });
		else months.set(month, { value: cell as number | null, valueContract: cell as number | null, pending: 0, momentum: null });
	}

	return {
		key,
		source: 'contract',
		contractId: 'c-1',
		contractNumber: 'CTR-1',
		itemId: key,
		clientId: 'cl-1',
		clientName: 'Cliente',
		companyId: 'co-1',
		companyName: 'Compañía',
		product: 'Producto',
		categoria: 'NEW',
		renewsItemId: null,
		renewedByItemId: null,
		legacyContractId: null,
		segment: 'SMB',
		market: 'Nacional',
		industry: null,
		country: null,
		itemType: null,
		unitOfMeasure: null,
		months,
		...extra,
	};
}

const keys = (movements: ReturnType<typeof classifyMonth>) => movements.map((m) => [m.category, m.key, m.amount]);

describe('metrics-period', () => {
	it('suma meses sin pasar por Date y valida el rango', () => {
		expect(addMonths('2026-01', -1)).toBe('2025-12');
		expect(addMonths('2025-11', 3)).toBe('2026-02');
		expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
		expect(resolveRange('2026-01', '2026-03').months).toHaveLength(3);
		expect(resolveRange(undefined, '2026-12').from).toBe('2026-01');
		expect(() => resolveRange('2026-05', '2026-01')).toThrow();
		expect(() => resolveRange('2023-01', '2026-01')).toThrow();
	});
});

describe('categoryOf', () => {
	it('mapea subcategorías abiertas: fijas, por signo y desconocidas a Otros', () => {
		expect(categoryOf('NEW', 10)).toBe('new');
		expect(categoryOf('CROSS-SELL', 10)).toBe('expansion');
		expect(categoryOf('EXPIRED', -10)).toBe('churn');
		expect(categoryOf('RENEWAL', 5)).toBe('expansion');
		expect(categoryOf('RENEWAL', -5)).toBe('contraction');
		expect(categoryOf('PAUSE', -5)).toBe('churn');
		expect(categoryOf('ALGO_NUEVO', 5)).toBe('other');
	});
});

describe('classifyMonth', () => {
	it('alta NEW, upsell con su momentum y downsell espejo negativo', () => {
		const lines = [
			line('a', { '2026-02': { value: 100, momentum: 'NEW' } }),
			line('b', { '2026-02': { value: 30, momentum: 'UPSELL' } }, { categoria: 'UPSELL' }),
			line('c', { '2026-02': { value: -20, momentum: 'DOWNSELL' } }, { categoria: 'DOWNSELL' }),
		];

		expect(keys(classifyMonth(lines, '2026-02', { currency: 'system' }))).toEqual([
			['new', 'NEW', 100],
			['expansion', 'UPSELL', 30],
			['contraction', 'DOWNSELL', -20],
		]);
	});

	it('vencido sin renovar = churn EXPIRED (D1); cola de churn explícita = CHURN', () => {
		const lines = [line('a', { '2026-01': 100, '2026-02': 0 }), line('b', { '2026-01': 50, '2026-02': { value: 0, momentum: 'CHURN' } })];

		expect(keys(classifyMonth(lines, '2026-02', { currency: 'system' }))).toEqual([
			['churn', 'EXPIRED', -100],
			['churn', 'CHURN', -50],
		]);
	});

	it('renovación a igual precio no es movimiento; con alza es expansión (D8)', () => {
		const same = [
			line('old', { '2026-01': 100 }, { renewedByItemId: 'new' }),
			line('new', { '2026-02': { value: 100, momentum: 'RENEWAL' } }, { categoria: 'RENEWAL', renewsItemId: 'old' }),
		];
		const up = [
			line('old', { '2026-01': 100 }, { renewedByItemId: 'new' }),
			line('new', { '2026-02': { value: 120, momentum: 'RENEWAL' } }, { categoria: 'RENEWAL', renewsItemId: 'old' }),
		];

		expect(classifyMonth(same, '2026-02', { currency: 'system' })).toEqual([]);
		expect(keys(classifyMonth(up, '2026-02', { currency: 'system' }))).toEqual([['expansion', 'RENEWAL', 20]]);
	});

	it('ítem vivo que cambia en moneda de sistema = tipo de cambio; en moneda de contrato no es FX', () => {
		const lines = [line('a', { '2026-01': 100, '2026-02': 104 })];

		expect(keys(classifyMonth(lines, '2026-02', { currency: 'system' }))).toEqual([['fx', 'FX', 4]]);
		expect(keys(classifyMonth(lines, '2026-02', { currency: 'contract' }))).toEqual([['other', 'OTHER', 4]]);
	});

	it('legacy → su contrato no es movimiento; la diferencia real en moneda de contrato sí, y el resto es FX (D2)', () => {
		const legacy = line(
			'l',
			{ '2026-01': { value: 100, valueContract: 1000 } },
			{ source: 'legacy', itemId: null, legacyContractId: 'c-9', contractId: 'c-9' }
		);
		const same = line('i', { '2026-02': { value: 98, valueContract: 1000, momentum: null } }, { contractId: 'c-9', categoria: 'RENEWAL' });
		const higher = line('i', { '2026-02': { value: 110, valueContract: 1100, momentum: null } }, { contractId: 'c-9', categoria: 'RENEWAL' });

		expect(keys(classifyMonth([legacy, same], '2026-02', { currency: 'system' }))).toEqual([['fx', 'FX', -2]]);
		expect(keys(classifyMonth([legacy, higher], '2026-02', { currency: 'system' }))).toEqual([['expansion', 'LEGACY_MIGRATION', 10]]);
	});

	it('legacy que termina sin contrato: contracción si el cliente sigue con MRR, churn si queda en 0', () => {
		const ended = line('l', { '2026-01': 40, '2026-02': 0 }, { source: 'legacy', itemId: null });
		const other = line('a', { '2026-01': 60, '2026-02': 60 });

		expect(keys(classifyMonth([ended, other], '2026-02', { currency: 'system' }))).toEqual([['contraction', 'LEGACY_END', -40]]);
		expect(keys(classifyMonth([ended], '2026-02', { currency: 'system' }))).toEqual([['churn', 'LEGACY_END', -40]]);
	});

	it('momentum desconocido (PAUSE futuro u otro) entra como dato abierto', () => {
		const lines = [line('a', { '2026-02': { value: 10, momentum: 'ALGO_NUEVO' } })];

		expect(keys(classifyMonth(lines, '2026-02', { currency: 'system' }))).toEqual([['other', 'ALGO_NUEVO', 10]]);
	});
});

describe('buildWaterfall', () => {
	it('inicio = cierre del mes anterior (nunca 0) y cierre = inicio + movimientos', () => {
		const lines = [
			line('a', { '2025-12': 100, '2026-01': 100, '2026-02': 0 }),
			line('b', { '2026-01': { value: 50, momentum: 'NEW' }, '2026-02': 52 }),
			line('c', { '2026-02': { value: 30, momentum: 'CROSS-SELL' } }, { categoria: 'CROSS-SELL' }),
		];
		const { months } = buildWaterfall(lines, ['2026-01', '2026-02'], { currency: 'system' });

		expect(months[0]).toMatchObject({ opening: 100, closing: 150, check: 0 });
		expect(months[1]).toMatchObject({ opening: 150, closing: 82, check: 0 });
		expect(months[1].movements.map((m) => [m.category, m.key, m.amount])).toEqual([
			['expansion', 'CROSS-SELL', 30],
			['churn', 'EXPIRED', -100],
			['fx', 'FX', 2],
		]);
	});

	it('indicadores del período: NRR/GRR, churn bruto y neto, quick ratio N/A sin pérdidas', () => {
		const lines = [
			line('a', { '2026-01': 100, '2026-02': 100 }),
			line('b', { '2026-02': { value: 10, momentum: 'UPSELL' } }, { categoria: 'UPSELL' }),
		];
		const { months } = buildWaterfall(lines, ['2026-02'], { currency: 'system' });
		const indicators = periodIndicators(retentionOf(months));

		expect(indicators.nrr).toBeCloseTo(1.1);
		expect(indicators.grr).toBeCloseTo(1);
		expect(indicators.gross_mrr_churn).toBe(0);
		expect(indicators.quick_ratio).toBeNull();
	});
});

describe('splitUnconverted', () => {
	it('una línea con un mes sin convertir sale completa de los totales', () => {
		const lines = [line('a', { '2026-01': 100, '2026-02': null }), line('b', { '2026-01': 10 })];
		const { converted, unconverted } = splitUnconverted(lines, ['2026-01', '2026-02']);

		expect(converted.map((l) => l.key)).toEqual(['b']);
		expect(unconverted.map((l) => l.key)).toEqual(['a']);
	});
});

describe('clientes, retención interanual y cohortes', () => {
	const lines = [
		line('a', { '2025-01': 100, '2026-01': 120 }, { clientId: 'x' }),
		line('b', { '2025-01': 50, '2026-01': 0 }, { clientId: 'y' }),
		line('c', { '2026-01': 70 }, { clientId: 'z' }),
	];

	it('NRR y GRR interanuales sobre los clientes de hace 12 meses (D6)', () => {
		const yoy = yoyRetention(lines, '2026-01');

		expect(yoy.nrr).toBeCloseTo(120 / 150);
		expect(yoy.grr).toBeCloseTo(100 / 150);
	});

	it('clientes activos = MRR > 0 y churn de logos', () => {
		const series = [line('a', { '2026-01': 10, '2026-02': 10 }, { clientId: 'x' }), line('b', { '2026-01': 5, '2026-02': 0 }, { clientId: 'y' })];

		expect(logoStats(series, '2026-02')).toMatchObject({ active: 1, activePrev: 2, lost: 1, logoChurn: 0.5 });
	});

	it('nuevo = primer MRR de su historia; reactivado = vuelve después de quedar en 0', () => {
		const history = monthRange('2025-12', '2026-03');
		const series = [
			line('a', { '2025-12': 10, '2026-01': 0, '2026-02': 10, '2026-03': 10 }, { clientId: 'x' }),
			line('b', { '2026-03': 5 }, { clientId: 'y' }),
		];
		const activity = clientActivity(series, history, ['2026-01', '2026-02', '2026-03']);

		expect(activity.map((m) => [m.period, m.active, m.new, m.reactivated, m.churned])).toEqual([
			['2026-01', 0, 0, 0, 1],
			['2026-02', 1, 0, 1, 0],
			['2026-03', 2, 1, 0, 0],
		]);
	});

	it('cohortes por ingresos pueden pasar de 100 %', () => {
		const series = [line('a', { '2026-01': 100, '2026-02': 150 }, { clientId: 'x' })];
		const [cohort] = buildCohorts(series, ['2026-01', '2026-02'], 'revenue', 'month');

		expect(cohort).toMatchObject({ cohort: '2026-01', size: 1, initial_mrr: 100, values: [1, 1.5] });
	});
});
