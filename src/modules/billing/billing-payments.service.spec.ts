jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { API_WRITER_SQL } from '@/modules/contracts/api-writer';

import { BillingPaymentsService } from './billing-payments.service';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const INVOICE = '11111111-2222-4333-8444-555555555555';
const PAYMENT = '99999999-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-01T15:00:00Z');

const invoice = (overrides: Record<string, unknown> = {}) => ({
	id: INVOICE,
	invoice_number: 'F-10',
	status: 'Emitida',
	document_type: 'FACTURA',
	is_active: true,
	contract_id: 'k1',
	client_id: 'c1',
	invoice_currency: 'CLP',
	total: '1000',
	due_date: '2026-10-15',
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	voided: false,
	paid: '0',
	cutoff_date: null,
	...overrides,
});

function build(options: { invoice?: Record<string, unknown>; invoices?: Record<string, unknown>[]; payment?: Record<string, unknown> } = {}) {
	const runnerQuery = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) => {
		if (sql.includes('AS total, i.due_date::text AS due_date, i.odoo_invoice_id')) return options.invoices ?? [invoice(options.invoice)];
		if (sql.includes('INSERT INTO invoice_payments')) return [{ id: PAYMENT }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: 'event-1' }];
		if (sql.includes('FROM invoice_payments p WHERE p.id')) return options.payment ? [options.payment] : [];

		return [];
	});
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: runnerQuery,
	};
	const query = jest.fn(async (sql: string) => {
		if (sql.includes('role_permissions')) return [];
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];

		return [];
	});
	const dataSource = { query, createQueryRunner: () => runner } as unknown as DataSource;

	return { runner, runnerQuery, service: new BillingPaymentsService(dataSource) };
}

const sqls = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => String(sql));

