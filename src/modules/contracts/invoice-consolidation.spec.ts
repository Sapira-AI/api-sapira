import {
	candidateView,
	type ConsolidationContext,
	type ConsolidationInvoice,
	type ConsolidationLine,
	dedupeReferences,
	groupBlockers,
	invoiceBlockers,
	mainContractOf,
	pairBlockers,
	planConsolidation,
	prefixDescription,
	undoBlockers,
	unifiedReadFields,
	valueLinesForConsolidation,
} from './invoice-consolidation';

const codes = (blockers: Array<{ code: string }>) => blockers.map((blocker) => blocker.code);

const invoice = (overrides: Partial<ConsolidationInvoice> = {}): ConsolidationInvoice => ({
	id: 'inv-a',
	invoice_number: null,
	contract_id: 'ctr-a',
	contract_number: 'CTR-2026-1',
	client_id: 'client-a',
	client_name: 'Cliente A',
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	consolidated_into_invoice_id: null,
	company_id: 'company-1',
	client_entity_id: 'entity-1',
	legal_name: 'Socio SpA',
	invoice_currency: 'CLP',
	contract_currency: 'USD',
	issue_date: '2026-10-05',
	scheduled_at: '2026-10-05',
	due_date: '2026-11-04',
	export_type: 0,
	invoice_series: 'FAC',
	tax_rate: 19,
	amount_contract_currency: 1000,
	vat: 180500,
	amount_invoice_currency: 950000,
	total_invoice_currency: 1130500,
	amount_system_currency: 1000,
	total_system_currency: 1190,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	auto_invoice: true,
	requires_references: false,
	contract_requires_references: false,
	contract_auto_send_to_erp: true,
	lines_count: 1,
	internal_lines: 0,
	open_lines: 0,
	cutoff_date: null,
	...overrides,
});

const line = (overrides: Partial<ConsolidationLine> = {}): ConsolidationLine => ({
	id: 'line-a',
	invoice_id: 'inv-a',
	contract_id: null,
	contract_item_id: 'item-a',
	description: 'PLATAFORMA - Periodo 01/10/2026 a 31/10/2026',
	product_name: 'Plataforma',
	currency: 'USD',
	quantity: 1,
	unit_price: 1000,
	subtotal: 1000,
	tax: 190,
	total: 1190,
	unit_price_invoice: 950000,
	subtotal_invoice: 950000,
	tax_invoice: 180500,
	total_invoice: 1130500,
	fx: 950,
	fx_rate_source: 'contract',
	fx_rate_date: '2026-10-01',
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	...overrides,
});

const A = invoice();
const B = invoice({
	id: 'inv-b',
	contract_id: 'ctr-b',
	contract_number: 'CTR-2026-2',
	client_id: 'client-b',
	client_name: 'Cliente B',
	amount_contract_currency: 2000,
	amount_invoice_currency: 1900000,
	vat: 361000,
	total_invoice_currency: 2261000,
	amount_system_currency: 2000,
	total_system_currency: 2380,
	auto_invoice: false,
});
const lineB = line({
	id: 'line-b',
	invoice_id: 'inv-b',
	contract_item_id: 'item-b',
	description: 'SOPORTE',
	unit_price: 2000,
	subtotal: 2000,
	tax: 380,
	total: 2380,
	unit_price_invoice: 1900000,
	subtotal_invoice: 1900000,
	tax_invoice: 361000,
	total_invoice: 2261000,
});
const ctx = (overrides: Partial<ConsolidationContext> = {}): ConsolidationContext => ({
	invoices: [A, B],
	lines: [line(), lineB],
	references: [],
	max_chars_by_contract: new Map([
		['ctr-a', null],
		['ctr-b', null],
	]),
	...overrides,
});

