// `InvoiceSchedulerService` (importado por el controlador) usa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { flattenValidationErrors } from '@/core/utils/validation-errors';

import { API_WRITER_SQL } from './api-writer';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicePartialPoService } from './contract-invoice-partial-po.service';
import { ContractInvoiceReorganizeService } from './contract-invoice-reorganize.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { PartialByPoDto } from './dtos/contract-invoice-partial-po.dto';

type Row = Record<string, unknown>;

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM = '99999999-9999-4999-8999-999999999999';
const LINE_A = '77777777-7777-4777-8777-777777777777';
const LINE_B = '88888888-8888-4888-8888-888888888888';
const HOLDING = 'h-1';
const TODAY = new Date('2026-09-30T12:00:00Z');

const contextRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	status: 'Activo',
	fx_invoice_policy: 'fixed',
	requires_references_for_billing: false,
	auto_send_to_odoo: true,
	payment_terms: { kind: 'net', days: 30 },
	client_entity_id: 'entity-1',
	odoo_partner_id: 1,
	entity_payment_terms: null,
	company_country: 'Chile',
	odoo_integration_id: 1,
	cutoff_date: null,
};

const invoiceRow = (overrides: Row = {}): Row => ({
	id: INV,
	invoice_number: 'F-100',
	status: 'Emitida',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-09-05',
	original_issue_date: '2026-09-05',
	scheduled_at: '2026-09-05',
	due_date: '2026-10-05',
	contract_currency: 'USD',
	invoice_currency: 'CLP',
	amount_contract_currency: '1500',
	amount_invoice_currency: '1425000',
	vat: '270750',
	total_invoice_currency: '1695750',
	fx_contract_to_invoice: '950',
	tax_rate: '19',
	fx_rate_source: 'contract',
	fx_confirmed_at: null,
	issued_externally: false,
	no_charge: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	sent_at: null,
	auto_invoice: false,
	requires_references_for_billing: false,
	consolidated_into_invoice_id: null,
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	legal_name: 'Cliente SpA',
	period_start: '2026-09-01',
	period_end: '2026-09-30',
	lines_count: '2',
	lines_without_product: '0',
	priced_base: '1500',
	references_count: '0',
	...overrides,
});

const lineRow = (id: string, subtotal: number, overrides: Row = {}): Row => ({
	id,
	invoice_id: INV,
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma',
	description_locked: false,
	quantity: String(subtotal / 100),
	unit_of_measure: 'UND',
	discount_pct: '0',
	unit_price_contract_currency: '100',
	subtotal_contract_currency: String(subtotal),
	tax_amount_contract_currency: String(subtotal * 0.19),
	total_contract_currency: String(subtotal * 1.19),
	unit_price_invoice_currency: '95000',
	subtotal_invoice_currency: String(subtotal * 950),
	tax_amount_invoice_currency: String(subtotal * 950 * 0.19),
	total_invoice_currency: String(subtotal * 950 * 1.19),
	billing_period_start: '2026-09-01',
	billing_period_end: '2026-09-30',
	quantity_source: 'fixed',
	pricing_breakdown: null,
	visible_line_id: null,
	...overrides,
});

const contractRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	client_id: 'client-1',
	document_type: 'FACTURA',
	billing_anchor_day: 1,
	group_invoices_by_period: true,
	invoice_currency: 'CLP',
	contract_currency: 'USD',
	fx_invoice_policy: 'fixed',
	payment_terms: { kind: 'net', days: 30 },
	invoice_description_template: null,
	tax_document_type_id: null,
	own_description_max_chars: null,
	company_country: 'Chile',
	company_tax_rate: '19',
	entity_country: 'Chile',
	entity_payment_terms: null,
	entity_legal_name: 'Cliente SpA',
	description_limits: [],
};

const itemRow: Row = {
	id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	unit_of_measure: 'UND',
	quantity: '10',
	unit_price: '100',
	annual_unit_price: null,
	discount_type: null,
	discount_value: null,
	final_price: '12000',
	billing_frequency: 'Mensual',
	billing_method: 'Anticipado',
	start_date: '2026-01-01',
	end_date: '2026-12-31',
	churn_date: null,
	term_months: 12,
	is_recurring: true,
	price_owner: null,
	price_id: null,
	consumption: [],
};

