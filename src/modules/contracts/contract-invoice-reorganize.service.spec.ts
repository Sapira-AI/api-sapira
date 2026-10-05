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
import { ContractInvoiceReorganizeService } from './contract-invoice-reorganize.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ReorganizeInvoicesDto } from './dtos/contract-invoice-reorganize.dto';
import { MC_UF_ITEM, mcInvoiceRow, mcStoredLine, multicurrencyRoute, revaluedHeaders } from './multicurrency.test-fixtures';

type Row = Record<string, unknown>;

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
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

const invoiceRow = (id: string, issueDate: string, overrides: Row = {}): Row => ({
	id,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: issueDate,
	original_issue_date: issueDate,
	scheduled_at: issueDate,
	due_date: null,
	contract_currency: 'USD',
	invoice_currency: 'CLP',
	amount_contract_currency: '1000',
	amount_invoice_currency: '900000',
	vat: '171000',
	total_invoice_currency: '1071000',
	fx_contract_to_invoice: '900',
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
	period_start: issueDate,
	period_end: null,
	lines_count: '1',
	lines_without_product: '0',
	priced_base: '1000',
	references_count: '0',
	...overrides,
});

const lineRow = (id: string, invoiceId: string, start: string, end: string, overrides: Row = {}): Row => ({
	id,
	invoice_id: invoiceId,
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma',
	description_locked: false,
	quantity: '10',
	unit_of_measure: 'UND',
	discount_pct: '0',
	unit_price_contract_currency: '100',
	subtotal_contract_currency: '1000',
	tax_amount_contract_currency: '190',
	total_contract_currency: '1190',
	unit_price_invoice_currency: '90000',
	subtotal_invoice_currency: '900000',
	tax_amount_invoice_currency: '171000',
	total_invoice_currency: '1071000',
	billing_period_start: start,
	billing_period_end: end,
	quantity_source: 'fixed',
	pricing_breakdown: null,
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
	start_date: '2026-10-01',
	end_date: '2027-09-30',
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
	fx_invoice_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2027-12-31' }],
};

interface Fixture {
	invoices?: Record<string, Row>;
	lines?: Record<string, Row[]>;
}

const build = (fixture: Fixture = {}) => {
	const invoices = fixture.invoices ?? { [INV_A]: invoiceRow(INV_A, '2026-10-01'), [INV_B]: invoiceRow(INV_B, '2026-11-01') };
	const lines = fixture.lines ?? {
		[INV_A]: [lineRow(LINE_A, INV_A, '2026-10-01', '2026-10-31')],
		[INV_B]: [lineRow(LINE_B, INV_B, '2026-11-01', '2026-11-30')],
	};
	let created = 0;
	const route = (sql: string, params: unknown[] = []): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [contextRow];
		if (sql.includes('priced_base')) {
			if (sql.includes("i.status = 'Por Emitir' AND i.is_active = true"))
				return Object.values(invoices).filter((row) => row.status === 'Por Emitir' && row.is_active !== false);
			if (sql.includes('ANY($3::uuid[])')) return (params[2] as string[]).map((id) => invoices[id]).filter(Boolean);

			return invoices[params[0] as string] ? [invoices[params[0] as string]] : [];
		}
		if (sql.includes('contract_fx_period_rates') && sql.includes('entity_legal_name')) return [generatorRow];
		if (sql.includes('c.billing_anchor_day')) return [contractRow];
		if (sql.includes('FROM consumption_entries e')) return [itemRow];
		if (sql.includes('cancelled_by_credit_note'))
			return Object.entries(lines).flatMap(([invoiceId, rows]) =>
				rows.map((row) => ({ ...row, invoice_id: invoiceId, status: invoices[invoiceId]?.status ?? 'Por Emitir', document_type: 'FACTURA' }))
			);
		if (sql.includes('ii.description_locked') && sql.includes('ANY($1::uuid[])')) return (params[0] as string[]).flatMap((id) => lines[id] ?? []);
		if (sql.includes('ii.id, ii.invoice_id, i.status')) return [];
		if (sql.includes('INSERT INTO invoices')) return [{ id: `new-invoice-${++created}` }];
		if (sql.includes('INSERT INTO invoice_adjustments')) return [{ id: 'adj-1' }];
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
	const contracts = { resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID, status: 'Activo' }) } as unknown as ContractsService;
	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as never);
	const edit = new ContractInvoiceEditService(dataSource, contracts, invoicesService);

	return { service: new ContractInvoiceReorganizeService(dataSource, contracts, invoicesService, edit), runner, dataSource };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const rejection = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const dto = (body: Row) => body as unknown as ReorganizeInvoicesDto;

