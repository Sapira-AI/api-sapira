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

		it('si api-factura no da el token de provisión llega un 502 que dice qué revisar, no un 500', async () => {
			const oauth = {
				getAccessToken: jest
					.fn()
					.mockRejectedValue(
						Object.assign(new Error('Request failed with status code 401'), { isAxiosError: true, response: { status: 401, data: {} } })
					),
			};
			const service = new FacturaClientService({ get: jest.fn().mockReturnValue('http://localhost:9005') } as any, oauth as any);
			const post = jest.spyOn(axios, 'post');

			await expect(service.provisionEmpresa({} as any)).rejects.toMatchObject({
				status: 502,
				message: expect.stringContaining('factura:empresas:provision'),
			});
			await expect(service.registrarCanalCorreo('SG.clave')).rejects.toMatchObject({ status: 502 });
			expect(post).not.toHaveBeenCalled();
		});

		it('con el OAuth sin configurar o api-factura caído al pedir el token, el 502 conserva el motivo', async () => {
			const oauth = { getAccessToken: jest.fn().mockRejectedValue(new Error('OAuth de api-factura no está configurado')) };
			const service = new FacturaClientService({ get: jest.fn().mockReturnValue('http://localhost:9005') } as any, oauth as any);

			await expect(service.provisionEmpresa({} as any)).rejects.toMatchObject({
				status: 502,
				message: 'No se pudo autenticar con el servicio de facturación: OAuth de api-factura no está configurado',
			});
		});

		it('sin FACTURA_API_URL responde 503 con el motivo, sin pedir token', async () => {
			const oauth = { getAccessToken: jest.fn() };
			const service = new FacturaClientService({ get: jest.fn().mockReturnValue(undefined) } as any, oauth as any);

			await expect(service.provisionEmpresa({} as any)).rejects.toMatchObject({
				status: 503,
				message: expect.stringContaining('FACTURA_API_URL'),
			});
			expect(oauth.getAccessToken).not.toHaveBeenCalled();
		});

		it('sin respuesta (caído o sin red) es 502', async () => {
			reject(axiosError(undefined));

			await expect(build().provisionEmpresa({} as any)).rejects.toBeInstanceOf(BadGatewayException);
			expect(facturaHttpError(new Error('otro')).getStatus()).toBe(502);
		});
	});

	describe('documentos tributarios (DTE)', () => {
		const build = () => {
			const oauth = {
				getAccessToken: jest.fn().mockResolvedValue('provision-token'),
				getDteAccessToken: jest.fn().mockResolvedValue('dte-token'),
			};
			const config = { get: jest.fn().mockReturnValue('http://localhost:9005/') };

			return { service: new FacturaClientService(config as any, oauth as any), oauth };
		};
		const COMPANY = '1bdded45-cda6-4148-a425-fa0086e27ce8';

		afterEach(() => jest.restoreAllMocks());

		it('crea el DTE con la referencia externa, solo en producción, con el token de DTE y la compañía en X-Factura-Company-Id', async () => {
			const { service, oauth } = build();
			const post = jest.spyOn(axios, 'post').mockResolvedValue({
				data: { data: { id: { toString: () => 'dte-1' }, folio: 15, tipoDte: 33, ambiente: 'produccion', existente: false } },
			});

			await expect(service.crearDte(COMPANY, { Encabezado: {} }, 'invoice-1')).resolves.toEqual({
				id: 'dte-1',
				folio: 15,
				tipoDte: 33,
				ambiente: 'produccion',
				existente: false,
			});
			expect(post).toHaveBeenCalledWith(
				'http://localhost:9005/dte/createDte',
				{ Encabezado: {}, externalRef: 'invoice-1', ambienteRequerido: 'produccion' },
				expect.objectContaining({ headers: { Authorization: 'Bearer dte-token', 'X-Factura-Company-Id': COMPANY } })
			);
			expect(oauth.getAccessToken).not.toHaveBeenCalled();

			await service.crearDte(COMPANY, { Encabezado: {} }, 'invoice-1', { reemitirRechazado: true });
			expect(post).toHaveBeenLastCalledWith(
				'http://localhost:9005/dte/createDte',
				{ Encabezado: {}, externalRef: 'invoice-1', ambienteRequerido: 'produccion', reemitirRechazado: true },
				expect.anything()
			);
		});

		it('envía al SII, consulta el estado y entrega al receptor', async () => {
			const { service } = build();
			const post = jest
				.spyOn(axios, 'post')
				.mockResolvedValueOnce({ data: { data: { trackId: 262800001 } } })
				.mockResolvedValueOnce({ data: { data: { para: 'dte@cliente.cl', messageId: 'msg-1' } } });
			const get = jest.spyOn(axios, 'get').mockResolvedValue({
				data: { data: { resultado: 'aceptado', estado: 'EPR', glosaEstado: 'Envio Procesado', trackId: '262800001' } },
			});

			await expect(service.enviarDte(COMPANY, 'dte-1')).resolves.toEqual({ trackId: '262800001' });
			expect(post.mock.calls[0].slice(0, 2)).toEqual(['http://localhost:9005/dte/sendDte', { dteIds: ['dte-1'] }]);
			await expect(service.estadoDte(COMPANY, 'dte-1')).resolves.toMatchObject({ resultado: 'aceptado' });
			expect(get.mock.calls[0][0]).toBe('http://localhost:9005/dte/dte-1/estado');
			await expect(service.enviarReceptor(COMPANY, 'dte-1', 'dte@cliente.cl')).resolves.toEqual({ para: 'dte@cliente.cl', messageId: 'msg-1' });
			expect(post.mock.calls[1].slice(0, 2)).toEqual(['http://localhost:9005/dte/dte-1/enviar-receptor', { para: 'dte@cliente.cl' }]);
		});

		it('descarga el PDF cedible con su nombre de archivo', async () => {
			const { service } = build();
			const get = jest.spyOn(axios, 'get').mockResolvedValue({
				data: Buffer.from('%PDF'),
				headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="DTE-33-15-cedible.pdf"' },
			});

			await expect(service.documentoDte(COMPANY, 'dte-1', 'pdf', 'cedible')).resolves.toEqual({
				contenido: Buffer.from('%PDF'),
				contentType: 'application/pdf',
				fileName: 'DTE-33-15-cedible.pdf',
			});
			expect(get).toHaveBeenCalledWith(
				'http://localhost:9005/dte/dte-1/pdf?copia=cedible',
				expect.objectContaining({ responseType: 'arraybuffer' })
			);
		});

		it('pide el PDF en borrador con el cuerpo del DTE', async () => {
			const { service } = build();
			const post = jest
				.spyOn(axios, 'post')
				.mockResolvedValue({ data: Buffer.from('%PDF-borrador'), headers: { 'content-type': 'application/pdf' } });

			await expect(service.previewPdfDte(COMPANY, { Encabezado: {} })).resolves.toMatchObject({
				contentType: 'application/pdf',
				fileName: 'Borrador.pdf',
			});
			expect(post).toHaveBeenCalledWith(
				'http://localhost:9005/dte/preview-pdf',
				{ Encabezado: {} },
				expect.objectContaining({
					responseType: 'arraybuffer',
					headers: { Authorization: 'Bearer dte-token', 'X-Factura-Company-Id': COMPANY },
				})
			);
		});

		it('un rechazo de datos de api-factura (422) llega con su mensaje', async () => {
			const { service } = build();
			jest.spyOn(axios, 'post').mockRejectedValueOnce(
				Object.assign(new Error('Request failed'), {
					isAxiosError: true,
					response: { status: 409, data: { message: 'No hay folios disponibles para el tipo 33' } },
				})
			);

			await expect(service.crearDte(COMPANY, {}, 'invoice-1')).rejects.toMatchObject({
				status: 409,
				message: 'No hay folios disponibles para el tipo 33',
			});
		});

		it('si api-factura no da el token de DTE (cliente OAuth sin los alcances) llega un 502 que dice qué falta, no un 500', async () => {
			const { service, oauth } = build();
			const post = jest.spyOn(axios, 'post');
			oauth.getDteAccessToken.mockRejectedValueOnce(
				Object.assign(new Error('Request failed with status code 401'), {
					isAxiosError: true,
					response: { status: 401, data: { message: 'invalid_scope' } },
				})
			);

			await expect(service.crearDte(COMPANY, {}, 'invoice-1')).rejects.toMatchObject({
				status: 502,
				message: expect.stringContaining('factura:dte:read y factura:dte:write'),
			});
			expect(post).not.toHaveBeenCalled();
		});
	});
});
