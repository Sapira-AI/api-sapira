import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { EmailsService } from '@/modules/emails/emails.service';

import { fakeDb, Handler } from './fake-db.testing-spec';
import { SettingsCatalogsService } from './settings-catalogs.service';
import { emailBelongsToDomain, SettingsCommunicationsService } from './settings-communications.service';
import { cleanFieldOptions, SettingsCustomFieldsService } from './settings-custom-fields.service';
import { SettingsHoldingService } from './settings-holding.service';
import { SettingsTaxDocumentsService } from './settings-tax-documents.service';

/** Configuración v2 · ronda 3 (contrato §8): documentos tributarios, comunicaciones, detalle FX, tipos de negocio/contacto, campos. */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const DOMAIN = '33333333-3333-4333-8333-333333333333';
const SENDER = '44444444-4444-4444-8444-444444444444';

describe('Documentos tributarios de la compañía (§8.1, solo lectura)', () => {
	const service = (handlers: Handler[]) => new SettingsTaxDocumentsService(fakeDb(handlers) as unknown as DataSource);
	const doc = (country_code: string, code: string, kind: string, tax_rate: number | null, extra: Record<string, unknown> = {}) => ({
		id: `${country_code}-${code}`,
		country_code,
		code,
		name: code,
		kind,
		is_electronic: true,
		sort: 10,
		tax_rate,
		in_use: 0,
		in_use_open: 0,
		...extra,
	});

	it('Chile: documentos del país con tasa propia, tasa de la compañía si es null y exportación 0', async () => {
		const result = await service([
			['FROM companies WHERE id = $1 AND holding_id = $2', () => [{ id: COMPANY, country_code: 'CL ', country: 'Chile', tax_rate: 0.19 }]],
			[
				'FROM tax_document_types t',
				() => [
					doc('CL', '33', 'invoice', 19, { in_use: '3', in_use_open: '2' }),
					doc('CL', '34', 'invoice', 0),
					doc('CL', '110', 'export_invoice', 0),
					doc('CL', '61', 'credit_note', null),
					doc('*', 'FACTURA', 'invoice', null),
				],
			],
		]).get(HOLDING, COMPANY);

		expect(result).toMatchObject({ company_id: COMPANY, country_code: 'CL', company_tax_rate: 19, generic: false });
		expect(result.documents.map((row) => [row.code, row.effective_tax_rate, row.tax_rule])).toEqual([
			['33', 19, 'document'],
			['34', 0, 'document'],
			['110', 0, 'export'],
			['61', 19, 'company'],
		]);
		expect(result.documents[0]).toMatchObject({ in_use: 3, in_use_open: 2 });
	});

	it('Colombia: FE con tasa 0 y la regla del ERP; país sin documentos propios → genéricos', async () => {
		const colombia = await service([
			['FROM companies WHERE id', () => [{ id: COMPANY, country_code: 'CO', country: 'Colombia', tax_rate: 19 }]],
			['FROM tax_document_types t', () => [doc('CO', 'FE', 'invoice', 0)]],
		]).get(HOLDING, COMPANY);

		expect(colombia.documents[0]).toMatchObject({ effective_tax_rate: null, tax_rule: 'colombia_erp' });
		const generic = await service([
			['FROM companies WHERE id', () => [{ id: COMPANY, country_code: 'AR', country: 'Argentina', tax_rate: 21 }]],
			['FROM tax_document_types t', () => [doc('*', 'FACTURA', 'invoice', null), doc('*', 'FACTURA_EXPORTACION', 'export_invoice', null)]],
		]).get(HOLDING, COMPANY);

		expect(generic.generic).toBe(true);
		expect(generic.documents.map((row) => [row.code, row.effective_tax_rate])).toEqual([
			['FACTURA', 21],
			['FACTURA_EXPORTACION', 0],
		]);
	});

	it('compañía de otro holding → 404', async () => {
		await expect(service([]).get(HOLDING, COMPANY)).rejects.toThrow('Compañía no encontrada');
	});
});

