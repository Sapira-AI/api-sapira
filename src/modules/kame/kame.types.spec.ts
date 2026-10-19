import {
	allowedKameRuts,
	formatKameRut,
	isKameRutAllowed,
	KAME_MAX_ATTEMPTS,
	kameJobEnabled,
	kameRutGuard,
	monthStartOf,
	nextRetryDelay,
	normalizeKameRut,
	secretLast4,
} from './kame.types';

describe('kame.types', () => {
	it('normaliza y formatea el RUT como lo usa Kame', () => {
		expect(normalizeKameRut('10.491.356-3')).toBe('10491356-3');
		expect(normalizeKameRut('76222111k')).toBe('76222111-K');
		expect(normalizeKameRut(null)).toBe('');
		expect(formatKameRut('76007171-4')).toBe('76.007.171-4');
		expect(formatKameRut('10491356-3')).toBe('10.491.356-3');
	});

	it('KAME_ALLOWED_RUTS limita las empresas de Kame del entorno (vacío = cualquiera, producción)', () => {
		expect(allowedKameRuts('10.491.356-3, 76007171-4')).toEqual(['10491356-3', '76007171-4']);
		expect(allowedKameRuts('')).toEqual([]);
		expect(isKameRutAllowed('10491356-3', ['10491356-3'])).toBe(true);
		expect(isKameRutAllowed('76007171-4', ['10491356-3'])).toBe(false);
		// Sin lista: solo producción escribe en cualquier empresa; fuera de producción falla cerrado.
		expect(isKameRutAllowed('76007171-4', [], 'production')).toBe(true);
		expect(isKameRutAllowed('10491356-3', [], 'qa')).toBe(false);
		expect(isKameRutAllowed('10491356-3', [], undefined)).toBe(false);
		expect(kameRutGuard(['10491356-3'], 'qa')).toBe('lista');
		expect(kameRutGuard([], 'production')).toBe('abierto');
		expect(kameRutGuard([], 'development')).toBe('cerrado');
	});

	it('el job queda apagado salvo KAME_EXPORT_JOB_ENABLED=true', () => {
		expect(kameJobEnabled(undefined)).toBe(false);
		expect(kameJobEnabled('false')).toBe(false);
		expect(kameJobEnabled('true')).toBe(true);
	});

	it('reintentos con espera creciente y un máximo', () => {
		expect(nextRetryDelay(1)).toBe(60 * 60_000);
		expect(nextRetryDelay(2)).toBe(4 * 60 * 60_000);
		expect(nextRetryDelay(3)).toBe(24 * 60 * 60_000);
		expect(nextRetryDelay(KAME_MAX_ATTEMPTS)).toBeNull();
		expect(monthStartOf('2026-09-30')).toBe('2026-09-01');
		expect(secretLast4('abcdef1234')).toBe('1234');
		expect(secretLast4(null)).toBeNull();
	});
});
