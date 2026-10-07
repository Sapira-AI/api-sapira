// `InvoiceSchedulerService` importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';

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
import { InvoiceFxBulkDto, InvoiceFxDto, MarkInvoiceIssuedDto, RescheduleInvoiceDto, RescheduleInvoicesBulkDto } from './dtos/contract-invoices.dto';

type Row = Record<string, unknown>;

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INV_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOLDING = 'h-1';
const TODAY = new Date('2026-09-29T12:00:00Z');

const contextRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	status: 'Activo',
	fx_invoice_policy: 'spot',
	requires_references_for_billing: false,
	auto_send_to_odoo: true,
	payment_terms: { kind: 'net', days: 30 },
	client_entity_id: 'entity-1',
	odoo_partner_id: 501,
	entity_payment_terms: null,
	company_country: 'Chile',
	odoo_integration_id: 7,
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
	invoice_currency: 'CLP',
	amount_contract_currency: '1000',
	amount_invoice_currency: null,
	vat: '190',
	total_invoice_currency: null,
	fx_contract_to_invoice: null,
	tax_rate: '19',
	fx_rate_source: null,
	fx_confirmed_at: null,
	issued_externally: false,
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
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

const lineRow = (id = 'line-1', overrides: Row = {}): Row => ({
	id,
	quantity: '10',
	unit_price_contract_currency: '100',
	subtotal_contract_currency: '1000',
	tax_amount_contract_currency: '190',
	total_contract_currency: '1190',
	unit_price_invoice_currency: null,
	subtotal_invoice_currency: null,
	tax_amount_invoice_currency: null,
	total_invoice_currency: null,
	created_at: new Date('2026-09-01T00:00:00Z'),
	...overrides,
});

const build = (invoices: Record<string, Row> = { [INV_A]: invoiceRow(INV_A) }, context: Row = contextRow, lines: Row[] = [lineRow()]) => {
	let events = 0;
	const route = (sql: string, params: unknown[] = []): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [context];
		if (sql.includes('priced_base')) {
			if (sql.includes("i.status = 'Por Emitir' AND i.is_active = true"))
				return Object.values(invoices).filter((row) => row.status === 'Por Emitir');
			if (sql.includes('ANY($3::uuid[])')) return (params[2] as string[]).map((id) => invoices[id]).filter(Boolean);
			const row = invoices[params[0] as string];

			return row ? [row] : [];
		}
		if (sql.includes('FROM invoice_items ii')) return lines;
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
		invoiceDetail: jest.fn().mockResolvedValue({ id: INV_A, history: [] }),
	} as unknown as ContractsService;
	const scheduler = {
		sendInvoiceById: jest.fn().mockResolvedValue({ invoiceId: INV_A, status: 'sent', odooInvoiceId: 9001 }),
		lastSendAttempt: jest.fn().mockResolvedValue(null),
	} as unknown as InvoiceSchedulerService;

	return { service: new ContractInvoicesService(dataSource, contracts, scheduler), runner, dataSource, contracts, scheduler };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const eventMeta = (mock: jest.Mock, index = 0) => JSON.parse(calls(mock, 'INSERT INTO contract_lifecycle_events')[index][1][7] as string) as Row;
const eventType = (mock: jest.Mock, index = 0) => calls(mock, 'INSERT INTO contract_lifecycle_events')[index][1][2];

