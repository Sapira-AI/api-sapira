import { getCorsOrigins, getFrontendOrigins } from './cors-origins';

describe('cors-origins', () => {
	it('usa los fronts locales cuando FRONT_BASE_URL no está definida', () => {
		expect(getFrontendOrigins('')).toEqual(['http://localhost:8080', 'http://localhost:8081']);
	});

	it('separa FRONT_BASE_URL por coma y descarta espacios y vacíos', () => {
		expect(getFrontendOrigins(' https://app.aisapira.com , https://www.aisapira.com,,')).toEqual([
			'https://app.aisapira.com',
			'https://www.aisapira.com',
		]);
	});

	it('comparte la lista entre HTTP y WebSocket e incluye los previews de Vercel', () => {
		const origins = getCorsOrigins('https://www.aisapira.com');

		expect(origins).toContain('https://www.aisapira.com');
		expect(origins.some((origin) => origin instanceof RegExp && origin.test('https://front-sapira-git-domi.vercel.app'))).toBe(true);
	});
});
