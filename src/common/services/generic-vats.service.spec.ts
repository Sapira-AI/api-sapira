import { GenericVatsService } from './generic-vats.service';

describe('GenericVatsService', () => {
	it('identifica VATs genéricos ignorando espacios, puntos y mayúsculas', async () => {
		const repository = {
			find: jest.fn().mockResolvedValue([{ vat: '5555555-5' }, { vat: 'XEXX010101000' }]),
		};
		const service = new GenericVatsService(repository as any);

		await expect(service.isGenericExportVat(' 5.555.555-5 ')).resolves.toBe(true);
		await expect(service.isGenericExportVat('xexx010101000')).resolves.toBe(true);
		await expect(service.isGenericExportVat('76517784-7')).resolves.toBe(false);
	});
});
