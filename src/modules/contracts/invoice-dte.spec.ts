import {
	asReissued,
	distributeTax,
	dteAmounts,
	dteExportAmounts,
	type DteReceptor,
	dteReferencesOf,
	dteStatusFromResultado,
	dteTipoFor,
	exportAduana,
	fxLineNote,
	isDteRejected,
	isValidRut,
	mapInvoiceToDteBody,
	normalizeRut,
	planDebitNote,
	planEmitDte,
	receptorDteBlockers,
	receptorExportDteBlockers,
	roundClp,
	roundTo,
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

	it('tipo SII: factura 33, sin IVA 34, NC 61, ND 56; exportación 110 y sus notas 112 y 111', () => {
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 19 }, '33')).toBe(33);
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 0 }, '33')).toBe(34);
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 19 }, '34')).toBe(34);
		expect(dteTipoFor({ document_type: 'NC', tax_rate: 19 }, '33')).toBe(61);
		expect(dteTipoFor({ document_type: 'ND', tax_rate: 19 }, '33')).toBe(56);
		expect(dteTipoFor({ document_type: 'FACTURA_EXPORTACION', tax_rate: 0 }, '110')).toBe(110);
		expect(dteTipoFor({ document_type: 'FACTURA', tax_rate: 0 }, '110')).toBe(110);
		// Las notas de una factura de exportación (export_type = 1, o su original es un DTE de exportación).
		expect(dteTipoFor({ document_type: 'NC', tax_rate: 0 }, '110', true)).toBe(112);
		expect(dteTipoFor({ document_type: 'ND', tax_rate: 0 }, '33', true)).toBe(111);
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

	it('contrato en UF: cada línea lleva en su descripción el valor en UF y la tasa con su día', () => {
		const amounts = dteAmounts(
			[
				{
					id: 'a',
					description: 'Desarrollo de Software Cuenta Sucurdal Norte',
					quantity: 1,
					unit_of_measure: 'UND',
					subtotal_invoice_currency: 823572.8,
					contract_amount: 20,
				},
			],
			19,
			false
		);
		const body = mapInvoiceToDteBody({
			tipo: 33,
			issue_date: '2026-10-19',
			due_date: '2026-11-18',
			receptor: receptor(),
			amounts,
			references: [],
			fx: { rate: 41178.64, currency: 'CLF', date: '2026-10-18' },
		}) as any;

		expect(body.Detalle[0]).toMatchObject({
			NmbItem: 'Desarrollo de Software Cuenta Sucurdal Norte',
			DscItem: 'Valor: 20 UF × $41.178,64 (UF del 18-10-2026)',
			MontoItem: 823573,
		});
		expect(fxLineNote(1.5, { rate: 950.4, currency: 'USD', date: null })).toBe('Valor: 1,5 USD × $950,40 (tipo de cambio de la factura)');
		// Sin conversión no hay nota.
		expect(
			(mapInvoiceToDteBody({ tipo: 33, issue_date: '2026-10-19', due_date: null, receptor: receptor(), amounts, references: [] }) as any)
				.Detalle[0].DscItem
		).toBeUndefined();
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

	it('plan de reemisión: un DTE rechazado por el SII se puede emitir de nuevo (otro folio, fecha de hoy)', () => {
		const rejected = invoice({ status: 'Emitida', invoice_number: '15', dte_id: 'd1', dte_status: 'rechazado' });
		const plan = planEmitDte(rejected, context(), { receptor: receptor(), base_blockers: [] });

		expect(plan).toMatchObject({ can_apply: true, reissue: true, retry: false });
		expect(plan.warnings.find((warning) => warning.code === 'dte_reissue')?.message).toBe(
			'El SII rechazó el documento N° 15: se emite uno nuevo, con otro folio y fecha de hoy'
		);
		// Una nota rechazada ya no está «pendiente» (tiene folio), pero se reemite igual.
		const note = invoice({ document_type: 'NC', status: 'Cancelada', invoice_number: '3', dte_id: 'd2', dte_status: 'rechazado' });
		const original = { id: 'orig', invoice_number: '15', issue_date: '2026-10-10', dte_tipo: 33, dte_status: 'aceptado' };
		expect(planEmitDte(note, context(), { receptor: receptor(), base_blockers: [], original, pending_note: false })).toMatchObject({
			can_apply: true,
			reissue: true,
		});
		// Aceptado, con reparos o enviado no se reemite.
		for (const dte_status of ['aceptado', 'reparos', 'enviado']) {
			expect(planEmitDte(invoice({ dte_id: 'd1', dte_status }), context(), { receptor: receptor(), base_blockers: [] })).toMatchObject({
				reissue: false,
				can_apply: false,
			});
		}
		expect(isDteRejected({ dte_id: 'd1', dte_status: 'rechazado' })).toBe(true);
		expect(asReissued({ document_type: 'FACTURA', status: 'Emitida', invoice_number: '15' }, false)).toEqual({
			document_type: 'FACTURA',
			status: 'Por Emitir',
			invoice_number: null,
		});
		expect(asReissued({ document_type: 'NC', status: 'Cancelada', invoice_number: '3' }, true)).toEqual({
			document_type: 'NC',
			status: 'Cancelada',
			invoice_number: null,
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

	describe('exportación (110, 111, 112)', () => {
		const extranjero = (patch: Partial<DteReceptor> = {}): DteReceptor =>
			receptor({
				tax_id: '98-7654321',
				legal_name: 'Example Client Inc.',
				economic_activity: 'Software services',
				legal_address: '100 Example Street',
				commune: null,
				city: 'Miami',
				country_code: 'US',
				...patch,
			});
		const lineas = [
			{ id: 'a', description: 'Desarrollo', quantity: 1, unit_of_measure: 'UN', subtotal_invoice_currency: 1250.505 },
			{ id: 'b', description: 'Soporte', quantity: 2, unit_of_measure: 'UN', subtotal_invoice_currency: 300.004 },
		];

		it('montos en la moneda de la factura: centavos en dólares, enteros en pesos, todo exento y sin IVA', () => {
			const usd = dteExportAmounts(lineas, 'USD');

			// Σ exacta 1550,509 → 1550,51; líneas 1250,51 + 300 = 1550,51.
			expect(usd.lines.map((line) => line.monto)).toEqual([1250.51, 300]);
			expect(usd).toMatchObject({ neto: 0, exento: 1550.51, iva: 0, total: 1550.51, tasa: 0 });
			expect(dteExportAmounts(lineas, 'CLP')).toMatchObject({ total: 1551, iva: 0 });
			expect(roundTo(2.345, 2)).toBe(2.35);
		});

		it('arma el elemento de exportación: receptor extranjero, Aduana de servicios y total en pesos', () => {
			const amounts = dteExportAmounts(lineas, 'USD');
			const body = mapInvoiceToDteBody({
				tipo: 110,
				issue_date: '2026-10-26',
				due_date: '2026-11-25',
				receptor: extranjero(),
				amounts,
				references: [],
				exportacion: { currency: 'USD', clp_rate: 950.25, contract: { kind: 'servicios', sale_clause: 5, payment_form: 1 }, invoice: null },
			});

			expect(body).toEqual({
				Encabezado: {
					IdDoc: { TipoDTE: 110, FchEmis: '2026-10-26', IndServicio: 3, FmaPagExp: 1, FchVenc: '2026-11-25' },
					Receptor: {
						RUTRecep: '55555555-5',
						RznSocRecep: 'Example Client Inc.',
						Extranjero: { NumId: '98-7654321', Nacionalidad: '225' },
						GiroRecep: 'Software services',
						DirRecep: '100 Example Street',
						CiudadRecep: 'Miami',
					},
					Transporte: { Aduana: { CodClauVenta: 5, CodPaisRecep: 225, CodPaisDestin: 225 } },
					Totales: { TpoMoneda: 'DOLAR USA', MntExe: 1550.51, MntTotal: 1550.51 },
					OtraMoneda: { TpoMoneda: 'PESO CL', TpoCambio: 950.25, MntExeOtrMnda: 1473372, MntTotOtrMnda: 1473372 },
				},
				Detalle: [
					expect.objectContaining({ NroLinDet: 1, NmbItem: 'Desarrollo', QtyItem: 1, PrcItem: 1250.51, MontoItem: 1250.51 }),
					expect.objectContaining({ NroLinDet: 2, NmbItem: 'Soporte', QtyItem: 2, PrcItem: 150, MontoItem: 300 }),
				],
			});
		});

		it('una exportación en pesos no lleva OtraMoneda; la nota de crédito referencia con CodRef', () => {
			const body = mapInvoiceToDteBody({
				tipo: 112,
				issue_date: '2026-10-26',
				due_date: null,
				receptor: extranjero(),
				amounts: dteExportAmounts(lineas, 'CLP'),
				references: [{ document_type_code: '110', document_number: '7', reference_date: '2026-10-20', reference_code: 1, reason: 'Anula' }],
				exportacion: { currency: 'CLP', clp_rate: null, contract: null, invoice: null },
			}) as { Encabezado: Record<string, unknown>; Referencia: unknown[] };

			expect(body.Encabezado.OtraMoneda).toBeUndefined();
			expect(body.Encabezado.Totales).toEqual({ TpoMoneda: 'PESO CL', MntExe: 1551, MntTotal: 1551 });
			expect(body.Referencia).toEqual([{ NroLinRef: 1, TpoDocRef: '110', FolioRef: '7', FchRef: '2026-10-20', CodRef: 1, RazonRef: 'Anula' }]);
		});

		it('Aduana de bienes: transporte, puertos, bultos, pesos, flete y seguro; en servicios se ignoran', () => {
			const contract = {
				kind: 'bienes' as const,
				sale_modality: 1,
				sale_clause: 5,
				transport_route: 1,
				port_of_loading: 906,
				port_of_unloading: 141,
			};
			const shipment = {
				total_packages: 30,
				package_type: 22,
				gross_weight: 1200.5,
				weight_unit: 6,
				freight: 350.5,
				insurance: 42,
				sale_clause_total: 36115,
			};

			expect(exportAduana({ currency: 'USD', clp_rate: 950, contract, invoice: shipment }, 225)).toEqual({
				CodModVenta: 1,
				CodClauVenta: 5,
				TotClauVenta: 36115,
				CodViaTransp: 1,
				CodPtoEmbarque: 906,
				CodPtoDesemb: 141,
				PesoBruto: 1200.5,
				CodUnidPesoBruto: 6,
				TotBultos: 30,
				TipoBultos: [{ CodTpoBultos: 22, CantBultos: 30 }],
				MntFlete: 350.5,
				MntSeguro: 42,
				CodPaisRecep: 225,
				CodPaisDestin: 225,
			});
			expect(exportAduana({ currency: 'USD', clp_rate: 950, contract: { ...contract, kind: 'servicios' }, invoice: shipment }, 225)).toEqual({
				CodModVenta: 1,
				CodClauVenta: 5,
				CodPaisRecep: 225,
				CodPaisDestin: 225,
			});
		});

		it('bloqueos del receptor extranjero: país de Aduana, dirección y ciudad; el RUT no aplica', () => {
			expect(receptorExportDteBlockers(extranjero())).toEqual([]);
			expect(receptorExportDteBlockers(extranjero({ tax_id: null, commune: null }))).toEqual([]);
			expect(receptorExportDteBlockers(extranjero({ country_code: 'XX', city: '', legal_address: null })).map((item) => item.code)).toEqual([
				'dte_receptor_country',
				'dte_receptor_address',
				'dte_receptor_city',
			]);
		});

		it('plan: deja emitir en dólares, euros y pesos y bloquea otras monedas', () => {
			const exportInvoice = invoice({ document_type: 'FACTURA_EXPORTACION', invoice_currency: 'USD', contract_currency: 'USD', tax_rate: 0 });
			const plan = planEmitDte(exportInvoice, context({ contract_document_code: '110' }), { receptor: extranjero(), base_blockers: [] });

			expect(plan).toMatchObject({ tipo: 110, can_apply: true, blockers: [] });
			const enYenes = planEmitDte({ ...exportInvoice, invoice_currency: 'JPY' }, context({ contract_document_code: '110' }), {
				receptor: extranjero(),
				base_blockers: [],
			});
			expect(enYenes.blockers.map((item) => item.code)).toEqual(['dte_export_currency_unsupported']);
			const sinId = planEmitDte(exportInvoice, context({ contract_document_code: '110' }), {
				receptor: extranjero({ tax_id: null }),
				base_blockers: [],
			});
			expect(sinId.warnings.map((item) => item.code)).toContain('dte_receptor_without_tax_id');
		});
	});
});
