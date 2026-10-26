// `InvoiceSchedulerService` importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import type { ExchangeRatesService } from '@/modules/banco-central/services/exchange-rates.service';
import type { FacturaClientService } from '@/modules/factura/factura-client.service';
import type { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';

import { ContractInvoiceDteController } from './contract-invoice-dte.controller';
import { ContractInvoiceDteService } from './contract-invoice-dte.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { CreateDebitNoteDto } from './dtos/contract-invoice-dte.dto';

import type { ContractsService } from './contracts.service';

type Row = Record<string, unknown>;

const CONTRACT_ID = '5a12436a-ce2d-4129-a924-e3bc0d999cb5';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOLDING = 'h-1';
const COMPANY = '1bdded45-cda6-4148-a425-fa0086e27ce8';
const TODAY = new Date('2026-10-18T12:00:00Z');

/** Contrato en UF de una compañía sin ERP (como el contrato real de la primera factura). */
const contextRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-200',
	status: 'Activo',
	fx_invoice_policy: 'spot',
	requires_references_for_billing: false,
	auto_send_to_odoo: false,
	payment_terms: { kind: 'net', days: 30 },
	client_entity_id: 'entity-1',
	odoo_partner_id: null,
	entity_payment_terms: null,
	company_country: 'Chile',
	odoo_integration_id: null,
	cutoff_date: null,
};

const invoiceRow = (overrides: Row = {}): Row => ({
	id: INVOICE_ID,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-10-18',
	original_issue_date: '2026-10-18',
	scheduled_at: '2026-10-18',
	due_date: null,
	contract_currency: 'CLF',
	invoice_currency: 'CLP',
	amount_contract_currency: '20',
	amount_invoice_currency: null,
	vat: '3.8',
	total_invoice_currency: null,
	fx_contract_to_invoice: null,
	tax_rate: '19',
	fx_rate_source: null,
	issued_externally: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	dte_id: null,
	dte_status: null,
	dte_folio: null,
	auto_invoice: false,
	requires_references_for_billing: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: COMPANY,
	legal_name: 'Comercializadora de Tecnologias Lenosoft Limitada',
	period_start: '2026-10-18',
	period_end: '2026-11-17',
	lines_count: '1',
	lines_without_product: '0',
	priced_base: '20',
	references_count: '0',
	internal_lines: '0',
	...overrides,
});

const extraRow = (overrides: Row = {}): Row => ({
	related_invoice_id: null,
	credit_type: null,
	due_date: null,
	contract_document_code: '33',
	has_electronic_invoicing: true,
	tax_id: '76.120.605-2',
	receptor_legal_name: 'Comercializadora de Tecnologias Lenosoft Limitada',
	economic_activity: 'CONSULTORÍA INFORMÁTICA, DE GESTIÓN Y VENTA DE SOFTWARE',
	legal_address: 'Costanera 408',
	commune: 'San Bernardo',
	email: 'dte@lenosoft.cl',
	client_entity_id: 'entity-1',
	...overrides,
});

const lineRow: Row = {
	id: 'line-1',
	description: 'Desarrollo de Software Cuenta Sucurdal Norte - Periodo 18/10/2026 a 17/11/2026',
	quantity: '1',
	unit_of_measure: 'UND',
	unit_price_contract_currency: '20',
	subtotal_contract_currency: '20',
	tax_amount_contract_currency: '3.8',
	total_contract_currency: '23.8',
	unit_price_invoice_currency: null,
	subtotal_invoice_currency: null,
	tax_amount_invoice_currency: null,
	total_invoice_currency: null,
	created_at: '2026-10-01',
	visible_line_id: null,
};

const dteRow = (overrides: Row = {}): Row => ({
	id: INVOICE_ID,
	holding_id: HOLDING,
	contract_id: CONTRACT_ID,
	company_id: COMPANY,
	dte_id: 'dte-1',
	dte_folio: 15,
	dte_status: 'enviado',
	dte_receptor_sent_at: null,
	dte_receptor_error: null,
	receptor_email: 'dte@lenosoft.cl',
	...overrides,
});

const UF = 39_485.65;

