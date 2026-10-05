import {
	catalogForCountry,
	documentTypeFromKind,
	documentTypeLabel,
	resolveDescriptionMaxChars,
	suggestTaxDocumentType,
	TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE,
	type TaxDocumentTypeOption,
} from './tax-document-types';

const option = (country_code: string, code: string, kind: TaxDocumentTypeOption['kind'], sort: number, name = code): TaxDocumentTypeOption => ({
	id: `${country_code}-${code}`,
	country_code,
	code,
	name,
	kind,
	is_electronic: country_code !== '*',
	sort,
});

/** Catálogo como lo carga el seed 003 (solo lo relevante para un contrato + una NC para verificar que se filtra). */
const CATALOG: TaxDocumentTypeOption[] = [
	option('CL', '110', 'export_invoice', 30, 'Factura de exportación electrónica'),
	option('CL', '33', 'invoice', 10, 'Factura electrónica'),
	option('CL', '34', 'invoice', 20, 'Factura no afecta o exenta electrónica'),
	option('CL', '61', 'credit_note', 40, 'Nota de crédito electrónica'),
	option('PE', '01', 'invoice', 10, 'Factura electrónica'),
	option('*', 'FACTURA_EXPORTACION', 'export_invoice', 20, 'Factura de exportación'),
	option('*', 'FACTURA', 'invoice', 10, 'Factura'),
];

describe('catálogo de documentos tributarios', () => {
	it('da los documentos del país de la compañía (texto libre → ISO-2), ordenados y sin notas de crédito', () => {
		expect(catalogForCountry(CATALOG, 'Chile').map((row) => row.code)).toEqual(['33', '34', '110']);
		expect(catalogForCountry(CATALOG, 'CL').map((row) => row.code)).toEqual(['33', '34', '110']);
		expect(catalogForCountry(CATALOG, 'Perú').map((row) => row.code)).toEqual(['01']);
	});

	it('cae a los genéricos cuando el país no tiene catálogo o no se reconoce', () => {
		expect(catalogForCountry(CATALOG, 'Colombia').map((row) => row.code)).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
		expect(catalogForCountry(CATALOG, null).map((row) => row.code)).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
		expect(catalogForCountry([], 'Chile')).toEqual([]);
	});

	it('sugiere exportación si emisor y receptor son de países distintos, factura local si no (o sin país)', () => {
		const chile = catalogForCountry(CATALOG, 'Chile');

		expect(suggestTaxDocumentType(chile, 'Chile', 'Chile')?.code).toBe('33');
		expect(suggestTaxDocumentType(chile, 'Chile', 'Perú')?.code).toBe('110');
		expect(suggestTaxDocumentType(chile, 'Chile', null)?.code).toBe('33');
		expect(suggestTaxDocumentType(catalogForCountry(CATALOG, 'Colombia'), 'Colombia', 'Mexico')?.code).toBe('FACTURA_EXPORTACION');
	});

	it('si el país no tiene la familia sugerida, usa la otra; con catálogo vacío no sugiere', () => {
		// Perú solo tiene factura local en este catálogo: para un cliente extranjero igual la propone.
		expect(suggestTaxDocumentType(catalogForCountry(CATALOG, 'Perú'), 'Perú', 'Chile')?.code).toBe('01');
		expect(suggestTaxDocumentType([], 'Chile', 'Perú')).toBeNull();
	});

	it('deriva la familia del contrato desde la familia fiscal y etiqueta la familia', () => {
		expect(documentTypeFromKind('export_invoice')).toBe('FACTURA_EXPORTACION');
		expect(documentTypeFromKind('invoice')).toBe('FACTURA');
		expect(documentTypeFromKind('receipt')).toBe('FACTURA');
		expect(documentTypeLabel('FACTURA')).toBe('Factura');
		expect(documentTypeLabel('FACTURA_EXPORTACION')).toBe('Factura de exportación');
		expect(documentTypeLabel(null)).toBeNull();
		expect(TAX_DOCUMENT_COUNTRY_MISMATCH_MESSAGE).toBe('El documento tributario no corresponde al país de la compañía emisora');
	});
});

describe('resolveDescriptionMaxChars (límite de la glosa, spec facturas §3.6)', () => {
	const limits = [
		{ country_code: 'CL', kind: 'invoice', description_max_chars: 80, sort: 10 },
		{ country_code: 'CL', kind: 'export_invoice', description_max_chars: '80', sort: 30 },
	];
	const input = (overrides: Partial<Parameters<typeof resolveDescriptionMaxChars>[0]> = {}) => ({
		tax_document_type_id: null,
		own_max_chars: null,
		company_country: 'Chile',
		document_type: 'FACTURA',
		limits,
		...overrides,
	});

	it('con documento del catálogo manda el suyo (null = sin límite, aunque el país tenga otro)', () => {
		expect(resolveDescriptionMaxChars(input({ tax_document_type_id: 'tdt-33', own_max_chars: 80 }))).toBe(80);
		expect(resolveDescriptionMaxChars(input({ tax_document_type_id: 'tdt-x', own_max_chars: null }))).toBeNull();
	});

	it('sin documento (contratos anteriores al catálogo): el primero de la familia en el país de la compañía; sin país o sin fila → null', () => {
		expect(resolveDescriptionMaxChars(input())).toBe(80);
		expect(resolveDescriptionMaxChars(input({ document_type: 'FACTURA_EXPORTACION' }))).toBe(80);
		expect(resolveDescriptionMaxChars(input({ company_country: 'México' }))).toBeNull();
		expect(resolveDescriptionMaxChars(input({ company_country: null }))).toBeNull();
		expect(resolveDescriptionMaxChars(input({ limits: null }))).toBeNull();
	});
});
