import { BadRequestException } from '@nestjs/common';

import { BigQueryController } from './bigquery.controller';

describe('BigQueryController', () => {
	const buildController = () => {
		const bigQueryService = {
			getProjectInfo: jest.fn(),
			executeQuery: jest.fn(),
			getDatasets: jest.fn(),
			getTables: jest.fn(),
			ingestSapiraQuantities: jest.fn(),
			integrateSapiraQuantities: jest.fn(),
			syncSapiraQuantities: jest.fn(),
			listQuantityImports: jest.fn(),
			replaceQuantityRecord: jest.fn(),
		};

		const controller = new BigQueryController(bigQueryService as any);

		return { controller, bigQueryService };
	};

	it('propaga x-holding-id al servicio en getProjectInfo', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.getProjectInfo('holding-1');

		expect(bigQueryService.getProjectInfo).toHaveBeenCalledWith('holding-1');
	});

	it('propaga x-holding-id al servicio en executeQuery', async () => {
		const { controller, bigQueryService } = buildController();
		const dto = { query: 'SELECT 1', params: {} };

		await controller.executeQuery(dto, 'holding-1');

		expect(bigQueryService.executeQuery).toHaveBeenCalledWith('holding-1', dto);
	});

	it('propaga x-holding-id al servicio en getDatasets', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.getDatasets('holding-1');

		expect(bigQueryService.getDatasets).toHaveBeenCalledWith('holding-1');
	});

	it('propaga x-holding-id al servicio en getTables', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.getTables('finance', 'holding-1');

		expect(bigQueryService.getTables).toHaveBeenCalledWith('holding-1', 'finance');
	});

	it('lanza BadRequestException cuando falta x-holding-id', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.executeQuery({ query: 'SELECT 1' }, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.executeQuery).not.toHaveBeenCalled();
	});

	it('propaga x-holding-id y el rango al servicio en ingestQuantities', async () => {
		const { controller, bigQueryService } = buildController();
		const dto = { from: '2026-07-01', to: '2026-07-31' };

		await controller.ingestQuantities(dto, 'holding-1');

		expect(bigQueryService.ingestSapiraQuantities).toHaveBeenCalledWith('holding-1', dto);
	});

	it('la fase 1 no dispara la fase 2', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.ingestQuantities({}, 'holding-1');

		expect(bigQueryService.integrateSapiraQuantities).not.toHaveBeenCalled();
	});

	it('lanza BadRequestException cuando falta x-holding-id en ingestQuantities', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.ingestQuantities({}, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.ingestSapiraQuantities).not.toHaveBeenCalled();
	});

	it('propaga rango y retryFailed al servicio en integrateQuantities', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.integrateQuantities({ from: '2026-07-01', to: '2026-07-31', retryFailed: true }, 'holding-1');

		expect(bigQueryService.integrateSapiraQuantities).toHaveBeenCalledWith('holding-1', {
			retryFailed: true,
			range: { from: '2026-07-01', to: '2026-07-31' },
		});
	});

	it('la fase 2 no consulta BigQuery', async () => {
		const { controller, bigQueryService } = buildController();

		await controller.integrateQuantities({}, 'holding-1');

		expect(bigQueryService.ingestSapiraQuantities).not.toHaveBeenCalled();
		expect(bigQueryService.syncSapiraQuantities).not.toHaveBeenCalled();
	});

	it('lanza BadRequestException cuando falta x-holding-id en integrateQuantities', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.integrateQuantities({}, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.integrateSapiraQuantities).not.toHaveBeenCalled();
	});

	it('propaga x-holding-id y el rango al servicio en syncQuantities', async () => {
		const { controller, bigQueryService } = buildController();
		const dto = { from: '2026-07-01', to: '2026-07-31' };

		await controller.syncQuantities(dto, 'holding-1');

		expect(bigQueryService.syncSapiraQuantities).toHaveBeenCalledWith('holding-1', dto);
	});

	it('lanza BadRequestException cuando falta x-holding-id en syncQuantities', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.syncQuantities({}, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.syncSapiraQuantities).not.toHaveBeenCalled();
	});

	it('propaga x-holding-id y los filtros al servicio en listQuantityImports', async () => {
		const { controller, bigQueryService } = buildController();
		const filters = { integration_status: 'unmapped' as const, limit: 50 };

		await controller.listQuantityImports(filters, 'holding-1');

		expect(bigQueryService.listQuantityImports).toHaveBeenCalledWith('holding-1', filters);
	});

	it('lanza BadRequestException cuando falta x-holding-id en listQuantityImports', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.listQuantityImports({}, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.listQuantityImports).not.toHaveBeenCalled();
	});

	it('propaga x-holding-id, id y dto al servicio en replaceQuantityRecord', async () => {
		const { controller, bigQueryService } = buildController();
		const dto = { quantity: 20000 };

		await controller.replaceQuantityRecord('quantity-1', dto as any, 'holding-1');

		expect(bigQueryService.replaceQuantityRecord).toHaveBeenCalledWith('holding-1', 'quantity-1', dto);
	});

	it('lanza BadRequestException cuando falta x-holding-id en replaceQuantityRecord', async () => {
		const { controller, bigQueryService } = buildController();

		await expect(controller.replaceQuantityRecord('quantity-1', {} as any, '')).rejects.toBeInstanceOf(BadRequestException);
		expect(bigQueryService.replaceQuantityRecord).not.toHaveBeenCalled();
	});
});
