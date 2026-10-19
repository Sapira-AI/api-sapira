import { creditNoteBody, documentRequest, journalBody, KameMappingError, lastDayOfMonth, parseIssuedDte, saleBody } from './kame-mapper';

const context = { usuario: 'contabilidad@empresa.cl', unidadNegocio: 'CASA MATRIZ', sucursal: null, comentario: 'Contrato CTR-2026-81 · Sapira' };

const dteXml = ({
	tipo = 33,
	folio = 5,
	fmaPago = 2,
	detalle = '',
	totales = '',
	referencia = '',
} = {}) => `<?xml version="1.0" encoding="ISO-8859-1"?>
<EnvioDTE xmlns="http://www.sii.cl/SiiDte" version="1.0"><SetDTE ID="SetDoc"><DTE version="1.0"><Documento ID="F${folio}T${tipo}">
	<Encabezado>
		<IdDoc><TipoDTE>${tipo}</TipoDTE><Folio>${folio}</Folio><FchEmis>2026-10-19</FchEmis><FmaPago>${fmaPago}</FmaPago><FchVenc>2026-11-18</FchVenc></IdDoc>
		<Emisor><RUTEmisor>77307689-8</RUTEmisor></Emisor>
		<Receptor><RUTRecep>76987654-5</RUTRecep><RznSocRecep>CLIENTE SPA</RznSocRecep><GiroRecep>SERVICIOS</GiroRecep><CorreoRecep>dte@cliente.cl</CorreoRecep><DirRecep>AV. SIEMPRE VIVA 742</DirRecep><CmnaRecep>PROVIDENCIA</CmnaRecep><CiudadRecep>SANTIAGO</CiudadRecep></Receptor>
		<Totales>${totales || '<MntNeto>823573</MntNeto><TasaIVA>19</TasaIVA><IVA>156479</IVA><MntTotal>980052</MntTotal>'}</Totales>
	</Encabezado>
	${detalle || '<Detalle><NroLinDet>1</NroLinDet><NmbItem>Plataforma de firma electrónica</NmbItem><DscItem>Valor: 20 UF × $41.178,64 (UF del 18-10-2026)</DscItem><QtyItem>20</QtyItem><UnmdItem>UF</UnmdItem><PrcItem>41178.65</PrcItem><MontoItem>823573</MontoItem></Detalle>'}
	${referencia}
	<TED version="1.0"></TED>
</Documento></DTE></SetDTE></EnvioDTE>`;

