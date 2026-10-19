import {
	distributeTax,
	dteAmounts,
	type DteReceptor,
	dteReferencesOf,
	dteStatusFromResultado,
	dteTipoFor,
	isValidRut,
	mapInvoiceToDteBody,
	normalizeRut,
	planDebitNote,
	planEmitDte,
	receptorDteBlockers,
	roundClp,
} from './invoice-dte';

import type { ContractInvoiceRow } from './contract-invoices';

const receptor = (patch: Partial<DteReceptor> = {}): DteReceptor => ({
	tax_id: '76.120.605-2',
	legal_name: 'Comercializadora de Tecnologias Lenosoft Limitada',
	economic_activity: 'CONSULTORÍA INFORMÁTICA, DE GESTIÓN Y VENTA DE SOFTWARE',
	legal_address: 'Costanera 408',
	commune: 'San Bernardo',
	email: 'contacto@lenosoft.cl',
	...patch,
});

const invoice = (patch: Partial<ContractInvoiceRow> = {}): ContractInvoiceRow =>
	({
		id: 'inv-1',
		invoice_number: null,
		status: 'Por Emitir',
		document_type: 'FACTURA',
		invoice_type: 'Automatica',
		is_active: true,
		is_legacy: false,
		issue_date: '2026-10-18',
		contract_currency: 'CLF',
		invoice_currency: 'CLP',
		tax_rate: 19,
		lines_count: 1,
		dte_id: null,
		dte_status: null,
		...patch,
	}) as ContractInvoiceRow;

const context = (patch: Record<string, unknown> = {}) => ({
	has_electronic_invoicing: true,
	has_erp_integration: false,
	contract_document_code: '33',
	today: '2026-10-18',
	...patch,
});