describe('ContractInvoiceReorganizeService (spec facturas §3.5)', () => {
	it('schedule-lines: Por Emitir con sus líneas ordenadas por período, sin escribir ni correr transacciones', async () => {
		const { service, dataSource, runner } = build();
		const board = await service.scheduleLines(CONTRACT_ID, HOLDING, TODAY);

		expect(runner.query).not.toHaveBeenCalled();
		expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		expect(board.invoices.map((invoice) => [invoice.id, invoice.lines.map((line) => line.id)])).toEqual([
			[INV_A, [LINE_A]],
			[INV_B, [LINE_B]],
		]);
		expect(board.invoices[0]).toMatchObject({ operable: true, header_residual: 0 });
		expect(board.items).toEqual([expect.objectContaining({ id: ITEM, product_name: 'Plataforma' })]);
	});

	it('preview: no abre transacción ni escribe', async () => {
		const { service, dataSource } = build();
		const preview = await service.preview(CONTRACT_ID, dto({ operations: [{ op: 'merge', invoice_ids: [INV_A, INV_B] }] }), HOLDING, TODAY);

		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		expect(preview).toMatchObject({ can_apply: true, continuity: { changed: false } });
		expect(preview.invoices.map((invoice) => [invoice.id, invoice.action])).toEqual([
			[INV_A, 'updated'],
			[INV_B, 'cancelled'],
		]);
	});

	it('merge: marca api primero, bloquea contrato y Por Emitir, mueve la línea por UPDATE, la vacía queda Cancelada (sin DELETE) y un evento INVOICES_REORGANIZED', async () => {
		const { service, runner } = build();
		const result = await service.apply(
			CONTRACT_ID,
			dto({ operations: [{ op: 'merge', invoice_ids: [INV_A, INV_B] }], reason: 'Cliente pidió una sola factura' }),
			HOLDING,
			'auth-1',
			TODAY
		);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toBe(API_WRITER_SQL);
		expect(sql[1]).toContain('FOR UPDATE');
		expect(sql.some((statement) => statement.includes('FOR UPDATE OF i'))).toBe(true);
		const [move] = calls(runner.query, 'UPDATE invoice_items SET invoice_id');

		expect((move[1] as unknown[]).slice(0, 3)).toEqual([LINE_B, HOLDING, INV_A]);
		const headers = calls(runner.query, 'UPDATE invoices SET amount_contract_currency');

		expect(headers.map(([statement, params]) => [(params as unknown[])[0], (params as unknown[])[6], statement.includes('updated_at')])).toEqual([
			[INV_A, 'Por Emitir', false],
			[INV_B, 'Cancelada', false],
		]);
		expect(headers[0][1]).toEqual(expect.arrayContaining([2000, 1800000]));
		expect(sql.some((statement) => /DELETE FROM invoices/i.test(statement))).toBe(false);
		expect(sql.some((statement) => statement.includes('revenue_schedule_rebuild'))).toBe(false);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const metadata = JSON.parse((event[1] as unknown[])[7] as string) as Row;

		expect((event[1] as unknown[])[2]).toBe('INVOICES_REORGANIZED');
		expect(metadata).toMatchObject({
			invoice_ids: [INV_A, INV_B],
			invoices_cancelled: [INV_B],
			created_invoices: [],
			reason: 'Cliente pidió una sola factura',
		});
		expect(result).toMatchObject({ applied: true, event_id: 'event-1', created_invoice_ids: [], cancelled_invoice_ids: [INV_B] });
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('move_line a una factura nueva: INSERT con reglas del generador (FX del contrato para el período, split_reason reorganize, split_from)', async () => {
		const { service, runner } = build({
			invoices: { [INV_A]: invoiceRow(INV_A, '2026-10-01', { amount_contract_currency: '1500' }) },
			lines: {
				[INV_A]: [
					lineRow(LINE_A, INV_A, '2026-10-01', '2026-10-31'),
					lineRow(LINE_B, INV_A, '2026-10-01', '2026-10-31', {
						subtotal_contract_currency: '500',
						unit_price_contract_currency: '50',
						tax_amount_contract_currency: '95',
						total_contract_currency: '595',
					}),
				],
			},
		});
		const result = await service.apply(
			CONTRACT_ID,
			dto({ operations: [{ op: 'move_line', line_id: LINE_B, new_invoice: { issue_date: '2026-10-20' } }] }),
			HOLDING,
			'auth-1',
			TODAY
		);
		const [insert] = calls(runner.query, 'INSERT INTO invoices');
		const params = insert[1] as unknown[];

		expect(insert[0]).toContain("'reorganize'");
		expect(params).toEqual([
			CONTRACT_ID,
			HOLDING,
			'entity-1',
			'2026-10-20',
			'2026-11-19',
			90250,
			19,
			500,
			475000,
			565250,
			'USD',
			'CLP',
			950,
			'FACTURA',
			0,
			INV_A,
		]);
		// Forma de pago, régimen fiscal y serie salen de la factura de origen (split_from), no de una serie fija.
		expect(insert[0]).toContain('LEFT JOIN invoices o ON o.id = $16::uuid');
		expect(insert[0]).toContain("COALESCE(o.invoice_series, 'FAC')");
		expect(insert[0]).toContain('o.payment_method, o.fiscal_regime');
		// Los consumos del período de la línea movida pasan con ella (antes de mover la línea).
		const [consumption] = calls(runner.query, 'UPDATE consumption_entries');

		expect(consumption[1]).toEqual([INV_A, HOLDING, 'new-invoice-1', ITEM, '2026-10-01', 'user-1']);
		const [move] = calls(runner.query, 'UPDATE invoice_items SET invoice_id');

		expect((move[1] as unknown[]).slice(0, 3)).toEqual([LINE_B, HOLDING, 'new-invoice-1']);
		expect((move[1] as unknown[]).slice(-2)).toEqual([950, 'CLP']);
		expect(result.created_invoice_ids).toEqual(['new-invoice-1']);
	});

	it('bloqueos → 409 blocked con el preview; no confirma', async () => {
		const { service, runner } = build({
			invoices: {
				[INV_A]: invoiceRow(INV_A, '2026-10-01'),
				[INV_B]: invoiceRow(INV_B, '2026-11-01', { odoo_invoice_id: 77, sent_to_odoo_at: '2026-09-29' }),
			},
		});
		const error = await rejection(
			service.apply(CONTRACT_ID, dto({ operations: [{ op: 'merge', invoice_ids: [INV_A, INV_B] }] }), HOLDING, 'auth-1', TODAY)
		);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as ConflictException).getResponse()).toMatchObject({
			code: 'blocked',
			blockers: [expect.objectContaining({ code: 'sent_to_erp_draft' })],
		});
		expect(runner.commitTransaction).not.toHaveBeenCalled();
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	it('cambio del total por ítem sin motivo → 409 deviation_reason_required; con motivo, fila en invoice_adjustments', async () => {
		const fixture = {
			invoices: { [INV_A]: invoiceRow(INV_A, '2026-10-01', { amount_contract_currency: '1005' }) },
			lines: { [INV_A]: [lineRow(LINE_A, INV_A, '2026-10-01', '2026-10-31')] },
		};
		const missing = build(fixture);
		const error = await rejection(
			missing.service.apply(CONTRACT_ID, dto({ operations: [{ op: 'round_fix', invoice_id: INV_A }] }), HOLDING, 'auth-1', TODAY)
		);

		expect((error as ConflictException).getResponse()).toMatchObject({ code: 'deviation_reason_required' });
		const explained = build(fixture);
		const result = await explained.service.apply(
			CONTRACT_ID,
			dto({ operations: [{ op: 'round_fix', invoice_id: INV_A }], deviation: { type: 'correction', reason: 'Cuadre con la OC' } }),
			HOLDING,
			'auth-1',
			TODAY
		);
		const [adjustment] = calls(explained.runner.query, 'INSERT INTO invoice_adjustments');

		expect(adjustment[1]).toEqual([INV_A, HOLDING, 'correction', 5, 'Cuadre con la OC', 'user-1']);
		expect(result.adjustment_ids).toEqual(['adj-1']);
	});

	it('split por fecha reconstruye el devengo desde el primer mes con período cambiado', async () => {
		const { service, runner } = build({
			invoices: { [INV_A]: invoiceRow(INV_A, '2026-10-01', { amount_contract_currency: '3000' }) },
			lines: { [INV_A]: [lineRow(LINE_A, INV_A, '2026-10-01', '2026-12-31', { subtotal_contract_currency: '3000' })] },
		});

		await service.apply(
			CONTRACT_ID,
			dto({ operations: [{ op: 'split_line', line_id: LINE_A, by: 'date', at: '2026-10-31' }] }),
			HOLDING,
			'auth-1',
			TODAY
		);
		const [rebuild] = calls(runner.query, 'revenue_schedule_rebuild');

		expect(rebuild[1]).toEqual([CONTRACT_ID, '2026-10-01']);
		expect(calls(runner.query, 'INSERT INTO invoice_items')).toHaveLength(1);
	});
});

describe('ReorganizeInvoicesDto', () => {
	const errorsOf = async (body: Row) =>
		flattenValidationErrors(await validate(plainToInstance(ReorganizeInvoicesDto, body), { whitelist: true, forbidNonWhitelisted: true }));

	it('valida por operación: merge con una sola factura, split_line sin forma, op desconocida', async () => {
		expect(await errorsOf({ operations: [{ op: 'merge', invoice_ids: [INV_A] }] })).toEqual([
			{ field: 'operations.0.invoice_ids', message: 'Indica al menos dos facturas para juntar' },
		]);
		expect((await errorsOf({ operations: [{ op: 'split_line', line_id: LINE_A }] })).map((error) => error.field)).toEqual(['operations.0.by']);
		expect((await errorsOf({ operations: [{ op: 'split_line', line_id: LINE_A, by: 'date' }] })).map((error) => error.field)).toEqual([
			'operations.0.at',
		]);
		expect((await errorsOf({ operations: [{ op: 'explode' }] }))[0].field).toBe('operations.0.op');
		expect(
			await errorsOf({ operations: [{ op: 'item_even_split', contract_item_id: ITEM, count: 3 }], deviation: { type: 'upsell', reason: 'x' } })
		).toEqual([]);
	});
});

describe('ContractsController (reorganizar)', () => {
	const proto = ContractsController.prototype as unknown as Record<string, object>;

	it('rutas: GET schedule-lines antes del detalle, POST reorganize/preview (200) y POST reorganize', () => {
		expect(Reflect.getMetadata(PATH_METADATA, proto.invoiceScheduleLines)).toBe(':id/invoices/schedule-lines');
		expect(Reflect.getMetadata(METHOD_METADATA, proto.invoiceScheduleLines)).toBe(RequestMethod.GET);
		expect(Reflect.getMetadata(PATH_METADATA, proto.reorganizePreview)).toBe(':id/invoices/reorganize/preview');
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.reorganizePreview)).toBe(200);
		expect(Reflect.getMetadata(PATH_METADATA, proto.reorganize)).toBe(':id/invoices/reorganize');
		expect(Reflect.getMetadata(METHOD_METADATA, proto.reorganize)).toBe(RequestMethod.POST);
		const methods = Object.getOwnPropertyNames(ContractsController.prototype);

		expect(methods.indexOf('invoiceScheduleLines')).toBeLessThan(methods.indexOf('invoiceDetail'));
	});

	it('pasa contrato, cuerpo, holding y usuario al servicio', async () => {
		const reorganizeService = {
			preview: jest.fn().mockResolvedValue({}),
			apply: jest.fn().mockResolvedValue({}),
			scheduleLines: jest.fn().mockResolvedValue({}),
		};
		const Controller = ContractsController as unknown as new (...args: unknown[]) => ContractsController;
		const controller = new Controller(...Array.from({ length: 11 }, () => ({})), reorganizeService);
		const body = dto({ operations: [{ op: 'round_fix', invoice_id: INV_A }] });

		await controller.reorganizePreview(CONTRACT_ID, body, HOLDING);
		await controller.reorganize(CONTRACT_ID, body, HOLDING, { user: { sub: 'auth-1' } });
		await controller.invoiceScheduleLines(CONTRACT_ID, HOLDING);
		expect(reorganizeService.preview).toHaveBeenCalledWith(CONTRACT_ID, body, HOLDING);
		expect(reorganizeService.apply).toHaveBeenCalledWith(CONTRACT_ID, body, HOLDING, 'auth-1');
		expect(reorganizeService.scheduleLines).toHaveBeenCalledWith(CONTRACT_ID, HOLDING);
	});
});

