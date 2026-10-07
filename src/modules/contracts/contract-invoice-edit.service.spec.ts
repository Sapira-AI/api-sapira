// `InvoiceSchedulerService` (importado por el controlador) usa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { flattenValidationErrors } from '@/core/utils/validation-errors';

import { API_WRITER_SQL } from './api-writer';
import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { EditInvoiceDto } from './dtos/contract-invoice-edit.dto';
import { MC_UF_ITEM, mcInvoiceRow, mcStoredLine, multicurrencyRoute, revaluedHeaders, revaluedLines } from './multicurrency.test-fixtures';

type Row = Record<string, unknown>;

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = '99999999-9999-4999-8999-999999999999';
const LINE = '77777777-7777-4777-8777-777777777777';
const HOLDING = 'h-1';
const TODAY = new Date('2026-09-30T12:00:00Z');

const contextRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	status: 'Activo',
	fx_invoice_policy: null,
	requires_references_for_billing: false,
	auto_send_to_odoo: false,
	payment_terms: { kind: 'net', days: 30 },
	client_entity_id: 'entity-1',
	odoo_partner_id: 1,
	entity_payment_terms: null,
	company_country: 'Chile',
	odoo_integration_id: null,
	cutoff_date: null,
};

const invoiceRow = (id: string, overrides: Row = {}): Row => ({
	id,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-10-01',
	original_issue_date: '2026-10-01',
	scheduled_at: '2026-10-01',
	due_date: '2026-10-31',
	contract_currency: 'USD',
	invoice_currency: 'USD',
	amount_contract_currency: '1000',
	amount_invoice_currency: '1000',
	vat: '190',
	total_invoice_currency: '1190',
	fx_contract_to_invoice: '1',
	tax_rate: '19',
	fx_rate_source: null,
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
	period_start: '2026-10-01',
	period_end: '2026-10-31',
	lines_count: '1',
	lines_without_product: '0',
	priced_base: '1000',
	references_count: '0',
	...overrides,
});

const lineRow = (invoiceId: string, overrides: Row = {}): Row => ({
	id: LINE,
	invoice_id: invoiceId,
	contract_item_id: ITEM,
	product_id: 'prod-1',
	product_name: 'Plataforma',
	account: null,
	description: 'Plataforma - Periodo 01/10/2026 a 31/10/2026',
	description_locked: false,
	quantity: '10',
	unit_of_measure: 'UND',
	discount_pct: '0',
	unit_price_contract_currency: '100',
	subtotal_contract_currency: '1000',
	tax_amount_contract_currency: '190',
	total_contract_currency: '1190',
	unit_price_invoice_currency: '100',
	subtotal_invoice_currency: '1000',
	tax_amount_invoice_currency: '190',
	total_invoice_currency: '1190',
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	quantity_source: 'fixed',
	pricing_breakdown: null,
	...overrides,
});

/** Contrato para el motor: un ítem mensual de 10 × 100 desde octubre (el plan espera 1.000 por período). */
const contractRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	client_id: 'client-1',
	document_type: 'FACTURA',
	billing_anchor_day: 1,
	group_invoices_by_period: true,
	invoice_currency: 'USD',
	contract_currency: 'USD',
	fx_invoice_policy: null,
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

interface Fixture {
	invoices?: Record<string, Row>;
	lines?: Record<string, Row[]>;
	receiver?: Row | null;
	adjustments?: Row[];
}