const generatorRow: Row = {
	client_entity_id: 'entity-1',
	document_type: 'FACTURA',
	invoice_currency: 'CLP',
	contract_currency: 'USD',
	fx_invoice_policy: 'fixed',
	company_country: 'Chile',
	company_tax_rate: '19',
	entity_country: 'Chile',
	entity_legal_name: 'Cliente SpA',
	fx_invoice_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 960, period_start: '2026-01-01', period_end: '2027-12-31' }],
};

const build = (invoice: Row = invoiceRow({ status: 'Por Emitir', invoice_number: null, issue_date: '2026-10-01' })) => {
	const lines = [lineRow(LINE_A, 1000), lineRow(LINE_B, 500)];
	let lineSeq = 0;
	const route = (sql: string): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [contextRow];
		if (sql.includes('priced_base')) return [invoice];
		if (sql.includes('ii.visible_line_id') && sql.includes('ANY($1::uuid[])')) return lines;
		if (sql.includes('i.client_tax_id, i.export_type')) return [{ id: INV, client_tax_id: '76.000.000-1', export_type: 0, notes: null }];
		if (sql.includes('contract_fx_period_rates') && sql.includes('entity_legal_name')) return [generatorRow];
		if (sql.includes('c.billing_anchor_day')) return [contractRow];
		if (sql.includes('FROM consumption_entries e WHERE e.contract_item_id')) return [itemRow];
		if (sql.includes('INSERT INTO invoices')) return [{ id: 'remainder-1' }];
		if (sql.includes('INSERT INTO invoice_items')) return [{ id: `new-line-${++lineSeq}` }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: 'event-1' }];

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
		invoiceDetail: jest.fn().mockResolvedValue({ id: INV }),
	} as unknown as ContractsService;
	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as never);
	const edit = new ContractInvoiceEditService(dataSource, contracts, invoicesService);
	const reorganize = new ContractInvoiceReorganizeService(dataSource, contracts, invoicesService, edit);

	return { service: new ContractInvoicePartialPoService(dataSource, contracts, invoicesService, edit, reorganize), runner, dataSource };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const rejection = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const dto = (amount: number, extra: Row = {}) =>
	({
		reference: { type: 'OC', code: '4500123', date: '2026-09-20' },
		amount_invoice_currency: amount,
		visible_line_text: 'Servicios OC 4500123',
		reason: 'OC por monto cerrado',
		...extra,
	}) as unknown as PartialByPoDto;

