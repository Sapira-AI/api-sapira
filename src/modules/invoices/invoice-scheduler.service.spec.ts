import { ConflictException } from '@nestjs/common';

import { InvoiceSchedulerService, isNonSendableDocumentType } from './invoice-scheduler.service';

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
			sendSchedulerErrorSummary: jest.fn(),
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
		const notificationsService = {
			createOrUpdate: jest.fn(),
			resolveOpen: jest.fn().mockResolvedValue(1),
			findOpenByDeduplicationKey: jest.fn().mockResolvedValue(null),
			findOpenWithMember: jest.fn().mockResolvedValue([]),
			updateContent: jest.fn().mockResolvedValue(undefined),
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
			invoiceNotificationService as any,
			{
				...exchangeRatesService,
			} as any,
			taxMappingService as any,
			documentTypeMappingService as any,
			{} as any,
			notificationsService as any
		);

		return {
			service,
			invoiceRepository,
			invoiceItemRepository,
			invoiceNotificationService,
			exchangeRatesService,
			taxMappingService,
			documentTypeMappingService,
			notificationsService,
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

	it('agrupa errores distintos y solo notifica ejecuciones reales', async () => {
		const { service, invoiceNotificationService } = createService();
		const result = {
			dryRun: false,
			summary: { total: 3, sent: 0, errors: 3, skipped: 0 },
			results: [
				{ invoiceId: '1', invoiceNumber: '1', status: 'error', error: ' Partner no encontrado ' },
				{ invoiceId: '2', invoiceNumber: '2', status: 'error', error: 'Partner no encontrado' },
				{ invoiceId: '3', invoiceNumber: '3', status: 'error' },
			],
			success: false,
			executedAt: new Date('2026-08-01T12:10:00.000Z'),
		};

		await (service as any).sendErrorSummaryNotification({
			jobId: 'job-1',
			holdingId: 'holding-1',
			dryRun: false,
			executionSource: 'automatic',
			executionEnvironment: 'qa',
			startedAt: new Date('2026-08-01T12:00:00.000Z'),
			result,
		});

		expect(invoiceNotificationService.sendSchedulerErrorSummary).toHaveBeenCalledWith(
			expect.objectContaining({
				distinctErrors: [
					{ message: 'Partner no encontrado', count: 2 },
					{ message: 'Error sin detalle', count: 1 },
				],
			})
		);

		await (service as any).sendErrorSummaryNotification({
			...{
				jobId: 'job-2',
				holdingId: 'holding-1',
				executionSource: 'manual',
				executionEnvironment: 'qa',
				startedAt: new Date(),
				result,
			},
			dryRun: true,
		});
		expect(invoiceNotificationService.sendSchedulerErrorSummary).toHaveBeenCalledTimes(1);
	});

	it('crea fallos de Odoo como notificaciones unificadas vinculadas a la factura', async () => {
		const { service, notificationsService } = createService();
		notificationsService.createOrUpdate.mockResolvedValue({});

		await (service as any).createOdooFailureNotification({
			invoice: {
				id: 'invoice-1',
				holding_id: 'holding-1',
				contract_id: 'contract-1',
				invoice_number: 'FAC-001',
				company: { country: 'Chile', legal_name: 'Sapira Chile' },
				clientEntity: { legal_name: 'Cliente Demo' },
			},
			title: 'Error al publicar factura en Odoo',
			message: 'La factura no tiene impuestos',
			stage: 'post',
			errorType: 'odoo_publish',
			errorMessage: 'La factura no tiene impuestos',
			schedulerSource: 'scheduler',
		});

		expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
			'holding-1',
			expect.objectContaining({
				source: 'invoices',
				type: 'invoice_odoo_failure',
				resource_type: 'invoice',
				resource_id: 'invoice-1',
				action_type: 'open_contract',
				action_payload: { contract_id: 'contract-1' },
			})
		);
	});

	it('la notificación de fallo usa la frase traducida (título con folio y cliente, cuerpo = qué pasó + paso siguiente) y deja lo técnico en metadata', async () => {
		const { service, notificationsService } = createService();

		await (service as any).createOdooFailureNotification({
			invoice: {
				id: 'invoice-1',
				holding_id: 'holding-1',
				contract_id: 'contract-1',
				invoice_number: 'FAC-001',
				company: { country: 'Chile', legal_name: 'Sapira Chile' },
				clientEntity: { legal_name: 'Cliente Demo' },
			},
			title: 'Error al crear la factura FAC-001 en Odoo',
			message: 'Error creando factura en borrador en Odoo: No journal could be found',
			stage: 'create_draft',
			errorType: 'odoo_rejection',
			errorMessage: 'Error creando factura en borrador en Odoo: No journal could be found',
			schedulerSource: 'manual',
		});

		expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
			'holding-1',
			expect.objectContaining({
				title: 'No se pudo enviar la factura FAC-001 de Cliente Demo',
				message:
					'Falta el diario de ventas en Odoo para la compañía emisora. Configura el diario de ventas de la compañía en Odoo y vuelve a enviarla.',
				metadata: expect.objectContaining({
					technical_message: 'Error creando factura en borrador en Odoo: No journal could be found',
					erp_error: expect.objectContaining({ category: 'journal_missing', action: 'integrations' }),
				}),
			})
		);
	});

	it('28-10: las facturas que fallan por la misma causa el mismo día se suman al aviso abierto (una alerta, lista de facturas, sin acción propia)', async () => {
		const { service, notificationsService } = createService();
		const CAF =
			'XML-RPC Fault: No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)';
		const invoiceOf = (n: number) => ({
			id: `invoice-${n}`,
			holding_id: 'holding-1',
			contract_id: `contract-${n}`,
			company_id: 'company-cl',
			invoice_number: 'FAC 028401',
			issue_date: new Date('2026-10-28T12:00:00Z'),
			company: { id: 'company-cl', country: 'Chile', legal_name: 'Simplit SpA' },
			clientEntity: { legal_name: `Cliente ${n}` },
		});
		const failure = (n: number) =>
			(service as any).createOdooFailureNotification({
				invoice: invoiceOf(n),
				stage: 'post_invoice',
				title: 'Error al publicar factura FAC 028401 en Odoo',
				message: `Factura creada en Odoo con ID: ${201180 + n}, pero falló la emisión: ${CAF}`,
				errorType: 'odoo_post_exception',
				errorMessage: CAF,
				odooInvoiceId: 201180 + n,
				schedulerSource: 'automatic',
				errorDetails: { stack: 'Error: …\n    at …' },
			});

		await failure(1);
		const first = notificationsService.createOrUpdate.mock.calls[0][1];

		expect(first.title).toBe('No se pudo enviar la factura FAC 028401 de Cliente 1');
		expect(first.deduplication_key).toMatch(/^invoice-odoo-failure:company-cl:\d{4}-\d{2}-\d{2}:post_invoice:folios_exhausted:[0-9a-f]{8}$/);
		expect(first.company_id).toBe('company-cl');
		expect(first.metadata.what_we_do).toMatch(/^No la reintentamos solos: el borrador ya existe en el ERP/);
		expect(first.metadata.technical_detail).toBe(
			'No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl'
		);

		// Segunda factura con la misma causa: el aviso abierto ya tiene a la primera → se agrupa.
		notificationsService.findOpenByDeduplicationKey.mockResolvedValueOnce({ id: 'group-1', metadata: first.metadata });
		await failure(2);
		const second = notificationsService.createOrUpdate.mock.calls[1][1];

		expect(second.deduplication_key).toBe(first.deduplication_key);
		expect(second.title).toBe('No se pudieron enviar 2 facturas de Simplit SpA al ERP');
		expect(second.message).toBe(first.message);
		expect(second.action_type).toBeUndefined();
		expect(second.resource_id).toBeUndefined();
		expect(second.metadata.invoice_count).toBe(2);
		expect(second.metadata.invoices.map((item: { id: string }) => item.id)).toEqual(['invoice-1', 'invoice-2']);
		expect(second.metadata.client_name).toBeNull();

		// La misma factura otra vez (reintento manual) no se cuenta dos veces.
		notificationsService.findOpenByDeduplicationKey.mockResolvedValueOnce({ id: 'group-1', metadata: second.metadata });
		await failure(2);
		expect(notificationsService.createOrUpdate.mock.calls[2][1].metadata.invoice_count).toBe(2);
	});

	it('28-10: al enviar bien una factura sale del aviso agrupado (se achica) y el aviso se resuelve cuando queda vacío', async () => {
		const { service, notificationsService } = createService();
		const invoices = (ids: string[]) => ids.map((id) => ({ id, invoice_number: `F-${id}`, client_name: `Cliente ${id}`, contract_id: `ctr-${id}`, odoo_invoice_id: null, issue_date: null }));
		const metadata = (ids: string[]) => ({
			failure_stage: 'post_invoice',
			error_type: 'odoo_post_exception',
			error_message: 'raw',
			company_name: 'Simplit SpA',
			country: 'Chile',
			scheduler_source: 'automatic',
			erp_error: { category: 'folios_exhausted', message: 'Se acabaron los folios', next_step: 'Solicita un CAF', action: 'none' },
			invoices: invoices(ids),
			invoice_count: ids.length,
		});
		notificationsService.findOpenWithMember.mockResolvedValue([
			{ id: 'group-2', metadata: metadata(['invoice-1', 'invoice-9']) },
			{ id: 'group-1', metadata: metadata(['invoice-1']) },
		]);

		await (service as any).resolveOdooFailureNotifications({ id: 'invoice-1', holding_id: 'holding-1' });

		expect(notificationsService.resolveOpen).toHaveBeenCalledWith('holding-1', { type: 'invoice_odoo_failure', resourceId: 'invoice-1' });
		expect(notificationsService.findOpenWithMember).toHaveBeenCalledWith('holding-1', 'invoice_odoo_failure', 'invoices', 'invoice-1');
		expect(notificationsService.updateContent).toHaveBeenCalledWith(
			'holding-1',
			'group-2',
			expect.objectContaining({
				title: 'No se pudo enviar la factura F-invoice-9 de Cliente invoice-9',
				message: 'Se acabaron los folios. Solicita un CAF.',
				action_type: 'open_contract',
				action_payload: { contract_id: 'ctr-invoice-9' },
				resource_id: 'invoice-9',
				metadata: expect.objectContaining({ invoice_count: 1, invoices: invoices(['invoice-9']) }),
			})
		);
		expect(notificationsService.resolveOpen).toHaveBeenCalledWith('holding-1', { ids: ['group-1'] });
	});

	it('lastSendAttempt: lee el último log de la factura y lo traduce; si el log falla devuelve null', async () => {
		const { service } = createService();
		const exec = jest.fn().mockResolvedValue({
			operation: 'create_draft',
			status: 'error',
			error_message: 'connect ETIMEDOUT',
			error_type: 'unexpected_exception',
			createdAt: new Date('2026-10-02T12:00:00.000Z'),
		});
		const chain = { sort: jest.fn(() => chain), lean: jest.fn(() => chain), exec };
		const findOne = jest.fn(() => chain);

		(service as any).invoiceOdooSendLogModel = { findOne };
		await expect(service.lastSendAttempt('invoice-1', 'holding-1')).resolves.toEqual({
			at: '2026-10-02T12:00:00.000Z',
			ok: false,
			operation: 'create_draft',
			category: 'connection',
			message: 'No pudimos conectarnos con Odoo',
			next_step: 'Vuelve a intentarlo en unos minutos; si sigue fallando, revisa la conexión en Integraciones › ERP › Configuración',
			action: 'retry',
			raw: 'connect ETIMEDOUT',
		});
		expect(findOne).toHaveBeenCalledWith({ invoice_id: 'invoice-1', holding_id: 'holding-1' });
		expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });

		exec.mockResolvedValue({ operation: 'create_draft', status: 'success', createdAt: '2026-10-02T13:00:00.000Z' });
		await expect(service.lastSendAttempt('invoice-1', 'holding-1')).resolves.toMatchObject({
			ok: true,
			message: 'Enviada al ERP como borrador',
			category: null,
		});

		exec.mockRejectedValue(new Error('mongo caído'));
		await expect(service.lastSendAttempt('invoice-1', 'holding-1')).resolves.toBeNull();
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

	it('no envía al ERP las líneas con cantidad 0 cuando la factura tiene otras líneas; si todas están en cero, las envía como antes', async () => {
		const { service } = createService();
		const base = buildInvoice('Uruguay', null, []);
		const zero = { id: 'item-0', description: 'Consumo en cero', quantity: 0, unit_price_invoice_currency: 5, discount_pct: 0 };

		const mixed = await service.mapInvoiceToOdooFormat({ ...base, items: [...base.items, zero] } as typeof base);

		expect(mixed.invoice_line_ids).toHaveLength(1);
		expect(mixed.invoice_line_ids[0].quantity).toBe(28);

		const allZero = await service.mapInvoiceToOdooFormat({ ...base, items: [zero] } as typeof base);

		expect(allZero.invoice_line_ids).toHaveLength(1);
	});

	it('no envía al ERP las líneas internas de una línea visible (facturación por OC): solo viaja la visible', async () => {
		const { service } = createService();
		const base = buildInvoice('Uruguay', null, []);
		const visible = {
			id: 'item-v',
			description: 'OC 123 · septiembre',
			quantity: 1,
			unit_price_invoice_currency: 900,
			discount_pct: 0,
			visible_line_id: null,
		};
		const internal = {
			id: 'item-i',
			description: 'PATHFINDER+',
			quantity: 28,
			unit_price_invoice_currency: 32.14,
			discount_pct: 0,
			visible_line_id: 'item-v',
		};

		const payload = await service.mapInvoiceToOdooFormat({ ...base, items: [visible, internal] } as typeof base);

		expect(payload.invoice_line_ids).toHaveLength(1);
		expect(payload.invoice_line_ids[0].quantity).toBe(1);
	});

	it('respeta la tasa fijada explícitamente en la factura (fx_rate_source manual/net_exact) aunque la política del contrato sea spot', async () => {
		const { service, exchangeRatesService } = createService();
		const base = buildInvoice('Chile', null, []);

		const items = base.items.map((item) => ({ ...item, fx_rate_source: 'manual' }));
		const result = await service.calculateInvoiceAmountsAtIssue({
			...base,
			items,
			fx_contract_to_invoice: 950.5,
			contract: { ...(base.contract ?? {}), fx_invoice_policy: 'spot' },
		} as typeof base);

		expect(result).toEqual({ success: true, usedFallback: false, exchangeRate: 950.5 });
		expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
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

	it('sendInvoiceById (Contrato 360 › Enviar al ERP ahora) carga la factura con sus relaciones y delega en sendInvoiceToOdoo con origen manual', async () => {
		const { service } = createService();
		const load = jest
			.spyOn(service as unknown as { getInvoiceWithRelations: (id: string) => Promise<unknown> }, 'getInvoiceWithRelations')
			.mockResolvedValue({ id: 'invoice-1', items: [{ id: 'item-1' }] });
		const send = jest.spyOn(service, 'sendInvoiceToOdoo').mockResolvedValue({ invoiceId: 'invoice-1', status: 'sent', odooInvoiceId: 77 } as any);

		await expect(service.sendInvoiceById('invoice-1', false)).resolves.toMatchObject({ status: 'sent', odooInvoiceId: 77 });
		expect(load).toHaveBeenCalledWith('invoice-1');
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: 'invoice-1', items: [{ id: 'item-1' }] }), false, 'manual');
	});

	it('Huecos #1: sendInvoiceById rechaza NC/ND con 409 credit_note_send_pending sin llamar a Odoo', async () => {
		const { service } = createService();

		for (const documentType of ['NC', 'ND']) {
			jest.spyOn(
				service as unknown as { getInvoiceWithRelations: (id: string) => Promise<unknown> },
				'getInvoiceWithRelations'
			).mockResolvedValue({ id: 'nc-1', document_type: documentType, items: [] });
			const send = jest.spyOn(service, 'sendInvoiceToOdoo');
			const error = await service.sendInvoiceById('nc-1', false).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			expect((error as ConflictException).getResponse()).toMatchObject({ code: 'credit_note_send_pending', document_type: documentType });
			expect(send).not.toHaveBeenCalled();
		}
	});

	it('Huecos #1: la consulta del envío (automático y lote manual) excluye NC y ND', async () => {
		const { service, invoiceRepository } = createService();
		const builder: Record<string, jest.Mock> = {};

		for (const method of ['leftJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy']) builder[method] = jest.fn(() => builder);
		builder.getMany = jest.fn().mockResolvedValue([]);
		(invoiceRepository as unknown as { createQueryBuilder: jest.Mock }).createQueryBuilder = jest.fn(() => builder);

		await expect(service.getInvoicesToSend('holding-1')).resolves.toEqual([]);
		expect(builder.andWhere).toHaveBeenCalledWith('(inv.document_type IS NULL OR inv.document_type NOT IN (:...nonSendableDocumentTypes))', {
			nonSendableDocumentTypes: ['NC', 'ND'],
		});
		expect(isNonSendableDocumentType('nc')).toBe(true);
		expect(isNonSendableDocumentType('FACTURA')).toBe(false);
		expect(isNonSendableDocumentType(null)).toBe(false);
	});

	it('U12/B3: política fija del contrato con tasa en la factura no consulta Banco Central; fija sin tasa se detiene (nunca spot en silencio)', async () => {
		const { service, invoiceRepository, exchangeRatesService } = createService();

		await expect(
			service.calculateInvoiceAmountsAtIssue({
				id: 'invoice-1',
				fx_contract_to_invoice: 950,
				contract: { fx_invoice_policy: 'fixed' },
				contract_currency: 'USD',
				invoice_currency: 'CLP',
			} as any)
		).resolves.toEqual({ success: true, usedFallback: false, exchangeRate: 950 });
		expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
		expect(invoiceRepository.update).not.toHaveBeenCalled();

		await expect(
			service.calculateInvoiceAmountsAtIssue({
				id: 'invoice-2',
				invoice_number: 'INV-2',
				fx_contract_to_invoice: null,
				contract: { fx_invoice_policy: 'fixed' },
				contract_currency: 'USD',
				invoice_currency: 'CLP',
			} as any)
		).rejects.toThrow('tipo de cambio fijo (política del contrato) y no tiene tasa');
		expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
	});

	it('"Del día" elegido en la factura (línea con fx_rate_source spot) en un contrato fijo sin tasa: se valoriza con la tasa del día (Domi 22-10, caso Carelis)', async () => {
		const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService } = createService();

		exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 41199.85, is_fallback: false, rate_date: new Date('2026-10-22') });
		await expect(
			service.calculateInvoiceAmountsAtIssue({
				id: 'invoice-carelis',
				invoice_number: 'INV-161-10',
				issue_date: new Date('2026-10-22'),
				fx_contract_to_invoice: null,
				contract: { fx_invoice_policy: 'fixed' },
				contract_currency: 'CLF',
				invoice_currency: 'CLP',
				amount_contract_currency: 10,
				items: [
					{
						id: 'line-1',
						unit_price_contract_currency: 10,
						subtotal_contract_currency: 10,
						tax_amount_contract_currency: 1.9,
						total_contract_currency: 11.9,
						fx_contract_to_invoice: null,
						fx_rate_source: 'spot',
					},
				],
			} as any)
		).resolves.toMatchObject({ success: true, exchangeRate: 41199.85 });
		expect(exchangeRatesService.getExchangeRateWithFallback).toHaveBeenCalledWith('CLF', 'CLP', expect.anything());
		expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-carelis', expect.objectContaining({ fx_contract_to_invoice: 41199.85 }));
		expect(invoiceItemRepository.update).toHaveBeenCalledWith('line-1', expect.objectContaining({ fx_contract_to_invoice: 41199.85 }));
	});

	it('reenvío de una "Del día" ya valorizada en un contrato fijo (marca spot con tasa): no reutiliza la tasa guardada, consulta la del día (revisión 23-10)', async () => {
		const { service, invoiceRepository, exchangeRatesService } = createService();

		exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 41350, is_fallback: false, rate_date: new Date('2026-10-23') });
		await expect(
			service.calculateInvoiceAmountsAtIssue({
				id: 'invoice-carelis-resend',
				invoice_number: 'INV-161-10',
				issue_date: new Date('2026-10-23'),
				fx_contract_to_invoice: 41199.85,
				contract: { fx_invoice_policy: 'fixed' },
				contract_currency: 'CLF',
				invoice_currency: 'CLP',
				amount_contract_currency: 10,
				items: [
					{
						id: 'line-1',
						unit_price_contract_currency: 10,
						subtotal_contract_currency: 10,
						tax_amount_contract_currency: 1.9,
						total_contract_currency: 11.9,
						fx_contract_to_invoice: 41199.85,
						fx_rate_source: 'spot',
					},
				],
			} as any)
		).resolves.toMatchObject({ success: true, exchangeRate: 41350 });
		expect(exchangeRatesService.getExchangeRateWithFallback).toHaveBeenCalledWith('CLF', 'CLP', expect.anything());
		expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-carelis-resend', expect.objectContaining({ fx_contract_to_invoice: 41350 }));
	});

	it('política spot del contrato: una tasa pegada sin origen explícito no se usa, se consulta Banco Central como antes', async () => {
		const { service, exchangeRatesService, invoiceRepository } = createService();

		exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 3.5, is_fallback: false, rate_date: new Date('2026-07-10') });
		await expect(
			service.calculateInvoiceAmountsAtIssue({
				id: 'invoice-1',
				fx_contract_to_invoice: 880,
				contract: { fx_invoice_policy: 'spot' },
				contract_currency: 'USD',
				invoice_currency: 'PEN',
				amount_contract_currency: 100,
				items: [],
			} as any)
		).resolves.toMatchObject({ success: true, exchangeRate: 3.5 });
		expect(invoiceRepository.update).toHaveBeenCalled();
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

	describe('MM4 · multimoneda: una tasa por par al emitir (spec-multimoneda §4)', () => {
		const usdLine = {
			id: 'line-usd',
			contract_currency: 'USD',
			unit_price_contract_currency: 50,
			subtotal_contract_currency: 100,
			tax_amount_contract_currency: 16,
			total_contract_currency: 116,
			fx_contract_to_invoice: null,
			fx_rate_source: null,
		};
		const mxnLine = {
			id: 'line-mxn',
			contract_currency: 'MXN',
			unit_price_contract_currency: 500,
			subtotal_contract_currency: 500,
			tax_amount_contract_currency: 80,
			total_contract_currency: 580,
			unit_price_invoice_currency: 500,
			subtotal_invoice_currency: 500,
			tax_amount_invoice_currency: 80,
			total_invoice_currency: 580,
			fx_contract_to_invoice: 1,
			fx_rate_source: 'contract',
		};
		const multiInvoice = (items: unknown[], contract: Record<string, unknown> = {}) =>
			({
				id: 'invoice-mm',
				invoice_number: 'INV-MM',
				issue_date: new Date('2026-10-01'),
				contract_currency: 'USD',
				invoice_currency: 'MXN',
				tax_rate: 16,
				amount_contract_currency: 127.03,
				items,
				contract: { requires_multicurrency_billing: true, fx_invoice_policy: 'spot', ...contract },
			}) as any;
		const rateDate = new Date('2026-10-01');

		it('contrato USD facturado en MXN (spot): la línea MXN queda a 1 sin tocar, la USD a la tasa USD→MXN del día; encabezado = Σ líneas con la tasa del único par', async () => {
			const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService } = createService();

			exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 18.5, is_fallback: false, rate_date: rateDate });

			await expect(service.calculateInvoiceAmountsAtIssue(multiInvoice([usdLine, mxnLine]))).resolves.toEqual({
				success: true,
				usedFallback: false,
				exchangeRate: 18.5,
				fallbackDate: undefined,
			});
			expect(exchangeRatesService.getExchangeRateWithFallback).toHaveBeenCalledTimes(1);
			expect(exchangeRatesService.getExchangeRateWithFallback).toHaveBeenCalledWith('USD', 'MXN', new Date('2026-10-01'));
			expect(invoiceItemRepository.update).toHaveBeenCalledTimes(1);
			expect(invoiceItemRepository.update).toHaveBeenCalledWith('line-usd', {
				unit_price_invoice_currency: 925,
				subtotal_invoice_currency: 1850,
				tax_amount_invoice_currency: 296,
				total_invoice_currency: 2146,
				fx_contract_to_invoice: 18.5,
				fx_rate_source: 'spot',
				fx_rate_date: rateDate,
			});
			// Nunca ida y vuelta por la moneda del contrato: amount_contract_currency no se toca.
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-mm', {
				amount_invoice_currency: 2350,
				vat: 376,
				total_invoice_currency: 2726,
				fx_contract_to_invoice: 18.5,
			});
		});

		it('dos pares que convierten (USD y CLF en CLP): cada par con su spot y el FX del encabezado queda NULL', async () => {
			const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService } = createService();
			const rates: Record<string, number> = { USD: 950, CLF: 39000 };

			exchangeRatesService.getExchangeRateWithFallback.mockImplementation(async (from: string) => ({
				rate: rates[from],
				is_fallback: false,
				rate_date: rateDate,
			}));
			await service.calculateInvoiceAmountsAtIssue({
				...multiInvoice([
					usdLine,
					{
						...usdLine,
						id: 'line-clf',
						contract_currency: 'CLF',
						unit_price_contract_currency: 2,
						subtotal_contract_currency: 2,
						tax_amount_contract_currency: 0.38,
						total_contract_currency: 2.38,
					},
				]),
				contract_currency: 'CLP',
				invoice_currency: 'CLP',
				tax_rate: 19,
			});

			expect(exchangeRatesService.getExchangeRateWithFallback.mock.calls.map((call) => `${call[0]}>${call[1]}`).sort()).toEqual([
				'CLF>CLP',
				'USD>CLP',
			]);
			expect(invoiceItemRepository.update).toHaveBeenCalledWith(
				'line-clf',
				expect.objectContaining({ subtotal_invoice_currency: 78000, fx_contract_to_invoice: 39000, fx_rate_source: 'spot' })
			);
			expect(invoiceItemRepository.update).toHaveBeenCalledWith(
				'line-usd',
				expect.objectContaining({ subtotal_invoice_currency: 95000, fx_contract_to_invoice: 950 })
			);
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-mm', {
				amount_invoice_currency: 173000,
				vat: 32870,
				total_invoice_currency: 205870,
				fx_contract_to_invoice: null,
			});
		});

		it('una línea con tasa manual ya fijada conserva su tasa y su origen; no se consulta Banco Central', async () => {
			const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService } = createService();

			await service.calculateInvoiceAmountsAtIssue(
				multiInvoice([{ ...usdLine, fx_contract_to_invoice: 19, fx_rate_source: 'manual' }, mxnLine])
			);

			expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
			expect(invoiceItemRepository.update).toHaveBeenCalledWith('line-usd', {
				unit_price_invoice_currency: 950,
				subtotal_invoice_currency: 1900,
				tax_amount_invoice_currency: 304,
				total_invoice_currency: 2204,
				fx_contract_to_invoice: 19,
			});
			expect(invoiceRepository.update).toHaveBeenCalledWith(
				'invoice-mm',
				expect.objectContaining({ amount_invoice_currency: 2400, fx_contract_to_invoice: 19 })
			);
		});

		it('contrato fijo sin tasa pero con "Del día" elegido en la factura (marca spot en una línea): se valoriza por par con la tasa del día (Domi 22-10)', async () => {
			const { service, exchangeRatesService } = createService();

			exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 18.5, is_fallback: false, rate_date: rateDate });
			await expect(
				service.calculateInvoiceAmountsAtIssue(
					multiInvoice([{ ...usdLine, fx_rate_source: 'spot' }, mxnLine], { fx_invoice_policy: 'fixed' })
				)
			).resolves.toMatchObject({ success: true, exchangeRate: 18.5 });
			// Sin la marca, la política fija del contrato sigue exigiendo la tasa (U12/B3).
			await expect(
				service.calculateInvoiceAmountsAtIssue(multiInvoice([usdLine, mxnLine], { fx_invoice_policy: 'fixed' }))
			).rejects.toMatchObject({
				code: 'fx_rate_missing',
			});
		});

		it('contrato fijo: una línea con tasa la conserva sea cual sea su origen (scheduled-generation, contract-change, NULL), sin consultar Banco Central (Domi 23-10, caso Carelis)', async () => {
			for (const source of ['scheduled-generation', 'contract-change', null]) {
				const { service, invoiceItemRepository, exchangeRatesService } = createService();
				const valuedUsd = {
					...usdLine,
					fx_contract_to_invoice: 18,
					fx_rate_source: source,
					unit_price_invoice_currency: 900,
					subtotal_invoice_currency: 1800,
					tax_amount_invoice_currency: 288,
					total_invoice_currency: 2088,
				};

				await expect(
					service.calculateInvoiceAmountsAtIssue(multiInvoice([valuedUsd, mxnLine], { fx_invoice_policy: 'fixed' }))
				).resolves.toMatchObject({
					success: true,
				});
				expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
				expect(invoiceItemRepository.update).toHaveBeenCalledWith('line-usd', expect.objectContaining({ fx_contract_to_invoice: 18 }));
			}
		});

		it('contrato fijo: la línea SIN tasa sigue deteniendo el envío con el par que falta; la marca spot con tasa no cuenta como fija', async () => {
			const { service } = createService();

			await expect(
				service.calculateInvoiceAmountsAtIssue(multiInvoice([usdLine, mxnLine], { fx_invoice_policy: 'fixed' }))
			).rejects.toMatchObject({
				code: 'fx_rate_missing',
				pairs: ['USD>MXN'],
				message: expect.stringContaining('USD → MXN'),
			});
		});

		it('contrato spot: una tasa de origen reissue/scheduled-generation no se conserva (se valoriza al día); la del contrato o la manual sí', async () => {
			const valued = (source: string) => ({ ...usdLine, fx_contract_to_invoice: 18, fx_rate_source: source });

			for (const source of ['reissue', 'scheduled-generation']) {
				const { service, exchangeRatesService } = createService();

				exchangeRatesService.getExchangeRateWithFallback.mockResolvedValue({ rate: 18.5, is_fallback: false, rate_date: rateDate });
				await expect(service.calculateInvoiceAmountsAtIssue(multiInvoice([valued(source), mxnLine]))).resolves.toMatchObject({
					exchangeRate: 18.5,
				});
				expect(exchangeRatesService.getExchangeRateWithFallback).toHaveBeenCalled();
			}
			for (const source of ['contract-change', 'manual']) {
				const { service, exchangeRatesService } = createService();

				await expect(service.calculateInvoiceAmountsAtIssue(multiInvoice([valued(source), mxnLine]))).resolves.toMatchObject({
					success: true,
				});
				expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
			}
		});

		it('falta la tasa de un par → fx_rate_missing con el par, no escribe nada (no se envía)', async () => {
			const { service, invoiceRepository, invoiceItemRepository, exchangeRatesService, invoiceNotificationService } = createService();

			exchangeRatesService.getExchangeRateWithFallback.mockRejectedValue(new Error('No hay tasa'));

			await expect(service.calculateInvoiceAmountsAtIssue(multiInvoice([usdLine, mxnLine]))).rejects.toMatchObject({
				code: 'fx_rate_missing',
				pairs: ['USD>MXN'],
				message: expect.stringContaining('USD → MXN'),
			});
			expect(invoiceNotificationService.sendMissingExchangeRateNotification).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Date),
				'USD',
				'MXN'
			);
			expect(invoiceItemRepository.update).not.toHaveBeenCalled();
			expect(invoiceRepository.update).not.toHaveBeenCalled();
		});

		it('política fija con una línea que convierte sin tasa → fx_rate_missing (nunca spot en silencio)', async () => {
			const { service, invoiceRepository, exchangeRatesService } = createService();

			await expect(
				service.calculateInvoiceAmountsAtIssue(multiInvoice([usdLine, mxnLine], { fx_invoice_policy: 'fixed' }))
			).rejects.toMatchObject({
				code: 'fx_rate_missing',
			});
			expect(exchangeRatesService.getExchangeRateWithFallback).not.toHaveBeenCalled();
			expect(invoiceRepository.update).not.toHaveBeenCalled();
		});

		it('detección: una sola moneda sin el flag sigue la rama de siempre; contrato CLP con líneas UF en factura CLP sí convierte por par', () => {
			const single = {
				contract_currency: 'USD',
				invoice_currency: 'PEN',
				items: [{ contract_currency: 'USD' }, { contract_currency: null }],
				contract: {},
			} as any;
			const ufInClp = {
				contract_currency: 'CLP',
				invoice_currency: 'CLP',
				items: [{ contract_currency: 'CLF' }, { contract_currency: 'CLP' }],
				contract: {},
			} as any;

			expect(InvoiceSchedulerService.requiresPairValuation(single)).toBe(false);
			expect(InvoiceSchedulerService.convertsByPair(single)).toBe(false);
			expect(InvoiceSchedulerService.requiresPairValuation(ufInClp)).toBe(true);
			expect(InvoiceSchedulerService.convertsByPair(ufInClp)).toBe(true);
		});
	});

	describe('producto sin mapeo al ERP (product_without_erp_mapping): nunca viaja como producto 1', () => {
		const withRepos = (mappings: Record<string, number>, products: Record<string, { name: string; odoo_product_id: number | null }>) => {
			const ctx = createService();
			const internals = ctx.service as unknown as Record<string, unknown>;
			const createDraftInvoice = jest.fn();

			internals.odooProductMappingRepository = {
				findOne: jest.fn(async ({ where }: { where: { sapira_product_id: string; holding_id: string } }) =>
					where.holding_id === 'holding-1' && mappings[where.sapira_product_id] !== undefined
						? { odoo_product_id: mappings[where.sapira_product_id] }
						: null
				),
			};
			internals.productRepository = {
				findOne: jest.fn(async ({ where }: { where: { id: string } }) =>
					products[where.id] ? { id: where.id, ...products[where.id] } : null
				),
			};
			internals.odooInvoicesService = { createDraftInvoice };
			const sendLog = jest.spyOn(ctx.service as never, 'createOdooSendLog').mockResolvedValue(undefined as never);

			return { ...ctx, createDraftInvoice, sendLog };
		};
		const invoiceWith = (items: unknown[]) =>
			({
				...buildInvoice('Uruguay', null, []),
				contract_id: 'contract-1',
				contract_currency: 'USD',
				amount_invoice_currency: 100,
				items,
			}) as any;
		const line = (id: string, product_id: string | null, extra: Record<string, unknown> = {}) => ({
			id,
			product_id,
			description: id,
			quantity: 1,
			unit_price_invoice_currency: 10,
			discount_pct: 0,
			...extra,
		});

		const CAF_FAULT =
			'Error emitiendo factura en Odoo: XML-RPC Fault: No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)';
		const PAC_FAULT =
			'Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.';
		/** Envío con borrador creado y emisión automática: el ERP se mockea por etapa. */
		const withErp = (erp: Record<string, jest.Mock>) => {
			const ctx = withRepos({ 'p-ok': 77 }, { 'p-ok': { name: 'Plan Pro', odoo_product_id: null } });
			const internals = ctx.service as unknown as Record<string, unknown>;
			const createDraftInvoice = jest.fn().mockResolvedValue({ success: true, invoice_id: 201185 });
			const query = jest.fn().mockResolvedValue([]);

			internals.odooInvoicesService = { createDraftInvoice, ...erp };
			internals.dataSource = { query };

			return { ...ctx, createDraftInvoice, query };
		};
		const autoInvoice = () => ({ ...invoiceWith([line('a', 'p-ok')]), auto_invoice: true, invoice_number: null });

		it('C (28-10): si la publicación falla y Odoo no publicó el documento, la factura vuelve a Por Emitir sin el folio que copió el webhook, conserva el borrador y se reconstruye el devengo', async () => {
			const { service, invoiceRepository, notificationsService, query } = withErp({
				postInvoice: jest.fn().mockRejectedValue(new Error(CAF_FAULT)),
				readInvoiceState: jest.fn().mockResolvedValue({ state: 'draft', name: '/', edi_state: null }),
			});
			// Lo que el webhook alcanzó a escribir dentro de la transacción de Odoo, antes del rollback.
			invoiceRepository.findOne.mockResolvedValue({ id: 'invoice-1', status: 'Enviada', invoice_number: 'FAC 028401', contract_id: 'contract-1', issue_date: new Date('2026-10-28T12:00:00Z') });

			const result = await service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(result.status).toBe('error');
			expect(result.errorType).toBe('odoo_post_exception');
			expect(result.details).toContain('La factura vuelve a Por Emitir como borrador en el ERP');
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', { odoo_invoice_id: 201185, sent_to_odoo_at: expect.any(Date) });
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', { status: 'Por Emitir', invoice_number: null });
			expect(invoiceRepository.update).not.toHaveBeenCalledWith('invoice-1', expect.objectContaining({ status: 'Emitida' }));
			expect(query).toHaveBeenCalledWith(expect.stringContaining('revenue_schedule_rebuild'), ['contract-1', '2026-10-01']);
			expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
				'holding-1',
				expect.objectContaining({ metadata: expect.objectContaining({ failure_stage: 'post_invoice', erp_error: expect.objectContaining({ category: 'folios_exhausted' }) }) })
			);
		});

		it('C: si Odoo dice que el documento sí quedó publicado, no se toca nada; si no se puede leer, tampoco', async () => {
			const posted = withErp({
				postInvoice: jest.fn().mockResolvedValue({ success: false, message: 'Falló después de publicar' }),
				readInvoiceState: jest.fn().mockResolvedValue({ state: 'posted', name: 'FAC 028401', edi_state: null }),
			});

			await posted.service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');
			expect(posted.invoiceRepository.update).toHaveBeenCalledTimes(1);
			expect(posted.invoiceRepository.update).not.toHaveBeenCalledWith('invoice-1', expect.objectContaining({ status: expect.anything() }));

			const unknown = withErp({
				postInvoice: jest.fn().mockRejectedValue(new Error(CAF_FAULT)),
				readInvoiceState: jest.fn().mockRejectedValue(new Error('timeout')),
			});
			const result = await unknown.service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(result.status).toBe('error');
			expect(unknown.invoiceRepository.update).toHaveBeenCalledTimes(1);
			expect(unknown.query).not.toHaveBeenCalled();
		});

		it('C: si la factura seguía Por Emitir sin folio (el webhook no llegó), no se reescribe', async () => {
			const { service, invoiceRepository, query } = withErp({
				postInvoice: jest.fn().mockRejectedValue(new Error(CAF_FAULT)),
				readInvoiceState: jest.fn().mockResolvedValue({ state: 'draft', name: '/', edi_state: null }),
			});
			invoiceRepository.findOne.mockResolvedValue({ id: 'invoice-1', status: 'Por Emitir', invoice_number: null, contract_id: 'contract-1' });

			await service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(invoiceRepository.update).toHaveBeenCalledTimes(1);
			expect(query).not.toHaveBeenCalled();
		});

		it('D (28-10): publicada pero con el timbre rechazado queda Enviada (nunca Emitida), no se manda al cliente y se avisa con el motivo del SAT', async () => {
			const sendInvoiceToCustomer = jest.fn();
			const { service, invoiceRepository, notificationsService } = withErp({
				postInvoice: jest.fn().mockResolvedValue({ success: true, message: 'ok', state: 'posted' }),
				emitElectronicInvoice: jest.fn().mockResolvedValue({ success: true, state: 'posted', electronic_status: 'rejected', electronic_errors: [{ message: PAC_FAULT }] }),
				sendInvoiceToCustomer,
			});

			const result = await service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(result.status).toBe('error');
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', { status: 'Enviada' });
			expect(invoiceRepository.update).not.toHaveBeenCalledWith('invoice-1', expect.objectContaining({ status: 'Emitida' }));
			expect(sendInvoiceToCustomer).not.toHaveBeenCalled();
			expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
				'holding-1',
				expect.objectContaining({
					message: expect.stringMatching(/^El SAT rechazó el timbrado: el domicilio fiscal \(código postal\) del cliente/),
					metadata: expect.objectContaining({ failure_stage: 'emit_electronic_invoice', erp_error: expect.objectContaining({ category: 'electronic_rejected' }) }),
				})
			);
		});

		it('D: si el paso de timbre lanza, la factura publicada queda Enviada, no Emitida', async () => {
			const { service, invoiceRepository } = withErp({
				postInvoice: jest.fn().mockResolvedValue({ success: true, message: 'ok', state: 'posted' }),
				emitElectronicInvoice: jest.fn().mockRejectedValue(new Error(`Error emitiendo factura México en Odoo: XML-RPC Fault: ${PAC_FAULT}`)),
			});

			const result = await service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(result.errorType).toBe('emit_electronic_exception');
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', { status: 'Enviada' });
			expect(invoiceRepository.update).not.toHaveBeenCalledWith('invoice-1', expect.objectContaining({ status: 'Emitida' }));
		});

		it('timbre aceptado: Emitida y correo al cliente, como siempre', async () => {
			const sendInvoiceToCustomer = jest.fn().mockResolvedValue({ message: 'enviado' });
			const { service, invoiceRepository } = withErp({
				postInvoice: jest.fn().mockResolvedValue({ success: true, message: 'ok', state: 'posted' }),
				emitElectronicInvoice: jest.fn().mockResolvedValue({ success: true, state: 'posted', electronic_status: 'accepted' }),
				sendInvoiceToCustomer,
			});

			const result = await service.sendInvoiceToOdoo(autoInvoice(), false, 'automatic');

			expect(result.status).toBe('sent');
			expect(invoiceRepository.update).toHaveBeenCalledWith('invoice-1', { status: 'Emitida' });
			expect(sendInvoiceToCustomer).toHaveBeenCalled();
		});

		it('lastSendErrors: último intento por factura en una sola consulta; solo las que fallaron; si el log falla, mapa vacío', async () => {
			const { service } = createService();
			const internals = service as unknown as Record<string, unknown>;
			const exec = jest.fn().mockResolvedValue([
				{ _id: 'invoice-1', log: { operation: 'post_invoice', status: 'error', error_message: CAF_FAULT, error_type: 'odoo_post_exception', createdAt: new Date('2026-10-28T11:00:00Z') } },
				{ _id: 'invoice-2', log: { operation: 'create_draft', status: 'success', createdAt: new Date('2026-10-28T11:00:00Z') } },
			]);
			const aggregate = jest.fn().mockReturnValue({ exec });

			internals.invoiceOdooSendLogModel = { aggregate };

			const errors = await service.lastSendErrors('holding-1', ['invoice-1', 'invoice-2']);

			expect(aggregate).toHaveBeenCalledWith([
				{ $match: { holding_id: 'holding-1', invoice_id: { $in: ['invoice-1', 'invoice-2'] } } },
				{ $sort: { createdAt: -1 } },
				{ $group: { _id: '$invoice_id', log: { $first: '$$ROOT' } } },
			]);
			expect([...errors.keys()]).toEqual(['invoice-1']);
			expect(errors.get('invoice-1')).toMatchObject({ ok: false, category: 'folios_exhausted', message: expect.stringMatching(/^Se acabaron los folios/) });
			expect(await service.lastSendErrors('holding-1', [])).toEqual(new Map());
			exec.mockRejectedValueOnce(new Error('sin mongo'));
			expect(await service.lastSendErrors('holding-1', ['invoice-1'])).toEqual(new Map());
		});

		it('rechaza la factura (skipped), registra el log, notifica por el camino de fallos de Odoo y no llama al ERP', async () => {
			const { service, createDraftInvoice, sendLog, notificationsService } = withRepos(
				{ 'p-ok': 77 },
				{ 'p-ok': { name: 'Plan Pro', odoo_product_id: null }, 'p-x': { name: 'Soporte Premium', odoo_product_id: null } }
			);

			const result = await service.sendInvoiceToOdoo(invoiceWith([line('a', 'p-ok'), line('b', 'p-x')]), false, 'automatic');

			expect(result.status).toBe('skipped');
			expect(result.error).toBe('Productos sin mapeo a Odoo: Soporte Premium');
			expect(createDraftInvoice).not.toHaveBeenCalled();
			expect(sendLog).toHaveBeenCalledWith(
				expect.objectContaining({
					status: 'skipped',
					errorType: 'product_without_erp_mapping',
					errorDetails: { unmapped_products: ['Soporte Premium'] },
				})
			);
			expect(notificationsService.createOrUpdate).toHaveBeenCalledWith(
				'holding-1',
				expect.objectContaining({
					type: 'invoice_odoo_failure',
					resource_id: 'invoice-1',
					title: 'No se pudo enviar la factura INV-001 de Cliente Demo',
					message:
						'Hay productos sin mapeo en Odoo: Soporte Premium. Relaciona el producto en Integraciones › ERP › Mapeos y vuelve a enviarla.',
					recommendation: 'Relaciona el producto en Integraciones › ERP › Mapeos y vuelve a enviarla',
					// Agrupada por compañía, día de negocio, etapa y causa (28-10); la factura va en la lista.
					deduplication_key: expect.stringMatching(/^invoice-odoo-failure:company-1:\d{4}-\d{2}-\d{2}:product_mapping:product_without_mapping:[0-9a-f]{8}$/),
					metadata: expect.objectContaining({ invoice_count: 1, invoices: [expect.objectContaining({ id: 'invoice-1', invoice_number: 'INV-001' })] }),
				})
			);
		});

		it('Notificaciones v2: al enviar bien la factura se cierran sus avisos de falla (todas las etapas); un error al cerrar no rompe el envío', async () => {
			const { service, notificationsService } = withRepos({}, {});
			const invoice = invoiceWith([]);

			await (service as unknown as { resolveOdooFailureNotifications: (value: unknown) => Promise<void> }).resolveOdooFailureNotifications(
				invoice
			);
			expect(notificationsService.resolveOpen).toHaveBeenCalledWith('holding-1', { type: 'invoice_odoo_failure', resourceId: 'invoice-1' });

			notificationsService.resolveOpen.mockRejectedValueOnce(new Error('sin base'));
			await expect(
				(service as unknown as { resolveOdooFailureNotifications: (value: unknown) => Promise<void> }).resolveOdooFailureNotifications(
					invoice
				)
			).resolves.toBeUndefined();
		});

		it('en dry run omite igual pero no notifica', async () => {
			const { service, notificationsService } = withRepos({}, { 'p-x': { name: 'Soporte', odoo_product_id: null } });

			await expect(service.sendInvoiceToOdoo(invoiceWith([line('a', 'p-x')]), true)).resolves.toMatchObject({
				status: 'skipped',
				error: 'Productos sin mapeo a Odoo: Soporte',
			});
			expect(notificationsService.createOrUpdate).not.toHaveBeenCalled();
			expect(notificationsService.resolveOpen).not.toHaveBeenCalled();
		});

		it('resuelve por odoo_product_mappings del holding o por products.odoo_product_id; mira solo las líneas que viajan (no internas ni en cero)', async () => {
			const { service } = withRepos(
				{ 'p-map': 10 },
				{
					'p-map': { name: 'Mapeado', odoo_product_id: null },
					'p-tab': { name: 'Por tabla', odoo_product_id: 20 },
					'p-x': { name: 'Sin mapeo', odoo_product_id: null },
				}
			);
			const invoice = invoiceWith([
				line('a', 'p-map'),
				line('b', 'p-tab'),
				line('zero', 'p-x', { quantity: 0 }),
				line('internal', 'p-x', { visible_line_id: 'a' }),
			]);

			await expect(service.findUnmappedProducts(invoice)).resolves.toEqual([]);
			const payload = await service.mapInvoiceToOdooFormat(invoice);

			expect(payload.invoice_line_ids.map((item) => item.product_id)).toEqual([10, 20]);
		});

		it('una línea visible sin producto también se rechaza (antes viajaba como producto 1)', async () => {
			const { service } = withRepos({}, {});

			await expect(service.findUnmappedProducts(invoiceWith([line('a', null, { description: 'Servicio X' })]))).resolves.toEqual([
				'línea sin producto (Servicio X)',
			]);
		});

		it('si se llama al mapeo directo con un producto sin mapeo, lanza en vez de usar el producto 1', async () => {
			const { service } = withRepos({}, { 'p-x': { name: 'Sin mapeo', odoo_product_id: null } });

			await expect(service.mapInvoiceToOdooFormat(invoiceWith([line('a', 'p-x')]))).rejects.toThrow('product_without_erp_mapping');
		});
	});

	describe('prefactura sin OC (Domi 07-10): sin la referencia exigida se emite solo con OC; como borrador se envía igual', () => {
		const withLinks = (links: number) => {
			const ctx = createService();
			const internals = ctx.service as unknown as Record<string, unknown>;
			const query = jest.fn().mockResolvedValue([{ count: links }]);
			const createDraftInvoice = jest.fn();

			internals.dataSource = { query };
			internals.odooInvoicesService = { createDraftInvoice };
			const sendLog = jest.spyOn(ctx.service as never, 'createOdooSendLog').mockResolvedValue(undefined as never);

			return { ...ctx, query, createDraftInvoice, sendLog };
		};
		const invoiceWith = (overrides: Record<string, unknown>) =>
			({ ...buildInvoice('Chile', null, []), contract: { requires_references_for_billing: true }, ...overrides }) as any;

		it('con emisión automática y sin referencias (propias ni vinculadas) se omite con motivo, se registra y no llega al ERP', async () => {
			const { service, createDraftInvoice, sendLog, notificationsService, query } = withLinks(0);

			const result = await service.sendInvoiceToOdoo(invoiceWith({ auto_invoice: true }), false, 'automatic');

			expect(result).toMatchObject({
				status: 'skipped',
				errorType: 'needs_reference',
				error: 'El contrato exige una referencia (por ejemplo, la OC) y la factura se emite sin ninguna: no se envía al ERP',
			});
			expect(query).toHaveBeenCalledWith(expect.stringContaining('invoice_reference_links'), ['invoice-1']);
			expect(sendLog).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', errorType: 'needs_reference' }));
			expect(createDraftInvoice).not.toHaveBeenCalled();
			expect(notificationsService.createOrUpdate).not.toHaveBeenCalled();
		});

		it('la exigencia puede venir de la factura misma', async () => {
			const { service } = withLinks(0);

			await expect(
				service.missingReferenceForIssue(invoiceWith({ auto_invoice: true, contract: null, requires_references_for_billing: true }))
			).resolves.toContain('no se envía al ERP');
		});

		it('como borrador (sin emisión automática) no se omite: el borrador viaja sin OC', async () => {
			const { service, query } = withLinks(0);

			await expect(service.missingReferenceForIssue(invoiceWith({ auto_invoice: false }))).resolves.toBeNull();
			expect(query).not.toHaveBeenCalled();
		});

		it('con una referencia propia o vinculada desde el contrato, o sin exigencia, se envía', async () => {
			const linked = withLinks(1);

			await expect(linked.service.missingReferenceForIssue(invoiceWith({ auto_invoice: true }))).resolves.toBeNull();

			const own = withLinks(0);

			await expect(
				own.service.missingReferenceForIssue({
					...buildInvoice('Chile', new Date('2026-07-01')),
					contract: { requires_references_for_billing: true },
					auto_invoice: true,
				})
			).resolves.toBeNull();
			expect(own.query).not.toHaveBeenCalled();
			await expect(own.service.missingReferenceForIssue(invoiceWith({ auto_invoice: true, contract: null }))).resolves.toBeNull();
		});
	});

	describe('precio al ERP con descuento (TOPGROUP 09-10): el ERP no descuenta dos veces', () => {
		it('línea con modelo de precio (unitario ya descontado: cantidad × unitario = subtotal) → se manda el unitario sin descontar', () => {
			// CTR-2026-85: 5,269 × 68.910,887401 = 363.091,46 (ya con el 25 %) → al ERP 91.881,18 con 25 %.
			const unit = InvoiceSchedulerService.erpPriceUnit(68910.887401, 5.269, 25, 363091.46);

			expect(unit).toBeCloseTo(91881.183201, 4);
			expect(5.269 * unit * 0.75).toBeCloseTo(363091.46, 0);
		});

		it('línea estándar (subtotal = cantidad × unitario × (1 − descuento)) → el unitario va tal cual', () => {
			expect(InvoiceSchedulerService.erpPriceUnit(100, 2, 10, 180)).toBe(100);
		});

		it('sin descuento, descuento 100 % o sin subtotal → tal cual', () => {
			expect(InvoiceSchedulerService.erpPriceUnit(100, 2, 0, 200)).toBe(100);
			expect(InvoiceSchedulerService.erpPriceUnit(100, 2, 100, 0)).toBe(100);
			expect(InvoiceSchedulerService.erpPriceUnit(100, 2, 25, null)).toBe(100);
		});
	});
});
