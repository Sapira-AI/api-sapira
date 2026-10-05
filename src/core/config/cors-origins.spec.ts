import { corsOriginsFaltante, getCorsOrigins, getFrontendOrigins } from './cors-origins';

describe('cors-origins', () => {
	describe('getFrontendOrigins (URL de los fronts, insumo de recaptcha)', () => {
		it('usa los fronts locales cuando FRONT_BASE_URL no está definida', () => {
			expect(getFrontendOrigins('')).toEqual(['http://localhost:8080', 'http://localhost:8081']);
		});

		it('separa FRONT_BASE_URL por coma y descarta espacios y vacíos', () => {
			expect(getFrontendOrigins(' https://app.aisapira.com , https://www.aisapira.com,,')).toEqual([
				'https://app.aisapira.com',
				'https://www.aisapira.com',
			]);
		});
	});

	describe('getCorsOrigins (política de CORS)', () => {
		it('sale de CORS_ORIGINS, no de FRONT_BASE_URL', () => {
			expect(getCorsOrigins('https://www.aisapira.com', 'https://otro-front.example.com')).toEqual(['https://www.aisapira.com']);
		});

		it('separa por coma y descarta espacios y vacíos', () => {
			expect(getCorsOrigins(' https://app.aisapira.com , https://www.aisapira.com,,')).toEqual([
				'https://app.aisapira.com',
				'https://www.aisapira.com',
			]);
		});

		/**
		 * Regresión del 05-10-2026: la lista incluía `/\.vercel\.app$/`, así que **cualquier** dominio
		 * `*.vercel.app` —de cualquiera, no solo de Sapira— podía hacer peticiones con credenciales.
		 */
		it('no devuelve comodines: ningún RegExp y nada de *.vercel.app ajeno', () => {
			const origins = getCorsOrigins('https://www.aisapira.com');

			expect(origins.every((origin) => typeof origin === 'string')).toBe(true);
			expect(origins).not.toContain('https://cualquiera.vercel.app');
			expect(origins.some((origin) => origin.includes('vercel.app'))).toBe(false);
		});

		it('un preview de Vercel entra solo si está declarado en CORS_ORIGINS', () => {
			const preview = 'https://front-sapira-git-domi.vercel.app';

			expect(getCorsOrigins('https://www.aisapira.com')).not.toContain(preview);
			expect(getCorsOrigins(`https://www.aisapira.com,${preview}`)).toContain(preview);
		});

		describe('compatibilidad: entornos que todavía no declaran CORS_ORIGINS', () => {
			it('cae a FRONT_BASE_URL cuando CORS_ORIGINS no está definida o viene vacía', () => {
				expect(getCorsOrigins(undefined, 'https://www.aisapira.com')).toEqual(['https://www.aisapira.com']);
				expect(getCorsOrigins('   ', 'https://www.aisapira.com')).toEqual(['https://www.aisapira.com']);
			});

			it('y en última instancia a los fronts locales', () => {
				expect(getCorsOrigins(undefined, '')).toEqual(['http://localhost:8080', 'http://localhost:8081']);
			});

			it('`corsOriginsFaltante` delata la caída para que main.ts avise al arrancar', () => {
				expect(corsOriginsFaltante(undefined)).toBe(true);
				expect(corsOriginsFaltante('   ')).toBe(true);
				expect(corsOriginsFaltante('https://www.aisapira.com')).toBe(false);
			});
		});
	});
});
