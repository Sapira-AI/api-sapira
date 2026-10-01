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
import { mirrorVisibleLineAmounts } from './contract-changes.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoiceVoidService } from './contract-invoice-void.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { DiscountCreditNoteDto, VoidInvoiceDto } from './dtos/contract-invoice-credit-notes.dto';

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

interface Fixture {
	invoice?: Row;
	extra?: Row;
	previous?: Row[];
}

const build = (fixture: Fixture = {}) => {
	const invoice = fixture.invoice ?? invoiceRow();
	const lines = [lineRow(LINE_A, 1000), lineRow(LINE_B, 500, { contract_item_id: ITEM })];
	let lineSeq = 0;
	const route = (sql: string): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [contextRow];
		if (sql.includes('priced_base')) return [invoice];
		if (sql.includes('AS paid')) return [fixture.extra ?? { voided: false, paid: false }];
		if (sql.includes('ii.visible_line_id') && sql.includes('ANY($1::uuid[])')) return lines;
		if (sql.includes('i.client_tax_id, i.export_type')) return [{ id: INV, client_tax_id: '76.000.000-1', export_type: 0, notes: null }];
		if (sql.includes('c.billing_anchor_day')) return [contractRow];
		if (sql.includes('FROM consumption_entries e WHERE e.contract_item_id')) return [itemRow];
		if (sql.includes('cancelled_by_credit_note')) return [];
		if (sql.includes("nc.credit_type = 'discount'")) return fixture.previous ?? [];
		if (sql.includes('FROM consumption_entries e') && sql.includes('e.invoice_id = $1'))
			return [{ id: 'entry-1', contract_item_id: ITEM, period_start: '2026-09-01' }];
		if (sql.includes('UPDATE consumption_entries')) return [{ id: 'entry-1' }];
		if (sql.includes('SELECT company_id, client_id')) return [{ ...invoice, contract_id: CONTRACT_ID }];
		if (sql.includes('INSERT INTO invoices') && sql.includes(`'NC', $17`)) return [{ id: 'nc-1' }];
		if (sql.includes('INSERT INTO invoices')) return [{ id: 'reissue-1' }];
		if (sql.includes('INSERT INTO invoice_items')) return [{ id: `new-line-${++lineSeq}` }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${sql.length % 7}` }];

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
		invoiceDetail: jest.fn().mockResolvedValue({ id: INV, voided: true }),
	} as unknown as ContractsService;
	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as never);
	const edit = new ContractInvoiceEditService(dataSource, contracts, invoicesService);

	return { service: new ContractInvoiceVoidService(dataSource, contracts, invoicesService, edit), runner, dataSource };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const rejection = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const metadataOf = (call: unknown[]) => JSON.parse((call[1] as unknown[])[7] as string) as Row;

describe('ContractInvoiceVoidService (spec facturas §3.8 y §8)', () => {
	it('preview de anular: no abre transacción ni escribe; NC espejo y reemisión con los consumos que se liberan', async () => {
		const { service, dataSource } = build();
		const preview = await service.previewVoid(CONTRACT_ID, INV, { reason: 'issue_error', reissue: true } as VoidInvoiceDto, HOLDING, TODAY);

		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		expect(preview).toMatchObject({
			can_apply: true,
			credit_note: {
				credit_type: 'cancellation',
				due_date: null,
				totals: { amount_contract_currency: -1500, amount_invoice_currency: -1425000 },
			},
			reissue: { issue_date: '2026-09-30', notes: 'Reemplaza a F-100', split_reason: 'reissue', related_invoice_id: INV },
			consumption_entries: [{ id: 'entry-1', contract_item_id: ITEM, period_start: '2026-09-01' }],
		});
	});

	it('anular y reemitir: api primero, NC espejo exacta sin vencimiento, reemisión con líneas copiadas, consumos a la reemisión, devengo y eventos VOIDED + REISSUED', async () => {
		const { service, runner } = build();
		const result = await service.voidInvoice(
			CONTRACT_ID,
			INV,
			{ reason: 'client_request', notes: 'Pidió otra razón social', reissue: true } as VoidInvoiceDto,
			HOLDING,
			'auth-1',
			TODAY
		);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toBe(API_WRITER_SQL);
		expect(sql[1]).toContain('FOR UPDATE');
		expect(sql.some((statement) => statement.includes('FOR UPDATE OF i'))).toBe(true);
		const [nc] = calls(runner.query, `'NC', $17`);
		const ncParams = nc[1] as unknown[];

		expect(nc[0]).toContain('$6, $6, $6, NULL');
		expect(ncParams[6]).toBe('Por Emitir');
		expect(ncParams.slice(10, 14)).toEqual([-1500, -1425000, -270750, -1695750]);
		expect(ncParams[16]).toBe(INV);
		expect(ncParams[17]).toBe('other');
		expect(ncParams[28]).toBe('cancellation');
		expect(ncParams[29]).toBeNull();
		expect(ncParams[30]).toBe('Manual');
		const [reissue] = calls(runner.query, `'reissue'`);

		expect(reissue[0]).toContain('related_invoice_id, split_reason');
		expect((reissue[1] as unknown[]).slice(0, 5)).toEqual([INV, HOLDING, 'entity-1', '2026-09-30', '2026-10-30']);
		expect((reissue[1] as unknown[])[14]).toBe('Reemplaza a F-100');
		const reissueLines = calls(runner.query, 'INSERT INTO invoice_items').filter(([, params]) => (params as unknown[])[0] === 'reissue-1');

		expect(reissueLines.map(([, params]) => (params as unknown[]).slice(11, 13))).toEqual([
			[1000, 950000],
			[500, 475000],
		]);
		const [release] = calls(runner.query, 'UPDATE consumption_entries');

		expect(release[1]).toEqual([INV, HOLDING, CONTRACT_ID, 'reissue-1', 'user-1']);
		// La reemisión copia las referencias propias y los vínculos a referencias del contrato (invoice_reference_links).
		const [links] = calls(runner.query, 'INSERT INTO invoice_reference_links');

		expect(links[1]).toEqual([INV, HOLDING, 'reissue-1']);
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-09-01']);
		const events = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(events.map((call) => (call[1] as unknown[])[2])).toEqual(['INVOICE_VOIDED', 'INVOICE_REISSUED']);
		expect(metadataOf(events[0])).toMatchObject({
			invoice_id: INV,
			invoice_ids: [INV, 'nc-1', 'reissue-1'],
			credit_note_id: 'nc-1',
			reissue_invoice_id: 'reissue-1',
			reason: 'client_request',
			credit_reason: 'other',
			consumption_entries_released: ['entry-1'],
		});
		expect(metadataOf(events[1])).toMatchObject({ invoice_id: 'reissue-1', related_invoice_id: INV, split_reason: 'reissue' });
		// Decisión Domi 01-10: la original queda Cancelada (cerrada, neteada) y la NC la referencia como la NC electrónica (código 1 = anula).
		expect(sql.some((statement) => /UPDATE invoices SET status = 'Cancelada'/.test(statement))).toBe(true);
		const [referenceCall] = calls(runner.query, 'INSERT INTO invoice_references');

		expect(referenceCall[1].slice(0, 2)).toEqual(['nc-1', 'h-1']);
		expect(referenceCall[1][5]).toBe('1');
		expect(sql.some((statement) => statement.includes('updated_at') && /UPDATE invoices\b/.test(statement))).toBe(false);
		expect(result).toMatchObject({ applied: true, credit_note_id: 'nc-1', reissue_invoice_id: 'reissue-1' });
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('anular sin reemitir: los consumos del período quedan libres (invoice_id NULL) y un solo evento INVOICE_VOIDED', async () => {
		const { service, runner } = build();

		await service.voidInvoice(CONTRACT_ID, INV, { reason: 'issue_error', reissue: false } as VoidInvoiceDto, HOLDING, 'auth-1', TODAY);
		const [release] = calls(runner.query, 'UPDATE consumption_entries');

		expect((release[1] as unknown[])[3]).toBeNull();
		expect(calls(runner.query, `'reissue'`)).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events').map((call) => (call[1] as unknown[])[2])).toEqual(['INVOICE_VOIDED']);
	});

	it('anular con una NC de descuento vigente: la línea descontada se acredita por lo que queda (cantidad 1 × −monto) y se avisa', async () => {
		const { service, runner } = build({
			previous: [
				{
					credit_note_id: 'nc-0',
					credit_note_number: 'NC-1',
					contract_item_id: ITEM,
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					subtotal_contract_currency: '-100',
					subtotal_invoice_currency: '-95000',
				},
			],
		});
		const result = await service.voidInvoice(
			CONTRACT_ID,
			INV,
			{ reason: 'issue_error', reissue: false } as VoidInvoiceDto,
			HOLDING,
			'auth-1',
			TODAY
		);
		const [nc] = calls(runner.query, `'NC', $17`);

		expect((nc[1] as unknown[]).slice(10, 12)).toEqual([-1400, -1330000]);
		const ncLines = calls(runner.query, 'INSERT INTO invoice_items').filter(([, params]) => (params as unknown[])[1] === 'nc-1');

		// Línea A (1000 USD, ya descontada 100): cantidad 1 y unitario −900; línea B completa: espejo (cantidad 5, unitario −100).
		expect(ncLines.map(([, params]) => [(params as unknown[])[5], (params as unknown[])[7], (params as unknown[])[10]])).toEqual([
			[1, -900, -900],
			[5, -100, -500],
		]);
		expect(result.warnings.map((warning) => warning.code)).toContain('previous_credit_notes_considered');
	});

	it('already_voided → 409 blocked sin escribir la NC ni la reemisión', async () => {
		const { service, runner } = build({ extra: { voided: true, paid: false } });
		const error = (await rejection(
			service.voidInvoice(CONTRACT_ID, INV, { reason: 'issue_error', reissue: true } as VoidInvoiceDto, HOLDING, 'auth-1', TODAY)
		)) as ConflictException;

		expect(error).toBeInstanceOf(ConflictException);
		expect(error.getResponse()).toMatchObject({ code: 'blocked', blockers: [expect.objectContaining({ code: 'already_voided' })] });
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	it('reemisión con cambios que se desvían del plan sin motivo → 409 deviation_reason_required', async () => {
		const { service } = build();
		const error = (await rejection(
			service.voidInvoice(
				CONTRACT_ID,
				INV,
				{
					reason: 'issue_error',
					reissue: true,
					reissue_changes: {
						lines: [
							{
								id: LINE_A,
								contract_item_id: ITEM,
								quantity: 12,
								unit_price: 100,
								billing_period_start: '2026-09-01',
								billing_period_end: '2026-09-30',
							},
						],
					},
				} as unknown as VoidInvoiceDto,
				HOLDING,
				'auth-1',
				TODAY
			)
		)) as ConflictException;

		expect(error.getResponse()).toMatchObject({ code: 'deviation_reason_required' });
	});

	it('NC de descuento: NC Por Emitir con treatment, línea cantidad 1 y unitario = −monto, devengo y evento INVOICE_CREDIT_NOTE_CREATED', async () => {
		const { service, runner } = build();
		const result = await service.createCreditNote(
			CONTRACT_ID,
			INV,
			{ lines: [{ line_id: LINE_A, amount: 95000 }], reason: 'one_time_discount', revenue_treatment: 'defer_forward' } as DiscountCreditNoteDto,
			HOLDING,
			'auth-1',
			TODAY
		);
		const [nc] = calls(runner.query, `'NC', $17`);
		const params = nc[1] as unknown[];

		expect(params.slice(10, 14)).toEqual([-100, -95000, -18050, -113050]);
		expect([params[17], params[28], params[29]]).toEqual(['one_time_discount', 'discount', 'defer_forward']);
		const [ncLine] = calls(runner.query, 'INSERT INTO invoice_items');

		expect((ncLine[1] as unknown[]).slice(5, 11)).toEqual([1, 'UND', -100, -95000, 0, -100]);
		expect((ncLine[1] as unknown[])[24]).toBe(ITEM);
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(1);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect((event[1] as unknown[])[2]).toBe('INVOICE_CREDIT_NOTE_CREATED');
		expect(metadataOf(event)).toMatchObject({ credit_note_id: 'nc-1', nc_revenue_treatment: 'defer_forward', invoice_ids: [INV, 'nc-1'] });
		expect(result).toMatchObject({ applied: true, credit_note_id: 'nc-1', can_apply: true });
	});

	it('NC de descuento que supera lo que queda de la línea → 409 exceeds_line', async () => {
		const { service, runner } = build({
			previous: [
				{
					contract_item_id: ITEM,
					billing_period_start: '2026-09-01',
					billing_period_end: '2026-09-30',
					subtotal_contract_currency: '-1400',
					subtotal_invoice_currency: '-1330000',
				},
			],
		});
		const error = (await rejection(
			service.createCreditNote(
				CONTRACT_ID,
				INV,
				{ pct: 10, reason: 'other', revenue_treatment: 'impact_month' } as DiscountCreditNoteDto,
				HOLDING,
				'auth-1',
				TODAY
			)
		)) as ConflictException;

		expect(error.getResponse()).toMatchObject({ code: 'blocked', blockers: [expect.objectContaining({ code: 'exceeds_line' })] });
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
	});

	describe('DTOs y rutas', () => {
		it('void: motivo del catálogo y reissue obligatorio; credit-note: motivo y devengo del catálogo', async () => {
			const voidErrors = flattenValidationErrors(await validate(plainToInstance(VoidInvoiceDto, { reason: 'x' })));
			const ncErrors = flattenValidationErrors(
				await validate(
					plainToInstance(DiscountCreditNoteDto, { reason: 'churn', revenue_treatment: 'never', lines: [{ line_id: 'x', amount: -1 }] })
				)
			);

			expect(voidErrors.map((error) => error.field).sort()).toEqual(['reason', 'reissue']);
			expect(ncErrors.map((error) => error.field).sort()).toEqual(['lines.0.amount', 'lines.0.line_id', 'reason', 'revenue_treatment']);
		});

		it('POST …/void/preview (200), …/void, …/credit-note/preview (200), …/credit-note', () => {
			const route = (handler: keyof ContractsController) => ({
				path: Reflect.getMetadata(PATH_METADATA, ContractsController.prototype[handler]) as string,
				method: Reflect.getMetadata(METHOD_METADATA, ContractsController.prototype[handler]) as RequestMethod,
				code: Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype[handler]) as number | undefined,
			});

			expect(route('voidPreview')).toEqual({ path: ':id/invoices/:invoiceId/void/preview', method: RequestMethod.POST, code: 200 });
			expect(route('voidInvoice')).toEqual({ path: ':id/invoices/:invoiceId/void', method: RequestMethod.POST, code: undefined });
			expect(route('creditNotePreview')).toEqual({
				path: ':id/invoices/:invoiceId/credit-note/preview',
				method: RequestMethod.POST,
				code: 200,
			});
			expect(route('createCreditNote')).toEqual({ path: ':id/invoices/:invoiceId/credit-note', method: RequestMethod.POST, code: undefined });
		});
	});

	describe('NC de una factura por OC (insertMirrorCreditNote)', () => {
		it('la línea del documento de la NC lleva cantidad 1 y unitario = −Σ acreditado en sus internas (ambas monedas)', () => {
			const entries = [
				{ line: { id: 'line-v', visible_line_id: null } },
				{ line: { id: 'line-a', visible_line_id: 'line-v' } },
				{ line: { id: 'line-b', visible_line_id: 'line-v' } },
				{ line: { id: 'line-x', visible_line_id: null } },
			];
			const amounts = [
				{ subtotal: 0, subtotal_invoice: 0 },
				{ subtotal: 100, subtotal_invoice: 95000 },
				{ subtotal: 33.33, subtotal_invoice: 31666.35 },
				{ subtotal: 5, subtotal_invoice: 4750 },
			];

			expect(mirrorVisibleLineAmounts('line-v', entries, amounts)).toEqual({ unit_price: -133.33, unit_price_invoice: -126666.35 });
			expect(
				mirrorVisibleLineAmounts('line-v', entries, [amounts[0], { subtotal: 1, subtotal_invoice: null }, amounts[2], amounts[3]])
					.unit_price_invoice
			).toBeNull();
		});
	});
});
