import JSZip from 'jszip';

/**
 * XLSX mínimo (Office Open XML) con `jszip`, que ya es dependencia de la API: sin librería nueva (la exportación de Revenue arma su XLSX en el
 * navegador con SheetJS; Facturación lo genera en la API, spec §4.8). Celdas de texto en línea (`inlineStr`), números como `n`, encabezado
 * en negrita y la primera fila fija. Sin fórmulas: un valor que empieza con `=` va como texto.
 */
export type Cell = string | number | boolean | null | undefined;

export interface Sheet {
	name: string;
	header: string[];
	rows: Cell[][];
}

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export const xmlEscape = (value: string): string =>
	value.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Letra de columna (0 → A, 25 → Z, 26 → AA). */
export function columnName(index: number): string {
	let name = '';
	let current = index + 1;

	while (current > 0) {
		const rest = (current - 1) % 26;

		name = String.fromCharCode(65 + rest) + name;
		current = Math.floor((current - 1) / 26);
	}

	return name;
}

export function cellXml(value: Cell, ref: string, style = 0): string {
	const s = style ? ` s="${style}"` : '';

	if (value === null || value === undefined || value === '') return '';
	if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
	if (typeof value === 'boolean') return `<c r="${ref}"${s} t="inlineStr"><is><t>${value ? 'Sí' : 'No'}</t></is></c>`;

	return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

export function sheetXml(sheet: Sheet): string {
	const rows = [sheet.header, ...sheet.rows].map(
		(row, rowIndex) =>
			`<row r="${rowIndex + 1}">${row.map((value, column) => cellXml(value, `${columnName(column)}${rowIndex + 1}`, rowIndex === 0 ? 1 : 0)).join('')}</row>`
	);

	return (
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
		'<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
		`<sheetData>${rows.join('')}</sheetData></worksheet>`
	);
}

const safeSheetName = (name: string, index: number) => xmlEscape(name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Hoja ${index + 1}`);

/** Workbook con una hoja por `Sheet`. */
export function buildWorkbook(sheets: Sheet[]): JSZip {
	const zip = new JSZip();

	zip.file(
		'[Content_Types].xml',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
			'<Default Extension="xml" ContentType="application/xml"/>' +
			'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
			'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
			sheets
				.map(
					(_, index) =>
						`<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
				)
				.join('') +
			'</Types>'
	);
	zip.file(
		'_rels/.rels',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
			'</Relationships>'
	);
	zip.file(
		'xl/workbook.xml',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
			`<sheets>${sheets.map((sheet, index) => `<sheet name="${safeSheetName(sheet.name, index)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets>` +
			'</workbook>'
	);
	zip.file(
		'xl/_rels/workbook.xml.rels',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
			sheets
				.map(
					(_, index) =>
						`<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
				)
				.join('') +
			`<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
			'</Relationships>'
	);
	zip.file(
		'xl/styles.xml',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
			'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
			'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
			'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
			'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
			'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
			'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
			'</styleSheet>'
	);
	sheets.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)));

	return zip;
}

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- columnas de Facturación

const DOCUMENT_KIND_LABELS: Record<string, string> = { invoice: 'Factura', credit_note: 'Nota de crédito', debit_note: 'Nota de débito' };
const PAYMENT_LABELS: Record<string, string> = { unpaid: 'Sin pagar', partial: 'Parcial', paid: 'Pagada', overdue: 'Vencida', not_applicable: '—' };
const ERP_LABELS: Record<string, string> = { none: 'Sin enviar', draft: 'Borrador en el ERP', sent: 'En el ERP', not_applicable: '—' };
const ELECTRONIC_LABELS: Record<string, string> = {
	pending_emission: 'Pendiente de emisión',
	issued_erp: 'Emitida vía ERP',
	issued_external: 'Emitida fuera de Sapira',
	not_issued: 'Sin emitir',
	voided: 'Anulada',
};

