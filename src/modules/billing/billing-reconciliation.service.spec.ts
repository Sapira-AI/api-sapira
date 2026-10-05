jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';

import { API_WRITER_SQL } from '@/modules/contracts/api-writer';

import { BillingPaymentsService } from './billing-payments.service';
import { BILLING_PERMISSION_KEY, BILLING_PERMISSIONS } from './billing-permissions.service';
import { parseStatement, type StatementMapping } from './billing-reconciliation-statement';
import { BillingReconciliationController } from './billing-reconciliation.controller';
import { BillingReconciliationService } from './billing-reconciliation.service';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const NOW = new Date('2026-10-02T15:00:00Z');
const MOV = 'mov-1';
const INV = 'inv-1';

type Row = Record<string, unknown>;

interface Fixtures {
	account?: Row | null;
	existing?: Row[];
	previousBatch?: Row | null;
	movements?: Row[];
	infos?: Row[];
	invoices?: Row[];
	lock?: Row | null;
	movementPayments?: Row[];
	paymentsById?: Record<string, Row>;
	batch?: Row | null;
	batchPayments?: number;
	mv?: Row[];
	candidates?: Row[];
}

const payInvoice = (overrides: Row = {}): Row => ({
	id: INV,
	invoice_number: 'F-1234',
	status: 'Emitida',
	document_type: 'FACTURA',
	is_active: true,
	contract_id: 'k1',
	client_id: 'c1',
	invoice_currency: 'CLP',
	total: '1000000',
	due_date: '2026-10-15',
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	voided: false,
	paid: '0',
	cutoff_date: null,
	...overrides,
});

const info = (overrides: Row = {}): Row => ({
	id: INV,
	invoice_number: 'F-1234',
	currency: 'CLP',
	client_id: 'c1',
	client_name: 'Acme',
	contract_id: 'k1',
	...overrides,
});

const movementRow = (overrides: Row = {}): Row => ({
	id: MOV,
	amount: '1000000',
	currency: 'CLP',
	status: 'Pendiente',
	date: '2026-10-01',
	description: 'TRANSF FACT 1234 ACME',
	bank_name: 'Banco de Chile',
	bank_account: '00-123',
	applied: '0',
	...overrides,
});

