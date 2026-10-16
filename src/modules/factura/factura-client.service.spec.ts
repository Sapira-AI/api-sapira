import { BadGatewayException } from '@nestjs/common';
import axios from 'axios';

import { FacturaClientService, facturaHttpError } from './factura-client.service';

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

	describe('errores de api-factura', () => {
		const build = () => {
			const oauth = { getAccessToken: jest.fn().mockResolvedValue('oauth-token') };
			const config = { get: jest.fn().mockReturnValue('http://localhost:9005') };

			return new FacturaClientService(config as any, oauth as any);
		};
		const axiosError = (status: number | undefined, message?: unknown) =>
			Object.assign(new Error(`Request failed with status code ${status}`), {
				isAxiosError: true,
				response: status ? { status, data: { message } } : undefined,
			});
		const reject = (error: unknown) => jest.spyOn(axios, 'post').mockRejectedValueOnce(error);

		afterEach(() => jest.restoreAllMocks());

		it('un 403 entre servicios llega como 502 con el mensaje de api-factura (no como "sin permiso")', async () => {
			reject(axiosError(403, 'X-Factura-Company-Id es requerido para operar en nombre de una empresa'));

			const error = await build()
				.provisionEmpresa({} as any)
				.catch((cause) => cause);

			expect(error).toBeInstanceOf(BadGatewayException);
			expect(error.message).toBe(
				'El servicio de facturación rechazó la operación (403): X-Factura-Company-Id es requerido para operar en nombre de una empresa'
			);
		});

		it('los errores de datos conservan su estado y mensaje', async () => {
			reject(axiosError(409, 'El RUT ya está vinculado a otra empresa externa del integrador'));

			const error = await build()
				.provisionEmpresa({} as any)
				.catch((cause) => cause);

			expect(error.getStatus()).toBe(409);
			expect(error.message).toBe('El RUT ya está vinculado a otra empresa externa del integrador');
			expect(facturaHttpError(axiosError(400, ['giro must be a string', 'comuna should not be empty'])).message).toBe(
				'giro must be a string. comuna should not be empty'
			);
		});

		it('sin respuesta (caído o sin red) es 502', async () => {
			reject(axiosError(undefined));

			await expect(build().provisionEmpresa({} as any)).rejects.toBeInstanceOf(BadGatewayException);
			expect(facturaHttpError(new Error('otro')).getStatus()).toBe(502);
		});
	});
});