describe('ContractInvoiceReorganizeService · multimoneda (spec-multimoneda §4)', () => {
	it('merge de dos Por Emitir con pares distintos: la línea movida conserva la tasa de SU par (no la del encabezado de destino) y el destino queda = Σ líneas con FX NULL', async () => {
		const clp = { contract_currency: 'CLP', invoice_currency: 'CLP', fx_contract_to_invoice: null };
		const usd = lineRow(LINE_A, INV_A, '2026-10-01', '2026-10-31', {
			subtotal_invoice_currency: '950000',
			line_currency: 'USD',
			line_fx: '950',
			line_fx_rate_source: 'contract',
		});
		const uf = lineRow(LINE_B, INV_B, '2026-11-01', '2026-11-30', {
			contract_item_id: MC_UF_ITEM,
			quantity: '1',
			unit_price_contract_currency: '10',
			subtotal_contract_currency: '10',
			tax_amount_contract_currency: '1.9',
			total_contract_currency: '11.9',
			unit_price_invoice_currency: '380000',
			subtotal_invoice_currency: '380000',
			tax_amount_invoice_currency: '72200',
			total_invoice_currency: '452200',
			line_currency: 'UF',
			line_fx: '38000',
			line_fx_rate_source: 'contract',
		});
		const { service, runner, dataSource } = build({
			invoices: { [INV_A]: invoiceRow(INV_A, '2026-10-01', clp), [INV_B]: invoiceRow(INV_B, '2026-11-01', clp) },
			lines: { [INV_A]: [usd], [INV_B]: [uf] },
		});
		const base = runner.query.getMockImplementation()!;
		const mc = multicurrencyRoute({
			contract_id: CONTRACT_ID,
			invoices: { [INV_A]: mcInvoiceRow(INV_A, CONTRACT_ID) },
			lines: { [INV_A]: [mcStoredLine(LINE_A, 'USD'), mcStoredLine(LINE_B, 'UF', { billing_period_start: '2026-11-01' })] },
		});
		const route = (sql: string, params: unknown[] = []) => {
			if (sql.includes('c.billing_anchor_day'))
				return [{ ...contractRow, contract_currency: 'CLP', invoice_currency: 'CLP', requires_multicurrency_billing: true }];

			return mc(sql, params) ?? base(sql, params);
		};

		runner.query.mockImplementation(route);
		(dataSource.query as unknown as jest.Mock).mockImplementation(route);
		await service.apply(CONTRACT_ID, dto({ operations: [{ op: 'merge', invoice_ids: [INV_A, INV_B] }] }), HOLDING, 'auth-1', TODAY);
		const move = calls(runner.query, 'UPDATE invoice_items SET invoice_id').find(([, params]) => (params as unknown[])[0] === LINE_B)!;

		// $12 = subtotal en moneda de factura, $18 = tasa de la línea: la del par UF → CLP.
		expect([(move[1] as unknown[])[0], (move[1] as unknown[])[11], (move[1] as unknown[])[17]]).toEqual([LINE_B, 380000, 38000]);
		expect(revaluedHeaders(runner.query.mock.calls)).toEqual([
			expect.objectContaining({ id: INV_A, fx: null, amount_invoice_currency: 1330000, amount_contract_currency: 1270000 }),
		]);
	});
});
