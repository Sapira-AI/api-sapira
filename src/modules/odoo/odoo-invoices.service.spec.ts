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

	const PAC_FAULT =
		'XML-RPC Fault: Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.';
	const conexion = { url: 'https://odoo.example.com', database_name: 'odoo', username: 'api@example.com', api_key: 'api-key' };

	it('readInvoiceState: lee state, name y edi_state; sin account_edi vuelve a leer sin el campo; id desconocido → null', async () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = {
			methodCall: jest
				.fn()
				.mockRejectedValueOnce(new Error('Invalid field edi_state'))
				.mockResolvedValueOnce([{ state: 'draft', name: '/' }])
				.mockResolvedValueOnce([{ state: 'posted', name: 'A10166', edi_state: 'sent' }])
				.mockResolvedValueOnce([]),
		};
		const odooProvider = { createXmlRpcClient: jest.fn().mockReturnValue(commonClient) };
		odooProvider.createXmlRpcClient.mockImplementation((url: string) => (url.endsWith('/common') ? commonClient : objectClient));
		const service = new OdooInvoicesService(odooProvider as any, { findOne: jest.fn().mockResolvedValue(conexion) } as any, {} as any, {} as any);

		await expect(service.readInvoiceState('holding-1', 201185)).resolves.toEqual({ state: 'draft', name: '/', edi_state: null });
		expect(objectClient.methodCall).toHaveBeenNthCalledWith(1, 'execute_kw', expect.arrayContaining(['account.move', 'read', [[201185]], { fields: ['state', 'name', 'edi_state'] }]));
		expect(objectClient.methodCall).toHaveBeenNthCalledWith(2, 'execute_kw', expect.arrayContaining([{ fields: ['state', 'name'] }]));
		await expect(service.readInvoiceState('holding-1', 201220)).resolves.toEqual({ state: 'posted', name: 'A10166', edi_state: 'sent' });
		await expect(service.readInvoiceState('holding-1', 999)).resolves.toBeNull();
	});

	it('D (28-10): si el wizard de timbre lanza pero el documento quedó publicado, devuelve rechazada con el motivo; si no quedó publicado, lanza', async () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = {
			methodCall: jest
				.fn()
				.mockResolvedValueOnce(45) // wizard create
				.mockRejectedValueOnce(new Error(PAC_FAULT)) // action_send_and_print
				.mockResolvedValueOnce([{ state: 'posted', name: 'A10166', edi_state: 'to_send' }]), // relectura
		};
		const odooProvider = { createXmlRpcClient: jest.fn((url: string) => (url.endsWith('/common') ? commonClient : objectClient)) };
		const service = new OdooInvoicesService(odooProvider as any, { findOne: jest.fn().mockResolvedValue(conexion) } as any, {} as any, {} as any);

		const result = await (service as any).emitElectronicInvoiceMexico('holding-1', 201220);

		expect(result).toMatchObject({ success: true, state: 'posted', electronic_status: 'rejected' });
		expect(result.electronic_errors[0].message).toContain('CFDI40147');
		expect(result.message).toBe('Factura A10166 publicada en Odoo pero rechazada por SAT/MX EDI');

		objectClient.methodCall.mockReset();
		objectClient.methodCall.mockResolvedValueOnce(46).mockRejectedValueOnce(new Error('Falló la conexión')).mockResolvedValueOnce([{ state: 'draft', name: '/' }]);
		await expect((service as any).emitElectronicInvoiceMexico('holding-1', 201221)).rejects.toThrow(/Error emitiendo factura México en Odoo: .*Falló la conexión/);
	});

	it('falla el envío si el email del cliente es solo espacios', async () => {
		const commonClient = { methodCall: jest.fn().mockResolvedValue(7) };
		const objectClient = {
			methodCall: jest
				.fn()
				.mockResolvedValueOnce([{ name: 'FAC-002', partner_id: [123, 'Cliente Demo'] }])
				.mockResolvedValueOnce([{ email: '   ' }]),
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
			'El cliente de la factura FAC-002 no tiene email configurado en Odoo'
		);
	});
});