describe('ContractInvoicesService (spec facturas §3.1–3.3)', () => {
	describe('previews', () => {
		it('ninguna vista previa abre transacción ni escribe', async () => {
			const { service, dataSource, runner } = build();

			await service.previewSendNow(CONTRACT_ID, INV_A, HOLDING, TODAY);
			await service.previewMarkIssued(CONTRACT_ID, INV_A, { invoice_number: 'F-1', issue_date: '2026-10-02' }, HOLDING, TODAY);
			await service.previewReschedule(CONTRACT_ID, INV_A, { issue_date: '2026-10-15', apply_to: 'this_and_following' }, HOLDING, TODAY);
			await service.previewRescheduleBulk(CONTRACT_ID, { invoice_ids: [INV_A], shift_months: 1 }, HOLDING, TODAY);
			await service.previewFx(CONTRACT_ID, INV_A, { policy: 'fixed', rate: 950 }, HOLDING, TODAY);
			await service.previewFxBulk(CONTRACT_ID, { invoice_ids: [INV_A], policy: 'spot' }, HOLDING, TODAY);

			expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
			expect(runner.query).not.toHaveBeenCalled();
			expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		});

		it('previewSendNow devuelve resumen, bloqueos y avisos con la forma del 360; 404 si la factura no es del contrato', async () => {
			const { service } = build({ [INV_A]: invoiceRow(INV_A, { requires_references_for_billing: true, auto_invoice: true }) });
			const preview = await service.previewSendNow(CONTRACT_ID, INV_A, HOLDING, TODAY);

			expect(preview).toMatchObject({
				invoice: { id: INV_A, status: 'Por Emitir', issue_date: '2026-10-01' },
				summary: { legal_name: 'Cliente SpA', invoice_currency: 'CLP', fx_policy: 'spot', references_count: 0, auto_invoice: true },
				can_apply: false,
			});
			expect(preview.blockers.map((blocker) => blocker.code)).toEqual(['needs_reference']);
			expect(preview.warnings.map((warning) => warning.code)).toEqual(['spot_fx']);

			// Prefactura sin OC: como borrador (sin emisión automática) se puede enviar con el aviso.
			const { service: draftService } = build({ [INV_A]: invoiceRow(INV_A, { requires_references_for_billing: true, auto_invoice: false }) });
			const draft = await draftService.previewSendNow(CONTRACT_ID, INV_A, HOLDING, TODAY);

			expect(draft).toMatchObject({ can_apply: true, blockers: [] });
			expect(draft.warnings.map((warning) => warning.code)).toEqual(['needs_reference', 'spot_fx']);
			await expect(service.previewSendNow(CONTRACT_ID, INV_B, HOLDING, TODAY)).rejects.toBeInstanceOf(NotFoundException);
		});

		it('previewFx muestra antes/después por factura y líneas; el masivo separa aplicables de bloqueadas', async () => {
			const { service } = build({ [INV_A]: invoiceRow(INV_A), [INV_B]: invoiceRow(INV_B, { status: 'Emitida', invoice_number: 'F-9' }) });
			const preview = await service.previewFxBulk(CONTRACT_ID, { invoice_ids: [INV_A, INV_B], policy: 'fixed', rate: 900 }, HOLDING, TODAY);

			expect(preview.updated).toEqual([INV_A]);
			expect(preview.skipped).toEqual([{ id: INV_B, invoice_number: 'F-9', blockers: [expect.objectContaining({ code: 'not_pending' })] }]);
			expect(preview.invoices[0].after).toMatchObject({
				fx_policy: 'fixed',
				fx_rate: 900,
				amount_invoice_currency: 900000,
				vat: 171000,
				total_invoice_currency: 1071000,
			});
			expect(preview.invoices[0].lines[0].after.subtotal_invoice_currency).toBe(900000);
			expect(preview.can_apply).toBe(true);
		});
	});

	describe('sendNow (POST …/send-now)', () => {
		it('con bloqueos responde 409 `blocked` con el preview y no llama al scheduler', async () => {
			const { service, scheduler, runner } = build({ [INV_A]: invoiceRow(INV_A, { odoo_invoice_id: 55 }) });
			const error = await service.sendNow(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			const body = (error as ConflictException).getResponse() as Row;

			expect(body.code).toBe('blocked');
			expect((body.blockers as Array<{ code: string }>).map((blocker) => blocker.code)).toEqual(['already_sent']);
			expect(body.preview).toMatchObject({ can_apply: false });
			expect(scheduler.sendInvoiceById).not.toHaveBeenCalled();
			expect(runner.query).not.toHaveBeenCalled();
		});

		it('NC Por Emitir: 409 `credit_note_send_pending` (envío de NC al ERP pendiente) y no llama al scheduler', async () => {
			const { service, scheduler } = build({ [INV_A]: invoiceRow(INV_A, { document_type: 'NC' }) });
			const error = await service.sendNow(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			const body = (error as ConflictException).getResponse() as Row;

			expect(body.code).toBe('credit_note_send_pending');
			expect((body.blockers as Array<{ code: string }>).map((blocker) => blocker.code)).toEqual(['credit_note_send_pending']);
			expect(scheduler.sendInvoiceById).not.toHaveBeenCalled();
		});

		it('sin bloqueos envía ESA factura con el scheduler (dryRun false, origen manual) y deja INVOICE_SENT_MANUALLY con invoice_id', async () => {
			const { service, scheduler, runner, contracts } = build({
				[INV_A]: invoiceRow(INV_A, { fx_contract_to_invoice: '950' }),
			});
			const result = await service.sendNow(CONTRACT_ID, INV_A, { reason: 'Cliente lo pidió' }, HOLDING, 'auth-1', TODAY);

			expect(scheduler.sendInvoiceById).toHaveBeenCalledWith(INV_A, false, 'manual');
			expect(result).toMatchObject({
				sent: true,
				status: 'sent',
				odoo_invoice_id: 9001,
				blockers: [],
				event_id: 'event-1',
				invoice: { id: INV_A },
			});
			expect(result.message).toContain('9001');
			expect(eventType(runner.query)).toBe('INVOICE_SENT_MANUALLY');
			expect(eventMeta(runner.query)).toMatchObject({
				source: 'contract_360',
				invoice_id: INV_A,
				odoo_invoice_id: 9001,
				before: { odoo_invoice_id: null, sent_to_odoo_at: null },
				after: { odoo_invoice_id: 9001 },
				fx_policy: 'fixed',
				fx_rate: 950,
				reason: 'Cliente lo pidió',
			});
			expect(sqlOf(runner.query)[0]).toContain("set_config('sapira.writer', 'api', true)");
			expect(runner.commitTransaction).toHaveBeenCalled();
			expect(contracts.invoiceDetail).toHaveBeenCalledWith(CONTRACT_ID, INV_A, HOLDING);
		});

		it('si el ERP no la recibe (omitida o error) responde sent: false con el motivo traducido y sin evento', async () => {
			const { service, scheduler, runner } = build();

			(scheduler.sendInvoiceById as jest.Mock).mockResolvedValue({
				invoiceId: INV_A,
				status: 'skipped',
				error: 'Sin tipo de cambio',
				errorType: 'exchange_rate',
				details: 'Se avisó por correo',
			});
			const result = await service.sendNow(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY);

			expect(result).toMatchObject({
				sent: false,
				status: 'skipped',
				odoo_invoice_id: null,
				event_id: null,
				message:
					'Falta el tipo de cambio para valorizar la factura en su moneda. Confirma la tasa desde Tipo de cambio de la factura y vuelve a enviarla.',
				error: { category: 'fx_rate_missing', action: 'fx', raw: 'Sin tipo de cambio. Se avisó por correo' },
			});
			expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')).toHaveLength(0);
		});

		it('error del ERP: el mensaje nunca es el técnico; el detalle trae last_send_attempt del log', async () => {
			const { service, scheduler } = build();
			const attempt = {
				at: '2026-10-02T12:00:00.000Z',
				ok: false,
				category: 'partner_not_linked',
				message: 'La razón social no está vinculada en Odoo',
			};

			(scheduler.sendInvoiceById as jest.Mock).mockResolvedValue({
				invoiceId: INV_A,
				status: 'skipped',
				error: 'Cliente no tiene odoo_partner_id',
				errorType: 'validation',
			});
			(scheduler.lastSendAttempt as jest.Mock).mockResolvedValue(attempt);
			const result = await service.sendNow(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY);

			expect(result.message).toBe('La razón social no está vinculada en Odoo. Vincúlala en Clientes › Razones sociales y vuelve a enviarla.');
			expect(result.message).not.toContain('odoo_partner_id');
			expect(result.error).toMatchObject({ category: 'partner_not_linked', action: 'client_entity' });
			expect(result.invoice).toMatchObject({ id: INV_A, last_send_attempt: attempt });
			expect(scheduler.lastSendAttempt).toHaveBeenCalledWith(INV_A, HOLDING);
		});
	});

	describe('markIssued (POST …/mark-issued)', () => {
		it('una transacción: costura, lock del contrato y de la factura, Emitida con folio/fecha/vencimiento/issued_externally, RSM del período y evento', async () => {
			const { service, runner } = build({ [INV_A]: invoiceRow(INV_A, { invoice_currency: 'USD' }) });
			const result = await service.markIssued(
				CONTRACT_ID,
				INV_A,
				{ invoice_number: 'F-1046', issue_date: '2026-10-03', notes: 'Emitida en el SII' },
				HOLDING,
				'auth-1',
				TODAY
			);
			const sql = sqlOf(runner.query);

			expect(sql[0]).toContain("set_config('sapira.writer', 'api', true)");
			expect(sql[1]).toContain('FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL FOR UPDATE');
			expect(sql.find((entry) => entry.includes('priced_base'))).toContain('FOR UPDATE OF i');
			const [updateSql, params] = calls(runner.query, 'UPDATE invoices SET status')[0];

			expect(updateSql).not.toContain('issued_externally');
			expect(updateSql).toContain("status = 'Por Emitir'");
			expect(params.slice(0, 6)).toEqual([INV_A, HOLDING, 'Emitida', 'F-1046', '2026-10-03', '2026-11-02']);
			expect(params[6]).toBeNull();
			expect(params.slice(7, 11)).toEqual([1000, 190, 1000, 1190]);
			expect(params[11]).toBe('Emisión registrada externamente: Emitida en el SII');
			expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-10-01']);
			expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);
			expect(eventType(runner.query)).toBe('INVOICE_ISSUED_EXTERNALLY');
			expect(eventMeta(runner.query)).toMatchObject({
				invoice_id: INV_A,
				before: { status: 'Por Emitir', invoice_number: null, issue_date: '2026-10-01' },
				after: { status: 'Emitida', invoice_number: 'F-1046', issue_date: '2026-10-03', due_date: '2026-11-02', issued_externally: true },
				rsm_from_month: '2026-10-01',
			});
			expect(runner.commitTransaction).toHaveBeenCalled();
			expect(result).toMatchObject({ applied: true, event_id: 'event-1', after: { status: 'Emitida' } });
			expect(result.warnings.map((warning) => warning.code)).toEqual(['erp_auto_send', 'future_issue_date']);
		});

		it('multimoneda valoriza líneas y encabezado con la tasa de la emisión', async () => {
			const { service, runner } = build();

			await service.markIssued(CONTRACT_ID, INV_A, { invoice_number: 'F-2', issue_date: '2026-10-03', fx_rate: 900 }, HOLDING, 'auth-1', TODAY);
			const [, lineParams] = calls(runner.query, 'UPDATE invoice_items')[0];

			expect(lineParams).toEqual(['line-1', HOLDING, 90000, 900000, 171000, 1071000, 900, 'manual', '2026-10-03']);
			const [, params] = calls(runner.query, 'UPDATE invoices SET status')[0];

			expect(params[6]).toBe(900);
			expect(params.slice(7, 11)).toEqual([1000, 171000, 900000, 1071000]);
		});

		it('ya valorizada (tasa fija / neto exacto / OC): solo registra, no reescribe líneas ni tasa; tasa distinta → fx_mismatch', async () => {
			const { service, runner } = build(
				{
					[INV_A]: invoiceRow(INV_A, {
						fx_contract_to_invoice: '950',
						amount_invoice_currency: '950000',
						vat: '180500',
						total_invoice_currency: '1130500',
						fx_rate_source: 'net_exact',
					}),
				},
				contextRow,
				[
					lineRow('line-1', {
						unit_price_invoice_currency: '95000',
						subtotal_invoice_currency: '950000',
						tax_amount_invoice_currency: '180500',
						total_invoice_currency: '1130500',
					}),
				]
			);
			const result = await service.markIssued(
				CONTRACT_ID,
				INV_A,
				{ invoice_number: 'F-3', issue_date: '2026-10-03', fx_rate: 940 },
				HOLDING,
				'auth-1',
				TODAY
			);

			expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);
			const [, params] = calls(runner.query, 'UPDATE invoices SET status')[0];

			expect(params[6]).toBeNull();
			expect(params.slice(7, 11)).toEqual([1000, 180500, 950000, 1130500]);
			expect(result.warnings.map((warning) => warning.code)).toContain('fx_mismatch');
			expect(eventMeta(runner.query)).toMatchObject({ valuated: false, fx_rate_reported: 940 });
		});

		it('bloqueada (ya emitida) → 409 y rollback sin escribir', async () => {
			const { service, runner } = build({ [INV_A]: invoiceRow(INV_A, { status: 'Emitida', invoice_number: 'F-1' }) });

			await expect(
				service.markIssued(CONTRACT_ID, INV_A, { invoice_number: 'F-1', issue_date: '2026-10-03' }, HOLDING, 'auth-1', TODAY)
			).rejects.toBeInstanceOf(ConflictException);
			expect(calls(runner.query, 'UPDATE invoice')).toHaveLength(0);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
			expect(runner.commitTransaction).not.toHaveBeenCalled();
		});
	});

	describe('reschedule (POST …/reschedule · …/reschedule-bulk)', () => {
		it('escribe scheduled_at = issue_date, conserva original_issue_date (COALESCE) y el vencimiento del contrato; evento con antes/después', async () => {
			const { service, runner } = build({ [INV_A]: invoiceRow(INV_A, { original_issue_date: '2026-09-01' }) });
			const result = await service.reschedule(
				CONTRACT_ID,
				INV_A,
				{ issue_date: '2026-10-20', reason: 'Cierre del cliente' },
				HOLDING,
				'auth-1',
				TODAY
			);
			const [sql, params] = calls(runner.query, 'UPDATE invoices SET scheduled_at')[0];

			expect(sql).toContain('original_issue_date = COALESCE(original_issue_date, $5::date)');
			expect(sql).not.toContain('billing_period');
			expect(params).toEqual([INV_A, HOLDING, '2026-10-20', '2026-11-19', '2026-09-01']);
			expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(0);
			expect(eventType(runner.query)).toBe('INVOICE_RESCHEDULED');
			expect(eventMeta(runner.query)).toMatchObject({
				invoice_id: INV_A,
				before: { issue_date: '2026-10-01', due_date: '2026-10-31', original_issue_date: '2026-09-01' },
				after: { issue_date: '2026-10-20', scheduled_at: '2026-10-20', due_date: '2026-11-19', original_issue_date: '2026-09-01' },
				bulk_id: null,
				reason: 'Cierre del cliente',
			});
			expect(result).toMatchObject({ applied: true, event_ids: ['event-1'], updated: [INV_A], invoice: { id: INV_A } });
		});

		it('con descuento puntual (nc_revenue_treatment) reconstruye el devengo desde el menor mes de emisión', async () => {
			const { service, runner } = build({ [INV_A]: invoiceRow(INV_A, { nc_revenue_treatment: 'impact_month' }) });

			await service.reschedule(CONTRACT_ID, INV_A, { issue_date: '2026-12-10' }, HOLDING, 'auth-1', TODAY);
			expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-10-01']);
			expect(eventMeta(runner.query).rsm_from_month).toBe('2026-10-01');
		});

		it('this_and_following lleva las posteriores al mismo día del mes, salta las bloqueadas y enlaza los eventos con bulk_id', async () => {
			const { service, runner } = build({
				[INV_A]: invoiceRow(INV_A),
				[INV_B]: invoiceRow(INV_B, {
					issue_date: '2026-11-01',
					original_issue_date: '2026-11-01',
					scheduled_at: '2026-11-01',
					due_date: '2026-12-01',
				}),
				[INV_C]: invoiceRow(INV_C, { issue_date: '2026-12-01', odoo_invoice_id: 3 }),
			});
			const result = await service.reschedule(
				CONTRACT_ID,
				INV_A,
				{ issue_date: '2026-10-06', apply_to: 'this_and_following' },
				HOLDING,
				'auth-1',
				TODAY
			);
			const updates = calls(runner.query, 'UPDATE invoices SET scheduled_at').map(([, params]) => params);

			expect(updates).toEqual([
				[INV_A, HOLDING, '2026-10-06', '2026-11-05', '2026-10-01'],
				[INV_B, HOLDING, '2026-11-06', '2026-12-06', '2026-11-01'],
			]);
			expect(result.skipped).toEqual([{ id: INV_C, invoice_number: null, blockers: [expect.objectContaining({ code: 'sent_to_erp_draft' })] }]);
			expect(result.event_ids).toEqual(['event-1', 'event-2']);
			expect(eventMeta(runner.query, 0).bulk_id).toEqual(expect.any(String));
			expect(eventMeta(runner.query, 1).bulk_id).toBe(eventMeta(runner.query, 0).bulk_id);
		});

		it('la factura objetivo bloqueada → 409 aunque las siguientes puedan moverse', async () => {
			const { service, runner } = build({
				[INV_A]: invoiceRow(INV_A, { status: 'Emitida', invoice_number: 'F-1' }),
				[INV_B]: invoiceRow(INV_B, { issue_date: '2026-11-01' }),
			});

			await expect(
				service.reschedule(CONTRACT_ID, INV_A, { issue_date: '2026-10-06', apply_to: 'this_and_following' }, HOLDING, 'auth-1', TODAY)
			).rejects.toBeInstanceOf(ConflictException);
			expect(calls(runner.query, 'UPDATE invoice')).toHaveLength(0);
		});

		it('masivo: corre un mes cada factura pedida, aplica a las que pasan; 404 si una no es del contrato; 409 si ninguna aplica', async () => {
			const { service, runner } = build({
				[INV_A]: invoiceRow(INV_A, { issue_date: '2026-10-31' }),
				[INV_B]: invoiceRow(INV_B, { status: 'Cancelada' }),
			});
			const result = await service.rescheduleBulk(CONTRACT_ID, { invoice_ids: [INV_A, INV_B], shift_months: 1 }, HOLDING, 'auth-1', TODAY);

			expect(calls(runner.query, 'UPDATE invoices SET scheduled_at').map(([, params]) => params)).toEqual([
				[INV_A, HOLDING, '2026-11-30', '2026-12-30', '2026-10-01'],
			]);
			expect(result.updated).toEqual([INV_A]);
			expect(result.skipped[0]).toMatchObject({ id: INV_B });
			await expect(
				service.rescheduleBulk(CONTRACT_ID, { invoice_ids: [INV_C], shift_months: 1 }, HOLDING, 'auth-1', TODAY)
			).rejects.toBeInstanceOf(NotFoundException);
			await expect(
				service.rescheduleBulk(CONTRACT_ID, { invoice_ids: [INV_B], shift_months: 1 }, HOLDING, 'auth-1', TODAY)
			).rejects.toBeInstanceOf(ConflictException);
		});
	});

	describe('fx (POST …/fx · …/fx-bulk)', () => {
		it('fixed: escribe la tasa en fx_contract_to_invoice, el origen en las líneas y la confirmación en el evento; recalcula líneas y encabezado; no toca el contrato', async () => {
			const { service, runner } = build();
			const result = await service.fx(CONTRACT_ID, INV_A, { policy: 'fixed', rate: 950 }, HOLDING, 'auth-1', TODAY);
			const [headerSql, headerParams] = calls(runner.query, 'UPDATE invoices SET fx_contract_to_invoice')[0];

			expect(headerSql).not.toMatch(/fx_policy|fx_rate\b|fx_confirmed_at/);
			expect(headerSql).toContain('fx_contract_to_invoice = $3');
			expect(headerSql).toContain("status = 'Por Emitir'");
			expect(headerParams).toEqual([INV_A, HOLDING, 950, 1000, 180500, 950000, 1130500]);
			expect(calls(runner.query, 'UPDATE invoice_items')[0][1]).toEqual([
				'line-1',
				HOLDING,
				95000,
				950000,
				180500,
				1130500,
				950,
				'manual',
				'2026-09-29',
			]);
			expect(calls(runner.query, 'UPDATE contracts')).toHaveLength(0);
			expect(eventType(runner.query)).toBe('INVOICE_FX_CHANGED');
			expect(eventMeta(runner.query)).toMatchObject({
				invoice_id: INV_A,
				before: { fx_policy: 'spot', fx_rate: null, amount_invoice_currency: null },
				after: { fx_policy: 'fixed', fx_rate: 950, fx_rate_source: 'manual', total_invoice_currency: 1130500 },
				policy_requested: 'fixed',
				lines_updated: 1,
			});
			expect(result).toMatchObject({ applied: true, event_ids: ['event-1'], updated: [INV_A] });
		});

		it('spot: NULL en montos de factura (líneas y encabezado), sin tasa ni origen; IVA del encabezado en moneda de contrato', async () => {
			const { service, runner } = build({
				[INV_A]: invoiceRow(INV_A, { fx_contract_to_invoice: '900', amount_invoice_currency: '900000' }),
			});

			await service.fx(CONTRACT_ID, INV_A, { policy: 'spot' }, HOLDING, 'auth-1', TODAY);
			expect(calls(runner.query, 'UPDATE invoices SET fx_contract_to_invoice')[0][1]).toEqual([INV_A, HOLDING, null, 1000, 190, null, null]);
			expect(calls(runner.query, 'UPDATE invoice_items')[0][1]).toEqual(['line-1', HOLDING, null, null, null, null, null, null, null]);
		});

		it('net_exact: tasa derivada del neto, encabezado exacto y origen net_exact', async () => {
			const { service, runner } = build();

			await service.fx(CONTRACT_ID, INV_A, { policy: 'net_exact', target_net_amount: 1000000 }, HOLDING, 'auth-1', TODAY);
			expect(calls(runner.query, 'UPDATE invoices SET fx_contract_to_invoice')[0][1]).toEqual([
				INV_A,
				HOLDING,
				1000,
				1000,
				190000,
				1000000,
				1190000,
			]);
			expect(calls(runner.query, 'UPDATE invoice_items')[0][1]).toEqual([
				'line-1',
				HOLDING,
				100000,
				1000000,
				190000,
				1190000,
				1000,
				'net_exact',
				'2026-09-29',
			]);
		});

		it('bloqueada (misma moneda) → 409 sin escribir; net_exact masivo con más de una factura → 400', async () => {
			const { service, runner } = build({ [INV_A]: invoiceRow(INV_A, { invoice_currency: 'USD' }), [INV_B]: invoiceRow(INV_B) });

			await expect(service.fx(CONTRACT_ID, INV_A, { policy: 'fixed', rate: 1 }, HOLDING, 'auth-1', TODAY)).rejects.toBeInstanceOf(
				ConflictException
			);
			expect(calls(runner.query, 'UPDATE invoice')).toHaveLength(0);
			await expect(
				service.fxBulk(CONTRACT_ID, { invoice_ids: [INV_A, INV_B], policy: 'net_exact', target_net_amount: 10 }, HOLDING, 'auth-1', TODAY)
			).rejects.toBeInstanceOf(BadRequestException);
		});

		it('masivo: misma tasa fija a varias, un evento por factura con bulk_id, y las bloqueadas en skipped', async () => {
			const { service, runner } = build({
				[INV_A]: invoiceRow(INV_A),
				[INV_B]: invoiceRow(INV_B),
				[INV_C]: invoiceRow(INV_C, { invoice_currency: 'USD' }),
			});
			const result = await service.fxBulk(
				CONTRACT_ID,
				{ invoice_ids: [INV_A, INV_B, INV_C], policy: 'fixed', rate: 900 },
				HOLDING,
				'auth-1',
				TODAY
			);

			expect(calls(runner.query, 'UPDATE invoices SET fx_contract_to_invoice').map(([, params]) => params[0])).toEqual([INV_A, INV_B]);
			expect(result.updated).toEqual([INV_A, INV_B]);
			expect(result.skipped).toEqual([{ id: INV_C, invoice_number: null, blockers: [expect.objectContaining({ code: 'same_currency' })] }]);
			expect(result.event_ids).toEqual(['event-1', 'event-2']);
			expect(eventMeta(runner.query, 1).bulk_id).toBe(eventMeta(runner.query, 0).bulk_id);
		});
	});
});

