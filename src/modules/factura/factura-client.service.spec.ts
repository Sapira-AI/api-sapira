import { FacturaClientService } from './factura-client.service';

describe('FacturaClientService', () => {
	it('posts provision payloads with an external reference instead of sapira-specific fields', async () => {
		const oauth = { getAccessToken: jest.fn().mockResolvedValue('oauth-token') };
		const config = { get: jest.fn().mockReturnValue('http://localhost:9005') };
		const service = new FacturaClientService(config as any, oauth as any);
		const axios = require('axios');
		const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: { created: true } });
		const payload = {
			externalReference: { companyId: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6', tenantId: 'd2719d82-5d77-4cf2-9a51-faa3eb18b488' },
			rut: '76123456-7',
			razonSocial: 'Empresa Demo SpA',
			giro: 'Software',
			direccion: 'Av. Principal 1',
			comuna: 'Santiago',
			ciudad: 'Santiago',
		};

		await expect(service.provisionEmpresa(payload)).resolves.toEqual({ data: { created: true } });
		expect(post).toHaveBeenCalledWith('http://localhost:9005/empresas/provision', payload, {
			headers: { Authorization: 'Bearer oauth-token' },
		});
		expect(JSON.stringify(post.mock.calls[0][1])).not.toContain('sapiraCompanyId');
		post.mockRestore();
	});
});