describe('Comunicaciones (§8.2)', () => {
	const build = (handlers: Handler[], emails: Partial<Record<keyof EmailsService, jest.Mock>> = {}, apiKey: string | undefined = 'SG.key') => {
		const db = fakeDb(handlers);
		const mocks = { verifyDomain: jest.fn(), deleteDomain: jest.fn(), send: jest.fn(), ...emails };
		const service = new SettingsCommunicationsService(
			db as unknown as DataSource,
			mocks as unknown as EmailsService,
			{ get: () => apiKey } as unknown as ConfigService
		);

		return { db, service, emails: mocks };
	};
	const domainRow = (extra: Record<string, unknown> = {}) => ({
		id: DOMAIN,
		holding_id: HOLDING,
		sender_domain: 'mail.empresa.com',
		domain_status: 'verified',
		is_default: true,
		is_active: true,
		resend_domain_id: '123',
		domain_dns_records: [
			{ type: 'CNAME', name: 'em.mail.empresa.com', value: 'u1.wl.sendgrid.net', status: 'pending' },
			{ type: 'CNAME', name: 's1._domainkey', value: 's1', status: 'pending' },
			{ type: 'CNAME', name: 's2._domainkey', value: 's2', status: 'pending' },
		],
		...extra,
	});
	const senderRow = (extra: Record<string, unknown> = {}) => ({
		id: SENDER,
		domain_config_id: DOMAIN,
		from_name: 'Cobranza',
		from_email: 'cobranza@empresa.com',
		is_default: true,
		is_active: true,
		in_use: '0',
		sender_domain: 'mail.empresa.com',
		...extra,
	});

	it('el correo del remitente debe ser del dominio o de su dominio base', () => {
		expect(emailBelongsToDomain('a@mail.empresa.com', 'mail.empresa.com')).toBe(true);
		expect(emailBelongsToDomain('a@empresa.com', 'mail.empresa.com')).toBe(true);
		expect(emailBelongsToDomain('a@otra.com', 'mail.empresa.com')).toBe(false);
	});

	it('toda lectura y escritura filtra por el holding del header (id de otro holding → 404)', async () => {
		const { db, service } = build([]);

		await expect(service.updateDomain(HOLDING, DOMAIN, { display_name: 'x' })).rejects.toThrow('Dominio no encontrado');
		await expect(service.deleteSender(HOLDING, SENDER)).rejects.toThrow('Remitente no encontrado');
		expect(db.calls.every((call) => call.params.includes(HOLDING))).toBe(true);
	});

	it('alta: dominio repetido → 409; correo de otro dominio → 400; sin SendGrid → 400; el primero queda por defecto', async () => {
		const dto = { sender_domain: 'mail.empresa.com', from_name: 'Sapira', from_email: 'hola@empresa.com' };

		await expect(build([], {}, '').service.createDomain(HOLDING, dto, 'auth')).rejects.toThrow('El servicio de correo no está configurado');
		await expect(build([]).service.createDomain(HOLDING, { ...dto, from_email: 'x@otra.com' }, 'auth')).rejects.toThrow(
			'El correo del remitente debe ser del dominio mail.empresa.com'
		);
		await expect(build([['lower(sender_domain) = $2', () => [{ '?column?': 1 }]]]).service.createDomain(HOLDING, dto, 'auth')).rejects.toThrow(
			'Ese dominio ya está registrado en el holding'
		);
		const { db, service, emails } = build([['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow()]]], {
			verifyDomain: jest.fn(async () => ({ id: DOMAIN })),
		});

		await service.createDomain(HOLDING, dto, 'auth');
		expect(emails.verifyDomain).toHaveBeenCalledWith(expect.objectContaining({ holding_id: HOLDING, is_default: false }), 'auth');
		expect(db.statements('SET is_default = (id = $2)')).toHaveLength(1);
	});

	it('no desactiva el dominio por defecto; no borra un remitente en uso', async () => {
		await expect(
			build([['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow()]]]).service.updateDomain(HOLDING, DOMAIN, {
				is_active: false,
			})
		).rejects.toThrow('Marca otro dominio por defecto antes de desactivar este');
		await expect(
			build([
				['WHERE s.id = $1 AND d.holding_id = $2', () => [senderRow({ in_use: '2' })]],
				['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow()]],
			]).service.deleteSender(HOLDING, SENDER)
		).rejects.toThrow('Este remitente lo usan 2 agentes de clientes: cámbialo antes de eliminarlo');
	});

	it('verificar: guarda el estado por registro que responde SendGrid', async () => {
		const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				valid: false,
				validation_results: { mail_cname: { valid: true }, dkim1: { valid: false, reason: 'no' }, dkim2: { valid: true } },
			}),
		} as unknown as Response);
		const { db, service } = build([['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow()]]]);
		const result = await service.verifyDomain(HOLDING, DOMAIN);

		expect(fetchMock.mock.calls[0][0]).toBe('https://api.sendgrid.com/v3/whitelabel/domains/123/validate');
		expect(result.status).toBe('pending');
		expect(result.results).toEqual([
			{ record: 'mail_cname', valid: true, reason: null },
			{ record: 'dkim1', valid: false, reason: 'no' },
			{ record: 'dkim2', valid: true, reason: null },
		]);
		const saved = db.statements('UPDATE holding_email_sender_settings SET domain_status')[0];

		expect(JSON.parse(String(saved.params[3])).map((record: { status: string }) => record.status)).toEqual(['verified', 'pending', 'verified']);
		fetchMock.mockRestore();
	});

	it('correo de prueba: solo a tu correo o a un miembro del holding; dominio verificado; usa el remitente', async () => {
		await expect(build([]).service.sendTestEmail(HOLDING, { to: 'extra@fuera.com' }, 'auth')).rejects.toThrow(
			'Solo puedes enviar la prueba a tu correo o al de un miembro del holding'
		);
		const handlers: Handler[] = [
			['FROM users u WHERE u.auth_id = $2', () => [{ '?column?': 1 }]],
			['WHERE d.holding_id = $1 AND d.is_default AND d.is_active AND s.is_default', () => [senderRow()]],
		];

		await expect(
			build([
				...handlers,
				['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow({ domain_status: 'pending' })]],
			]).service.sendTestEmail(HOLDING, { to: 'ana@empresa.com' }, 'auth')
		).rejects.toThrow('El dominio aún no está verificado');
		const { service, emails } = build([...handlers, ['WHERE holding_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid)', () => [domainRow()]]]);

		await expect(service.sendTestEmail(HOLDING, { to: 'ana@empresa.com' }, 'auth')).resolves.toMatchObject({
			to: 'ana@empresa.com',
			from: 'cobranza@empresa.com',
		});
		expect(emails.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ana@empresa.com', from: 'cobranza@empresa.com' }));
	});
});

describe('Tipos de cambio sincronizados · detalle (§8.3)', () => {
	const build = (handlers: Handler[]) =>
		new SettingsHoldingService(
			fakeDb([
				['FROM currencies WHERE code = $1', (params) => [{ code: params[0] }]],
				['SELECT DISTINCT upper(code) AS code', () => [{ code: 'CLP' }, { code: 'USD' }, { code: 'PEN' }]],
				['FROM holding_settings WHERE holding_id', () => [{ system_currency: 'USD', fx_system_policy: 'monthly_avg' }]],
				...handlers,
			]) as unknown as DataSource,
			{} as never
		);

	it('valida moneda en uso, distinta de la de consolidación, fechas y rango', async () => {
		await expect(build([]).fxSyncHistory(HOLDING, { currency: 'USD' })).rejects.toThrow('USD es la moneda de consolidación');
		await expect(build([]).fxSyncHistory(HOLDING, { currency: 'EUR' })).rejects.toThrow('La moneda EUR no está en uso en el holding');
		await expect(build([]).fxSyncHistory(HOLDING, { currency: 'CLP', from: '2026-10-02', to: '2026-10-01' })).rejects.toThrow(
			'La fecha de inicio debe ser anterior o igual a la de fin'
		);
		await expect(build([]).fxSyncHistory(HOLDING, { currency: 'CLP', from: '2023-01-01', to: '2026-10-01' })).rejects.toThrow(
			'El rango no puede superar 2 años'
		);
	});

	it('historial: inversa (1/tasa) cuando solo hay USD→CLP, con la fuente', async () => {
		const result = await build([
			[
				'FROM exchange_rates',
				() => [
					{
						rate_date: '2026-10-01',
						from_currency: 'USD',
						to_currency: 'CLP',
						rate: '1000',
						source_type: 'BANCOCENTRAL',
						api_source: 'Banco Central de Chile',
					},
				],
			],
		]).fxSyncHistory(HOLDING, { currency: 'clp', from: '2026-10-01', to: '2026-10-02' });

		expect(result).toMatchObject({ currency: 'CLP', to_currency: 'USD' });
		expect(result.points).toEqual([
			{ date: '2026-10-01', rate: 0.001, source_type: 'BANCOCENTRAL', source_label: 'Banco Central de Chile', method: 'inverse' },
		]);
	});

	it('mensual: promedio del par, inverso con mín./máx. cruzados y 12 meses siempre', async () => {
		const result = await build([
			[
				'FROM exchange_rates_monthly_avg',
				() => [
					{
						from_currency: 'CLP',
						to_currency: 'USD',
						month: 1,
						avg_rate: '0.001',
						min_rate: '0.0009',
						max_rate: '0.0011',
						data_points: 20,
					},
					{ from_currency: 'USD', to_currency: 'CLP', month: 2, avg_rate: '1000', min_rate: '800', max_rate: '1250', data_points: 19 },
				],
			],
		]).fxSyncMonthly(HOLDING, { currency: 'CLP', year: 2026 });

		expect(result.months).toHaveLength(12);
		expect(result.months[0]).toMatchObject({ month: 1, avg_rate: 0.001, source: 'monthly_avg' });
		expect(result.months[1]).toMatchObject({ month: 2, avg_rate: 0.001, min_rate: 0.0008, max_rate: 0.00125, source: 'monthly_avg_inverse' });
		expect(result.months[2]).toMatchObject({ month: 3, avg_rate: null, source: null });
	});
});

describe('Tipos de negocio y de contacto (§8.4)', () => {
	it('los 7 tipos con efecto en MRR y los tipos de Salesforce mapeados del holding', async () => {
		const db = fakeDb([
			[
				'FROM salesforce_quote_type_mappings',
				() => [
					{ salesforce_type: 'New Business', sapira_quote_type: 'NewBusiness' },
					{ salesforce_type: 'Upsell SF', sapira_quote_type: 'Upselling' },
				],
			],
		]);
		const types = await new SettingsCatalogsService(db as unknown as DataSource).listBusinessTypes(HOLDING);

		expect(types.map((type) => type.code)).toEqual([
			'new_business',
			'upsell',
			'cross_sell',
			'downsell',
			'renewal',
			'renegotiation',
			'reactivation',
		]);
		expect(types[0]).toMatchObject({ label: 'Nuevo negocio', mrr_effect: 'new', salesforce_types: ['New Business'] });
		expect(types[1].salesforce_types).toEqual(['Upsell SF']);
		expect(db.calls[0].params).toEqual([HOLDING]);
	});

	it('tipos de contacto fijos con su uso en el holding', async () => {
		const db = fakeDb([['FROM client_contacts', () => [{ value: 'Facturación', n: '3' }]]]);
		const types = await new SettingsCatalogsService(db as unknown as DataSource).listContactTypes(HOLDING);

		expect(types.map((type) => type.value)).toEqual(['Principal', 'Comercial', 'Facturación', 'Cobranza', 'Proforma']);
		expect(types[2]).toMatchObject({ in_use: 3, used_by: ['Cobranza (recordatorios)'] });
	});
});

describe('Campos personalizados con más tipos (§8.7)', () => {
	const options = [
		{ value: 'enterprise', label: 'Enterprise' },
		{ value: 'smb', label: 'SMB' },
	];

	it('opciones obligatorias en select, prohibidas en el resto, sin repetir', () => {
		expect(() => cleanFieldOptions('select', null)).toThrow('Las opciones son obligatorias para un campo de lista');
		expect(() => cleanFieldOptions('date', options)).toThrow('Solo los campos de lista tienen opciones');
		expect(() => cleanFieldOptions('select', [...options, { value: 'SMB ', label: 'Otra' }])).toThrow('Opción repetida: Otra');
		expect(cleanFieldOptions('boolean', undefined)).toBeNull();
		expect(cleanFieldOptions('select', options)).toEqual(options);
	});

	it('crear un select guarda las opciones; la lista trae option_usage', async () => {
		const row = {
			id: 'f-1',
			entity_type: 'client',
			field_name: 'tamano',
			field_label: 'Tamaño',
			field_type: 'select',
			options,
			display_order: 0,
		};
		const db = fakeDb([
			['INSERT INTO custom_field_definitions', () => [row]],
			['custom_fields ->> $2 = ANY($3::text[])', () => [{ value: 'smb', n: '4' }]],
		]);
		const created = await new SettingsCustomFieldsService(db as unknown as DataSource).create(
			HOLDING,
			{ entity_type: 'client', field_name: 'tamano', field_label: 'Tamaño', field_type: 'select', options },
			null
		);

		expect(db.statements('INSERT INTO custom_field_definitions')[0].params[8]).toBe(JSON.stringify(options));
		expect(created).toMatchObject({ options, option_usage: { enterprise: 0, smb: 4 } });
	});

	it('quitar una opción en uso → 409; cambiar su etiqueta sí', async () => {
		const row = {
			id: 'f-1',
			entity_type: 'client',
			field_name: 'tamano',
			field_label: 'Tamaño',
			field_type: 'select',
			options,
			display_order: 0,
		};
		const handlers: Handler[] = [
			['SELECT * FROM custom_field_definitions WHERE id = $1', () => [row]],
			['custom_fields ->> $2 = ANY($3::text[])', () => [{ value: 'smb', n: '4' }]],
			['UPDATE custom_field_definitions', () => [row]],
		];

		await expect(
			new SettingsCustomFieldsService(fakeDb(handlers) as unknown as DataSource).update(HOLDING, 'f-1', { options: [options[0]] })
		).rejects.toThrow('La opción "SMB" está en 4 registros: no se puede quitar');
		await expect(
			new SettingsCustomFieldsService(fakeDb(handlers) as unknown as DataSource).update(HOLDING, 'f-1', {
				options: [options[0], { value: 'smb', label: 'Pyme' }],
			})
		).resolves.toBeDefined();
	});
});