describe('ContractInvoicesService · restablecer el borrador del ERP (§3.1)', () => {
	it('una: marca api, bloquea contrato y factura, pone en NULL solo el vínculo al ERP y deja INVOICE_ERP_DRAFT_RESET con el antes, motivo y usuario', async () => {
		const { service, runner, contracts } = build({
			[INV_A]: invoiceRow(INV_A, { odoo_invoice_id: 321, sent_to_odoo_at: '2026-09-20T10:00:00.000Z', sent_at: '2026-09-20T10:00:00.000Z' }),
		});
		const result = await service.erpReset(CONTRACT_ID, INV_A, { reason: 'Se corrige el monto antes de reenviar' }, HOLDING, 'auth-1', TODAY);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toContain("set_config('sapira.writer', 'api', true)");
		expect(sql.some((statement) => statement.includes('FOR UPDATE OF i'))).toBe(true);
		const [update] = calls(runner.query, 'UPDATE invoices SET odoo_invoice_id = NULL');

		expect(update[0]).toContain('sent_to_odoo_at = NULL, sent_at = NULL');
		// Nada más que el vínculo al ERP (el SET no toca estado, montos ni `updated_at`, que no existe en invoices).
		expect((update[0] as string).split('WHERE')[0]).not.toMatch(/status|amount|updated_at/);
		expect(update[1]).toEqual([INV_A, HOLDING]);
		expect(eventType(runner.query)).toBe('INVOICE_ERP_DRAFT_RESET');
		expect(eventMeta(runner.query)).toMatchObject({
			invoice_id: INV_A,
			before: { odoo_invoice_id: 321, sent_to_odoo_at: '2026-09-20T10:00:00.000Z', sent_at: '2026-09-20T10:00:00.000Z' },
			after: { odoo_invoice_id: null, sent_to_odoo_at: null, sent_at: null },
			reason: 'Se corrige el monto antes de reenviar',
			bulk_id: null,
		});
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][5]).toBe('user-1');
		expect(result).toMatchObject({
			invoice_id: INV_A,
			reset: true,
			previous_odoo_invoice_id: 321,
			warnings: [
				{ code: 'erp_draft_remains', message: 'El borrador sigue en el ERP: elimínalo allí para que no quede duplicado al reenviar.' },
			],
			event_id: 'event-1',
			invoice: { id: INV_A },
		});
		expect(contracts.invoiceDetail).toHaveBeenCalledWith(CONTRACT_ID, INV_A, HOLDING);
	});

	it('contrato spot con la tasa escrita por el envío: la factura vuelve a spot (líneas y encabezado en NULL, IVA en moneda de contrato)', async () => {
		const { service, runner } = build(
			{
				[INV_A]: invoiceRow(INV_A, {
					odoo_invoice_id: 321,
					sent_to_odoo_at: '2026-09-20T10:00:00.000Z',
					fx_contract_to_invoice: '950',
					amount_invoice_currency: '950000',
					vat: '180500',
					total_invoice_currency: '1130500',
					fx_explicit: false,
				}),
			},
			contextRow,
			[lineRow('line-1', { subtotal_invoice_currency: '950000', tax_amount_invoice_currency: '180500' })]
		);
		const result = await service.erpReset(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY);
		const [lines] = calls(runner.query, 'UPDATE invoice_items SET unit_price_invoice_currency = NULL');
		const [header] = calls(runner.query, 'UPDATE invoices SET fx_contract_to_invoice = NULL');

		expect(lines[1]).toEqual([INV_A, HOLDING]);
		expect(header[1]).toEqual([INV_A, HOLDING, 190]);
		expect(result).toMatchObject({ spot_reset: true, after: { fx_contract_to_invoice: null, amount_invoice_currency: null, vat: 190 } });
		expect(eventMeta(runner.query)).toMatchObject({
			spot_reset: true,
			before: { fx_contract_to_invoice: 950, amount_invoice_currency: 950000 },
			after: { fx_contract_to_invoice: null, amount_invoice_currency: null, total_invoice_currency: null },
		});
		// Con tasa fijada explícitamente desde el 360 se conserva.
		const kept = build(
			{
				[INV_A]: invoiceRow(INV_A, {
					odoo_invoice_id: 321,
					fx_contract_to_invoice: '950',
					amount_invoice_currency: '950000',
					fx_explicit: true,
				}),
			},
			contextRow
		);

		await kept.service.erpReset(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY);
		expect(calls(kept.runner.query, 'UPDATE invoices SET fx_contract_to_invoice = NULL')).toHaveLength(0);
	});

	it('una no vinculada al ERP → 409 blocked not_sent_to_erp, sin escribir', async () => {
		const { service, runner } = build();
		const error = await service.erpReset(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1', TODAY).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect(((error as ConflictException).getResponse() as Row).blockers).toEqual([expect.objectContaining({ code: 'not_sent_to_erp' })]);
		expect(calls(runner.query, 'UPDATE invoices')).toHaveLength(0);
	});

	it('masivo: restablece las que pasan, salta y reporta las bloqueadas, un evento por factura con bulk_id compartido', async () => {
		const { service, runner } = build({
			[INV_A]: invoiceRow(INV_A, { odoo_invoice_id: 1 }),
			[INV_B]: invoiceRow(INV_B, { odoo_invoice_id: 2 }),
			[INV_C]: invoiceRow(INV_C),
		});
		const result = await service.erpResetBulk(CONTRACT_ID, { invoice_ids: [INV_A, INV_B, INV_C], reason: 'Reenvío' }, HOLDING, 'auth-1', TODAY);

		expect(result.updated).toEqual([INV_A, INV_B]);
		expect(result.skipped).toEqual([{ id: INV_C, invoice_number: null, blockers: [expect.objectContaining({ code: 'not_sent_to_erp' })] }]);
		expect(calls(runner.query, 'UPDATE invoices SET odoo_invoice_id = NULL')).toHaveLength(2);
		expect(result.event_ids).toEqual(['event-1', 'event-2']);
		expect(eventMeta(runner.query, 0).bulk_id).toBe(result.bulk_id);
		expect(eventMeta(runner.query, 1).bulk_id).toBe(result.bulk_id);
		const none = build({ [INV_C]: invoiceRow(INV_C) });

		await expect(none.service.erpResetBulk(CONTRACT_ID, { invoice_ids: [INV_C] }, HOLDING, 'auth-1', TODAY)).rejects.toBeInstanceOf(
			ConflictException
		);
	});
});