const build = (
	options: { invoice?: Row; extra?: Row; dte?: Row; pending?: Row[]; lines?: Row[]; references?: Row[]; original?: Row; status?: Row } = {}
) => {
	let events = 0;
	const route = (sql: string): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('SELECT status, dte_id, dte_status FROM invoices'))
			return [options.status ?? { status: 'Por Emitir', dte_id: null, dte_status: null }];
		if (sql.includes('dte_tipo, dte_status FROM invoices')) return options.original ? [options.original] : [];
		if (sql.includes('get_cutoff_date')) return [contextRow];
		if (sql.includes('priced_base')) return [options.invoice ?? invoiceRow()];
		if (sql.includes('FROM invoice_references WHERE')) return options.references ?? [];
		if (sql.includes('has_electronic_invoicing')) return [options.extra ?? extraRow()];
		if (sql.includes('FROM invoice_items ii')) return options.lines ?? [lineRow];
		if (sql.includes('receptor_email') && sql.includes('LIMIT $1')) return options.pending ?? [];
		if (sql.includes('receptor_email')) return [options.dte ?? dteRow()];
		if (sql.includes("UPDATE invoices SET status = 'Emitida'")) return [{ id: INVOICE_ID }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${++events}` }];

		return [];
	};
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: jest.fn(route),
	};
	const dataSource = { query: jest.fn(route), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
	const contracts = {
		resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID, status: 'Activo' }),
		invoiceDetail: jest.fn().mockResolvedValue({ id: INVOICE_ID }),
	} as unknown as ContractsService;
	const invoices = new ContractInvoicesService(dataSource, contracts, {} as InvoiceSchedulerService);
	const factura = {
		crearDte: jest.fn().mockResolvedValue({ id: 'dte-1', folio: 15, tipoDte: 33, ambiente: 'produccion', existente: false }),
		enviarDte: jest.fn().mockResolvedValue({ trackId: '0262800001' }),
		estadoDte: jest.fn().mockResolvedValue({ resultado: 'aceptado', estado: 'EPR', glosaEstado: 'Envio Procesado', trackId: '0262800001' }),
		enviarReceptor: jest.fn().mockResolvedValue({ para: 'dte@lenosoft.cl', messageId: 'msg-1' }),
		documentoDte: jest.fn().mockResolvedValue({ contenido: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'DTE-33-15.pdf' }),
		previewPdfDte: jest
			.fn()
			.mockResolvedValue({ contenido: Buffer.from('%PDF-borrador'), contentType: 'application/pdf', fileName: 'Borrador.pdf' }),
	};
	// Tasa del día anterior (no había del día de emisión): la nota de la línea dice de qué día es.
	const exchangeRates = {
		getExchangeRateWithFallback: jest.fn().mockResolvedValue({ rate: UF, is_fallback: true, rate_date: new Date(2026, 9, 17) }),
	};
	const service = new ContractInvoiceDteService(
		dataSource,
		contracts,
		invoices,
		factura as unknown as FacturaClientService,
		exchangeRates as unknown as ExchangeRatesService
	);

	return { service, runner, dataSource, factura, exchangeRates };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));

describe('ContractInvoiceDteService (emisión de DTE con el servicio de facturación electrónica)', () => {
	it('vista previa: factura 33 en pesos con la UF del día, receptor y totales; sin escribir', async () => {
		const { service, runner, factura, exchangeRates } = build();
		const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);

		expect(exchangeRates.getExchangeRateWithFallback).toHaveBeenCalledWith('CLF', 'CLP', '2026-10-18');
		// 20 UF × 39.485,65 = 789.713 pesos; IVA 19 % = 150.045; total 939.758.
		expect(preview.document).toMatchObject({
			tipo: 33,
			issue_date: '2026-10-18',
			due_date: '2026-11-17',
			neto: 789713,
			iva: 150045,
			total: 939758,
			fx: UF,
			fx_currency: 'CLF',
			receptor: { tax_id: '76.120.605-2', commune: 'San Bernardo', email: 'dte@lenosoft.cl' },
		});
		expect(preview.can_apply).toBe(true);
		expect(preview.warnings.map((warning: { code: string }) => warning.code)).toEqual(['dte_giro_truncated']);
		expect(factura.crearDte).not.toHaveBeenCalled();
		expect(runner.query).not.toHaveBeenCalled();
	});

	it('emite: crea el DTE con la factura como referencia, lo envía al SII y deja la factura Emitida con el folio', async () => {
		const { service, runner, factura } = build();
		const result = await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);

		const [companyId, body, externalRef] = factura.crearDte.mock.calls[0];
		expect(companyId).toBe(COMPANY);
		expect(externalRef).toBe(INVOICE_ID);
		expect(body.Encabezado.Receptor).toMatchObject({ RUTRecep: '76120605-2', CmnaRecep: 'San Bernardo' });
		expect(body.Encabezado.Totales).toEqual({ MntNeto: 789713, TasaIVA: 19, IVA: 150045, MntTotal: 939758 });
		expect(body.Detalle[0].DscItem).toBe('Valor: 20 UF × $39.485,65 (UF del 17-10-2026)');
		expect(factura.enviarDte).toHaveBeenCalledWith(COMPANY, 'dte-1');

		// Vínculo guardado antes de enviar, y la emisión después.
		const link = calls(runner.query, "dte_status = 'creado'")[0];
		expect(link[1]).toEqual([INVOICE_ID, HOLDING, 'dte-1', 33, 15, 'produccion']);
		const issued = calls(runner.query, "UPDATE invoices SET status = 'Emitida'")[0];
		expect(issued[1]).toEqual([INVOICE_ID, HOLDING, '0262800001', '15', '2026-10-18', '2026-11-17', UF, 789713, 150045, 939758]);
		const line = calls(runner.query, 'UPDATE invoice_items SET unit_price_invoice_currency')[0];
		expect(line[1]).toEqual(['line-1', HOLDING, 789713, 789713, 150045, 939758, UF, '2026-10-18']);
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-10-01']);
		const event = calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1];
		expect(event[2]).toBe('INVOICE_ISSUED_DTE');
		expect(JSON.parse(event[7] as string)).toMatchObject({ invoice_id: INVOICE_ID, dte_id: 'dte-1', folio: 15, track_id: '0262800001' });
		expect(result.dte).toEqual({ id: 'dte-1', tipo: 33, folio: 15, track_id: '0262800001', ambiente: 'produccion', status: 'enviado' });
	});

	it('si el envío al SII falla, la factura queda Por Emitir con su DTE creado y avisa cómo terminar', async () => {
		const { service, runner, factura } = build();
		factura.enviarDte.mockRejectedValueOnce(new Error('El SII no respondió'));

		const error = await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY).catch((cause) => cause);

		expect(error).toBeInstanceOf(ConflictException);
		expect(error.getResponse()).toMatchObject({ code: 'dte_not_sent', dte: { id: 'dte-1', folio: 15 } });
		expect(calls(runner.query, "dte_status = 'creado'")).toHaveLength(1);
		expect(calls(runner.query, "UPDATE invoices SET status = 'Emitida'")).toHaveLength(0);
	});

	it('reintentar una factura con DTE creado reusa el mismo documento (la referencia externa evita otro folio)', async () => {
		const { service, factura } = build({ invoice: invoiceRow({ dte_id: 'dte-1', dte_status: 'creado', dte_folio: 15 }) });

		const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
		expect(preview.can_apply).toBe(true);
		expect(preview.document?.retry).toBe(true);
		await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);
		expect(factura.crearDte.mock.calls[0][2]).toBe(INVOICE_ID);
	});

	it('reemite una factura rechazada por el SII: documento nuevo con otro folio, vuelve a Por Emitir sin el folio rechazado y queda Emitida', async () => {
		const { service, runner, factura } = build({
			invoice: invoiceRow({ status: 'Emitida', invoice_number: '15', dte_id: 'dte-old', dte_status: 'rechazado', dte_folio: 15 }),
		});
		factura.crearDte.mockResolvedValueOnce({ id: 'dte-new', folio: 16, tipoDte: 33, ambiente: 'produccion', existente: false });

		const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
		expect(preview.can_apply).toBe(true);
		expect(preview.warnings.map((warning: { code: string }) => warning.code)).toContain('dte_reissue');

		await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);

		expect(factura.crearDte.mock.calls[0][2]).toBe(INVOICE_ID);
		expect(factura.crearDte.mock.calls[0][3]).toEqual({ reemitirRechazado: true });
		const [reset] = calls(runner.query, "dte_status = 'creado'");
		expect(reset[0]).toContain('invoice_number = NULL');
		expect(reset[0]).toContain("status = 'Por Emitir'");
		expect(reset[0]).toContain("OR dte_status = 'rechazado'");
		expect(reset[1]).toEqual([INVOICE_ID, HOLDING, 'dte-new', 33, 16, 'produccion']);
		expect(calls(runner.query, "UPDATE invoices SET status = 'Emitida'")).toHaveLength(1);
		expect(JSON.stringify(runner.query.mock.calls)).toContain('N° 16 reemitida');
	});

	it('una emisión normal no pide reemitir', async () => {
		const { service, factura } = build();

		await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);
		expect(factura.crearDte.mock.calls[0][3]).toEqual({ reemitirRechazado: false });
	});

	it('bloquea sin facturación electrónica, con receptor incompleto o sin tipo de cambio, y no llama al servicio', async () => {
		const { service, factura } = build({ extra: extraRow({ has_electronic_invoicing: false, commune: null }) });
		const error = await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY).catch((cause) => cause);

		expect(error).toBeInstanceOf(ConflictException);
		expect(error.getResponse().blockers.map((blocker: { code: string }) => blocker.code)).toEqual([
			'no_electronic_invoicing',
			'dte_receptor_commune',
		]);
		expect(factura.crearDte).not.toHaveBeenCalled();

		const withoutRate = build();
		withoutRate.exchangeRates.getExchangeRateWithFallback.mockRejectedValueOnce(new Error('sin tasa'));
		const preview = await withoutRate.service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
		expect(preview.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['fx_rate_missing']);
	});

	it('NC de anulación: DTE 61 en positivo con la referencia CodRef 1 al folio de la factura; guarda el folio sin cambiar su estado', async () => {
		const { service, runner, factura } = build({
			invoice: invoiceRow({ document_type: 'NC', status: 'Cancelada', invoice_number: null, fx_contract_to_invoice: String(UF) }),
			extra: extraRow({ related_invoice_id: 'orig', credit_type: 'cancellation', due_date: null }),
			original: { id: 'orig', invoice_number: '15', issue_date: '2026-10-18', dte_tipo: 33, dte_status: 'aceptado' },
			references: [{ document_type_code: '33', document_number: 'orig', reference_date: null, reference_code: '1', reason: 'Anula 15: error' }],
			lines: [{ ...lineRow, quantity: '1', subtotal_invoice_currency: '-789713', tax_amount_invoice_currency: '-150045' }],
		});
		factura.crearDte.mockResolvedValueOnce({ id: 'dte-61', folio: 3, tipoDte: 61, ambiente: 'produccion', existente: false });

		await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);

		const body = factura.crearDte.mock.calls[0][1];
		expect(body.Encabezado.IdDoc).toEqual({ TipoDTE: 61, FchEmis: '2026-10-18' });
		expect(body.Encabezado.Totales).toEqual({ MntNeto: 789713, TasaIVA: 19, IVA: 150045, MntTotal: 939758 });
		expect(body.Referencia).toEqual([
			{ NroLinRef: 1, TpoDocRef: '33', FolioRef: '15', FchRef: '2026-10-18', CodRef: 1, RazonRef: 'Anula 15: error' },
		]);
		expect(calls(runner.query, "UPDATE invoices SET status = 'Emitida'")).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoices SET invoice_number = $4')[0][1]).toEqual([INVOICE_ID, HOLDING, '0262800001', '3', '2026-10-18']);
	});

	it('NC: bloquea si la factura original todavía no está aceptada por el SII', async () => {
		const { service } = build({
			invoice: invoiceRow({ document_type: 'NC', status: 'Emitida', invoice_number: null, fx_contract_to_invoice: String(UF) }),
			extra: extraRow({ related_invoice_id: 'orig', credit_type: 'discount' }),
			original: { id: 'orig', invoice_number: '15', issue_date: '2026-10-18', dte_tipo: 33, dte_status: 'enviado' },
		});

		const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
		expect(preview.blockers.map((blocker: { code: string }) => blocker.code)).toEqual(['original_not_accepted']);
	});

	it('estado: aceptado por el SII guarda el estado y entrega el documento al cliente', async () => {
		const { service, runner, factura } = build();
		const result = await service.refreshDteStatus(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1');

		expect(factura.estadoDte).toHaveBeenCalledWith(COMPANY, 'dte-1');
		expect(calls(runner.query, 'UPDATE invoices SET dte_status = $3')[0][1]).toEqual([INVOICE_ID, HOLDING, 'aceptado', 'EPR: Envio Procesado']);
		expect(factura.enviarReceptor).toHaveBeenCalledWith(COMPANY, 'dte-1', 'dte@lenosoft.cl');
		expect(calls(runner.query, 'dte_receptor_sent_at = now()')).toHaveLength(1);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events').map(([, params]) => (params as unknown[])[2])).toEqual([
			'INVOICE_DTE_STATUS_CHANGED',
			'INVOICE_DTE_SENT_TO_RECEPTOR',
		]);
		expect(result).toMatchObject({ dte_status: 'aceptado', consulted: true, delivery: { para: 'dte@lenosoft.cl', sent: true } });
	});

	it('estado: un error al entregar al cliente queda guardado; reenviar exige el documento aceptado', async () => {
		const { service, runner, factura } = build({ dte: dteRow({ dte_status: 'aceptado' }) });
		factura.enviarReceptor.mockRejectedValueOnce(new Error('El integrador no tiene canal de correo configurado'));

		await expect(service.sendDteToReceptor(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1')).rejects.toMatchObject({
			response: { code: 'dte_receptor_failed' },
		});
		expect(calls(runner.query, 'dte_receptor_error = $4')[0][1]).toEqual([
			INVOICE_ID,
			HOLDING,
			'dte@lenosoft.cl',
			'El integrador no tiene canal de correo configurado',
		]);

		const pending = build({ dte: dteRow({ dte_status: 'enviado' }) });
		await expect(pending.service.sendDteToReceptor(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1')).rejects.toMatchObject({
			response: { code: 'dte_not_accepted' },
		});
	});

	it('job: consulta los enviados y entrega los aceptados, sin dejar eventos (no hay usuario)', async () => {
		const { service, runner, factura } = build({ pending: [dteRow(), dteRow({ id: 'otra', dte_id: 'dte-2', dte_status: 'aceptado' })] });

		await expect(service.pollPendingDtes()).resolves.toEqual({ consulted: 1, delivered: 2, failed: 0 });
		expect(factura.estadoDte).toHaveBeenCalledTimes(1);
		expect(factura.enviarReceptor).toHaveBeenCalledTimes(2);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')).toHaveLength(0);
	});

	it('PDF en borrador: el mismo cuerpo de «Emitir», sin gastar folio ni escribir', async () => {
		const { service, runner, factura } = build();
		const pdf = await service.previewDtePdf(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);

		expect(pdf.fileName).toBe('Borrador.pdf');
		const [companyId, body] = factura.previewPdfDte.mock.calls[0];
		expect(companyId).toBe(COMPANY);
		expect(body.Encabezado.Totales).toEqual({ MntNeto: 789713, TasaIVA: 19, IVA: 150045, MntTotal: 939758 });
		expect(factura.crearDte).not.toHaveBeenCalled();
		expect(runner.query).not.toHaveBeenCalled();
	});

	it('documento: PDF del DTE de la factura desde el servicio de facturación', async () => {
		const { service, factura } = build({ dte: dteRow({ dte_status: 'aceptado' }) });

		await expect(service.dteDocument(CONTRACT_ID, INVOICE_ID, HOLDING, 'pdf', 'cedible')).resolves.toMatchObject({ fileName: 'DTE-33-15.pdf' });
		expect(factura.documentoDte).toHaveBeenCalledWith(COMPANY, 'dte-1', 'pdf', 'cedible');
	});

	it('nota de débito: valida el monto y el motivo', async () => {
		const errors = await validate(plainToInstance(CreateDebitNoteDto, { amount: 0, reason: ' ' }));

		expect(errors.map((error) => error.property).sort()).toEqual(['amount', 'reason']);
		expect(await validate(plainToInstance(CreateDebitNoteDto, { amount: 10000, reason: 'Intereses por mora' }))).toEqual([]);
	});
});

describe('ContractInvoiceDteController', () => {
	const dteService = {
		previewEmitDte: jest.fn().mockResolvedValue({}),
		emitDte: jest.fn().mockResolvedValue({}),
		refreshDteStatus: jest.fn().mockResolvedValue({}),
		sendDteToReceptor: jest.fn().mockResolvedValue({}),
		dteDocument: jest.fn().mockResolvedValue({ contenido: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'DTE-33-15.pdf' }),
		previewDtePdf: jest.fn().mockResolvedValue({ contenido: Buffer.from('%PDF'), contentType: 'application/pdf', fileName: 'Borrador.pdf' }),
		previewDebitNote: jest.fn().mockResolvedValue({}),
		createDebitNote: jest.fn().mockResolvedValue({}),
	};
	const controller = new ContractInvoiceDteController(dteService as unknown as ContractInvoiceDteService);
	const routeOf = (handler: keyof ContractInvoiceDteController) => ({
		path: Reflect.getMetadata(PATH_METADATA, ContractInvoiceDteController.prototype[handler]),
		method: Reflect.getMetadata(METHOD_METADATA, ContractInvoiceDteController.prototype[handler]),
		code: Reflect.getMetadata(HTTP_CODE_METADATA, ContractInvoiceDteController.prototype[handler]),
	});

	describe('factura de exportación (110, 112)', () => {
		const exportInvoice = (overrides: Row = {}) =>
			invoiceRow({
				document_type: 'FACTURA_EXPORTACION',
				contract_currency: 'USD',
				invoice_currency: 'USD',
				amount_contract_currency: '1550.5',
				vat: '0',
				tax_rate: '0',
				...overrides,
			});
		const exportExtra = (overrides: Row = {}) =>
			extraRow({
				contract_document_code: '110',
				export_type: 1,
				tax_id: '98-7654321',
				receptor_legal_name: 'Example Client Inc.',
				economic_activity: 'Software services',
				legal_address: '100 Example Street',
				commune: null,
				country_code: 'US',
				city: 'Miami',
				contract_export_details: { kind: 'servicios', sale_clause: 5, payment_form: 1 },
				invoice_export_details: null,
				...overrides,
			});
		const exportLine = {
			...lineRow,
			description: 'Desarrollo de software',
			subtotal_contract_currency: '1550.5',
			tax_amount_contract_currency: '0',
		};
		const rates = (table: Record<string, number>) =>
			jest.fn(async (from: string, to: string) => {
				const rate = table[`${from}/${to}`];
				if (!rate) throw new Error(`sin tasa ${from}/${to}`);
				return { rate, rate_date: new Date(2026, 9, 18) };
			});

		it('emite una 110 en dólares: receptor extranjero, Aduana del contrato y total en pesos con el dólar observado', async () => {
			const { service, factura, exchangeRates } = build({ invoice: exportInvoice(), extra: exportExtra(), lines: [exportLine] });
			exchangeRates.getExchangeRateWithFallback = rates({ 'USD/CLP': 950.25 });
			factura.crearDte.mockResolvedValue({ id: 'dte-1', folio: 3, tipoDte: 110, ambiente: 'produccion', existente: false });

			const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
			expect(preview.document).toMatchObject({
				tipo: 110,
				currency: 'USD',
				total: 1550.5,
				iva: 0,
				export: { services: true, clp_rate: 950.25, total_clp: 1473363 },
			});
			expect(preview.can_apply).toBe(true);

			await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);
			const body = factura.crearDte.mock.calls[0][1];
			expect(body.Encabezado.IdDoc).toEqual({ TipoDTE: 110, FchEmis: '2026-10-18', IndServicio: 3, FmaPagExp: 1, FchVenc: '2026-11-17' });
			expect(body.Encabezado.Receptor).toMatchObject({
				RUTRecep: '55555555-5',
				Extranjero: { NumId: '98-7654321', Nacionalidad: '225' },
				CiudadRecep: 'Miami',
			});
			expect(body.Encabezado.Receptor).not.toHaveProperty('CmnaRecep');
			expect(body.Encabezado.Transporte).toEqual({ Aduana: { CodClauVenta: 5, CodPaisRecep: 225, CodPaisDestin: 225 } });
			expect(body.Encabezado.Totales).toEqual({ TpoMoneda: 'DOLAR USA', MntExe: 1550.5, MntTotal: 1550.5 });
			expect(body.Encabezado.OtraMoneda).toEqual({ TpoMoneda: 'PESO CL', TpoCambio: 950.25, MntExeOtrMnda: 1473363, MntTotOtrMnda: 1473363 });
		});

		it('en euros el tipo de cambio es EUR → USD × dólar observado; sin tasa, bloquea la emisión', async () => {
			const enEuros = build({
				invoice: exportInvoice({ contract_currency: 'EUR', invoice_currency: 'EUR' }),
				extra: exportExtra(),
				lines: [exportLine],
			});
			enEuros.exchangeRates.getExchangeRateWithFallback = rates({ 'USD/CLP': 950, 'EUR/USD': 1.08 });
			const preview = await enEuros.service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
			expect(preview.document).toMatchObject({ currency: 'EUR', export: { clp_rate: 1026 } });

			const sinTasa = build({ invoice: exportInvoice(), extra: exportExtra(), lines: [exportLine] });
			sinTasa.exchangeRates.getExchangeRateWithFallback = rates({});
			const bloqueada = await sinTasa.service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
			expect(bloqueada.can_apply).toBe(false);
			expect(bloqueada.blockers.map((blocker: { code: string }) => blocker.code)).toContain('dte_export_fx_missing');
		});

		it('una factura de bienes lleva el embarque y el DUS como referencia 807', async () => {
			const { service, factura, exchangeRates } = build({
				invoice: exportInvoice({ invoice_currency: 'CLP', contract_currency: 'CLP' }),
				extra: exportExtra({
					contract_export_details: { kind: 'bienes', sale_clause: 5, transport_route: 1, port_of_loading: 906, port_of_unloading: 141 },
					invoice_export_details: { total_packages: 30, package_type: 22, freight: 120, dus_number: '6012345', dus_date: '2026-10-17' },
				}),
				lines: [{ ...exportLine, subtotal_contract_currency: '1500000' }],
			});
			factura.crearDte.mockResolvedValue({ id: 'dte-1', folio: 3, tipoDte: 110, ambiente: 'produccion', existente: false });

			await service.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', TODAY);
			const body = factura.crearDte.mock.calls[0][1];
			expect(exchangeRates.getExchangeRateWithFallback).not.toHaveBeenCalled();
			expect(body.Encabezado.IdDoc).not.toHaveProperty('IndServicio');
			expect(body.Encabezado.Transporte.Aduana).toMatchObject({ CodViaTransp: 1, CodPtoEmbarque: 906, TotBultos: 30, MntFlete: 120 });
			expect(body.Encabezado.Totales).toEqual({ TpoMoneda: 'PESO CL', MntExe: 1500000, MntTotal: 1500000 });
			expect(body.Encabezado).not.toHaveProperty('OtraMoneda');
			expect(body.Referencia).toEqual([{ NroLinRef: 1, TpoDocRef: '807', FolioRef: '6012345', FchRef: '2026-10-17', RazonRef: 'DUS' }]);
		});

		it('la NC de una factura de exportación sale como 112 y referencia la 110', async () => {
			const { service, factura, exchangeRates } = build({
				invoice: exportInvoice({ document_type: 'NC', status: 'Emitida', fx_contract_to_invoice: null }),
				extra: exportExtra({ related_invoice_id: 'orig-1', credit_type: 'cancellation' }),
				lines: [{ ...exportLine, subtotal_contract_currency: '-1550.5' }],
				original: { id: 'orig-1', invoice_number: '3', issue_date: '2026-10-10', dte_tipo: 110, dte_status: 'aceptado' },
				references: [{ document_type_code: '110', document_number: '3', reference_date: '2026-10-10', reference_code: '1', reason: 'Anula' }],
			});
			exchangeRates.getExchangeRateWithFallback = rates({ 'USD/CLP': 950.25 });

			const preview = await service.previewEmitDte(CONTRACT_ID, INVOICE_ID, HOLDING, TODAY);
			expect(preview.document).toMatchObject({ tipo: 112, total: 1550.5 });
			expect(preview.document!.references).toEqual([{ type: '110', folio: '3', date: '2026-10-10', code: 1 }]);
			expect(factura.crearDte).not.toHaveBeenCalled();
		});

		it('guarda los datos de exportación del contrato y el embarque solo en una factura Por Emitir sin DTE', async () => {
			const { service, runner } = build();
			await expect(
				service.updateContractExportDetails(CONTRACT_ID, HOLDING, { kind: 'bienes', sale_clause: 5, port_of_loading: null })
			).resolves.toEqual({
				contract_id: CONTRACT_ID,
				export_details: { kind: 'bienes', sale_clause: 5 },
			});
			expect(calls(runner.query, 'UPDATE contracts SET export_details')[0][1]).toEqual([
				CONTRACT_ID,
				HOLDING,
				'{"kind":"bienes","sale_clause":5}',
			]);

			await expect(service.updateInvoiceExportDetails(CONTRACT_ID, INVOICE_ID, HOLDING, { total_packages: 3 })).resolves.toEqual({
				invoice_id: INVOICE_ID,
				export_details: { total_packages: 3 },
			});
			const emitida = build({ status: { status: 'Emitida', dte_id: 'dte-1', dte_status: 'aceptado' } });
			await expect(emitida.service.updateInvoiceExportDetails(CONTRACT_ID, INVOICE_ID, HOLDING, { total_packages: 3 })).rejects.toBeInstanceOf(
				ConflictException
			);
		});
	});

	it('rutas bajo `contracts/:id/invoices/:invoiceId/...`, tras SupabaseAuthGuard + HoldingScopeGuard (sin header 400, holding ajeno 403)', () => {
		expect(Reflect.getMetadata(PATH_METADATA, ContractInvoiceDteController)).toBe('contracts');
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractInvoiceDteController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		const [GET, POST] = [0, 1];

		expect(routeOf('emitDtePreview')).toEqual({ path: ':id/invoices/:invoiceId/emit-dte/preview', method: POST, code: 200 });
		expect(routeOf('emitDte')).toEqual({ path: ':id/invoices/:invoiceId/emit-dte', method: POST, code: 200 });
		expect(routeOf('emitDtePreviewPdf')).toEqual({ path: ':id/invoices/:invoiceId/emit-dte/preview-pdf', method: POST, code: 200 });
		expect(routeOf('refreshDteStatus')).toEqual({ path: ':id/invoices/:invoiceId/dte-status', method: POST, code: 200 });
		expect(routeOf('sendDteToReceptor')).toEqual({ path: ':id/invoices/:invoiceId/dte-send-receptor', method: POST, code: 200 });
		expect(routeOf('dteDocument')).toMatchObject({ path: ':id/invoices/:invoiceId/dte-document', method: GET });
		expect(routeOf('debitNotePreview')).toEqual({ path: ':id/invoices/:invoiceId/debit-note/preview', method: POST, code: 200 });
		expect(routeOf('createDebitNote')).toMatchObject({ path: ':id/invoices/:invoiceId/debit-note', method: POST });
		const PATCH = 4;
		expect(routeOf('updateContractExportDetails')).toMatchObject({ path: ':id/export-details', method: PATCH });
		expect(routeOf('updateInvoiceExportDetails')).toMatchObject({ path: ':id/invoices/:invoiceId/export-details', method: PATCH });
	});

	it('pasa el holding y el usuario al servicio, y devuelve el documento en base64', async () => {
		const req = { user: { sub: 'auth-1' } };

		await controller.emitDte(CONTRACT_ID, INVOICE_ID, HOLDING, req);
		expect(dteService.emitDte).toHaveBeenCalledWith(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1');
		await controller.sendDteToReceptor(CONTRACT_ID, INVOICE_ID, { email: 'otro@cliente.cl' }, HOLDING, req);
		expect(dteService.sendDteToReceptor).toHaveBeenCalledWith(CONTRACT_ID, INVOICE_ID, HOLDING, 'auth-1', 'otro@cliente.cl');
		await expect(controller.dteDocument(CONTRACT_ID, INVOICE_ID, { format: 'pdf' }, HOLDING)).resolves.toEqual({
			file_name: 'DTE-33-15.pdf',
			content_type: 'application/pdf',
			content_base64: Buffer.from('%PDF').toString('base64'),
		});
		expect(dteService.dteDocument).toHaveBeenCalledWith(CONTRACT_ID, INVOICE_ID, HOLDING, 'pdf', 'tributaria');
	});

	it('una factura de otro holding no se encuentra (404): el servicio acota por holding', async () => {
		const { service, dataSource } = build();
		(dataSource.query as jest.Mock).mockResolvedValue([]);

		await expect(service.dteDocument(CONTRACT_ID, INVOICE_ID, 'otro-holding', 'pdf')).rejects.toMatchObject({ status: 404 });
	});
});
