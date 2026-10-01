/**
 * Fixtures compartidos por `contract-changes.spec.ts` y `contract-changes.service.spec.ts`: contrato chileno en CLP, IVA 19,
 * día de ciclo 1, dos ítems recurrentes de enero a diciembre de 2026 (Licencia 10 × 100 y Soporte 1 × 200), facturas de
 * enero a septiembre emitidas y octubre a diciembre Por Emitir (una por mes con las dos líneas). Hoy = 28-09-2026.
 */
import type { ChangeContext, ChangeContractRow, ChangeInvoiceRow, ChangeItemRow } from './contract-changes';
import type { ContractChangeRequestDto } from './dtos/contract-changes.dto';

export const CONTRACT_ID = 'c0000000-0000-4000-8000-000000000001';
export const LICENCIA = '11111111-1111-4111-8111-111111111111';
export const SOPORTE = '22222222-2222-4222-8222-222222222222';
export const PRODUCT_LICENCIA = 'p0000000-0000-4000-8000-00000000000a';
export const PRODUCT_SOPORTE = 'p0000000-0000-4000-8000-00000000000b';
export const PRODUCT_NUEVO = 'p0000000-0000-4000-8000-00000000000c';
export const ENTITY_NEW = 'e0000000-0000-4000-8000-000000000002';
export const HOLDING = 'h-1';
export const TODAY = '2026-09-28';

export const contractRow = (overrides: Partial<ChangeContractRow> = {}): ChangeContractRow => ({
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	status: 'Activo',
	client_id: 'client-1',
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	system_currency: 'CLP',
	company_currency: 'CLP',
	fx_invoice_policy: 'spot',
	fx_company_policy: null,
	group_invoices_by_period: true,
	auto_invoice: false,
	auto_send_to_odoo: false,
	requires_references_for_billing: false,
	billing_anchor_day: 1,
	payment_terms: { kind: 'net', days: 30 },
	document_type: 'FACTURA',
	tax_document_type_id: null,
	tax_document_type_kind: null,
	invoice_terms_and_conditions: null,
	total_value: 14400,
	contract_end_date: '2026-12-31',
	quote_id: null,
	company: {
		legal_name: 'Simplit SpA',
		tax_id: '76.000.000-0',
		address: 'Av. Siempre Viva 123',
		country: 'Chile',
		tax_rate: '19',
		currency: 'CLP',
	},
	entity: { id: 'entity-1', legal_name: 'Cliente SpA', tax_id: '77.777.777-7', country: 'Chile', payment_terms: { kind: 'net', days: 60 } },
	fx_invoice_rates: [],
	cutoff_date: null,
	...overrides,
});

export const itemRow = (overrides: Partial<ChangeItemRow> = {}): ChangeItemRow => ({
	id: LICENCIA,
	product_id: PRODUCT_LICENCIA,
	product_name: 'Licencia',
	account: null,
	item_type: 'Recurrente',
	categoria: 'NEW',
	unit_of_measure: 'Usuarios',
	quantity: 10,
	unit_price: 100,
	price_entry_mode: 'monthly',
	annual_unit_price: 1200,
	discount_type: null,
	discount_value: 0,
	monthly_price: 1000,
	billing_period_price: 1000,
	price: 12000,
	final_price: 12000,
	term_months: 12,
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	is_recurring: true,
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	booking_date: '2026-01-01',
	churn_date: null,
	related_item_id: null,
	renews_item_id: null,
	renewed_by_item_id: null,
	auto_renew: false,
	currency: 'CLP',
	price_id: null,
	raw: {},
	...overrides,
});

export const soporteRow = (overrides: Partial<ChangeItemRow> = {}): ChangeItemRow =>
	itemRow({
		id: SOPORTE,
		product_id: PRODUCT_SOPORTE,
		product_name: 'Soporte',
		unit_of_measure: 'UND',
		quantity: 1,
		unit_price: 200,
		annual_unit_price: 2400,
		monthly_price: 200,
		billing_period_price: 200,
		price: 2400,
		final_price: 2400,
		...overrides,
	});

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const lastDay = (month: string) => new Date(Date.UTC(2026, Number(month), 0)).getUTCDate();

/** Factura del mes `mm` con las líneas de Licencia (1.000) y Soporte (200); emitida hasta septiembre, Por Emitir después. */
export const invoiceRow = (mm: string, overrides: Partial<ChangeInvoiceRow> = {}): ChangeInvoiceRow => {
	const issued = Number(mm) <= 9;
	const start = `2026-${mm}-01`;
	const end = `2026-${mm}-${String(lastDay(mm)).padStart(2, '0')}`;

	return {
		id: `inv-${mm}`,
		invoice_number: issued ? `F-${mm}` : null,
		status: issued ? (Number(mm) <= 8 ? 'Pagada' : 'Emitida') : 'Por Emitir',
		is_active: true,
		is_legacy: false,
		invoice_type: 'Automatica',
		document_type: 'FACTURA',
		export_type: 0,
		issue_date: start,
		due_date: `2026-${mm}-${String(Math.min(31, lastDay(mm))).padStart(2, '0')}`,
		client_entity_id: 'entity-1',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx: 1,
		tax_rate: 19,
		subtotal: 1200,
		vat: 228,
		amount_invoice: 1200,
		total_invoice: 1428,
		lines: [
			{
				id: `line-${mm}-lic`,
				invoice_id: `inv-${mm}`,
				contract_item_id: LICENCIA,
				product_id: PRODUCT_LICENCIA,
				description: `Licencia - Periodo 01/${mm}/2026 a ${lastDay(mm)}/${mm}/2026`,
				quantity: 10,
				unit_price: 100,
				unit_price_invoice: 100,
				discount_pct: 0,
				subtotal: 1000,
				subtotal_invoice: 1000,
				tax_amount: 190,
				tax_amount_invoice: 190,
				total: 1190,
				total_invoice: 1190,
				billing_period_start: start,
				billing_period_end: end,
				unit_of_measure: 'Usuarios',
			},
			{
				id: `line-${mm}-sop`,
				invoice_id: `inv-${mm}`,
				contract_item_id: SOPORTE,
				product_id: PRODUCT_SOPORTE,
				description: `Soporte - Periodo 01/${mm}/2026 a ${lastDay(mm)}/${mm}/2026`,
				quantity: 1,
				unit_price: 200,
				unit_price_invoice: 200,
				discount_pct: 0,
				subtotal: 200,
				subtotal_invoice: 200,
				tax_amount: 38,
				tax_amount_invoice: 38,
				total: 238,
				total_invoice: 238,
				billing_period_start: start,
				billing_period_end: end,
				unit_of_measure: 'UND',
			},
		],
		...overrides,
	};
};

export const context = (overrides: Partial<ChangeContext> = {}): ChangeContext => ({
	contract: contractRow(),
	items: [itemRow(), soporteRow()],
	invoices: MONTHS.map((mm) => invoiceRow(mm)),
	quantity_override_item_ids: [],
	churn_reason: { id: 'reason-1', name: 'Presupuesto' },
	new_entity: null,
	products: new Map([
		[PRODUCT_NUEVO, 'Analítica'],
		[PRODUCT_LICENCIA, 'Licencia'],
	]),
	tax_document_type: null,
	quote: null,
	today: TODAY,
	...overrides,
});

export const request = (change: ContractChangeRequestDto['change'], overrides: Partial<ContractChangeRequestDto> = {}): ContractChangeRequestDto => ({
	effective_date: '2026-11-15',
	origin: { type: 'manual' },
	reason_id: 'reason-1',
	reason: 'Pedido del cliente',
	change,
	...overrides,
});
