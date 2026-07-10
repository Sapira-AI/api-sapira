import { InvoiceSchedulerService } from './invoice-scheduler.service';

jest.mock('uuid', () => ({
	v4: jest.fn(() => 'test-uuid'),
}));

describe('InvoiceSchedulerService', () => {
	const createService = () => {
		const taxMappingService = {
			getProductSaleTaxes: jest.fn().mockResolvedValue([116]),
			applyFiscalPositionMapping: jest.fn(),
		};
		const documentTypeMappingService = {
			getDefaultDocumentTypeForInvoice: jest.fn().mockResolvedValue(null),
		};

		const service = new InvoiceSchedulerService(
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
			{} as any,
			{} as any,
			{
				getExchangeRateWithFallback: jest.fn(),
			} as any,
			taxMappingService as any,
			documentTypeMappingService as any,
			{} as any
		);

		return {
			service,
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
});
