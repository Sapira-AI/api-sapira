import { OdooConnectionError, OdooPartnersService } from './odoo-partners.service';

describe('OdooPartnersService', () => {
	const buildService = () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = { methodCall: jest.fn() };
		const odooProvider = {
			createXmlRpcClient: jest.fn().mockReturnValueOnce(commonClient).mockReturnValueOnce(objectClient),
		};
		const genericVatsService = {
			isGenericExportVat: jest.fn().mockResolvedValue(false),
		};
		const connectionRepository = {
			findOne: jest.fn().mockResolvedValue({
				id: 'connection-1',
				url: 'https://odoo.example.com',
				database_name: 'odoo',
				username: 'api-user',
				api_key: 'api-key',
				holding_id: 'holding-1',
			}),
		};
		const clientEntityUpdateQuery = {
			update: jest.fn().mockReturnThis(),
			set: jest.fn().mockReturnThis(),
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			execute: jest.fn().mockResolvedValue({ affected: 1 }),
		};
		const clientEntitiesRepository = {
			find: jest.fn(),
			findOne: jest.fn(),
			update: jest.fn(),
			createQueryBuilder: jest.fn(() => clientEntityUpdateQuery),
		};

		const service = new OdooPartnersService(
			odooProvider as any,
			{} as any,
			{} as any,
			genericVatsService as any,
			connectionRepository as any,
			{} as any,
			clientEntitiesRepository as any,
			{} as any
		);

		return { service, genericVatsService, objectClient, clientEntitiesRepository, clientEntityUpdateQuery, connectionRepository };
	};

	it('asocia un partner único encontrado por VAT normalizado', async () => {
		const { service, objectClient, clientEntitiesRepository } = buildService();
		objectClient.methodCall.mockResolvedValue([
			{
				id: 125,
				name: 'Acme SpA',
				display_name: 'Acme SpA',
				vat: '76517784-7',
				active: true,
				email: 'contacto@acme.cl',
				phone: '+56 2 1234 5678',
				contact_address_complete: 'Av. Principal 123, Santiago',
			},
		]);

		const result = await service.resolveAndLinkPartnerForEntity('holding-1', {
			id: 'entity-1',
			tax_id: '76.517.784-7',
			legal_name: 'Acme SpA',
			odoo_partner_id: null,
		});

		expect(clientEntitiesRepository.update).toHaveBeenCalledWith({ id: 'entity-1', holding_id: 'holding-1' }, { odoo_partner_id: 125 });
		expect(result.status).toBe('found');
		expect(result.odooPartnerId).toBe(125);
		expect(result.partnerData).toEqual({
			legal_name: 'Acme SpA',
			legal_address: 'Av. Principal 123, Santiago',
			email: 'contacto@acme.cl',
			phone: '+56 2 1234 5678',
		});
	});

	it('busca el vat con sus variantes de formato y no se ahoga con un vat numérico sin cero inicial (caso Ransa SV)', async () => {
		const { service, objectClient, clientEntitiesRepository } = buildService();
		// `parseTagValue: true` devuelve el NIT 06142406041060 como número sin el cero inicial.
		objectClient.methodCall.mockResolvedValue([{ id: 16415, name: 'Ransa SV', display_name: 'Ransa SV', vat: 6142406041060, active: true }]);

		const result = await service.resolveAndLinkPartnerForEntity('holding-1', {
			id: 'entity-1',
			tax_id: '06142406041060',
			legal_name: 'Ransa SV',
			odoo_partner_id: null,
		});

		expect(result).toMatchObject({ status: 'found', odooPartnerId: 16415 });
		expect(clientEntitiesRepository.update).toHaveBeenCalledWith({ id: 'entity-1', holding_id: 'holding-1' }, { odoo_partner_id: 16415 });
		const domain = objectClient.methodCall.mock.calls[0][1][5][0];

		expect(domain[0][0]).toBe('vat');
		expect(domain[0][1]).toBe('in');
		expect(domain[0][2]).toEqual(expect.arrayContaining(['06142406041060']));
	});

	it('un RUT con puntos en Odoo y los contactos hijos de la empresa ya no lo vuelven ambiguo', async () => {
		const { service, objectClient } = buildService();
		objectClient.methodCall.mockResolvedValue([
			{ id: 200, name: 'Tompetrol SpA', display_name: 'Tompetrol SpA', vat: '76.397.190-2', active: true, parent_id: false },
			{
				id: 201,
				name: 'Juan Pérez',
				display_name: 'Tompetrol SpA, Juan Pérez',
				vat: '76.397.190-2',
				active: true,
				parent_id: [200, 'Tompetrol SpA'],
			},
		]);

		const result = await service.resolveAndLinkPartnerForEntity('holding-1', {
			id: 'entity-1',
			tax_id: '76397190-2',
			legal_name: 'Tompetrol SpA',
			odoo_partner_id: null,
		});

		expect(result).toMatchObject({ status: 'found', odooPartnerId: 200 });
		expect(objectClient.methodCall.mock.calls[0][1][5][0][0][2]).toEqual(expect.arrayContaining(['76397190-2', '76.397.190-2']));
	});

	it('findPartnerCandidates: por vat y por nombre, sin repetir y con el motivo; no escribe', async () => {
		const { service, objectClient, clientEntitiesRepository } = buildService();
		objectClient.methodCall
			.mockResolvedValueOnce([
				{ id: 10, name: 'Acme SpA', vat: '76517784-7', active: true, country_id: [46, 'Chile'], is_company: true, parent_id: false },
			])
			.mockResolvedValueOnce([
				{ id: 10, name: 'Acme SpA', vat: '76517784-7', active: true, parent_id: false },
				{ id: 11, name: 'Acme Perú SAC', vat: '20601234567', active: true, country_id: [173, 'Perú'], parent_id: false },
			]);

		const candidates = await service.findPartnerCandidates('holding-1', { taxId: '76.517.784-7', name: 'Acme' });

		expect(candidates).toEqual([
			expect.objectContaining({ odoo_partner_id: 10, match: 'tax_id', country: 'Chile', is_company: true }),
			expect.objectContaining({ odoo_partner_id: 11, match: 'name', country: 'Perú' }),
		]);
		expect(objectClient.methodCall.mock.calls[1][1][5][0]).toEqual([
			['name', 'ilike', 'Acme'],
			['parent_id', '=', false],
			['active', '=', true],
		]);
		expect(clientEntitiesRepository.update).not.toHaveBeenCalled();
	});

	it('findPartnerCandidates: cada candidato trae correo y dirección (para prellenar "Traer desde ERP")', async () => {
		const { service, objectClient } = buildService();
		objectClient.methodCall.mockResolvedValueOnce([
			{
				id: 10,
				name: 'Acme SpA',
				vat: '76517784-7',
				active: true,
				email: 'pagos@acme.cl',
				street: 'Av. 1',
				city: 'Santiago',
				country_id: [46, 'Chile'],
			},
			{ id: 12, name: 'Acme Norte', vat: '76517784-7', active: true, email: false, contact_address_complete: false },
		]);

		const candidates = await service.findPartnerCandidates('holding-1', { taxId: '76.517.784-7' });

		expect(candidates[0]).toMatchObject({ email: 'pagos@acme.cl', address: 'Av. 1, Santiago, Chile' });
		expect(candidates[1]).toMatchObject({ email: null, address: null });
	});

	it('connectionStatus: solo lee la conexión activa (no autentica contra el ERP)', async () => {
		const { service, connectionRepository } = buildService();
		connectionRepository.findOne.mockResolvedValueOnce({ id: 'connection-1', name: ' Odoo producción ' }).mockResolvedValueOnce(null);

		expect(await service.connectionStatus('holding-1')).toEqual({ connected: true, name: 'Odoo producción' });
		expect(await service.connectionStatus('holding-1')).toEqual({ connected: false, name: null });
		expect(connectionRepository.findOne).toHaveBeenCalledWith({ where: { holding_id: 'holding-1', is_active: true } });
	});

	it('sin conexión activa lanza OdooConnectionError (no un Error genérico)', async () => {
		const { service, connectionRepository } = buildService();
		connectionRepository.findOne.mockResolvedValue(null);

		await expect(service.findPartnerCandidates('holding-1', { taxId: '1-9' })).rejects.toBeInstanceOf(OdooConnectionError);
	});

	it('devuelve datos actuales de Odoo para un partner ya asociado cuando se solicitan', async () => {
		const { service, objectClient } = buildService();
		objectClient.methodCall.mockResolvedValue([
			{
				id: 125,
				name: 'Acme Odoo SpA',
				display_name: 'Acme Odoo SpA',
				vat: '76517784-7',
				active: true,
				email: 'odoo@acme.cl',
				phone: null,
				mobile: '+56 9 8765 4321',
				street: 'Calle Odoo 10',
				city: 'Santiago',
			},
		]);

		const result = await service.resolveAndLinkPartnerForEntity(
			'holding-1',
			{ id: 'entity-1', tax_id: '76517784-7', legal_name: 'Acme SpA', odoo_partner_id: 125 },
			true
		);

		expect(result).toMatchObject({
			status: 'already_linked',
			odooPartnerId: 125,
			partnerData: {
				legal_name: 'Acme Odoo SpA',
				legal_address: 'Calle Odoo 10, Santiago',
				email: 'odoo@acme.cl',
				phone: '+56 9 8765 4321',
			},
		});
	});

	it('usa razón social para desambiguar un VAT genérico', async () => {
		const { service, genericVatsService, objectClient, clientEntitiesRepository } = buildService();
		genericVatsService.isGenericExportVat.mockResolvedValue(true);
		objectClient.methodCall.mockResolvedValue([
			{ id: 125, name: 'Empresa Uno SpA', display_name: 'Empresa Uno SpA', vat: '5555555-5', active: true },
			{ id: 126, name: 'Empresa Dos SpA', display_name: 'Empresa Dos SpA', vat: '5555555-5', active: true },
		]);

		const result = await service.resolveAndLinkPartnerForEntity('holding-1', {
			id: 'entity-1',
			tax_id: '5555555-5',
			legal_name: 'Empresa Dos SpA',
			odoo_partner_id: null,
		});

		expect(result).toMatchObject({ status: 'found', odooPartnerId: 126 });
		expect(clientEntitiesRepository.update).toHaveBeenCalledWith({ id: 'entity-1', holding_id: 'holding-1' }, { odoo_partner_id: 126 });
	});

	it('no asocia un VAT genérico si la razón social no entrega una coincidencia única', async () => {
		const { service, genericVatsService, objectClient, clientEntitiesRepository } = buildService();
		genericVatsService.isGenericExportVat.mockResolvedValue(true);
		objectClient.methodCall.mockResolvedValue([
			{ id: 125, name: 'Empresa SpA', display_name: 'Empresa SpA', vat: '5555555-5', active: true },
			{ id: 126, name: 'Empresa SpA', display_name: 'Empresa SpA', vat: '5555555-5', active: true },
		]);

		const result = await service.resolveAndLinkPartnerForEntity('holding-1', {
			id: 'entity-1',
			tax_id: '5555555-5',
			legal_name: 'Empresa SpA',
			odoo_partner_id: null,
		});

		expect(result.status).toBe('ambiguous');
		expect(clientEntitiesRepository.update).not.toHaveBeenCalled();
	});

	it('simula partners faltantes sin modificar los IDs ya asignados', async () => {
		const { service, objectClient, clientEntitiesRepository } = buildService();
		clientEntitiesRepository.find.mockResolvedValue([
			{ id: 'entity-missing', tax_id: '76.517.784-7', legal_name: 'Acme SpA', odoo_partner_id: null },
		]);
		objectClient.methodCall.mockResolvedValue([{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true }]);

		const result = await service.resolveMissingPartners('holding-1', { dryRun: true, sampleSize: 20 });

		expect(result).toMatchObject({ dryRun: true, evaluated: 1, wouldUpdate: 1, updated: 0 });
		expect(result.examples[0]).toMatchObject({ clientEntityId: 'entity-missing', status: 'would_create', odooPartnerId: 125 });
		expect(clientEntitiesRepository.update).not.toHaveBeenCalled();
	});

	it('asocia o actualiza solo entidades cuyo partner Odoo difiere', async () => {
		const { service, objectClient, clientEntitiesRepository, clientEntityUpdateQuery } = buildService();
		clientEntitiesRepository.find.mockResolvedValue([
			{ id: 'entity-missing', tax_id: '76.517.784-7', legal_name: 'Acme SpA', odoo_partner_id: null },
		]);
		objectClient.methodCall.mockResolvedValue([{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true }]);

		const result = await service.resolveMissingPartners('holding-1', { dryRun: false, sampleSize: 20 });

		expect(result).toMatchObject({ dryRun: false, evaluated: 1, wouldUpdate: 1, updated: 1 });
		expect(clientEntityUpdateQuery.set).toHaveBeenCalledWith({ odoo_partner_id: 125 });
		expect(clientEntityUpdateQuery.andWhere).toHaveBeenCalledWith('odoo_partner_id IS DISTINCT FROM :partnerId', { partnerId: 125 });
	});

	it('no escribe cuando el partner Odoo ya coincide', async () => {
		const { service, objectClient, clientEntitiesRepository, clientEntityUpdateQuery } = buildService();
		clientEntitiesRepository.find.mockResolvedValue([
			{ id: 'entity-linked', tax_id: '76.517.784-7', legal_name: 'Acme SpA', odoo_partner_id: 125 },
		]);
		objectClient.methodCall.mockResolvedValue([{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true }]);

		const result = await service.resolveMissingPartners('holding-1', { dryRun: false, sampleSize: 20 });

		expect(result).toMatchObject({ evaluated: 1, wouldUpdate: 0, updated: 0, unchanged: 1 });
		expect(result.examples[0]).toMatchObject({ status: 'unchanged', odooPartnerId: 125 });
		expect(clientEntityUpdateQuery.execute).not.toHaveBeenCalled();
	});
});
