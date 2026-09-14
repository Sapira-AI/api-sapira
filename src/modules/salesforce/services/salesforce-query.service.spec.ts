import { of, throwError } from 'rxjs';

import { SalesforceQueryService } from './salesforce-query.service';

describe('SalesforceQueryService', () => {
	const buildService = () => {
		const connection = {
			holding_id: 'holding-1',
			is_active: true,
			instance_url: 'https://acme.my.salesforce.com',
			access_token: 'token-viejo',
			login_url: 'https://login.salesforce.com',
		};
		const connectionRepository = {
			findOne: jest.fn().mockResolvedValue(connection),
			update: jest.fn().mockResolvedValue(undefined),
		};
		const tokenService = {
			// El token parece vigente para el reloj local: no hay refresh proactivo.
			isTokenExpired: jest.fn().mockReturnValue(false),
			ensureValidToken: jest.fn().mockResolvedValue('token-viejo'),
			refreshAccessToken: jest.fn().mockResolvedValue({
				access_token: 'token-nuevo',
				instance_url: 'https://acme.my.salesforce.com',
				issued_at: String(Date.now()),
			}),
			updateTokens: jest.fn().mockResolvedValue(undefined),
		};
		const httpService = {
			get: jest.fn(),
		};

		return {
			service: new SalesforceQueryService(connectionRepository as any, tokenService as any, httpService as any),
			connectionRepository,
			tokenService,
			httpService,
			connection,
		};
	};

	const unauthorized = () => Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } });
	const okPage = (records: unknown[]) => of({ data: { records, done: true } });

	it('re-autentica y reintenta una vez cuando Salesforce rechaza un token que parecía vigente', async () => {
		const { service, tokenService, httpService } = buildService();
		httpService.get.mockReturnValueOnce(throwError(() => unauthorized())).mockReturnValueOnce(okPage([{ Id: 'opp-1' }]));

		const result = await service.executeQuery('SELECT Id FROM Opportunity', 'holding-1');

		expect(tokenService.refreshAccessToken).toHaveBeenCalledTimes(1);
		expect(tokenService.updateTokens).toHaveBeenCalledWith('holding-1', expect.objectContaining({ access_token: 'token-nuevo' }));
		expect(httpService.get).toHaveBeenCalledTimes(2);
		expect(result.data.records).toEqual([{ Id: 'opp-1' }]);
		expect(result.tokenRefreshed).toBe(true);
	});

	it('no desactiva la conexión cuando el 401 persiste tras re-autenticar', async () => {
		const { service, connectionRepository, tokenService, httpService } = buildService();
		httpService.get.mockReturnValue(throwError(() => unauthorized()));

		await expect(service.executeQuery('SELECT Id FROM Opportunity', 'holding-1')).rejects.toThrow(
			'Salesforce authentication failed. Please reconnect.'
		);

		// Un solo reintento, y la conexión sigue activa para la corrida del día siguiente.
		expect(tokenService.refreshAccessToken).toHaveBeenCalledTimes(1);
		expect(httpService.get).toHaveBeenCalledTimes(2);
		expect(connectionRepository.update).not.toHaveBeenCalledWith({ holding_id: 'holding-1' }, { is_active: false });
	});

	it('informa cuando la re-autenticación misma falla, sin reintentar la consulta', async () => {
		const { service, connectionRepository, tokenService, httpService } = buildService();
		httpService.get.mockReturnValue(throwError(() => unauthorized()));
		tokenService.refreshAccessToken.mockRejectedValue(new Error('SOAP re-authentication failed: INVALID_LOGIN'));

		await expect(service.executeQuery('SELECT Id FROM Opportunity', 'holding-1')).rejects.toThrow(
			'Salesforce authentication failed and re-authentication was not possible: SOAP re-authentication failed: INVALID_LOGIN'
		);

		expect(httpService.get).toHaveBeenCalledTimes(1);
		expect(connectionRepository.update).not.toHaveBeenCalledWith({ holding_id: 'holding-1' }, { is_active: false });
	});

	it('no reintenta ni re-autentica ante errores que no son 401', async () => {
		const { service, tokenService, httpService } = buildService();
		httpService.get.mockReturnValue(
			throwError(() => Object.assign(new Error('boom'), { response: { status: 400, data: [{ message: 'MALFORMED_QUERY' }] } }))
		);

		await expect(service.executeQuery('SELECT Id FROM Opportunity', 'holding-1')).rejects.toThrow('MALFORMED_QUERY');

		expect(tokenService.refreshAccessToken).not.toHaveBeenCalled();
		expect(httpService.get).toHaveBeenCalledTimes(1);
	});

	it('lanza NotFoundException cuando el holding no tiene conexión activa', async () => {
		const { service, connectionRepository } = buildService();
		connectionRepository.findOne.mockResolvedValue(null);

		await expect(service.executeQuery('SELECT Id FROM Opportunity', 'holding-1')).rejects.toThrow('No active Salesforce connection found');
	});

	it('agrega todas las páginas de resultados en una sola respuesta', async () => {
		const { service, httpService } = buildService();
		httpService.get
			.mockReturnValueOnce(of({ data: { records: [{ Id: 'opp-1' }], done: false, nextRecordsUrl: '/services/data/v58.0/query/01g-2000' } }))
			.mockReturnValueOnce(of({ data: { records: [{ Id: 'opp-2' }], done: true } }));

		const result = await service.executeQuery('SELECT Id FROM Opportunity', 'holding-1');

		expect(result.data.records).toEqual([{ Id: 'opp-1' }, { Id: 'opp-2' }]);
		expect(result.data.done).toBe(true);
	});
});
