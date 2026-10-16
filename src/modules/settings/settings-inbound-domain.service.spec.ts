import { promises as dns } from 'dns';

import { esSubdominio, MX_SENDGRID, SettingsInboundDomainService } from './settings-inbound-domain.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function setup(fila?: Record<string, unknown>) {
	let row = fila;
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			if (sql.startsWith('SELECT * FROM holding_inbound_email_domains')) return row ? [row] : [];
			if (sql.startsWith('SELECT 1 FROM holding_inbound_email_domains')) return [];
			if (sql.startsWith('INSERT')) {
				row = {
					id: 'd1',
					holding_id: params[0],
					inbound_domain: params[1],
					sendgrid_domain_id: params[2],
					dns_records: params[3],
					domain_status: 'pending',
				};
				return [];
			}
			if (sql.startsWith('UPDATE')) {
				row = { ...row, dns_records: params[2], domain_status: params[3], inbound_parse_configured_at: params[5] };
				return [];
			}
			if (sql.startsWith('DELETE')) row = undefined;
			return [];
		}),
	};
	const config = { get: jest.fn(() => 'SG.clave-de-sapira') };
	const factura = { registrarCanalCorreo: jest.fn(async () => ({ inboundUrl: 'https://api-factura/intercambio/inbound/abc' })) };
	const service = new SettingsInboundDomainService(dataSource as never, config as never, factura as never);
	return { service, dataSource, factura };
}

describe('SettingsInboundDomainService', () => {
	const fetchMock = jest.fn();

	beforeEach(() => {
		fetchMock.mockReset();
		global.fetch = fetchMock as never;
		jest.restoreAllMocks();
	});

	it('solo acepta subdominios: un MX en el dominio principal se llevaría todo el correo', async () => {
		expect(esSubdominio('dte.empresa.cl')).toBe(true);
		expect(esSubdominio('empresa.cl')).toBe(false);
		await expect(setup().service.create(HOLDING, 'empresa.cl', 'auth-1')).rejects.toMatchObject({ status: 400 });
	});

	it('registra el dominio en SendGrid y muestra el MX hacia SendGrid junto a los CNAME de autenticación', async () => {
		fetchMock.mockResolvedValueOnce(
			json({
				id: 77,
				dns: {
					mail_cname: { host: 'em1.dte.empresa.cl', data: 'u1.wl.sendgrid.net', type: 'cname' },
					dkim1: { host: 's1._domainkey.dte.empresa.cl', data: 's1.x', type: 'cname' },
					dkim2: { host: 's2._domainkey.dte.empresa.cl', data: 's2.x', type: 'cname' },
				},
			})
		);
		const { service } = setup();

		const dominio = await service.create(HOLDING, ' DTE.Empresa.cl ', 'auth-1');

		expect(fetchMock).toHaveBeenCalledWith(
			'https://api.sendgrid.com/v3/whitelabel/domains',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ domain: 'dte.empresa.cl', automatic_security: true }) })
		);
		expect(dominio).toMatchObject({ inbound_domain: 'dte.empresa.cl', status: 'pending' });
		expect(dominio!.dns_records).toEqual([
			{ type: 'MX', name: 'dte.empresa.cl', value: MX_SENDGRID, priority: 10, status: 'pending' },
			{ type: 'CNAME', name: 'em1.dte.empresa.cl', value: 'u1.wl.sendgrid.net', status: 'pending' },
			expect.objectContaining({ name: 's1._domainkey.dte.empresa.cl' }),
			expect.objectContaining({ name: 's2._domainkey.dte.empresa.cl' }),
		]);
	});

	const registrado = () => ({
		id: 'd1',
		holding_id: HOLDING,
		inbound_domain: 'dte.empresa.cl',
		sendgrid_domain_id: '77',
		domain_status: 'pending',
		dns_records: [
			{ type: 'MX', name: 'dte.empresa.cl', value: MX_SENDGRID, priority: 10, status: 'pending' },
			{ type: 'CNAME', name: 'em1', value: 'x', status: 'pending' },
		],
	});

	it('con MX y CNAME puestos, registra el canal en api-factura y crea el Inbound Parse hacia su webhook', async () => {
		jest.spyOn(dns, 'resolveMx').mockResolvedValue([{ exchange: 'mx.sendgrid.net.', priority: 10 }]);
		fetchMock.mockResolvedValueOnce(json({ valid: true, validation_results: { mail_cname: { valid: true } } })).mockResolvedValueOnce(json({}));
		const { service, factura } = setup(registrado());

		const dominio = await service.verify(HOLDING);

		expect(factura.registrarCanalCorreo).toHaveBeenCalledWith('SG.clave-de-sapira');
		expect(fetchMock).toHaveBeenLastCalledWith(
			'https://api.sendgrid.com/v3/user/webhooks/parse/settings',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					hostname: 'dte.empresa.cl',
					url: 'https://api-factura/intercambio/inbound/abc',
					spam_check: false,
					send_raw: false,
				}),
			})
		);
		expect(dominio).toMatchObject({ status: 'verified', inbound_parse_configured_at: expect.any(Date) });
		expect(dominio!.dns_records.map((registro) => registro.status)).toEqual(['verified', 'verified']);
	});

	it('si el Inbound Parse ya existía, actualiza su URL', async () => {
		jest.spyOn(dns, 'resolveMx').mockResolvedValue([{ exchange: 'mx.sendgrid.net', priority: 10 }]);
		fetchMock
			.mockResolvedValueOnce(json({ valid: true, validation_results: {} }))
			.mockResolvedValueOnce(json({ errors: [{ message: 'hostname already exists' }] }, 400))
			.mockResolvedValueOnce(json({}));
		const { service } = setup(registrado());

		await service.verify(HOLDING);

		expect(fetchMock).toHaveBeenLastCalledWith(
			'https://api.sendgrid.com/v3/user/webhooks/parse/settings/dte.empresa.cl',
			expect.objectContaining({ method: 'PATCH' })
		);
	});

	it('sin el MX puesto queda pendiente y no conecta nada', async () => {
		jest.spyOn(dns, 'resolveMx').mockRejectedValue(new Error('ENOTFOUND'));
		fetchMock.mockResolvedValueOnce(json({ valid: true, validation_results: {} }));
		const { service, factura } = setup(registrado());

		const dominio = await service.verify(HOLDING);

		expect(dominio).toMatchObject({ status: 'pending', inbound_parse_configured_at: null });
		expect(factura.registrarCanalCorreo).not.toHaveBeenCalled();
	});

	it('eliminar borra el Inbound Parse, el dominio de SendGrid y la fila; sin dominio responde 404', async () => {
		fetchMock.mockResolvedValue(json({}));
		const { service } = setup(registrado());

		await service.remove(HOLDING);

		expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`)).toEqual([
			'DELETE https://api.sendgrid.com/v3/user/webhooks/parse/settings/dte.empresa.cl',
			'DELETE https://api.sendgrid.com/v3/whitelabel/domains/77',
		]);
		expect(await service.get(HOLDING)).toBeNull();
		await expect(service.remove(HOLDING)).rejects.toMatchObject({ status: 404 });
	});
});
