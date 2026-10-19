import axios from 'axios';

import { FACTURA_DTE_SCOPE_DEFAULT, FacturaOAuthService } from './factura-oauth.service';

describe('FacturaOAuthService', () => {
	const config = (values: Record<string, string>) => ({ get: jest.fn((key: string) => values[key]) });
	const base = { FACTURA_API_URL: 'http://localhost:9005', FACTURA_OAUTH_CLIENT_ID: 'sapira-api', FACTURA_OAUTH_CLIENT_SECRET: 'secreto' };

	afterEach(() => jest.restoreAllMocks());

	it('pide un token por conjunto de alcances: la provisión no depende de los de DTE, y cada uno se reutiliza mientras vale', async () => {
		const post = jest
			.spyOn(axios, 'post')
			.mockResolvedValueOnce({ data: { access_token: 'provision', expires_in: 900 } })
			.mockResolvedValueOnce({ data: { access_token: 'dte', expires_in: 900 } });
		const service = new FacturaOAuthService(config(base) as any);

		await expect(service.getAccessToken()).resolves.toBe('provision');
		await expect(service.getDteAccessToken()).resolves.toBe('dte');
		await expect(service.getAccessToken()).resolves.toBe('provision');
		await expect(service.getDteAccessToken()).resolves.toBe('dte');
		expect(post).toHaveBeenCalledTimes(2);
		expect(String(post.mock.calls[0][1])).toContain('scope=factura%3Aempresas%3Aprovision');
		expect(new URLSearchParams(String(post.mock.calls[1][1])).get('scope')).toBe(FACTURA_DTE_SCOPE_DEFAULT);
	});

	it('los alcances se configuran con FACTURA_OAUTH_SCOPE y FACTURA_OAUTH_DTE_SCOPE', async () => {
		const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'token', expires_in: 900 } });
		const service = new FacturaOAuthService(config({ ...base, FACTURA_OAUTH_DTE_SCOPE: 'factura:dte:write' }) as any);

		await service.getDteAccessToken();
		expect(new URLSearchParams(String(post.mock.calls[0][1])).get('scope')).toBe('factura:dte:write');
	});
});
