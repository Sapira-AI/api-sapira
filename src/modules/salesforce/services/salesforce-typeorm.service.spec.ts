import { SalesforceTypeOrmService } from './salesforce-typeorm.service';

describe('SalesforceTypeOrmService', () => {
	const buildService = () => {
		const quoteRepository = {
			save: jest.fn(),
		};
		const quoteItemRepository = {
			find: jest.fn(),
			save: jest.fn(),
			delete: jest.fn(),
			query: jest.fn(),
		};
		const clientEntityRepository = {
			find: jest.fn(),
			createQueryBuilder: jest.fn(),
		};
		const clientEntityClientRepository = {
			find: jest.fn(),
		};

		const service = new SalesforceTypeOrmService(
			{} as any,
			{} as any,
			{} as any,
			quoteRepository as any,
			quoteItemRepository as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			clientEntityRepository as any,
			clientEntityClientRepository as any,
			{} as any
		);

		return {
			service,
			quoteRepository,
			quoteItemRepository,
			clientEntityRepository,
			clientEntityClientRepository,
		};
	};

	it('omite un conflicto único al crear una cotización insert-only', async () => {
		const { service, quoteRepository } = buildService();
		quoteRepository.save.mockRejectedValue({ code: '23505', message: 'duplicate key' });

		await expect(service.createQuoteIfAbsent({ holding_id: 'holding-1', salesforce_opportunity_id: 'opp-1' })).resolves.toBeNull();
	});

	it('actualiza items existentes, crea nuevos y elimina sobrantes no vinculados', async () => {
		const { service, quoteItemRepository } = buildService();
		quoteItemRepository.find.mockResolvedValue([
			{
				id: 'qi-1',
				quote_id: 'quote-1',
				quote_item_number: 'li-1',
				product_name: 'Anterior',
			},
			{
				id: 'qi-2',
				quote_id: 'quote-1',
				quote_item_number: 'li-obsolete',
				product_name: 'Obsoleto',
			},
		]);
		quoteItemRepository.query.mockResolvedValue([]);

		await service.createQuoteItems([
			{
				quote_id: 'quote-1',
				quote_item_number: 'li-1',
				salesforce_line_item_id: 'li-1',
				product_name: 'Actualizado',
			},
			{
				quote_id: 'quote-1',
				quote_item_number: 'li-2',
				salesforce_line_item_id: 'li-2',
				product_name: 'Nuevo',
			},
		]);

		expect(quoteItemRepository.save).toHaveBeenCalledWith([
			expect.objectContaining({
				id: 'qi-1',
				quote_item_number: 'li-1',
				product_name: 'Actualizado',
			}),
			expect.objectContaining({
				quote_item_number: 'li-2',
				product_name: 'Nuevo',
			}),
		]);
		expect(quoteItemRepository.delete).toHaveBeenCalledWith(['qi-2']);
	});

	it('falla cuando intenta eliminar items vinculados a contract_items', async () => {
		const { service, quoteItemRepository } = buildService();
		quoteItemRepository.find.mockResolvedValue([
			{
				id: 'qi-linked',
				quote_id: 'quote-1',
				quote_item_number: 'li-linked',
				product_name: 'Vinculado',
			},
		]);
		quoteItemRepository.query.mockResolvedValue([
			{
				id: 'qi-linked',
				quote_item_number: 'li-linked',
			},
		]);

		await expect(
			service.createQuoteItems([
				{
					quote_id: 'quote-1',
					quote_item_number: 'li-other',
					salesforce_line_item_id: 'li-other',
					product_name: 'Nuevo',
				},
			])
		).rejects.toThrow('No se pueden eliminar quote_items vinculados a contract_items');

		expect(quoteItemRepository.delete).not.toHaveBeenCalled();
	});

	it('devuelve todas las entidades que comparten un tax_id', async () => {
		const { service, clientEntityRepository } = buildService();
		clientEntityRepository.find.mockResolvedValue([
			{ id: 'entity-1', client_id: 'client-other', legal_name: 'Entidad 1' },
			{ id: 'entity-2', client_id: 'client-2', legal_name: 'Entidad 2' },
		]);

		const result = await service.resolveClientEntitiesByTaxId('holding-1', '5555555-5');

		expect(result).toEqual({
			entities: [
				{ id: 'entity-1', client_id: 'client-other', legal_name: 'Entidad 1' },
				{ id: 'entity-2', client_id: 'client-2', legal_name: 'Entidad 2' },
			],
		});
	});

	it('devuelve una lista vacía cuando no hay coincidencias de tax_id', async () => {
		const { service, clientEntityRepository } = buildService();
		clientEntityRepository.find.mockResolvedValue([
			
		]);

		const result = await service.resolveClientEntitiesByTaxId('holding-1', '76517784-7');

		expect(result).toEqual({ entities: [] });
	});

	it('lista únicamente grupos duplicados del holding y excluye VATs genéricos activos', async () => {
		const { service, clientEntityRepository } = buildService();
		const countQueryBuilder = {
			select: jest.fn().mockReturnThis(),
			getRawMany: jest.fn().mockResolvedValue([{ taxId: '76517784-7' }]),
		};
		const itemsQueryBuilder = {
			select: jest.fn().mockReturnThis(),
			addSelect: jest.fn().mockReturnThis(),
			orderBy: jest.fn().mockReturnThis(),
			offset: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			getRawMany: jest.fn().mockResolvedValue([
				{
					taxId: '76517784-7',
					count: '2',
					entities: JSON.stringify([
						{ id: 'entity-1', legalName: 'Empresa Uno', clientId: 'client-1', country: 'CL' },
						{ id: 'entity-2', legalName: 'Empresa Dos', clientId: null, country: 'CL' },
					]),
				},
			]),
		};
		const duplicateGroupsQueryBuilder = {
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			groupBy: jest.fn().mockReturnThis(),
			having: jest.fn().mockReturnThis(),
			clone: jest.fn().mockReturnValueOnce(countQueryBuilder).mockReturnValueOnce(itemsQueryBuilder),
		};
		clientEntityRepository.createQueryBuilder.mockReturnValue(duplicateGroupsQueryBuilder);

		await expect(service.getDuplicateClientEntitiesTaxIds('holding-1', { page: 2, limit: 10 })).resolves.toEqual({
			items: [
				{
					taxId: '76517784-7',
					count: 2,
					entities: [
						{ id: 'entity-1', legalName: 'Empresa Uno', clientId: 'client-1', country: 'CL' },
						{ id: 'entity-2', legalName: 'Empresa Dos', clientId: null, country: 'CL' },
					],
				},
			],
			total: 1,
			page: 2,
			limit: 10,
			totalPages: 1,
		});
		expect(duplicateGroupsQueryBuilder.where).toHaveBeenCalledWith('entity.holding_id = :holdingId', { holdingId: 'holding-1' });
		expect(duplicateGroupsQueryBuilder.andWhere).toHaveBeenCalledWith(expect.stringContaining('generic_export_vats generic_vat'));
		expect(duplicateGroupsQueryBuilder.having).toHaveBeenCalledWith('COUNT(*) > 1');
		expect(itemsQueryBuilder.offset).toHaveBeenCalledWith(10);
		expect(itemsQueryBuilder.limit).toHaveBeenCalledWith(10);
	});
});
