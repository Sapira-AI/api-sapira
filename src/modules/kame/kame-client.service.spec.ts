import axios from 'axios';

import { KameApiError, KameClientService, readWriteResult } from './kame-client.service';

jest.mock('axios', () => {
	const instance = { request: jest.fn() };
	const mocked = { create: jest.fn(() => instance), post: jest.fn(), instance };

	return { __esModule: true, default: mocked, ...mocked, AxiosError: class AxiosError extends Error {} };
});

const mockedAxios = axios as unknown as { post: jest.Mock; instance: { request: jest.Mock } };
const credential = { key: 'conn-1', clientId: 'id', clientSecret: 'secret' };
const httpError = (status: number | null, data?: unknown, code?: string) =>
	Object.assign(new Error(`HTTP ${status}`), { response: status === null ? undefined : { status, data }, code });

describe('KameClientService', () => {
	let client: KameClientService;

	beforeEach(() => {
		jest.clearAllMocks();
		delete process.env.KAME_API_URL;
		client = new KameClientService();
		mockedAxios.post.mockResolvedValue({ data: { access_token: 'tok-1', expires_in: 86400, token_type: 'Bearer' } });
	});

	it('pide el token con client_credentials y audience, y lo reutiliza mientras no venza', async () => {
		mockedAxios.instance.request.mockResolvedValue({ data: [] });

		await client.listBusinessUnits(credential);
		await client.listBusinessUnits(credential);

		expect(mockedAxios.post).toHaveBeenCalledTimes(1);
		expect(mockedAxios.post).toHaveBeenCalledWith(
			'https://api.kameone.cl/oauth/token',
			{ client_id: 'id', client_secret: 'secret', audience: 'https://api.kameone.cl/api', grant_type: 'client_credentials' },
			expect.anything()
		);
		expect(mockedAxios.instance.request).toHaveBeenCalledWith(
			expect.objectContaining({ method: 'get', url: '/Maestro/getListUnidadNegocio', headers: { Authorization: 'Bearer tok-1' } })
		);
	});

	it('una credencial rechazada da un error legible y no reintentable', async () => {
		mockedAxios.post.mockRejectedValue(httpError(401, { error: 'access_denied' }));

		await expect(client.token(credential)).rejects.toMatchObject({ message: 'Kame rechazó el client ID o el client secret', retryable: false });
	});

	it('un 401 en una petición renueva el token una vez', async () => {
		mockedAxios.instance.request.mockRejectedValueOnce(httpError(401)).mockResolvedValueOnce({ data: { Estado: 'Ok', Id: 7, Folio: 5 } });

		const result = await client.write(credential, '/Documento/addVenta', {});

		expect(mockedAxios.post).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ ok: true, id: '7', folio: '5' });
	});

	it('el 403 sin cuerpo del firewall es límite de tasa (reintentable); un 400 con Error es un rechazo', async () => {
		mockedAxios.instance.request.mockRejectedValueOnce(httpError(403, '<html>Forbidden</html>'));
		await expect(client.getSale(credential, 'Factura Electrónica', 5)).rejects.toMatchObject({ retryable: true, status: 403 });

		mockedAxios.instance.request.mockRejectedValueOnce(httpError(400, { Error: 'El folio ya existe' }));
		await expect(client.write(credential, '/Documento/addVenta', {})).rejects.toMatchObject({ message: 'El folio ya existe', retryable: false });

		mockedAxios.instance.request.mockRejectedValueOnce(httpError(null, undefined, 'ECONNRESET'));
		await expect(client.write(credential, '/Documento/addVenta', {})).rejects.toBeInstanceOf(KameApiError);
	});

	it('getVenta lleva el nombre del documento en la ruta', async () => {
		mockedAxios.instance.request.mockResolvedValue({ data: { IdVenta: 1 } });

		await client.getSale(credential, 'Factura Electrónica', 5);

		expect(mockedAxios.instance.request).toHaveBeenCalledWith(
			expect.objectContaining({ url: '/Documento/getVenta/Factura%20Electr%C3%B3nica/5' })
		);
	});

	it('readWriteResult: Estado Ok o la ausencia de Error', () => {
		expect(readWriteResult({ Estado: 'Ok', Id: 1183781, Folio: 1, Error: null })).toMatchObject({
			ok: true,
			id: '1183781',
			folio: '1',
			error: null,
		});
		expect(readWriteResult({ Estado: 'Error', Error: 'IVA no cuadra' })).toMatchObject({ ok: false, error: 'IVA no cuadra' });
		expect(readWriteResult({ idComprobante: 99 })).toMatchObject({ ok: true, id: '99' });
	});
});
