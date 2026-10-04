import { addMonths, fxMonthCloseKey, isMonthComplete, monthStartIn, weekdaysOf } from './fx-month-close';

describe('cierre mensual de la moneda de compañía · reglas puras', () => {
	it('monthStartIn: el mes de negocio en America/Santiago (no UTC)', () => {
		// 01-11 00:30 UTC = 31-10 21:30 en Santiago: todavía es octubre.
		expect(monthStartIn(new Date('2026-11-01T00:30:00Z'), 'America/Santiago')).toBe('2026-10-01');
		expect(monthStartIn(new Date('2026-11-01T13:00:00Z'), 'America/Santiago')).toBe('2026-11-01');
	});

	it('addMonths cruza años en ambos sentidos', () => {
		expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
		expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
		expect(addMonths('2026-10-01', -12)).toBe('2025-10-01');
	});

	it('weekdaysOf: días hábiles (lunes a viernes) y el último', () => {
		expect(weekdaysOf('2026-09-01')).toEqual({ weekdays: 22, lastWeekday: '2026-09-30' });
		// Octubre 2026 termina sábado: el último hábil es el viernes 30.
		expect(weekdaysOf('2026-10-01')).toEqual({ weekdays: 22, lastWeekday: '2026-10-30' });
	});

	it('isMonthComplete: completo con holgura de 3 días hábiles; incompleto por pocos días, última tasa lejana o sin tasas', () => {
		const pair = { from_currency: 'USD', to_currency: 'CLP' };

		expect(isMonthComplete('2026-09-01', { ...pair, days: 21, last_date: '2026-09-30' }).complete).toBe(true);
		expect(isMonthComplete('2026-09-01', { ...pair, days: 19, last_date: '2026-09-28' }).complete).toBe(true);
		expect(isMonthComplete('2026-09-01', { ...pair, days: 18, last_date: '2026-09-30' })).toMatchObject({
			complete: false,
			reason: '18 de 22 días hábiles',
		});
		expect(isMonthComplete('2026-09-01', { ...pair, days: 20, last_date: '2026-09-25' })).toMatchObject({
			complete: false,
			reason: 'la última tasa es del 2026-09-25',
		});
		expect(isMonthComplete('2026-09-01', { ...pair, days: 0, last_date: null })).toMatchObject({ complete: false, reason: 'sin tasas diarias' });
		// Series con fines de semana (UF, Perú API) tienen más puntos que días hábiles: completo.
		expect(isMonthComplete('2026-09-01', { from_currency: 'CLF', to_currency: 'CLP', days: 30, last_date: '2026-09-30' }).complete).toBe(true);
	});

	it('clave de la alerta: una por mes', () => {
		expect(fxMonthCloseKey('2026-09-01')).toBe('fx-month-close:2026-09');
	});
});