describe('ContractsController (facturas del contrato)', () => {
	const invoicesService = {
		previewSendNow: jest.fn().mockResolvedValue({ can_apply: true }),
		sendNow: jest.fn().mockResolvedValue({ sent: true }),
		previewMarkIssued: jest.fn().mockResolvedValue({}),
		markIssued: jest.fn().mockResolvedValue({}),
		previewReschedule: jest.fn().mockResolvedValue({}),
		reschedule: jest.fn().mockResolvedValue({}),
		previewRescheduleBulk: jest.fn().mockResolvedValue({}),
		rescheduleBulk: jest.fn().mockResolvedValue({}),
		previewFx: jest.fn().mockResolvedValue({}),
		fx: jest.fn().mockResolvedValue({}),
		previewFxBulk: jest.fn().mockResolvedValue({}),
		fxBulk: jest.fn().mockResolvedValue({}),
	};
	const controller = new ContractsController(
		{} as ContractsService,
		{} as ContractDraftsService,
		{} as ContractSubscriptionsService,
		{} as Contract360Service,
		{} as ContractBulkService,
		{} as ContractActivationService,
		{} as ConsumptionService,
		{} as ContractChangesService,
		invoicesService as unknown as ContractInvoicesService,
		{} as ContractInvoiceDescriptionsService,

		{} as ContractInvoiceEditService,
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

	it('rutas POST bajo `:id/invoices/...` con 200, todas tras SupabaseAuthGuard + HoldingScopeGuard', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		const POST = 1;

		expect(routeOf('sendNowPreview')).toEqual({ path: ':id/invoices/:invoiceId/send-now/preview', method: POST, code: 200 });
		expect(routeOf('sendNow')).toEqual({ path: ':id/invoices/:invoiceId/send-now', method: POST, code: 200 });
		expect(routeOf('markIssuedPreview')).toEqual({ path: ':id/invoices/:invoiceId/mark-issued/preview', method: POST, code: 200 });
		expect(routeOf('markIssued')).toEqual({ path: ':id/invoices/:invoiceId/mark-issued', method: POST, code: 200 });
		expect(routeOf('reschedulePreview')).toEqual({ path: ':id/invoices/:invoiceId/reschedule/preview', method: POST, code: 200 });
		expect(routeOf('reschedule')).toEqual({ path: ':id/invoices/:invoiceId/reschedule', method: POST, code: 200 });
		expect(routeOf('rescheduleBulkPreview')).toEqual({ path: ':id/invoices/reschedule-bulk/preview', method: POST, code: 200 });
		expect(routeOf('rescheduleBulk')).toEqual({ path: ':id/invoices/reschedule-bulk', method: POST, code: 200 });
		expect(routeOf('fxPreview')).toEqual({ path: ':id/invoices/:invoiceId/fx/preview', method: POST, code: 200 });
		expect(routeOf('fx')).toEqual({ path: ':id/invoices/:invoiceId/fx', method: POST, code: 200 });
		expect(routeOf('fxBulkPreview')).toEqual({ path: ':id/invoices/fx-bulk/preview', method: POST, code: 200 });
		expect(routeOf('fxBulk')).toEqual({ path: ':id/invoices/fx-bulk', method: POST, code: 200 });
	});

	it('pasa holding y usuario al servicio', async () => {
		await controller.sendNow(CONTRACT_ID, INV_A, {}, HOLDING, req);
		expect(invoicesService.sendNow).toHaveBeenCalledWith(CONTRACT_ID, INV_A, {}, HOLDING, 'auth-1');
		await controller.markIssued(CONTRACT_ID, INV_A, { invoice_number: 'F-1', issue_date: '2026-10-01' }, HOLDING, req);
		expect(invoicesService.markIssued).toHaveBeenCalledWith(
			CONTRACT_ID,
			INV_A,
			{ invoice_number: 'F-1', issue_date: '2026-10-01' },
			HOLDING,
			'auth-1'
		);
		await controller.rescheduleBulk(CONTRACT_ID, { invoice_ids: [INV_A], shift_months: 1 }, HOLDING, req);
		expect(invoicesService.rescheduleBulk).toHaveBeenCalledWith(CONTRACT_ID, { invoice_ids: [INV_A], shift_months: 1 }, HOLDING, 'auth-1');
		await controller.fxPreview(CONTRACT_ID, INV_A, { policy: 'spot' }, HOLDING);
		expect(invoicesService.previewFx).toHaveBeenCalledWith(CONTRACT_ID, INV_A, { policy: 'spot' }, HOLDING);
	});

	it('DTOs: folio y fecha obligatorios en mark-issued; fixed exige tasa; net_exact exige neto; masivo exige meses o fecha', async () => {
		const errors = async (dto: object) => flattenValidationErrors(await validate(dto)).map((error) => error.field);

		expect(await errors(plainToInstance(MarkInvoiceIssuedDto, { invoice_number: '  ', issue_date: '2026-13-01' }))).toEqual([
			'invoice_number',
			'issue_date',
		]);
		expect(await errors(plainToInstance(MarkInvoiceIssuedDto, { invoice_number: 'F-1', issue_date: '2026-10-01', fx_rate: 0 }))).toEqual([
			'fx_rate',
		]);
		expect(await errors(plainToInstance(InvoiceFxDto, { policy: 'fixed' }))).toEqual(['rate']);
		expect(await errors(plainToInstance(InvoiceFxDto, { policy: 'net_exact' }))).toEqual(['target_net_amount']);
		expect(await errors(plainToInstance(InvoiceFxDto, { policy: 'spot' }))).toEqual([]);
		expect(await errors(plainToInstance(InvoiceFxDto, { policy: 'otra' }))).toEqual(['policy']);
		expect(await errors(plainToInstance(RescheduleInvoiceDto, { issue_date: '2026-10-01', apply_to: 'all' }))).toEqual(['apply_to']);
		expect(await errors(plainToInstance(RescheduleInvoicesBulkDto, { invoice_ids: [INV_A] }))).toEqual(['shift_months', 'issue_date']);
		expect(await errors(plainToInstance(RescheduleInvoicesBulkDto, { invoice_ids: [INV_A], shift_months: 13 }))).toEqual(['shift_months']);
		expect(await errors(plainToInstance(RescheduleInvoicesBulkDto, { invoice_ids: ['x'], issue_date: '2026-10-01' }))).toEqual(['invoice_ids']);
		expect(await errors(plainToInstance(InvoiceFxBulkDto, { invoice_ids: [], policy: 'spot' }))).toEqual(['invoice_ids']);
	});
});
