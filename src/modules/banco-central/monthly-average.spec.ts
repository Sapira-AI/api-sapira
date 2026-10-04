import {
	isMonthlyAverageClosed,
	isWeekday,
	monthEndInstant,
	MONTHLY_AVG_BY_PAIR_SQL,
	MONTHLY_AVG_DAILY_RATES_SQL,
	MONTHLY_AVG_DAILY_SOURCES,
	monthlyAverage,
	monthlyAverageRange,
	monthlyAvgSourcePriority,
} from './monthly-average';

const squash = (sql: string) => sql.replace(/\s+/g, ' ');

describe('promedio mensual de tipos de cambio (regla corregida 04-10)', () => {
	it('todas las fuentes diarias (Banco Central de los dos sistemas y Perú API), no las cargas manuales', () => {
		expect([...MONTHLY_AVG_DAILY_SOURCES]).toEqual(['PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE']);
		const sql = squash(MONTHLY_AVG_DAILY_RATES_SQL);

		expect(sql).toContain(`er.source_type IN ('PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE')`);
		expect(sql).not.toContain(`'system'`);
		// Una tasa por par y día; solo lunes a viernes; tasas positivas.
		expect(sql).toContain('SELECT DISTINCT ON (er.from_currency, er.to_currency, er.rate_date)');
		expect(sql).toContain('EXTRACT(ISODOW FROM er.rate_date) < 6');
		expect(sql).toContain('er.rate > 0');
		expect(sql).toMatch(/ORDER BY er\.from_currency, er\.to_currency, er\.rate_date, \(CASE .* END\), er\.created_at DESC$/);
		expect(squash(MONTHLY_AVG_BY_PAIR_SQL)).toContain('AVG(rate) AS avg_rate');
		expect(squash(MONTHLY_AVG_BY_PAIR_SQL)).toContain('COUNT(*)::int AS data_points');
	});

	it('prioridad: Perú API primero solo en USD/PEN; Banco Central antes que el sistema anterior; lo demás al final', () => {
		expect(monthlyAvgSourcePriority('PERU_API', 'USD', 'PEN')).toBeLessThan(monthlyAvgSourcePriority('BANCOCENTRAL', 'USD', 'PEN'));
		expect(monthlyAvgSourcePriority('BANCOCENTRAL', 'USD', 'CLP')).toBeLessThan(monthlyAvgSourcePriority('BANCOCENTRALCHILE', 'USD', 'CLP'));
		expect(monthlyAvgSourcePriority('PERU_API', 'USD', 'CLP')).toBeGreaterThan(monthlyAvgSourcePriority('BANCOCENTRALCHILE', 'USD', 'CLP'));
		expect(monthlyAvgSourcePriority('system', 'USD', 'CLP')).toBe(9);
	});

	it('una tasa por día (sin promediar duplicados), sin fines de semana ni cargas manuales; mezcla de fuentes en el mes', () => {
		// Julio 2026 USD/PEN: Banco Central hasta el 15, Perú API desde el 17 → entran las dos (antes solo Perú API: 15 de 23 días).
		const average = monthlyAverage('USD', 'PEN', [
			{ rate_date: '2026-07-14', rate: 3.5, source_type: 'BANCOCENTRAL' },
			{ rate_date: '2026-07-15', rate: 3.6, source_type: 'BANCOCENTRAL' },
			// Mismo día en dos fuentes: gana Perú API (USD/PEN), no se promedian.
			{ rate_date: '2026-07-17', rate: 3.7, source_type: 'BANCOCENTRAL' },
			{ rate_date: '2026-07-17', rate: 3.8, source_type: 'PERU_API' },
			// Sábado y domingo (viernes repetido): no entran.
			{ rate_date: '2026-07-18', rate: 3.8, source_type: 'PERU_API' },
			{ rate_date: '2026-07-19', rate: 3.8, source_type: 'PERU_API' },
			// Carga manual: no es fuente diaria.
			{ rate_date: '2026-07-20', rate: 99, source_type: 'system' },
			{ rate_date: '2026-07-21', rate: 0, source_type: 'PERU_API' },
		]);

		expect(average).toEqual({ avg_rate: (3.5 + 3.6 + 3.8) / 3, min_rate: 3.5, max_rate: 3.8, data_points: 3 });
		// A igual fuente, la más reciente.
		expect(
			monthlyAverage('USD', 'CLP', [
				{ rate_date: '2026-09-01', rate: 900, source_type: 'BANCOCENTRAL', created_at: '2026-09-01T10:00:00Z' },
				{ rate_date: '2026-09-01', rate: 910, source_type: 'BANCOCENTRAL', created_at: '2026-09-02T10:00:00Z' },
			])
		).toMatchObject({ avg_rate: 910, data_points: 1 });
		expect(monthlyAverage('ARS', 'USD', [{ rate_date: '2026-01-02', rate: 1452.25, source_type: 'system' }])).toBeNull();
		expect([isWeekday('2026-10-02'), isWeekday('2026-10-03'), isWeekday('2026-10-04')]).toEqual([true, false, false]);
	});

	it('UF (CLF/CLP) con la misma regla de días hábiles: los fines de semana no repiten el viernes', () => {
		const rates = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map((rate_date, index) => ({
			rate_date,
			rate: 39000 + index,
			source_type: 'BANCOCENTRAL',
		}));

		expect(monthlyAverage('CLF', 'CLP', rates)).toMatchObject({ avg_rate: (39000 + 39003) / 2, data_points: 2 });
	});

	it('cerrado = calculado después de terminado el mes (America/Santiago) y con más de una tasa', () => {
		// 01-10-2026 00:00 en Santiago (UTC−3) = 03:00 UTC.
		expect(monthEndInstant(2026, 9).toISOString()).toBe('2026-10-01T03:00:00.000Z');
		expect(monthEndInstant(2026, 12).toISOString()).toBe('2027-01-01T03:00:00.000Z');
		// Junio: Santiago en UTC−4.
		expect(monthEndInstant(2026, 6).toISOString()).toBe('2026-07-01T04:00:00.000Z');
		expect(isMonthlyAverageClosed(2026, 9, '2026-10-01T13:00:00Z', 22)).toBe(true);
		// Calculado el último día del mes (sincronización diaria): abierto.
		expect(isMonthlyAverageClosed(2026, 9, '2026-09-30T23:00:00Z', 21)).toBe(false);
		expect(isMonthlyAverageClosed(2026, 9, '2026-10-01T02:59:59Z', 21)).toBe(false);
		// Fila con una sola tasa (carga a mano) o sin fecha de cálculo: nunca cerrada.
		expect(isMonthlyAverageClosed(2027, 1, '2027-03-01T00:00:00Z', 1)).toBe(false);
		expect(isMonthlyAverageClosed(2026, 9, null, 22)).toBe(false);
	});

	it('rango de meses del cálculo', () => {
		expect(monthlyAverageRange({ year: 2026, month: 9 })).toEqual(['2026-09-01', '2026-10-01']);
		expect(monthlyAverageRange({ year: 2026, month: 12 })).toEqual(['2026-12-01', '2027-01-01']);
		expect(monthlyAverageRange({ year: 2025 })).toEqual(['2025-01-01', '2026-01-01']);
		expect(monthlyAverageRange({})).toEqual(['1900-01-01', '2200-01-01']);
	});
});
