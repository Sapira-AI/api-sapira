// `InvoiceSchedulerService` (importado por el controlador) usa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common/enums';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { flattenValidationErrors } from '@/core/utils/validation-errors';

import { API_WRITER_SQL } from './api-writer';
import { ContractInvoiceConsolidationService } from './contract-invoice-consolidation.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ConsolidateInvoicesDto, UndoConsolidationDto } from './dtos/contract-invoice-consolidation.dto';

type Row = Record<string, unknown>;

const HOLDING = 'h-1';
const CTR_A = '11111111-1111-4111-8111-111111111111';
const CTR_B = '22222222-2222-4222-8222-222222222222';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TODAY = new Date('2026-10-01T12:00:00Z');

const invoiceRow = (overrides: Row = {}): Row => ({
	id: INV_A,
	invoice_number: null,
	contract_id: CTR_A,
	contract_number: 'CTR-2026-1',
	client_id: 'client-a',
	client_name: 'Cliente A',
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	consolidated_into_invoice_id: null,
	company_id: 'company-1',
	client_entity_id: 'entity-1',
	legal_name: 'Socio SpA',
	invoice_currency: 'CLP',
	contract_currency: 'USD',
	issue_date: '2026-10-05',
	scheduled_at: '2026-10-05',
	due_date: '2026-11-04',
	export_type: '0',
	invoice_series: 'FAC',
	tax_rate: '19',
	amount_contract_currency: '1000',
	vat: '180500',
	amount_invoice_currency: '950000',
	total_invoice_currency: '1130500',
	amount_system_currency: '1000',
	total_system_currency: '1190',
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	auto_invoice: true,
	requires_references_for_billing: false,
	contract_requires_references: false,
	auto_send_to_odoo: true,
	lines_count: '1',
	internal_lines: '0',
	open_lines: '0',
	cutoff_date: null,
	...overrides,
});
const invoiceB = (overrides: Row = {}) =>
	invoiceRow({
		id: INV_B,
		contract_id: CTR_B,
		contract_number: 'CTR-2026-2',
		client_id: 'client-b',
		client_name: 'Cliente B',
		amount_contract_currency: '2000',
		amount_invoice_currency: '1900000',
		vat: '361000',
		total_invoice_currency: '2261000',
		contract_requires_references: true,
		...overrides,
	});
const lineRow = (id: string, invoiceId: string, subtotal: number, overrides: Row = {}): Row => ({
	id,
	invoice_id: invoiceId,
	contract_id: null,
	contract_item_id: `item-${id}`,
	description: `GLOSA ${id}`,
	product_name: 'Producto',
	contract_currency: 'USD',
	quantity: '1',
	unit_price_contract_currency: String(subtotal),
	subtotal_contract_currency: String(subtotal),
	tax_amount_contract_currency: String(subtotal * 0.19),
	total_contract_currency: String(subtotal * 1.19),
	unit_price_invoice_currency: String(subtotal * 950),
	subtotal_invoice_currency: String(subtotal * 950),
	tax_amount_invoice_currency: String(subtotal * 950 * 0.19),
	total_invoice_currency: String(subtotal * 950 * 1.19),
	fx_contract_to_invoice: '950',
	fx_rate_source: 'contract',
	fx_rate_date: '2026-10-01',
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	...overrides,
});

interface Fixture {
	invoices?: Row[];
	consolidated?: Row;
	origins?: Row[];
	event?: Row | null;
}

