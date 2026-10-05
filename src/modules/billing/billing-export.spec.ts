import JSZip from 'jszip';

import { buildWorkbook, cellXml, columnName, INVOICE_HEADER, invoiceCells, sheetXml } from './billing-export';

describe('XLSX de Facturación', () => {
	it('columnas A..Z, AA, AZ, BA', () => {
		expect([0, 25, 26, 51, 52].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA']);
	});

	it('celdas: número, texto escapado (también "=" como texto), vacío omitido, booleano en palabras', () => {
		expect(cellXml(12.5, 'B2')).toBe('<c r="B2"><v>12.5</v></c>');
		expect(cellXml('=SUM(A1)<x>&', 'A1')).toBe('<c r="A1" t="inlineStr"><is><t xml:space="preserve">=SUM(A1)&lt;x&gt;&amp;</t></is></c>');
		expect(cellXml(null, 'A1')).toBe('');
		expect(cellXml(true, 'A1')).toContain('<t>Sí</t>');
		expect(sheetXml({ name: 'x', header: ['A'], rows: [[1]] })).toContain('state="frozen"');
	});

	it('workbook válido: partes OOXML y una hoja por pestaña', async () => {
		const zip = buildWorkbook([
			{
				name: 'Facturas',
				header: INVOICE_HEADER,
				rows: [
					invoiceCells({
						id: '1',
						invoice_number: 'F-1',
						document_kind: 'invoice',
						document_type: 'FACTURA',
						status: 'Emitida',
						client_name: 'Acme',
						client_entity_name: 'Acme SpA',
						contract_number: 'C-1',
						company_name: 'Sapira',
						issue_date: '2026-10-01',
						scheduled_at: '2026-10-01',
						due_date: '2026-10-31',
						invoice_currency: 'CLP',
						fx_contract_to_invoice: null,
						amount_invoice_currency: 1000,
						vat: 190,
						total_invoice_currency: 1190,
						total_system_currency: 1.25,
						paid_amount: 0,
						balance: 1190,
						payment_state: 'unpaid',
						erp_state: 'not_applicable',
						electronic_state: 'issued_external',
						days_overdue: 0,
						voided: false,
						credit_type: null,
						related_invoice_id: null,
					}),
				],
			},
			{ name: 'Líneas', header: ['Folio'], rows: [] },
		]);
		const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));

		expect(Object.keys(loaded.files).sort()).toEqual(
			[
				'[Content_Types].xml',
				'_rels/',
				'_rels/.rels',
				'xl/',
				'xl/_rels/',
				'xl/_rels/workbook.xml.rels',
				'xl/styles.xml',
				'xl/workbook.xml',
				'xl/worksheets/',
				'xl/worksheets/sheet1.xml',
				'xl/worksheets/sheet2.xml',
			].sort()
		);
		const sheet = await loaded.file('xl/worksheets/sheet1.xml')!.async('string');

		expect(sheet).toContain('Emitida fuera de Sapira');
		expect(sheet).toContain('<v>1190</v>');
		expect(await loaded.file('xl/workbook.xml')!.async('string')).toContain('name="Líneas"');
	});
});
