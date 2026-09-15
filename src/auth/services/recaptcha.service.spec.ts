import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RecaptchaService } from './recaptcha.service';

describe('RecaptchaService', () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	function createService(env: Record<string, string | undefined> = {}) {
		const values: Record<string, string | undefined> = {
			GOOGLE_RECAPTCHA_API_KEY: 'api-key',
			GOOGLE_RECAPTCHA_PROJECT_ID: 'project-id',
			GOOGLE_RECAPTCHA_SITE_KEY: 'site-key',
			RECAPTCHA_ENABLED: 'true',
			RECAPTCHA_MIN_SCORE: '0.5',
			FRONT_BASE_URL: 'http://localhost:8081,https://www.aisapira.com',
			...env,
		};
		const configService = {
			get: jest.fn((key: string, fallback?: string) => (values[key] === undefined ? fallback : values[key])),
		};

		return new RecaptchaService(configService as unknown as ConfigService);
	}

	function mockAssessment(payload: unknown, ok = true, status = 200) {
		global.fetch = jest.fn().mockResolvedValue({
			ok,
			status,
			statusText: ok ? 'OK' : 'Bad Request',
			json: jest.fn().mockResolvedValue(payload),
		}) as unknown as typeof fetch;
	}

	it('omite la validación cuando reCAPTCHA está deshabilitado', async () => {
		const service = createService({ RECAPTCHA_ENABLED: 'false' });

		await expect(service.verifyToken(undefined, { expectedAction: 'LOGIN' })).resolves.toEqual(
			expect.objectContaining({
				tokenProperties: expect.objectContaining({ valid: true, action: 'LOGIN' }),
				riskAnalysis: expect.objectContaining({ reasons: ['DISABLED_IN_SETTINGS'] }),
			})
		);
		expect(global.fetch).toBe(originalFetch);
	});

	it('omite la validación cuando faltan credenciales', async () => {
		const service = createService({ GOOGLE_RECAPTCHA_API_KEY: '' });

		await expect(service.verifyToken(undefined)).resolves.toEqual(
			expect.objectContaining({
				riskAnalysis: expect.objectContaining({ reasons: ['DISABLED_IN_SETTINGS'] }),
			})
		);
	});

	it('exige token cuando está habilitado', async () => {
		const service = createService();

		await expect(service.verifyToken(undefined)).rejects.toBeInstanceOf(BadRequestException);
	});

	it('rechaza un token inválido', async () => {
		const service = createService();
		mockAssessment({ tokenProperties: { valid: false, invalidReason: 'EXPIRED' } });

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).rejects.toThrow('La validación del captcha falló');
	});

	it('rechaza una acción distinta a la esperada', async () => {
		const service = createService();
		mockAssessment({
			tokenProperties: { valid: true, hostname: 'localhost', action: 'public_lead' },
			riskAnalysis: { score: 0.9 },
		});

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).rejects.toThrow('La acción del captcha no coincide');
	});

	it('rechaza un score bajo el umbral', async () => {
		const service = createService();
		mockAssessment({
			tokenProperties: { valid: true, hostname: 'localhost', action: 'LOGIN' },
			riskAnalysis: { score: 0.2 },
		});

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).rejects.toThrow('puntaje mínimo');
	});

	it('acepta un hostname permitido y un score suficiente', async () => {
		const service = createService();
		mockAssessment({
			tokenProperties: { valid: true, hostname: 'www.aisapira.com', action: 'LOGIN' },
			riskAnalysis: { score: 0.8 },
		});

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).resolves.toEqual(
			expect.objectContaining({
				tokenProperties: expect.objectContaining({ valid: true, action: 'LOGIN' }),
			})
		);
	});

	it('rechaza un hostname no permitido', async () => {
		const service = createService();
		mockAssessment({
			tokenProperties: { valid: true, hostname: 'evil.example.com', action: 'LOGIN' },
			riskAnalysis: { score: 0.9 },
		});

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).rejects.toThrow('La validación del captcha falló');
	});

	it('lanza 500 si Google responde error', async () => {
		const service = createService();
		mockAssessment({ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }, false, 400);

		await expect(service.verifyToken('token', { expectedAction: 'LOGIN' })).rejects.toBeInstanceOf(InternalServerErrorException);
	});

	it('expone siteKey solo cuando está habilitado', () => {
		expect(createService().getPublicAuthConfig()).toEqual({
			recaptcha: { enabled: true, siteKey: 'site-key' },
		});
		expect(createService({ RECAPTCHA_ENABLED: 'false' }).getPublicAuthConfig()).toEqual({
			recaptcha: { enabled: false, siteKey: '' },
		});
	});
});