describe('invoice-consolidation (spec multimoneda §7)', () => {
	describe('elegibilidad', () => {
		it('cada bloqueo propio de una factura', () => {
			expect(codes(invoiceBlockers(A))).toEqual([]);
			expect(codes(invoiceBlockers(invoice({ document_type: 'NC' })))).toEqual(['credit_note']);
			expect(codes(invoiceBlockers(invoice({ document_type: 'ND' })))).toEqual(['credit_note']);
			expect(codes(invoiceBlockers(invoice({ status: 'Emitida' })))).toEqual(['not_pending']);
			expect(codes(invoiceBlockers(invoice({ is_active: false })))).toEqual(['not_pending']);
			expect(codes(invoiceBlockers(invoice({ consolidated_into_invoice_id: 'x' })))).toEqual(['already_consolidated']);
			expect(codes(invoiceBlockers(invoice({ invoice_type: 'Unificada' })))).toEqual(['already_consolidated']);
			expect(codes(invoiceBlockers(invoice({ invoice_type: 'Consolidada' })))).toEqual(['already_consolidated']);
			expect(codes(invoiceBlockers(invoice({ is_legacy: true })))).toEqual(['legacy_invoice']);
			expect(codes(invoiceBlockers(invoice({ contract_id: null })))).toEqual(['no_contract']);
			expect(codes(invoiceBlockers(invoice({ internal_lines: 2 })))).toEqual(['partial_billing_invoice']);
			// Consumo abierto ya no bloquea (Domi 05-10): el consumo posterior re-copia sus líneas al unificado.
			expect(codes(invoiceBlockers(invoice({ open_lines: 1 })))).toEqual([]);
			expect(codes(invoiceBlockers(invoice({ cutoff_date: '2026-10-31' })))).toEqual([]); // un mes cerrado no bloquea (Domi 03-10)
		});

		it('borrador en el ERP (id o solo la marca de envío) → sent_to_erp_draft con action erp_reset', () => {
			const byId = invoiceBlockers(invoice({ odoo_invoice_id: 77, sent_to_odoo_at: '2026-10-01T10:00:00Z' }));
			const byMark = invoiceBlockers(invoice({ sent_to_odoo_at: '2026-10-01T10:00:00Z' }));

			expect(byId).toEqual([expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' })]);
			expect(byMark).toEqual([expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' })]);
		});

		it('cada bloqueo de la pareja; clientes comerciales distintos sí calzan', () => {
			expect(pairBlockers(A, B)).toEqual([]);
			expect(codes(pairBlockers(A, invoice({ company_id: 'company-2' })))).toEqual(['company_mismatch']);
			expect(codes(pairBlockers(A, invoice({ client_entity_id: 'entity-2' })))).toEqual(['entity_mismatch']);
			expect(codes(pairBlockers(A, invoice({ invoice_currency: 'USD' })))).toEqual(['currency_mismatch']);
			expect(codes(pairBlockers(A, invoice({ issue_date: '2026-11-02' })))).toEqual(['month_mismatch']);
			expect(codes(pairBlockers(A, invoice({ document_type: 'FACTURA_EXPORTACION' })))).toEqual(['document_type_mismatch']);
			expect(codes(pairBlockers(A, invoice({ export_type: 1 })))).toEqual(['export_type_mismatch']);
			expect(codes(pairBlockers(A, invoice({ invoice_series: 'FEX' })))).toEqual(['series_mismatch']);
		});

		it('grupo: un solo contrato y tasas de IVA distintas', () => {
			expect(codes(groupBlockers([A, invoice({ id: 'inv-a2' })]))).toEqual(['single_contract']);
			expect(codes(groupBlockers([A, { ...B, tax_rate: 0 }]))).toEqual(['tax_rate_mismatch']);
			expect(groupBlockers([A, B])).toEqual([]);
		});

		it('candidata: bloqueos propios + pareja y `eligible`', () => {
			expect(candidateView(A, B)).toMatchObject({ id: 'inv-b', contract_number: 'CTR-2026-2', eligible: true, blockers: [] });
			expect(candidateView(A, { ...B, invoice_series: 'X', odoo_invoice_id: 3 })).toMatchObject({
				eligible: false,
				blockers: [expect.objectContaining({ code: 'sent_to_erp_draft' }), expect.objectContaining({ code: 'series_mismatch' })],
			});
		});
	});

	describe('glosa', () => {
		it('antepone "<contrato> - " con guion ASCII y no duplica el prefijo', () => {
			expect(prefixDescription('CTR-2026-12', 'PLATAFORMA', null)).toEqual({ text: 'CTR-2026-12 - PLATAFORMA', fitted: false });
			expect(prefixDescription('CTR-2026-12', 'CTR-2026-12 - PLATAFORMA', null).text).toBe('CTR-2026-12 - PLATAFORMA');
			expect(prefixDescription(null, 'PLATAFORMA', null).text).toBe('PLATAFORMA');
			expect(prefixDescription('CTR-2026-12', '', null).text).toBe('CTR-2026-12');
		});

		it('respeta el límite del documento con fitDescription: recorta la glosa y conserva el número', () => {
			const long = 'PLATAFORMA DE RUTEO Cuenta Operaciones Norte - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100';
			const fitted = prefixDescription('CTR-2026-12', long, 80);

			expect(fitted.fitted).toBe(true);
			expect(fitted.text.length).toBeLessThanOrEqual(80);
			expect(fitted.text.startsWith('CTR-2026-12 - ')).toBe(true);
		});
	});

	describe('valorización por par', () => {
		it('una línea spot que convierte deja spot TODO el documento; la línea en moneda de factura conserva FX 1', () => {
			const lines = [
				{ ...line(), origin_currency: 'USD' },
				{
					...line({ id: 'line-spot', fx: null, subtotal_invoice: null, unit_price_invoice: null, tax_invoice: null, total_invoice: null }),
					origin_currency: 'USD',
				},
				{
					...line({
						id: 'line-clp',
						currency: 'CLP',
						subtotal: 5000,
						unit_price: 5000,
						tax: 950,
						total: 5950,
						fx: 1,
						subtotal_invoice: 5000,
					}),
					origin_currency: 'USD',
				},
			];
			const result = valueLinesForConsolidation(lines, 'CLP');

			expect(result.spot).toBe(true);
			expect(result.pairs).toEqual(['USD>CLP']);
			expect(result.lines.map((entry) => [entry.source_line_id, entry.fx, entry.subtotal_invoice_currency, entry.spot_propagated])).toEqual([
				['line-a', null, null, true],
				['line-spot', null, null, false],
				['line-clp', 1, 5000, false],
			]);
			expect(result.lines[0].fx_rate_source).toBeNull();
		});

		it('todas fijas → cada línea conserva su tasa y montos', () => {
			const result = valueLinesForConsolidation(
				[
					{ ...line(), origin_currency: 'USD' },
					{ ...lineB, fx: 960, origin_currency: 'USD' },
				],
				'CLP'
			);

			expect(result.spot).toBe(false);
			expect(result.lines.map((entry) => entry.fx)).toEqual([950, 960]);
		});
	});

	describe('referencias', () => {
		it('dedupe por tipo+folio (OC = 801 = PO), gana la propia de la factura', () => {
			const result = dedupeReferences([
				{ id: 'br-1', source: 'contract', invoice_id: 'inv-b', type: 'PO', name: null, code: '4500 ' },
				{ id: 'r-1', source: 'invoice', invoice_id: 'inv-a', type: '801', name: 'Orden de Compra', code: '4500' },
				{ id: 'r-2', source: 'invoice', invoice_id: 'inv-b', type: 'HES', name: null, code: 'h-9' },
				{ id: 'r-3', source: 'invoice', invoice_id: 'inv-b', type: 'HES', name: null, code: 'H-9' },
				{ id: 'br-2', source: 'contract', invoice_id: 'inv-a', type: 'HES', name: null, code: 'H-10' },
			]);

			expect(result).toEqual({
				invoice_reference_ids: ['r-1', 'r-2'],
				contract_reference_ids: ['br-2'],
				items: [
					{ kind: 'OC', code: '4500', source: 'invoice' },
					{ kind: 'HES', code: 'h-9', source: 'invoice' },
					{ kind: 'HES', code: 'H-10', source: 'contract' },
				],
				deduped: 2,
			});
		});
	});

	describe('planConsolidation', () => {
		it('aporte por contrato, principal = mayor aporte, encabezado = Σ líneas, prefijo y contract_id de la línea', () => {
			const plan = planConsolidation(ctx());

			expect(plan.can_apply).toBe(true);
			expect(plan.main_contract_id).toBe('ctr-b');
			expect(plan.contributions.map((entry) => [entry.contract_id, entry.subtotal_invoice_currency, entry.main])).toEqual([
				['ctr-b', 1900000, true],
				['ctr-a', 950000, false],
			]);
			expect(plan.header).toMatchObject({
				contract_id: 'ctr-b',
				client_id: 'client-b',
				template_invoice_id: 'inv-b',
				contract_currency: 'USD',
				contract_currency_mode: 'same',
				amount_contract_currency: 3000,
				amount_invoice_currency: 2850000,
				vat: 541500,
				total_invoice_currency: 3391500,
				fx_contract_to_invoice: 950,
				spot: false,
				auto_invoice: false,
				requires_references_for_billing: false,
			});
			expect(plan.lines.map((entry) => [entry.contract_id, entry.description])).toEqual([
				['ctr-b', 'CTR-2026-2 - SOPORTE'],
				['ctr-a', 'CTR-2026-1 - PLATAFORMA - Periodo 01/10/2026 a 31/10/2026'],
			]);
			expect(codes(plan.warnings)).toEqual(['auto_invoice_differs']);
		});

		it('unificación recurrente (Domi 05-10): el principal fijado por la regla lleva el encabezado y la fecha de su factura del mes', () => {
			const plan = planConsolidation(
				ctx({ invoices: [{ ...A, issue_date: '2026-10-20', scheduled_at: '2026-10-20' }, B], main_contract_id: 'ctr-a' })
			);

			expect(plan.main_contract_id).toBe('ctr-a');
			expect(plan.header).toMatchObject({ contract_id: 'ctr-a', template_invoice_id: 'inv-a', issue_date: '2026-10-20' });
			// Sin principal fijado: el de mayor aporte y la fecha más temprana, como siempre.
			expect(planConsolidation(ctx({ invoices: [{ ...A, issue_date: '2026-10-20', scheduled_at: '2026-10-20' }, B] })).header).toMatchObject({
				contract_id: 'ctr-b',
				issue_date: B.issue_date,
			});
			// Un principal que no está entre las facturas no se usa.
			expect(planConsolidation(ctx({ main_contract_id: 'ctr-x' })).main_contract_id).toBe('ctr-b');
		});

		it('AND de banderas: aviso si difieren envío automático; requisito de referencias heredado', () => {
			const plan = planConsolidation(
				ctx({ invoices: [A, { ...B, auto_invoice: true, contract_auto_send_to_erp: false, contract_requires_references: true }] })
			);

			expect(plan.header).toMatchObject({ auto_invoice: true, auto_send_to_erp: false, requires_references_for_billing: true });
			expect(codes(plan.warnings)).toEqual(['auto_send_to_erp_differs', 'references_inherited']);
		});

		it('spot propagado: encabezado en moneda de factura NULL, FX NULL y VAT en moneda de contrato', () => {
			const plan = planConsolidation(
				ctx({
					invoices: [A, { ...B, amount_invoice_currency: null, total_invoice_currency: null, vat: 380 }],
					lines: [line(), { ...lineB, fx: null, subtotal_invoice: null, unit_price_invoice: null, tax_invoice: null, total_invoice: null }],
				})
			);

			expect(plan.header).toMatchObject({
				spot: true,
				amount_invoice_currency: null,
				total_invoice_currency: null,
				fx_contract_to_invoice: null,
				amount_contract_currency: 3000,
				vat: 570,
			});
			expect(plan.lines.every((entry) => entry.subtotal_invoice_currency === null)).toBe(true);
			expect(codes(plan.warnings)).toContain('spot_document');
			expect(plan.can_apply).toBe(true);
		});

		it('spot con dos pares (o un par distinto del encabezado) se puede consolidar: el envío valoriza cada par al emitir (MM4)', () => {
			const plan = planConsolidation(
				ctx({
					lines: [
						line(),
						{
							...lineB,
							currency: 'CLF',
							fx: null,
							subtotal_invoice: null,
							unit_price_invoice: null,
							tax_invoice: null,
							total_invoice: null,
						},
					],
				})
			);

			expect(codes(plan.blockers)).toEqual([]);
			expect(plan.header).toMatchObject({ spot: true, amount_invoice_currency: null });
		});

		it('monedas de contrato distintas: encabezado en moneda de factura y Σ moneda del sistema de los orígenes', () => {
			const plan = planConsolidation(
				ctx({
					invoices: [A, { ...B, contract_currency: 'CLP', amount_contract_currency: 1900000 }],
					lines: [line(), { ...lineB, currency: 'CLP', fx: 1, unit_price: 1900000, subtotal: 1900000, tax: 361000, total: 2261000 }],
				})
			);

			expect(plan.header).toMatchObject({
				contract_currency_mode: 'mixed',
				contract_currency: 'CLP',
				amount_contract_currency: 2850000,
				amount_system_currency: 3000,
				total_system_currency: 3570,
				fx_contract_to_invoice: 950,
			});
		});

		it('glosa ajustada al límite del contrato principal → aviso description_fitted', () => {
			const long = 'PLATAFORMA DE RUTEO Cuenta Operaciones Norte - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100';
			const plan = planConsolidation(ctx({ lines: [line({ description: long }), lineB], max_chars_by_contract: new Map([['ctr-b', 80]]) }));

			expect(plan.lines[1].description_fitted).toBe(true);
			expect(codes(plan.warnings)).toContain('description_fitted');
		});

		it('mainContractOf desempata por número de contrato', () => {
			expect(
				mainContractOf([
					{ contract_id: 'b', contract_number: 'CTR-2', weight: 10 },
					{ contract_id: 'a', contract_number: 'CTR-1', weight: 10 },
				])
			).toBe('a');
		});
	});

	describe('deshacer', () => {
		const consolidated = {
			id: 'cons',
			invoice_number: null,
			invoice_type: 'Unificada',
			status: 'Por Emitir',
			is_active: true,
			odoo_invoice_id: null,
			sent_to_odoo_at: null,
		};

		it('solo un consolidado v2 Por Emitir, sin ERP y con orígenes', () => {
			expect(undoBlockers(consolidated, true, 2)).toEqual([]);
			expect(codes(undoBlockers({ ...consolidated, invoice_type: 'Automatica' }, true, 2))).toEqual(['not_consolidated']);
			expect(codes(undoBlockers(consolidated, false, 2))).toEqual(['legacy_unified']);
			expect(codes(undoBlockers({ ...consolidated, status: 'Emitida' }, true, 2))).toEqual(['not_pending']);
			expect(undoBlockers({ ...consolidated, odoo_invoice_id: 5 }, true, 2)).toEqual([
				expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' }),
			]);
			expect(codes(undoBlockers(consolidated, true, 0))).toEqual(['no_origins']);
		});
	});

	describe('historial unificado (§9)', () => {
		it('legacy_unified sin evento v2 y aporte por contrato (null si alguna línea quedó sin valorizar)', () => {
			const fields = unifiedReadFields([
				{
					invoice_id: 'u-1',
					consolidated_v2: false,
					contract_id: 'ctr-a',
					contract_number: 'CTR-1',
					currency: 'USD',
					lines_count: '2',
					subtotal: '100',
					subtotal_invoice_currency: '95000',
				},
				{
					invoice_id: 'u-1',
					consolidated_v2: false,
					contract_id: 'ctr-b',
					contract_number: 'CTR-2',
					currency: 'CLF',
					lines_count: '1',
					subtotal: '3',
					subtotal_invoice_currency: null,
				},
				{
					invoice_id: 'u-1',
					consolidated_v2: false,
					contract_id: 'ctr-b',
					contract_number: 'CTR-2',
					currency: 'CLP',
					lines_count: '1',
					subtotal: '1000',
					subtotal_invoice_currency: '1000',
				},
				{
					invoice_id: 'u-2',
					consolidated_v2: true,
					contract_id: null,
					contract_number: null,
					currency: null,
					lines_count: 0,
					subtotal: 0,
					subtotal_invoice_currency: null,
				},
			]);

			expect(fields.get('u-1')).toEqual({
				legacy_unified: true,
				contributions: [
					{
						contract_id: 'ctr-a',
						contract_number: 'CTR-1',
						lines_count: 2,
						subtotal_invoice_currency: 95000,
						subtotal_by_currency: [{ currency: 'USD', subtotal: 100 }],
					},
					{
						contract_id: 'ctr-b',
						contract_number: 'CTR-2',
						lines_count: 2,
						subtotal_invoice_currency: null,
						subtotal_by_currency: [
							{ currency: 'CLF', subtotal: 3 },
							{ currency: 'CLP', subtotal: 1000 },
						],
					},
				],
			});
			expect(fields.get('u-2')).toEqual({ legacy_unified: false, contributions: [] });
		});
	});
});