export const INVOICE_HEADER = [
	'Folio',
	'Documento',
	'Tipo documento',
	'Estado',
	'Cliente',
	'Razón social',
	'Contrato',
	'Compañía',
	'Emisión',
	'Programada',
	'Vencimiento',
	'Moneda',
	'Tipo de cambio',
	'Neto',
	'IVA',
	'Total',
	'Total moneda sistema',
	'Pagado',
	'Saldo',
	'Pago',
	'ERP',
	'Emisión electrónica',
	'Días vencida',
	'Anulada',
	'Tipo de NC',
	'Factura acreditada',
];

export interface ExportInvoice {
	id: string;
	invoice_number: string | null;
	document_kind: string | null;
	document_type: string | null;
	status: string | null;
	client_name: string | null;
	client_entity_name: string | null;
	contract_number: string | null;
	company_name: string | null;
	issue_date: string | null;
	scheduled_at: string | null;
	due_date: string | null;
	invoice_currency: string | null;
	fx_contract_to_invoice: number | null;
	amount_invoice_currency: number | null;
	vat: number | null;
	total_invoice_currency: number | null;
	total_system_currency: number | null;
	paid_amount: number;
	balance: number | null;
	payment_state: string | null;
	erp_state: string | null;
	electronic_state: string | null;
	days_overdue: number;
	voided: boolean;
	credit_type: string | null;
	related_invoice_id: string | null;
}

export function invoiceCells(row: ExportInvoice, relatedNumber?: string | null): Cell[] {
	return [
		row.invoice_number,
		DOCUMENT_KIND_LABELS[row.document_kind ?? ''] ?? row.document_kind,
		row.document_type,
		row.status,
		row.client_name,
		row.client_entity_name,
		row.contract_number,
		row.company_name,
		row.issue_date,
		row.scheduled_at,
		row.due_date,
		row.invoice_currency,
		row.fx_contract_to_invoice,
		row.amount_invoice_currency,
		row.vat,
		row.total_invoice_currency,
		row.total_system_currency,
		row.paid_amount,
		row.balance,
		PAYMENT_LABELS[row.payment_state ?? ''] ?? row.payment_state,
		ERP_LABELS[row.erp_state ?? ''] ?? row.erp_state,
		ELECTRONIC_LABELS[row.electronic_state ?? ''] ?? row.electronic_state,
		row.days_overdue || null,
		row.voided,
		row.credit_type === 'cancellation' ? 'Anulación' : row.credit_type === 'discount' ? 'Descuento' : null,
		relatedNumber ?? null,
	];
}

export const LINE_HEADER = [
	'Folio',
	'Contrato',
	'Cliente',
	'Descripción',
	'Producto',
	'Período desde',
	'Período hasta',
	'Cantidad',
	'Unidad',
	'Descuento %',
	'Moneda línea',
	'Precio unitario',
	'Subtotal (moneda línea)',
	'Moneda factura',
	'Tipo de cambio',
	'Precio unitario (factura)',
	'Subtotal (factura)',
	'IVA (factura)',
	'Total (factura)',
	'Va al documento',
];

const n = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const t = (value: unknown) => (value === null || value === undefined ? null : String(value));

export function lineCells(
	line: Record<string, unknown>,
	invoice: Pick<ExportInvoice, 'invoice_number' | 'contract_number' | 'client_name' | 'invoice_currency'>
): Cell[] {
	return [
		invoice.invoice_number,
		invoice.contract_number,
		invoice.client_name,
		t(line.description),
		t(line.product_name),
		t(line.billing_period_start),
		t(line.billing_period_end),
		n(line.quantity),
		t(line.unit_of_measure),
		n(line.discount_pct),
		t(line.line_currency),
		n(line.unit_price_contract_currency),
		n(line.subtotal_contract_currency),
		t(line.invoice_currency) ?? invoice.invoice_currency,
		n(line.fx_contract_to_invoice),
		n(line.unit_price_invoice_currency),
		n(line.subtotal_invoice_currency),
		n(line.tax_amount_invoice_currency),
		n(line.total_invoice_currency),
		line.visible !== false,
	];
}
