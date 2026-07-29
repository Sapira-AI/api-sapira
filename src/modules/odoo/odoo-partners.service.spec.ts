import { OdooPartnersService } from './odoo-partners.service';

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

		return { service, genericVatsService, objectClient, clientEntitiesRepository, clientEntityUpdateQuery };
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

		expect(clientEntitiesRepository.update).toHaveBeenCalledWith(
			{ id: 'entity-1', holding_id: 'holding-1' },
			{ odoo_partner_id: 125 }
		);
		expect(result.status).toBe('found');
		expect(result.odooPartnerId).toBe(125);
		expect(result.partnerData).toEqual({
			legal_name: 'Acme SpA',
			legal_address: 'Av. Principal 123, Santiago',
			email: 'contacto@acme.cl',
			phone: '+56 2 1234 5678',
		});
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
		expect(clientEntitiesRepository.update).toHaveBeenCalledWith(
			{ id: 'entity-1', holding_id: 'holding-1' },
			{ odoo_partner_id: 126 }
		);
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
		objectClient.methodCall.mockResolvedValue([
			{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true },
		]);

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
		objectClient.methodCall.mockResolvedValue([
			{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true },
		]);

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
		objectClient.methodCall.mockResolvedValue([
			{ id: 125, name: 'Acme SpA', display_name: 'Acme SpA', vat: '76517784-7', active: true },
		]);

		const result = await service.resolveMissingPartners('holding-1', { dryRun: false, sampleSize: 20 });

		expect(result).toMatchObject({ evaluated: 1, wouldUpdate: 0, updated: 0, unchanged: 1 });
		expect(result.examples[0]).toMatchObject({ status: 'unchanged', odooPartnerId: 125 });
		expect(clientEntityUpdateQuery.execute).not.toHaveBeenCalled();
	});
});
