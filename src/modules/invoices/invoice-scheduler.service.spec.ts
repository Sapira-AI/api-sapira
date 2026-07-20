import { InvoiceSchedulerService } from './invoice-scheduler.service';

jest.mock('uuid', () => ({
	v4: jest.fn(() => 'test-uuid'),
}));

describe('InvoiceSchedulerService', () => {
	const createService = () => {
		const invoiceRepository = {
			update: jest.fn(),
			findOne: jest.fn(),
		};
		const invoiceItemRepository = {
			update: jest.fn(),
			find: jest.fn(),
		};
		const invoiceNotificationService = {
			sendExchangeRateFallbackNotification: jest.fn(),
			sendMissingExchangeRateNotification: jest.fn(),
		};
		const exchangeRatesService = {
			getExchangeRateWithFallback: jest.fn(),
		};
		const taxMappingService = {
			getProductSaleTaxes: jest.fn().mockResolvedValue([116]),
			getCompanyZeroRateSaleTax: jest.fn().mockResolvedValue(null),
			applyFiscalPositionMapping: jest.fn(),
		};
		const documentTypeMappingService = {
			getDefaultDocumentTypeForInvoice: jest.fn().mockResolvedValue(null),
		};

		const service = new InvoiceSchedulerService(
			invoiceRepository as any,
			invoiceItemRepository as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{
				...exchangeRatesService,
			} as any,
			taxMappingService as any,
			documentTypeMappingService as any,
			{
				...invoiceNotificationService,
			} as any
		);

		return {
			service,
			invoiceRepository,
			invoiceItemRepository,
			invoiceNotificationService,
			exchangeRatesService,
			taxMappingService,
			documentTypeMappingService,
		};
	};

	const buildInvoice = (country: string, referenceDate?: Date | null, referenceDocuments: string[] = ['REF-001']) =>
		({
			id: 'invoice-1',
			holding_id: 'holding-1',
			client_entity_id: 'client-1',
			company_id: 'company-1',
			invoice_number: 'INV-001',
			issue_date: new Date('2026-07-10'),
			due_date: new Date('2026-07-20'),
			invoice_currency: 'USD',
			auto_invoice: false,
			export_type: 0,
			total_invoice_currency: 100,
			clientEntity: {
				odoo_partner_id: 16115,
				legal_name: 'Cliente Demo',
			},
			company: {
				odoo_integration_id: 5,
				country,
				legal_name: 'Compania Demo',
			},
			items: [
				{
					id: 'item-1',
					description: 'PATHFINDER+',
					quantity: 28,
					unit_price_invoice_currency: 130.68,
					discount_pct: 0,
				},
			],
			references: referenceDocuments.map((documentNumber) => ({
				document_number: documentNumber,
				document_type_code: '33',
				reference_date: referenceDate ?? undefined,
			})),
		}) as any;

	it('rechaza facturas de Chile con referencias sin reference_date', () => {
		const { service } = createService();

		const validation = service.validateInvoiceForOdoo(buildInvoice('Chile', null));

		expect(validation).toEqual({
			valid: false,
			error: 'Factura de Chile con referencias sin reference_date. El campo date es obligatorio para l10n_cl_reference_ids',
		});
	});

	it('permite facturas de Uruguay aunque la referencia no tenga reference_date', () => {
		const { service } = createService();

		const validation = service.validateInvoiceForOdoo(buildInvoice('Uruguay', null));

		expect(validation).toEqual({ valid: true });
	});

	it('envia la primera referencia en ref para Uruguay', async () => {
		const { service } = createService();
		const getOdooDocumentTypeIdSpy = jest.spyOn(service as any, 'getOdooDocumentTypeId').mockResolvedValue(321);

		const payload = await service.mapInvoiceToOdooFormat(buildInvoice('Uruguay', null, ['OC-27-2026', 'PED-445']));

		expect(payload.l10n_cl_reference_ids).toBeUndefined();
		expect(payload.ref).toBe('OC-27-2026');
		expect(getOdooDocumentTypeIdSpy).not.toHaveBeenCalled();
	});

	it('incluye l10n_cl_reference_ids para Chile cuando la referencia tiene fecha', async () => {
		const { service } = createService();
		jest.spyOn(service as any, 'getOdooDocumentTypeId').mockResolvedValue(321);

		const payload = await service.mapInvoiceToOdooFormat(buildInvoice('Chile', new Date('2026-07-01')));

		expect(payload.l10n_cl_reference_ids).toEqual([
			{
				origin_doc_number: 'REF-001',
				l10n_cl_reference_doc_type_id: 321,
				reference_doc_code: false,
				reason: false,
				date: '2026-07-01',
				l10n_cl_reference_doc_internal_type: false,
			},
		]);
		expect(payload.ref).toBeUndefined();
	});

	it('marca factura de Peru como sujeta a detraccion usando amount_invoice_currency', async () => {
		const { service, documentTypeMappingService } = createService();
		documentTypeMappingService.getDefaultDocumentTypeForInvoice.mockResolvedValue({
			id: 55,
			code: '1',
			name: 'Factura',
		});

		const payload = await service.mapInvoiceToOdooFormat({
			...buildInvoice('Peru', null, []),
			invoice_currency: 'PEN',
			amount_invoice_currency: 800,
			total_invoice_currency: 0,
		});

		expect(payload.l10n_pe_edi_operation_type).toBe('1001');
	});

	it('usa impuesto 0% para exportacion de Mexico', async () => {
		const { service, taxMappingService } = createService();
		taxMappingService.getCompanyZeroRateSaleTax.mockResolvedValue(90);

		const payload = await service.mapInvoiceToOdooFormat({
			...buildInvoice('México', null, []),
			export_type: 1,
		});

		expect(taxMappingService.getCompanyZeroRateSaleTax).toHaveBeenCalledWith(5, 'holding-1');
		expect(payload.invoice_line_ids[0].tax_ids).toEqual([90]);
	});

	it('persiste total_invoice_currency y vat al recalcular montos para emision', async () => {
		const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService } = createService();
		exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({
			rate: 3.5,
			is_fallback: false,
			rate_date: new Date('2026-07-10'),
		});

		await service.calculateInvoiceAmountsAtIssue({
			id: 'invoice-1',
			invoice_number: 'INV-PE-001',
			issue_date: new Date('2026-07-10'),
			contract_currency: 'USD',
			invoice_currency: 'PEN',
			amount_contract_currency: 100,
			items: [
				{
					id: 'item-1',
					unit_price_contract_currency: 100,
					subtotal_contract_currency: 100,
					tax_amount_contract_currency: 18,
					total_contract_currency: 118,
				},
			],
		} as any);

		expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', {
			amount_invoice_currency: 350,
			vat: 63,
			total_invoice_currency: 413,
			fx_contract_to_invoice: 3.5,
		});
		expect(invoiceItemRepository.update).toHaveBeenCalledWith('item-1', {
			unit_price_invoice_currency: 350,
			subtotal_invoice_currency: 350,
			tax_amount_invoice_currency: 63,
			total_invoice_currency: 413,
			fx_contract_to_invoice: 3.5,
		});
	});
});
