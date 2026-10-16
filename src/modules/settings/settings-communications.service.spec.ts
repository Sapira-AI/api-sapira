import { promises as dns } from 'dns';

import { SettingsCommunicationsService } from './settings-communications.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

function setup() {
	let row: Record<string, unknown> = {
		id: ID,
		holding_id: HOLDING,
		sender_domain: 'firmare.cl',
		resend_domain_id: '33521008',
		domain_status: 'verified',
		domain_dns_records: [
			{ type: 'CNAME', name: 'em3870.firmare.cl', value: 'u1.wl.sendgrid.net', status: 'verified' },
			{ type: 'CNAME', name: 's1._domainkey.firmare.cl', value: 's1', status: 'verified' },
			{ type: 'CNAME', name: 's2._domainkey.firmare.cl', value: 's2', status: 'verified' },
			{ type: 'TXT', name: '_dmarc.firmare.cl', value: 'v=DMARC1; p=none', status: 'pending' },
		],
	};
	const dataSource = {
		query: jest.fn(async (sql: string, params: unknown[] = []) => {
			if (sql.includes('SELECT * FROM holding_email_sender_settings')) return [row];
			if (sql.startsWith('UPDATE holding_email_sender_settings SET domain_status'))
				row = { ...row, domain_status: params[2], domain_dns_records: params[3] };
			return [];
		}),
	};
	const service = new SettingsCommunicationsService(dataSource as never, {} as never, { get: () => 'SG.clave' } as never);
	return { service, estado: () => row };
}

describe('SettingsCommunicationsService · revisar estado', () => {
	const fetchMock = jest.fn();
	const validos = { mail_cname: { valid: true }, dkim1: { valid: true }, dkim2: { valid: true } };

	beforeEach(() => {
		fetchMock.mockReset();
		global.fetch = fetchMock as never;
		jest.restoreAllMocks();
		jest.spyOn(dns, 'resolveTxt').mockResolvedValue([['v=DMARC1; p=none; rua=mailto:dmarc@firmare.cl']]);
	});

	it('si SendGrid responde valid:false en una consulta suelta, pide validar antes de dejarlo pendiente', async () => {
		fetchMock.mockResolvedValueOnce(json({ valid: false })).mockResolvedValueOnce(json({ valid: true, validation_results: validos }));
		const { service, estado } = setup();

		const resultado = await service.checkStatus(HOLDING, ID);

		expect(fetchMock.mock.calls.map(([url, init]) => `${(init as RequestInit).method} ${url}`)).toEqual([
			'GET https://api.sendgrid.com/v3/whitelabel/domains/33521008',
			'POST https://api.sendgrid.com/v3/whitelabel/domains/33521008/validate',
		]);
		expect(resultado.status).toBe('verified');
		expect(estado().domain_status).toBe('verified');
	});

	it('con la consulta válida no pide validar, y el DMARC publicado queda OK', async () => {
		fetchMock.mockResolvedValueOnce(json({ valid: true, dns: validos }));
		const { service, estado } = setup();

		await service.checkStatus(HOLDING, ID);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(estado().domain_dns_records)).map((record: { status: string }) => record.status)).toEqual([
			'verified',
			'verified',
			'verified',
			'verified',
		]);
	});

	it('si la validación también falla, queda pendiente; un DMARC sin publicar queda pendiente', async () => {
		jest.spyOn(dns, 'resolveTxt').mockRejectedValue(new Error('ENOTFOUND'));
		fetchMock
			.mockResolvedValueOnce(json({ valid: false }))
			.mockResolvedValueOnce(json({ valid: false, validation_results: { ...validos, dkim2: { valid: false, reason: 'No encontrado' } } }));
		const { service, estado } = setup();

		expect((await service.checkStatus(HOLDING, ID)).status).toBe('pending');
		expect(JSON.parse(String(estado().domain_dns_records)).map((record: { status: string }) => record.status)).toEqual([
			'verified',
			'verified',
			'pending',
			'pending',
		]);
	});
});