function build(fixtures: Fixtures = {}) {
	let sequence = 0;
	const handler = async (sql: string, params: unknown[] = []): Promise<unknown[]> => {
		if (sql.includes("set_config('sapira.writer'")) return [];
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('WITH mv AS')) {
			if (sql.includes('COUNT(*) AS total')) return [{ total: String((fixtures.mv ?? []).length) }];

			return fixtures.mv ?? [];
		}
		if (sql.includes('WITH base AS')) return fixtures.candidates ?? [];
		if (sql.includes('pg_advisory_xact_lock')) return [];
		if (sql.includes('FROM company_bank_accounts ba LEFT JOIN companies co')) return fixtures.account ? [fixtures.account] : [];
		if (sql.includes("original_row_data->>'fingerprint' = ANY")) return fixtures.existing ?? [];
		if (sql.includes('file_hash = $2')) return fixtures.previousBatch ? [fixtures.previousBatch] : [];
		if (sql.includes('INSERT INTO bank_upload_batches')) return [{ id: 'batch-1' }];
		if (sql.includes('INSERT INTO bank_movements'))
			return (JSON.parse(String(params[5])) as unknown[]).map((_, index) => ({ id: `new-${index}` }));
		if (sql.includes('INSERT INTO bank_column_mappings')) return [{ id: 'tpl-1' }];
		if (sql.includes('AS total, i.due_date::text AS due_date, i.odoo_invoice_id')) {
			const ids = params[1] as string[];

			return (fixtures.invoices ?? []).filter((row) => ids.includes(String(row.id)));
		}
		if (sql.includes('INSERT INTO invoice_payments')) return [{ id: `pay-${(sequence += 1)}` }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${sequence}` }];
		if (sql.includes('cl.name_commercial AS client_name, i.contract_id')) {
			const ids = params[1] as string[];

			return (fixtures.infos ?? []).filter((row) => ids.includes(String(row.id)));
		}
		if (sql.includes('m.bank_name, m.bank_account,')) {
			const ids = params[1] as string[];

			return (fixtures.movements ?? []).filter((row) => ids.includes(String(row.id)));
		}
		if (sql.includes('SELECT id FROM bank_movements WHERE holding_id = $1 AND id = ANY')) return [];
		if (sql.includes('SELECT id FROM bank_movements WHERE id = $1 AND holding_id = $2 FOR UPDATE'))
			return fixtures.lock ? [{ id: params[0] }] : [];
		if (sql.includes('AS payments FROM bank_movements m')) return fixtures.lock ? [fixtures.lock] : [];
		if (sql.includes('SELECT id FROM invoice_payments WHERE bank_movement_id')) return fixtures.movementPayments ?? [];
		if (sql.includes('FROM invoice_payments p WHERE p.id'))
			return fixtures.paymentsById?.[String(params[0])] ? [fixtures.paymentsById[String(params[0])]] : [];
		if (sql.includes('FROM bank_upload_batches WHERE id = $1')) return fixtures.batch ? [fixtures.batch] : [];
		if (sql.includes('COUNT(*) AS payments FROM invoice_payments p JOIN bank_movements'))
			return [{ payments: String(fixtures.batchPayments ?? 0) }];
		if (sql.includes('DELETE FROM bank_movements')) return [{ id: 'm1' }, { id: 'm2' }];

		return [];
	};
	const runners: Array<{ query: jest.Mock; startTransaction: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock }> = [];
	const createQueryRunner = () => {
		const runner = {
			connect: jest.fn(),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
			query: jest.fn(handler),
		};

		runners.push(runner);

		return runner;
	};
	const query = jest.fn(handler);
	const dataSource = { query, createQueryRunner } as unknown as DataSource;
	const payments = new BillingPaymentsService(dataSource);

	return { query, runners, payments, service: new BillingReconciliationService(dataSource, payments) };
}

const runnerSqls = (runner: { query: jest.Mock }) => runner.query.mock.calls.map(([sql]) => String(sql));
const allRunnerCalls = (runners: Array<{ query: jest.Mock }>) => runners.flatMap((runner) => runner.query.mock.calls as Array<[string, unknown[]]>);

/** Postgres rechaza un `$n` que el SQL no referencia. */
function unreferencedParams(calls: Array<[string, unknown[]?]>): string[] {
	return calls.flatMap(([sql, params]) =>
		(params ?? []).map((_, index) => `$${index + 1}`).filter((placeholder) => !new RegExp(`\\${placeholder}(?!\\d)`).test(sql))
	);
}

// ---------------------------------------------------------------- cartolas

const MAPPING: StatementMapping = {
	date_column: 'Fecha',
	description_column: 'Glosa',
	amount_column: 'Monto',
	date_format: 'auto',
	decimal_separator: ',',
	thousands_separator: '.',
	amount_sign_convention: 'credit_positive',
};
const ACCOUNT = { id: 'acc-1', company_id: 'co-1', company_name: 'Sapira', bank_name: 'Banco de Chile', account_number: '00-123', currency: 'CLP' };
const STATEMENT = {
	bank_account_id: 'acc-1',
	file_name: 'cartola.csv',
	file_hash: 'hash-1',
	format: 'csv' as const,
	headers: ['Fecha', 'Glosa', 'Monto'],
	rows: [
		['01/10/2026', 'TRANSF FACT 1234 ACME', '1.000.000'],
		['01/10/2026', 'COMISION', '-5.000'],
		['xx', 'MALA', '1'],
	],
	mapping: MAPPING,
};

describe('Conciliación: cartolas', () => {
	const lines = parseStatement(STATEMENT.headers, STATEMENT.rows, MAPPING, ACCOUNT);

	it('vista previa: new / duplicate / error, resumen por moneda y aviso de archivo ya importado (no escribe)', async () => {
		const { service, runners } = build({
			account: ACCOUNT,
			existing: [{ id: 'old-1', fingerprint: lines[0].fingerprint }],
			previousBatch: { id: 'batch-0', file_name: 'cartola.csv' },
		});
		const preview = await service.previewStatement(HOLDING, STATEMENT);

		expect(preview.lines.map((line) => line.status)).toEqual(['duplicate', 'new', 'error']);
		expect(preview.lines[0]).toMatchObject({ duplicate_of: 'old-1', kind: 'credit' });
		expect(preview.lines[1].kind).toBe('debit');
		expect(preview.summary).toMatchObject({ total: 3, new: 1, duplicates: 1, errors: 1, credits: 1, debits: 1 });
		expect(preview.summary.by_currency).toEqual([{ currency: 'CLP', credits: 1_000_000, debits: 5000, count: 2 }]);
		expect(preview.warnings).toEqual([expect.objectContaining({ code: 'file_already_imported', batch_id: 'batch-0' })]);
		expect(runners).toHaveLength(0);
	});

	it('cuenta fuera del holding → 404 no_bank_account', async () => {
		await expect(build({ account: null }).service.previewStatement(HOLDING, STATEMENT)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('importar: setApiWriter primero, lock por holding, omite huellas existentes, lote + movimientos ON CONFLICT DO NOTHING, plantilla', async () => {
		const { service, runners } = build({ account: ACCOUNT, existing: [{ id: 'old-1', fingerprint: lines[0].fingerprint }] });
		const result = await service.importStatement(
			HOLDING,
			{ ...STATEMENT, save_template: { bank_name: 'Banco de Chile', mapping_name: 'Cartola CSV', is_default: true } },
			'auth-1',
			NOW
		);
		const statements = runnerSqls(runners[0]);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements[1]).toContain(`pg_advisory_xact_lock(hashtext('bank_movements:' || $1))`);
		const insert = runners[0].query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO bank_movements'))!;

		expect(String(insert[0])).toContain('ON CONFLICT DO NOTHING RETURNING id');
		expect(String(insert[0])).not.toMatch(/ON CONFLICT \(/);
		const inserted = JSON.parse(String(insert[1][5])) as Array<Row & { original_row_data: Row }>;

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toMatchObject({ amount: -5000, currency: 'CLP', movement_date: '2026-10-01' });
		expect(inserted[0].original_row_data).toMatchObject({ fingerprint: lines[1].fingerprint, row: 2, bank_account_id: 'acc-1' });
		expect(result).toMatchObject({ batch_id: 'batch-1', inserted: 1, skipped_duplicates: 1, errors: 1, template_id: 'tpl-1' });
		expect(result.suggestions).toEqual({ exact: 0, high: 0, medium: 0, none: 0 });
		expect(statements.some((sql) => sql.includes('UPDATE bank_column_mappings SET is_default = false'))).toBe(true);
	});

	it('importar sin líneas nuevas → 409 blocked nothing_to_import y rollback', async () => {
		const { service, runners } = build({
			account: ACCOUNT,
			existing: lines.filter((line) => line.fingerprint).map((line, index) => ({ id: `old-${index}`, fingerprint: line.fingerprint })),
		});

		await expect(service.importStatement(HOLDING, STATEMENT, 'auth-1', NOW)).rejects.toMatchObject({
			response: { code: 'blocked', blockers: [expect.objectContaining({ code: 'nothing_to_import' })] },
		});
		expect(runners[0].rollbackTransaction).toHaveBeenCalled();
		expect(runnerSqls(runners[0]).some((sql) => sql.includes('INSERT INTO bank_upload_batches'))).toBe(false);
	});

	it('revertir: bloqueado si algún movimiento del lote tiene pagos o ya está revertido; si no, borra sus líneas y marca Revertido con motivo', async () => {
		await expect(
			build({ batch: { id: 'batch-1', status: 'Procesado' }, batchPayments: 2 }).service.revertStatement(
				HOLDING,
				'batch-1',
				{ reason: 'Error' },
				'auth-1'
			)
		).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'batch_has_payments' })] } });
		await expect(
			build({ batch: { id: 'batch-1', status: 'Revertido' } }).service.revertStatement(HOLDING, 'batch-1', { reason: 'Error' }, 'auth-1')
		).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'already_reverted' })] } });
		const { service, runners } = build({ batch: { id: 'batch-1', status: 'Procesado' } });
		const result = await service.revertStatement(HOLDING, 'batch-1', { reason: 'Cuenta equivocada' }, 'auth-1');
		const statements = runnerSqls(runners[0]);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(result).toEqual({ batch_id: 'batch-1', removed: 2 });
		expect(statements.some((sql) => sql.includes("SET status = 'Revertido'") && sql.includes("jsonb_build_object('revert'"))).toBe(true);
	});
});

// ---------------------------------------------------------------- conciliar

describe('Conciliación: conciliar (single path de pagos)', () => {
	it('1-a-1 misma moneda: register con movimiento (transfer, fecha del movimiento, glosa, notas) y movimiento Conciliado', async () => {
		const { service, runners } = build({ movements: [movementRow()], infos: [info()], invoices: [payInvoice()] });
		const result = await service.applyMatches(
			HOLDING,
			{ items: [{ movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 1_000_000 }], confidence: 'exact', score: 100 }] },
			'auth-1',
			NOW
		);
		const statements = runnerSqls(runners[0]);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements.filter((sql) => sql === API_WRITER_SQL)).toHaveLength(1);
		const insert = runners[0].query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO invoice_payments'))!;

		expect(String(insert[0])).toContain('bank_movement_id');
		expect(insert[1]).toEqual([
			INV,
			HOLDING,
			1_000_000,
			'CLP',
			'2026-10-01',
			'transfer',
			'TRANSF FACT 1234 ACME',
			'Conciliado desde cartola Banco de Chile 00-123',
			'user-1',
			MOV,
		]);
		const update = runners[0].query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'Conciliado'"))!;

		expect(update[1]).toEqual([MOV, HOLDING, INV, 'user-1', 'high', 100]);
		expect(result.items[0]).toMatchObject({ ok: true, applied: true, payment_ids: ['pay-1'], movements: [{ state_after: 'reconciled' }] });
		expect(result.summary).toMatchObject({ ok: 1, blocked: 0 });
	});

	it('moneda distinta: pago en la moneda de la factura con original_amount y fx_rate; sin tasa → fx_required; inconsistente → fx_inconsistent', async () => {
		const fixtures = { movements: [movementRow({ amount: '1000', currency: 'USD' })], infos: [info()], invoices: [payInvoice()] };
		const { service, runners } = build(fixtures);
		const result = await service.applyMatches(
			HOLDING,
			{
				items: [
					{ movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 950_000 }], fx: { rate: 950 }, allow_multiple_clients: false },
				],
			},
			'auth-1',
			NOW
		);
		const insert = runners[0].query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO invoice_payments'))!;

		expect(String(insert[0])).toContain('bank_movement_id, original_amount, fx_rate');
		expect((insert[1] as unknown[]).slice(2, 4)).toEqual([950_000, 'CLP']);
		expect((insert[1] as unknown[]).slice(-3)).toEqual([MOV, 1000, 950]);
		expect(result.items[0]).toMatchObject({ ok: true, currency: 'USD', invoice_currency: 'CLP', fx_rate: 950 });
		const preview = await build(fixtures).service.previewMatches(
			HOLDING,
			{
				items: [
					{ key: 'a', movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 950_000 }] },
					{ key: 'b', movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 950_000, original_amount: 900 }], fx: { rate: 950 } },
					{ key: 'c', movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 950_000, original_amount: 1000 }] },
				],
			},
			NOW
		);

		expect(preview.items.map((item) => item.blockers.map((blocker) => blocker.code))).toEqual([['fx_required'], ['fx_inconsistent'], []]);
		expect(preview.items[2].fx_rate).toBe(950);
	});

	it('diferencia con motivo: efectivo + ajuste no monetario (method adjustment, settlement_reason) en la misma transacción', async () => {
		const { service, runners } = build({ movements: [movementRow({ amount: '995000' })], infos: [info()], invoices: [payInvoice()] });
		const result = await service.applyMatches(
			HOLDING,
			{
				items: [
					{
						movement_ids: [MOV],
						allocations: [{ invoice_id: INV, amount: 995_000 }],
						adjustments: [{ invoice_id: INV, amount: 5000, reason: 'bank_fee' }],
					},
				],
			},
			'auth-1',
			NOW
		);
		const inserts = runners[0].query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO invoice_payments'));

		expect(runners).toHaveLength(1);
		expect(inserts).toHaveLength(2);
		expect(String(inserts[0][0])).not.toContain('settlement_reason');
		expect(String(inserts[1][0])).toContain('bank_movement_id, settlement_reason');
		expect((inserts[1][1] as unknown[]).slice(2, 8)).toEqual([
			5000,
			'CLP',
			'2026-10-01',
			'adjustment',
			'TRANSF FACT 1234 ACME',
			'Comisión bancaria',
		]);
		expect((inserts[1][1] as unknown[]).slice(-2)).toEqual([MOV, 'bank_fee']);
		expect(result.items[0]).toMatchObject({
			ok: true,
			invoices: [{ cash_amount: 995_000, adjustment_amount: 5000, adjustment_reason: 'bank_fee' }],
			movements: [{ state_after: 'reconciled' }],
		});
	});

	it('motivo "other" sin texto → note_required', async () => {
		const preview = await build({ movements: [movementRow()], infos: [info()], invoices: [payInvoice()] }).service.previewMatches(
			HOLDING,
			{
				items: [
					{
						movement_ids: [MOV],
						allocations: [{ invoice_id: INV, amount: 990_000 }],
						adjustments: [{ invoice_id: INV, amount: 10, reason: 'other' }],
					},
				],
			},
			NOW
		);

		expect(preview.items[0].blockers.map((blocker) => blocker.code)).toEqual(['note_required']);
	});

	it('varios clientes: por defecto client_mismatch; a mano con allow_multiple_clients → aviso multiple_clients', async () => {
		const fixtures = {
			movements: [movementRow()],
			infos: [info(), info({ id: 'inv-2', client_id: 'c2', invoice_number: 'F-9' })],
			invoices: [payInvoice(), payInvoice({ id: 'inv-2', client_id: 'c2', invoice_number: 'F-9' })],
		};
		const item = {
			movement_ids: [MOV],
			allocations: [
				{ invoice_id: INV, amount: 500_000 },
				{ invoice_id: 'inv-2', amount: 500_000 },
			],
		};
		const blocked = await build(fixtures).service.previewMatches(HOLDING, { items: [item] }, NOW);
		const allowed = await build(fixtures).service.previewMatches(HOLDING, { items: [{ ...item, allow_multiple_clients: true }] }, NOW);

		expect(blocked.items[0].blockers.map((blocker) => blocker.code)).toEqual(['client_mismatch']);
		expect(allowed.items[0]).toMatchObject({ ok: true, blockers: [], warnings: [expect.objectContaining({ code: 'multiple_clients' })] });
	});

	it('los ítems son independientes (uno falla con rollback, el otro se aplica); un mes cerrado no bloquea pagos (Domi 03-10)', async () => {
		const { service, runners } = build({
			movements: [movementRow(), movementRow({ id: 'mov-2' })],
			infos: [info(), info({ id: 'inv-2', invoice_number: 'F-2' })],
			// La primera ya tiene la mitad pagada → sobrepago; la segunda está en un mes cerrado y se aplica igual.
			invoices: [payInvoice({ paid: '500000' }), payInvoice({ id: 'inv-2', invoice_number: 'F-2', cutoff_date: '2026-10-31' })],
		});
		const result = await service.applyMatches(
			HOLDING,
			{
				items: [
					{ key: 'closed', movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 1_000_000 }] },
					{ key: 'open', movement_ids: ['mov-2'], allocations: [{ invoice_id: 'inv-2', amount: 1_000_000 }] },
				],
			},
			'auth-1',
			NOW
		);

		expect(result.items[0]).toMatchObject({
			key: 'closed',
			ok: false,
			applied: false,
			blockers: [expect.objectContaining({ code: 'overpayment' })],
		});
		expect(result.items[1]).toMatchObject({ key: 'open', ok: true, applied: true });
		expect(runners[0].rollbackTransaction).toHaveBeenCalled();
		expect(runners[1].commitTransaction).toHaveBeenCalled();
		expect(result.summary).toMatchObject({ ok: 1, blocked: 1 });
	});

	it('movimiento sobreaplicado o ya conciliado bloquea', async () => {
		const preview = await build({
			movements: [movementRow({ applied: '600000' }), movementRow({ id: 'done', status: 'Conciliado', applied: '1000000' })],
			infos: [info()],
			invoices: [payInvoice()],
		}).service.previewMatches(
			HOLDING,
			{
				items: [
					{ movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 500_000 }] },
					{ movement_ids: ['done'], allocations: [{ invoice_id: INV, amount: 1 }] },
				],
			},
			NOW
		);

		expect(preview.items[0].blockers.map((blocker) => blocker.code)).toEqual(['movement_overapplied']);
		expect(preview.items[1].blockers.map((blocker) => blocker.code)).toEqual(['movement_not_pending']);
	});

	it('muchos-a-1: un register por movimiento con su parte', async () => {
		const { service, runners } = build({
			movements: [movementRow({ amount: '600000' }), movementRow({ id: 'mov-2', amount: '400000', date: '2026-10-03' })],
			infos: [info()],
			invoices: [payInvoice()],
		});

		await service.applyMatches(
			HOLDING,
			{ items: [{ movement_ids: [MOV, 'mov-2'], allocations: [{ invoice_id: INV, amount: 1_000_000 }] }] },
			'auth-1',
			NOW
		);
		const inserts = runners[0].query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO invoice_payments'));

		expect(inserts.map(([, params]) => [(params as unknown[])[2], (params as unknown[])[4], (params as unknown[]).at(-1)])).toEqual([
			[600_000, '2026-10-01', MOV],
			[400_000, '2026-10-03', 'mov-2'],
		]);
	});
});

describe('Conciliación: deshacer, ignorar, reabrir', () => {
	const payment = (id: string) => ({ id, invoice_id: INV, amount: '500', currency: 'CLP', payment_date: '2026-10-01', confirmed: true });

	it('deshacer: void de cada pago (confirmed = false, sin DELETE) en una transacción y movimiento a Pendiente', async () => {
		const { service, runners } = build({
			lock: { id: MOV, status: 'Conciliado', amount: '1000', payments: '2' },
			movementPayments: [{ id: 'p-2' }, { id: 'p-1' }],
			paymentsById: { 'p-1': payment('p-1'), 'p-2': payment('p-2') },
			invoices: [payInvoice({ paid: '1000', total: '1000', status: 'Pagada' })],
		});
		const result = await service.undo(HOLDING, MOV, { reason: 'Factura equivocada' }, 'auth-1', NOW);
		const statements = runnerSqls(runners[0]);

		expect(statements[0]).toBe(API_WRITER_SQL);
		expect(statements.filter((sql) => sql === API_WRITER_SQL)).toHaveLength(1);
		expect(statements.filter((sql) => sql.includes('UPDATE invoice_payments SET confirmed = false'))).toHaveLength(2);
		expect(statements.some((sql) => /DELETE/i.test(sql))).toBe(false);
		expect(statements.some((sql) => sql.includes("UPDATE bank_movements SET status = 'Pendiente'"))).toBe(true);
		expect(result).toEqual({ movement_id: MOV, voided_payment_ids: ['p-2', 'p-1'], state: 'pending' });
	});

	it('deshacer sin pagos → 409 movement_has_no_payments; fuera del holding → 404 (un mes cerrado ya no bloquea, Domi 03-10)', async () => {
		await expect(
			build({ lock: { id: MOV, status: 'Pendiente', amount: '1000', payments: '0' } }).service.undo(
				HOLDING,
				MOV,
				{ reason: 'x' },
				'auth-1',
				NOW
			)
		).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'movement_has_no_payments' })] } });
		await expect(build({ lock: null }).service.undo(HOLDING, MOV, { reason: 'x' }, 'auth-1', NOW)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('ignorar: con pagos → movement_has_payments; ignorado/conciliado → movement_not_pending; si no, Ignorado con motivo', async () => {
		await expect(
			build({ lock: { id: MOV, status: 'Pendiente', amount: '10', payments: '1' } }).service.ignore(
				HOLDING,
				MOV,
				{ reason: 'Préstamo' },
				'auth-1'
			)
		).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'movement_has_payments' })] } });
		await expect(
			build({ lock: { id: MOV, status: 'Ignorado', amount: '10', payments: '0' } }).service.ignore(HOLDING, MOV, { reason: 'x' }, 'auth-1')
		).rejects.toBeInstanceOf(ConflictException);
		const { service, runners } = build({ lock: { id: MOV, status: 'Pendiente', amount: '10', payments: '0' } });

		expect(await service.ignore(HOLDING, MOV, { reason: 'Préstamo' }, 'auth-1')).toEqual({ movement_id: MOV, state: 'ignored' });
		const update = runners[0].query.mock.calls.find(([sql]) => String(sql).includes("SET status = 'Ignorado'"))!;

		expect(update[1]).toEqual([MOV, HOLDING, 'Préstamo', 'user-1']);
	});

	it('reabrir: solo un ignorado (movement_not_ignored); vuelve a Pendiente', async () => {
		await expect(
			build({ lock: { id: MOV, status: 'Pendiente', amount: '10', payments: '0' } }).service.reopen(HOLDING, MOV, {}, 'auth-1', NOW)
		).rejects.toMatchObject({ response: { blockers: [expect.objectContaining({ code: 'movement_not_ignored' })] } });
		const { service } = build({ lock: { id: MOV, status: 'Ignorado', amount: '10', payments: '0' } });

		expect(await service.reopen(HOLDING, MOV, { reason: 'Era una factura' }, 'auth-1', NOW)).toEqual({ movement_id: MOV, state: 'pending' });
	});
});

describe('Conciliación: lecturas', () => {
	const mvRow = (overrides: Row = {}): Row => ({
		id: MOV,
		date: '2026-10-01',
		description: 'TRANSF FACT 1234 ACME',
		amount: '1000000',
		currency: 'CLP',
		status: 'Pendiente',
		state: 'pending',
		applied: '0',
		adjustments: '0',
		original_row_data: { reference: null, counterparty_tax_id: '760864285', counterparty_name: 'ACME' },
		...overrides,
	});
	const candidate = {
		id: INV,
		invoice_number: 'F-1234',
		client_id: 'c1',
		client_name: 'Acme',
		client_entity_name: 'Acme SpA',
		tax_id: '76.086.428-5',
		contract_id: 'k1',
		invoice_currency: 'CLP',
		total_due: '1000000',
		balance: '1000000',
		due_date: '2026-10-15',
		status: 'Emitida',
		payment_state: 'unpaid',
	};

	it('cola: paginado { data, items, currentPage, pages, limit }, mejor sugerencia en vivo (sin moneda distinta) y todos los $n referenciados', async () => {
		const { service, query } = build({ mv: [mvRow()], candidates: [candidate] });
		const result = await service.movements(
			HOLDING,
			{
				from: '2026-09-01',
				to: '2026-10-31',
				bank_account_id: '11111111-2222-4333-8444-555555555555',
				state: 'pending,partial',
				confidence: 'exact,none',
				q: 'ACME_1%',
				page: 1,
				limit: 20,
				sortBy: 'amount',
			},
			NOW
		);

		expect(result).toMatchObject({ items: 1, currentPage: 1, pages: 1, limit: 20 });
		expect(result.data[0]).toMatchObject({
			id: MOV,
			state: 'pending',
			remaining: 1_000_000,
			counterparty_tax_id: '760864285',
			best: { confidence: 'exact', movement_ids: [MOV], allocations: [{ invoice_id: INV, amount: 1_000_000, contract_id: 'k1' }] },
		});
		await service.movements(HOLDING, { kpi: 'reconciled' }, NOW);
		await service.movements(HOLDING, { kpi: 'differences', include_debits: true }, NOW);
		await service.movements(HOLDING, { kpi: 'unidentified' }, NOW);
		await service.summary(HOLDING, { from: '2026-09-01', to: '2026-09-30', bank_account_id: '11111111-2222-4333-8444-555555555555' }, NOW);
		await service.summary(HOLDING, {}, NOW);
		await service.candidates(HOLDING, { q: 'acme', client_id: 'c1', currency: 'clp', limit: 10 }, NOW);
		await service.statements(HOLDING, { page: 2, limit: 10 });
		expect(unreferencedParams(query.mock.calls as Array<[string, unknown[]]>)).toEqual([]);
		const sql = query.mock.calls.map(([statement]) => String(statement)).find((statement) => statement.includes('mv.state = ANY'))!;

		expect(sql).toContain("mv.state <> 'debit'");
	});

	it('resumen: KPIs por moneda, niveles de confianza, cuentas, fuente y último lote', async () => {
		const { service } = build();
		const query = jest.spyOn((service as unknown as { dataSource: DataSource }).dataSource, 'query');

		query.mockImplementation((async (sql: string) => {
			if (sql.includes('WITH mv AS'))
				return [{ currency: 'CLP', pending_count: '3', pending_amount: '1500', tier_exact: '1', tier_none: '2', ignored_count: '1' }];
			if (sql.includes('FROM company_bank_accounts ba')) return [{ id: 'acc-1', bank_name: 'BCI', movements: '4', currency: 'CLP' }];

			return [{ has_source: true, last_batch: { id: 'batch-1' } }];
		}) as never);
		const summary = await service.summary(HOLDING, {}, NOW);

		expect(summary).toMatchObject({
			period: { from: '2026-10-01', to: '2026-10-31' },
			pending: { count: 3, by_currency: [{ currency: 'CLP', amount: 1500 }] },
			reconciled_period: { count: 0, by_currency: [] },
			ignored: { count: 1 },
			by_confidence: { exact: 1, high: 0, medium: 0, none: 2 },
			accounts: [{ id: 'acc-1', movements: 4 }],
			has_source: true,
			last_batch: { id: 'batch-1' },
		});
	});

	it('sugerencias de un movimiento: 404 fuera del holding', async () => {
		await expect(build().service.suggestions(HOLDING, MOV, {}, NOW)).rejects.toBeInstanceOf(NotFoundException);
		const { service } = build({ mv: [mvRow()], candidates: [candidate] });
		const detail = await service.suggestions(HOLDING, MOV, {}, NOW);

		expect(detail.suggestions[0]).toMatchObject({ confidence: 'exact', shape: 'one_to_one' });
		expect(detail.movement.best).toMatchObject({ confidence: 'exact' });
	});

	it('actualizar sugerencias: persiste high/100 para exacta en una transacción con setApiWriter', async () => {
		const { service, runners } = build({ mv: [mvRow()], candidates: [candidate] });
		const result = await service.refreshSuggestions(HOLDING, {}, NOW);
		const update = allRunnerCalls(runners).find(([sql]) => sql.includes('UPDATE bank_movements m SET suggested_invoice_id'))!;

		expect(runnerSqls(runners[0])[0]).toBe(API_WRITER_SQL);
		expect(update[1]).toEqual([HOLDING, [MOV], [INV], ['high'], [100]]);
		expect(result).toEqual({ updated: 1, by_confidence: { exact: 1, high: 0, medium: 0, none: 0 } });
	});
});

describe('Conciliación: permisos del controlador', () => {
	it('lecturas exigen VIEW_FACTURACION (controlador) y toda escritura EDIT_FACTURACION (ruta)', () => {
		const reflector = new Reflector();
		const proto = BillingReconciliationController.prototype as unknown as Record<string, (...args: never[]) => unknown>;
		const required = (name: string) => reflector.getAllAndOverride(BILLING_PERMISSION_KEY, [proto[name], BillingReconciliationController]);

		for (const name of ['summary', 'movements', 'suggestions', 'candidates', 'statements', 'templates']) {
			expect([name, required(name)]).toEqual([name, BILLING_PERMISSIONS.view]);
		}
		for (const name of [
			'previewStatement',
			'importStatement',
			'revertStatement',
			'createTemplate',
			'updateTemplate',
			'deleteTemplate',
			'previewMatches',
			'applyMatches',
			'undo',
			'ignore',
			'reopen',
			'refreshSuggestions',
		]) {
			expect([name, required(name)]).toEqual([name, BILLING_PERMISSIONS.edit]);
		}
	});
});