describe('kame-mapper', () => {
	it('lee el XML del DTE emitido (folio, receptor, totales, líneas)', () => {
		const dte = parseIssuedDte(Buffer.from(dteXml(), 'latin1'));

		expect(dte).toMatchObject({
			tipo: 33,
			folio: 5,
			fechaEmision: '2026-10-19',
			formaPago: 2,
			fechaVencimiento: '2026-11-18',
			neto: 823573,
			iva: 156479,
			total: 980052,
		});
		expect(dte.receptor).toMatchObject({ rut: '76987654-5', razonSocial: 'CLIENTE SPA', comuna: 'PROVIDENCIA', correo: 'dte@cliente.cl' });
		expect(dte.lineas).toEqual([
			expect.objectContaining({
				nombre: 'Plataforma de firma electrónica',
				cantidad: 20,
				precio: 41178.65,
				monto: 823573,
				exento: false,
				unidad: 'UF',
			}),
		]);
	});

	it('factura 33 → addVenta con el folio emitido, montos exactos y crédito en una cuota', () => {
		const { endpoint, body } = documentRequest(parseIssuedDte(dteXml()), context);

		expect(endpoint).toBe('/Documento/addVenta');
		expect(body).toMatchObject({
			Usuario: 'contabilidad@empresa.cl',
			Documento: 'Factura Electrónica',
			TipoDocumento: 'VENTA',
			Folio: '5',
			Rut: '76.987.654-5',
			Fecha: '2026-10-19T00:00:00',
			FormaPago: '2',
			FechaVencimiento: '2026-11-18T00:00:00',
			Cuotas: [{ FechaPago: '2026-11-18T00:00:00', MontoPago: 980052 }],
			Afecto: 823573,
			Exento: 0,
			ValorImpto1: 156479,
			total: 980052,
			Comentario: 'Contrato CTR-2026-81 · Sapira',
		});
		// 20 × 41.178,65 = 823.573: la cantidad y el precio dan el monto, la línea va tal cual.
		expect((body as ReturnType<typeof saleBody>).Detalle[0]).toMatchObject({
			Cantidad: 20,
			PrecioUnitario: 41178.65,
			Total: 823573,
			UnidadNegocio: 'CASA MATRIZ',
			TipoArticulo: 'SERVICIO',
		});
	});

	it('si cantidad × precio no da el monto, la línea va como 1 × monto y la cantidad queda en la descripción', () => {
		const xml = dteXml({
			detalle: '<Detalle><NmbItem>Servicio</NmbItem><QtyItem>3</QtyItem><PrcItem>333.33</PrcItem><MontoItem>1000</MontoItem></Detalle>',
			totales: '<MntNeto>1000</MntNeto><IVA>190</IVA><MntTotal>1190</MntTotal>',
		});
		const body = saleBody(parseIssuedDte(xml), context);

		expect(body.Detalle[0]).toMatchObject({ Cantidad: 1, PrecioUnitario: 1000, Total: 1000, DescripcionDetallada: 'Cantidad 3 × 333.33' });
	});

	it('factura exenta 34: líneas exentas y sin IVA; contado sin cuotas', () => {
		const xml = dteXml({
			tipo: 34,
			fmaPago: 1,
			detalle:
				'<Detalle><NmbItem>Curso</NmbItem><IndExe>1</IndExe><QtyItem>1</QtyItem><PrcItem>50000</PrcItem><MontoItem>50000</MontoItem></Detalle>',
			totales: '<MntExe>50000</MntExe><MntTotal>50000</MntTotal>',
		});
		const body = saleBody(parseIssuedDte(xml), context);

		expect(body).toMatchObject({
			Documento: 'Factura Exenta Electrónica',
			Afecto: 0,
			Exento: 50000,
			ValorImpto1: 0,
			total: 50000,
			FormaPago: '1',
			Cuotas: [],
		});
		expect(body.Detalle[0]).toMatchObject({ Exento: 'S', TipoExento: '1' });
	});

	it('nota de crédito 61 → addNotaCredito con la referencia a la factura', () => {
		const xml = dteXml({
			tipo: 61,
			folio: 1,
			fmaPago: 1,
			referencia:
				'<Referencia><NroLinRef>1</NroLinRef><TpoDocRef>33</TpoDocRef><FolioRef>5</FolioRef><FchRef>2026-10-19</FchRef><CodRef>1</CodRef><RazonRef>Anula factura</RazonRef></Referencia>',
		});
		const { endpoint, body } = documentRequest(parseIssuedDte(xml), context);

		expect(endpoint).toBe('/Documento/addNotaCredito');
		expect(body).toMatchObject({
			Documento: 'Nota de Crédito Electrónica',
			Folio: '1',
			Total: 980052,
			Referencias: [{ TpoDocRef: 'Factura Electrónica', FolioRef: '5', CodRef: 1, FechaRef: '2026-10-19T00:00:00', RazonRef: 'Anula factura' }],
		});
		expect(() => creditNoteBody(parseIssuedDte(dteXml({ tipo: 61 })), context)).toThrow('referencia');
	});

	it('rechaza antes de enviar lo que Kame rechazaría: IVA, total o tipo', () => {
		const badIva = dteXml({ totales: '<MntNeto>823573</MntNeto><IVA>156000</IVA><MntTotal>979573</MntTotal>' });
		const badTotal = dteXml({ totales: '<MntNeto>823573</MntNeto><IVA>156479</IVA><MntTotal>999999</MntTotal>' });

		expect(() => saleBody(parseIssuedDte(badIva), context)).toThrow(KameMappingError);
		expect(() => saleBody(parseIssuedDte(badTotal), context)).toThrow('total');
		expect(() => parseIssuedDte(dteXml({ tipo: 39 }))).toThrow('tipo 39');
		expect(() => parseIssuedDte('<xml/>')).toThrow('Documento');
	});

	it('comprobante de devengo: pesos enteros, una línea de debe y una de haber por cuenta, cuadrado y al último día del mes', () => {
		const body = journalBody(
			{
				period: '2026-09-01',
				postings: [
					{ account: 'receivable', debit: 980052.4, credit: 0, name: 'Clientes', external_code: '1.01.05.01' },
					{ account: 'deferred', debit: 0, credit: 980052.4, name: 'Ingresos diferidos', external_code: '2.01.07.01' },
					{ account: 'deferred', debit: 823573.2, credit: 0, name: 'Ingresos diferidos', external_code: '2.01.07.01' },
					{ account: 'revenue', debit: 0, credit: 823573.2, name: 'Ingresos', external_code: '4.01.01.01' },
				],
			},
			{ usuario: 'contabilidad@empresa.cl', unidadNegocio: null, comentario: 'Devengo de ingresos 2026-09 · Sapira' }
		);

		expect(body).toMatchObject({ tipoComprobante: 'TRASPASO', fecha: '2026-09-30', folio: '', usuario: 'contabilidad@empresa.cl' });
		expect(body.detalle.map((line) => [line.cuenta, line.debe, line.haber])).toEqual([
			['1.01.05.01', 980052, 0],
			['2.01.07.01', 823573, 0],
			['2.01.07.01', 0, 980052],
			['4.01.01.01', 0, 823573],
		]);
		expect(body.detalle[0].comentario).toBe('Devengo de ingresos 2026-09 · Sapira · Clientes');
		expect(lastDayOfMonth('2026-02-01')).toBe('2026-02-28');
	});

	it('el comprobante falla si falta el código de una cuenta o si el mes no tiene movimientos', () => {
		const ctx = { usuario: 'x@y.cl', unidadNegocio: null, comentario: 'Devengo' };

		expect(() =>
			journalBody(
				{ period: '2026-09-01', postings: [{ account: 'revenue', debit: 0, credit: 10, name: 'Ingresos', external_code: null }] },
				ctx
			)
		).toThrow('Faltan los códigos del ERP de estas cuentas: Ingresos');
		expect(() => journalBody({ period: '2026-09-01', postings: [] }, ctx)).toThrow('no tiene movimientos');
	});
});
