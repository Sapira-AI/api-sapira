import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { BillingPermissionGuard, BillingPermissionsService } from '@/modules/billing/billing-permissions.service';

import { BudgetsController } from './budgets.controller';
import { BudgetsModule } from './budgets.module';
import { BudgetsService } from './budgets.service';

import type { UpsertBudgetDto } from './dtos/budgets.dto';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const BUDGET_ID = 'b0000000-0000-4000-8000-000000000001';
const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001';
const BUDGET_ROW = {
	id: BUDGET_ID,
	kind: 'cash_in',
	name: 'Caja 2026',
	scenario: 'base',
	currency: 'USD',
	period_granularity: 'month',
	fiscal_year: 2026,
	status: 'active',
	notes: null,
	created_at: new Date('2026-10-01T00:00:00Z'),
	updated_at: new Date('2026-10-01T00:00:00Z'),
};

function build({ existing = false, companies = [COMPANY] }: { existing?: boolean; companies?: string[] } = {}) {
	const runnerQuery = jest.fn(async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
		void params;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FOR UPDATE')) return existing ? [{ id: BUDGET_ID }] : [];
		if (sql.includes('INSERT INTO budgets')) return [{ id: BUDGET_ID }];
		if (sql.includes("SET status = 'archived'")) return [{ id: BUDGET_ID }];

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
	const query = jest.fn(async (sql: string, ...params: unknown[]): Promise<unknown[]> => {
		void params;
		if (sql.includes('holding_settings')) return [{ system_currency: 'usd' }];
		if (sql.includes('FROM companies')) return companies.map((id) => ({ id }));
		if (sql.includes('FROM budgets b')) return [BUDGET_ROW];
		if (sql.includes('FROM budget_lines')) {
			return [
				{
					budget_id: BUDGET_ID,
					period_start: '2026-01-01',
					dimension_type: 'total',
					dimension_id: null,
					dimension_key: null,
					amount: '100.50',
				},
				{
					budget_id: BUDGET_ID,
					period_start: '2026-02-01',
					dimension_type: 'total',
					dimension_id: null,
					dimension_key: null,
					amount: '99.50',
				},
			];
		}

		return [];
	});
	const service = new BudgetsService({ query, createQueryRunner: () => runner } as unknown as DataSource);

	return { service, query, runner, runnerQuery };
}

const dto = (overrides: Partial<UpsertBudgetDto> = {}): UpsertBudgetDto => ({
	kind: 'cash_in',
	fiscal_year: 2026,
	name: 'Caja 2026',
	period_granularity: 'month',
	lines: [
		{ period_start: '2026-01-01', amount: 100.5 },
		{ period_start: '2026-02-01', amount: 99.5 },
		{ period_start: '2026-01-01', dimension_type: 'company', dimension_id: COMPANY, amount: 100.5 },
	],
	...overrides,
});

describe('BudgetsService', () => {
	it('upsert nuevo: valida, crea la cabecera en moneda de sistema y reemplaza las líneas con un INSERT … unnest en una transacción', async () => {
		const { service, runner, runnerQuery } = build();
		const result = await service.upsert(HOLDING, dto(), 'auth-1');

		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		expect(runnerQuery.mock.calls[0][0]).toContain("set_config('sapira.writer', 'api', true)");
		const insert = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO budgets'))!;

		expect(insert[1]).toEqual([HOLDING, 'cash_in', 'Caja 2026', 'base', 'USD', 'month', 2026, 'active', null, 'user-1']);
		const lines = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO budget_lines'))!;

		expect(lines[0]).toContain('unnest($3::date[], $4::text[], $5::uuid[], $6::text[], $7::numeric[])');
		expect(lines[1]).toEqual([
			HOLDING,
			BUDGET_ID,
			['2026-01-01', '2026-02-01', '2026-01-01'],
			['total', 'total', 'company'],
			[null, null, COMPANY],
			[null, null, null],
			[100.5, 99.5, 100.5],
		]);
		expect(result).toMatchObject({ id: BUDGET_ID, total: 200, lines_count: 2, monthly: { '2026-01': 100.5, '2026-02': 99.5, '2026-03': 0 } });
	});

	it('upsert existente (no archivado): actualiza la cabecera y borra todas sus líneas antes de insertar (reemplazo total)', async () => {
		const { service, runnerQuery } = build({ existing: true });

		await service.upsert(HOLDING, dto({ status: 'draft', notes: 'v2' }), null);
		const statements = runnerQuery.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' '));

		expect(statements).toEqual([
			"SELECT set_config('sapira.writer', 'api',",
			'SELECT id FROM',
			'UPDATE budgets SET',
			'DELETE FROM budget_lines',
			'INSERT INTO budget_lines',
		]);
		expect(runnerQuery.mock.calls.find(([sql]) => sql.startsWith('UPDATE budgets'))![1]).toEqual([
			HOLDING,
			BUDGET_ID,
			'Caja 2026',
			'USD',
			'month',
			'draft',
			'v2',
		]);
	});

	it('400 errors[] por reglas de líneas o entidades de otro holding; no abre transacción', async () => {
		const { service, runner } = build({ companies: [] });

		await expect(service.upsert(HOLDING, dto({ lines: [{ period_start: '2026-01-15', amount: 1 }] }), null)).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(service.upsert(HOLDING, dto(), null)).rejects.toMatchObject({
			response: { errors: [{ field: 'lines', message: `La compañía ${COMPANY} no existe en este holding` }] },
		});
		expect(runner.startTransaction).not.toHaveBeenCalled();
	});

	it('sin la tabla (migración sin aplicar): el PUT responde 409 budget_storage_missing y las lecturas de reportes vacío', async () => {
		const { service, runnerQuery, query } = build();
		const missing = Object.assign(new Error('relation "budgets" does not exist'), { code: '42P01' });

		runnerQuery.mockImplementation(async (sql: string) => {
			if (sql.includes('budgets')) throw missing;

			return [];
		});
		await expect(service.upsert(HOLDING, dto(), null)).rejects.toMatchObject({ response: { code: 'budget_storage_missing' } });
		await expect(service.upsert(HOLDING, dto(), null)).rejects.toBeInstanceOf(ConflictException);
		query.mockImplementation(async () => {
			throw missing;
		});
		await expect(service.activeFor(HOLDING, 'cash_in', [2026])).resolves.toEqual([]);
	});

	it('list, get (404 fuera del holding) y archive', async () => {
		const { service, query } = build();

		await expect(service.list(HOLDING, { kind: 'cash_in', fiscal_year: 2026 })).resolves.toEqual([
			expect.objectContaining({ id: BUDGET_ID, total: 200, lines_count: 2 }),
		]);
		expect(query.mock.calls.find(([sql]) => sql.includes('FROM budgets b'))![1]).toEqual([HOLDING, 'cash_in', 2026]);
		await expect(service.archive(HOLDING, BUDGET_ID)).resolves.toMatchObject({ id: BUDGET_ID });
		query.mockImplementation(async () => []);
		await expect(service.get(HOLDING, BUDGET_ID)).rejects.toBeInstanceOf(NotFoundException);
	});
});

describe('BudgetsModule (DI)', () => {
	it('exporta BudgetsService y resuelve controlador, servicio y guard de permisos (los de Facturación) sin importar BillingModule', async () => {
		const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, BudgetsModule) as unknown[];

		expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, BudgetsModule)).toEqual([BudgetsService]);
		expect(imports.map((entry) => (entry as { name?: string }).name)).not.toContain('BillingModule');
		const moduleRef = await Test.createTestingModule({
			controllers: [BudgetsController],
			providers: [
				BudgetsService,
				BillingPermissionsService,
				BillingPermissionGuard,
				Reflector,
				{ provide: DataSource, useValue: { query: jest.fn(async () => []) } },
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({ canActivate: () => true })
			.overrideGuard(HoldingScopeGuard)
			.useValue({ canActivate: () => true })
			.compile();

		expect(moduleRef.get(BudgetsController)).toBeInstanceOf(BudgetsController);
		expect(Reflect.getMetadata('billing_permission', BudgetsController.prototype.upsert)).toBe('EDIT_FACTURACION');
		expect(Reflect.getMetadata('billing_permission', BudgetsController)).toBe('VIEW_FACTURACION');
	});
});
