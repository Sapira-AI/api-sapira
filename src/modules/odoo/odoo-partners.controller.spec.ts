import { OdooPartnersController } from './odoo-partners.controller';

describe('OdooPartnersController', () => {
	it('resuelve un partner usando el holding recibido por header', async () => {
		const odooPartnersService = {
			resolveAndLinkPartnerByTaxId: jest.fn().mockResolvedValue({
				status: 'found',
				taxId: '76517784-7',
				odooPartnerId: 125,
				message: 'Partner Odoo encontrado y asociado a la entidad legal',
			}),
		};
		const controller = new OdooPartnersController(odooPartnersService as any);

		await expect(
			controller.resolvePartnerByTaxId('holding-1', {
				taxId: '76.517.784-7',
				legalName: 'Acme SpA',
			})
		).resolves.toMatchObject({ status: 'found', odooPartnerId: 125 });
		expect(odooPartnersService.resolveAndLinkPartnerByTaxId).toHaveBeenCalledWith('holding-1', '76.517.784-7', 'Acme SpA');
	});
});