describe('BillingPaymentsService', () => {
	it('registrar: setApiWriter primero, INSERT confirmado con moneda y autor, estado escrito por la API y evento', async () => {
		const { runnerQuery, runner, service } = build();
		const result = await service.register(
			HOLDING,
			{ allocations: [{ invoice_id: INVOICE, amount: 1000 }], currency: 'clp', payment_date: '2026-10-01', method: 'transferencia' },
			'auth-1',
			NOW
		);
		const statements = sqls(runnerQuery);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements[1]).toContain('FOR UPDATE OF i');
		const insert = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO invoice_payments'))!;

		expect(insert[1]).toEqual([INVOICE, HOLDING, 1000, 'CLP', '2026-10-01', 'transferencia', null, null, 'user-1']);
		const update = runnerQuery.mock.calls.find(([sql]) => sql.includes('UPDATE invoices SET status'))!;

		expect(update[1]).toEqual([INVOICE, HOLDING, 'Pagada']);
		expect(statements.findIndex((sql) => sql.includes('UPDATE invoices'))).toBeGreaterThan(
			statements.findIndex((sql) => sql.includes('INSERT INTO invoice_payments'))
		);
		const event = runnerQuery.mock.calls.find(([sql]) => sql.includes('contract_lifecycle_events'))!;

		expect(event[1]?.[2]).toBe('INVOICE_PAYMENT_REGISTERED');
		expect(result).toMatchObject({ applied: true, payment_ids: [PAYMENT], event_ids: ['event-1'] });
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('registrar sobre una Por Emitir → 409 not_issued y rollback (B-F3)', async () => {
		const { runner, runnerQuery, service } = build({ invoice: { status: 'Por Emitir' } });

		await expect(
			service.register(
				HOLDING,
				{ allocations: [{ invoice_id: INVOICE, amount: 10 }], currency: 'CLP', payment_date: '2026-10-01' },
				'auth-1',
				NOW
			)
		).rejects.toBeInstanceOf(ConflictException);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
		expect(sqls(runnerQuery).some((sql) => sql.includes('INSERT INTO invoice_payments'))).toBe(false);
	});

	it('anular: confirmed = false (sin DELETE) y estado hacia atrás (Pagada → Emitida)', async () => {
		const { runnerQuery, service } = build({
			invoice: { status: 'Pagada', paid: '1000' },
			payment: { id: PAYMENT, invoice_id: INVOICE, amount: '1000', currency: 'CLP', payment_date: '2026-09-20', confirmed: true },
		});
		const result = await service.void(HOLDING, PAYMENT, { reason: 'Pago duplicado' }, 'auth-1', NOW);
		const statements = sqls(runnerQuery);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements.some((sql) => /DELETE/i.test(sql))).toBe(false);
		expect(statements.some((sql) => sql.includes('UPDATE invoice_payments SET confirmed = false'))).toBe(true);
		expect(result).toMatchObject({
			voided: true,
			before: { status: 'Pagada', paid: 1000 },
			after: { status: 'Emitida', paid: 0 },
			event_id: 'event-1',
		});
	});

	it('anular dos veces → 409 already_voided', async () => {
		const { service } = build({
			payment: { id: PAYMENT, invoice_id: INVOICE, amount: '10', currency: 'CLP', payment_date: '2026-09-20', confirmed: false },
		});

		await expect(service.void(HOLDING, PAYMENT, { reason: 'x' }, 'auth-1', NOW)).rejects.toMatchObject({
			response: { code: 'blocked', blockers: [expect.objectContaining({ code: 'already_voided' })] },
		});
	});

	it('register sin opciones: el INSERT no nombra las columnas de conciliación (sirve antes de la migración 1790740000000)', async () => {
		const { runnerQuery, service } = build();

		await service.register(
			HOLDING,
			{ allocations: [{ invoice_id: INVOICE, amount: 10 }], currency: 'CLP', payment_date: '2026-10-01' },
			'auth-1',
			NOW
		);
		const insert = sqls(runnerQuery).find((sql) => sql.includes('INSERT INTO invoice_payments'))!;

		expect(insert).not.toMatch(/bank_movement_id|original_amount|fx_rate|settlement_reason/);
	});

	it('register con runner del llamador (conciliación): no abre transacción; INSERT con movimiento, monto original y tipo de cambio; evento con metadata', async () => {
		const { runner, runnerQuery, service } = build();
		const result = await service.register(
			HOLDING,
			{ allocations: [{ invoice_id: INVOICE, amount: 950 }], currency: 'CLP', payment_date: '2026-10-01', method: 'transfer' },
			'auth-1',
			NOW,
			{
				runner: runner as never,
				bankMovementId: 'mov-1',
				originalAmounts: { [INVOICE]: 1 },
				fxRate: 950,
				originalCurrency: 'usd',
			}
		);
		const statements = sqls(runnerQuery);

		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect(runner.commitTransaction).not.toHaveBeenCalled();
		expect(statements[0]).toContain('FOR UPDATE OF i');
		const insert = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO invoice_payments'))!;

		expect(insert[0]).toContain('bank_movement_id, original_amount, fx_rate');
		expect(insert[0]).not.toContain('settlement_reason');
		expect(insert[1]).toEqual([INVOICE, HOLDING, 950, 'CLP', '2026-10-01', 'transfer', null, null, 'user-1', 'mov-1', 1, 950]);
		const event = runnerQuery.mock.calls.find(([sql]) => sql.includes('contract_lifecycle_events'))!;

		expect(JSON.parse(String(event[1]?.[7]))).toMatchObject({
			bank_movement_id: 'mov-1',
			original_amount: 1,
			original_currency: 'USD',
			fx_rate: 950,
			currency: 'CLP',
		});
		expect(result).toMatchObject({ applied: true, warnings: [] });
	});

	it('ajuste no monetario: settlement_reason en el INSERT y en el evento', async () => {
		const { runner, runnerQuery, service } = build();

		await service.register(
			HOLDING,
			{
				allocations: [{ invoice_id: INVOICE, amount: 5 }],
				currency: 'CLP',
				payment_date: '2026-10-01',
				method: 'adjustment',
				notes: 'Comisión',
			},
			'auth-1',
			NOW,
			{ runner: runner as never, bankMovementId: 'mov-1', settlementReason: 'bank_fee' }
		);
		const insert = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO invoice_payments'))!;

		expect(insert[0]).toContain('bank_movement_id, settlement_reason');
		expect(insert[1]?.slice(-2)).toEqual(['mov-1', 'bank_fee']);
		const event = runnerQuery.mock.calls.find(([sql]) => sql.includes('contract_lifecycle_events'))!;

		expect(JSON.parse(String(event[1]?.[7]))).toMatchObject({ settlement_reason: 'bank_fee', bank_movement_id: 'mov-1' });
	});

	it('varios clientes: por defecto 409 client_mismatch; con allowMultipleClients pasa con aviso multiple_clients', async () => {
		const other = '22222222-2222-4333-8444-555555555555';
		const invoices = [invoice(), invoice({ id: other, client_id: 'c2', invoice_number: 'F-11' })];
		const dto = {
			allocations: [
				{ invoice_id: INVOICE, amount: 100 },
				{ invoice_id: other, amount: 100 },
			],
			currency: 'CLP',
			payment_date: '2026-10-01',
		};

		await expect(build({ invoices }).service.register(HOLDING, dto, 'auth-1', NOW)).rejects.toMatchObject({
			response: { blockers: [expect.objectContaining({ code: 'client_mismatch' })] },
		});
		const result = await build({ invoices }).service.register(HOLDING, dto, 'auth-1', NOW, { allowMultipleClients: true });

		expect(result.warnings).toEqual([expect.objectContaining({ code: 'multiple_clients' })]);
		expect(result.payment_ids).toHaveLength(2);
	});

	it('anular con runner del llamador: sin transacción propia, confirmed = false; un mes cerrado no bloquea (Domi 03-10)', async () => {
		const payment = { id: PAYMENT, invoice_id: INVOICE, amount: '10', currency: 'CLP', payment_date: '2026-09-20', confirmed: true };
		const { runner, runnerQuery, service } = build({ invoice: { status: 'Emitida', paid: '10' }, payment });

		await service.void(HOLDING, PAYMENT, { reason: 'Deshacer conciliación' }, 'auth-1', NOW, { runner: runner as never });
		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect(sqls(runnerQuery).some((sql) => sql.includes('UPDATE invoice_payments SET confirmed = false'))).toBe(true);
		const closed = build({ invoice: { status: 'Emitida', paid: '10', cutoff_date: '2026-09-30' }, payment });

		await closed.service.void(HOLDING, PAYMENT, { reason: 'Pago mal registrado' }, 'auth-1', NOW);
		expect(sqls(closed.runnerQuery).some((sql) => sql.includes('get_cutoff_date'))).toBe(false);
		expect(sqls(closed.runnerQuery).some((sql) => sql.includes('UPDATE invoice_payments SET confirmed = false'))).toBe(true);
	});
});
