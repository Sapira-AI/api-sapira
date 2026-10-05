import { DEFAULT_HOLDING_TIMEZONE, todayFor } from './business-date';

describe('todayFor (hoy del holding, cobertura D16 / Huecos #10)', () => {
	it('usa America/Santiago por defecto: a las 22:30 de Chile (01:30 UTC del día siguiente) sigue siendo el mismo día', () => {
		expect(DEFAULT_HOLDING_TIMEZONE).toBe('America/Santiago');
		// 2026-10-01 22:30 en Santiago (UTC−3) = 2026-10-02T01:30Z: la fecha UTC ya es mañana.
		expect(todayFor(null, new Date('2026-10-02T01:30:00Z'))).toBe('2026-10-01');
		expect(todayFor(undefined, new Date('2026-10-02T03:30:00Z'))).toBe('2026-10-02');
		// Invierno (UTC−4).
		expect(todayFor(null, new Date('2026-07-01T03:30:00Z'))).toBe('2026-06-30');
	});

	it('respeta la zona indicada y cae al default con una zona inválida', () => {
		expect(todayFor('UTC', new Date('2026-10-02T01:30:00Z'))).toBe('2026-10-02');
		expect(todayFor('America/Mexico_City', new Date('2026-10-02T05:30:00Z'))).toBe('2026-10-01');
		expect(todayFor('No/Existe', new Date('2026-10-02T01:30:00Z'))).toBe('2026-10-01');
	});
});