const build = (fixture: Fixture = {}) => {
	const invoices = fixture.invoices ?? [invoiceRow(), invoiceB()];
	const route = (sql: string, params: unknown[] = []): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('SELECT DISTINCT i.contract_id'))
			return [...new Set(invoices.map((row) => row.contract_id))].map((id) => ({ contract_id: id }));
		if (sql.includes('i.consolidated_into_invoice_id = $2::uuid')) return fixture.origins ?? [];
		if (sql.includes('FROM invoices i') && sql.includes('i.id = ANY($2::uuid[])')) {
			const ids = params[1] as string[];

			return [...invoices, ...(fixture.consolidated ? [fixture.consolidated] : [])].filter((row) => ids.includes(String(row.id)));
		}
		if (sql.includes('FROM invoices i') && sql.includes('LIMIT 100')) return [invoiceB()];
		if (sql.includes('FROM invoice_items ii LEFT JOIN contract_items ci')) return [lineRow('la', INV_A, 1000), lineRow('lb', INV_B, 2000)];
		if (sql.includes('FROM invoice_references r'))
			return [
				{ id: 'ref-1', source: 'invoice', invoice_id: INV_A, type: '801', name: 'Orden de Compra', code: '4500' },
				{ id: 'ref-2', source: 'invoice', invoice_id: INV_B, type: '801', name: 'Orden de Compra', code: '4500' },
				{ id: 'br-1', source: 'contract', invoice_id: INV_B, type: 'HES', name: null, code: 'H-1' },
			];
		if (sql.includes('tdt.description_max_chars')) return [];
		if (sql.includes("event_type = 'INVOICE_CONSOLIDATED'")) return fixture.event === null ? [] : [fixture.event ?? { id: 'ev-0', metadata: {} }];
		if (sql.includes('INSERT INTO invoices')) return [{ id: CONS }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${String(params[0])}` }];
		// UPDATE … RETURNING: TypeORM (postgres) devuelve [filas, rowCount].
		if (sql.includes('UPDATE invoices SET is_active = true'))
			return [(fixture.origins ?? []).map((row) => ({ id: row.id })), (fixture.origins ?? []).length] as unknown as Row[];
		if (sql.includes('FROM invoices i') && sql.includes('JOIN contracts c ON c.id = i.contract_id') && sql.includes('holding_settings'))
			return [
				{ id: CONS, source_currency: 'USD', from_invoice: false, fx_date: '2026-10-05', system_currency: 'USD', fx_policy: 'monthly_avg' },
			];

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
		resolveContract: jest.fn().mockResolvedValue({ id: CTR_A, status: 'Activo' }),
		invoiceDetail: jest.fn().mockResolvedValue({ id: CONS }),
	} as unknown as ContractsService;

	return { service: new ContractInvoiceConsolidationService(dataSource, contracts), runner, dataSource, contracts };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const rejection = async (promise: Promise<unknown>) => promise.catch((caught: unknown) => caught);
const dto = (ids = [INV_A, INV_B], notes?: string) => ({ invoice_ids: ids, ...(notes ? { notes } : {}) }) as ConsolidateInvoicesDto;

describe('ContractInvoiceConsolidationService (spec multimoneda §7)', () => {
	it('candidatas: Por Emitir de otros contratos que calzan con la base, con bloqueos y `eligible`', async () => {
		const { service, dataSource } = build();
		const result = await service.candidates('CTR-2026-1', INV_A, HOLDING);
		const [[sql, params]] = calls(dataSource.query as unknown as jest.Mock, 'LIMIT 100');

		expect(sql).toContain('i.contract_id <> $3::uuid');
		expect(sql).toContain("date_trunc('month', COALESCE(i.issue_date, i.scheduled_at))");
		expect(params).toEqual([HOLDING, INV_A, CTR_A, 'company-1', 'entity-1', 'CLP', '2026-10-05', 'FACTURA', 0]);
		expect(result).toMatchObject({
			invoice: { id: INV_A, eligible: true },
			base_blockers: [],
			candidates: [{ id: INV_B, contract_number: 'CTR-2026-2', eligible: true, blockers: [] }],
			total: 1,
		});
	});

	it('candidatas: 404 si la factura no es del contrato', async () => {
		const { service } = build();

		await expect(service.candidates('CTR-2026-2', INV_B, HOLDING)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('preview: no abre transacción ni escribe; aporte por contrato y principal', async () => {
		const { service, dataSource } = build();
		const preview = await service.preview(dto(), HOLDING);

		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		expect(sqlOf(dataSource.query as unknown as jest.Mock).some((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql))).toBe(false);
		expect(preview).toMatchObject({
			can_apply: true,
			main_contract_id: CTR_B,
			contributions: [
				{ contract_id: CTR_B, subtotal_invoice_currency: 1900000, main: true },
				{ contract_id: CTR_A, subtotal_invoice_currency: 950000, main: false },
			],
			header: { amount_invoice_currency: 2850000, requires_references_for_billing: true },
			references: { invoice_reference_ids: ['ref-1'], contract_reference_ids: ['br-1'], deduped: 1 },
		});
	});

	it('preview: 404 si alguna factura no existe en el holding', async () => {
		const { service } = build();

		await expect(service.preview(dto([INV_A, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd']), HOLDING)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('aplica: api primero, contratos bloqueados en orden, documento Unificada con copias (número de contrato al final), referencias, orígenes inactivos y un evento por contrato', async () => {
		const { service, runner, contracts } = build();
		const result = await service.apply(dto(undefined, 'Socio octubre'), HOLDING, 'auth-1', TODAY);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toBe(API_WRITER_SQL);
		expect(sql[1]).toContain('FROM contracts WHERE id = ANY($1::uuid[])');
		expect(sql[1]).toContain('ORDER BY id FOR UPDATE');
		expect((runner.query.mock.calls[1] as unknown[])[1]).toEqual([[CTR_A, CTR_B], HOLDING]);
		expect(sql[2]).toContain('FROM invoices WHERE holding_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE');
		const [header] = calls(runner.query, 'INSERT INTO invoices');

		expect(header[0]).toContain("'Unificada'");
		expect(header[0]).toContain('g.id, g.id');
		expect(header[1]).toEqual([
			INV_B,
			HOLDING,
			CTR_B,
			'2026-10-05',
			'2026-10-05',
			'2026-11-04',
			541500,
			3000,
			2850000,
			3391500,
			'USD',
			'CLP',
			950,
			null,
			null,
			true,
			true,
			'Socio octubre',
		]);
		const [lines] = calls(runner.query, 'INSERT INTO invoice_items');
		const payload = JSON.parse((lines[1] as unknown[])[1] as string) as Row[];

		expect(payload.map((entry) => [entry.source_id, entry.contract_id, entry.description, entry.fx])).toEqual([
			['lb', CTR_B, 'GLOSA lb - CTR-2026-2', 950],
			['la', CTR_A, 'GLOSA la - CTR-2026-1', 950],
		]);
		expect(calls(runner.query, 'INSERT INTO invoice_references')[0][1]).toEqual([CONS, ['ref-1'], HOLDING]);
		expect(calls(runner.query, 'INSERT INTO invoice_reference_links')[0][1]).toEqual([CONS, ['br-1'], HOLDING, 'user-1']);
		expect(calls(runner.query, 'UPDATE invoices SET is_active = false')[0][1]).toEqual([CONS, [INV_A, INV_B], HOLDING]);
		expect(calls(runner.query, 'holding_settings')).toHaveLength(1);
		const events = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(events.map(([, params]) => [(params as unknown[])[0], (params as unknown[])[2]])).toEqual([
			[CTR_B, 'INVOICE_CONSOLIDATED'],
			[CTR_A, 'INVOICE_CONSOLIDATED'],
		]);
		expect(JSON.parse((events[0][1] as unknown[])[7] as string)).toMatchObject({
			source: 'contract_360',
			invoice_id: CONS,
			consolidated_invoice_id: CONS,
			source_invoice_ids: [INV_A, INV_B],
			invoice_ids: [CONS, INV_A, INV_B],
			contracts: [
				{ contract_id: CTR_B, main: true },
				{ contract_id: CTR_A, main: false },
			],
			notes: 'Socio octubre',
		});
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(0);
		expect(sql.some((statement) => /UPDATE invoices\b/.test(statement) && statement.includes('updated_at'))).toBe(false);
		expect(sql.some((statement) => /^\s*DELETE/i.test(statement))).toBe(false);
		expect(runner.commitTransaction).toHaveBeenCalled();
		expect(contracts.invoiceDetail).toHaveBeenCalledWith(CTR_B, CONS, HOLDING);
		expect(result).toMatchObject({
			applied: true,
			consolidated_invoice_id: CONS,
			event_ids: [`event-${CTR_B}`, `event-${CTR_A}`],
			invoice: { id: CONS },
		});
	});

	it('aplica en modo mixed (contratos en monedas distintas): el consolidado Por Emitir se recalcula desde su encabezado, que queda en moneda de factura (04-10)', async () => {
		const { service, runner } = build({ invoices: [invoiceRow(), invoiceB({ contract_currency: 'CLF' })] });

		await service.apply(dto(), HOLDING, 'auth-1', TODAY);
		const [header] = calls(runner.query, 'INSERT INTO invoices');

		// Encabezado en moneda de factura (modo mixed); la vista previa trae Σ de los orígenes, pero se reemplaza con el refresh.
		expect((header[1] as unknown[])[10]).toBe('CLP');
		const refresh = calls(runner.query, 'holding_settings');

		expect(refresh).toHaveLength(1);
		expect(refresh[0][1]).toEqual([[CONS], HOLDING]);
	});

	it('aplica con bloqueos (serie distinta, borrador en el ERP) → 409 blocked sin escribir y con rollback', async () => {
		const { service, runner } = build({ invoices: [invoiceRow(), invoiceB({ invoice_series: 'FEX', odoo_invoice_id: '44' })] });
		const error = (await rejection(service.apply(dto(), HOLDING, 'auth-1', TODAY))) as ConflictException;

		expect(error).toBeInstanceOf(ConflictException);
		expect(error.getResponse()).toMatchObject({
			code: 'blocked',
			blockers: expect.arrayContaining([
				expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' }),
				expect.objectContaining({ code: 'series_mismatch' }),
			]),
		});
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	describe('deshacer', () => {
		const consolidated = invoiceRow({ id: CONS, invoice_type: 'Unificada', contract_id: CTR_B, contract_number: 'CTR-2026-2' });
		const origins = [
			invoiceRow({ is_active: false, consolidated_into_invoice_id: CONS }),
			invoiceB({ is_active: false, consolidated_into_invoice_id: CONS }),
		];

		it('consolidado → Cancelada (sin DELETE), orígenes restaurados y un evento INVOICE_CONSOLIDATION_UNDONE por contrato', async () => {
			const { service, runner } = build({ consolidated, origins });
			const result = await service.undo(CONS, { reason: 'Error de agrupación' } as UndoConsolidationDto, HOLDING, 'auth-1', TODAY);
			const sql = sqlOf(runner.query);

			expect(sql[0]).toBe(API_WRITER_SQL);
			expect(calls(runner.query, "UPDATE invoices SET status = 'Cancelada'")[0][1]).toEqual([CONS, HOLDING]);
			expect(calls(runner.query, 'UPDATE invoices SET is_active = true, consolidated_into_invoice_id = NULL')[0][1]).toEqual([CONS, HOLDING]);
			expect(sql.some((statement) => /^\s*DELETE/i.test(statement))).toBe(false);
			const events = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

			expect(events.map(([, params]) => [(params as unknown[])[0], (params as unknown[])[2]])).toEqual([
				[CTR_A, 'INVOICE_CONSOLIDATION_UNDONE'],
				[CTR_B, 'INVOICE_CONSOLIDATION_UNDONE'],
			]);
			expect(JSON.parse((events[0][1] as unknown[])[7] as string)).toMatchObject({
				consolidated_invoice_id: CONS,
				source_invoice_ids: [INV_A, INV_B],
				reason: 'Error de agrupación',
			});
			expect(result).toMatchObject({ undone: true, status: 'Cancelada', restored_invoice_ids: [INV_A, INV_B] });
		});

		it('legacy (sin evento INVOICE_CONSOLIDATED) → 409 legacy_unified; enviado al ERP → sent_to_erp_draft', async () => {
			const legacy = build({ consolidated, origins, event: null });
			const legacyError = (await rejection(
				legacy.service.undo(CONS, { reason: 'x' } as UndoConsolidationDto, HOLDING, 'auth-1', TODAY)
			)) as ConflictException;

			expect(legacyError.getResponse()).toMatchObject({ code: 'blocked', blockers: [expect.objectContaining({ code: 'legacy_unified' })] });
			expect(calls(legacy.runner.query, 'UPDATE invoices')).toHaveLength(0);
			const sent = build({ consolidated: { ...consolidated, odoo_invoice_id: '9' }, origins });
			const sentError = (await rejection(
				sent.service.undo(CONS, { reason: 'x' } as UndoConsolidationDto, HOLDING, 'auth-1', TODAY)
			)) as ConflictException;

			expect(sentError.getResponse()).toMatchObject({
				blockers: [expect.objectContaining({ code: 'sent_to_erp_draft', action: 'erp_reset' })],
			});
		});
	});

	it('DTO: 2–50 ids UUID sin repetir, notas ≤ 500; deshacer exige motivo', async () => {
		const errors = flattenValidationErrors(await validate(plainToInstance(ConsolidateInvoicesDto, { invoice_ids: [INV_A] })));

		expect(errors.map((error) => error.message)).toContain('Elige al menos 2 facturas');
		const repeated = flattenValidationErrors(await validate(plainToInstance(ConsolidateInvoicesDto, { invoice_ids: [INV_A, INV_A] })));
		const invalid = flattenValidationErrors(await validate(plainToInstance(ConsolidateInvoicesDto, { invoice_ids: [INV_A, 'nope'] })));

		expect(repeated.map((error) => error.message)).toEqual(['Hay facturas repetidas']);
		expect(invalid.map((error) => error.message)).toEqual(['Factura inválida']);
		expect(await validate(plainToInstance(ConsolidateInvoicesDto, { invoice_ids: [INV_A, INV_B], notes: ' ok ' }))).toEqual([]);
		const undo = flattenValidationErrors(await validate(plainToInstance(UndoConsolidationDto, { reason: '  ' })));

		expect(undo.map((error) => error.message)).toContain('Escribe el motivo');
	});

	describe('re-unificar (regla de la razón social, Domi 07-10)', () => {
		const OLD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
		const previous = (overrides: Row = {}) =>
			invoiceRow({
				id: OLD,
				invoice_type: 'Unificada',
				contract_id: CTR_B,
				contract_number: 'CTR-2026-2',
				issue_date: '2026-10-20',
				scheduled_at: '2026-10-20',
				due_date: '2026-11-19',
				...overrides,
			});
		const origins = [
			invoiceRow({ is_active: false, consolidated_into_invoice_id: OLD }),
			invoiceB({ is_active: false, consolidated_into_invoice_id: OLD }),
		];
		const withCarry = (fixture: Fixture) => {
			const built = build(fixture);
			const route = built.runner.query.getMockImplementation()!;

			built.runner.query.mockImplementation((sql: string, params: unknown[] = []) => {
				if (sql.includes('FROM invoice_references r') && JSON.stringify(params[0]) === JSON.stringify([OLD]))
					return [
						// Copia en la anterior de la OC del origen (se descarta: ya viene del origen).
						{ id: 'ref-old-copy', source: 'invoice', invoice_id: OLD, type: '801', name: 'Orden de Compra', code: '4500' },
						// OC agregada a mano a la unificada ("Pide OC"): pasa a la nueva.
						{ id: 'ref-old', source: 'invoice', invoice_id: OLD, type: '801', name: 'Orden de Compra', code: '7788' },
						{ id: 'br-1', source: 'contract', invoice_id: OLD, type: 'HES', name: null, code: 'H-1' },
					];
				if (sql.includes('ii.description_locked = true'))
					return [
						{
							contract_id: CTR_B,
							contract_item_id: 'item-lb',
							billing_period_start: '2026-10-01',
							billing_period_end: '2026-10-31',
							tier_index: null,
							description: 'Soporte octubre (texto propio)',
						},
					];

				return route(sql, params);
			});

			return built;
		};

		it('una transacción: cancela la anterior y arma la nueva con sus referencias, glosas a mano y fechas reprogramadas', async () => {
			const { service, runner, dataSource } = withCarry({ consolidated: previous(), origins });
			const result = await service.reunifyInvoices(OLD, [INV_A, INV_B], 'Factura nueva del mes', HOLDING, 'user-1', {
				main_contract_id: CTR_B,
				rule_id: 'rule-1',
				source: 'consolidation_rule_job',
			});
			const sql = sqlOf(runner.query);

			expect((dataSource.createQueryRunner as jest.Mock).mock.calls).toHaveLength(1);
			expect(runner.startTransaction).toHaveBeenCalledTimes(1);
			expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
			const cancelled = sql.findIndex((text) => text.includes("UPDATE invoices SET status = 'Cancelada'"));
			const created = sql.findIndex((text) => text.includes('INSERT INTO invoices'));

			expect(cancelled).toBeGreaterThan(-1);
			expect(created).toBeGreaterThan(cancelled);
			// Fechas reprogramadas de la anterior (no las de la factura del principal).
			expect((calls(runner.query, 'INSERT INTO invoices')[0][1] as unknown[]).slice(3, 6)).toEqual(['2026-10-20', '2026-10-20', '2026-11-19']);
			// Referencias: las de los orígenes más la OC agregada a la anterior, sin repetir tipo+folio; la del contrato, vinculada una vez.
			expect(calls(runner.query, 'INSERT INTO invoice_references')[0][1]).toEqual([CONS, ['ref-1', 'ref-old'], HOLDING]);
			expect(calls(runner.query, 'INSERT INTO invoice_reference_links')[0][1]).toEqual([CONS, ['br-1'], HOLDING, 'user-1']);
			// Glosa escrita a mano en la anterior: se conserva (protegida) en la línea que calza por ítem y período.
			const copies = JSON.parse((calls(runner.query, 'INSERT INTO invoice_items')[0][1] as unknown[])[1] as string) as Row[];

			expect(copies.map((copy) => [copy.source_id, copy.description, copy.locked])).toEqual([
				['lb', 'Soporte octubre (texto propio)', true],
				['la', 'GLOSA la - CTR-2026-1', null],
			]);
			const [consolidated] = calls(runner.query, 'INSERT INTO contract_lifecycle_events').filter(
				([, params]) => (params as unknown[])[2] === 'INVOICE_CONSOLIDATED'
			);

			expect(JSON.parse((consolidated[1] as unknown[])[7] as string)).toMatchObject({
				rule_id: 'rule-1',
				previous_consolidated_invoice_id: OLD,
				kept_descriptions: 1,
				kept_dates: true,
			});
			expect(result).toMatchObject({
				applied: true,
				consolidated_invoice_id: CONS,
				undone: { undone: true },
				carried: { references: 3, descriptions: 1 },
			});
		});

		it('sin reprogramar: la nueva toma las fechas de la factura del principal del mes', async () => {
			const { service, runner } = withCarry({
				consolidated: previous({ issue_date: '2026-10-05', scheduled_at: '2026-10-05', due_date: '2026-11-04' }),
				origins,
			});

			await service.reunifyInvoices(OLD, [INV_A, INV_B], 'x', HOLDING, null, { main_contract_id: CTR_B });
			expect((calls(runner.query, 'INSERT INTO invoices')[0][1] as unknown[]).slice(3, 6)).toEqual(['2026-10-05', '2026-10-05', '2026-11-04']);
		});

		it('si la nueva queda bloqueada, rollback: la anterior no se cancela', async () => {
			const { service, runner } = withCarry({
				consolidated: previous(),
				origins,
				invoices: [invoiceRow(), invoiceB({ invoice_series: 'FEX' })],
			});
			const error = await rejection(service.reunifyInvoices(OLD, [INV_A, INV_B], 'x', HOLDING, null, { main_contract_id: CTR_B }));

			expect(error).toBeInstanceOf(ConflictException);
			expect(runner.rollbackTransaction).toHaveBeenCalled();
			expect(runner.commitTransaction).not.toHaveBeenCalled();
		});
	});

	it('rutas: candidatas bajo el contrato; consolidar y deshacer como rutas fijas `invoices/consolidations…`', () => {
		const proto = ContractsController.prototype as unknown as Record<string, object>;
		const route = (name: string) => [Reflect.getMetadata(METHOD_METADATA, proto[name]), Reflect.getMetadata(PATH_METADATA, proto[name])];

		expect(route('consolidationCandidates')).toEqual([RequestMethod.GET, ':id/invoices/:invoiceId/consolidation-candidates']);
		expect(route('consolidationPreview')).toEqual([RequestMethod.POST, 'invoices/consolidations/preview']);
		expect(route('consolidate')).toEqual([RequestMethod.POST, 'invoices/consolidations']);
		expect(route('undoConsolidation')).toEqual([RequestMethod.POST, 'invoices/consolidations/:invoiceId/undo']);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.consolidationPreview)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.undoConsolidation)).toBe(200);
		// Las rutas fijas se declaran antes que cualquier ruta `:id/...` para que Nest no tome `invoices` como id de contrato.
		const names = Object.getOwnPropertyNames(ContractsController.prototype);

		expect(names.indexOf('consolidationPreview')).toBeLessThan(names.indexOf('remove'));
		expect(names.indexOf('consolidate')).toBeLessThan(names.indexOf('remove'));
	});

	it('el controlador delega en el servicio con el holding del guard y el usuario', async () => {
		const consolidation = {
			candidates: jest.fn().mockResolvedValue({}),
			preview: jest.fn().mockResolvedValue({}),
			apply: jest.fn().mockResolvedValue({}),
			undo: jest.fn().mockResolvedValue({}),
		} as unknown as ContractInvoiceConsolidationService;
		// Los 14 servicios anteriores no se usan aquí; el de consolidación va último.
		const Controller = ContractsController as unknown as new (...args: unknown[]) => ContractsController;
		const controller = new Controller(...Array.from({ length: 14 }, () => ({})), consolidation);
		const req = { user: { sub: 'auth-1' } };

		await controller.consolidationCandidates('CTR-2026-1', INV_A, HOLDING);
		await controller.consolidationPreview(dto(), HOLDING);
		await controller.consolidate(dto(), HOLDING, req);
		await controller.undoConsolidation(CONS, { reason: 'x' } as UndoConsolidationDto, HOLDING, req);
		expect(consolidation.candidates).toHaveBeenCalledWith('CTR-2026-1', INV_A, HOLDING);
		expect(consolidation.preview).toHaveBeenCalledWith(dto(), HOLDING);
		expect(consolidation.apply).toHaveBeenCalledWith(dto(), HOLDING, 'auth-1');
		expect(consolidation.undo).toHaveBeenCalledWith(CONS, { reason: 'x' }, HOLDING, 'auth-1');
	});
});

describe('resyncFromOrigins: consumo sobre un origen consolidado (Domi 05-10)', () => {
	const origins = [
		invoiceRow({ is_active: false, consolidated_into_invoice_id: CONS }),
		invoiceB({ is_active: false, consolidated_into_invoice_id: CONS }),
	];

	it('borra las copias del unificado Por Emitir, vuelve a copiar las de todos los orígenes y recalcula su encabezado (sin tocar contrato ni fechas)', async () => {
		const { service, runner } = build({ origins });
		const route = runner.query.getMockImplementation()!;

		runner.query.mockImplementation((sql: string, params: unknown[] = []) =>
			sql.includes('FOR UPDATE') && sql.includes('SELECT id, invoice_number, status')
				? [{ id: CONS, invoice_number: 'U-1', status: 'Por Emitir', invoice_currency: 'CLP', issue_date: '2026-10-05' }]
				: route(sql, params)
		);
		const result = await service.resyncFromOrigins(runner as never, HOLDING, CONS);
		const sql = sqlOf(runner.query);

		expect(result).toMatchObject({ invoice_id: CONS, invoice_number: 'U-1', lines_count: 2, amount_contract_currency: 3000 });
		const del = sql.findIndex((text) => text.includes('DELETE FROM invoice_items WHERE invoice_id = $1'));
		const ins = sql.findIndex((text) => text.includes('INSERT INTO invoice_items'));
		const upd = sql.findIndex((text) => text.includes('UPDATE invoices SET vat = $3'));

		expect(del).toBeGreaterThan(-1);
		expect(ins).toBeGreaterThan(del);
		expect(upd).toBeGreaterThan(ins);
		const [insert] = calls(runner.query, 'INSERT INTO invoice_items');
		const copies = JSON.parse(insert[1][1] as string) as Array<{ source_id: string; description: string }>;

		expect(copies.map((copy) => copy.source_id).sort()).toEqual(['la', 'lb']);
		expect(copies.every((copy) => /^GLOSA l[ab] - CTR-2026-\d$/.test(copy.description))).toBe(true);
		expect(insert[1].slice(2, 4)).toEqual(['CLP', '2026-10-05']);
		expect(sql[upd]).not.toContain('contract_id');
		expect(sql[upd]).toContain(`status = 'Por Emitir'`);
		// Ni INSERT de encabezado nuevo ni eventos: es el mismo documento.
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')).toHaveLength(0);
	});

	it('conserva la glosa escrita a mano en la unificada (Editar descripción) y respeta el principal de la unificada', async () => {
		const { service, runner } = build({ origins });
		const route = runner.query.getMockImplementation()!;

		runner.query.mockImplementation((sql: string, params: unknown[] = []) => {
			if (sql.includes('FOR UPDATE') && sql.includes('SELECT id, invoice_number, status'))
				return [
					{ id: CONS, invoice_number: 'U-1', status: 'Por Emitir', contract_id: CTR_A, invoice_currency: 'CLP', issue_date: '2026-10-05' },
				];
			if (sql.includes('ii.description_locked = true'))
				return [
					{
						contract_id: CTR_B,
						contract_item_id: 'item-lb',
						billing_period_start: '2026-10-01',
						billing_period_end: '2026-10-31',
						tier_index: null,
						description: 'Soporte octubre (texto propio)',
					},
				];

			return route(sql, params);
		});
		const result = await service.resyncFromOrigins(runner as never, HOLDING, CONS);
		const [insert] = calls(runner.query, 'INSERT INTO invoice_items');
		const copies = JSON.parse(insert[1][1] as string) as Array<{ source_id: string; description: string; locked: boolean | null }>;

		expect(result.kept_descriptions).toBe(1);
		// Principal fijado = el de la unificada (CTR_A): sus líneas van primero aunque aporte menos.
		expect(copies.map((copy) => [copy.source_id, copy.description, copy.locked])).toEqual([
			['la', 'GLOSA la - CTR-2026-1', null],
			['lb', 'Soporte octubre (texto propio)', true],
		]);
		expect(insert[0]).toContain('COALESCE(p.locked, s.description_locked)');
	});

	it('409 si el unificado ya no está Por Emitir (emitido o deshecho)', async () => {
		const { service, runner } = build({ origins });
		const error = await rejection(service.resyncFromOrigins(runner as never, HOLDING, CONS));

		expect(error).toBeInstanceOf(ConflictException);
		expect(calls(runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);
	});
});