const build = (fixture: Fixture = {}) => {
	const invoices = fixture.invoices ?? { [INV_A]: invoiceRow(INV_A) };
	const lines = fixture.lines ?? { [INV_A]: [lineRow(INV_A)] };
	let events = 0;
	const route = (sql: string, params: unknown[] = []): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [contextRow];
		if (sql.includes('priced_base')) {
			if (sql.includes("i.status = 'Por Emitir' AND i.is_active = true"))
				return Object.values(invoices).filter((row) => row.status === 'Por Emitir');
			if (sql.includes('ANY($3::uuid[])')) return (params[2] as string[]).map((id) => invoices[id]).filter(Boolean);
			const row = invoices[params[0] as string];

			return row ? [row] : [];
		}
		if (sql.includes('i.client_tax_id, i.export_type'))
			return (params[0] as string[]).map((id) => ({
				id,
				client_tax_id: '76.000.000-1',
				export_type: 0,
				notes: null,
				nc_revenue_treatment: null,
			}));
		if (sql.includes('c.billing_anchor_day')) return [contractRow];
		if (sql.includes('FROM consumption_entries e')) return [itemRow];
		if (sql.includes('cancelled_by_credit_note'))
			return Object.entries(lines).flatMap(([invoiceId, rows]) =>
				rows.map((row) => ({ ...row, invoice_id: invoiceId, status: invoices[invoiceId]?.status ?? 'Por Emitir', document_type: 'FACTURA' }))
			);
		if (sql.includes('ii.description_locked') && sql.includes('ANY($1::uuid[])')) return (params[0] as string[]).flatMap((id) => lines[id] ?? []);
		if (sql.includes('FROM invoice_references r')) return [];
		if (sql.includes('client_entity_clients')) return fixture.receiver ? [fixture.receiver] : [];
		if (sql.includes('DISTINCT ON (a.invoice_id)')) return fixture.adjustments ?? [];
		if (sql.includes('INSERT INTO invoice_adjustments')) return [{ id: 'adj-1' }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${++events}` }];

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
		invoiceDetail: jest.fn().mockResolvedValue({ id: INV_A }),
		invoicedVsTotal: jest.fn().mockResolvedValue({ invoices_count: 2, invoiced_total: 1300, total_value: 1500 }),
	} as unknown as ContractsService;
	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as never);

	return { service: new ContractInvoiceEditService(dataSource, contracts, invoicesService), runner, dataSource, contracts };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const events = (mock: jest.Mock) =>
	calls(mock, 'INSERT INTO contract_lifecycle_events').map(([, params]) => ({
		type: (params as unknown[])[2],
		metadata: JSON.parse((params as unknown[])[7] as string) as Row,
	}));
const rejection = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const lineEdit = (overrides: Row = {}) => ({
	id: LINE,
	contract_item_id: ITEM,
	quantity: 10,
	unit_price: 100,
	discount_pct: 0,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	...overrides,
});

describe('ContractInvoiceEditService (spec facturas §3.4)', () => {
	describe('previewEdit', () => {
		it('no abre transacción ni escribe; devuelve encabezado y líneas antes/después, desvío contra el plan del motor y avisos', async () => {
			const { service, dataSource, runner } = build();
			const preview = await service.previewEdit(CONTRACT_ID, INV_A, { lines: [lineEdit({ quantity: 12 })] }, HOLDING, TODAY);

			expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
			expect(runner.query).not.toHaveBeenCalled();
			expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
			expect(preview.invoice).toMatchObject({
				id: INV_A,
				before: { amount_contract_currency: 1000, status: 'Por Emitir' },
				after: { amount_contract_currency: 1200, vat: 228, total_invoice_currency: 1428, status: 'Por Emitir' },
			});
			expect(preview.lines).toEqual([
				expect.objectContaining({
					id: LINE,
					action: 'update',
					is_visible: true,
					after: expect.objectContaining({ quantity: 12, quantity_source: 'manual' }),
				}),
			]);
			// El plan (motor con el ítem mensual 10 × 100) espera 1.000 en octubre: la edición deja 1.200.
			expect(preview.deviation).toMatchObject({
				has_deviation: true,
				total_diff: 200,
				changed: true,
				reason_required: true,
				by_item: [expect.objectContaining({ contract_item_id: ITEM, expected: 1000, actual: 1200, diff: 200 })],
			});
			expect(preview.warnings.map((warning) => warning.code)).toContain('deviation_reason_required');
			expect(preview.can_apply).toBe(true);
			expect(preview.revenue_effect).toBeNull();
		});

		it('errores de forma → 400 con errors[{ field, message }]', async () => {
			const { service } = build();
			const error = await rejection(
				service.previewEdit(CONTRACT_ID, INV_A, { lines: [lineEdit({ id: '00000000-0000-4000-8000-000000000000' })] }, HOLDING, TODAY)
			);

			expect(error).toBeInstanceOf(BadRequestException);
			expect(((error as BadRequestException).getResponse() as Row).errors).toEqual([
				{ field: 'lines.0.id', message: 'La línea no pertenece a esta factura' },
			]);
		});
	});

	describe('edit (PUT)', () => {
		it('desvío sin motivo → 409 deviation_reason_required con el preview; no confirma', async () => {
			const { service, runner } = build();
			const error = await rejection(service.edit(CONTRACT_ID, INV_A, { lines: [lineEdit({ quantity: 12 })] }, HOLDING, 'auth-1', TODAY));

			expect(error).toBeInstanceOf(ConflictException);
			const response = (error as ConflictException).getResponse() as Row;

			expect(response.code).toBe('deviation_reason_required');
			expect((response.blockers as Row[])[0]).toMatchObject({ code: 'deviation_reason_required' });
			expect(response.preview).toMatchObject({ deviation: { has_deviation: true } });
			expect(runner.commitTransaction).not.toHaveBeenCalled();
			expect(runner.rollbackTransaction).toHaveBeenCalled();
		});

		it('con motivo: marca api primero, bloquea contrato y factura, encabezado = Σ líneas, línea manual, devengo, ajuste y evento INVOICE_EDITED', async () => {
			const { service, runner, contracts } = build();
			const result = await service.edit(
				CONTRACT_ID,
				INV_A,
				{ lines: [lineEdit({ quantity: 12 })], deviation: { type: 'upsell', reason: 'Dos usuarios más este mes' } },
				HOLDING,
				'auth-1',
				TODAY
			);
			const sql = sqlOf(runner.query);

			expect(sql[0]).toBe(API_WRITER_SQL);
			expect(sql[1]).toContain('FOR UPDATE');
			expect(sql.some((statement) => statement.includes('FOR UPDATE OF i'))).toBe(true);
			const [header] = calls(runner.query, 'UPDATE invoices SET issue_date');

			expect(header[1]).toEqual(expect.arrayContaining([INV_A, HOLDING, 1200, 228, 'Por Emitir']));
			expect(header[0]).not.toContain('updated_at');
			const [lineUpdate] = calls(runner.query, 'UPDATE invoice_items SET description');

			expect(lineUpdate[1]).toEqual(expect.arrayContaining([LINE, INV_A, HOLDING, 12, 1200, 228, 'manual']));
			expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-10-01']);
			expect(calls(runner.query, 'INSERT INTO invoice_adjustments')[0][1]).toEqual([
				INV_A,
				HOLDING,
				'upsell',
				200,
				'Dos usuarios más este mes',
				'user-1',
			]);
			const [event] = events(runner.query);

			expect(event.type).toBe('INVOICE_EDITED');
			expect(event.metadata).toMatchObject({
				source: 'contract_360',
				invoice_id: INV_A,
				deviation: { has_deviation: true, total_diff: 200 },
				deviation_type: 'upsell',
				adjustment_id: 'adj-1',
				lines: [expect.objectContaining({ id: LINE, action: 'update' })],
			});
			expect(result).toMatchObject({ applied: true, event_id: 'event-1', adjustment_id: 'adj-1', invoice: { id: INV_A } });
			expect(runner.commitTransaction).toHaveBeenCalled();
			expect(contracts.invoiceDetail).toHaveBeenCalledWith(CONTRACT_ID, INV_A, HOLDING);
		});

		it('borrador en el ERP → 409 blocked (sent_to_erp_draft con acción erp_reset); nada se escribe', async () => {
			const { service, runner } = build({ invoices: { [INV_A]: invoiceRow(INV_A, { odoo_invoice_id: 55 }) } });
			const error = await rejection(service.edit(CONTRACT_ID, INV_A, { notes: 'x' }, HOLDING, 'auth-1', TODAY));
			const response = (error as ConflictException).getResponse() as Row;

			expect(response.code).toBe('blocked');
			expect(response.blockers).toEqual([expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' })]);
			expect(sqlOf(runner.query).filter((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toEqual([]);
		});

		it('todas las líneas en 0: la factura pasa a Cancelada sin cobro y deja INVOICE_NO_CHARGE (zero_edit); la línea queda (no se borra)', async () => {
			const { service, runner } = build();

			await service.edit(
				CONTRACT_ID,
				INV_A,
				{ lines: [lineEdit({ quantity: 0 })], deviation: { type: 'downsell', reason: 'Sin servicio en octubre' } },
				HOLDING,
				'auth-1',
				TODAY
			);
			const [header] = calls(runner.query, 'UPDATE invoices SET issue_date');

			expect((header[1] as unknown[]).slice(-3)).toEqual(['Cancelada', null, 'Por Emitir']);
			expect(calls(runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);
			expect(events(runner.query).map((event) => event.type)).toEqual(['INVOICE_EDITED', 'INVOICE_NO_CHARGE']);
			expect(events(runner.query)[1].metadata).toMatchObject({
				reason: 'zero_edit',
				before: { status: 'Por Emitir' },
				after: { status: 'Cancelada' },
			});
		});

		it('sin cobro que recupera cantidad: vuelve a Por Emitir con INVOICE_NO_CHARGE_REVERTED', async () => {
			const { service, runner } = build({
				invoices: { [INV_A]: invoiceRow(INV_A, { status: 'Cancelada', no_charge: true, amount_contract_currency: '0', vat: '0' }) },
				lines: {
					[INV_A]: [
						lineRow(INV_A, {
							quantity: '0',
							subtotal_contract_currency: '0',
							tax_amount_contract_currency: '0',
							total_contract_currency: '0',
							subtotal_invoice_currency: '0',
							tax_amount_invoice_currency: '0',
							total_invoice_currency: '0',
						}),
					],
				},
			});

			await service.edit(CONTRACT_ID, INV_A, { lines: [lineEdit({ quantity: 10 })] }, HOLDING, 'auth-1', TODAY);
			const [header] = calls(runner.query, 'UPDATE invoices SET issue_date');

			expect((header[1] as unknown[]).slice(-3)).toEqual(['Por Emitir', null, 'Cancelada']);
			expect(events(runner.query).map((event) => event.type)).toEqual(['INVOICE_EDITED', 'INVOICE_NO_CHARGE_REVERTED']);
		});

		it('descuento puntual: guarda el tratamiento en nc_revenue_treatment, la sublínea one_off y reconstruye el devengo', async () => {
			const { service, runner } = build();
			const result = await service.edit(
				CONTRACT_ID,
				INV_A,
				{
					lines: [lineEdit({ one_off_discount: { type: 'pct', value: 10 } })],
					deviation: { type: 'discount', reason: 'Compensación por caída', revenue_treatment: 'impact_month' },
				},
				HOLDING,
				'auth-1',
				TODAY
			);
			const [header] = calls(runner.query, 'UPDATE invoices SET issue_date');

			expect((header[1] as unknown[]).slice(-3)).toEqual(['Por Emitir', 'impact_month', 'Por Emitir']);
			const [lineUpdate] = calls(runner.query, 'UPDATE invoice_items SET description');
			const breakdown = JSON.parse((lineUpdate[1] as unknown[])[18] as string) as Row[];

			expect(breakdown).toEqual([expect.objectContaining({ kind: 'discount', one_off: true, amount: -100 })]);
			expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(1);
			expect(calls(runner.query, 'INSERT INTO invoice_adjustments')[0][1]).toEqual([
				INV_A,
				HOLDING,
				'discount',
				-100,
				'Compensación por caída',
				'user-1',
			]);
			expect(result.revenue_effect).toEqual({ treatment: 'impact_month', total: -100, by_month: [{ month: '2026-10-01', amount: -100 }] });
		});
	});

	describe('explainDeviation', () => {
		it('registra el motivo de un desvío heredado con la diferencia del conciliador y deja INVOICE_DEVIATION_EXPLAINED', async () => {
			const { service, runner } = build({ lines: { [INV_A]: [lineRow(INV_A, { subtotal_contract_currency: '900', discount_pct: '10' })] } });
			const result = await service.explainDeviation(
				CONTRACT_ID,
				INV_A,
				{ type: 'correction', reason: 'Editada en el ERP' },
				HOLDING,
				'auth-1',
				TODAY
			);

			expect(calls(runner.query, 'INSERT INTO invoice_adjustments')[0][1]).toEqual([
				INV_A,
				HOLDING,
				'correction',
				-100,
				'Editada en el ERP',
				'user-1',
			]);
			expect(events(runner.query)[0]).toMatchObject({
				type: 'INVOICE_DEVIATION_EXPLAINED',
				metadata: { adjustment_id: 'adj-1', inherited: true },
			});
			expect(result).toMatchObject({ invoice_id: INV_A, adjustment_id: 'adj-1', event_id: 'event-1', deviation: { total_diff: -100 } });
		});

		it('sin desvío → 409 no_deviation', async () => {
			const { service } = build();
			const error = await rejection(
				service.explainDeviation(CONTRACT_ID, INV_A, { type: 'correction', reason: 'x' }, HOLDING, 'auth-1', TODAY)
			);

			expect(((error as ConflictException).getResponse() as Row).blockers).toEqual([expect.objectContaining({ code: 'no_deviation' })]);
		});
	});

	describe('deviations (GET)', () => {
		it('lista las Por Emitir que se desvían del plan sin motivo registrado', async () => {
			const fixture = {
				invoices: { [INV_A]: invoiceRow(INV_A), [INV_B]: invoiceRow(INV_B, { issue_date: '2026-11-01', period_start: '2026-11-01' }) },
				lines: {
					[INV_A]: [lineRow(INV_A, { subtotal_contract_currency: '800' })],
					[INV_B]: [
						lineRow(INV_B, {
							id: 'l-b',
							billing_period_start: '2026-11-01',
							billing_period_end: '2026-11-30',
							subtotal_contract_currency: '700',
						}),
					],
				},
				adjustments: [{ invoice_id: INV_B, id: 'adj-9', type: 'discount', amount_diff: '-300', notes: 'Acordado' }],
			};
			const { service } = build(fixture);
			const result = await service.deviations(CONTRACT_ID, HOLDING);

			expect(result.total).toBe(1);
			expect(result.data).toEqual([
				expect.objectContaining({
					invoice_id: INV_A,
					deviation: expect.objectContaining({ has_deviation: true, total_diff: -200 }),
					cause: null,
				}),
			]);
			// Caso S02762: la diferencia de "las facturas suman" (−200) es la misma de los desvíos → el front muestra un solo aviso.
			expect(result.invoices_vs_total).toEqual({ difference: -200, deviations_total: -200, explained_by_deviations: true });
		});
	});

	describe('bulk-edit', () => {
		it('aplica a las Por Emitir que pasan, informa las bloqueadas y deja un INVOICE_EDITED por factura con el mismo bulk_id', async () => {
			const { service, runner } = build({
				invoices: { [INV_A]: invoiceRow(INV_A), [INV_B]: invoiceRow(INV_B, { status: 'Emitida', invoice_number: 'F-10' }) },
				lines: { [INV_A]: [lineRow(INV_A)], [INV_B]: [lineRow(INV_B, { id: 'l-b' })] },
			});
			const result = await service.bulkEdit(
				CONTRACT_ID,
				{ invoice_ids: [INV_A, INV_B], invoice_terms_and_conditions: 'Pago a 45 días', auto_invoice: true },
				HOLDING,
				'auth-1',
				TODAY
			);

			expect(result.updated).toEqual([INV_A]);
			expect(result.skipped).toEqual([{ id: INV_B, invoice_number: 'F-10', blockers: [expect.objectContaining({ code: 'not_pending' })] }]);
			expect(calls(runner.query, 'UPDATE invoices SET issue_date')).toHaveLength(1);
			const [event] = events(runner.query);

			expect(event).toMatchObject({ type: 'INVOICE_EDITED', metadata: { bulk_id: result.bulk_id, invoice_id: INV_A } });
			expect(sqlOf(runner.query)[0]).toBe(API_WRITER_SQL);
		});

		it('si ninguna aplica → 409; sin campos → 400', async () => {
			const { service } = build({ invoices: { [INV_A]: invoiceRow(INV_A, { status: 'Emitida' }) } });

			expect(
				await rejection(service.bulkEdit(CONTRACT_ID, { invoice_ids: [INV_A], auto_invoice: true }, HOLDING, 'auth-1', TODAY))
			).toBeInstanceOf(ConflictException);
			expect(await rejection(service.previewBulkEdit(CONTRACT_ID, { invoice_ids: [INV_A] }, HOLDING, TODAY))).toBeInstanceOf(
				BadRequestException
			);
		});
	});

	describe('DTO', () => {
		it('valida la línea, el descuento puntual y el motivo (tipos y devengo)', async () => {
			const dto = plainToInstance(EditInvoiceDto, {
				lines: [
					{
						contract_item_id: 'x',
						quantity: 1,
						unit_price: -1,
						billing_period_start: '2026-10-01',
						billing_period_end: 'mal',
						one_off_discount: { type: 'pct', value: 120 },
					},
				],
				deviation: { type: 'otro', reason: '', revenue_treatment: 'semanal' },
			});
			const fields = flattenValidationErrors(await validate(dto)).map((error) => error.field);

			expect(fields).toEqual(
				expect.arrayContaining([
					'lines.0.contract_item_id',
					'lines.0.unit_price',
					'lines.0.billing_period_end',
					'lines.0.one_off_discount.value',
					'deviation.type',
					'deviation.reason',
					'deviation.revenue_treatment',
				])
			);
		});

		it('descuento puntual en monto: IsNumber y Min también aplican (antes ValidateIf los apagaba); el tope 100 solo con pct', async () => {
			const errorsFor = async (oneOff: unknown) =>
				flattenValidationErrors(
					await validate(
						plainToInstance(EditInvoiceDto, {
							lines: [
								{
									contract_item_id: '99999999-9999-4999-8999-999999999999',
									quantity: 1,
									unit_price: 100,
									billing_period_start: '2026-10-01',
									billing_period_end: '2026-10-31',
									one_off_discount: oneOff,
								},
							],
						})
					)
				).map((error) => error.field);

			expect(await errorsFor({ type: 'amount', value: -5 })).toContain('lines.0.one_off_discount.value');
			expect(await errorsFor({ type: 'amount', value: 'mucho' })).toContain('lines.0.one_off_discount.value');
			expect(await errorsFor({ type: 'amount', value: 150 })).not.toContain('lines.0.one_off_discount.value');
			expect(await errorsFor({ type: 'pct', value: 150 })).toContain('lines.0.one_off_discount.value');
		});
	});
});

describe('ContractInvoiceEditService · multimoneda (spec-multimoneda §4)', () => {
	/** Factura CLP de un contrato CLP multimoneda con una línea USD (950) y una UF (38.000). */
	const multicurrency = () => {
		const mcInvoice = invoiceRow(INV_A, {
			contract_currency: 'CLP',
			invoice_currency: 'CLP',
			fx_contract_to_invoice: null,
			amount_contract_currency: '1270000',
			amount_invoice_currency: '1330000',
			vat: '252700',
			total_invoice_currency: '1582700',
			lines_count: '2',
		});
		const usd = lineRow(INV_A, {
			unit_price_invoice_currency: '95000',
			subtotal_invoice_currency: '950000',
			tax_amount_invoice_currency: '180500',
			total_invoice_currency: '1130500',
			line_currency: 'USD',
			line_fx: '950',
			line_fx_rate_source: 'contract',
		});
		const uf = lineRow(INV_A, {
			id: '66666666-6666-4666-8666-666666666666',
			contract_item_id: MC_UF_ITEM,
			product_name: 'Soporte',
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
		const built = build({ invoices: { [INV_A]: mcInvoice }, lines: { [INV_A]: [usd, uf] } });
		const base = built.runner.query.getMockImplementation()!;
		const mc = multicurrencyRoute({
			contract_id: CONTRACT_ID,
			invoices: { [INV_A]: mcInvoiceRow(INV_A, CONTRACT_ID) },
			lines: {
				[INV_A]: [
					mcStoredLine(LINE, 'USD', {
						subtotal_contract_currency: '1200',
						unit_price_contract_currency: '100',
						tax_amount_contract_currency: '228',
					}),
					mcStoredLine(String(uf.id), 'UF'),
				],
			},
		});
		const route = (sql: string, params: unknown[] = []) => {
			if (sql.includes('c.billing_anchor_day'))
				return [
					{
						...contractRow,
						contract_currency: 'CLP',
						invoice_currency: 'CLP',
						fx_invoice_policy: 'fixed',
						requires_multicurrency_billing: true,
					},
				];

			return mc(sql, params) ?? base(sql, params);
		};

		built.runner.query.mockImplementation(route);
		(built.dataSource.query as unknown as jest.Mock).mockImplementation(route);

		return built;
	};

	it('preview y PUT: la línea USD editada se valoriza con USD → CLP, la UF conserva su par; encabezado = Σ líneas con FX NULL', async () => {
		const { service, runner } = multicurrency();
		const body = { lines: [lineEdit({ quantity: 12 })], deviation: { type: 'upsell' as const, reason: 'Dos usuarios más' } };
		const preview = await service.previewEdit(CONTRACT_ID, INV_A, body, HOLDING, TODAY);

		expect(preview.lines[0].after).toMatchObject({ currency: 'USD', fx: 950, subtotal_invoice_currency: 1140000 });
		expect(preview.invoice.after).toMatchObject({
			fx_contract_to_invoice: null,
			amount_invoice_currency: 1520000,
			amount_contract_currency: 1450000,
		});

		await service.edit(CONTRACT_ID, INV_A, body, HOLDING, 'auth-1', TODAY);
		const [pairUpdate] = calls(runner.query, 'contract_currency = COALESCE($4, contract_currency)');

		expect(pairUpdate[1]).toEqual([LINE, INV_A, HOLDING, 'USD', 950, 'contract']);
		expect(revaluedLines(runner.query.mock.calls)).toEqual([
			expect.objectContaining({ currency: 'USD', fx: 950, subtotal: 1140000, tax: 216600 }),
			expect.objectContaining({ currency: 'UF', fx: 38000, subtotal: 380000, tax: 72200 }),
		]);
		expect(revaluedHeaders(runner.query.mock.calls)).toEqual([
			{
				id: INV_A,
				amount_contract_currency: 1450000,
				vat: 288800,
				amount_invoice_currency: 1520000,
				total_invoice_currency: 1808800,
				fx: null,
			},
		]);
	});

	it('sin el flag no se consulta ni se escribe nada por par (comportamiento de siempre)', async () => {
		const { service, runner } = build();

		await service.edit(
			CONTRACT_ID,
			INV_A,
			{ lines: [lineEdit({ quantity: 12 })], deviation: { type: 'upsell', reason: 'x' } },
			HOLDING,
			'auth-1',
			TODAY
		);
		expect(sqlOf(runner.query).some((sql) => sql.includes('multimoneda'))).toBe(false);
	});
});

describe('ContractsController (editar Por Emitir, desvíos, masivo y borrador del ERP)', () => {
	const edit = {
		previewEdit: jest.fn().mockResolvedValue({}),
		edit: jest.fn().mockResolvedValue({}),
		explainDeviation: jest.fn().mockResolvedValue({}),
		deviations: jest.fn().mockResolvedValue({ data: [], total: 0 }),
		previewBulkEdit: jest.fn().mockResolvedValue({}),
		bulkEdit: jest.fn().mockResolvedValue({}),
	};
	const invoices = { erpReset: jest.fn().mockResolvedValue({}), erpResetBulk: jest.fn().mockResolvedValue({}) };
	const controller = new ContractsController(
		{} as ContractsService,
		{} as ContractDraftsService,
		{} as ContractSubscriptionsService,
		{} as Contract360Service,
		{} as ContractBulkService,
		{} as ContractActivationService,
		{} as ConsumptionService,
		{} as ContractChangesService,
		invoices as unknown as ContractInvoicesService,
		{} as ContractInvoiceDescriptionsService,
		edit as unknown as ContractInvoiceEditService,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never
	);
	const req = { user: { sub: 'auth-1' } };
	const routeOf = (handler: string) => ({
		path: Reflect.getMetadata(PATH_METADATA, ContractsController.prototype[handler as keyof ContractsController]),
		method: Reflect.getMetadata(METHOD_METADATA, ContractsController.prototype[handler as keyof ContractsController]),
		code: Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype[handler as keyof ContractsController]),
	});

	it('rutas: preview/PUT de edición, deviation, deviations (antes de :invoiceId), bulk-edit y erp-reset', () => {
		expect(routeOf('editPreview')).toEqual({ path: ':id/invoices/:invoiceId/edit/preview', method: 1, code: 200 });
		expect(routeOf('editInvoice')).toMatchObject({ path: ':id/invoices/:invoiceId', method: 2 });
		expect(routeOf('explainDeviation')).toEqual({ path: ':id/invoices/:invoiceId/deviation', method: 1, code: 200 });
		expect(routeOf('invoiceDeviations')).toMatchObject({ path: ':id/invoices/deviations', method: 0 });
		expect(routeOf('bulkEditPreview')).toEqual({ path: ':id/invoices/bulk-edit/preview', method: 1, code: 200 });
		expect(routeOf('bulkEdit')).toMatchObject({ path: ':id/invoices/bulk-edit', method: 4 });
		expect(routeOf('erpReset')).toEqual({ path: ':id/invoices/:invoiceId/erp-reset', method: 1, code: 200 });
		expect(routeOf('erpResetBulk')).toEqual({ path: ':id/invoices/erp-reset', method: 1, code: 200 });
		const handlers = Object.getOwnPropertyNames(ContractsController.prototype);

		expect(handlers.indexOf('invoiceDeviations')).toBeLessThan(handlers.indexOf('invoiceDetail'));
	});

	it('pasa holding y usuario a los servicios', async () => {
		await controller.editInvoice(CONTRACT_ID, INV_A, { lines: [] }, HOLDING, req);
		await controller.explainDeviation(CONTRACT_ID, INV_A, { type: 'correction', reason: 'x' }, HOLDING, req);
		await controller.bulkEdit(CONTRACT_ID, { invoice_ids: [INV_A], auto_invoice: true }, HOLDING, req);
		await controller.erpReset(CONTRACT_ID, INV_A, {}, HOLDING, req);
		await controller.erpResetBulk(CONTRACT_ID, { invoice_ids: [INV_A] }, HOLDING, req);

		expect(edit.edit).toHaveBeenCalledWith(CONTRACT_ID, INV_A, { lines: [] }, HOLDING, 'auth-1');
		expect(edit.explainDeviation).toHaveBeenCalledWith(CONTRACT_ID, INV_A, { type: 'correction', reason: 'x' }, HOLDING, 'auth-1');
		expect(edit.bulkEdit).toHaveBeenCalledWith(CONTRACT_ID, { invoice_ids: [INV_A], auto_invoice: true }, HOLDING, 'auth-1');
		expect(invoices.erpReset).toHaveBeenCalledWith(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1');
		expect(invoices.erpResetBulk).toHaveBeenCalledWith(CONTRACT_ID, { invoice_ids: [INV_A] }, HOLDING, 'auth-1');
	});
});