describe('invoice-dte: documento tributario desde la factura (lógica pura)', () => {
	it('redondea como api-factura (0,5 hacia arriba) y normaliza el RUT', () => {
		expect(roundClp(10.5)).toBe(11);
		expect(roundClp(10.49)).toBe(10);
		expect(normalizeRut('76.120.605-2')).toBe('76120605-2');
		expect(normalizeRut('7.654.321-k')).toBe('7654321-K');
		expect(normalizeRut('no es rut')).toBeNull();
	});

	it('tipo SII: factura 33, sin IVA 34, NC 61, ND 56 y exportación fuera de este camino', () => {
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 19 }, '33')).toBe(33);
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 0 }, '33')).toBe(34);
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 19 }, '34')).toBe(34);
		expect(dteTipoFor({ document_type: 'NC', tax_rate: 19 }, '33')).toBe(61);
		expect(dteTipoFor({ document_type: 'ND', tax_rate: 19 }, '33')).toBe(56);
		expect(dteTipoFor({ document_type: 'FACTURA_EXPORTACION', tax_rate: 0 }, '110')).toBeNull();
	});

	it('montos en pesos enteros: el residuo de redondear va a la línea mayor, IVA sobre el neto y total = neto + IVA', () => {
		const amounts = dteAmounts(
			[
				{ id: 'a', description: 'A', quantity: 1, unit_of_measure: 'UND', subtotal_invoice_currency: 790000.4 },
				{ id: 'b', description: 'B', quantity: 1, unit_of_measure: 'UND', subtotal_invoice_currency: 100.4 },
			],
			19,
			false
		);

		// Σ exacta 790100,8 → 790101; líneas 790000 + 100 = 790100 → el peso que falta va a la mayor.
		expect(amounts.lines.map((line) => line.monto)).toEqual([790001, 100]);
		expect(amounts).toMatchObject({ neto: 790101, exento: 0, iva: 150119, total: 940220, tasa: 19 });
		expect(distributeTax(amounts)).toEqual([150119 - 19, 19]);
		expect(distributeTax(amounts).reduce((sum, value) => sum + value, 0)).toBe(amounts.iva);
	});

	it('factura exenta: todo exento, sin IVA; una NC llega negativa y sale positiva', () => {
		expect(
			dteAmounts([{ id: 'a', description: 'A', quantity: 2, unit_of_measure: null, subtotal_invoice_currency: 5000 }], 19, true)
		).toMatchObject({
			neto: 0,
			exento: 5000,
			iva: 0,
			total: 5000,
		});
		expect(
			dteAmounts([{ id: 'a', description: 'A', quantity: -1, unit_of_measure: null, subtotal_invoice_currency: -1000 }], 19, false).lines[0]
		).toMatchObject({ quantity: 1, monto: 1000 });
	});

	it('arma el dteBody sin emisor: receptor cortado al XSD, glosa larga en DscItem, crédito con vencimiento y referencias', () => {
		const amounts = dteAmounts(
			[
				{
					id: 'a',
					description: 'Desarrollo de Software Cuenta Sucurdal Norte - Periodo 18/10/2026 a 17/11/2026 y mantención evolutiva del sistema',
					quantity: 1,
					unit_of_measure: 'UNIDAD',
					subtotal_invoice_currency: 790123.45,
				},
			],
			19,
			false
		);
		const body = mapInvoiceToDteBody({
			tipo: 33,
			issue_date: '2026-10-18',
			due_date: '2026-11-17',
			receptor: receptor(),
			amounts,
			references: [{ document_type_code: '801', document_number: 'OC-4500', reference_date: '2026-10-01', reference_code: null, reason: null }],
		}) as any;

		expect(body.Encabezado.Emisor).toBeUndefined();
		expect(body.Encabezado.IdDoc).toEqual({ TipoDTE: 33, FchEmis: '2026-10-18', FmaPago: 2, FchVenc: '2026-11-17' });
		expect(body.Encabezado.Receptor).toEqual({
			RUTRecep: '76120605-2',
			RznSocRecep: 'Comercializadora de Tecnologias Lenosoft Limitada',
			GiroRecep: 'CONSULTORÍA INFORMÁTICA, DE GESTIÓN Y VE',
			DirRecep: 'Costanera 408',
			CmnaRecep: 'San Bernardo',
		});
		expect(body.Encabezado.Receptor.GiroRecep).toHaveLength(40);
		expect(body.Encabezado.Totales).toEqual({ MntNeto: 790123, TasaIVA: 19, IVA: 150123, MntTotal: 940246 });
		expect(body.Detalle[0]).toMatchObject({ NroLinDet: 1, QtyItem: 1, PrcItem: 790123, UnmdItem: 'UNID', MontoItem: 790123 });
		expect(body.Detalle[0].NmbItem).toHaveLength(80);
		expect(body.Detalle[0].DscItem).toContain('mantención evolutiva');
		// Una factura no lleva CodRef: solo las notas.
		expect(body.Referencia).toEqual([{ NroLinRef: 1, TpoDocRef: '801', FolioRef: 'OC-4500', FchRef: '2026-10-01' }]);
	});

	it('precio unitario a 6 decimales que reproduce el monto al peso; las notas llevan CodRef y no forma de pago', () => {
		const amounts = dteAmounts(
			[{ id: 'a', description: 'Servicio', quantity: 3, unit_of_measure: null, subtotal_invoice_currency: 1000 }],
			19,
			false
		);
		const body = mapInvoiceToDteBody({
			tipo: 61,
			issue_date: '2026-10-18',
			due_date: null,
			receptor: receptor(),
			amounts,
			references: [
				{ document_type_code: '33', document_number: '15', reference_date: '2026-10-10', reference_code: 1, reason: 'Anula factura' },
			],
		}) as any;

		expect(body.Detalle[0]).toEqual({ NroLinDet: 1, NmbItem: 'Servicio', QtyItem: 3, PrcItem: 333.333333, MontoItem: 1000 });
		expect(body.Encabezado.IdDoc).toEqual({ TipoDTE: 61, FchEmis: '2026-10-18' });
		expect(body.Referencia[0]).toEqual({
			NroLinRef: 1,
			TpoDocRef: '33',
			FolioRef: '15',
			FchRef: '2026-10-10',
			CodRef: 1,
			RazonRef: 'Anula factura',
		});
	});

	it('referencias: las de la factura más las OC/HES del contrato, sin repetir', () => {
		expect(
			dteReferencesOf(
				[{ document_type_code: '801', document_number: '4500', reference_date: '2026-10-01', reference_code: null, reason: null }],
				[
					{ reference_type: 'PO', reference_code: '4500', issue_date: '2026-10-01' },
					{ reference_type: 'HES', reference_code: 'H-9', issue_date: null },
					{ reference_type: 'OTHER', reference_code: 'X', issue_date: null },
				]
			)
		).toEqual([
			{ document_type_code: '801', document_number: '4500', reference_date: '2026-10-01', reference_code: null, reason: null },
			{ document_type_code: 'HES', document_number: 'H-9', reference_date: null, reference_code: null, reason: null },
		]);
	});

	it('receptor: exige RUT válido, razón social, giro, dirección y comuna', () => {
		expect(receptorDteBlockers(receptor())).toEqual([]);
		expect(receptorDteBlockers(receptor({ commune: null, tax_id: 'sin rut' })).map((blocker) => blocker.code)).toEqual([
			'dte_receptor_tax_id',
			'dte_receptor_commune',
		]);
		expect(receptorDteBlockers(null).map((blocker) => blocker.code)).toEqual(['dte_receptor_missing']);
		// Dígito verificador mal escrito: el SII lo rechazaría.
		expect(receptorDteBlockers(receptor({ tax_id: '76.120.605-3' }))).toEqual([
			expect.objectContaining({ code: 'dte_receptor_tax_id', message: 'El RUT 76.120.605-3 no es válido: revisa el dígito verificador' }),
		]);
		expect(isValidRut('77.307.689-8')).toBe(true);
		expect(isValidRut('60803000-k')).toBe(true);
		expect(isValidRut('77307689-7')).toBe(false);
	});

	it('plan: emite una factura de una compañía con facturación electrónica y sin ERP; avisa el giro acortado', () => {
		const plan = planEmitDte(invoice(), context(), { receptor: receptor(), base_blockers: [] });

		expect(plan).toMatchObject({ can_apply: true, tipo: 33, retry: false });
		expect(plan.warnings.map((warning) => warning.code)).toEqual(['dte_giro_truncated']);
	});

	it('plan: bloquea sin facturación electrónica, con ERP, fuera de pesos o ya emitida; un DTE creado se reintenta', () => {
		const codes = (patch: Partial<ContractInvoiceRow>, ctx: Record<string, unknown> = {}) =>
			planEmitDte(invoice(patch), context(ctx), { receptor: receptor(), base_blockers: [] }).blockers.map((blocker) => blocker.code);

		expect(codes({}, { has_electronic_invoicing: false })).toEqual(['no_electronic_invoicing']);
		expect(codes({}, { has_erp_integration: true })).toEqual(['company_uses_erp']);
		expect(codes({ invoice_currency: 'USD' })).toEqual(['dte_currency_not_clp']);
		expect(codes({ dte_id: 'd1', dte_status: 'enviado' })).toEqual(['dte_already_issued']);
		expect(planEmitDte(invoice({ dte_id: 'd1', dte_status: 'creado' }), context(), { receptor: receptor(), base_blockers: [] })).toMatchObject({
			can_apply: true,
			retry: true,
		});
	});

	it('plan de una nota: pendiente de emisión y con su factura emitida y válida ante el SII', () => {
		const note = invoice({ document_type: 'NC', status: 'Cancelada' });
		const original = { id: 'orig', invoice_number: '15', issue_date: '2026-10-10', dte_tipo: 33, dte_status: 'aceptado' };

		expect(planEmitDte(note, context(), { receptor: receptor(), base_blockers: [], original, pending_note: true })).toMatchObject({
			can_apply: true,
			tipo: 61,
		});
		expect(
			planEmitDte(note, context(), {
				receptor: receptor(),
				base_blockers: [],
				original: { ...original, dte_status: 'enviado' },
				pending_note: true,
			}).blockers.map((blocker) => blocker.code)
		).toEqual(['original_not_accepted']);
		expect(
			planEmitDte(note, context(), {
				receptor: receptor(),
				base_blockers: [],
				original: { ...original, invoice_number: null },
				pending_note: true,
			}).blockers.map((blocker) => blocker.code)
		).toEqual(['original_not_issued']);
		expect(
			planEmitDte(note, context(), { receptor: receptor(), base_blockers: [], original, pending_note: false }).blockers.map(
				(blocker) => blocker.code
			)
		).toEqual(['note_not_pending']);
	});

	it('nota de débito: solo sobre una factura emitida con folio; neto, IVA de la factura y total', () => {
		const original = {
			id: 'orig',
			status: 'Emitida',
			document_type: 'FACTURA',
			is_active: true,
			invoice_number: '15',
			issue_date: '2026-10-10',
			invoice_currency: 'CLP',
			tax_rate: 19,
			dte_status: 'aceptado',
		};

		expect(planDebitNote(original, { amount: 10000, reason: ' Intereses por mora ' })).toMatchObject({
			can_apply: true,
			amount: 10000,
			vat: 1900,
			total: 11900,
			reason: 'Intereses por mora',
		});
		expect(planDebitNote({ ...original, status: 'Por Emitir' }, { amount: 1, reason: 'x' }).blockers.map((blocker) => blocker.code)).toEqual([
			'not_issued',
		]);
		expect(planDebitNote({ ...original, document_type: 'NC' }, { amount: 1, reason: 'x' }).blockers.map((blocker) => blocker.code)).toEqual([
			'credit_note',
		]);
		expect(planDebitNote({ ...original, dte_status: 'rechazado' }, { amount: 1, reason: 'x' }).blockers.map((blocker) => blocker.code)).toEqual([
			'original_not_accepted',
		]);
	});

	it('estado guardado desde el resultado del SII', () => {
		expect(dteStatusFromResultado('aceptado')).toBe('aceptado');
		expect(dteStatusFromResultado('reparos')).toBe('reparos');
		expect(dteStatusFromResultado('rechazado')).toBe('rechazado');
		expect(dteStatusFromResultado('en_proceso')).toBe('enviado');
	});
});