describe('ContractInvoicePartialPoService (spec facturas §3.7b)', () => {
	it('preview: no abre transacción ni escribe; propone la línea que calza exacto', async () => {
		const { service, dataSource } = build();
		const preview = await service.preview(CONTRACT_ID, INV, dto(475000), HOLDING, TODAY);

		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		expect(preview).toMatchObject({ can_apply: true, proposal: { mode: 'exact', allocation: [{ line_id: LINE_B, amount: 475000 }] } });
		expect(preview).not.toHaveProperty('write');
	});

	it('aplica: api primero; línea visible nueva, cubierta → interna con visible_line_id y neto exacto; referencia OC; saldo nuevo con reglas del generador; evento INVOICE_PARTIAL_BILLING', async () => {
		const { service, runner } = build();
		const result = await service.apply(CONTRACT_ID, INV, dto(475000), HOLDING, 'auth-1', TODAY);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toBe(API_WRITER_SQL);
		expect(sql[1]).toContain('FOR UPDATE');
		expect(sql.some((statement) => statement.includes('FOR UPDATE OF i'))).toBe(true);
		const [visible] = calls(runner.query, 'INSERT INTO invoice_items');
		const visibleParams = visible[1] as unknown[];

		expect(visibleParams[0]).toBe(INV);
		expect(visibleParams.slice(4, 8)).toEqual(['Servicios OC 4500123', true, 1, 'UND']);
		expect(visibleParams.slice(9, 13)).toEqual([500, 475000, 0, 0]);
		expect(visibleParams[18]).toBe('net_exact');
		expect(visibleParams[24]).toBeNull();
		const updates = calls(runner.query, 'UPDATE invoice_items SET invoice_id');

		expect(updates.map(([, params]) => [(params as unknown[])[0], (params as unknown[])[2], (params as unknown[])[16]])).toEqual([
			[LINE_B, INV, 'new-line-1'],
			[LINE_A, 'remainder-1', null],
		]);
		const [header] = calls(runner.query, 'UPDATE invoices SET amount_contract_currency');

		expect(header[1]).toEqual([INV, HOLDING, 500, 90250, 475000, 565250, 950]);
		const [reference] = calls(runner.query, 'INSERT INTO invoice_references');

		expect((reference[1] as unknown[]).slice(0, 5)).toEqual([INV, HOLDING, '4500123', '801', 'Orden de Compra']);
		const [remainder] = calls(runner.query, 'INSERT INTO invoices');

		expect(remainder[0]).toContain(`'partial_by_po'`);
		expect(remainder[1]).toEqual([
			CONTRACT_ID,
			HOLDING,
			'entity-1',
			'2026-11-01',
			'2026-12-01',
			182400,
			19,
			1000,
			960000,
			1142400,
			'USD',
			'CLP',
			960,
			'FACTURA',
			0,
			INV,
			'Saldo de OC 4500123 del período 09/2026',
			// Sin descuento puntual en las líneas del saldo: sin devengo de puntual.
			null,
		]);
		// Forma de pago, régimen fiscal y serie salen de la factura cubierta (origen), no de una serie fija.
		expect(remainder[0]).toContain('LEFT JOIN invoices o ON o.id = $16::uuid');
		expect(remainder[0]).toContain("COALESCE(o.invoice_series, 'FAC')");
		expect(remainder[0]).toContain('o.payment_method, o.fiscal_regime');
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(1);
		expect(calls(runner.query, 'invoice_adjustments')).toHaveLength(0);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const metadata = JSON.parse((event[1] as unknown[])[7] as string) as Row;

		expect((event[1] as unknown[])[2]).toBe('INVOICE_PARTIAL_BILLING');
		expect(metadata).toMatchObject({
			invoice_id: INV,
			remainder_invoice_id: 'remainder-1',
			invoice_ids: [INV, 'remainder-1'],
			reference: { type: 'OC', code: '4500123' },
			covered_total: 475000,
			visible_line_id: 'new-line-1',
			fx_difference: 0,
			fx: { net_exact: true, fx_after: 950, remainder_fx: 960 },
		});
		expect(sql.some((statement) => /UPDATE invoices\b/.test(statement) && statement.includes('updated_at'))).toBe(false);
		expect(result).toMatchObject({ applied: true, remainder_invoice_id: 'remainder-1', visible_line_id: 'new-line-1' });
	});

	it('emitida o spot sin tasa → 409 blocked sin escribir', async () => {
		const { service, runner } = build(invoiceRow({ status: 'Emitida' }));
		const error = (await rejection(service.apply(CONTRACT_ID, INV, dto(475000), HOLDING, 'auth-1', TODAY))) as ConflictException;

		expect(error.getResponse()).toMatchObject({ code: 'blocked', blockers: [expect.objectContaining({ code: 'not_pending' })] });
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
		const spot = build(invoiceRow({ status: 'Por Emitir', fx_contract_to_invoice: null }));
		const spotError = (await rejection(spot.service.apply(CONTRACT_ID, INV, dto(475000), HOLDING, 'auth-1', TODAY))) as ConflictException;

		expect(spotError.getResponse()).toMatchObject({ blockers: [expect.objectContaining({ code: 'spot_without_rate' })] });
	});

	it('DTO y rutas', async () => {
		const errors = flattenValidationErrors(
			await validate(
				plainToInstance(PartialByPoDto, {
					reference: { type: 'OCX', code: ' ' },
					amount_invoice_currency: 0,
					visible_line_text: '',
					reason: '',
				})
			)
		);

		expect(errors.map((error) => error.field).sort()).toEqual([
			'amount_invoice_currency',
			'reason',
			'reference.code',
			'reference.type',
			'visible_line_text',
		]);
		const route = (handler: keyof ContractsController) => ({
			path: Reflect.getMetadata(PATH_METADATA, ContractsController.prototype[handler]) as string,
			method: Reflect.getMetadata(METHOD_METADATA, ContractsController.prototype[handler]) as RequestMethod,
			code: Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype[handler]) as number | undefined,
		});

		expect(route('partialByPoPreview')).toEqual({ path: ':id/invoices/:invoiceId/partial-by-po/preview', method: RequestMethod.POST, code: 200 });
		expect(route('partialByPo')).toEqual({ path: ':id/invoices/:invoiceId/partial-by-po', method: RequestMethod.POST, code: undefined });
	});
});
