import { OdooInvoicesService } from './odoo-invoices.service';

describe('OdooInvoicesService', () => {
	const createService = () => new OdooInvoicesService({} as any, {} as any, {} as any, {} as any);

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

	it('solicita a Odoo el envío de una factura emitida al email del cliente', async () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = {
			methodCall: jest
				.fn()
				.mockResolvedValueOnce([{ name: 'FAC-001', partner_id: [123, 'Cliente Demo'] }])
				.mockResolvedValueOnce([{ email: 'cliente@example.com' }])
				.mockResolvedValueOnce(45)
				.mockResolvedValueOnce(undefined),
		};
		const odooProvider = {
			createXmlRpcClient: jest.fn().mockReturnValueOnce(commonClient).mockReturnValueOnce(objectClient),
		};
		const connectionRepository = {
			findOne: jest.fn().mockResolvedValue({
				url: 'https://odoo.example.com',
				database_name: 'odoo',
				username: 'api@example.com',
				api_key: 'api-key',
			}),
		};
		const service = new OdooInvoicesService(odooProvider as any, connectionRepository as any, {} as any, {} as any);

		const result = await service.sendInvoiceToCustomer('holding-1', 456);

		expect(result).toEqual({
			success: true,
			message: 'Factura FAC-001 enviada por Odoo a cliente@example.com',
			recipientEmail: 'cliente@example.com',
		});
		expect(objectClient.methodCall).toHaveBeenCalledWith(
			'execute_kw',
			expect.arrayContaining([
				'account.move.send',
				'create',
				expect.arrayContaining([
					expect.objectContaining({
						move_ids: [[6, 0, [456]]],
						checkbox_send_mail: true,
					}),
				]),
			])
		);
		expect(objectClient.methodCall).toHaveBeenCalledWith(
			'execute_kw',
			expect.arrayContaining(['account.move.send', 'action_send_and_print', [[45]]])
		);
	});

	it('falla el envío si el cliente no tiene email en Odoo', async () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = {
			methodCall: jest
				.fn()
				.mockResolvedValueOnce([{ name: 'FAC-001', partner_id: [123, 'Cliente Demo'] }])
				.mockResolvedValueOnce([{ email: false }]),
		};
		const odooProvider = {
			createXmlRpcClient: jest.fn().mockReturnValueOnce(commonClient).mockReturnValueOnce(objectClient),
		};
		const connectionRepository = {
			findOne: jest.fn().mockResolvedValue({
				url: 'https://odoo.example.com',
				database_name: 'odoo',
				username: 'api@example.com',
				api_key: 'api-key',
			}),
		};
		const service = new OdooInvoicesService(odooProvider as any, connectionRepository as any, {} as any, {} as any);

		await expect(service.sendInvoiceToCustomer('holding-1', 456)).rejects.toThrow(
			'El cliente de la factura FAC-001 no tiene email configurado en Odoo'
		);
	});
});
