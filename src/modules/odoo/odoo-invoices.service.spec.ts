import { OdooInvoicesService } from './odoo-invoices.service';

describe('OdooInvoicesService', () => {
	const createService = () =>
		new OdooInvoicesService(
			{} as any,
			{} as any,
			{} as any,
			{} as any
		);

	it('usa el flujo de autoemit para Mexico', async () => {
		const service = createService();
		const emitElectronicInvoiceMexicoSpy = jest.spyOn(service as any, 'emitElectronicInvoiceMexico').mockResolvedValue({
			success: true,
			message: 'ok',
			state: 'posted',
			electronic_status: 'accepted',
		});

		const response = await service.emitElectronicInvoice('holding-1', 123, 'México');

		expect(emitElectronicInvoiceMexicoSpy).toHaveBeenCalledWith('holding-1', 123);
		expect(response).toEqual({
			success: true,
			message: 'ok',
			state: 'posted',
			electronic_status: 'accepted',
		});
	});

	it('reutiliza el wizard estandar para Mexico', async () => {
		const service = createService();
		const helperSpy = jest.spyOn(service as any, 'emitElectronicInvoiceWithSendWizard').mockResolvedValue({
			success: true,
			message: 'ok',
			state: 'posted',
			electronic_status: 'accepted',
		});

		const response = await (service as any).emitElectronicInvoiceMexico('holding-1', 456);

		expect(helperSpy).toHaveBeenCalledWith('holding-1', 456, {
			countryLabel: 'México',
			authorityLabel: 'SAT/MX EDI',
		});
		expect(response).toEqual({
			success: true,
			message: 'ok',
			state: 'posted',
			electronic_status: 'accepted',
		});
	});
});
