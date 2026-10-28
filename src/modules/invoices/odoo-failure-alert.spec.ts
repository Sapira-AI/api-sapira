import { translateErpError } from './erp-error-translation';
import {
	businessDay,
	contentInputFromMetadata,
	failureInvoicesOf,
	mergeFailureInvoice,
	ODOO_FAILURE_MAX_INVOICES,
	ODOO_FAILURE_WHAT_WE_DO,
	odooFailureContent,
	odooFailureGroupKey,
	type OdooFailureInvoice,
} from './odoo-failure-alert';

const CAF =
	'XML-RPC Fault: No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl (Code: 2)';
const PAC =
	'Error emitiendo factura México en Odoo: XML-RPC Fault: Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.';

const invoice = (n: number, overrides: Partial<OdooFailureInvoice> = {}): OdooFailureInvoice => ({
	id: `inv-${n}`,
	invoice_number: `FAC 0284${String(n).padStart(2, '0')}`,
	client_name: `Cliente ${n}`,
	contract_id: `ctr-${n}`,
	odoo_invoice_id: 201180 + n,
	issue_date: '2026-10-28',
	...overrides,
});

const simplit = { id: 'company-cl', legal_name: 'Simplit SpA', country: 'Chile' };

describe('odoo-failure-alert (alerta agrupada por causa, Domi 28-10)', () => {
	it('businessDay: fecha en la zona del negocio', () => {
		// 02:30 UTC del 29 todavía es 28 en Santiago (UTC-3).
		expect(businessDay(new Date('2026-10-29T02:30:00Z'), 'America/Santiago')).toBe('2026-10-28');
		expect(businessDay(new Date('2026-10-29T02:30:00Z'), 'zona/invalida')).toBe('2026-10-29');
	});

	it('la clave agrupa por compañía, día, etapa y causa traducida: las 29 del CAF comparten clave; otra compañía u otra causa, no', () => {
		const caf = translateErpError(CAF, 'odoo_post_exception');
		const key = odooFailureGroupKey({ companyId: 'company-cl', day: '2026-10-28', stage: 'post_invoice', translation: caf });

		expect(key).toMatch(/^invoice-odoo-failure:company-cl:2026-10-28:post_invoice:folios_exhausted:[0-9a-f]{8}$/);
		expect(odooFailureGroupKey({ companyId: 'company-cl', day: '2026-10-28', stage: 'post_invoice', translation: caf })).toBe(key);
		expect(odooFailureGroupKey({ companyId: 'company-mx', day: '2026-10-28', stage: 'post_invoice', translation: caf })).not.toBe(key);
		expect(odooFailureGroupKey({ companyId: 'company-cl', day: '2026-10-29', stage: 'post_invoice', translation: caf })).not.toBe(key);
		expect(odooFailureGroupKey({ companyId: 'company-cl', day: '2026-10-28', stage: 'create_draft', translation: caf })).not.toBe(key);
		// Mismo CAF agotado pero otra secuencia (otro folio en el mensaje) → otro aviso.
		const otraSecuencia = translateErpError(CAF.replace('28401', '910').replace('Electronic Invoice', 'Electronic Exempt Invoice'), 'odoo_post_exception');

		expect(odooFailureGroupKey({ companyId: 'company-cl', day: '2026-10-28', stage: 'post_invoice', translation: otraSecuencia })).not.toBe(key);
		expect(odooFailureGroupKey({ companyId: null, day: '2026-10-28', stage: 'post_invoice', translation: caf })).toContain(':sin-compania:');
	});

	it('failureInvoicesOf tolera metadata vieja o rota y mergeFailureInvoice reemplaza por id con tope', () => {
		expect(failureInvoicesOf(undefined)).toEqual([]);
		expect(failureInvoicesOf({ invoices: 'no' })).toEqual([]);
		expect(failureInvoicesOf({ invoices: [null, { id: '' }, { id: 'a', odoo_invoice_id: '5' }, { id: 'b', invoice_number: 'F-1', odoo_invoice_id: 7 }] })).toEqual([
			{ id: 'a', invoice_number: null, client_name: null, contract_id: null, odoo_invoice_id: null, issue_date: null },
			{ id: 'b', invoice_number: 'F-1', client_name: null, contract_id: null, odoo_invoice_id: 7, issue_date: null },
		]);
		const merged = mergeFailureInvoice([invoice(1), invoice(2)], invoice(1, { odoo_invoice_id: 999 }));

		expect(merged.map((item) => item.id)).toEqual(['inv-2', 'inv-1']);
		expect(merged[1].odoo_invoice_id).toBe(999);
		const many = Array.from({ length: ODOO_FAILURE_MAX_INVOICES }, (_, index) => invoice(index + 1));

		expect(mergeFailureInvoice(many, invoice(999))).toHaveLength(ODOO_FAILURE_MAX_INVOICES);
	});

	it('una sola factura: la forma de siempre (título con folio y cliente, Ver contrato, resource_id) más detalle técnico limpio y qué hacemos por etapa', () => {
		const translation = translateErpError(CAF, 'odoo_post_exception');
		const content = odooFailureContent({
			invoices: [invoice(1)],
			company: simplit,
			stage: 'post_invoice',
			translation,
			errorType: 'odoo_post_exception',
			errorMessage: CAF,
			schedulerSource: 'automatic',
			technicalTitle: 'Error al publicar factura FAC 028401 en Odoo',
			technicalMessage: 'Factura creada en Odoo con ID: 201181, pero falló la emisión',
			errorDetails: { stack: 'Error: …\n    at …' },
		});

		expect(content.title).toBe('No se pudo enviar la factura FAC 028401 de Cliente 1');
		expect(content.message).toBe(
			'Se acabaron los folios autorizados por el SII para facturas electrónicas (siguiente folio 28401). Solicita un CAF nuevo en sii.cl y cárgalo en Odoo; después confirma allí los borradores que quedaron sin folio.'
		);
		expect(content.action_type).toBe('open_contract');
		expect(content.action_payload).toEqual({ contract_id: 'ctr-1' });
		expect(content.resource_id).toBe('inv-1');
		expect(content.company_id).toBe('company-cl');
		expect(content.metadata).toMatchObject({
			invoice_id: 'inv-1',
			invoice_number: 'FAC 028401',
			odoo_invoice_id: 201181,
			contract_id: 'ctr-1',
			client_name: 'Cliente 1',
			company_name: 'Simplit SpA',
			country: 'Chile',
			failure_stage: 'post_invoice',
			invoice_count: 1,
			technical_detail: 'No hay CAFs disponible para el folio 28401 en la secuencia de Electronic Invoice. Por favor subo un archivo CAF o solicite uno nuevo en el sitio www.sii.cl',
			what_we_do: ODOO_FAILURE_WHAT_WE_DO.post_invoice,
			erp_error: { category: 'folios_exhausted', action: 'none', message: translation.message, next_step: translation.next_step },
		});
		expect(String(content.metadata.technical_detail)).not.toMatch(/XML-RPC|Code: 2|at /);
	});

	it('varias facturas: "No se pudieron enviar N facturas de <compañía> al ERP", sin acción ni resource_id, cliente solo si es uno', () => {
		const translation = translateErpError(CAF, 'odoo_post_exception');
		const base = {
			company: simplit,
			stage: 'post_invoice' as const,
			translation,
			errorType: 'odoo_post_exception',
			errorMessage: CAF,
			schedulerSource: 'automatic',
			technicalTitle: null,
			technicalMessage: null,
		};
		const content = odooFailureContent({ ...base, invoices: [invoice(1), invoice(2), invoice(3)] });

		expect(content.title).toBe('No se pudieron enviar 3 facturas de Simplit SpA al ERP');
		expect(content.action_type).toBeUndefined();
		expect(content.action_payload).toEqual({});
		expect(content.resource_id).toBeUndefined();
		expect(content.metadata).toMatchObject({ invoice_id: null, invoice_number: null, contract_id: null, client_name: null, invoice_count: 3 });
		expect(content.metadata.invoices).toHaveLength(3);

		const mismoCliente = odooFailureContent({ ...base, invoices: [invoice(1), invoice(2, { client_name: 'Cliente 1' })] });

		expect(mismoCliente.metadata.client_name).toBe('Cliente 1');
		// El total real puede superar la lista guardada.
		expect(odooFailureContent({ ...base, invoices: [invoice(1), invoice(2)], invoiceCount: 29 }).title).toBe('No se pudieron enviar 29 facturas de Simplit SpA al ERP');
		expect(odooFailureContent({ ...base, company: { id: null, legal_name: null, country: null }, invoices: [invoice(1), invoice(2)] }).title).toBe(
			'No se pudieron enviar 2 facturas de la compañía al ERP'
		);
	});

	it('México: timbrado rechazado → categoría electronic_rejected con su qué hacemos', () => {
		const translation = translateErpError(PAC, 'emit_electronic_exception');
		const content = odooFailureContent({
			invoices: [invoice(7, { invoice_number: 'A10166', client_name: 'Receptor MX' })],
			company: { id: 'company-mx', legal_name: 'SimpliRoute S.A.P.I. de C.V.', country: 'México' },
			stage: 'emit_electronic_invoice',
			translation,
			errorType: 'emit_electronic_exception',
			errorMessage: PAC,
			schedulerSource: 'automatic',
			technicalTitle: null,
			technicalMessage: null,
		});

		expect(content.title).toBe('No se pudo enviar la factura A10166 de Receptor MX');
		expect(content.message).toMatch(/^El SAT rechazó el timbrado: el domicilio fiscal \(código postal\) del cliente/);
		expect(content.metadata.what_we_do).toBe(ODOO_FAILURE_WHAT_WE_DO.emit_electronic_invoice);
		expect(content.metadata.technical_detail).toBe(
			'Ocurrió un error al enviar el CFDI al PAC: - Código: CFDI40147 - El campo DomicilioFiscalReceptor del receptor, debe encontrarse en la lista de RFC inscritos no cancelados en el SAT.'
		);
	});

	it('contentInputFromMetadata reconstruye la entrada desde lo guardado (para achicar el grupo) y devuelve null si falta lo esencial', () => {
		const translation = translateErpError(CAF, 'odoo_post_exception');
		const saved = odooFailureContent({
			invoices: [invoice(1), invoice(2)],
			company: simplit,
			stage: 'post_invoice',
			translation,
			errorType: 'odoo_post_exception',
			errorMessage: CAF,
			schedulerSource: 'manual',
			technicalTitle: 't',
			technicalMessage: 'm',
		}).metadata;
		const input = contentInputFromMetadata(saved, [invoice(2)]);

		expect(input).toMatchObject({
			stage: 'post_invoice',
			schedulerSource: 'manual',
			errorType: 'odoo_post_exception',
			errorMessage: CAF,
			company: { id: null, legal_name: 'Simplit SpA', country: 'Chile' },
			translation: { category: 'folios_exhausted', action: 'none', message: translation.message, next_step: translation.next_step },
		});
		const shrunk = odooFailureContent({ ...input!, invoiceCount: 1 });

		expect(shrunk.title).toBe('No se pudo enviar la factura FAC 028402 de Cliente 2');
		expect(shrunk.action_payload).toEqual({ contract_id: 'ctr-2' });
		expect(shrunk.message).toBe(saved.erp_error && translation.message + '. ' + translation.next_step + '.');
		expect(contentInputFromMetadata({ failure_stage: 'post_invoice' }, [invoice(1)])).toBeNull();
		expect(contentInputFromMetadata({ ...saved, failure_stage: 'otra' }, [invoice(1)])).toBeNull();
	});
});
